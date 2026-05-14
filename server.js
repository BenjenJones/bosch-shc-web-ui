/**
 * Bosch SHC – local proxy + UI server
 *  - Holds the client certificate (mTLS) for the SHC connection
 *  - Exposes a small REST API for the browser UI
 *  - Streams live events (long polling -> Server-Sent Events) to the UI
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const express = require('express');

// Config & auth paths can be overridden via env (used by the test harness so
// it doesn't have to touch the real config.json sitting next to the source).
const CONFIG_FILE = process.env.BOSCH_SHC_CONFIG_FILE || path.join(__dirname, 'config.json');
const AUTH_FILE   = process.env.BOSCH_SHC_AUTH_FILE   || path.join(__dirname, 'auth.json');
if (!fs.existsSync(CONFIG_FILE)) {
  console.error('✖ config.json missing. Please run `npm run setup` first.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
// shcProtocol defaults to 'https' (real SHC requires mTLS). The test harness
// sets it to 'http' so it can point at Prism, which has no HTTPS server.
const SHC_PROTOCOL = config.shcProtocol === 'http' ? 'http' : 'https';
const SHC_PORT     = config.shcPort || (SHC_PROTOCOL === 'http' ? 80 : 8444);
const cert = SHC_PROTOCOL === 'https' ? fs.readFileSync(path.join(__dirname, config.certPath)) : null;
const key  = SHC_PROTOCOL === 'https' ? fs.readFileSync(path.join(__dirname, config.keyPath))  : null;

// =========================================================================
//  Authentication state (optional). When config.authEnabled is false, every
//  endpoint is open and the auth middleware is a no-op. When enabled, auth.json
//  holds users (with scrypt-hashed passwords) and persistent sessions.
// =========================================================================
const AUTH_ENABLED = !!config.authEnabled;
const COOKIE_NAME  = 'shc_session';
// 10 years — sessions are explicitly "valid indefinitely on the same device"
// per the spec; admins can revoke individual sessions on demand.
const COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;

let authData = { users: [], sessions: [] };
if (AUTH_ENABLED) {
  if (!fs.existsSync(AUTH_FILE)) {
    console.error('✖ authEnabled is true but auth.json is missing. Re-run `npm run setup`.');
    process.exit(1);
  }
  authData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  if (!Array.isArray(authData.users))    authData.users = [];
  if (!Array.isArray(authData.sessions)) authData.sessions = [];
}

function saveAuth() {
  if (!AUTH_ENABLED) return;
  fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, passwordHash: hash };
}

function verifyPassword(password, salt, expectedHash) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected  = Buffer.from(expectedHash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function readCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function findUser(username) {
  return authData.users.find(u => u.username === username);
}

function findSession(token) {
  return authData.sessions.find(s => s.token === token);
}

function publicUser(u) {
  if (!u) return null;
  return { username: u.username, role: u.role, mustChangePassword: !!u.mustChangePassword };
}

// Resolve req.user from cookie (no-op when AUTH_ENABLED is false). Called for
// every /api/... request by the middleware below.
function resolveUser(req) {
  if (!AUTH_ENABLED) return null;
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const session = findSession(token);
  if (!session) return null;
  const user = findUser(session.username);
  if (!user) return null;
  session.lastSeenAt = Date.now();
  return { token, session, user };
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const ctx = resolveUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  // Users with mustChangePassword may only reach the change-password / me /
  // logout endpoints (handled in their own routes below).
  req.authCtx = ctx;
  next();
}

function requireAdmin(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const ctx = req.authCtx || resolveUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  if (ctx.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  req.authCtx = ctx;
  next();
}

// Reusable transport agent — HTTPS+mTLS for the real SHC, plain HTTP for the
// test mock (Prism).
const transport = SHC_PROTOCOL === 'http' ? http : https;
// keep-alive on plain HTTP causes ECONNRESET races against Prism after a
// 4xx — Prism closes the socket but a pooled request gets queued onto the
// dead one. Production HTTPS path keeps the pool for performance.
const agent = SHC_PROTOCOL === 'http'
  ? new http.Agent({ keepAlive: false })
  : new https.Agent({
      cert,
      key,
      rejectUnauthorized: false, // SHC uses a self-signed certificate
      keepAlive: true,
    });

/** Helper: send a request to the SHC */
function shcRequest(method, urlPath, { body, port = SHC_PORT, timeoutMs = 35000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null
      ? (typeof body === 'string' ? body : JSON.stringify(body))
      : null;
    const req = transport.request(
      {
        host: config.shcIp,
        port,
        method,
        path: urlPath,
        agent,
        headers: {
          'Content-Type': 'application/json',
          'api-version': '3.2',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let parsed = chunks;
          try { parsed = JSON.parse(chunks); } catch (_) { /* not JSON */ }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(Object.assign(new Error(`SHC ${res.statusCode}`), {
              status: res.statusCode, body: parsed,
            }));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const app = express();
// strict:false so we can forward top-level scalar bodies (e.g. boolean for
// userdefinedstates/.../state) which the SHC accepts.
app.use(express.json({ strict: false }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) =>
    res.status(err.status || 502).json({ error: err.message, body: err.body })
  );

// =========================================================================
//  Auth endpoints (always mounted; behave correctly whether AUTH_ENABLED or not)
// =========================================================================

// Status: tells the UI whether auth is required, and if so who is logged in.
// Always 200 so the UI can read it before any login flow.
app.get('/api/auth/status', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ enabled: false, authenticated: true });
  const ctx = resolveUser(req);
  res.json({
    enabled: true,
    authenticated: !!ctx,
    user: publicUser(ctx?.user),
  });
});

// Login: creates a session, sets the HttpOnly cookie, returns the user info.
// When auth is disabled there's nothing to do — return ok so the UI never
// breaks if someone hits the endpoint by accident.
app.post('/api/auth/login', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true, authEnabled: false });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username/password required' });
  }
  const user = findUser(username);
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = newToken();
  const now = Date.now();
  const ua = (req.headers['user-agent'] || '').slice(0, 200);
  authData.sessions.push({
    token,
    username: user.username,
    createdAt: now,
    lastSeenAt: now,
    userAgent: ua,
    ip: req.ip || req.socket?.remoteAddress || '',
  });
  saveAuth();
  setSessionCookie(res, token);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true });
  const token = readCookie(req, COOKIE_NAME);
  if (token) {
    authData.sessions = authData.sessions.filter(s => s.token !== token);
    saveAuth();
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ enabled: false, authenticated: true });
  const ctx = resolveUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  res.json({ enabled: true, authenticated: true, user: publicUser(ctx.user) });
});

