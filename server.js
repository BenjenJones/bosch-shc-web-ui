/**
 * Bosch SHC - local proxy + UI server
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
const setupLib = require('./setup.js');

// Config & auth paths can be overridden via env (used by the test harness so
// it doesn't have to touch the real config.json sitting next to the source).
const CONFIG_FILE = process.env.BOSCH_SHC_CONFIG_FILE || path.join(__dirname, 'config.json');
const AUTH_FILE   = process.env.BOSCH_SHC_AUTH_FILE   || path.join(__dirname, 'auth.json');
// Server-local archive of dismissed / no-longer-active messages. The SHC drops
// a message the moment it is resolved or dismissed, so we keep our own copy
// here to give the UI a browsable history. Plain JSON file — no SHC connection
// or auth state involved, so it loads at boot regardless of setup status.
const MESSAGE_ARCHIVE_FILE = process.env.BOSCH_SHC_MESSAGE_ARCHIVE_FILE || path.join(__dirname, 'messages-archive.ndjson');
const MESSAGE_ARCHIVE_MAX  = 500; // cap so a chatty SHC can't grow the file forever

// =========================================================================
//  Runtime state — populated by initRuntime() once config.json exists. The
//  values used to live in module-level `const`s and the server exited if
//  config was missing; now we boot in "setup-mode" instead (no SHC stack,
//  /api/setup/* is the only working endpoint) so the user can pair via the
//  web wizard.
// =========================================================================
let config       = null;
let SHC_PROTOCOL = 'https';
let SHC_PORT     = 8444;
let cert         = null;
let key          = null;
let transport    = https;
let agent        = null;
let AUTH_ENABLED = false;
let authData     = { users: [], sessions: [] };

const COOKIE_NAME = 'shc_session';
// 10 years — sessions are explicitly "valid indefinitely on the same device"
// per the spec; admins can revoke individual sessions on demand.
const COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;

function isReady() { return config !== null; }

function initRuntime() {
  if (!fs.existsSync(CONFIG_FILE)) return false;
  config       = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  // shcProtocol defaults to 'https' (real SHC requires mTLS). The test
  // harness sets it to 'http' so it can point at Prism, which has no HTTPS
  // server.
  SHC_PROTOCOL = config.shcProtocol === 'http' ? 'http' : 'https';
  SHC_PORT     = config.shcPort || (SHC_PROTOCOL === 'http' ? 80 : 8444);
  cert = SHC_PROTOCOL === 'https' ? fs.readFileSync(path.join(__dirname, config.certPath)) : null;
  key  = SHC_PROTOCOL === 'https' ? fs.readFileSync(path.join(__dirname, config.keyPath))  : null;
  transport = SHC_PROTOCOL === 'http' ? http : https;
  // keep-alive on plain HTTP causes ECONNRESET races against Prism after a
  // 4xx — Prism closes the socket but a pooled request gets queued onto the
  // dead one. Production HTTPS path keeps the pool for performance.
  agent = SHC_PROTOCOL === 'http'
    ? new http.Agent({ keepAlive: false })
    : new https.Agent({ cert, key, rejectUnauthorized: false, keepAlive: true });
  AUTH_ENABLED = !!config.authEnabled;
  if (AUTH_ENABLED) {
    if (!fs.existsSync(AUTH_FILE)) {
      throw new Error('authEnabled is true but auth.json is missing — re-run setup or disable auth in config.json.');
    }
    authData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (!Array.isArray(authData.users))    authData.users = [];
    if (!Array.isArray(authData.sessions)) authData.sessions = [];
  } else {
    authData = { users: [], sessions: [] };
  }
  return true;
}

function saveAuth() {
  if (!AUTH_ENABLED) return;
  fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
}

// =========================================================================
//  Message archive (server-local JSON store)
// =========================================================================
let messageArchive = [];

function loadMessageArchive() {
  try {
    if (!fs.existsSync(MESSAGE_ARCHIVE_FILE)) return;
    // NDJSON: one object per line. Skip a corrupt line rather than losing the
    // entire archive over it.
    messageArchive = fs.readFileSync(MESSAGE_ARCHIVE_FILE, 'utf8')
      .split('\n').map(l => l.trim()).filter(Boolean)
      .reduce((acc, l) => {
        try { acc.push(JSON.parse(l)); } catch { /* skip corrupt line */ }
        return acc;
      }, []);
  } catch (err) {
    console.warn('Could not read message archive:', err.message);
  }
}

