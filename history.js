// =========================================================================
//  History store — records sensor values (temperature, humidity, power,
//  energy counter, contacts, …) into SQLite so the UI can draw charts. The
//  SHC itself keeps no history.
//
//  Three tiers, each with its own retention (configurable, stored in the DB):
//    raw    every recorded value                     default 14 days
//    hourly min/max/avg/last per series and hour     default 730 days
//    daily  min/max/avg/last per series and day      default unlimited (0)
//  Hourly/daily rows are maintained on insert (upsert), so aggregates are
//  always current; prune() only deletes rows past their retention.
//
//  Uses the built-in `node:sqlite` (Node >= 22.5). On older Node the module
//  reports `available: false` and every call is a no-op — the rest of the
//  UI keeps working without history.
// =========================================================================
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node < 22.5 */ }

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const DEFAULT_SETTINGS = { rawDays: 14, hourlyDays: 730, dailyDays: 0 };

// Service state → [metric, numeric value] pairs. A series is `${deviceId}|${metric}`.
// Booleans/enums become 0/1 so contacts can be charted as steps.
const METRICS = {
  TemperatureLevel:   s => [['temperature', s.temperature]],
  HumidityLevel:      s => [['humidity', s.humidity]],
  RoomClimateControl: s => [['setpoint', s.setpointTemperature]],
  PowerMeter:         s => [['power', s.powerConsumption], ['energy', s.energyConsumption]],
  ShutterContact:     s => [['contact', s.value === 'OPEN' ? 1 : s.value === 'CLOSED' ? 0 : null]],
  ValveTappet:        s => [['valve', s.position]],
  AirQualityLevel:    s => [['purity', s.purity]],
  ShutterControl:     s => [['shutter', typeof s.level === 'number' ? Math.round(s.level * 100) : null]],
  MultiLevelSensor:   s => [['illuminance', typeof s.illuminance === 'number' ? s.illuminance : null]],
};

// Extract [{series, value}] from one DeviceServiceData object (as returned by
// /smarthome/services or delivered as a long-poll event).
function extractMetrics(svc) {
  const fn = METRICS[svc?.id];
  if (!fn || !svc.state || !svc.deviceId) return [];
  return fn(svc.state)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([metric, value]) => ({ series: `${svc.deviceId}|${metric}`, value }));
}

const hourStart = (ts) => Math.floor(ts / HOUR) * HOUR;
// Days follow the server's local time zone (TZ), so "today" in the energy
// view matches the wall clock rather than UTC.
const dayStart = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