// Change own password. Allowed for any authenticated user (including those
// flagged mustChangePassword — that's the whole point of this route).
app.post('/api/auth/change-password', (req, res) => {
  if (!AUTH_ENABLED) return res.status(400).json({ error: 'auth disabled' });
  const ctx = resolveUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  const { oldPassword, newPassword } = req.body || {};
  if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'oldPassword/newPassword required' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: 'password too short' });
  }
  const user = ctx.user;
  if (!verifyPassword(oldPassword, user.salt, user.passwordHash)) {
    return res.status(401).json({ error: 'old password incorrect' });
  }
  const { salt, passwordHash } = hashPassword(newPassword);
  user.salt = salt;
  user.passwordHash = passwordHash;
  user.mustChangePassword = false;
  saveAuth();
  res.json({ ok: true });
});

// Block all /api/* when auth is enabled. The bootstrap auth routes
// (status, login, logout, me, change-password) above this middleware always
// run; everything else (including the admin /api/auth/users etc. routes
// declared below) goes through this gate. Users flagged with
// mustChangePassword are blocked from anything except change-password.
const ALWAYS_OPEN = new Set([
  '/auth/status', '/auth/login', '/auth/logout',
  '/auth/me',     '/auth/change-password',
]);
app.use('/api', (req, res, next) => {
  if (ALWAYS_OPEN.has(req.path)) return next();
  if (!AUTH_ENABLED) return next();
  const ctx = resolveUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  if (ctx.user.mustChangePassword) {
    return res.status(403).json({ error: 'password change required' });
  }
  req.authCtx = ctx;
  next();
});

