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
  clients: [],
  automations: [],
  userdefinedstates: [],
  intrusion: null,
  // Collapsible rooms: set of room ids currently collapsed
  collapsedRooms: new Set(),
  deviceFilter: '',
  // null | 'AVAILABLE' | 'UNAVAILABLE' — quick status filter
  statusFilter: null,
  lang: (localStorage.getItem('lang') === 'en' ? 'en' : 'de'),
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
         clients, automations, userdefinedstates, intrusion] = await Promise.all([
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

// =========================================================================
//  Tab: Devices
// =========================================================================
// Fixed sort order for device types within a room.
// Lower number = higher up. Unknown models end up at the bottom.
const DEVICE_TYPE_ORDER = [
  ['ROOM_CLIMATE_CONTROL'],                                         // virtual room climate control
  ['THB', 'RTH', 'RTH2', 'RT2'],                                    // room thermostat
  ['TRV', 'TRV_GEN2'],                                              // radiator thermostat
  ['SWD', 'SWD2'],                                                  // door/window contact
  ['BBL', 'BBL_2', 'MICROMODULE_SHUTTER', 'SHUTTER_CONTROL'],       // shutter
  ['BSM', 'MICROMODULE_LIGHT_CONTROL', 'LIGHT_CONTROL_2',
   'HUE_LIGHT', 'LEDVANCE_LIGHT', 'SMART_BULB'],                    // light
  ['PSM', 'PLUG', 'PLUG_COMPACT'],                                  // smart plug
  ['SD', 'SMOKE_DETECTOR', 'SMOKE_DETECTOR_2', 'TWINGUARD'],        // smoke detector
  ['MD', 'MOTION_DETECTOR'],                                        // motion detector
  ['WLS', 'WATER_LEAKAGE_SENSOR'],                                  // water leakage sensor
  ['UNIVERSAL_SWITCH', 'UNIVERSAL_SWITCH_2', 'WRC2'],               // universal switch
  ['HUE_BRIDGE'],                                                   // bridges
];
const DEVICE_MODEL_RANK = (() => {
  const m = new Map();
  DEVICE_TYPE_ORDER.forEach((group, i) => group.forEach(model => m.set(model, i)));
  return m;
})();
function deviceSortRank(device) {
  const m = (device.deviceModel || '').toUpperCase();
  if (DEVICE_MODEL_RANK.has(m)) return DEVICE_MODEL_RANK.get(m);
  // Prefix matches (e.g. CAMERA_*, TRV_*) for robustness
  for (const [model, rank] of DEVICE_MODEL_RANK) {
    if (m.startsWith(model + '_')) return rank;
  }
  return DEVICE_TYPE_ORDER.length;
}
function renderDevices() {
  // Build the toolbar only once so the filter input keeps focus during
  // re-renders (e.g. triggered by SSE events).
  if (!$('#device-toolbar')) {
    $('#tab-devices').innerHTML = `
      <div id="device-toolbar" class="flex items-center gap-2 mb-3 sticky top-[88px] bg-slate-100/90 backdrop-blur py-2 z-[5]">
        <input id="device-filter" type="search" placeholder="${t('devices.filter')}"
          class="flex-1 border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white" />
        <button id="filter-available"   data-status="AVAILABLE"
          title="${t('devices.onlyAvailable')}"
          class="status-filter inline-flex items-center justify-center px-2 py-1.5 border border-slate-300 rounded-md bg-white hover:bg-slate-50">
          <img src="svg/wifi-strength-4.svg" alt="" style="width:16px;height:16px" />
        </button>
        <button id="filter-unavailable" data-status="UNAVAILABLE"
          title="${t('devices.onlyUnavailable')}"
          class="status-filter inline-flex items-center justify-center px-2 py-1.5 border border-slate-300 rounded-md bg-white hover:bg-slate-50">
          <img src="svg/wifi-off.svg" alt="" style="width:16px;height:16px" />
        </button>
        <button id="expand-all"   title="${t('devices.expandAll')}"
          class="px-2 py-1.5 text-sm border border-slate-300 rounded-md bg-white hover:bg-slate-50">⇕</button>
        <button id="collapse-all" title="${t('devices.collapseAll')}"
          class="px-2 py-1.5 text-sm border border-slate-300 rounded-md bg-white hover:bg-slate-50">⇔</button>
      </div>
      <div id="device-list"></div>`;
    $('#device-filter').addEventListener('input', (e) => {
      state.deviceFilter = e.target.value;
      renderDeviceList();
    });
    $$('#device-toolbar .status-filter').forEach(b => b.addEventListener('click', () => {
      // Click on active filter clears it; otherwise activate this filter
      state.statusFilter = state.statusFilter === b.dataset.status ? null : b.dataset.status;
      updateStatusFilterButtons();
      renderDeviceList();
    }));
    $('#expand-all').addEventListener('click', () => {
      state.collapsedRooms.clear();
      renderDeviceList();
    });
    $('#collapse-all').addEventListener('click', () => {
      const allRooms = new Set(state.devices.filter(d => d.roomId).map(d => d.roomId));
      state.collapsedRooms = allRooms;
      renderDeviceList();
    });
  }
  updateStatusFilterButtons();
  renderDeviceList();
}

function updateStatusFilterButtons() {
  $$('#device-toolbar .status-filter').forEach(b => {
    const active = state.statusFilter === b.dataset.status;
    b.classList.toggle('bg-blue-600', active);
    b.classList.toggle('text-white',  active);
    b.classList.toggle('border-blue-600', active);
    b.classList.toggle('bg-white',    !active);
    b.classList.toggle('hover:bg-slate-50', !active);
    b.classList.toggle('border-slate-300',  !active);
  });
}

function renderDeviceList() {
  const filter = (state.deviceFilter || '').trim().toLowerCase();
  const matchesText = (d) => {
    if (!filter) return true;
    return (d.name || '').toLowerCase().includes(filter)
        || (d.deviceModel || '').toLowerCase().includes(filter)
        || roomName(d.roomId).toLowerCase().includes(filter);
  };
  const matchesStatus = (d) =>
    !state.statusFilter || d.status === state.statusFilter;

  const visible = state.devices.filter(d =>
    d.roomId && d.status !== 'DISCOVERED' && matchesText(d) && matchesStatus(d)
  );
  // Discovered devices: not yet configured, no roomId, not affected by status filter
  const discovered = state.devices
    .filter(d => d.status === 'DISCOVERED' && matchesText(d))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, 'de'));
  const byRoom = new Map();
  for (const d of visible) {
    if (!byRoom.has(d.roomId)) byRoom.set(d.roomId, []);
    byRoom.get(d.roomId).push(d);
  }
  for (const devs of byRoom.values()) {
    devs.sort((a, b) => {
      const r = deviceSortRank(a) - deviceSortRank(b);
      if (r !== 0) return r;
      return (a.name || a.id).localeCompare(b.name || b.id, 'de');
    });
  }

  const discoveredHtml = discovered.length ? `
    <section class="mb-4 border border-amber-300 bg-amber-50 rounded-lg p-3">
      <h2 class="text-sm uppercase tracking-wide text-amber-800 flex items-center gap-1.5 mb-1">
        ⚠ ${t('devices.discoveredHeader', discovered.length)}
      </h2>
      <p class="text-xs text-amber-700 mb-2">${t('devices.discoveredHint')}</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        ${discovered.map(d => `
          <article class="card bg-white rounded-lg p-4 border border-amber-200">
            <header class="flex items-start gap-2.5">
              <div class="text-2xl leading-none mt-0.5 shrink-0" aria-hidden="true">
                <img src="svg/${deviceIcon(d)}.svg" style="width:25px;height:25px" />
              </div>
              <div class="min-w-0">
                <h3 class="font-medium leading-tight truncate">${d.name || d.id}</h3>
                <p class="text-xs text-slate-500">${d.deviceModel || d.profile || ''}</p>
                <p class="text-[10px] text-slate-400 mt-1 break-all">${d.id}</p>
              </div>
            </header>
          </article>`).join('')}
      </div>
    </section>` : '';

  $('#device-list').innerHTML = discoveredHtml + [...byRoom.entries()]
    .sort((a, b) => roomName(a[0]).localeCompare(roomName(b[0]), 'de'))
    .map(([rId, devs]) => {
      // When any filter is active, always open matching rooms
      const filtering = !!filter || !!state.statusFilter;
      const open = filtering ? true : !state.collapsedRooms.has(rId);
      return `
      <details class="room mb-4" data-room="${rId}" ${open ? 'open' : ''}>
        <summary class="flex items-end justify-between mb-2 px-1 gap-3">
          <h2 class="text-sm uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
            <span class="chev text-slate-400">▸</span>
            ${roomName(rId)}
            <span class="normal-case text-[11px] text-slate-400">(${devs.length})</span>
          </h2>
          ${renderRoomClimateBadge(rId)}
        </summary>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          ${devs.map(safeRenderDeviceCard).join('')}
        </div>
      </details>`;
    }).join('') || `<p class="text-slate-500">${filter ? t('devices.noMatches') : t('devices.none')}</p>`;

  $$('#device-list [data-action]').forEach(el => el.addEventListener('click', onDeviceAction));
  $$('#device-list [data-temp-set]').forEach(el => el.addEventListener('change', onTemperatureChange));
  // Remember the open/closed state on user interaction (not while filtering)
  $$('#device-list details.room').forEach(el => el.addEventListener('toggle', () => {
    if (state.deviceFilter.trim() || state.statusFilter) return;
    if (el.open) state.collapsedRooms.delete(el.dataset.room);
    else        state.collapsedRooms.add(el.dataset.room);
  }));
}

