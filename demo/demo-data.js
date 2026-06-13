/**
 * Demo-Datenmodell + Router — der in-memory "Inhalt" des Demo-SHC.
 *
 * Hält den kompletten Datenbestand im Speicher und beantwortet via `handle()`
 * exakt die `/smarthome/...`-Pfade der echten Box. Der eigentliche HTTP-Server,
 * der das nach außen über dieselbe Schnittstelle wie die echte SHC ausliefert,
 * ist demo/shc-server.js; server.js verbindet sich dann ganz normal
 * (`shcProtocol:'http'`) damit — kein Demo-Sonderweg im UI-Server.
 *
 * Die Geräte/Services/Szenen/Automationen kommen aus dem *eingecheckten*,
 * anonymisierten Datensatz unter demo/dataset/ (je ein Beispiel pro Typ). Den
 * erzeugt demo/build-dataset.js aus den lokalen, echten examples/*-Exporten
 * (die selbst nicht eingecheckt werden). Mutationen (schalten, umbenennen,
 * löschen, Alarm scharf) leben im Speicher; ein Neustart setzt zurück.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, 'dataset');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));

// Meldungen liegen im Datensatz ohne timestamp/archivedAt — hier beim Laden
// gestempelt, damit die Daten unabhängig vom Build-Datum "frisch" wirken
// (jüngste zuerst). Das Archiv wird von server.js (loadMessageArchive) im
// Demo-Modus aus store.messageArchive übernommen statt aus der NDJSON-Datei.
const HOUR = 3600e3, DAY = 24 * HOUR;
const now = Date.now();
const activeMessages = readJson('messages.json').map((m, i) => ({ ...m, timestamp: now - (i + 1) * 6 * HOUR }));
const archivedMessages = readJson('messages-archive.json').map((m, i) => ({
  ...m, timestamp: now - (i + 3) * DAY, archivedAt: now - (i + 1) * 18 * HOUR,
}));

// =========================================================================
//  In-memory store — frisch bei jedem Boot aus dem Datensatz geladen, damit
//  Mutationen die JSON-Dateien auf der Platte nicht anfassen.
// =========================================================================
const store = {
  rooms: readJson('rooms.json'),
  devices: readJson('devices.json'),
  services: readJson('services.json'),
  scenarios: readJson('scenarios.json'),
  automations: readJson('automations.json'),
  userdefinedstates: readJson('userdefinedstates.json'),
  messages: activeMessages,
  messageArchive: archivedMessages,
  clients: [
    { '@type': 'client', id: 'oss_bosch_shc_web_ui', name: 'Bosch SHC Web UI (Demo)', primaryRole: 'ROLE_RESTRICTED_CLIENT', dynamicRoles: [] },
  ],
  info: {
    '@type': 'information',
    version: '10.21.2200',
    updateState: 'NO_UPDATE_AVAILABLE',
    swUpdateAvailableVersion: null,
    shcGeneration: 'SHC_2',
    apiVersions: ['3.2'],
  },
  intrusion: {
    '@type': 'systemState',
    systemAvailability: { '@type': 'systemAvailabilityState', available: true },
    armingState: { '@type': 'armingState', state: 'SYSTEM_DISARMED', remainingTimeUntilArmed: null },
    alarmState: { '@type': 'alarmState', value: 'ALARM_OFF', incidents: [] },
    activeConfigurationProfile: { '@type': 'activeConfigurationProfile', profileId: '0' },
  },
};

const notFound = (msg = 'not found') => { throw Object.assign(new Error(msg), { status: 404 }); };
const findDevice = (id) => store.devices.find(d => d.id === id);

// =========================================================================
//  Router — entspricht den `/smarthome/...`-Pfaden aus server.js. Segmente
//  werden dekodiert, weil shcRequest() Geräte-IDs (mit ':' und '#')
//  URL-kodiert übergibt.
// =========================================================================
async function handle(method, urlPath, body) {
  const p = urlPath.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  if (p[0] !== 'smarthome') return notFound();
  const seg = p.slice(1);
  const m = method.toUpperCase();
  const at = (i, v) => seg[i] === v;
  const is = (...v) => seg.length === v.length && v.every((x, i) => seg[i] === x);

  // ---- rooms -----------------------------------------------------------
  if (is('rooms')) {
    if (m === 'GET') return store.rooms;
    if (m === 'POST') { const room = { '@type': 'room', id: 'hz_' + crypto.randomUUID().slice(0, 8), ...body }; store.rooms.push(room); return room; }
  }
  if (at(0, 'rooms') && seg.length === 2) {
    const i = store.rooms.findIndex(r => r.id === seg[1]);
    if (m === 'PUT')    { if (i < 0) return notFound(); store.rooms[i] = { ...store.rooms[i], ...body }; return store.rooms[i]; }
    if (m === 'DELETE') { if (i < 0) return notFound(); store.rooms.splice(i, 1); return {}; }
  }

  // ---- devices + services ---------------------------------------------
  if (is('devices'))  return store.devices;
  if (is('services')) return store.services;
  if (at(0, 'devices') && seg.length === 2) {
    const dev = findDevice(seg[1]);
    if (m === 'PUT')    { if (!dev) return notFound(); Object.assign(dev, body); return dev; }
    if (m === 'DELETE') {
      if (!dev) return notFound();
      store.devices = store.devices.filter(d => d.id !== seg[1]);
      store.services = store.services.filter(s => s.deviceId !== seg[1]);
      return {};
    }
  }
  if (at(0, 'devices') && at(2, 'services')) {
    const svc = store.services.find(s => s.deviceId === seg[1] && s.id === seg[3]);
    if (seg.length === 4 && m === 'GET') return svc || notFound();
    if (seg.length === 5 && seg[4] === 'state' && m === 'PUT') {
      if (!svc) return notFound();
      svc.state = typeof body === 'object' && body !== null ? { ...svc.state, ...body } : body;
      return svc.state;
    }
  }

  // ---- scenarios -------------------------------------------------------
  if (is('scenarios')) {
    if (m === 'GET') return store.scenarios;
    if (m === 'POST') { const s = { '@type': 'scenario', id: crypto.randomUUID(), ...body }; store.scenarios.push(s); return s; }
  }
  if (at(0, 'scenarios') && seg.length === 2) {
    const i = store.scenarios.findIndex(s => s.id === seg[1]);
    if (m === 'PUT')    { if (i < 0) return notFound(); store.scenarios[i] = { ...store.scenarios[i], ...body, id: seg[1] }; return store.scenarios[i]; }
    if (m === 'DELETE') { if (i < 0) return notFound(); store.scenarios.splice(i, 1); return {}; }
  }
  if (at(0, 'scenarios') && at(2, 'triggers') && m === 'POST') return {}; // trigger = no-op

  // ---- messages --------------------------------------------------------
  if (is('messages') && m === 'GET') return store.messages;
  if (at(0, 'messages') && seg.length === 2 && m === 'DELETE') {
    store.messages = store.messages.filter(x => x.id !== seg[1]);
    return {};
  }

  // ---- user-defined states --------------------------------------------
  if (is('userdefinedstates')) {
    if (m === 'GET') return store.userdefinedstates;
    if (m === 'POST') { const u = { '@type': 'userDefinedState', id: crypto.randomUUID(), state: false, ...body }; store.userdefinedstates.push(u); return u; }
  }
  if (at(0, 'userdefinedstates') && seg.length === 3 && seg[2] === 'state' && m === 'PUT') {
    const u = store.userdefinedstates.find(x => x.id === seg[1]);
    if (!u) return notFound();
    u.state = typeof body === 'boolean' ? body : (body?.state ?? u.state);
    return {};
  }
  if (at(0, 'userdefinedstates') && seg.length === 2 && m === 'DELETE') {
    store.userdefinedstates = store.userdefinedstates.filter(x => x.id !== seg[1]);
    return {};
  }

  // ---- automations (/automation/rules) --------------------------------
  if (is('automation', 'rules')) {
    if (m === 'GET') return store.automations;
    if (m === 'POST') { const a = { '@type': 'automationRule', id: crypto.randomUUID(), enabled: true, ...body }; store.automations.push(a); return a; }
  }
  if (at(0, 'automation') && at(1, 'rules') && seg.length === 3) {
    const i = store.automations.findIndex(a => a.id === seg[2]);
    if (m === 'PUT')    { if (i < 0) return notFound(); store.automations[i] = { ...store.automations[i], ...body, id: seg[2] }; return store.automations[i]; }
    if (m === 'DELETE') { if (i < 0) return notFound(); store.automations.splice(i, 1); return {}; }
  }
  if (at(0, 'automation') && at(1, 'rules') && seg.length === 4 && seg[3] === 'triggers' && m === 'POST') return {};

  // ---- system info / clients ------------------------------------------
  if (is('information') && m === 'GET') return store.info;
  if (is('clients') && m === 'GET') return store.clients;
  if (at(0, 'clients') && seg.length === 2 && m === 'DELETE') {
    store.clients = store.clients.filter(c => c.id !== seg[1]);
    return {};
  }

  // ---- intrusion detection --------------------------------------------
  if (is('intrusion', 'states', 'system') && m === 'GET') return store.intrusion;
  if (at(0, 'intrusion') && at(1, 'actions') && m === 'POST') {
    const action = seg[2];
    if (action === 'arm') {
      store.intrusion.armingState.state = 'SYSTEM_ARMED';
      store.intrusion.activeConfigurationProfile.profileId = String(body?.profileId ?? '0');
    } else if (action === 'disarm') {
      store.intrusion.armingState.state = 'SYSTEM_DISARMED';
      store.intrusion.alarmState.value = 'ALARM_OFF';
    } else if (action === 'mute') {
      store.intrusion.alarmState.value = 'ALARM_MUTED';
    }
    return {};
  }

  return notFound(`demo: unhandled ${m} ${urlPath}`);
}

module.exports = { handle, store };
