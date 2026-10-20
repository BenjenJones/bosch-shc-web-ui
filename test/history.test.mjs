// Unit tests for the SQLite history store (history.js), run against an
// in-memory database.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openHistory, extractMetrics, HOUR, DAY } = require('../history.js');

let h;
beforeEach(() => { h = openHistory(':memory:'); });
afterEach(() => h.close());

// Fixed reference time on a full hour, so bucket boundaries are predictable.
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);

describe('extractMetrics', () => {
  test('maps known services to series and skips non-numeric values', () => {
    expect(extractMetrics({ id: 'TemperatureLevel', deviceId: 'd1', state: { temperature: 21.5 } }))
      .toEqual([{ series: 'd1|temperature', value: 21.5 }]);
    expect(extractMetrics({ id: 'TerminalConfiguration', deviceId: 'rt', state: { type: 'FLOOR_SENSOR_CONNECTED', temperature: 24.5 } }))
      .toEqual([{ series: 'rt|externalTemperature', value: 24.5 }]);
    expect(extractMetrics({ id: 'TerminalConfiguration', deviceId: 'rt', state: { type: 'NOT_CONNECTED' } })).toEqual([]);
    expect(extractMetrics({ id: 'PowerMeter', deviceId: 'p', state: { powerConsumption: 12, energyConsumption: 5000 } }))
      .toEqual([{ series: 'p|power', value: 12 }, { series: 'p|energy', value: 5000 }]);
    expect(extractMetrics({ id: 'ShutterContact', deviceId: 'c', state: { value: 'OPEN' } }))
      .toEqual([{ series: 'c|contact', value: 1 }]);
    expect(extractMetrics({ id: 'ShutterControl', deviceId: 's', state: { level: 0.47 } }))
      .toEqual([{ series: 's|shutter', value: 47 }]);
    // Gen1 motion detectors report illuminance as LOW/MEDIUM/HIGH — not charted.
    expect(extractMetrics({ id: 'MultiLevelSensor', deviceId: 'm', state: { illuminance: 'LOW' } })).toEqual([]);
    expect(extractMetrics({ id: 'Unknown', deviceId: 'x', state: { v: 1 } })).toEqual([]);
    expect(extractMetrics({ id: 'TemperatureLevel', deviceId: 'd1' })).toEqual([]);
  });
});

describe('record / query', () => {
  test('raw query returns recorded values in order', () => {
    h.record([{ series: 'a|temperature', value: 20 }], T0);
    h.record([{ series: 'a|temperature', value: 22 }], T0 + 10 * 60e3);
    const r = h.query('a|temperature', T0, T0 + HOUR, 'raw');
    expect(r.res).toBe('raw');
    expect(r.points.map(p => p[1])).toEqual([20, 22]);
  });

  test('hourly aggregate keeps min/max/avg/last', () => {
    h.record([{ series: 'a|power', value: 10 }], T0 + 1000);
    h.record([{ series: 'a|power', value: 30 }], T0 + 2000);
    h.record([{ series: 'a|power', value: 20 }], T0 + 3000);
    const [[ts, avg, min, max, last]] = h.query('a|power', T0, T0 + HOUR, 'hour').points;
    expect(ts).toBe(T0);
    expect({ avg, min, max, last }).toEqual({ avg: 20, min: 10, max: 30, last: 20 });
  });

  test('a late, older value does not overwrite "last"', () => {
    h.record([{ series: 'a|energy', value: 200 }], T0 + 2000);
    h.record([{ series: 'a|energy', value: 100 }], T0 + 1000);
    expect(h.query('a|energy', T0, T0 + HOUR, 'hour').points[0][4]).toBe(200);
  });

  test('auto resolution: raw for short ranges, hourly/daily for longer ones', () => {
    const now = T0 + 30 * DAY;
    expect(h.pickResolution(now - DAY, now, now)).toBe('raw');
    expect(h.pickResolution(now - 7 * DAY, now, now)).toBe('hour');
    expect(h.pickResolution(now - 365 * DAY, now, now)).toBe('day');
    // A short range older than raw retention can't be served raw.
    expect(h.pickResolution(now - 20 * DAY, now - 19 * DAY, now)).toBe('hour');
  });

  test('sparklines return hourly averages of the last 24 h', () => {
    h.record([{ series: 'r|temperature', value: 19 }], T0 - 2 * HOUR);
    h.record([{ series: 'r|temperature', value: 21 }], T0);
    h.record([{ series: 'r|temperature', value: 18 }], T0 - 30 * HOUR); // too old
    expect(h.sparklines(['r|temperature', 'none|x'], T0 + 5 * 60e3))
      .toEqual({ 'r|temperature': [[T0 - 2 * HOUR, 19], [T0, 21]], 'none|x': [] });
  });

  test('seriesFor lists metrics of one device only', () => {
    h.record([{ series: 'dev_1|temperature', value: 1 }, { series: 'dev_1|humidity', value: 2 },
              { series: 'devX1|temperature', value: 3 }], T0);
    expect(h.seriesFor('dev_1').sort()).toEqual(['humidity', 'temperature']);
  });
});

