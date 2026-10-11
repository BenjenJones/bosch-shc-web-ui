import { state, $, $$, t, api, escapeHtml, roomName, deviceName } from './core.js';
import { showModal } from './modals.js';

// =========================================================================
//  History charts — hand-drawn SVG (no chart library: CSP allows only
//  same-origin scripts and the app ships without a bundler). Data comes from
//  /api/history (server-side SQLite, see history.js).
//
//  Visual rules: one y-axis per chart; 2px lines; min/max as a faint band
//  for aggregated data; a second series (setpoint) dashed *and* coloured so
//  it isn't told apart by colour alone; recessive grid; crosshair tooltip.
//  Series colours (#0284c7 / #d97706) are validated for CVD separation and
//  contrast on both the light and the dark card surface.
// =========================================================================

// Which services produce which history metric — mirrors METRICS in history.js.
const SERVICE_METRICS = {
  TemperatureLevel: ['temperature'], HumidityLevel: ['humidity'], RoomClimateControl: ['setpoint'],
  PowerMeter: ['power', 'energy'], ShutterContact: ['contact'], ValveTappet: ['valve'],
  AirQualityLevel: ['purity'], ShutterControl: ['shutter'], MultiLevelSensor: ['illuminance'],
};
const METRIC_ORDER = ['temperature', 'humidity', 'energy', 'power', 'contact', 'valve', 'purity', 'shutter', 'illuminance', 'setpoint'];
const METRIC_DEFS = {
  temperature: { unit: '°C', dec: 1 },
  setpoint:    { unit: '°C', dec: 1, step: true },
  humidity:    { unit: '%', dec: 0 },
  power:       { unit: 'W', dec: 0 },
  energy:      { unit: 'kWh', dec: 2, bars: true },
  contact:     { step: true, binary: true },
  valve:       { unit: '%', dec: 0 },
  purity:      { unit: 'ppm', dec: 0 },
  shutter:     { unit: '%', dec: 0, step: true },
  illuminance: { unit: 'lx', dec: 0 },
};
const HOUR = 3600e3, DAY = 24 * HOUR;
const RANGES = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '1y': 365 * DAY };

// Does this device have any service we record history for?
const hasHistory = (deviceId) =>
  state.historyAvailable && state.services.some(s => s.deviceId === deviceId && SERVICE_METRICS[s.id]);

const locale = () => (state.lang === 'en' ? 'en-GB' : 'de-DE');
const fmt = (v, dec = 1) => (v == null || !Number.isFinite(v)) ? '–'
  : v.toLocaleString(locale(), { minimumFractionDigits: dec, maximumFractionDigits: dec });

// ---- scales / ticks ------------------------------------------------------
function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

// Decimals needed to print every tick exactly (step 2.5 → 1, 0.25 → 2).
function tickDec(ticks) {
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
  for (let d = 0; d < 3; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) return d;
  return 3;
}

function timeTicks(from, to, rangeKey) {
  const out = [];
  const d = new Date(from);
  if (rangeKey === '24h') {
    d.setMinutes(0, 0, 0);
    while (d.getHours() % 6) d.setHours(d.getHours() + 1);
    for (; d.getTime() <= to; d.setHours(d.getHours() + 6))
      out.push([d.getTime(), d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })]);
  } else if (rangeKey === '1y') {
    d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
    for (; d.getTime() <= to; d.setMonth(d.getMonth() + 2))
      out.push([d.getTime(), d.toLocaleDateString(locale(), { month: 'short' })]);
  } else {
    const stepDays = rangeKey === '7d' ? 1 : 7;
    d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1);
    for (; d.getTime() <= to; d.setDate(d.getDate() + stepDays))
      out.push([d.getTime(), rangeKey === '7d'
        ? d.toLocaleDateString(locale(), { weekday: 'short' })
        : d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' })]);
  }
  return out;
}

