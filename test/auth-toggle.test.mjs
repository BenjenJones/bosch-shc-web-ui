// Turning login on/off from the running UI (POST /api/auth/enable|disable).
// Runs against a throwaway copy of the fixture config in a temp data dir,
// since both endpoints rewrite config.json and auth.json.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll } from 'vitest';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Must be set BEFORE importing server.js — it reads them at module top.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bosch-shc-auth-'));
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'config.json'), 'utf8'));
fs.writeFileSync(CONFIG_FILE, JSON.stringify({
  ...fixture,
  certPath: path.join(ROOT, fixture.certPath),
  keyPath:  path.join(ROOT, fixture.keyPath),
  uiTls: { enabled: false }, // a foreign key that must survive the toggle
}, null, 2));
process.env.BOSCH_SHC_DATA_DIR    = DATA_DIR;
process.env.BOSCH_SHC_CONFIG_FILE = CONFIG_FILE;
process.env.BOSCH_SHC_NO_LISTEN   = '1';
process.env.BOSCH_SHC_MESSAGE_ARCHIVE_FILE = path.join(DATA_DIR, 'messages.ndjson');

let app;
beforeAll(async () => {
  const mod = await import('../server.js');
  app = mod.default?.app || mod.app;
});

const readConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

describe('login on/off from the UI', () => {
  let cookie;

  test('enable validates input', async () => {
    const res = await request(app).post('/api/auth/enable').send({ adminUsername: 'admin', adminPassword: 'x' });
    expect(res.status).toBe(400);
    expect(readConfig().authEnabled).toBe(false);
  });

  test('enable turns auth on and logs the caller in', async () => {
    const res = await request(app).post('/api/auth/enable').send({ adminUsername: 'boss', adminPassword: 'secret1' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'boss', role: 'admin' });
    cookie = res.headers['set-cookie'][0].split(';')[0];

    const cfg = readConfig();
    expect(cfg.authEnabled).toBe(true);
    expect(cfg.uiTls).toEqual({ enabled: false });
    expect(cfg.shcPort).toBe(fixture.shcPort);

    expect((await request(app).get('/api/rooms')).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user.username).toBe('boss');
  });

  test('enable is refused once auth is on', async () => {
    const res = await request(app).post('/api/auth/enable').send({ adminUsername: 'evil', adminPassword: 'secret1' });
    expect(res.status).toBe(409);
  });

  test('disable needs an admin session and the right password', async () => {
    expect((await request(app).post('/api/auth/disable').send({ password: 'secret1' })).status).toBe(401);
    expect((await request(app).post('/api/auth/disable').set('Cookie', cookie).send({ password: 'wrong' })).status).toBe(401);
    expect(readConfig().authEnabled).toBe(true);
  });

  test('disable turns auth off and keeps auth.json', async () => {
    const res = await request(app).post('/api/auth/disable').set('Cookie', cookie).send({ password: 'secret1' });
    expect(res.status).toBe(200);
    expect(readConfig().authEnabled).toBe(false);
    expect(fs.existsSync(path.join(DATA_DIR, 'auth.json'))).toBe(true);
    expect((await request(app).get('/api/auth/status')).body.enabled).toBe(false);
  });
});
