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