function openHistory(file) {
  if (!DatabaseSync) return disabledStore('node:sqlite not available (Node >= 22.5 required)');
  let db;
  try {
    db = new DatabaseSync(file);
  } catch (err) {
    return disabledStore(err.message);
  }
  // Series keys ("deviceId|metric") are stored once in the series table; the
  // value tables reference them by integer id and are WITHOUT ROWID tables
  // clustered on (sid, ts). That keeps rows small (a year of hourly data for
  // ~30 series is a few MB) and range scans per series fast.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS series (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS raw    (sid INTEGER NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL,
      PRIMARY KEY (sid, ts)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS raw_ts ON raw(ts);
    CREATE TABLE IF NOT EXISTS hourly (sid INTEGER NOT NULL, ts INTEGER NOT NULL,
      vmin REAL, vmax REAL, vsum REAL, n INTEGER, vlast REAL, last_ts INTEGER, PRIMARY KEY (sid, ts)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS daily  (sid INTEGER NOT NULL, ts INTEGER NOT NULL,
      vmin REAL, vmax REAL, vsum REAL, n INTEGER, vlast REAL, last_ts INTEGER, PRIMARY KEY (sid, ts)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);

  const upsertSql = (table) => `
    INSERT INTO ${table} (sid, ts, vmin, vmax, vsum, n, vlast, last_ts) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(sid, ts) DO UPDATE SET
      vmin = min(vmin, excluded.vmin), vmax = max(vmax, excluded.vmax),
      vsum = vsum + excluded.vsum, n = n + 1,
      vlast = CASE WHEN excluded.last_ts >= last_ts THEN excluded.vlast ELSE vlast END,
      last_ts = max(last_ts, excluded.last_ts)`;
  const st = {
    // Two values for the same series and millisecond: keep the newer one.
    raw: db.prepare('INSERT INTO raw (sid, ts, value) VALUES (?, ?, ?) ON CONFLICT(sid, ts) DO UPDATE SET value = excluded.value'),
    hourly: db.prepare(upsertSql('hourly')),
    daily: db.prepare(upsertSql('daily')),
    findSeries: db.prepare('SELECT id FROM series WHERE key = ?'),
    addSeries: db.prepare('INSERT INTO series (key) VALUES (?)'),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };

  // series key -> id, cached; `create` adds unknown keys (writes only).
  const sidCache = new Map();
  function sid(key, create) {
    if (sidCache.has(key)) return sidCache.get(key);
    let id = st.findSeries.get(key)?.id;
    if (id == null && create) id = st.addSeries.run(key).lastInsertRowid;
    if (id == null) return null;
    id = Number(id);
    sidCache.set(key, id);
    return id;
  }

  // Run fn inside one transaction; nested calls join the outer one. Used by
  // record() and for bulk imports such as the demo seed.
  let txDepth = 0;
  function batch(fn) {
    if (txDepth) return fn();
    db.exec('BEGIN');
    txDepth++;
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      txDepth--;
    }
  }

  function getSettings() {
    try {
      const row = st.getSetting.get('retention');
      return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
    } catch { return { ...DEFAULT_SETTINGS }; }
  }

  function setSettings(patch) {
    const next = { ...getSettings() };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (patch[k] === undefined) continue;
      const v = Math.floor(Number(patch[k]));
      if (!Number.isFinite(v) || v < 0 || v > 36500) throw Object.assign(new Error(`invalid ${k}`), { status: 400 });
      next[k] = v;
    }
    // A coarser tier shorter than a finer one would leave gaps in long-range
    // charts, so enforce raw <= hourly <= daily (0 = unlimited).
    if (next.hourlyDays && next.hourlyDays < next.rawDays) next.hourlyDays = next.rawDays;
    if (next.dailyDays && next.dailyDays < (next.hourlyDays || Infinity)) next.dailyDays = next.hourlyDays;
    st.setSetting.run('retention', JSON.stringify(next));
    return next;
  }

  // Record values at `ts` (ms). `points` = [{series, value}].
  function record(points, ts = Date.now()) {
    if (!points.length) return;
    const h = hourStart(ts), d = dayStart(ts);
    batch(() => {
      for (const { series, value } of points) {
        const id = sid(series, true);
        st.raw.run(id, ts, value);
        st.hourly.run(id, h, value, value, value, value, ts);
        st.daily.run(id, d, value, value, value, value, ts);
      }
    });
  }

  // Convenience: record every metric found in a list of service objects.
  const recordServices = (services, ts) => record(services.flatMap(extractMetrics), ts);

  function prune(now = Date.now()) {
    const s = getSettings();
    const cut = (table, days) => days > 0
      ? Number(db.prepare(`DELETE FROM ${table} WHERE ts < ?`).run(now - days * DAY).changes) : 0;
    return { raw: cut('raw', s.rawDays), hourly: cut('hourly', s.hourlyDays), daily: cut('daily', s.dailyDays) };
  }

  // Resolution for a time range: raw for short ranges still inside raw
  // retention, hourly up to ~3 months, daily beyond.
  function pickResolution(from, to, now = Date.now()) {
    const span = to - from;
    const s = getSettings();
    const rawFrom = s.rawDays > 0 ? now - s.rawDays * DAY : -Infinity;
    if (span <= 3 * DAY && from >= rawFrom) return 'raw';
    if (span <= 92 * DAY) return 'hour';
    return 'day';
  }

  const MAX_RAW_POINTS = 3000;

  // Points as [ts, avg, min, max, last]. For raw, all four values are equal.
  function query(series, from, to, res = 'auto') {
    if (res === 'auto') res = pickResolution(from, to);
    const id = sid(series, false);
    if (id == null) return { res, points: [] };
    if (res === 'raw') {
      const rows = db.prepare('SELECT ts, value FROM raw WHERE sid = ? AND ts >= ? AND ts <= ? ORDER BY ts')
        .all(id, from, to);
      // Chatty series (e.g. power) can produce thousands of raw rows; fall
      // back to hourly then rather than shipping them all to the browser.
      if (rows.length <= MAX_RAW_POINTS) {
        return { res, points: rows.map(r => [r.ts, r.value, r.value, r.value, r.value]) };
      }
      res = 'hour';
    }
    const table = res === 'day' ? 'daily' : 'hourly';
    const rows = db.prepare(`SELECT ts, vsum / n AS avg, vmin, vmax, vlast FROM ${table}
      WHERE sid = ? AND ts >= ? AND ts <= ? ORDER BY ts`).all(id, from, to);
    return { res, points: rows.map(r => [r.ts, r.avg, r.vmin, r.vmax, r.vlast]) };
  }

  // Last 24 hourly averages per series — for room sparklines.
  function sparklines(seriesList, now = Date.now()) {
    const from = hourStart(now) - 23 * HOUR;
    const stmt = db.prepare('SELECT ts, vsum / n AS avg FROM hourly WHERE sid = ? AND ts >= ? ORDER BY ts');
    const out = {};
    for (const s of seriesList) {
      const id = sid(s, false);
      out[s] = id == null ? [] : stmt.all(id, from).map(r => [r.ts, r.avg]);
    }
    return out;
  }

  // Metrics of one device that have (hourly) data — for the chart picker.
  function seriesFor(deviceId) {
    const prefix = deviceId + '|';
    return db.prepare('SELECT id, key FROM series WHERE substr(key, 1, ?) = ?').all(prefix.length, prefix)
      .filter(r => db.prepare('SELECT 1 FROM hourly WHERE sid = ? LIMIT 1').get(r.id))
      .map(r => r.key.slice(prefix.length));
  }

  // ---- Energy -------------------------------------------------------------
  // Tariffs: [{ validFrom: 'YYYY-MM-DD', price: <€/kWh> }], applied by the
  // local date of each bucket. Stored next to the retention settings.
  function getTariffs() {
    try {
      const row = st.getSetting.get('tariffs');
      return row ? JSON.parse(row.value) : [];
    } catch { return []; }
  }

  function setTariffs(list) {
    if (!Array.isArray(list)) throw Object.assign(new Error('tariffs must be an array'), { status: 400 });
    const clean = list.map(t => {
      const price = Number(t?.price);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t?.validFrom)) || Number.isNaN(Date.parse(t.validFrom)))
        throw Object.assign(new Error('invalid validFrom'), { status: 400 });
      if (!Number.isFinite(price) || price < 0 || price > 100)
        throw Object.assign(new Error('invalid price'), { status: 400 });
      return { validFrom: t.validFrom, price };
    }).sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    st.setSetting.run('tariffs', JSON.stringify(clean));
    return clean;
  }

  // Price for a bucket start (local date), or null before the first tariff.
  function priceAt(ts, tariffs) {
    const d = new Date(ts);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let price = null;
    for (const t of tariffs) if (t.validFrom <= date) price = t.price;
    return price;
  }

  const monthStart = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };

  // Consumption of every energy counter in [from, to), per bucket
  // ('hour' | 'day' | 'month'). A bucket's consumption is its last counter
  // reading minus the previous reading (the last one before the bucket, which
  // may lie before `from`). A missed bucket is absorbed by the next one; a
  // negative delta (counter reset / device replaced) counts as 0.
  // Returns { buckets: [ts], devices: [{ deviceId, kwh, cost, values: [kWh per bucket] }],
  //           totals: [kWh per bucket], kwh, cost, priced }.
  function energy(from, to, bucket = 'day') {
    const table = bucket === 'hour' ? 'hourly' : 'daily';
    const bucketOf = bucket === 'month' ? monthStart : (ts) => ts;
    const tariffs = getTariffs();
    const counters = db.prepare("SELECT id, key FROM series WHERE key LIKE '%|energy'").all();
    const rowsStmt = db.prepare(`SELECT ts, vlast FROM ${table} WHERE sid = ? AND ts >= ? AND ts < ? ORDER BY ts`);
    const prevStmt = db.prepare(`SELECT vlast FROM ${table} WHERE sid = ? AND ts < ? ORDER BY ts DESC LIMIT 1`);

    const bucketSet = new Set();
    const perDevice = [];
    for (const c of counters) {
      const rows = rowsStmt.all(c.id, from, to);
      if (!rows.length) continue;
      let prev = prevStmt.get(c.id, from)?.vlast;
      const byBucket = new Map();
      for (const r of rows) {
        const kwh = prev == null ? 0 : Math.max(0, r.vlast - prev) / 1000;
        prev = r.vlast;
        const b = bucketOf(r.ts);
        bucketSet.add(b);
        byBucket.set(b, (byBucket.get(b) || 0) + kwh);
      }
      perDevice.push({ deviceId: c.key.slice(0, -'|energy'.length), byBucket });
    }

    const buckets = [...bucketSet].sort((a, b) => a - b);
    let priced = tariffs.length > 0;
    const devices = perDevice.map(({ deviceId, byBucket }) => {
      const values = buckets.map(b => byBucket.get(b) || 0);
      let cost = 0;
      values.forEach((v, i) => {
        const p = priceAt(buckets[i], tariffs);
        if (p == null) { if (v > 0) priced = false; } else cost += v * p;
      });
      return { deviceId, values, kwh: values.reduce((a, v) => a + v, 0), cost };
    }).sort((a, b) => b.kwh - a.kwh);
    const totals = buckets.map((_, i) => devices.reduce((a, d) => a + d.values[i], 0));
    return {
      buckets, devices, totals,
      kwh: totals.reduce((a, v) => a + v, 0),
      cost: devices.reduce((a, d) => a + d.cost, 0),
      // false when some consumption falls before the first tariff (cost incomplete)
      priced,
    };
  }

  function stats() {
    const count = (t) => Number(db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c);
    const oldest = Number(db.prepare('SELECT min(ts) AS t FROM daily').get().t) || null;
    let bytes = null;
    try {
      const pc = db.prepare('PRAGMA page_count').get().page_count;
      const ps = db.prepare('PRAGMA page_size').get().page_size;
      bytes = Number(pc) * Number(ps);
    } catch { /* ignore */ }
    return {
      available: true, series: count('series'),
      rows: { raw: count('raw'), hourly: count('hourly'), daily: count('daily') },
      oldest, bytes, settings: getSettings(),
    };
  }

  return {
    available: true, batch, record, recordServices, prune, query, sparklines, seriesFor, stats,
    getSettings, setSettings, pickResolution, energy, getTariffs, setTariffs, close: () => db.close(),
  };
}

// Same interface, does nothing — used when SQLite can't be opened.
function disabledStore(reason) {
  const empty = () => ({ res: 'raw', points: [] });
  return {
    available: false, reason,
    batch: (fn) => fn(), record() {}, recordServices() {}, prune: () => ({ raw: 0, hourly: 0, daily: 0 }),
    query: empty, sparklines: () => ({}), seriesFor: () => [],
    stats: () => ({ available: false, reason }), getSettings: () => ({ ...DEFAULT_SETTINGS }),
    setSettings() { throw Object.assign(new Error('history unavailable: ' + reason), { status: 503 }); },
    pickResolution: () => 'raw', close() {},
    energy: () => ({ buckets: [], devices: [], totals: [], kwh: 0, cost: 0, priced: false }),
    getTariffs: () => [],
    setTariffs() { throw Object.assign(new Error('history unavailable: ' + reason), { status: 503 }); },
  };
}

module.exports = { openHistory, extractMetrics, DEFAULT_SETTINGS, HOUR, DAY };