// =========================================================================
//  Admin – user management (admin role only)
// =========================================================================
app.get('/api/auth/users', requireAdmin, (req, res) => {
  res.json(authData.users.map(publicUser));
});

app.post('/api/auth/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'username required' });
  }
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'password too short' });
  }
  if (findUser(username)) {
    return res.status(409).json({ error: 'user already exists' });
  }
  const { salt, passwordHash } = hashPassword(password);
  const user = {
    username: username.trim(),
    salt,
    passwordHash,
    role: role === 'admin' ? 'admin' : 'user',
    mustChangePassword: true, // forces the new user to change on first login
    createdAt: Date.now(),
  };
  authData.users.push(user);
  saveAuth();
  res.status(201).json(publicUser(user));
});

app.delete('/api/auth/users/:username', requireAdmin, (req, res) => {
  const username = req.params.username;
  const target = findUser(username);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.username === req.authCtx.user.username) {
    return res.status(400).json({ error: 'cannot delete yourself' });
  }
  authData.users   = authData.users.filter(u => u.username !== username);
  // Remove any active sessions for the deleted user
  authData.sessions = authData.sessions.filter(s => s.username !== username);
  saveAuth();
  res.json({ ok: true });
});

app.post('/api/auth/users/:username/reset-password', requireAdmin, (req, res) => {
  const username = req.params.username;
  const target = findUser(username);
  if (!target) return res.status(404).json({ error: 'user not found' });
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'password too short' });
  }
  const { salt, passwordHash } = hashPassword(password);
  target.salt = salt;
  target.passwordHash = passwordHash;
  target.mustChangePassword = true;
  // Reset invalidates all existing sessions for that user.
  authData.sessions = authData.sessions.filter(s => s.username !== username);
  saveAuth();
  res.json({ ok: true });
});

// =========================================================================
//  Admin – session management (admin role only)
// =========================================================================
app.get('/api/auth/sessions', requireAdmin, (req, res) => {
  const currentToken = req.authCtx.token;
  res.json(authData.sessions.map(s => ({
    token: s.token.slice(0, 8) + '…', // never expose full tokens, even to admins
    tokenId: s.token,                  // opaque id used only for delete calls
    username: s.username,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    userAgent: s.userAgent,
    ip: s.ip,
    current: s.token === currentToken,
  })));
});

app.delete('/api/auth/sessions/:tokenId', requireAdmin, (req, res) => {
  const tokenId = req.params.tokenId;
  const before = authData.sessions.length;
  authData.sessions = authData.sessions.filter(s => s.token !== tokenId);
  if (authData.sessions.length === before) {
    return res.status(404).json({ error: 'session not found' });
  }
  saveAuth();
  res.json({ ok: true });
});

// =========================================================================
//  Read endpoints (main data)
// =========================================================================
const GET_ENDPOINTS = {
  '/api/rooms':             '/smarthome/rooms',
  '/api/devices':           '/smarthome/devices',
  '/api/services':          '/smarthome/services',
  '/api/scenarios':         '/smarthome/scenarios',
  '/api/messages':          '/smarthome/messages',
  '/api/userdefinedstates': '/smarthome/userdefinedstates',
};

// /api/clients is admin-only — the list of paired Bosch app/client devices
// is only shown in the admin tab and lets the admin revoke clients.
app.get('/api/clients', requireAdmin, wrap(async (_req, res) => {
  res.json(await shcRequest('GET', '/smarthome/clients'));
}));