function saveMessageArchive() {
  try {
    // NDJSON — one compact JSON object per line. Much smaller than a
    // pretty-printed file, append-friendly, and still line-readable. The
    // frontend re-formats each message for its technical-details view anyway.
    const body = messageArchive.map(m => JSON.stringify(m)).join('\n');
    fs.writeFileSync(MESSAGE_ARCHIVE_FILE, body ? body + '\n' : '');
  } catch (err) {
    console.warn('Could not write message archive:', err.message);
  }
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

/** Helper: send a request to the SHC. The transport/agent it picks come from
 *  the module-level `let`s set by initRuntime(); calling this before runtime
 *  is ready will throw on agent being null. The setup-mode middleware
 *  short-circuits everything except /api/setup/* and /api/auth/status before
 *  it can get here, so in practice that only happens if you call shcRequest
 *  directly. */
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

// =========================================================================
//  Content Security Policy
//  Everything the UI needs is served from this same origin — no CDN, no
//  inline scripts, no eval. The theme bootstrap that used to be inline in
//  index.html now lives in public/init.js so we can run without
//  `'unsafe-inline'`. `data:` is kept on img-src for SVG masks loaded via
//  CSS `mask-image: url(...)` which some browsers route through img-src.
// =========================================================================
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    // style-src needs 'unsafe-inline' because the UI uses `style="..."`
    // attributes with dynamic values (per-icon mask-image URLs, sizing).
    // Inline styles can't execute JS, so this doesn't open the XSS attack
    // surface that script-src 'unsafe-inline' would.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '));
  next();
});

// strict:false so we can forward top-level scalar bodies (e.g. boolean for
// userdefinedstates/.../state) which the SHC accepts.
app.use(express.json({ strict: false }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) =>
    res.status(err.status || 502).json({ error: err.message, body: err.body })
  );

// =========================================================================
//  Setup-mode gate
//  When config.json is missing the server has no SHC connection and no auth
//  state to enforce. The only thing it can usefully serve is the wizard's
//  index.html (handled by static middleware above) and the /api/setup/*
//  endpoints. Everything else returns 503 so the UI can render a clear
//  "setup required" message instead of getting silent 404s/500s.
// =========================================================================
app.use('/api', (req, res, next) => {
  if (isReady()) return next();
  if (req.path === '/setup' || req.path === '/setup/status') return next();
  if (req.path === '/auth/status')                            return next();
  res.status(503).json({ error: 'setup required', setupRequired: true });
});

// =========================================================================
//  Setup endpoints — drive the in-browser pairing wizard. Mirror what
//  setup.js does on the CLI: generate certs, register with the SHC,
//  optionally configure auth. After each step we initRuntime() so the
//  server flips from setup-mode to normal mode without a manual restart.
// =========================================================================
app.get('/api/setup/status', (_req, res) => {
  res.json({
    needed: !isReady(),
    hasCerts: fs.existsSync(setupLib.CERT_FILE) && fs.existsSync(setupLib.KEY_FILE),
  });
});