// Climate summary for a room: prefers the virtual roomClimateControl_*
// device of the room for the temperature and any HumidityLevel source in the
// same room for the humidity.
function renderRoomClimateBadge(roomId) {
  const roomDeviceIds = state.devices
    .filter(d => d.roomId === roomId)
    .map(d => d.id);

  // Temperature: prefer the virtual roomClimateControl_* device, fall back to any TemperatureLevel
  const rccDevice = state.devices.find(
    d => d.roomId === roomId && d.id?.startsWith('roomClimateControl_')
  );
  let tempSvc = rccDevice && serviceOf(rccDevice.id, 'TemperatureLevel');
  if (!tempSvc) {
    tempSvc = state.services.find(
      s => s.id === 'TemperatureLevel' && roomDeviceIds.includes(s.deviceId)
    );
  }
  // Humidity: any HumidityLevel in the room (e.g. Room Thermostat II or Twinguard)
  const humSvc = state.services.find(
    s => s.id === 'HumidityLevel' && roomDeviceIds.includes(s.deviceId)
  );

  const t = tempSvc?.state?.temperature;
  const h = humSvc?.state?.humidity;
  if (t == null && h == null) return '';

  const parts = [];
  if (t != null) parts.push(`<span class="tabular-nums">${t.toFixed(1)}°C</span>`);
  if (h != null) parts.push(`<span class="tabular-nums">${Math.round(h)}% rH</span>`);
  return `<div class="text-xs text-slate-600 flex items-center gap-2">${parts.join(' · ')}</div>`;
}

// Returns an icon name for a device. Primary lookup is by deviceModel
// (Bosch shorthand like TRV, SWD, PSM …), with a fallback based on the
// services present for unknown or third-party devices.
function deviceIcon(device) {
  const services = state.services.filter(s => s.deviceId === device.id);
  const m = (device.deviceModel || '').toUpperCase();
  const has = (id) => state.services.some(s => s.deviceId === device.id && s.id === id);

  // Radiator thermostat
  if (m === 'TRV' || m === 'TRV_GEN2' || m.startsWith('TRV')) {
    const valve = services.find(s => s.id === 'ValveTappet');
    return (valve?.state?.position ?? 0) > 0 ? 'radiator' : 'radiator-disabled';
  }
  // Room thermostat / virtual room climate control
  if (m === 'THB' || m === 'RTH' || m === 'RTH2' || m === 'RT2'
      || m === 'ROOM_CLIMATE_CONTROL') return 'home-thermometer';
  // Door/window contact
  if (m === 'SWD' || m === 'SWD2' || m.startsWith('SWD')) {
    const sc = services.find(s => s.id === 'ShutterContact');
    return sc?.state?.value === 'OPEN' ? 'window-open' : 'window-closed';
  }
  // Smart plug
  if (m === 'PSM' || m === 'PLUG' || m === 'PLUG_COMPACT') {
    const power = services.find(s => s.id === 'PowerSwitch');
    return power?.state?.switchState === 'ON' ? 'power-plug' : 'power-plug-off';
  }
  // Light switch / micromodule / smart bulb
  if (m === 'BSM' || m === 'MICROMODULE_LIGHT_CONTROL'
      || m === 'LIGHT_CONTROL_2' || m === 'HUE_LIGHT'
      || m === 'LEDVANCE_LIGHT' || m === 'SMART_BULB') {
        return "lightbulb-on";
      };
  if (m === 'HUE_BRIDGE') return 'router-network';
  // Shutter / blinds
  if (m === 'BBL' || m === 'BBL_2' || m === 'MICROMODULE_SHUTTER' || m === 'SHUTTER_CONTROL') {
        return 'window-shutter'
  };
  // Smoke detector
  if (m === 'SD' || m === 'SMOKE_DETECTOR' || m === 'SMOKE_DETECTOR_2' || m === 'TWINGUARD') {
    return 'smoke-detector'
  };
  // Motion detector
  if (m === 'MD' || m === 'MOTION_DETECTOR') return 'motion-sensor';
  // Water leakage sensor
  if (m === 'WLS' || m === 'WATER_LEAKAGE_SENSOR') return 'water-alert';
  // Cameras
  if (m.startsWith('CAMERA') || m === 'EYES_OUTDOOR') return 'cctv';
  // Universal switch / remote
  if (m === 'UNIVERSAL_SWITCH' || m === 'UNIVERSAL_SWITCH_2' || m === 'WRC2') return 'light-switch-off';
  // Alarm system
  if (m === 'INTRUSION_DETECTION_SYSTEM') return 'shield-home';
  // Presence simulation
  if (m === 'PRESENCE_SIMULATION_SERVICE') return 'account-multiple';

  // Fallback based on the services that are present
  if (has('ValveTappet')) return 'radiator';
  if (has('RoomClimateControl')) return 'home-thermometer';
  if (has('ShutterContact')) return 'window-shutter';
  if (has('PowerSwitch')) return 'power-plug';
  if (has('SmokeDetectorCheck') || has('AirQualityLevel')) return 'smoke-detector';
  if (has('LatestMotion')) return 'motion-sensor';
  if (has('WaterLeakageSensor')) return 'water-alert';
  if (has('HumidityLevel') || has('TemperatureLevel')) return '';
  return '⚙️';
}

// Known camera services and how they map to a toggle button.
// PrivacyMode is inverted: "Privacy ENABLED" = camera OFF, so the camera is
// considered "on" when the value is DISABLED.
const CAMERA_SERVICE_DEFS = {
  PrivacyMode: {
    type:  'privacyModeState',
    field: 'value',
    onValue:  'DISABLED',
    offValue: 'ENABLED',
    onKey:  'devices.cameraOff', // camera is on → button says "turn off"
    offKey: 'devices.cameraOn',
  },
  CameraNotification: {
    type:  'cameraNotificationState',
    field: 'value',
    onValue:  'ENABLED',
    offValue: 'DISABLED',
    onKey:  'devices.notifyOff',
    offKey: 'devices.notifyOn',
  },
  CameraLight: {
    type:  'cameraLightState',
    field: 'value',
    onValue:  'ON',
    offValue: 'OFF',
    onKey:  'devices.lightOff',
    offKey: 'devices.lightOn',
  },
};

// Maps the value of CommunicationQuality.state.quality to icon, color and a
// human-readable tooltip. Possible values per the Bosch SHC API:
// UNKNOWN, FETCHING, BAD, MEDIUM, NORMAL, GOOD.
function commQualityInfo(quality) {
  const map = {
    GOOD:     { icon: 'wifi-strength-4',       cls: 'text-emerald-600', label: t('commQuality.good') },
    NORMAL:   { icon: 'wifi-strength-3',       cls: 'text-lime-600',    label: t('commQuality.normal') },
    MEDIUM:   { icon: 'wifi-strength-2',       cls: 'text-amber-600',   label: t('commQuality.medium') },
    BAD:      { icon: 'wifi-strength-1',       cls: 'text-rose-600',    label: t('commQuality.bad') },
    FETCHING: { icon: 'wifi-sync',             cls: 'text-blue-500',    label: t('commQuality.fetching') },
    UNKNOWN:  { icon: 'wifi-strength-outline', cls: 'text-slate-400',   label: t('commQuality.unknown') },
  };
  return map[quality] || { icon: 'wifi-off', cls: 'text-slate-400', label: quality || t('commQuality.unknown') };
}

