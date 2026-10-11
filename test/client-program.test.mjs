// Unit tests for the switch-program conversion (public/js/program.js).
import { describe, test, expect, beforeAll } from 'vitest';

globalThis.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};

let toDraft, fromDraft, daySegments, DAYS;
beforeAll(async () => {
  ({ toDraft, fromDraft, daySegments, DAYS } = await import('../public/js/program.js'));
});

const sp = (min, on) => ({ startTimeMinutes: min, value: { '@type': 'switchStateSwitchPointValue', switchState: on ? 'ON' : 'OFF' } });
// Real SHC default: every day "off from 00:00", manual.
const shcDefault = () => ({ '@type': 'powerSwitchProgramState', operationMode: 'MANUAL',
  schedule: { profiles: DAYS.map(day => ({ day, switchPoints: [sp(0, false)] })) } });

describe('switch program draft', () => {
  test('SHC default round-trips unchanged', () => {
    const out = fromDraft(toDraft('d', shcDefault()));
    expect(out).toEqual(shcDefault());
  });

  test('points are sorted, same-time duplicates collapse, empty days become "off from 00:00"', () => {
    const st = { operationMode: 'AUTOMATIC', schedule: { profiles: [
      { day: 'MONDAY', switchPoints: [sp(1320, false), sp(390, true), sp(390, false)] },
      { day: 'TUESDAY', switchPoints: [] },
    ] } };
    const d = toDraft('d', st);
    expect(d.operationMode).toBe('AUTOMATIC');
    expect(d.days.MONDAY).toEqual([{ min: 390, on: false }, { min: 1320, on: false }]);
    const out = fromDraft(d);
    expect(out.schedule.profiles).toHaveLength(7);
    expect(out.schedule.profiles[1].switchPoints).toEqual([sp(0, false)]);
  });

  test('timeline carries the previous day’s last state into the morning', () => {
    const d = toDraft('d', { schedule: { profiles: [
      { day: 'SUNDAY', switchPoints: [sp(1380, true)] },     // Sunday 23:00 on
      { day: 'MONDAY', switchPoints: [sp(360, false), sp(1080, true), sp(1320, false)] },
    ] } });
    expect(daySegments(d, 0)).toEqual([
      { from: 0, to: 360, on: true },      // still on from Sunday night
      { from: 360, to: 1080, on: false },
      { from: 1080, to: 1320, on: true },
      { from: 1320, to: 1440, on: false },
    ]);
  });
});