// Body: { shcIp, password, authEnabled, adminUsername?, adminPassword? }.
// Single one-shot endpoint — does cert + SHC pairing + config + auth.json
// atomically. Strictly gated on !isReady() so that once setup has run once,
// no further calls succeed. Re-pairing (and admin-password rotation) goes
// through the CLI `npm run setup`.
//
// The wizard puts the time-sensitive bit (SHC pairing mode requires the
// physical button press) at the end of the form so the user can press the
// button right before submitting; auth choices are made earlier and
// preserved in JS state if registration needs a retry.
app.post('/api/setup', wrap(async (req, res) => {
  if (isReady()) return res.status(409).json({ error: 'already configured — re-run `npm run setup` from the CLI to change anything' });

  const shcIp         = (req.body?.shcIp || '').trim();
  const password      = req.body?.password;
  const authEnabled   = !!req.body?.authEnabled;
  const adminUsername = (req.body?.adminUsername || '').trim();
  const adminPassword = req.body?.adminPassword;

  if (!shcIp)                                    return res.status(400).json({ error: 'shcIp required' });
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'password required' });
  if (authEnabled) {
    if (!adminUsername)                                                 return res.status(400).json({ error: 'adminUsername required when authEnabled' });
    if (typeof adminPassword !== 'string' || adminPassword.length < 4)  return res.status(400).json({ error: 'adminPassword must be at least 4 chars' });
  }

  // Cert generation first — if openssl isn't around we want to fail before
  // touching the SHC (it would only timeout otherwise).
  try {
    setupLib.ensureCerts();
  } catch (err) {
    return res.status(500).json({
      error: 'cert generation failed — is openssl on PATH?',
      detail: err.message,
    });
  }
  const certPem = fs.readFileSync(setupLib.CERT_FILE, 'utf8');

  // SHC registration — fails fast on wrong password or no pairing mode.
  // 401 from the SHC = wrong system password; 400 typically = not in pairing
  // mode. Pass the upstream status through so the wizard can surface a
  // useful message instead of a generic 5xx.
  try {
    await setupLib.registerClient(shcIp, password, certPem);
  } catch (err) {
    return res.status(err.status || 502).json({
      error: 'SHC registration failed',
      status: err.status, detail: err.body || err.message,
    });
  }

  // From here on disk-only — write auth.json first (if requested), then the
  // config that references it, so a partial write can't leave us in a state
  // where authEnabled=true points at a missing auth.json.
  if (authEnabled) {
    setupLib.writeAuth({ adminUsername, adminPassword });
  } else {
    setupLib.removeAuthFile();
  }
  setupLib.writeConfig({ shcIp, authEnabled });

  initRuntime();
  kickPollLoop();
  res.json({ ok: true });
}));

// =========================================================================
//  Auth endpoints (always mounted; behave correctly whether AUTH_ENABLED or not)
// =========================================================================

// Status: tells the UI whether auth is required, and if so who is logged in.
// Always 200 so the UI can read it before any login flow.
app.get('/api/auth/status', (req, res) => {
  if (!isReady())   return res.json({ enabled: false, authenticated: false, setupRequired: true });
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
//  First-run web setup wizard. Endpoints are reachable only while the
//  server is in setup-mode (config.json missing); once the wizard finishes
//  isReady() flips true and the setup-mode gate above stops routing them.
//  We deliberately don't gate them with `requireAuth` — there's no admin
//  to authenticate yet, and the SHC's own pairing-mode (front-button press)
//  is the physical proof-of-presence here.
// =========================================================================
app.get('/api/setup/status', (_req, res) => {
  res.json({
    needed:   !isReady(),
    hasCerts: fs.existsSync(setupLib.CERT_FILE) && fs.existsSync(setupLib.KEY_FILE),
  });
});

// Step 1 of the wizard: generate the client cert (if not already present),
// register with the SHC over its pairing port (8443), and persist a minimal
// config.json. After this, isReady() flips true and the rest of /api/*
// becomes reachable. Auth is still off — that's the optional step 2.
app.post('/api/setup/register', wrap(async (req, res) => {
  if (isReady()) {
    return res.status(409).json({ error: 'already configured — remove config.json to re-pair' });
  }
  const shcIp    = (req.body?.shcIp || '').trim();
  const password = req.body?.password;
  if (!shcIp)                                    return res.status(400).json({ error: 'shcIp required' });
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'password required' });

  try {
    setupLib.ensureCerts();
  } catch (err) {
    return res.status(500).json({
      error: 'certificate generation failed — is openssl installed and on PATH?',
      detail: err.message,
    });
  }
  const certPem = fs.readFileSync(setupLib.CERT_FILE, 'utf8');
  try {
    await setupLib.registerClient(shcIp, password, certPem);
  } catch (err) {
    return res.status(err.status || 502).json({
      error: 'SHC registration failed — wrong password, or SHC not in pairing mode?',
      detail: err.message,
    });
  }
  // Reset any stale auth.json from a previous pairing and write a minimal
  // config (auth disabled). The user can opt into auth via step 2.
  setupLib.removeAuthFile();
  setupLib.writeConfig({ shcIp, authEnabled: false });
  initRuntime();
  kickPollLoop();
  res.json({ ok: true });
}));

