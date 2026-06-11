// Circular by design — these are only ever called at runtime (inside loadAll /
// renderAll / notifyNewMessage / api's 401 path), never during module eval, so
// the cycle resolves cleanly.
import { renderDevices } from './devices.js';
import { renderScenarios } from './scenarios.js';
import { renderSecurity } from './security.js';
import { renderMessages, messageTitle } from './messages.js';
import { renderAdmin } from './admin.js';
import { renderUsers } from './users.js';
import { renderSessions } from './sessions.js';
import { showLogin } from './auth.js';

const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

// =========================================================================
//  i18n
// =========================================================================
const I18N = {};

async function loadI18N() {
  const [de, en] = await Promise.all([
    fetch('i18n/de.json').then(r => r.json()),
    fetch('i18n/en.json').then(r => r.json()),
  ]);
  I18N.de = de;
  I18N.en = en;
}

function t(key, ...args) {
  const dict = I18N[state.lang] || I18N.de;
  let s = dict[key];
  if (s == null) s = (I18N.de[key] != null ? I18N.de[key] : key);
  return s.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '');
}

const state = {
  info: {},
  rooms: [],
  devices: [],
  services: [],
  scenarios: [],
  messages: [],
  // History of dismissed / no-longer-active messages, persisted server-side
  // (see /api/messages/archive). Rendered as a second list under the active
  // messages on the Messages tab.
  messageArchive: [],
  clients: [],
  automations: [],
  userdefinedstates: [],
  intrusion: null,
  // Collapsible rooms: set of room ids currently collapsed. Persisted via
  // saveCollapsedRooms() — survives reloads so the user doesn't have to
  // re-collapse the same rooms every session.
  collapsedRooms: (() => {
    try { return new Set(JSON.parse(localStorage.getItem('collapsedRooms') || '[]')); }
    catch { return new Set(); }
  })(),
  deviceFilter: '',
  // null | 'AVAILABLE' | 'UNAVAILABLE' — quick status filter
  statusFilter: null,
  // Multi-select quick filter by device category (see DEVICE_CATEGORIES).
  // Empty set = no filter.
  typeFilter: new Set(),
  lang: (() => {
    const stored = localStorage.getItem('lang');
    if (stored === 'en' || stored === 'de') return stored;
    // First visit: take the cue from the browser. Default to German because
    // the SHC is a German product and the rest of the app's documentation
    // assumes German users; only switch to English if the browser explicitly
    // prefers an English locale.
    return (navigator.language || '').toLowerCase().startsWith('en') ? 'en' : 'de';
  })(),
  theme: (localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'),
  notify: localStorage.getItem('notify') === '1',
  // Auth: { enabled, authenticated, user: {username, role, mustChangePassword} | null }
  auth: { enabled: false, authenticated: true, user: null },
  // Admin-only tab data
  users: [],
  sessions: [],
};

const isAdmin = () => !state.auth.enabled || state.auth.user?.role === 'admin';

async function toggleNotify() {
  if (!('Notification' in window)) {
    alert(t('notify.unsupported'));
    return;
  }
  if (Notification.permission === 'denied') {
    alert(t('notify.denied'));
    return;
  }
  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    state.notify = true;
  } else {
    state.notify = !state.notify;
  }
  localStorage.setItem('notify', state.notify ? '1' : '0');
  applyStaticTexts();
}

function notifyNewMessage(m) {
  if (!state.notify) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const codeName = m.messageCode?.name || 'UNKNOWN';
  const title = messageTitle(codeName);
  const source = m.sourceName || (m.sourceId && deviceName(m.sourceId)) || m.sourceId || '';
  const body = m.location ? `${m.location} - ${source}` : source;
  try {
    const n = new Notification(title, { body, tag: m.id });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (_) { /* ignore */ }
}

function saveCollapsedRooms() {
  try { localStorage.setItem('collapsedRooms', JSON.stringify([...state.collapsedRooms])); }
  catch { /* quota or private-mode — silently drop persistence */ }
}

function setTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return;
  state.theme = theme;
  localStorage.setItem('theme', theme);
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  applyStaticTexts();
}