// Wrapper: a render error in a single card must not tear down the whole
// device list. We show a fallback error card instead.
function safeRenderDeviceCard(device) {
  try {
    return renderDeviceCard(device);
  } catch (err) {
    console.error('renderDeviceCard failed for', device?.id, err);
    return `
      <article class="card bg-rose-50 rounded-lg p-4 border border-rose-200">
        <h3 class="font-medium text-rose-800 truncate">${device?.name || device?.id || '?'}</h3>
        <p class="text-xs text-rose-700 mt-1">${t('error.cardRender', err.message)}</p>
      </article>`;
  }
}

function renderDeviceCard(device) {
  const services = state.services.filter(s => s.deviceId === device.id);
  const power    = services.find(s => s.id === 'PowerSwitch');
  const climate  = services.find(s => s.id === 'RoomClimateControl');
  const temp     = services.find(s => s.id === 'TemperatureLevel');
  const humidity = services.find(s => s.id === 'HumidityLevel');
  const battery  = services.find(s => s.id === 'BatteryLevel');
  const shutter  = services.find(s => s.id === 'ShutterContact');
  const valve    = services.find(s => s.id === 'ValveTappet');
  const energy   = services.find(s => s.id === 'PowerMeter');
  const silentMode = services.find(s => s.id === 'SilentMode');
  const communicationQuality = services.find(s => s.id === 'CommunicationQuality');

  const humTxt = (humidity?.state?.humidity != null)
    ? `<span class="inline-flex items-center gap-1 text-slate-500 text-sm tabular-nums">
         <img src="svg/water-percent.svg" style="width:20px;height:20px" alt="" />
         ${Math.round(humidity.state.humidity)}% rH
       </span>`
    : '';

  let body = '';
  if (power) {
    const on = power.state?.switchState === 'ON';
    body += `
      <button data-action="toggle-power" data-device="${device.id}" data-on="${on}"
        class="w-full mt-2 px-3 py-2 rounded-md font-medium text-sm
        ${on ? 'bg-amber-100 text-amber-900 hover:bg-amber-200'
             : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}">
        ${t(on ? 'devices.turnOff' : 'devices.turnOn')}
      </button>`;
  }
  // Inline camera toggles (PrivacyMode, CameraNotification, CameraLight),
  // shown if the device exposes the respective service.
  for (const [svcId, def] of Object.entries(CAMERA_SERVICE_DEFS)) {
    const svc = services.find(s => s.id === svcId);
    if (!svc) continue;
    const on = svc.state?.[def.field] === def.onValue;
    body += `
      <button data-action="toggle-cam" data-device="${device.id}" data-svc="${svcId}" data-on="${on}"
        class="w-full mt-2 px-3 py-2 rounded-md font-medium text-sm
        ${on ? 'bg-amber-100 text-amber-900 hover:bg-amber-200'
             : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}">
        ${t(on ? def.onKey : def.offKey)}
      </button>`;
  }
  if (climate && temp) {
    const setpoint = climate.state?.setpointTemperature ?? '-';
    const current  = temp.state?.temperature?.toFixed?.(1) ?? '-';
    body += `
      <div class="mt-2 flex items-center gap-3">
        <div class="text-2xl font-light tabular-nums">${current}°</div>
        <div class="text-xs text-slate-500">${t('devices.current')}</div>
        <div class="ml-auto flex items-center gap-1.5">
          <input type="number" min="5" max="30" step="0.5" value="${setpoint}"
            data-temp-set data-device="${device.id}"
            class="w-16 text-right border border-slate-300 rounded-md px-2 py-1 text-sm tabular-nums" />
          <span class="text-xs text-slate-500">${t('devices.target')}</span>
        </div>
      </div>
      ${humTxt ? `<div class="mt-1">${humTxt}</div>` : ''}`;
  } else if (temp && humidity) {
    body += `
      <div class="mt-2 flex items-baseline gap-4">
        <div class="text-2xl font-light tabular-nums">${temp.state?.temperature?.toFixed?.(1) ?? '-'}°</div>
        ${humTxt}
      </div>`;
  } else if (temp) {
    body += `<div class="mt-2 text-2xl font-light tabular-nums">${temp.state?.temperature?.toFixed?.(1) ?? '-'}°</div>`;
  } else if (humidity) {
    body += `<div class="mt-2">${humTxt}</div>`;
  }
  if (shutter) {
    const open = shutter.state?.value === 'OPEN';
    body += `<div class="mt-2 inline-flex items-center gap-1.5 text-sm
      ${open ? 'text-rose-700' : 'text-emerald-700'}">
      <span class="w-2 h-2 rounded-full ${open ? 'bg-rose-500' : 'bg-emerald-500'}"></span>
      ${t(open ? 'devices.opened' : 'devices.closed')}
    </div>`;
  }
  if (energy?.state) {
    body += `<div class="mt-2 text-xs text-slate-500">
      ${energy.state.powerConsumption ?? 0} W · ${(energy.state.energyConsumption/1000).toFixed(2)} kWh
    </div>`;
  }
  if (silentMode) {
    // Display-only: PUTting to SilentMode triggers SERVICE_INVOCATION_FAILED
    // on some TRV models and pushes the device to UNAVAILABLE. Writing is
    // disabled until the correct payload format is confirmed.
    const silent = silentMode.state?.mode === 'MODE_SILENT';
    body += `
      <span title="${t('devices.silentTitle')}"
        class="mt-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
        ${silent ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-600'}">
        ${t(silent ? 'devices.silentOn' : 'devices.silentOff')}
      </span>`;
  }
  const meta = [];
  if (battery?.state) {
    const lvl = battery.state.warningLevel || 'OK';
    // Possible values per the API: OK, LOW_BATTERY, CRITICAL_LOW,
    // CRITICAL_LOW_BATTERY, INSERT_BATTERY, NOT_AVAILABLE
    const map = {
      OK:                    { icon: 'battery-high', cls: 'text-emerald-700', label: t('battery.ok') },
      LOW_BATTERY:           { icon: 'battery-medium', cls: 'text-amber-700',   label: t('battery.low') },
      CRITICAL_LOW:          { icon: 'battery-low', cls: 'text-rose-700',    label: t('battery.critical') },
      CRITICAL_LOW_BATTERY:  { icon: 'battery-low', cls: 'text-rose-700',    label: t('battery.critical') },
      INSERT_BATTERY:        { icon: 'battery-off-outline',  cls: 'text-rose-700',    label: t('battery.insert') },
      NOT_AVAILABLE:         { icon: 'cable-data', cls: 'text-slate-500',   label: t('battery.mains') },
    };
    const b = map[lvl] || { icon: '🔋', cls: 'text-slate-600', label: lvl };
    // omit for mains-powered devices, otherwise show
    if (lvl !== 'NOT_AVAILABLE') {
      meta.push(`<span class="${b.cls}"><img src="svg/${b.icon}.svg"> ${b.label}</span>`);
    }
  }
  if (valve?.state?.position != null) meta.push(t('devices.valve', valve.state.position));

  let cqHtml = '';
  if (communicationQuality?.state?.quality) {
    const cq = commQualityInfo(communicationQuality.state.quality);
    const url = `svg/${cq.icon}.svg`;
    const tip = t('devices.commQuality', cq.label, communicationQuality.state.quality);
    cqHtml = `<span class="icon-mask ${cq.cls}"
        style="width:18px;height:18px;mask-image:url(${url});-webkit-mask-image:url(${url})"
        title="${tip}" aria-label="${tip}"></span>`;
  }

  return `
    <article class="card bg-white rounded-lg p-4 border border-slate-200">
      <header class="flex items-start justify-between gap-2">
        <div class="flex items-start gap-2.5 min-w-0">
          <div class="text-2xl leading-none mt-0.5 shrink-0" aria-hidden="true"><img src="svg/${deviceIcon(device)}.svg" style="width: 25px; height: 25px;"/></div>
          <div class="min-w-0">
            <h3 class="font-medium leading-tight">${device.name || device.id}</h3>
            <p class="text-xs text-slate-500">${device.deviceModel || device.profile || ''}</p>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          ${cqHtml}
          <span class="text-[10px] px-1.5 py-0.5 rounded
            ${device.status === 'AVAILABLE' ? 'bg-emerald-50 text-emerald-700'
                                            : 'bg-slate-100 text-slate-500'}">${device.status||''}</span>
        </div>
      </header>
      ${body}
      ${meta.length ? `<div class="mt-2 text-xs text-slate-500 space-x-2">${meta.join(' · ')}</div>` : ''}
    </article>`;
}