// Step 2 (optional): enable login auth. Allowed only between the register
// step and the first non-setup request — once auth is on or the user closes
// the wizard, admin rotation goes through the CLI (`npm run setup`) again.
app.post('/api/setup/complete', wrap(async (req, res) => {
  if (!isReady()) {
    return res.status(409).json({ error: 'not registered yet — call /api/setup/register first' });
  }
  if (AUTH_ENABLED) {
    return res.status(409).json({ error: 'auth already configured' });
  }
  const enabled = !!req.body?.authEnabled;
  if (enabled) {
    const username = (req.body?.adminUsername || '').trim();
    const password = req.body?.adminPassword;
    if (!username)                                    return res.status(400).json({ error: 'adminUsername required' });
    if (typeof password !== 'string' || password.length < 4)
                                                      return res.status(400).json({ error: 'adminPassword must be at least 4 chars' });
    setupLib.writeAuth({ adminUsername: username, adminPassword: password });
  } else {
    setupLib.removeAuthFile();
  }
  setupLib.writeConfig({ shcIp: config.shcIp, authEnabled: enabled });
  initRuntime();
  res.json({ ok: true });
}));

// =========================================================================
//  Admin - user management (admin role only)
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
//  Admin - session management (admin role only)
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

// /api/info pulls from the *undocumented* /smarthome/information rather than
// the documented /public/information (port 8446). The "public" endpoint is
// only the pre-pairing discovery shim — it returns apiVersions and
// shcGeneration but no firmware version or softwareUpdateState. The
// /smarthome variant is what the Bosch app uses post-pairing and is the
// only practical source for the fields the UI shows.
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
//  Admin - devices
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
//  Admin - rooms (create / rename / change icon)
// =========================================================================
// Creating rooms is not part of the documented SHC API (only GET is), but the
// controller accepts a POST to /smarthome/rooms the same way it accepts the
// undocumented rename PUT below.
app.post('/api/rooms', requireAdmin, wrap(async (req, res) => {
  const result = await shcRequest('POST', '/smarthome/rooms', { body: req.body });
  res.json(result || { ok: true });
}));

app.put('/api/rooms/:id', requireAdmin, wrap(async (req, res) => {
  const result = await shcRequest(
    'PUT',
    `/smarthome/rooms/${encodeURIComponent(req.params.id)}`,
    { body: req.body }
  );
  res.json(result || { ok: true });
}));

app.delete('/api/rooms/:id', requireAdmin, wrap(async (req, res) => {
  await shcRequest('DELETE', `/smarthome/rooms/${encodeURIComponent(req.params.id)}`);
  res.json({ ok: true });
}));

// =========================================================================
//  Admin - clients (registered apps / devices)
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

// Create / update / delete scenarios. Undocumented (the spec lists only GET +
// the trigger POST), but the controller accepts CRUD on /smarthome/scenarios
// like it does for rooms and automations.
app.post('/api/scenarios', requireAdmin, wrap(async (req, res) => {
  const result = await shcRequest('POST', '/smarthome/scenarios', { body: req.body });
  res.json(result || { ok: true });
}));

app.put('/api/scenarios/:id', requireAdmin, wrap(async (req, res) => {
  const result = await shcRequest('PUT',
    `/smarthome/scenarios/${encodeURIComponent(req.params.id)}`, { body: req.body });
  res.json(result || { ok: true });
}));

app.delete('/api/scenarios/:id', requireAdmin, wrap(async (req, res) => {
  await shcRequest('DELETE', `/smarthome/scenarios/${encodeURIComponent(req.params.id)}`);
  res.json({ ok: true });
}));

app.get('/api/automations', wrap(async (_req, res) => {
  const base = await automationsBase();
  res.json(base ? await shcRequest('GET', base) : []);
}));