function setLang(lang) {
  if (lang !== 'de' && lang !== 'en') return;
  state.lang = lang;
  localStorage.setItem('lang', lang);
  document.documentElement.lang = lang;
  applyStaticTexts();
  // Re-render everything so all texts get updated. The device toolbar is
  // rebuilt as well, so capture the filter value and restore it afterwards.
  const filterVal = state.deviceFilter;
  const toolbar = $('#device-toolbar');
  if (toolbar) toolbar.remove();
  renderAll();
  if (filterVal && $('#device-filter')) $('#device-filter').value = filterVal;
}

// Apply all static texts (header, tabs, refresh, lang-switch active state)
// from the dictionary to the DOM. Called on boot and from setLang().
function applyStaticTexts() {
  document.title = state.lang === 'en' ? 'Bosch SHC - local UI' : 'Bosch SHC - lokales UI';
  $('#refresh').textContent = t('header.refresh');
  $('#event-dot').title = t('header.liveStatus');
  // Tab-Beschriftungen — bei #messages innerhalb des span[data-tab-label]
  $('[data-tab="devices"]').textContent   = t('tab.devices');
  $('[data-tab="scenarios"]').textContent = t('tab.scenarios');
  $('[data-tab="security"]').textContent  = t('tab.security');
  $('[data-tab="admin"]').textContent     = t('tab.admin');
  $('[data-tab="users"]').textContent     = t('tab.users');
  $('[data-tab="sessions"]').textContent  = t('tab.sessions');
  $('[data-tab="messages"] [data-tab-label]').textContent = t('tab.messages');
  // Mobile dropdown mirrors the same labels (i18n applied here too)
  for (const name of ['devices','scenarios','security','messages','admin','users','sessions']) {
    const opt = $(`#tab-select option[value="${name}"]`);
    if (opt) opt.textContent = t('tab.' + name);
  }
  // Account button (only present when auth is enabled)
  const acc = $('#account-btn');
  if (acc && state.auth.enabled) {
    acc.textContent = state.auth.user?.username || t('auth.account');
    acc.title = t('auth.accountTitle');
  }
  // Lang-Switch: aktiver Button hervorheben
  $$('#lang-switch [data-lang]').forEach(b => {
    const active = b.dataset.lang === state.lang;
    b.classList.toggle('bg-blue-600', active);
    b.classList.toggle('text-white', active);
    b.classList.toggle('hover:bg-slate-100', !active);
  });
  // Theme-Switch: aktiver Button hervorheben + Tooltips lokalisieren
  $$('#theme-switch [data-theme-set]').forEach(b => {
    const active = b.dataset.themeSet === state.theme;
    b.classList.toggle('bg-blue-600', active);
    b.classList.toggle('text-white', active);
    b.classList.toggle('hover:bg-slate-100', !active);
    b.title = t(b.dataset.themeSet === 'dark' ? 'header.themeDark' : 'header.themeLight');
  });
  // Notify-Toggle: aktiver Zustand spiegelt state.notify + erteilte Permission
  const nb = $('#notify-toggle');
  if (nb) {
    const granted = ('Notification' in window) && Notification.permission === 'granted';
    const active = state.notify && granted;
    nb.classList.toggle('bg-blue-600', active);
    nb.classList.toggle('text-white', active);
    nb.classList.toggle('hover:bg-slate-100', !active);
    nb.title = t(active ? 'notify.on' : 'notify.off');
  }
  // Info line: not yet loaded → "Connecting …", IP present → full info,
  // otherwise (loaded but no IP) → plain "Connected"
  const i = state.info;
  const loaded = i && Object.keys(i).length > 0;
  $('#info-line').textContent = !loaded
    ? t('header.connecting')
    : (i.shcIpAddress
        ? t('header.infoLine', i.shcIpAddress, (i.apiVersions||[]).join(', '), i.softwareUpdateState?.swInstalledVersion ?? '-')
        : t('header.connected'));
}

// =========================================================================
//  HTTP-Helper
// =========================================================================
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  // Auth dropouts (session revoked by admin, server restart with auth.json gone, …)
  // bounce the user back to the login screen instead of crashing the UI.
  if (res.status === 401 && state.auth.enabled && !path.startsWith('/api/auth/')) {
    state.auth.authenticated = false;
    state.auth.user = null;
    showLogin();
    throw new Error('unauthenticated');
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    // SHC often returns errors as a nested body object with errorCode/message
    const inner = data.body || {};
    const detail = inner.message || inner.errorCode || (inner.raw && String(inner.raw).slice(0, 200));
    const msg = detail ? `${data.error || 'HTTP ' + res.status} - ${detail}` : (data.error || `HTTP ${res.status}`);
    const e = new Error(msg);
    e.body = data; throw e;
  }
  return data;
}
const safeApi = (p, o) => api(p, o).catch(() => null);