const tooltipTime = (ts, res) => new Date(ts).toLocaleString(locale(), res === 'day'
  ? { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }
  : { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// ---- chart rendering -----------------------------------------------------
// series: [{ label, cls, dashed, step, points: [[ts, avg, min, max]] }]
function renderLineChart(el, series, { from, to, rangeKey, res, def }) {
  const W = Math.max(280, el.clientWidth || 560), H = 220;
  const P = { l: 44, r: 10, t: 10, b: 24 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const band = res !== 'raw';
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const p of s.points) {
    lo = Math.min(lo, band ? p[2] : p[1]); hi = Math.max(hi, band ? p[3] : p[1]);
  }
  if (!Number.isFinite(lo)) { el.innerHTML = `<p class="text-sm text-slate-500 py-8 text-center">${t('history.noData')}</p>`; return; }
  const yt = def.binary ? [0, 1] : niceTicks(lo, hi);
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const x = (ts) => P.l + ((ts - from) / (to - from)) * iw;
  const y = (v) => P.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
  // Break the line at gaps (missed samples / server offline) rather than
  // drawing a misleading straight segment across them.
  const gapMs = res === 'raw' ? HOUR : res === 'hour' ? 3 * HOUR : 3 * DAY;
  const yDec = tickDec(yt);
  const yLabel = (v) => def.binary ? t(v ? 'history.stateOpen' : 'history.stateClosed') : fmt(v, yDec);

  const path = (pts, step) => {
    let d = '', prev = null;
    for (const p of pts) {
      const px = x(p[0]).toFixed(1), py = y(p[1]).toFixed(1);
      if (!prev || p[0] - prev[0] > gapMs) d += `M${px},${py}`;
      else d += step ? `H${px}V${py}` : `L${px},${py}`;
      prev = p;
    }
    return d;
  };
  const bandPath = (pts) => {
    // One closed polygon per contiguous run (max forward, min backward).
    const runs = []; let run = [];
    for (const p of pts) { if (run.length && p[0] - run[run.length - 1][0] > gapMs) { runs.push(run); run = []; } run.push(p); }
    if (run.length) runs.push(run);
    return runs.filter(r => r.length > 1).map(r =>
      'M' + r.map(p => `${x(p[0]).toFixed(1)},${y(p[3]).toFixed(1)}`).join('L') +
      'L' + [...r].reverse().map(p => `${x(p[0]).toFixed(1)},${y(p[2]).toFixed(1)}`).join('L') + 'Z').join('');
  };

  el.innerHTML = `
    <div class="chart relative text-slate-500">
      <svg width="${W}" height="${H}" role="img" aria-label="${escapeHtml(series.map(s => s.label).join(', '))}">
        ${yt.map(v => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" class="chart-grid" />
          <text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11">${yLabel(v)}</text>`).join('')}
        ${timeTicks(from, to, rangeKey).map(([ts, l]) =>
          `<text x="${x(ts)}" y="${H - 6}" text-anchor="middle" font-size="11">${escapeHtml(l)}</text>`).join('')}
        ${series.map(s => band && !s.step ? `<path d="${bandPath(s.points)}" class="${s.cls} chart-band" />` : '').join('')}
        ${series.map(s => `<path d="${path(s.points, s.step)}" class="${s.cls} chart-line${s.dashed ? ' chart-dashed' : ''}" />`).join('')}
        <line class="chart-cross" y1="${P.t}" y2="${P.t + ih}" visibility="hidden" />
        ${series.map((s, i) => `<circle r="4" class="${s.cls} chart-dot" data-dot="${i}" visibility="hidden" />`).join('')}
        <rect x="${P.l}" y="${P.t}" width="${iw}" height="${ih}" fill="transparent" data-hit />
      </svg>
      <div class="chart-tip hidden absolute pointer-events-none bg-white border border-slate-200 rounded-md shadow px-2 py-1 text-xs text-slate-700 whitespace-nowrap"></div>
    </div>`;

  // Crosshair + tooltip: nearest sample of each series to the pointer.
  const svg = el.querySelector('svg'), tip = el.querySelector('.chart-tip');
  const cross = svg.querySelector('.chart-cross');
  const nearest = (pts, ts) => {
    let lo2 = 0, hi2 = pts.length - 1;
    while (hi2 - lo2 > 1) { const m = (lo2 + hi2) >> 1; if (pts[m][0] < ts) lo2 = m; else hi2 = m; }
    return Math.abs(pts[lo2][0] - ts) <= Math.abs(pts[hi2][0] - ts) ? pts[lo2] : pts[hi2];
  };
  const hit = svg.querySelector('[data-hit]');
  const hide = () => { cross.setAttribute('visibility', 'hidden'); $$('[data-dot]', svg).forEach(d => d.setAttribute('visibility', 'hidden')); tip.classList.add('hidden'); };
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const ts = from + ((e.clientX - r.left - P.l) / iw) * (to - from);
    const ref = series.find(s => s.points.length);
    if (!ref) return;
    const p0 = nearest(ref.points, ts);
    const cx = x(p0[0]);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    const rows = series.map((s, i) => {
      const dot = svg.querySelector(`[data-dot="${i}"]`);
      if (!s.points.length) return '';
      const p = nearest(s.points, p0[0]);
      dot.setAttribute('cx', x(p[0])); dot.setAttribute('cy', y(p[1])); dot.setAttribute('visibility', 'visible');
      const val = def.binary ? t(p[1] >= 0.5 ? 'history.stateOpen' : 'history.stateClosed') : `${fmt(p[1], def.dec)} ${def.unit}`;
      const range = band && !def.binary && !s.step ? ` <span class="text-slate-400">(${fmt(p[2], def.dec)}–${fmt(p[3], def.dec)})</span>` : '';
      return `<div><span class="${s.cls} chart-key${s.dashed ? ' chart-dashed' : ''}"></span>${escapeHtml(s.label)}: <b>${val}</b>${range}</div>`;
    }).join('');
    tip.innerHTML = `<div class="text-slate-500">${tooltipTime(p0[0], res)}</div>${rows}`;
    tip.classList.remove('hidden');
    const left = Math.min(Math.max(cx + 10, 0), W - tip.offsetWidth - 4);
    tip.style.left = (cx + 10 + tip.offsetWidth > W ? cx - tip.offsetWidth - 10 : left) + 'px';
    tip.style.top = '4px';
  });
}

// bars: [[ts, value, label]]
function renderBarChart(el, bars, { def }) {
  const W = Math.max(280, el.clientWidth || 560), H = 220;
  const P = { l: 44, r: 10, t: 10, b: 24 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  if (!bars.length) { el.innerHTML = `<p class="text-sm text-slate-500 py-8 text-center">${t('history.noData')}</p>`; return; }
  const yt = niceTicks(0, Math.max(...bars.map(b => b[1]), 0.001));
  const y1 = yt[yt.length - 1];
  const slot = iw / bars.length;
  const bw = Math.max(1, Math.min(slot - 2, 40));
  const y = (v) => P.t + ih - (v / y1) * ih;
  const labelEvery = Math.ceil(bars.length / 8);
  el.innerHTML = `
    <div class="chart relative text-slate-500">
      <svg width="${W}" height="${H}" role="img" aria-label="${escapeHtml(t('history.consumption'))}">
        ${yt.map(v => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" class="chart-grid" />
          <text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11">${fmt(v, tickDec(yt))}</text>`).join('')}
        ${bars.map((b, i) => {
          const bx = P.l + i * slot + (slot - bw) / 2, by = y(b[1]);
          return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, P.t + ih - by).toFixed(1)}" rx="${bw > 6 ? 2 : 0}" class="chart-s1 chart-bar" data-bar="${i}" />
            ${i % labelEvery === 0 ? `<text x="${(bx + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11">${escapeHtml(b[2])}</text>` : ''}`;
        }).join('')}
      </svg>
      <div class="chart-tip hidden absolute pointer-events-none bg-white border border-slate-200 rounded-md shadow px-2 py-1 text-xs text-slate-700 whitespace-nowrap"></div>
    </div>`;
  const tip = el.querySelector('.chart-tip');
  $$('[data-bar]', el).forEach(r => {
    r.addEventListener('pointerenter', () => {
      const b = bars[Number(r.dataset.bar)];
      tip.innerHTML = `<div class="text-slate-500">${escapeHtml(b[3] || b[2])}</div><b>${fmt(b[1], def.dec)} ${def.unit}</b>`;
      tip.classList.remove('hidden');
      const bx = Number(r.getAttribute('x'));
      tip.style.left = Math.min(bx, W - tip.offsetWidth - 4) + 'px';
      tip.style.top = '4px';
    });
    r.addEventListener('pointerleave', () => tip.classList.add('hidden'));
  });
}

// ---- data ----------------------------------------------------------------
const fetchSeries = (series, from, to, res = 'auto') =>
  api(`api/history?series=${encodeURIComponent(series)}&from=${Math.round(from)}&to=${Math.round(to)}&res=${res}`);

// Energy counter (Wh, cumulative) → consumption per bucket (kWh). Each bucket
// is the delta of its last reading to the previous bucket's last reading;
// counter resets (negative delta) count as 0.
function energyBars(points, rangeKey) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const kwh = Math.max(0, (points[i][4] - points[i - 1][4]) / 1000);
    out.push([points[i][0], kwh]);
  }
  const lbl = (ts, o) => new Date(ts).toLocaleString(locale(), o);
  if (rangeKey === '1y') {
    // Months: sum the daily deltas per calendar month.
    const months = new Map();
    for (const [ts, v] of out) {
      const d = new Date(ts); const key = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      months.set(key, (months.get(key) || 0) + v);
    }
    return [...months].map(([ts, v]) => [ts, v, lbl(ts, { month: 'short' }), lbl(ts, { month: 'long', year: 'numeric' })]);
  }
  return out.map(([ts, v]) => rangeKey === '24h'
    ? [ts, v, lbl(ts, { hour: '2-digit' }), lbl(ts, { weekday: 'short', hour: '2-digit', minute: '2-digit' })]
    : [ts, v, lbl(ts, rangeKey === '7d' ? { weekday: 'short' } : { day: '2-digit' }), lbl(ts, { weekday: 'short', day: '2-digit', month: '2-digit' })]);
}

// ---- modal ----------------------------------------------------------------
let modalState = null;

async function openHistoryModal(deviceId, preferMetric) {
  const dev = state.devices.find(d => d.id === deviceId);
  // Same naming rule as the favourites: the virtual climate controller is
  // better known by its room.
  const title = dev?.deviceModel === 'ROOM_CLIMATE_CONTROL' ? roomName(dev.roomId) : deviceName(deviceId);
  showModal(`<p class="text-sm text-slate-500">${t('history.loading')}</p>`);
  $('#modal-card').classList.remove('max-w-md');
  $('#modal-card').classList.add('max-w-2xl');
  let metrics = [];
  try { metrics = (await api(`api/history/series?deviceId=${encodeURIComponent(deviceId)}`)).metrics || []; }
  catch (err) { showModal(`<p class="text-sm text-rose-600">${escapeHtml(t('error.generic', err.message))}</p>`); return; }
  // Setpoint is drawn into the temperature chart, not as its own tab.
  const tabs = METRIC_ORDER.filter(m => metrics.includes(m) && !(m === 'setpoint' && metrics.includes('temperature')));
  modalState = { deviceId, metrics, tabs, metric: tabs.includes(preferMetric) ? preferMetric : tabs[0], range: '24h' };
  showModal(`
    <div class="flex items-start justify-between gap-2 mb-3">
      <div>
        <h4 class="font-medium">${escapeHtml(title)}</h4>
        <p class="text-xs text-slate-500">${t('history.title')}</p>
      </div>
      <button id="h-close" class="text-slate-400 hover:text-slate-700 text-xl leading-none px-1" aria-label="${t('modal.cancel')}">×</button>
    </div>
    ${tabs.length ? `
      <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div class="inline-flex flex-wrap gap-1" id="h-metrics">
          ${tabs.map(m => `<button data-h-metric="${m}" class="px-2 py-1 text-xs rounded-md border border-slate-300">${t('history.m.' + m)}</button>`).join('')}
        </div>
        <div class="inline-flex text-xs border border-slate-300 rounded-md overflow-hidden" id="h-ranges">
          ${Object.keys(RANGES).map((r, i) => `<button data-h-range="${r}" class="px-2 py-1 ${i ? 'border-l border-slate-300' : ''}">${t('history.r.' + r)}</button>`).join('')}
        </div>
      </div>
      <div id="h-chart" class="min-h-[220px]"></div>
      <div id="h-legend" class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600"></div>
      <div id="h-summary" class="mt-2 text-xs text-slate-500"></div>`
    : `<p class="text-sm text-slate-500 py-6">${t('history.noData')}</p>`}`);
  $('#h-close').onclick = () => $('#modal-root').click();
  $$('[data-h-metric]').forEach(b => b.addEventListener('click', () => { modalState.metric = b.dataset.hMetric; drawModalChart(); }));
  $$('[data-h-range]').forEach(b => b.addEventListener('click', () => { modalState.range = b.dataset.hRange; drawModalChart(); }));
  if (tabs.length) drawModalChart();
}

async function drawModalChart() {
  const ms = modalState;
  const mine = { ...ms };
  const toggle = (sel, attr, val) => $$(sel).forEach(b => {
    const on = b.dataset[attr] === val;
    b.classList.toggle('bg-blue-600', on); b.classList.toggle('text-white', on);
  });
  toggle('[data-h-metric]', 'hMetric', ms.metric);
  toggle('[data-h-range]', 'hRange', ms.range);
  const el = $('#h-chart');
  if (!el) return;
  const def = METRIC_DEFS[ms.metric];
  const to = Date.now(), from = to - RANGES[ms.range];
  try {
    if (def.bars) {
      // One extra bucket before the range so the first delta has a base.
      const res = ms.range === '24h' ? 'hour' : 'day';
      const pad = res === 'hour' ? HOUR : DAY;
      const r = await fetchSeries(`${ms.deviceId}|energy`, from - pad, to, res);
      if (modalState !== ms || ms.metric !== mine.metric || ms.range !== mine.range) return;
      const bars = energyBars(r.points, ms.range);
      renderBarChart(el, bars, { def });
      $('#h-legend').innerHTML = '';
      const total = bars.reduce((a, b) => a + b[1], 0);
      $('#h-summary').textContent = t('history.total', `${fmt(total, 2)} kWh`);
      return;
    }
    const wanted = [{ metric: ms.metric, label: t('history.m.' + ms.metric), cls: 'chart-s1' }];
    if (ms.metric === 'temperature' && ms.metrics.includes('setpoint'))
      wanted.push({ metric: 'setpoint', label: t('history.m.setpoint'), cls: 'chart-s2', dashed: true, step: true });
    const results = await Promise.all(wanted.map(w => fetchSeries(`${ms.deviceId}|${w.metric}`, from, to)));
    if (modalState !== ms || ms.metric !== mine.metric || ms.range !== mine.range) return;
    const res = results[0].res;
    const series = wanted.map((w, i) => ({ ...w, step: w.step || def.step, points: results[i].points }));
    renderLineChart(el, series, { from, to, rangeKey: ms.range, res, def });
    // Legend only when there's more than one series; a single one is named by the tab.
    $('#h-legend').innerHTML = series.length > 1 ? series.map(s =>
      `<span class="inline-flex items-center gap-1.5"><span class="${s.cls} chart-key${s.dashed ? ' chart-dashed' : ''}"></span>${escapeHtml(s.label)}</span>`).join('') : '';
    const pts = series[0].points;
    if (pts.length && !def.binary) {
      const min = Math.min(...pts.map(p => p[2])), max = Math.max(...pts.map(p => p[3]));
      const avg = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      $('#h-summary').textContent = t('history.summary', `${fmt(min, def.dec)} ${def.unit}`, `${fmt(avg, def.dec)} ${def.unit}`, `${fmt(max, def.dec)} ${def.unit}`);
    } else {
      $('#h-summary').textContent = '';
    }
  } catch (err) {
    el.innerHTML = `<p class="text-sm text-rose-600 py-6">${escapeHtml(t('error.generic', err.message))}</p>`;
  }
}

// ---- room sparklines ------------------------------------------------------
// Placeholders `<span data-spark="<series>" data-spark-device="<id>">` are
// filled after each dashboard render. Results are cached for 10 minutes so
// live-event re-renders don't refetch.
const SPARK_TTL = 10 * 60e3;
const sparkCache = new Map(); // series -> { at, points }

function sparkSvg(points) {
  if (points.length < 2) return '';
  const W = 56, H = 16;
  const vals = points.map(p => p[1]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const t0 = points[0][0], t1 = points[points.length - 1][0];
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${((p[0] - t0) / (t1 - t0 || 1) * (W - 2) + 1).toFixed(1)},${(H - 2 - ((p[1] - lo) / (hi - lo || 1)) * (H - 4)).toFixed(1)}`).join('');
  return `<svg width="${W}" height="${H}" class="chart-spark" aria-hidden="true"><path d="${d}" /></svg>`;
}

async function fillSparklines(root) {
  if (!state.historyAvailable) return;
  const els = $$('[data-spark]', root);
  if (!els.length) return;
  const now = Date.now();
  const missing = [...new Set(els.map(e => e.dataset.spark))]
    .filter(s => !(sparkCache.get(s)?.at > now - SPARK_TTL));
  if (missing.length) {
    try {
      const r = await api(`api/history/spark?series=${missing.map(encodeURIComponent).join(',')}`);
      for (const s of missing) sparkCache.set(s, { at: now, points: r.series?.[s] || [] });
    } catch { return; }
  }
  for (const e of $$('[data-spark]', root)) {
    e.innerHTML = sparkSvg(sparkCache.get(e.dataset.spark)?.points || []);
  }
}

// Clicks on chart buttons / sparklines anywhere open the modal. Delegated
// once from boot so re-renders need no re-wiring.
function initCharts() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-history]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    openHistoryModal(b.dataset.history, b.dataset.historyMetric);
  });
}

export { initCharts, hasHistory, openHistoryModal, fillSparklines, energyBars, niceTicks, tickDec, renderBarChart };
