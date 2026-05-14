// End-to-end tests for the /api proxy routes in server.js.
//
// Each test fires a request at server.js (via supertest, no socket needed),
// which in turn talks to the Prism mock on :4010. Prism validates the
// outgoing request against the bundled Bosch OpenAPI spec — if server.js
// builds a wrong URL or sends a body the SHC wouldn't accept, Prism answers
// 422 and that bubbles up to the test as a non-2xx response.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll } from 'vitest';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Must set these BEFORE importing server.js — it reads them at module top.
process.env.BOSCH_SHC_CONFIG_FILE = path.join(__dirname, 'fixtures', 'config.json');
process.env.BOSCH_SHC_NO_LISTEN   = '1';

let app;
beforeAll(async () => {
  const mod = await import('../server.js');
  app = mod.default?.app || mod.app;
});

// =========================================================================
//  Read endpoints — should all return 200 with whatever the spec mocks up
// =========================================================================
describe('GET /api/* (read endpoints proxied to SHC)', () => {
  test.each([
    ['/api/rooms'],
    ['/api/devices'],
    ['/api/services'],
    ['/api/scenarios'],
    ['/api/messages'],
    ['/api/userdefinedstates'],
    ['/api/info'],
    ['/api/automations'],
    ['/api/intrusion'],
  ])('%s returns 200', async (url) => {
    const res = await request(app).get(url);
    expect(res.status, `expected 200 from ${url}, got ${res.status} body=${JSON.stringify(res.body)}`).toBe(200);
  });
});

// =========================================================================
//  PUT device service state — happy paths
//  These bodies match the Bosch service state schemas. Prism only returns
//  204 if every property (incl. @type discriminator and enum values) lines
//  up with what the SHC actually accepts.
// =========================================================================
describe('PUT device service state (valid payloads)', () => {
  const cases = [
    {
      name: 'PowerSwitch ON',
      service: 'PowerSwitch',
      body: { '@type': 'powerSwitchState', switchState: 'ON' },
    },
    {
      name: 'PowerSwitch OFF',
      service: 'PowerSwitch',
      body: { '@type': 'powerSwitchState', switchState: 'OFF' },
    },
    {
      name: 'ShutterControl level=50',
      service: 'ShutterControl',
      body: { '@type': 'shutterControlState', level: 0.5 },
    },
    {
      name: 'RoomClimateControl setpoint',
      service: 'RoomClimateControl',
      body: { '@type': 'climateControlState', setpointTemperature: 21.5 },
    },
  ];
  test.each(cases)('$name passes spec validation', async ({ service, body }) => {
    const res = await request(app)
      .put(`/api/devices/hdm:HomeMaticIP:0001/services/${service}/state`)
      .send(body);
    expect(res.status, `body=${JSON.stringify(res.body)}`).toBeLessThan(300);
  });
});

// =========================================================================
//  PUT device service state — sad paths
//  Each of these breaks the spec in a specific way. They MUST be rejected
//  by the mock (i.e. server.js's proxy must surface a 4xx); if any of them
//  starts succeeding, server.js is sending something the real SHC would
//  reject too.
// =========================================================================
describe('PUT device service state (invalid payloads are caught)', () => {
  const cases = [
    {
      name: 'PowerSwitch unknown enum value',
      service: 'PowerSwitch',
      body: { '@type': 'powerSwitchState', switchState: 'BANANA' },
      expectField: 'switchState',
    },
    {
      name: 'PowerSwitch wrong @type discriminator',
      service: 'PowerSwitch',
      body: { '@type': 'wrongTypeState', switchState: 'ON' },
      expectField: '@type',
    },
  ];
  test.each(cases)('$name is rejected with 4xx', async ({ service, body }) => {
    const res = await request(app)
      .put(`/api/devices/hdm:HomeMaticIP:0001/services/${service}/state`)
      .send(body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// =========================================================================
//  POST scenario trigger
// =========================================================================
describe('POST /api/scenarios/:id/trigger', () => {
  test('triggers a scenario', async () => {
    const res = await request(app).post('/api/scenarios/scn-1/trigger');
    expect(res.status).toBeLessThan(300);
  });
});

// =========================================================================
//  Intrusion detection state
// =========================================================================
describe('PUT /api/intrusion/state', () => {
  test('SYSTEM_ARMED is accepted', async () => {
    const res = await request(app)
      .put('/api/intrusion/state')
      .send({ value: 'SYSTEM_ARMED', activeProfile: '0' });
    expect(res.status).toBeLessThan(300);
  });
  test('SYSTEM_DISARMED is accepted', async () => {
    const res = await request(app)
      .put('/api/intrusion/state')
      .send({ value: 'SYSTEM_DISARMED' });
    expect(res.status).toBeLessThan(300);
  });
  test('bogus value is rejected with 4xx', async () => {
    const res = await request(app)
      .put('/api/intrusion/state')
      .send({ value: 'BANANA' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// =========================================================================
//  User-defined states (boolean body — server.js uses strict:false JSON
//  parser to allow a top-level scalar through)
// =========================================================================
describe('PUT /api/userdefinedstates/:id/state', () => {
  test('boolean true is accepted', async () => {
    const res = await request(app)
      .put('/api/userdefinedstates/abc/state')
      .set('Content-Type', 'application/json')
      .send('true');
    expect(res.status).toBeLessThan(300);
  });
});

// =========================================================================
//  Dismiss message
// =========================================================================
describe('DELETE /api/messages/:id', () => {
  test('dismisses a message', async () => {
    const res = await request(app).delete('/api/messages/m1');
    expect(res.status).toBeLessThan(300);
  });
});

// =========================================================================
//  Admin device/room mutations — auth disabled in test config, so they hit
//  the SHC paths directly.
// =========================================================================
describe('admin mutations', () => {
  test('PUT /api/devices/:id renames a device', async () => {
    const res = await request(app)
      .put('/api/devices/hdm:HomeMaticIP:0001')
      .send({ name: 'New Name' });
    expect(res.status).toBeLessThan(300);
  });
  test('PUT /api/rooms/:id renames a room', async () => {
    const res = await request(app)
      .put('/api/rooms/hz_1')
      .send({ name: 'New Room' });
    expect(res.status).toBeLessThan(300);
  });
  test('DELETE /api/devices/:id removes a device', async () => {
    const res = await request(app).delete('/api/devices/hdm:HomeMaticIP:0001');
    expect(res.status).toBeLessThan(300);
  });
});