// =========================================================================
//  Load data
// =========================================================================
async function loadAll() {
  // /api/clients is admin-only; non-admins skip it (the server would return 403)
  const [info, rooms, devices, services, scenarios, messages,
         clients, automations, userdefinedstates, intrusion, messageArchive] = await Promise.all([
    safeApi('/api/info'),
    safeApi('/api/rooms'),
    safeApi('/api/devices'),
    safeApi('/api/services'),
    safeApi('/api/scenarios'),
    safeApi('/api/messages'),
    isAdmin() ? safeApi('/api/clients') : Promise.resolve([]),
    safeApi('/api/automations'),
    safeApi('/api/userdefinedstates'),
    safeApi('/api/intrusion'),
    safeApi('/api/messages/archive'),
  ]);
  state.info        = info || {};
  state.rooms       = rooms || [];
  state.devices     = devices || [];
  state.info.macAddress = state.devices.find(d => d.rootDeviceId)?.rootDeviceId;
  state.services    = services || [];
  state.scenarios   = scenarios || [];
  state.messages    = messages || [];
  state.clients     = clients || [];
  state.automations = automations || [];
  state.userdefinedstates = userdefinedstates || [];
  state.intrusion   = intrusion;
  state.messageArchive = messageArchive || [];

  applyStaticTexts();
  renderAll();
}

function renderAll() {
  renderDevices();
  renderScenarios();
  renderSecurity();
  renderMessages();
  if (isAdmin()) {
    renderAdmin();
    renderUsers();
    renderSessions();
  }
}

const serviceOf = (deviceId, serviceId) =>
  state.services.find(s => s.deviceId === deviceId && s.id === serviceId);
const roomName = (id) => state.rooms.find(r => r.id === id)?.name ?? id;
const deviceName = (id) => state.devices.find(d => d.id === id)?.name ?? id;

// Determines a device's update status. Sources in this order:
//  1) "SoftwareUpdate" service on the device (most reliable: state + both versions)
//  2) "FirmwareVersion" service or similar (installed version only)
//  3) SOFTWARE_UPDATE_AVAILABLE message targeting the device (fallback)
// Note: many devices (e.g. some third-party devices) don't expose any firmware
// info via the SHC API at all — in that case the field stays empty.
function deviceUpdateInfo(device) {
  // 1) SoftwareUpdate service
  const swSvc = serviceOf(device.id, 'SoftwareUpdate');
  if (swSvc?.state) {
    const st = swSvc.state;
    const swState = st.swUpdateState || st.state || '';
    const hasUpdate =
      /UPDATE_AVAILABLE/i.test(swState) ||
      /DOWNLOADING/i.test(swState) ||
      /UPDATE_IN_PROGRESS/i.test(swState);
    return {
      hasUpdate,
      currentVersion: st.swInstalledVersion || st.installedVersion || null,
      targetVersion:  st.swUpdateAvailableVersion || st.availableVersion || null,
      stateText:      swState || null,
    };
  }
  // 2) Some devices have a FirmwareVersion service or similar
  const fwSvc = serviceOf(device.id, 'FirmwareVersion') ||
                serviceOf(device.id, 'DeviceFirmwareVersion');
  // 3) Message fallback
  const msg = state.messages.find(m =>
    m.sourceId === device.id &&
    /UPDATE/i.test(m.messageCode?.name || '')
  );
  const args = msg?.arguments || {};
  return {
    hasUpdate: !!msg,
    currentVersion:
      fwSvc?.state?.firmwareVersion || fwSvc?.state?.version ||
      args.swInstalledVersion || args.installedVersion || args.currentVersion ||
      device.firmwareVersion || device.swVersion || null,
    targetVersion:
      args.swUpdateAvailableVersion || args.availableVersion || args.targetVersion || args.version || null,
    stateText: null,
  };
}


const escapeHtml = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

export { $, $$, I18N, loadI18N, t, state, isAdmin, toggleNotify, notifyNewMessage, saveCollapsedRooms, setTheme, setLang, applyStaticTexts, api, safeApi, loadAll, renderAll, serviceOf, roomName, deviceName, deviceUpdateInfo, escapeHtml };