describe('retention', () => {
  test('prune removes rows past each tier retention', () => {
    h.setSettings({ rawDays: 1, hourlyDays: 2, dailyDays: 3 });
    for (const ageDays of [0.5, 1.5, 2.5, 4]) h.record([{ series: 'a|t', value: ageDays }], T0 - ageDays * DAY);
    h.prune(T0);
    expect(h.query('a|t', 0, T0, 'raw').points).toHaveLength(1);
    expect(h.query('a|t', 0, T0, 'hour').points).toHaveLength(2);
    // Daily buckets start at local midnight, so only assert the clear case:
    // the 4-day-old value is gone, the 0.5-day-old one is kept.
    const daily = h.query('a|t', 0, T0, 'day').points.map(p => p[4]);
    expect(daily).not.toContain(4);
    expect(daily).toContain(0.5);
  });

  test('0 = keep forever', () => {
    h.setSettings({ rawDays: 0, hourlyDays: 0, dailyDays: 0 });
    h.record([{ series: 'a|t', value: 1 }], T0 - 1000 * DAY);
    h.prune(T0);
    expect(h.query('a|t', 0, T0, 'raw').points).toHaveLength(1);
  });

  test('settings are validated and coarse tiers never shorter than finer ones', () => {
    expect(() => h.setSettings({ rawDays: -1 })).toThrow();
    expect(() => h.setSettings({ rawDays: 'abc' })).toThrow();
    expect(h.setSettings({ rawDays: 30, hourlyDays: 10 })).toMatchObject({ rawDays: 30, hourlyDays: 30 });
  });
});

describe('energy', () => {
  // Local-time helpers: energy buckets follow the server's local calendar.
  const at = (y, m, d, h = 0) => new Date(y, m - 1, d, h).getTime();

  test('daily consumption = delta of counter readings, incl. the reading before the range', () => {
    h.record([{ series: 'p1|energy', value: 1000 }], at(2026, 9, 30, 23));
    h.record([{ series: 'p1|energy', value: 3000 }], at(2026, 10, 1, 12));
    h.record([{ series: 'p1|energy', value: 3500 }], at(2026, 10, 2, 12));
    const e = h.energy(at(2026, 10, 1), at(2026, 10, 3), 'day');
    expect(e.buckets).toEqual([at(2026, 10, 1), at(2026, 10, 2)]);
    expect(e.devices[0]).toMatchObject({ deviceId: 'p1', values: [2, 0.5], kwh: 2.5 });
    expect(e.kwh).toBe(2.5);
  });

  test('first bucket without an earlier reading counts from its own first reading', () => {
    h.record([{ series: 'n|energy', value: 1000 }], at(2026, 10, 1, 9));
    h.record([{ series: 'n|energy', value: 1600 }], at(2026, 10, 1, 18));
    h.record([{ series: 'n|energy', value: 2000 }], at(2026, 10, 2, 12));
    for (const bucket of ['day', 'month']) {
      expect(h.energy(at(2026, 10, 1), at(2026, 11, 1), bucket).kwh).toBeCloseTo(1);
    }
    const hourly = h.energy(at(2026, 10, 1), at(2026, 10, 2), 'hour');
    expect(hourly.kwh).toBeCloseTo(0.6);
  });

  test('counter reset counts as 0, devices sorted by consumption, months grouped', () => {
    h.record([{ series: 'a|energy', value: 5000 }], at(2026, 1, 10, 12));
    h.record([{ series: 'a|energy', value: 100 }], at(2026, 1, 11, 12));   // reset
    h.record([{ series: 'a|energy', value: 1100 }], at(2026, 2, 5, 12));
    h.record([{ series: 'b|energy', value: 0 }], at(2026, 1, 10, 12));
    h.record([{ series: 'b|energy', value: 9000 }], at(2026, 2, 5, 12));
    const e = h.energy(at(2026, 1, 1), at(2026, 3, 1), 'month');
    expect(e.buckets).toEqual([at(2026, 1, 1), at(2026, 2, 1)]);
    expect(e.devices.map(d => d.deviceId)).toEqual(['b', 'a']);
    expect(e.devices[1].values).toEqual([0, 1]);
    expect(e.totals).toEqual([0, 10]);
  });

  test('costs follow the tariff valid on each day; consumption before the first tariff marks cost incomplete', () => {
    h.setTariffs([{ validFrom: '2026-10-02', price: 0.5 }, { validFrom: '2026-10-01', price: 0.3 }]);
    expect(h.getTariffs().map(t => t.validFrom)).toEqual(['2026-10-01', '2026-10-02']);
    h.record([{ series: 'p|energy', value: 0 }], at(2026, 9, 30, 12));
    h.record([{ series: 'p|energy', value: 1000 }], at(2026, 10, 1, 12));
    h.record([{ series: 'p|energy', value: 3000 }], at(2026, 10, 2, 12));
    const e = h.energy(at(2026, 10, 1), at(2026, 10, 3), 'day');
    expect(e.cost).toBeCloseTo(1 * 0.3 + 2 * 0.5);
    expect(e.priced).toBe(true);
    const early = h.energy(at(2026, 9, 30), at(2026, 10, 3), 'day');
    expect(early.priced).toBe(true); // first day has a single reading → 0 kWh, so nothing unpriced
    h.record([{ series: 'p|energy', value: 0 }], at(2026, 9, 29, 12));
    h.record([{ series: 'p|energy', value: 500 }], at(2026, 9, 30, 13));
    expect(h.energy(at(2026, 9, 30), at(2026, 10, 3), 'day').priced).toBe(false);
  });

  test('tariff validation', () => {
    expect(() => h.setTariffs([{ validFrom: '01.10.2026', price: 0.3 }])).toThrow();
    expect(() => h.setTariffs([{ validFrom: '2026-10-01', price: -1 }])).toThrow();
    expect(() => h.setTariffs('x')).toThrow();
  });
});