async function onDeviceAction(e) {
  const btn = e.currentTarget;
  const { action, device } = btn.dataset;
  if (action === 'toggle-power') {
    const newState = btn.dataset.on === 'true' ? 'OFF' : 'ON';
    btn.classList.add('pulse');
    try {
      await api(`/api/devices/${encodeURIComponent(device)}/services/PowerSwitch/state`, {
        method: 'PUT',
        body: { '@type': 'powerSwitchState', switchState: newState },
      });
      const svc = serviceOf(device, 'PowerSwitch');
      if (svc) svc.state.switchState = newState;
      renderDevices();
    } catch (err) { alert(t('error.generic', err.message)); }
  } else if (action === 'toggle-cam') {
    const svcId = btn.dataset.svc;
    const def = CAMERA_SERVICE_DEFS[svcId];
    if (!def) return;
    const newValue = btn.dataset.on === 'true' ? def.offValue : def.onValue;
    btn.classList.add('pulse');
    try {
      await api(`/api/devices/${encodeURIComponent(device)}/services/${svcId}/state`, {
        method: 'PUT',
        body: { '@type': def.type, [def.field]: newValue },
      });
      const svc = serviceOf(device, svcId);
      if (svc) svc.state = { ...(svc.state || {}), '@type': def.type, [def.field]: newValue };
      renderDevices();
    } catch (err) { alert(t('error.generic', err.message)); }
  }
}

async function onTemperatureChange(e) {
  const input = e.currentTarget;
  try {
    await api(`/api/devices/${encodeURIComponent(input.dataset.device)}/services/RoomClimateControl/state`, {
      method: 'PUT',
      body: { '@type': 'climateControlState', setpointTemperature: parseFloat(input.value) },
    });
  } catch (err) { alert('Fehler: ' + err.message); }
}

// =========================================================================
//  Tab: Scenarios
// =========================================================================
function renderScenarios() {
  const scenariosBlock = state.scenarios.length
    ? `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        ${state.scenarios.map(s => `
          <button data-scenario="${s.id}"
            class="card bg-white rounded-lg p-4 border border-slate-200 text-left hover:border-blue-400">
            <div class="font-medium">${s.name}</div>
            <div class="text-xs text-slate-500 mt-1">${t('scenarios.tap')}</div>
          </button>`).join('')}
      </div>`
    : `<p class="text-slate-500">${t('scenarios.none')}</p>`;

  const udsBlock = state.userdefinedstates.length
    ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        ${state.userdefinedstates.map(u => `
          <div class="flex items-center justify-between bg-white border border-slate-200 rounded-md p-3">
            <span class="font-medium truncate">${u.name}</span>
            <button data-uds="${u.id}" data-on="${!!u.state}"
              class="text-xs px-2 py-1 rounded
              ${u.state ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}">
              ${t(u.state ? 'security.active' : 'security.inactive')}
            </button>
          </div>`).join('')}
      </div>`
    : `<p class="text-slate-500">${t('scenarios.noStates')}</p>`;

  const automationsBlock = state.automations.length
    ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        ${state.automations.map(a => `
          <div class="flex items-center justify-between bg-white border border-slate-200 rounded-md p-3">
            <div class="min-w-0">
              <div class="font-medium truncate">${a.name || a.id}</div>
              <div class="text-xs text-slate-500">${t(a.enabled ? 'admin.autoEnabled' : 'admin.autoDisabled')}</div>
            </div>
            <div class="flex gap-1 shrink-0">
              <button data-auto-toggle="${a.id}" data-enabled="${!!a.enabled}"
                class="text-xs px-2 py-1 rounded
                ${a.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}">
                ${t(a.enabled ? 'admin.on' : 'admin.off')}
              </button>
            </div>
          </div>`).join('')}
      </div>`
    : `<p class="text-slate-500">${t('admin.noAutomations')}</p>`;

  $('#tab-scenarios').innerHTML = `
    <section class="mb-6">
      <h2 class="text-sm font-medium text-slate-700 mb-2">${t('scenarios.scenariosH', state.scenarios.length)}</h2>
      ${scenariosBlock}
    </section>
    <section class="mb-6">
      <h2 class="text-sm font-medium text-slate-700 mb-2">${t('scenarios.statesH', state.userdefinedstates.length)}</h2>
      ${udsBlock}
    </section>
    <section>
      <h2 class="text-sm font-medium text-slate-700 mb-2">${t('admin.automationsH', state.automations.length)}</h2>
      ${automationsBlock}
    </section>`;

  $$('#tab-scenarios [data-scenario]').forEach(b =>
    b.addEventListener('click', async () => {
      try {
        await api(`/api/scenarios/${encodeURIComponent(b.dataset.scenario)}/trigger`, { method: 'POST' });
        b.classList.add('pulse');
        setTimeout(() => b.classList.remove('pulse'), 1500);
      } catch (err) { alert(t('error.generic', err.message)); }
    })
  );

  $$('#tab-scenarios [data-uds]').forEach(b => b.addEventListener('click', async () => {
    const newState = !(b.dataset.on === 'true');
    try {
      await api(`/api/userdefinedstates/${encodeURIComponent(b.dataset.uds)}/state`,
        { method: 'PUT', body: newState });
      const u = state.userdefinedstates.find(x => x.id === b.dataset.uds);
      if (u) u.state = newState;
      renderScenarios();
    } catch (err) { alert(t('error.generic', err.message)); }
  }));

  $$('#tab-scenarios [data-auto-toggle]').forEach(b => b.addEventListener('click', async () => {
    const enabled = !(b.dataset.enabled === 'true');
    const existing = state.automations.find(x => x.id === b.dataset.autoToggle);
    if (!existing) return;
    try {
      await api(`/api/automations/${encodeURIComponent(b.dataset.autoToggle)}`,
        { method: 'PUT', body: { ...existing, enabled } });
      existing.enabled = enabled;
      renderScenarios();
    } catch (err) { alert(t('error.generic', err.message)); }
  }));
}

// =========================================================================
//  Tab: Security (intrusion detection + user-defined states)
// =========================================================================
function renderSecurity() {
  const ids = state.intrusion;
  let idsBlock = '';
  if (ids?.state) {
    const value = ids.state.value || 'SYSTEM_DISARMED';
    const armed = value === 'SYSTEM_ARMED';
    const alarm = value === 'SYSTEM_ALARM' || value === 'MUTE_ALARM';
    const profiles = ids.state.activeConfigurationProfile != null
      ? ids.state.activeConfigurationProfile : '0';
    const remaining = ids.state.remainingTimeUntilArmed
      ? `<span class="text-xs text-slate-500">${t('security.remaining', Math.round(ids.state.remainingTimeUntilArmed/1000))}</span>` : '';
    const stateLabel =
      alarm ? t('security.alarmActive') :
      armed ? t('security.armed') :
      value === 'SYSTEM_ARMING' ? t('security.arming') :
      t('security.disarmed');
    idsBlock = `
      <article class="card bg-white rounded-lg p-5 border border-slate-200">
        <h3 class="font-medium">${t('security.alarm')}</h3>
        <div class="mt-2 flex items-center gap-3">
          <span class="inline-block w-3 h-3 rounded-full
            ${alarm ? 'bg-rose-500 pulse' : armed ? 'bg-emerald-500' : 'bg-slate-300'}"></span>
          <span class="font-semibold">${stateLabel}</span>
          ${remaining}
        </div>
        <p class="text-xs text-slate-500 mt-1">${t('security.activeProfile', profiles)}</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <button data-ids="SYSTEM_ARMED" data-profile="0"
            class="px-3 py-2 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700">
            ${t('security.fullProtection')}
          </button>
          <button data-ids="SYSTEM_ARMED" data-profile="1"
            class="px-3 py-2 text-sm rounded-md bg-emerald-100 text-emerald-800 hover:bg-emerald-200">
            ${t('security.partial')}
          </button>
          <button data-ids="SYSTEM_ARMED" data-profile="2"
            class="px-3 py-2 text-sm rounded-md bg-emerald-100 text-emerald-800 hover:bg-emerald-200">
            ${t('security.custom')}
          </button>
          <button data-ids="SYSTEM_DISARMED"
            class="px-3 py-2 text-sm rounded-md bg-slate-100 text-slate-700 hover:bg-slate-200">
            ${t('security.off')}
          </button>
          ${alarm ? `<button data-ids="MUTE_ALARM"
            class="px-3 py-2 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700">
            ${t('security.muteAlarm')}</button>` : ''}
        </div>
      </article>`;
  } else {
    idsBlock = `<article class="card bg-white rounded-lg p-5 border border-slate-200">
      <h3 class="font-medium">${t('security.alarm')}</h3>
      <p class="text-xs text-slate-500 mt-2">${t('security.notConfigured')}</p>
    </article>`;
  }

  $('#tab-security').innerHTML = idsBlock;

  $$('#tab-security [data-ids]').forEach(b => b.addEventListener('click', async () => {
    const value = b.dataset.ids;
    const body = { value };
    if (b.dataset.profile != null) body.activeProfile = b.dataset.profile;
    try { await api('/api/intrusion/state', { method: 'PUT', body }); }
    catch (err) { alert('Fehler: ' + err.message); }
  }));
}