// SHC firmware differs in where automation rules live. Probe both known paths
// on first use and cache the working one (or null if neither answers).
let automationsBaseCache;
async function automationsBase() {
  if (automationsBaseCache !== undefined) return automationsBaseCache;
  for (const p of ['/smarthome/automation/rules', '/smarthome/automations']) {
    try {
      await shcRequest('GET', p);
      return (automationsBaseCache = p);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  return (automationsBaseCache = null);
}
for (const [route, shcPath] of Object.entries(GET_ENDPOINTS)) {
  app.get(route, wrap(async (_req, res) => {
    res.json(await shcRequest('GET', shcPath));
  }));
}

// /api/info enriches /smarthome/information with fields the SHC itself does
// not expose (IP from config.json, API version from the request header) and
// remaps the version fields into the schema the UI expects
// (softwareUpdateState.swInstalledVersion / .swUpdateState).
app.get('/api/info', wrap(async (_req, res) => {
  const raw = await shcRequest('GET', '/smarthome/information') || {};
  res.json({
    ...raw,
    shcIpAddress: config.shcIp,
    apiVersions: ['3.2'],
    softwareUpdateState: {
      swInstalledVersion:      raw.version,
      swUpdateState:           raw.updateState,
      swUpdateAvailableVersion: raw.swUpdateAvailableVersion || null,
    },
  });
}));

// =========================================================================
//  Device services
// =========================================================================
app.get('/api/devices/:id/services/:service', wrap(async (req, res) => {
  res.json(await shcRequest(
    'GET',
    `/smarthome/devices/${encodeURIComponent(req.params.id)}` +
    `/services/${encodeURIComponent(req.params.service)}`
  ));
}));

app.put('/api/devices/:id/services/:service/state', wrap(async (req, res) => {
  const result = await shcRequest(
    'PUT',
    `/smarthome/devices/${encodeURIComponent(req.params.id)}` +
    `/services/${encodeURIComponent(req.params.service)}/state`,
    { body: req.body }
  );
  res.json(result || { ok: true });
}));

// =========================================================================
//  Admin – devices
// =========================================================================
// Rename device / change properties (body e.g. { name: "New name" })
app.put('/api/devices/:id', requireAdmin, wrap(async (req, res) => {
  const result = await shcRequest(
    'PUT',
    `/smarthome/devices/${encodeURIComponent(req.params.id)}`,
    { body: req.body }
  );
  res.json(result || { ok: true });
}));

// Remove device
app.delete('/api/devices/:id', requireAdmin, wrap(async (req, res) => {
  await shcRequest('DELETE', `/smarthome/devices/${encodeURIComponent(req.params.id)}`);
  res.json({ ok: true });
}));

// =========================================================================
//  Admin – rooms (rename / change icon)
// =========================================================================
app.put('/api/rooms/:id', requireAdmin, wrap(async (req, res) => {
  const result = await shcRequest(
    'PUT',
    `/smarthome/rooms/${encodeURIComponent(req.params.id)}`,
    { body: req.body }
  );
  res.json(result || { ok: true });
}));

// =========================================================================
//  Admin – clients (registered apps / devices)
// =========================================================================
app.delete('/api/clients/:id', requireAdmin, wrap(async (req, res) => {
  await shcRequest('DELETE', `/smarthome/clients/${encodeURIComponent(req.params.id)}`);
  res.json({ ok: true });
}));

// =========================================================================
//  Scenarios & automations
// =========================================================================
app.post('/api/scenarios/:id/trigger', wrap(async (req, res) => {
  await shcRequest('POST',
    `/smarthome/scenarios/${encodeURIComponent(req.params.id)}/triggers`);
  res.json({ ok: true });
}));

app.get('/api/automations', wrap(async (_req, res) => {
  const base = await automationsBase();
  res.json(base ? await shcRequest('GET', base) : []);
}));

// Enable/disable or update an automation
app.put('/api/automations/:id', wrap(async (req, res) => {
  const base = await automationsBase();
  if (!base) return res.status(404).json({ error: 'automations endpoint not available' });
  const result = await shcRequest(
    'PUT',
    `${base}/${encodeURIComponent(req.params.id)}`,
    { body: req.body }
  );
  res.json(result || { ok: true });
}));

// Trigger-sub-path also varies by firmware. Probe the common candidates on
// first call and cache the one that works.
let automationsTriggerSub;
app.post('/api/automations/:id/trigger', wrap(async (req, res) => {
  const base = await automationsBase();
  if (!base) return res.status(404).json({ error: 'automations endpoint not available' });
  const id = encodeURIComponent(req.params.id);
  const candidates = automationsTriggerSub ? [automationsTriggerSub]
    : ['triggers', 'execute', 'trigger', 'run'];
  for (const sub of candidates) {
    try {
      await shcRequest('POST', `${base}/${id}/${sub}`);
      automationsTriggerSub = sub;
      return res.json({ ok: true });
    } catch (err) {
      if (err.status !== 404 && err.status !== 405) throw err;
    }
  }
  res.status(404).json({ error: 'no working trigger sub-path on this firmware' });
}));

// =========================================================================
//  User-defined states (e.g. "Present" toggle for automations)
// =========================================================================
app.put('/api/userdefinedstates/:id/state', wrap(async (req, res) => {
  const result = await shcRequest(
    'PUT',
    `/smarthome/userdefinedstates/${encodeURIComponent(req.params.id)}/state`,
    { body: req.body }
  );
  res.json(result || { ok: true });
}));

// =========================================================================
//  Intrusion detection (alarm system)
// =========================================================================
const IDS_PATH = '/smarthome/devices/intrusionDetectionSystem' +
                 '/services/IntrusionDetectionControl';

app.get('/api/intrusion', wrap(async (_req, res) => {
  res.json(await shcRequest('GET', IDS_PATH));
}));

// Body: { value, activeProfile? }
app.put('/api/intrusion/state', wrap(async (req, res) => {
  const result = await shcRequest(
    'PUT', `${IDS_PATH}/state`,
    { body: { '@type': 'intrusionDetectionControlState', ...req.body } }
  );
  res.json(result || { ok: true });
}));

// =========================================================================
//  Dismiss messages
// =========================================================================
app.delete('/api/messages/:id', wrap(async (req, res) => {
  await shcRequest('DELETE',
    `/smarthome/messages/${encodeURIComponent(req.params.id)}`);
  res.json({ ok: true });
}));

// =========================================================================
//  Live events via long polling -> Server-Sent Events
// =========================================================================
let subscriptionId = null;
const sseClients = new Set();

function broadcast(events) {
  const payload = `data: ${JSON.stringify(events)}\n\n`;
  for (const c of sseClients) c.write(payload);
}

async function jsonRpc(method, params) {
  return shcRequest('POST', '/remote/json-rpc', {
    body: { jsonrpc: '2.0', method, params },
    timeoutMs: 35000,
  });
}

async function ensureSubscription() {
  if (subscriptionId) return subscriptionId;
  const result = await jsonRpc('RE/subscribe', ['com/bosch/sh/remote/*', null]);
  subscriptionId = result.result;
  console.log('✔ SHC subscription:', subscriptionId);
  return subscriptionId;
}

async function pollLoop() {
  while (true) {
    try {
      const id = await ensureSubscription();
      const res = await jsonRpc('RE/longPoll', [id, 30]);
      if (Array.isArray(res.result) && res.result.length > 0) {
        broadcast(res.result);
      }
    } catch (err) {
      console.warn('Polling error, retrying in 3s:', err.message);
      subscriptionId = null;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// =========================================================================
//  Start
// =========================================================================
// When loaded by the test harness we want the express app but no listener and
// no long-polling loop (which would otherwise hold the process open and spam
// the mock with /remote/json-rpc subscribe calls). The harness sets
// BOSCH_SHC_NO_LISTEN=1; production startup is unaffected.
if (!process.env.BOSCH_SHC_NO_LISTEN) {
  const PORT = config.uiPort || 3000;
  app.listen(PORT, () => {
    console.log(`▶ Bosch SHC UI running on http://localhost:${PORT}`);
    console.log(`  SHC: ${config.shcIp}  (client: ${config.clientId})`);
    pollLoop().catch((e) => console.error('pollLoop crashed:', e));
  });
}

module.exports = { app, shcRequest };