// Create an automation. Undocumented (the spec lists only GET + PUT), but the
// SHC accepts a POST to /automation/rules with the same body shape it returns
// on GET — minus the `id`, which the controller assigns.
app.post('/api/automations', requireAdmin, wrap(async (req, res) => {
  const base = await automationsBase();
  if (!base) return res.status(404).json({ error: 'automations endpoint not available' });
  const result = await shcRequest('POST', base, { body: req.body });
  res.json(result || { ok: true });
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

// Delete an automation. Undocumented (the spec only lists GET + PUT), but the
// SHC accepts a DELETE on the same /automation/rules/{id} path.
app.delete('/api/automations/:id', requireAdmin, wrap(async (req, res) => {
  const base = await automationsBase();
  if (!base) return res.status(404).json({ error: 'automations endpoint not available' });
  await shcRequest('DELETE', `${base}/${encodeURIComponent(req.params.id)}`);
  res.json({ ok: true });
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

// Create / delete user-defined states. Undocumented (the spec lists GET + the
// state PUT only), but the controller accepts CRUD like for rooms/scenarios.
app.post('/api/userdefinedstates', requireAdmin, wrap(async (req, res) => {
  const result = await shcRequest('POST', '/smarthome/userdefinedstates', { body: req.body });
  res.json(result || { ok: true });
}));

app.delete('/api/userdefinedstates/:id', requireAdmin, wrap(async (req, res) => {
  await shcRequest('DELETE', `/smarthome/userdefinedstates/${encodeURIComponent(req.params.id)}`);
  res.json({ ok: true });
}));

// =========================================================================
//  Intrusion detection (alarm system) — official endpoints under
//  /smarthome/intrusion/{states,actions}. The UI was originally written
//  against the older device-service-style response, so we reshape the
//  SystemStateData payload back into { state: { value, activeConfiguration-
//  Profile, remainingTimeUntilArmed } } here.
// =========================================================================
const IDS_STATE_PATH   = '/smarthome/intrusion/states/system';
const IDS_ACTION_PATHS = {
  SYSTEM_ARMING:   '/smarthome/intrusion/actions/arm',
  SYSTEM_ARMED:    '/smarthome/intrusion/actions/arm',
  SYSTEM_DISARMED: '/smarthome/intrusion/actions/disarm',
  MUTE_ALARM:      '/smarthome/intrusion/actions/mute',
};

function adaptIntrusionState(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const arming = raw.armingState?.state || 'SYSTEM_DISARMED';
  const alarm  = raw.alarmState?.value;
  // Old contract collapsed "armed" + "alarming/muted" into one `value`. The
  // UI checks for SYSTEM_ALARM and MUTE_ALARM explicitly, so promote those.
  const value =
    alarm === 'ALARM_ON'    ? 'SYSTEM_ALARM' :
    alarm === 'ALARM_MUTED' ? 'MUTE_ALARM'   :
    arming;
  return {
    '@type': 'DeviceServiceData',
    id: 'IntrusionDetectionControl',
    deviceId: 'intrusionDetectionSystem',
    state: {
      '@type': 'intrusionDetectionControlState',
      value,
      activeConfigurationProfile: raw.activeConfigurationProfile?.profileId ?? '0',
      remainingTimeUntilArmed: raw.armingState?.remainingTimeUntilArmed ?? null,
    },
    raw, // preserve the upstream payload for clients that want richer fields
  };
}

app.get('/api/intrusion', wrap(async (_req, res) => {
  const raw = await shcRequest('GET', IDS_STATE_PATH);
  res.json(adaptIntrusionState(raw));
}));

// Body: { value, activeProfile? }. Maps to a POST /intrusion/actions/{arm,
// disarm,mute}; the arm action carries the profile as a typed JSON body.
app.put('/api/intrusion/state', wrap(async (req, res) => {
  const value  = req.body?.value;
  const target = IDS_ACTION_PATHS[value];
  if (!target) {
    return res.status(400).json({ error: `unsupported intrusion value: ${value}` });
  }
  const body = target.endsWith('/arm')
    ? { '@type': 'armRequest', profileId: String(req.body?.activeProfile ?? '0') }
    : undefined;
  await shcRequest('POST', target, body ? { body } : {});
  res.json({ ok: true });
}));

// =========================================================================
//  Message archive — history of no-longer-active messages, stored locally.
//  Declared BEFORE the `/api/messages/:id` dismiss route below so the exact
//  `/archive` paths match first instead of being captured as `:id=archive`.
// =========================================================================
app.get('/api/messages/archive', (_req, res) => {
  res.json(messageArchive);
});

// The UI posts the full message object when it dismisses an active message, or
// when the SHC marks one deleted via the live stream. Deduped by id: a repeat
// post moves the entry to the front and refreshes archivedAt.
app.post('/api/messages/archive', (req, res) => {
  const msg = req.body;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !msg.id) {
    return res.status(400).json({ error: 'message object with an id required' });
  }
  const existing = messageArchive.find(m => m.id === msg.id);
  // The SHC's deletion event is a bare stub (id + `deleted: true`, no
  // messageCode). If a richer copy is already archived, don't let the stub
  // overwrite it — keep the original content, just refresh archivedAt.
  const incomingIsStub = !msg.messageCode;
  const entry = (existing && incomingIsStub && existing.messageCode)
    ? { ...existing, archivedAt: msg.archivedAt || Date.now() }
    : { ...msg, archivedAt: msg.archivedAt || Date.now() };
  messageArchive = messageArchive.filter(m => m.id !== entry.id);
  messageArchive.unshift(entry);
  if (messageArchive.length > MESSAGE_ARCHIVE_MAX) messageArchive.length = MESSAGE_ARCHIVE_MAX;
  saveMessageArchive();
  res.status(201).json(entry);
});

// Clear the whole archive. Exact path, so it must precede the `:id` variant.
app.delete('/api/messages/archive', (_req, res) => {
  messageArchive = [];
  saveMessageArchive();
  res.json({ ok: true });
});

app.delete('/api/messages/archive/:id', (req, res) => {
  const before = messageArchive.length;
  messageArchive = messageArchive.filter(m => m.id !== req.params.id);
  if (messageArchive.length === before) return res.status(404).json({ error: 'not in archive' });
  saveMessageArchive();
  res.json({ ok: true });
});

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

// Start the long-polling loop exactly once per process. Called both at boot
// (when config existed already) and at the end of /api/setup/register (so
// pairing-via-web users don't need a server restart to get live events).
let pollStarted = false;
function kickPollLoop() {
  if (pollStarted || !isReady()) return;
  // The test harness talks to Prism over plain HTTP; pollLoop would spam
  // /remote/json-rpc subscribe forever in that mode, so skip it there.
  if (SHC_PROTOCOL !== 'https') return;
  pollStarted = true;
  pollLoop().catch((e) => { console.error('pollLoop crashed:', e); pollStarted = false; });
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
// Populate runtime from disk if config.json exists. Missing config is not
// fatal — the server boots in setup-mode and lets the user pair via the
// wizard at /api/setup/*.
try { initRuntime(); }
catch (err) { console.error('✖ initRuntime:', err.message); process.exit(1); }

// Archive is independent of SHC config — load it unconditionally so the
// history survives restarts in both setup-mode and normal mode.
loadMessageArchive();

// When loaded by the test harness we want the express app but no listener
// and no long-polling loop. The harness sets BOSCH_SHC_NO_LISTEN=1.
if (!process.env.BOSCH_SHC_NO_LISTEN) {
  // Default to 3000 for setup-mode boots where there's no config yet.
  const PORT = (isReady() && config.uiPort) || 3000;

  // Optional native TLS for the UI itself (separate from the SHC client cert).
  // Set config.uiTls = { certPath, keyPath } to serve HTTPS directly; otherwise
  // fall back to plain HTTP as before. A reverse proxy (Caddy/Apache)
  // terminating TLS remains a valid alternative. Paths may be relative (to this
  // dir) or absolute — path.resolve keeps an absolute path as-is on both
  // Windows (C:\...) and Linux (/...).
  const uiTls = isReady() && config.uiTls;
  const server = (uiTls && uiTls.certPath && uiTls.keyPath)
    ? https.createServer({
        cert: fs.readFileSync(path.resolve(__dirname, uiTls.certPath)),
        key:  fs.readFileSync(path.resolve(__dirname, uiTls.keyPath)),
      }, app)
    : app;
  const scheme = server === app ? 'http' : 'https';

  server.listen(PORT, () => {
    if (isReady()) {
      console.log(`▶ Bosch SHC UI running on ${scheme}://localhost:${PORT}`);
      console.log(`  SHC: ${config.shcIp}  (client: ${config.clientId})`);
    } else {
      console.log(`▶ Bosch SHC UI running on ${scheme}://localhost:${PORT}  (SETUP MODE — visit it to pair)`);
    }
    kickPollLoop();
  });
}

module.exports = {
  app, shcRequest,
  // Internals exposed for unit tests — pure functions, no live state.
  _internals: { hashPassword, verifyPassword, readCookie, adaptIntrusionState, publicUser, newToken },
};