// =========================================================================
//  Tab: Messages
// =========================================================================
// Translate a Bosch message code into a readable title; uses i18n keys
// 'msg.<CODE>' and falls back to TitleCase for unknown codes.
function messageTitle(codeName) {
  const key = `msg.${codeName}`;
  const dict = I18N[state.lang] || I18N.de;
  if (dict[key]) return dict[key];
  return codeName.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
}

function severityFromMessage(m) {
  // Es gibt kein eigenes severity-Feld - wir leiten es ab.
  const cat = (m.messageCode?.category || '').toUpperCase();
  if (m.flags?.includes('USER_ACTION_REQUIRED')) return 'error';
  if (cat === 'WARNING' || cat === 'ALARM' || cat === 'CRITICAL') return 'error';
  if (cat === 'NOTICE' || cat === 'REMINDER')                     return 'warning';
  return 'info';
}

function describeArguments(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null || v === '') continue;
    if (typeof v === 'object') continue; // skip nested objects
    // Make keys more readable: deviceModel -> "Device Model"
    const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
    parts.push(`<span class="text-slate-500">${label}:</span> <span>${v}</span>`);
  }
  return parts.join(' · ');
}

function renderMessages() {
  // Hide messages flagged as deleted
  const visible = state.messages.filter(m => !m.deleted);
  // Badge mit Anzahl der nicht-info-Messages
  const importantCount = visible.filter(m => severityFromMessage(m) !== 'info').length;
  const badge = $('#msg-badge');
  if (importantCount > 0) { badge.textContent = importantCount; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');

  if (!visible.length) {
    $('#tab-messages').innerHTML = `<p class="text-slate-500">${t('messages.none')}</p>`;
    return;
  }

  const sorted = [...visible].sort((a, b) => (b.timestamp||0) - (a.timestamp||0));
  const dateLocale = state.lang === 'en' ? 'en-GB' : 'de-DE';

  $('#tab-messages').innerHTML = `
    <ul class="bg-white rounded-lg border border-slate-200 divide-y">
      ${sorted.map(m => {
        const sev = severityFromMessage(m);
        const codeName = m.messageCode?.name || 'UNKNOWN';
        const title = messageTitle(codeName);
        let source = m.sourceName || (m.sourceId && deviceName(m.sourceId)) || m.sourceId || '';
        const location = m.location;
        source = location + " - " + source;
        const date = m.timestamp ? new Date(Number(m.timestamp)).toLocaleString(dateLocale) : '';
        const argsHtml = describeArguments(m.arguments);
        const sevClass = {
          error:   'bg-rose-100 text-rose-700',
          warning: 'bg-amber-100 text-amber-700',
          info:    'bg-slate-100 text-slate-600',
        }[sev];
        const sevLabel = t(`messages.sev.${sev}`);
        return `
          <li class="p-4 text-sm flex items-start gap-3">
            <span class="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${sevClass} mt-0.5">${sevLabel}</span>
            <div class="flex-1 min-w-0">
              <div class="font-medium">${title}</div>
              <div class="text-xs text-slate-500 mt-0.5">
                ${source ? `<span>${source}</span>` : ''}
                ${source && date ? ' · ' : ''}
                ${date ? `<span>${date}</span>` : ''}
              </div>
              ${argsHtml ? `<div class="text-xs mt-1.5">${argsHtml}</div>` : ''}
              <details class="mt-1.5 text-xs text-slate-400">
                <summary class="cursor-pointer hover:text-slate-600">${t('messages.technical')}</summary>
                <pre class="mt-1 bg-slate-50 p-2 rounded overflow-auto">${escapeHtml(JSON.stringify(m, null, 2))}</pre>
              </details>
            </div>
            <button data-dismiss="${m.id}" title="${t('messages.dismiss')}"
              class="text-slate-400 hover:text-rose-600 text-xl leading-none">×</button>
          </li>`;
      }).join('')}
    </ul>`;

  $$('#tab-messages [data-dismiss]').forEach(b =>
    b.addEventListener('click', async () => {
      try {
        await api(`/api/messages/${encodeURIComponent(b.dataset.dismiss)}`, { method: 'DELETE' });
        state.messages = state.messages.filter(x => x.id !== b.dataset.dismiss);
        renderMessages();
      } catch (err) { alert(t('error.generic', err.message)); }
    })
  );
}

const escapeHtml = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// =========================================================================
//  Tab: Admin
// =========================================================================
function renderAdmin() {
  const sw = state.info.softwareUpdateState || {};
  const swState = sw.swUpdateState || 'UNKNOWN';
  const updateInfo = swState === 'UPDATE_AVAILABLE'
    ? `<span class="text-amber-700">${t('admin.updateAvailable', sw.swUpdateAvailableVersion)}</span>`
    : `<span class="text-emerald-700">${t('admin.upToDate', sw.swInstalledVersion || '-')}</span>`;
  $('#tab-admin').innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">

      <!-- System -->
      <article class="card bg-white rounded-lg p-5 border border-slate-200">
        <h3 class="font-medium mb-3">${t('admin.controller')}</h3>
        <dl class="text-sm space-y-1.5">
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.ip')}</dt>             <dd class="tabular-nums">${state.info.shcIpAddress || '-'}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.mac')}</dt>            <dd class="tabular-nums">${state.info.macAddress.toLowerCase().replaceAll(":", "-") || '-'}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.api')}</dt>            <dd class="tabular-nums">${(state.info.apiVersions||[]).join(', ')}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.firmware')}</dt>       <dd class="tabular-nums">${sw.swInstalledVersion || '-'}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.updateStatus')}</dt>   <dd>${updateInfo}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.devices')}</dt>        <dd class="tabular-nums">${state.devices.length}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.rooms')}</dt>          <dd class="tabular-nums">${state.rooms.length}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.scenarios')}</dt>      <dd class="tabular-nums">${state.scenarios.length}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.automations')}</dt>    <dd class="tabular-nums">${state.automations.length}</dd></div>
        </dl>
      </article>

      <!-- Mobile devices / clients -->
      <article class="card bg-white rounded-lg p-5 border border-slate-200">
        <h3 class="font-medium mb-3">${t('admin.clients', state.clients.length)}</h3>
        <ul class="text-sm divide-y">
          ${state.clients.map(c => `
            <li class="flex items-center justify-between py-2">
              <div>
                <div>${c.name || c.id}</div>
                <div class="text-xs text-slate-500">${c.id}${c.primaryRole ? ' · ' + c.primaryRole : ''}</div>
              </div>
              <button data-client-del="${c.id}" data-client-name="${(c.name||c.id).replace(/"/g,'')}"
                class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded">${t('admin.remove')}</button>
            </li>`).join('') || `<li class="text-slate-500 py-2">${t('admin.noClients')}</li>`}
        </ul>
      </article>

      <!-- Rooms -->
      <article class="card bg-white rounded-lg p-5 border border-slate-200">
        <h3 class="font-medium mb-3">${t('admin.roomsHeader', state.rooms.length)}</h3>
        <ul class="text-sm divide-y">
          ${state.rooms.map(r => {
            const count = state.devices.filter(d => d.roomId === r.id).length;
            const countLabel = t(count === 1 ? 'admin.deviceCount' : 'admin.deviceCountP', count);
            return `<li class="flex items-center justify-between py-2">
              <div>
                <div>${r.name}</div>
                <div class="text-xs text-slate-500">${countLabel}</div>
              </div>
              <button data-room-rename="${r.id}" data-name="${r.name.replace(/"/g,'')}"
                class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('admin.rename')}</button>
            </li>`;
          }).join('')}
        </ul>
      </article>

      <!-- Manage devices -->
      <article class="card bg-white rounded-lg p-5 border border-slate-200">
        <h3 class="font-medium mb-3">
          ${t('admin.manageDevices', state.devices.filter(d=>d.roomId).length)}
          ${(() => {
            const n = state.devices.filter(d => d.roomId && deviceUpdateInfo(d).hasUpdate).length;
            return n > 0
              ? `<span class="text-xs ml-2 text-amber-700">${t(n === 1 ? 'admin.updatesAvail' : 'admin.updatesAvailP', n)}</span>`
              : '';
          })()}
        </h3>
        <div class="text-sm max-h-96 overflow-auto divide-y">
          ${state.devices.filter(d => d.roomId).map(d => {
            const u = deviceUpdateInfo(d);
            const fwLine = u.hasUpdate
              ? `<span class="text-amber-700">${t('admin.fwUpdate',
                    u.targetVersion ? t('admin.fwUpdateTo', u.targetVersion) : '',
                    u.currentVersion ? t('admin.fwUpdateCurrent', u.currentVersion) : '',
                    u.stateText ? ` - ${u.stateText}` : '')}</span>`
              : (u.currentVersion
                  ? `<span class="text-emerald-700">${t('admin.fwCurrent', u.currentVersion)}</span>`
                  : '');
            return `
            <div class="flex items-center justify-between py-2 gap-2">
              <div class="min-w-0">
                <div class="truncate">${d.name || d.id}</div>
                <div class="text-xs text-slate-500 truncate">
                  ${d.deviceModel || ''} · ${roomName(d.roomId)} · ${d.status||''}
                </div>
                ${fwLine ? `<div class="text-xs mt-0.5">${fwLine}</div>` : ''}
              </div>
              <div class="flex gap-1 shrink-0">
                <button data-device-inspect="${d.id}"
                  class="text-xs text-slate-600 hover:bg-slate-100 px-2 py-1 rounded" title="${t('admin.viewRaw')}">ⓘ</button>
                <button data-device-rename="${d.id}" data-name="${(d.name||'').replace(/"/g,'')}"
                  class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('admin.rename')}</button>
                <button data-device-del="${d.id}" data-name="${(d.name||d.id).replace(/"/g,'')}"
                  class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded">${t('admin.remove')}</button>
              </div>
            </div>`;
          }).join('')}
        </div>
      </article>

    </div>`;

  // Aktionen verdrahten
  $$('#tab-admin [data-client-del]').forEach(b => b.addEventListener('click', () =>
    confirmModal(t('modal.confirmRmClient', b.dataset.clientName), async () => {
      await api(`/api/clients/${encodeURIComponent(b.dataset.clientDel)}`, { method: 'DELETE' });
      await loadAll();
    })));

  $$('#tab-admin [data-room-rename]').forEach(b => b.addEventListener('click', () =>
    promptModal(t('modal.renameRoom'), b.dataset.name, async (newName) => {
      const room = state.rooms.find(r => r.id === b.dataset.roomRename);
      await api(`/api/rooms/${encodeURIComponent(b.dataset.roomRename)}`, {
        method: 'PUT',
        body: { '@type': 'room', id: room?.id, iconId: room?.iconId, name: newName },
      });
      await loadAll();
    })));

  $$('#tab-admin [data-device-rename]').forEach(b => b.addEventListener('click', () =>
    promptModal(t('modal.renameDevice'), b.dataset.name, async (newName) => {
      await api(`/api/devices/${encodeURIComponent(b.dataset.deviceRename)}`,
        { method: 'PUT', body: { '@type': 'device', name: newName } });
      await loadAll();
    })));

  $$('#tab-admin [data-device-del]').forEach(b => b.addEventListener('click', () =>
    confirmModal(t('modal.confirmRmDevice', b.dataset.name), async () => {
      await api(`/api/devices/${encodeURIComponent(b.dataset.deviceDel)}`, { method: 'DELETE' });
      await loadAll();
    })));

  $$('#tab-admin [data-device-inspect]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.deviceInspect;
    const device = state.devices.find(d => d.id === id);
    const services = state.services.filter(s => s.deviceId === id);
    const noState = t('modal.noState');
    const serviceList = services.map(s =>
      `${s.id}${s.state ? ' = ' + JSON.stringify(s.state) : ' ' + noState}`
    ).join('\n');
    showModal(`
      <h4 class="font-medium mb-2 truncate">${device?.name || id}</h4>
      <p class="text-xs text-slate-500 mb-3">${t('modal.inspectDesc')}</p>
      <div class="space-y-3 max-h-[60vh] overflow-auto">
        <div>
          <div class="text-xs uppercase tracking-wide text-slate-500 mb-1">${t('modal.deviceLabel')}</div>
          <pre class="text-xs bg-slate-50 p-2 rounded overflow-auto">${escapeHtml(JSON.stringify(device, null, 2))}</pre>
        </div>
        <div>
          <div class="text-xs uppercase tracking-wide text-slate-500 mb-1">${t('modal.servicesLabel', services.length)}</div>
          <pre class="text-xs bg-slate-50 p-2 rounded overflow-auto">${escapeHtml(serviceList || t('modal.noServices'))}</pre>
        </div>
      </div>
      <div class="mt-4 flex justify-end">
        <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.close')}</button>
      </div>`);
    $('#m-cancel').onclick = hideModal;
    // Make the modal a bit wider for the inspect view
    $('#modal-card').classList.remove('max-w-md');
    $('#modal-card').classList.add('max-w-2xl');
  }));

}

// =========================================================================
//  Modals
// =========================================================================
function showModal(html) {
  $('#modal-card').innerHTML = html;
  $('#modal-root').classList.remove('hidden');
}
function hideModal() {
  $('#modal-root').classList.add('hidden');
  // If we previously switched to a wider modal, reset to normal width
  $('#modal-card').classList.remove('max-w-2xl');
  $('#modal-card').classList.add('max-w-md');
}
$('#modal-root').addEventListener('click', (e) => {
  if (e.target.id === 'modal-root') hideModal();
});

function confirmModal(message, onConfirm) {
  showModal(`
    <p class="text-sm">${message}</p>
    <div class="mt-4 flex justify-end gap-2">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="m-ok" class="px-3 py-1.5 text-sm bg-rose-600 text-white rounded-md">${t('modal.confirm')}</button>
    </div>`);
  $('#m-cancel').onclick = hideModal;
  $('#m-ok').onclick = async () => {
    try { await onConfirm(); hideModal(); }
    catch (err) { alert(t('error.generic', err.message)); }
  };
}
function promptModal(title, defaultValue, onSave) {
  showModal(`
    <h4 class="font-medium mb-2">${title}</h4>
    <input id="m-input" class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
      value="${(defaultValue||'').replace(/"/g, '&quot;')}" />
    <div class="mt-4 flex justify-end gap-2">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="m-ok" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md">${t('modal.save')}</button>
    </div>`);
  const input = $('#m-input'); input.focus(); input.select();
  $('#m-cancel').onclick = hideModal;
  $('#m-ok').onclick = async () => {
    const v = input.value.trim();
    if (!v) return;
    try { await onSave(v); hideModal(); }
    catch (err) { alert(t('error.generic', err.message)); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#m-ok').click(); });
}

// =========================================================================
//  Tabs (using tabEl instead of t to not shadow the global t() function)
// =========================================================================
const ALL_TABS = ['devices','scenarios','security','messages','admin','users','sessions'];
$$('.tab').forEach(tabEl => tabEl.addEventListener('click', () => {
  $$('.tab').forEach(x => {
    x.classList.remove('border-blue-600', 'font-medium');
    x.classList.add('border-transparent', 'text-slate-500');
  });
  tabEl.classList.add('border-blue-600', 'font-medium');
  tabEl.classList.remove('text-slate-500');
  ALL_TABS.forEach(n =>
    $('#tab-' + n).classList.toggle('hidden', n !== tabEl.dataset.tab));
}));
$('#refresh').addEventListener('click', loadAll);
$$('#lang-switch [data-lang]').forEach(b =>
  b.addEventListener('click', () => setLang(b.dataset.lang))
);
$$('#theme-switch [data-theme-set]').forEach(b =>
  b.addEventListener('click', () => setTheme(b.dataset.themeSet))
);
$('#notify-toggle')?.addEventListener('click', toggleNotify);

// =========================================================================
//  Live events (SSE)
// =========================================================================
function connectEvents() {
  const ev = new EventSource('/api/events');
  ev.onopen  = () => $('#event-dot').className = 'inline-block w-2.5 h-2.5 rounded-full bg-emerald-500';
  ev.onerror = () => $('#event-dot').className = 'inline-block w-2.5 h-2.5 rounded-full bg-rose-500';
  ev.onmessage = (msg) => {
    let events; try { events = JSON.parse(msg.data); } catch { return; }
    let touchedDev = false, touchedMsg = false, touchedSec = false, touchedScn = false;
    for (const e of events) {
      if (e['@type'] === 'DeviceServiceData') {
        const idx = state.services.findIndex(s => s.id === e.id && s.deviceId === e.deviceId);
        if (idx >= 0) state.services[idx] = { ...state.services[idx], ...e };
        else state.services.push(e);
        touchedDev = true;
        // Update IDS state live
        if (e.deviceId === 'intrusionDetectionSystem' && e.id === 'IntrusionDetectionControl') {
          state.intrusion = e; touchedSec = true;
        }
      } else if (e['@type'] === 'message') {
        // existing update or brand new?
        const idx = state.messages.findIndex(m => m.id === e.id);
        if (idx >= 0) state.messages[idx] = e;
        else {
          state.messages.unshift(e);
          if (!e.deleted) notifyNewMessage(e);
        }
        touchedMsg = true;
      } else if (e['@type'] === 'userDefinedState') {
        const idx = state.userdefinedstates.findIndex(u => u.id === e.id);
        if (idx >= 0) state.userdefinedstates[idx] = e;
        touchedScn = true;
      }
    }
    if (touchedDev) renderDevices();
    if (touchedSec) renderSecurity();
    if (touchedMsg) renderMessages();
    if (touchedScn) renderScenarios();
  };
}

// =========================================================================
//  Auth – login overlay, account menu, role-based tab visibility
// =========================================================================
async function loadAuthStatus() {
  try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
    state.auth = await res.json();
  } catch (_) {
    state.auth = { enabled: false, authenticated: true, user: null };
  }
}

function applyRoleVisibility() {
  const admin = isAdmin();
  $$('.admin-only').forEach(el => el.classList.toggle('hidden', !admin));
  // Account button only makes sense when auth is on
  const acc = $('#account-btn');
  if (acc) acc.classList.toggle('hidden', !state.auth.enabled);
}

// Login overlay: two modes — 'login' (username + password) and 'change'
// (mustChangePassword flow: old password + new password + repeat). Both use
// the same compact form for simplicity.
function showLogin(mode = 'login') {
  const root = $('#login-root');
  const form = $('#login-form');
  const errEl = $('#login-error');
  errEl.classList.add('hidden'); errEl.textContent = '';

  if (mode === 'change') {
    $('#login-title').textContent = t('auth.changeTitle');
    $('#login-sub').textContent   = t('auth.changeSub');
    $('#login-user-label').textContent = t('auth.oldPassword');
    $('#login-pass-label').textContent = t('auth.newPassword');
    $('#login-user').type = 'password';
    $('#login-user').autocomplete = 'current-password';
    $('#login-pass').type = 'password';
    $('#login-pass').autocomplete = 'new-password';
    $('#login-submit').textContent = t('auth.changeBtn');
    form.dataset.mode = 'change';
  } else {
    $('#login-title').textContent = t('auth.loginTitle');
    $('#login-sub').textContent   = t('auth.loginSub');
    $('#login-user-label').textContent = t('auth.username');
    $('#login-pass-label').textContent = t('auth.password');
    $('#login-user').type = 'text';
    $('#login-user').autocomplete = 'username';
    $('#login-pass').type = 'password';
    $('#login-pass').autocomplete = 'current-password';
    $('#login-submit').textContent = t('auth.loginBtn');
    form.dataset.mode = 'login';
  }
  $('#login-user').value = '';
  $('#login-pass').value = '';
  $('#app-shell').classList.add('hidden');
  root.classList.remove('hidden');
  setTimeout(() => $('#login-user').focus(), 0);
}

function hideLogin() {
  $('#login-root').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
}

async function submitLogin(e) {
  e.preventDefault();
  const form = $('#login-form');
  const errEl = $('#login-error');
  errEl.classList.add('hidden'); errEl.textContent = '';
  try {
    if (form.dataset.mode === 'change') {
      const oldPassword = $('#login-user').value;
      const newPassword = $('#login-pass').value;
      if (!newPassword || newPassword.length < 4) {
        errEl.textContent = t('auth.passwordTooShort');
        errEl.classList.remove('hidden');
        return;
      }
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      if (!res.ok) {
        errEl.textContent = t('auth.changeFailed');
        errEl.classList.remove('hidden');
        return;
      }
      // Refresh status and start the app
      await loadAuthStatus();
      hideLogin();
      applyStaticTexts();
      applyRoleVisibility();
      await loadAll();
      connectEvents();
    } else {
      const username = $('#login-user').value.trim();
      const password = $('#login-pass').value;
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        errEl.textContent = t('auth.loginFailed');
        errEl.classList.remove('hidden');
        return;
      }
      const data = await res.json();
      state.auth = { enabled: true, authenticated: true, user: data.user };
      if (data.user?.mustChangePassword) {
        showLogin('change');
        return;
      }
      hideLogin();
      applyStaticTexts();
      applyRoleVisibility();
      await loadAll();
      connectEvents();
    }
  } catch (err) {
    errEl.textContent = t('error.generic', err.message);
    errEl.classList.remove('hidden');
  }
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) { /* ignore */ }
  // Hard reload – simplest way to drop SSE/state and re-enter the login flow.
  location.reload();
}

function openAccountMenu() {
  if (!state.auth.enabled) return;
  showModal(`
    <h4 class="font-medium mb-1">${escapeHtml(state.auth.user?.username || '')}</h4>
    <p class="text-xs text-slate-500 mb-4">${state.auth.user?.role === 'admin' ? t('auth.roleAdmin') : t('auth.roleUser')}</p>
    <div class="flex flex-col gap-2">
      <button id="acc-change" class="w-full px-3 py-2 text-sm border border-slate-300 rounded-md text-left hover:bg-slate-50">${t('auth.changePassword')}</button>
      <button id="acc-logout" class="w-full px-3 py-2 text-sm border border-rose-300 text-rose-700 rounded-md text-left hover:bg-rose-50">${t('auth.logout')}</button>
    </div>
    <div class="mt-4 flex justify-end">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.close')}</button>
    </div>`);
  $('#m-cancel').onclick = hideModal;
  $('#acc-logout').onclick = logout;
  $('#acc-change').onclick = () => {
    hideModal();
    openChangePasswordModal();
  };
}

function openChangePasswordModal() {
  showModal(`
    <h4 class="font-medium mb-3">${t('auth.changePassword')}</h4>
    <label class="text-xs text-slate-500 block mb-1">${t('auth.oldPassword')}</label>
    <input id="cp-old" type="password" autocomplete="current-password"
      class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm mb-2" />
    <label class="text-xs text-slate-500 block mb-1">${t('auth.newPassword')}</label>
    <input id="cp-new" type="password" autocomplete="new-password"
      class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm mb-2" />
    <label class="text-xs text-slate-500 block mb-1">${t('auth.repeatPassword')}</label>
    <input id="cp-rep" type="password" autocomplete="new-password"
      class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
    <p id="cp-err" class="hidden text-xs text-rose-600 mt-2"></p>
    <div class="mt-4 flex justify-end gap-2">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="m-ok" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md">${t('modal.save')}</button>
    </div>`);
  $('#m-cancel').onclick = hideModal;
  $('#m-ok').onclick = async () => {
    const o = $('#cp-old').value, n = $('#cp-new').value, r = $('#cp-rep').value;
    const err = $('#cp-err');
    err.classList.add('hidden');
    if (!o || !n) { err.textContent = t('auth.allFieldsRequired'); err.classList.remove('hidden'); return; }
    if (n.length < 4) { err.textContent = t('auth.passwordTooShort'); err.classList.remove('hidden'); return; }
    if (n !== r)   { err.textContent = t('auth.passwordsMismatch'); err.classList.remove('hidden'); return; }
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { oldPassword: o, newPassword: n } });
      hideModal();
      alert(t('auth.changeOk'));
    } catch (e) {
      err.textContent = e.message || t('auth.changeFailed');
      err.classList.remove('hidden');
    }
  };
}

// =========================================================================
//  Tab: Users (admin only)
// =========================================================================
async function loadUsers() {
  if (!isAdmin()) return;
  try { state.users = await api('/api/auth/users') || []; }
  catch (_) { state.users = []; }
  renderUsers();
}

function renderUsers() {
  if (!isAdmin()) return;
  const self = state.auth.user?.username;
  const rows = state.users.map(u => {
    const isSelf = u.username === self;
    const mustChange = u.mustChangePassword
      ? `<span class="ml-2 text-[10px] uppercase tracking-wide text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">${t('users.mustChange')}</span>` : '';
    return `<li class="flex items-center justify-between py-2 gap-2">
      <div class="min-w-0">
        <div class="truncate">${escapeHtml(u.username)} ${mustChange}</div>
        <div class="text-xs text-slate-500">${u.role === 'admin' ? t('auth.roleAdmin') : t('auth.roleUser')}${isSelf ? ' · ' + t('users.you') : ''}</div>
      </div>
      <div class="flex gap-1 shrink-0">
        <button data-user-reset="${escapeHtml(u.username)}"
          class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('users.resetPassword')}</button>
        <button data-user-del="${escapeHtml(u.username)}"
          class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded ${isSelf ? 'opacity-30 pointer-events-none' : ''}"
          ${isSelf ? 'disabled' : ''}>${t('admin.remove')}</button>
      </div>
    </li>`;
  }).join('') || `<li class="text-slate-500 py-2">${t('users.none')}</li>`;

  $('#tab-users').innerHTML = `
    <article class="card bg-white rounded-lg p-5 border border-slate-200 mb-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-medium">${t('users.header', state.users.length)}</h3>
        <button id="user-new"
          class="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700">${t('users.create')}</button>
      </div>
      <ul class="text-sm divide-y">${rows}</ul>
    </article>`;

  $('#user-new').onclick = openCreateUserModal;
  $$('#tab-users [data-user-del]').forEach(b => b.addEventListener('click', () =>
    confirmModal(t('users.confirmDelete', b.dataset.userDel), async () => {
      await api(`/api/auth/users/${encodeURIComponent(b.dataset.userDel)}`, { method: 'DELETE' });
      await loadUsers();
      await loadSessions();
    })));
  $$('#tab-users [data-user-reset]').forEach(b => b.addEventListener('click', () =>
    openResetPasswordModal(b.dataset.userReset)));
}

function openCreateUserModal() {
  showModal(`
    <h4 class="font-medium mb-3">${t('users.create')}</h4>
    <label class="text-xs text-slate-500 block mb-1">${t('auth.username')}</label>
    <input id="nu-name" type="text" autocomplete="off"
      class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm mb-2" />
    <label class="text-xs text-slate-500 block mb-1">${t('users.startPassword')}</label>
    <input id="nu-pass" type="text" autocomplete="off"
      class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm mb-2" />
    <label class="flex items-center gap-2 text-sm text-slate-600 mt-2">
      <input id="nu-admin" type="checkbox" /> ${t('users.makeAdmin')}
    </label>
    <p class="text-xs text-slate-500 mt-2">${t('users.startPasswordHint')}</p>
    <p id="nu-err" class="hidden text-xs text-rose-600 mt-2"></p>
    <div class="mt-4 flex justify-end gap-2">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="m-ok" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md">${t('users.create')}</button>
    </div>`);
  $('#nu-name').focus();
  $('#m-cancel').onclick = hideModal;
  $('#m-ok').onclick = async () => {
    const name = $('#nu-name').value.trim();
    const pass = $('#nu-pass').value;
    const role = $('#nu-admin').checked ? 'admin' : 'user';
    const err = $('#nu-err'); err.classList.add('hidden');
    if (!name) { err.textContent = t('auth.allFieldsRequired'); err.classList.remove('hidden'); return; }
    if (pass.length < 4) { err.textContent = t('auth.passwordTooShort'); err.classList.remove('hidden'); return; }
    try {
      await api('/api/auth/users', { method: 'POST', body: { username: name, password: pass, role } });
      hideModal();
      await loadUsers();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  };
}

function openResetPasswordModal(username) {
  showModal(`
    <h4 class="font-medium mb-1">${t('users.resetPassword')}</h4>
    <p class="text-xs text-slate-500 mb-3">${escapeHtml(username)}</p>
    <label class="text-xs text-slate-500 block mb-1">${t('users.newStartPassword')}</label>
    <input id="rp-pass" type="text" autocomplete="off"
      class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
    <p class="text-xs text-slate-500 mt-2">${t('users.resetHint')}</p>
    <p id="rp-err" class="hidden text-xs text-rose-600 mt-2"></p>
    <div class="mt-4 flex justify-end gap-2">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="m-ok" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md">${t('modal.save')}</button>
    </div>`);
  $('#rp-pass').focus();
  $('#m-cancel').onclick = hideModal;
  $('#m-ok').onclick = async () => {
    const pass = $('#rp-pass').value;
    const err = $('#rp-err'); err.classList.add('hidden');
    if (pass.length < 4) { err.textContent = t('auth.passwordTooShort'); err.classList.remove('hidden'); return; }
    try {
      await api(`/api/auth/users/${encodeURIComponent(username)}/reset-password`,
        { method: 'POST', body: { password: pass } });
      hideModal();
      await loadUsers();
      await loadSessions();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  };
}

// =========================================================================
//  Tab: Sessions (admin only)
// =========================================================================
async function loadSessions() {
  if (!isAdmin()) return;
  try { state.sessions = await api('/api/auth/sessions') || []; }
  catch (_) { state.sessions = []; }
  renderSessions();
}

function renderSessions() {
  if (!isAdmin()) return;
  const dateLocale = state.lang === 'en' ? 'en-GB' : 'de-DE';
  const rows = state.sessions
    .slice()
    .sort((a, b) => (b.lastSeenAt||0) - (a.lastSeenAt||0))
    .map(s => {
      const created = s.createdAt ? new Date(s.createdAt).toLocaleString(dateLocale) : '';
      const seen    = s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString(dateLocale) : '';
      const ua      = s.userAgent ? escapeHtml(s.userAgent.slice(0, 100)) : '';
      const currentBadge = s.current
        ? `<span class="ml-2 text-[10px] uppercase tracking-wide text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">${t('sessions.current')}</span>` : '';
      return `<li class="py-2 flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="truncate">${escapeHtml(s.username)} ${currentBadge}</div>
          <div class="text-xs text-slate-500 truncate">
            ${t('sessions.created', created)} · ${t('sessions.lastSeen', seen)}
          </div>
          ${ua ? `<div class="text-[11px] text-slate-400 truncate">${ua}</div>` : ''}
          <div class="text-[11px] text-slate-400">${escapeHtml(s.token)}${s.ip ? ' · ' + escapeHtml(s.ip) : ''}</div>
        </div>
        <button data-session-del="${escapeHtml(s.tokenId)}"
          class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded shrink-0">${t('sessions.invalidate')}</button>
      </li>`;
    }).join('') || `<li class="text-slate-500 py-2">${t('sessions.none')}</li>`;

  $('#tab-sessions').innerHTML = `
    <article class="card bg-white rounded-lg p-5 border border-slate-200">
      <h3 class="font-medium mb-3">${t('sessions.header', state.sessions.length)}</h3>
      <ul class="text-sm divide-y">${rows}</ul>
    </article>`;

  $$('#tab-sessions [data-session-del]').forEach(b => b.addEventListener('click', () =>
    confirmModal(t('sessions.confirmInvalidate'), async () => {
      await api(`/api/auth/sessions/${encodeURIComponent(b.dataset.sessionDel)}`, { method: 'DELETE' });
      await loadSessions();
    })));
}

// Tab clicks for the admin-only tabs trigger lazy loads of their data.
$('[data-tab="users"]').addEventListener('click', loadUsers);
$('[data-tab="sessions"]').addEventListener('click', loadSessions);
$('#account-btn')?.addEventListener('click', openAccountMenu);
$('#login-form').addEventListener('submit', submitLogin);

// =========================================================================
//  Boot
// =========================================================================
(async () => {
  try {
    await loadI18N();
    await loadAuthStatus();
    applyStaticTexts();

    if (state.auth.enabled && !state.auth.authenticated) {
      showLogin('login');
      return;
    }
    if (state.auth.user?.mustChangePassword) {
      showLogin('change');
      return;
    }

    hideLogin();
    applyRoleVisibility();
    await loadAll();
    connectEvents();
  } catch (err) {
    document.body.insertAdjacentHTML('afterbegin',
      `<div class="bg-rose-100 text-rose-800 p-3 text-sm">${t('error.loading', err.message)}</div>`);
  }
})();
