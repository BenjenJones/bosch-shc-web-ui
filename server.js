/**
 * Bosch SHC – local proxy + UI server
 *  - Holds the client certificate (mTLS) for the SHC connection
 *  - Exposes a small REST API for the browser UI
 *  - Streams live events (long polling -> Server-Sent Events) to the UI
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');

const CONFIG_FILE = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_FILE)) {
  console.error('✖ config.json missing. Please run `npm run setup` first.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const cert = fs.readFileSync(path.join(__dirname, config.certPath));
const key = fs.readFileSync(path.join(__dirname, config.keyPath));

// Reusable HTTPS agent with mTLS
const agent = new https.Agent({
  cert,
  key,
  rejectUnauthorized: false, // SHC uses a self-signed certificate
  keepAlive: true,
});

/** Helper: send a request to the SHC */
function shcRequest(method, urlPath, { body, port = 8444, timeoutMs = 35000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null
      ? (typeof body === 'string' ? body : JSON.stringify(body))
      : null;
    const req = https.request(
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
//  Read endpoints (main data)
// =========================================================================
const GET_ENDPOINTS = {
  '/api/rooms':             '/smarthome/rooms',
  '/api/devices':           '/smarthome/devices',
  '/api/services':          '/smarthome/services',
  '/api/scenarios':         '/smarthome/scenarios',
  '/api/messages':          '/smarthome/messages',
  '/api/clients':           '/smarthome/clients',
  '/api/userdefinedstates': '/smarthome/userdefinedstates',
};

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
app.put('/api/devices/:id', wrap(async (req, res) => {
  const result = await shcRequest(
    'PUT',
    `/smarthome/devices/${encodeURIComponent(req.params.id)}`,
    { body: req.body }
  );
  res.json(result || { ok: true });
}));

// Remove device
app.delete('/api/devices/:id', wrap(async (req, res) => {
  await shcRequest('DELETE', `/smarthome/devices/${encodeURIComponent(req.params.id)}`);
  res.json({ ok: true });
}));

// =========================================================================
//  Admin – rooms (rename / change icon)
// =========================================================================
app.put('/api/rooms/:id', wrap(async (req, res) => {
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
app.delete('/api/clients/:id', wrap(async (req, res) => {
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
const PORT = config.uiPort || 3000;
app.listen(PORT, () => {
  console.log(`▶ Bosch SHC UI running on http://localhost:${PORT}`);
  console.log(`  SHC: ${config.shcIp}  (client: ${config.clientId})`);
  pollLoop().catch((e) => console.error('pollLoop crashed:', e));
});
