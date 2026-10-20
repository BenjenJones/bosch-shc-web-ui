// Unit tests for the Health tab's issue derivation (public/js/health.js) and
// the shared battery/fault helpers in core.js. Same Node-only setup as
// client-messages.test.mjs: stub localStorage, then import the browser modules.
import { describe, test, expect, beforeAll, beforeEach } from 'vitest';

globalThis.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};

let state, deviceBatteryLevel, deviceFaults, deviceIssues, batterySeverity;
beforeAll(async () => {
  const core = await import('../public/js/core.js');
  const health = await import('../public/js/health.js');
  ({ state, deviceBatteryLevel, deviceFaults } = core);
  // t() falls back to the key when a dictionary is loaded but has no entry.
  core.I18N.de = {}; core.I18N.en = {};
  ({ deviceIssues, batterySeverity } = health);
});

beforeEach(() => {
  state.devices = [];
  state.services = [];
  state.messages = [];
  state.messageArchive = [];
});

const dev = (extra = {}) => ({ id: 'd1', name: 'Dev', status: 'AVAILABLE', roomId: 'r1', ...extra });
const kinds = (issues) => issues.map(i => i.kind).sort();

describe('deviceBatteryLevel', () => {
  test('mains-powered device has no battery level', () => {
    expect(deviceBatteryLevel(dev())).toBe(null);
  });

  test('BatteryLevel service without fault means OK', () => {
    state.services = [{ id: 'BatteryLevel', deviceId: 'd1' }];
    expect(deviceBatteryLevel(dev())).toBe('OK');
  });

  test('fault on the service wins over warningLevel', () => {
    state.services = [{ id: 'BatteryLevel', deviceId: 'd1', state: { warningLevel: 'OK' },
      faults: { entries: [{ type: 'LOW_BATTERY', category: 'WARNING' }] } }];
    expect(deviceBatteryLevel(dev())).toBe('LOW_BATTERY');
  });

  test('active LOW_BATTERY message counts, archived one does not', () => {
    state.services = [{ id: 'BatteryLevel', deviceId: 'd1' }];
    state.messages = [{ id: 'm1', sourceId: 'd1', messageCode: { name: 'LOW_BATTERY' } }];
    expect(deviceBatteryLevel(dev())).toBe('LOW_BATTERY');
    state.messageArchive = [{ id: 'm1' }];
    expect(deviceBatteryLevel(dev())).toBe('OK');
  });

  test('CRITICALLY_LOW_BATTERY message counts', () => {
    state.services = [{ id: 'BatteryLevel', deviceId: 'd1' }];
    state.messages = [{ id: 'm2', sourceId: 'd1', messageCode: { name: 'CRITICALLY_LOW_BATTERY' } }];
    expect(deviceBatteryLevel(dev())).toBe('CRITICALLY_LOW_BATTERY');
  });
});

describe('deviceFaults', () => {
  test('excludes battery faults and collapses duplicates', () => {
    state.services = [
      { id: 'BatteryLevel', deviceId: 'd1', faults: { entries: [{ type: 'LOW_BATTERY' }] } },
      { id: 'ValveTappet', deviceId: 'd1', faults: { entries: [{ type: 'VALVE_NO_MOTOR_ERROR' }] } },
    ];
    const d = dev({ faults: { entries: [{ type: 'VALVE_NO_MOTOR_ERROR' }] } });
    expect(deviceFaults(d).map(f => f.type)).toEqual(['VALVE_NO_MOTOR_ERROR']);
  });
});

describe('batterySeverity', () => {
  test.each([
    [null, 0], ['OK', 0], ['NOT_AVAILABLE', 0],
    ['LOW_BATTERY', 2], ['CRITICAL_LOW', 3], ['CRITICALLY_LOW_BATTERY', 3], ['INSERT_BATTERY', 3], ['SOMETHING_NEW', 1],
  ])('%s → %i', (level, sev) => expect(batterySeverity(level)).toBe(sev));
});

describe('deviceIssues', () => {
  test('healthy device has no issues', () => {
    state.services = [
      { id: 'BatteryLevel', deviceId: 'd1' },
      { id: 'CommunicationQuality', deviceId: 'd1', state: { quality: 'GOOD' } },
    ];
    expect(deviceIssues(dev())).toEqual([]);
  });

  test('collects offline, battery, fault, signal and update issues', () => {
    state.services = [
      { id: 'BatteryLevel', deviceId: 'd1', faults: { entries: [{ type: 'CRITICAL_LOW' }] } },
      { id: 'ValveTappet', deviceId: 'd1', faults: { entries: [{ type: 'VALVE_NO_BODY_ERROR', category: 'WARNING' }] } },
      { id: 'CommunicationQuality', deviceId: 'd1', state: { quality: 'BAD' } },
      { id: 'SoftwareUpdate', deviceId: 'd1', state: { swUpdateState: 'UPDATE_AVAILABLE' } },
    ];
    const issues = deviceIssues(dev({ status: 'UNAVAILABLE' }));
    expect(kinds(issues)).toEqual(['battery', 'faults', 'offline', 'signal', 'updates']);
    const sev = Object.fromEntries(issues.map(i => [i.kind, i.severity]));
    expect(sev).toEqual({ offline: 3, battery: 3, faults: 2, signal: 2, updates: 1 });
  });

  test('COMMUNICATION_ERROR counts as offline, UNDEFINED does not', () => {
    expect(kinds(deviceIssues(dev({ status: 'COMMUNICATION_ERROR' })))).toEqual(['offline']);
    expect(deviceIssues(dev({ status: 'UNDEFINED' }))).toEqual([]);
  });

  test('MEDIUM signal is not an issue', () => {
    state.services = [{ id: 'CommunicationQuality', deviceId: 'd1', state: { quality: 'MEDIUM' } }];
    expect(deviceIssues(dev())).toEqual([]);
  });
});
