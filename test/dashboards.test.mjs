// Custom dashboards: validation (dashboards.js) and the /api/dashboards
// routes in server.js. Auth is off in the fixture config, so PUT is open.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll } from 'vitest';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { sanitizeDashboards } = require('../dashboards.js');

process.env.BOSCH_SHC_CONFIG_FILE = path.join(__dirname, 'fixtures', 'config.json');
process.env.BOSCH_SHC_NO_LISTEN   = '1';

let app;
beforeAll(async () => {
  const mod = await import('../server.js');
  app = mod.default?.app || mod.app;
});

const widget = (extra = {}) => ({ id: 'w1', type: 'device', x: 0, y: 0, w: 4, h: 5, cfg: { deviceId: 'd1' }, ...extra });

describe('sanitizeDashboards', () => {
  test('keeps a valid dashboard as is', () => {
    const list = [{ id: 'a', name: 'Home', widgets: [widget()] }];
    expect(sanitizeDashboards(list)).toEqual(list);
  });

  test('clamps geometry into the 12-column grid', () => {
    const [d] = sanitizeDashboards([{ id: 'a', name: 'A', widgets: [widget({ x: 10, w: 6, y: -3, h: 99 })] }]);
    expect(d.widgets[0]).toMatchObject({ x: 6, w: 6, y: 0, h: 40 });
  });

  test('drops unknown cfg keys and non-string values', () => {
    const [d] = sanitizeDashboards([{ id: 'a', name: 'A', widgets: [widget({ cfg: { deviceId: 'd1', evil: 'x', metric: 5 } })] }]);
    expect(d.widgets[0].cfg).toEqual({ deviceId: 'd1' });
  });

  test.each([
    [{}, 'array'],
    [[{ id: '', name: 'A' }], 'id required'],
    [[{ id: 'a', name: ' ' }], 'name required'],
    [[{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }], 'duplicate'],
    [[{ id: 'a', name: 'A', widgets: [widget({ type: 'iframe' })] }], 'unknown type'],
  ])('rejects %j', (input, msg) => {
    expect(() => sanitizeDashboards(input)).toThrow(msg);
  });
});

describe('/api/dashboards', () => {
  test('starts empty', async () => {
    const res = await request(app).get('/api/dashboards');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('PUT stores the list and GET returns it', async () => {
    const list = [{ id: 'a', name: 'Wohnzimmer', widgets: [widget(), widget({ id: 'w2', type: 'clock', cfg: {} })] }];
    const put = await request(app).put('/api/dashboards').send(list);
    expect(put.status).toBe(200);
    expect(put.body).toEqual(list);
    const get = await request(app).get('/api/dashboards');
    expect(get.body).toEqual(list);
  });

  test('PUT with invalid data is a 400 and keeps the old list', async () => {
    const res = await request(app).put('/api/dashboards').send([{ id: 'x' }]);
    expect(res.status).toBe(400);
    const get = await request(app).get('/api/dashboards');
    expect(get.body[0]?.id).toBe('a');
  });
});
