// Unit tests for the energy tab's calendar periods (public/js/energy.js).
// Same Node-only setup as the other client tests: stub localStorage, then
// import the browser module.
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

globalThis.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};

let periodRange, isoWeek;
beforeAll(async () => {
  const core = await import('../public/js/core.js');
  core.I18N.de = {}; core.I18N.en = {};
  ({ periodRange, isoWeek } = await import('../public/js/energy.js'));
  // Wednesday, 14 Oct 2026, 15:30 local time
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 14, 15, 30));
});
afterAll(() => vi.useRealTimers());

const local = (y, m, d) => new Date(y, m - 1, d).getTime();

describe('periodRange', () => {
  test('day: 24 hourly slots from local midnight; offset goes back', () => {
    const r = periodRange('day', 0);
    expect(r.from).toBe(local(2026, 10, 14));
    expect(r.bucket).toBe('hour');
    expect(r.slots).toHaveLength(24);
    expect(periodRange('day', -1).from).toBe(local(2026, 10, 13));
  });

  test('week starts on Monday', () => {
    const r = periodRange('week', 0);
    expect(r.from).toBe(local(2026, 10, 12));
    expect(r.to).toBe(local(2026, 10, 19));
    expect(r.slots).toHaveLength(7);
    expect(periodRange('week', -1).from).toBe(local(2026, 10, 5));
  });

  test('month has one slot per day, year one per month', () => {
    expect(periodRange('month', 0).slots).toHaveLength(31);
    expect(periodRange('month', -1).slots).toHaveLength(30); // September
    const y = periodRange('year', 0);
    expect(y.bucket).toBe('month');
    expect(y.slots).toHaveLength(12);
    expect(y.from).toBe(local(2026, 1, 1));
  });
});

describe('isoWeek', () => {
  test.each([
    [new Date(2026, 9, 14), 42],
    [new Date(2026, 0, 1), 1],   // Thursday → week 1
    [new Date(2027, 0, 1), 53],  // Friday → still week 53 of 2026
  ])('%s → KW %i', (d, w) => expect(isoWeek(d)).toBe(w));
});

describe('chart tick decimals', () => {
  test('just enough decimals for the tick step', async () => {
    const { tickDec, niceTicks } = await import('../public/js/charts.js');
    expect(tickDec([0, 2.5, 5, 7.5, 10])).toBe(1);
    expect(tickDec([0, 100, 200])).toBe(0);
    expect(tickDec([0, 0.25, 0.5])).toBe(2);
    expect(niceTicks(0, 9.2)).toEqual([0, 2.5, 5, 7.5, 10]);
  });
});
