import { state, $, $$, t, api, escapeHtml, roomName, deviceName, serviceOf, deviceUpdateInfo, saveCollapsedRooms } from './core.js';
import { severityFromMessage, messageTitle } from './messages.js';
import { showModal, hideModal } from './modals.js';

// Service ids that the per-device settings dialog (⚙) can configure.
const CONFIG_SVC_IDS = ['Thermostat', 'ChildProtection', 'TemperatureOffset', 'PowerSwitchConfiguration', 'VibrationSensor', 'Bypass', 'KeypadTrigger'];
// Radiator thermostats (TRV) vs. room thermostats (RT). When a TRV shares a
// room with an RT, the RT drives the temperature, so the TRV's own offset is
// meaningless and must not be offered.
const TRV_MODELS = ['TRV', 'TRV_GEN2'];
const ROOM_THERMOSTAT_MODELS = ['THB', 'RTH', 'RTH2', 'RTH2_BAT', 'RT2'];
// True if the device exposes at least one configurable service with state.
// `Thermostat` only counts as child-lock; `KeypadTrigger` needs scenarios to map.
function hasSettings(services) {
  return CONFIG_SVC_IDS.some(id => {
    const s = services.find(x => x.id === id);
    if (!s?.state) return false;
    if (id === 'Thermostat') return s.state['@type'] === 'childLockState';
    if (id === 'ChildProtection') return s.state.childLockActive != null;
    if (id === 'KeypadTrigger') return s.state.switchType === 'ScenarioTrigger' && state.scenarios.length > 0;
    return true;
  });
}

// =========================================================================
//  Tab: Devices
// =========================================================================
// Fixed sort order for device types within a room.
// Lower number = higher up. Unknown models end up at the bottom.
const DEVICE_TYPE_ORDER = [
  ['ROOM_CLIMATE_CONTROL'],                                         // virtual room climate control
  ['THB', 'RTH', 'RTH2', 'RTH2_BAT', 'RT2'],                        // room thermostat
  ['TRV', 'TRV_GEN2'],                                              // radiator thermostat
  ['BOILER', 'HEATING_CIRCUIT'],                                    // central heating control
  ['SWD', 'SWD2'],                                                  // door/window contact
  ['BBL', 'BBL_2', 'MICROMODULE_SHUTTER', 'SHUTTER_CONTROL'],       // shutter
  ['BSM', 'MICROMODULE_LIGHT_CONTROL', 'LIGHT_CONTROL_2',
   'HUE_LIGHT', 'HUE_LIGHT_ROOM_CONTROL',
   'LEDVANCE_LIGHT', 'SMART_BULB'],                                 // light
  ['PSM', 'PLUG', 'PLUG_COMPACT', 'PLUG_COMPACT_DUAL'],             // smart plug
  ['MICROMODULE_RELAY'],                                            // relay (impulse)
  ['SD', 'SMOKE_DETECTOR', 'SMOKE_DETECTOR_2', 'TWINGUARD'],        // smoke detector
  ['MD', 'MOTION_DETECTOR'],                                        // motion detector
  ['WLS', 'WATER_LEAKAGE_SENSOR'],                                  // water leakage sensor
  ['UNIVERSAL_SWITCH', 'UNIVERSAL_SWITCH_2', 'WRC2', 'MULTISWITCH'],// universal switch / twist
  ['HOMECONNECT_WASHER'],                                           // home connect appliances
  ['HUE_BRIDGE'],                                                   // bridges
];
const DEVICE_MODEL_RANK = (() => {
  const m = new Map();
  DEVICE_TYPE_ORDER.forEach((group, i) => group.forEach(model => m.set(model, i)));
  return m;
})();

// Categories used by the type quick-filter dropdown. Each entry groups one or
// more deviceModel values under a single human-readable label + icon. Models
// are matched exactly; prefixes match `${prefix}` or `${prefix}_…` (catches
// e.g. CAMERA_360, TRV_GEN2_FOO).
const DEVICE_CATEGORIES = [
  { id: 'thermostat', icon: 'home-thermometer', models: ['THB','RTH','RTH2','RTH2_BAT','RT2','TRV','TRV_GEN2','ROOM_CLIMATE_CONTROL'], prefixes: ['TRV'] },
  { id: 'boiler',     icon: 'water-boiler',     models: ['BOILER', 'HEATING_CIRCUIT'] },
  { id: 'contact',    icon: 'window-closed',    models: ['SWD','SWD2'], prefixes: ['SWD', 'SWD2'] },
  { id: 'shutter',    icon: 'window-shutter',   models: ['BBL','BBL_2','MICROMODULE_SHUTTER','SHUTTER_CONTROL'] },
  { id: 'light',      icon: 'lightbulb-on',     models: ['BSM','MICROMODULE_LIGHT_CONTROL','LIGHT_CONTROL_2','HUE_LIGHT','HUE_LIGHT_ROOM_CONTROL','LEDVANCE_LIGHT','SMART_BULB'] },
  { id: 'plug',       icon: 'power-plug',       models: ['PSM','PLUG','PLUG_COMPACT','PLUG_COMPACT_DUAL'] },
  { id: 'relay',      icon: 'electric-switch',  models: ['MICROMODULE_RELAY'] },
  { id: 'smoke',      icon: 'smoke-detector',   models: ['SD','SMOKE_DETECTOR','SMOKE_DETECTOR_2','TWINGUARD'] },
  { id: 'motion',     icon: 'motion-sensor',    models: ['MD','MOTION_DETECTOR'] },
  { id: 'water',      icon: 'water-alert',      models: ['WLS','WATER_LEAKAGE_SENSOR', 'WATER_DETECTOR'] },
  { id: 'switch',     icon: 'light-switch-off', models: ['UNIVERSAL_SWITCH','UNIVERSAL_SWITCH_2','WRC2','MULTISWITCH'] },
  { id: 'washer',     icon: 'washing-machine',  models: ['HOMECONNECT_WASHER'] },
  { id: 'camera',     icon: 'cctv',             models: ['EYES_OUTDOOR'], prefixes: ['CAMERA'] },
  { id: 'bridge',     icon: 'router-network',   models: ['HUE_BRIDGE'] },
];
function deviceCategory(device) {
  const m = (device.deviceModel || '').toUpperCase();
  for (const cat of DEVICE_CATEGORIES) {
    if (cat.models.includes(m)) return cat.id;
    if (cat.prefixes?.some(p => m === p || m.startsWith(p + '_'))) return cat.id;
  }
  return null;
}

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
      <div id="device-toolbar" class="mb-3 sticky top-[88px] bg-slate-100/90 backdrop-blur py-2 z-[5] flex flex-col sm:flex-row sm:items-center gap-2">
        <input id="device-filter" type="search" placeholder="${t('devices.filter')}"
          class="w-full sm:flex-1 border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white" />
        <div class="flex items-center gap-2 flex-wrap sm:flex-nowrap sm:shrink-0">
          <details id="type-filter-dd" class="dropdown relative shrink-0">
            <summary id="type-filter-summary"
              title="${t('devices.typeFilterTitle')}"
              class="inline-flex items-center gap-1 px-2 py-1.5 text-sm border border-slate-300 rounded-md bg-white hover:bg-slate-50">
              <span>${t('devices.typeFilter')}</span>
              <span id="type-filter-badge" class="hidden text-[10px] bg-blue-600 text-white px-1.5 rounded-full leading-4"></span>
              <span class="text-slate-400 leading-none">▾</span>
            </summary>
            <div id="type-filter-panel"
              class="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-md shadow-lg p-1 z-20 min-w-[200px] max-h-[70vh] overflow-auto"></div>
          </details>
          <button id="filter-available"   data-status="AVAILABLE"
            title="${t('devices.onlyAvailable')}"
            class="status-filter shrink-0 inline-flex items-center justify-center px-2 py-1.5 border border-slate-300 rounded-md bg-white hover:bg-slate-50">
            <img src="svg/wifi-strength-4.svg" alt="" style="width:16px;height:16px" />
          </button>
          <button id="filter-unavailable" data-status="UNAVAILABLE"
            title="${t('devices.onlyUnavailable')}"
            class="status-filter shrink-0 inline-flex items-center justify-center px-2 py-1.5 border border-slate-300 rounded-md bg-white hover:bg-slate-50">
            <img src="svg/wifi-off.svg" alt="" style="width:16px;height:16px" />
          </button>
          <button id="expand-all"   title="${t('devices.expandAll')}"
            class="shrink-0 px-2 py-1.5 text-sm border border-slate-300 rounded-md bg-white hover:bg-slate-50">⇕</button>
          <button id="collapse-all" title="${t('devices.collapseAll')}"
            class="shrink-0 px-2 py-1.5 text-sm border border-slate-300 rounded-md bg-white hover:bg-slate-50">⇔</button>
        </div>
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
    const typeDd = $('#type-filter-dd');
    typeDd.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type=checkbox][data-cat]');
      if (!cb) return;
      if (cb.checked) state.typeFilter.add(cb.dataset.cat);
      else            state.typeFilter.delete(cb.dataset.cat);
      updateTypeFilterBadge();
      renderDeviceList();
    });
    typeDd.addEventListener('click', (e) => {
      if (e.target.closest('#type-filter-clear')) {
        state.typeFilter.clear();
        renderTypeFilterOptions();
        renderDeviceList();
      }
    });
    document.addEventListener('click', (e) => {
      if (typeDd.open && !typeDd.contains(e.target)) typeDd.open = false;
    });
    $('#expand-all').addEventListener('click', () => {
      state.collapsedRooms.clear();
      saveCollapsedRooms();
      renderDeviceList();
    });
    $('#collapse-all').addEventListener('click', () => {
      const allRooms = new Set(state.devices.filter(d => d.roomId).map(d => d.roomId));
      state.collapsedRooms = allRooms;
      saveCollapsedRooms();
      renderDeviceList();
    });
  }
  updateStatusFilterButtons();
  renderTypeFilterOptions();
  renderDeviceList();
}

// Populates the type filter dropdown panel. Only categories that actually
// have at least one device in the current state are shown — empty categories
// would just be noise. Also drops stale selections (e.g. a category whose
// last device was just removed).
function renderTypeFilterOptions() {
  const panel = $('#type-filter-panel');
  if (!panel) return;
  const present = new Set(state.devices.map(deviceCategory).filter(Boolean));
  for (const id of [...state.typeFilter]) {
    if (!present.has(id)) state.typeFilter.delete(id);
  }
  const cats = DEVICE_CATEGORIES.filter(c => present.has(c.id));
  const clearBtn = state.typeFilter.size ? `
    <button id="type-filter-clear" type="button"
      class="w-full text-left text-xs text-slate-500 hover:text-slate-800 px-2 py-1">
      ${t('devices.typeFilterClear')}
    </button>
    <div class="border-t border-slate-200 my-1"></div>` : '';
  panel.innerHTML = clearBtn + (cats.length ? cats.map(c => `
    <label class="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-100 cursor-pointer text-sm">
      <input type="checkbox" data-cat="${c.id}" ${state.typeFilter.has(c.id) ? 'checked' : ''}
        class="accent-blue-600" />
      <img src="svg/${c.icon}.svg" alt="" style="width:16px;height:16px" />
      <span>${t('devices.type.' + c.id)}</span>
    </label>`).join('')
    : `<p class="text-xs text-slate-500 px-2 py-1">${t('devices.none')}</p>`);
  updateTypeFilterBadge();
}

function updateTypeFilterBadge() {
  const badge = $('#type-filter-badge');
  if (!badge) return;
  const n = state.typeFilter.size;
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
  const summary = $('#type-filter-summary');
  if (summary) {
    summary.classList.toggle('border-blue-600', n > 0);
    summary.classList.toggle('text-blue-600',   n > 0);
  }
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
  const matchesType = (d) =>
    state.typeFilter.size === 0 || state.typeFilter.has(deviceCategory(d));

  const visible = state.devices.filter(d =>
    d.roomId && d.status !== 'DISCOVERED' && matchesText(d) && matchesStatus(d) && matchesType(d)
  );
  // Discovered devices: not yet configured, no roomId, not affected by status/type filter
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
      const filtering = !!filter || !!state.statusFilter || state.typeFilter.size > 0;
      const open = filtering ? true : !state.collapsedRooms.has(rId);
      return `
      <details class="room mb-4" data-room="${rId}" ${open ? 'open' : ''}>
        <summary class="flex flex-col sm:flex-row items-start sm:items-end justify-between gap-y-1.5 sm:gap-x-3 mb-2 px-1">
          <h2 class="text-sm uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
            <span class="chev text-slate-400">▸</span>
            ${roomName(rId)}
            <span class="normal-case text-[11px] text-slate-400">(${devs.length})</span>
            ${renderRoomMessageBadge(rId)}
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
  // Live value readout while dragging the slider.
  $$('#device-list [data-temp-set]').forEach(el => el.addEventListener('input', e => {
    const out = e.currentTarget.closest('[data-setpoint]')?.querySelector('[data-temp-out]');
    if (out) out.textContent = e.currentTarget.value + '°';
  }));
  // Step the setpoint by 0.5 °C and trigger the write. Shared by the −/+ buttons
  // and the mouse-wheel handler. Dispatches `change` so the existing debounced
  // PUT path (onTemperatureChange) handles clamp, write and re-render.
  const stepSetpoint = (slider, dir) => {
    const next = Math.min(30, Math.max(5, parseFloat(slider.value) + dir * 0.5));
    slider.value = next;
    const out = slider.closest('[data-setpoint]')?.querySelector('[data-temp-out]');
    if (out) out.textContent = next + '°';
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  };
  $$('#device-list [data-temp-step]').forEach(el => el.addEventListener('click', e => {
    const slider = e.currentTarget.closest('[data-setpoint]')?.querySelector('[data-temp-set]');
    if (slider) stepSetpoint(slider, Number(e.currentTarget.dataset.tempStep));
  }));
  // Mouse wheel over any slider nudges it by one step (up = increase). Non-passive
  // so the page doesn't scroll while the cursor is over the control. Reuses each
  // slider's existing change handler (setpoint / dimmer / shutter) for the write.
  $$('#device-list input[type="range"]').forEach(el => el.addEventListener('wheel', e => {
    e.preventDefault();
    const r = e.currentTarget;
    const step = parseFloat(r.step) || 1;
    const min = parseFloat(r.min), max = parseFloat(r.max);
    const dir = e.deltaY < 0 ? 1 : -1;
    r.value = Math.min(max, Math.max(min, parseFloat(r.value) + dir * step));
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  }, { passive: false }));
  // Sliders/buttons sitting in a room <summary> must not toggle the room when used.
  $$('#device-list [data-room-setpoint]').forEach(el =>
    el.addEventListener('click', e => e.preventDefault()));
  $$('#device-list [data-heat-set]').forEach(el => el.addEventListener('change', onHeatingSetpointChange));
  // Live readout while dragging the heating-circuit slider.
  $$('#device-list [data-heat-set]').forEach(el => el.addEventListener('input', e => {
    const out = e.currentTarget.closest('[data-setpoint]')?.querySelector('[data-temp-out]');
    if (out) out.textContent = e.currentTarget.value + '°';
  }));
  $$('#device-list [data-shutter-level]').forEach(el => el.addEventListener('change', onShutterLevelChange));
  $$('#device-list [data-dimmer-level]').forEach(el => el.addEventListener('change', onDimmerLevelChange));
  $$('#device-list [data-color-set]').forEach(el => el.addEventListener('change', onColorChange));
  // Remember the open/closed state on user interaction (not while filtering)
  $$('#device-list details.room').forEach(el => el.addEventListener('toggle', () => {
    if (state.deviceFilter.trim() || state.statusFilter || state.typeFilter.size) return;
    if (el.open) state.collapsedRooms.delete(el.dataset.room);
    else        state.collapsedRooms.add(el.dataset.room);
    saveCollapsedRooms();
  }));
}

// Which room does a message belong to? `sourceId` is resolved by what it
// actually matches, not by the (unreliable) `sourceType` field — observed
// values include a device id while sourceType says SERVICE, and a room id
// while sourceType says SERVICE too. `sourceName` is the device/source name,
// never a room. Returns null for sources not tied to a room (e.g. controller).
function messageRoomId(m) {
  if (!m.sourceId) return null;
  const dev = state.devices.find(d => d.id === m.sourceId);
  if (dev?.roomId) return dev.roomId;                    // device → its room
  if (state.rooms.some(r => r.id === m.sourceId)) return m.sourceId; // already a room id
  return null;
}

function activeMessagesForRoom(roomId) {
  return state.messages.filter(m => !m.deleted && messageRoomId(m) === roomId);
}

// Marker shown in the room header when the room has active messages — count +
// a bell, tinted by the most severe message (error > warning > info). Stays
// visible while the room is collapsed, so problems are visible at a glance.
function renderRoomMessageBadge(roomId) {
  const msgs = activeMessagesForRoom(roomId);
  if (!msgs.length) return '';
  const sev = msgs.some(m => severityFromMessage(m) === 'error')   ? 'error'
            : msgs.some(m => severityFromMessage(m) === 'warning') ? 'warning'
            : 'info';
  const cls = {
    error:   'bg-rose-100 text-rose-700',
    warning: 'bg-amber-100 text-amber-700',
    info:    'bg-slate-100 text-slate-600',
  }[sev];
  const titles = msgs.map(m => messageTitle(m.messageCode?.name || 'UNKNOWN')).join(', ');
  return `<span class="normal-case inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${cls}"
      title="${escapeHtml(titles)}">
      <span class="icon-mask" style="width:11px;height:11px;mask-image:url(svg/bell.svg);-webkit-mask-image:url(svg/bell.svg)"></span>${msgs.length}
    </span>`;
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
  // Window/door contacts in the room — summarised as "all closed" vs "n open".
  const contactSvcs = state.services.filter(
    s => s.id === 'ShutterContact' && roomDeviceIds.includes(s.deviceId)
  );
  // Switched-on devices in the room (plugs + lights expose PowerSwitch).
  const onCount = state.services.filter(
    s => s.id === 'PowerSwitch' && roomDeviceIds.includes(s.deviceId)
         && s.state?.switchState === 'ON'
  ).length;

  const tVal = tempSvc?.state?.temperature;
  const hVal = humSvc?.state?.humidity;
  if (tVal == null && hVal == null && contactSvcs.length === 0 && onCount === 0) return '';

  const parts = [];
  if (tVal != null) parts.push(`<span class="tabular-nums">${tVal.toFixed(1)}°C</span>`);
  if (hVal != null) parts.push(`<span class="tabular-nums">${Math.round(hVal)}% rH</span>`);
  if (onCount) {
    const label = t('devices.devicesOn', onCount);
    parts.push(
      `<span class="flex items-center gap-1 text-amber-600 font-medium" title="${escapeHtml(label)}">` +
      `<span class="icon-mask" style="width:14px;height:14px;mask-image:url(svg/power.svg);-webkit-mask-image:url(svg/power.svg)" aria-hidden="true"></span>${label}</span>`
    );
  }
  if (contactSvcs.length) {
    const openCount = contactSvcs.filter(s => s.state?.value === 'OPEN').length;
    const closed = openCount === 0;
    const icon  = closed ? 'window-closed' : 'window-open';
    const label = closed ? t('devices.windowsClosed') : t('devices.windowsOpen', openCount);
    const cls   = closed ? 'text-slate-600' : 'text-amber-600 font-medium';
    parts.push(
      `<span class="flex items-center gap-1 ${cls}" title="${escapeHtml(label)}">` +
      `<img src="svg/${icon}.svg" style="width:14px;height:14px" aria-hidden="true" />${label}</span>`
    );
  }
  // Mobile: wrap parts onto multiple lines and drop the dot separators so they
  // don't crowd. Desktop (sm+) keeps the original single-line · separated look.
  const sep = '<span class="hidden sm:inline" aria-hidden="true">·</span>';
  const info = `<div class="text-xs text-slate-600 flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1 sm:gap-2">${parts.join(sep)}</div>`;

  // Setpoint slider in the summary so the target can be changed without
  // expanding the room. data-room-setpoint marks it so clicks don't toggle
  // the <details>.
  const climateSvc = rccDevice && serviceOf(rccDevice.id, 'RoomClimateControl');
  const slider = climateSvc
    ? `<div class="mt-1 w-full sm:w-56" data-room-setpoint>${renderSetpointControl(rccDevice.id, climateSvc.state?.setpointTemperature, { compact: true })}</div>`
    : '';

  return `<div class="flex flex-col gap-1 w-full sm:w-auto sm:items-end">${info}${slider}</div>`;
}

// Temperature setpoint slider for RoomClimateControl. Shared by the device card
// and the collapsed-room climate badge so the target can be set without
// expanding the room. The change PUT is wired via [data-temp-set]
// (onTemperatureChange); an `input` listener updates [data-temp-out] live.
function renderSetpointControl(deviceId, setpoint, { compact = false } = {}) {
  const val = typeof setpoint === 'number' ? setpoint : 5;
  const btn = (dir, glyph) =>
    `<button type="button" data-temp-step="${dir}" data-device="${deviceId}"
       class="shrink-0 w-7 h-7 flex items-center justify-center rounded-md border border-slate-300
              text-slate-600 hover:bg-slate-100 active:bg-slate-200 text-lg leading-none">${glyph}</button>`;
  return `
    <div class="flex items-center gap-1.5 w-full" data-setpoint>
      ${btn(-1, '−')}
      <input type="range" min="5" max="30" step="0.5" value="${val}"
        data-temp-set data-device="${deviceId}"
        class="flex-1 min-w-0 accent-sky-600 cursor-pointer" />
      ${btn(1, '+')}
      <span class="tabular-nums text-sm font-medium w-12 text-right" data-temp-out>${val}°</span>
    </div>`;
}

// HeatingCircuit control: AUTOMATIC/MANUAL mode toggle + target slider. The
// circuit has no own temperature sensor (per the model registry), so we only
// expose the setpoint. Writes go to the HeatingCircuit service
// (onHeatingSetpointChange / the `heat-mode` device action).
function renderHeatingCircuit(deviceId, st) {
  const manual = st.operationMode === 'MANUAL';
  const val = typeof st.setpointTemperature === 'number' ? st.setpointTemperature : 5;
  const modeBtn = (mode, active, label) =>
    `<button data-action="heat-mode" data-device="${deviceId}" data-mode="${mode}"
       class="flex-1 px-2 py-1 rounded-md text-xs font-medium
       ${active ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">${label}</button>`;
  return `
    <div class="mt-2">
      <div class="flex items-center gap-1.5">
        ${modeBtn('AUTOMATIC', !manual, t('devices.heatAuto'))}
        ${modeBtn('MANUAL', manual, t('devices.heatManual'))}
      </div>
      <div class="flex items-center gap-1.5 w-full mt-2" data-setpoint>
        <input type="range" min="5" max="30" step="0.5" value="${val}"
          data-heat-set data-device="${deviceId}"
          class="flex-1 min-w-0 accent-orange-500 cursor-pointer" />
        <span class="tabular-nums text-sm font-medium w-12 text-right" data-temp-out>${val}°</span>
      </div>
    </div>`;
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
  if (m === 'THB' || m === 'RTH' || m === 'RTH2' || m === 'RTH2_BAT' || m === 'RT2'
      || m === 'ROOM_CLIMATE_CONTROL') return 'home-thermometer';
  // Central heating control (virtual)
  if (m === 'BOILER') return 'water-boiler';
  // Heating circuit (central heating valve circuit)
  if (m === 'HEATING_CIRCUIT') return 'radiator';
  // Home Connect washing machine
  if (m === 'HOMECONNECT_WASHER') return 'washing-machine';
  // Hue room light virtual device
  if (m === 'HUE_LIGHT_ROOM_CONTROL') return 'lightbulb-multiple';
  // Micromodule relay (impulse mode)
  if (m === 'MICROMODULE_RELAY') return 'electric-switch';
  // Twist rotary remote
  if (m === 'MULTISWITCH') return 'knob';
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
  if (has('HeatingCircuit')) return 'radiator';
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

// Air-quality / climate rating (GOOD | MEDIUM | BAD) → text colour.
function ratingColor(rating) {
  return { GOOD: 'text-emerald-600', MEDIUM: 'text-amber-600', BAD: 'text-rose-600' }[rating]
    || 'text-slate-500';
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
  const shutterCtl = services.find(s => s.id === 'ShutterControl');
  const binary   = services.find(s => s.id === 'BinarySwitch');   // generic on/off (Hue, micromodule light/switch)
  const dimmer   = services.find(s => s.id === 'MultiLevelSwitch'); // brightness 0–100
  const color    = services.find(s => s.id === 'HSBColorActuator'); // rgb colour
  const impulse  = services.find(s => s.id === 'ImpulseSwitch');  // momentary relay trigger
  const valve    = services.find(s => s.id === 'ValveTappet');
  const energy   = services.find(s => s.id === 'PowerMeter');
  const silentMode = services.find(s => s.id === 'SilentMode');
  const airQuality = services.find(s => s.id === 'AirQualityLevel'); // Twinguard
  const illuminanceSvc = services.find(s => s.id === 'MultiLevelSensor'); // motion detector
  const heatingCircuit = services.find(s => s.id === 'HeatingCircuit');
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
  // BinarySwitch: generic on/off used by Hue lights and micromodule light/switch
  // actuators (these have no PowerSwitch). Skip if a PowerSwitch already drew a
  // toggle to avoid two on/off buttons on the same card.
  if (binary && !power) {
    const on = binary.state?.on === true;
    body += `
      <button data-action="toggle-binary" data-device="${device.id}" data-on="${on}"
        class="w-full mt-2 px-3 py-2 rounded-md font-medium text-sm
        ${on ? 'bg-amber-100 text-amber-900 hover:bg-amber-200'
             : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}">
        ${t(on ? 'devices.turnOff' : 'devices.turnOn')}
      </button>`;
  }
  // MultiLevelSwitch: dimmable brightness 0–100 %.
  if (dimmer?.state) {
    const lvl = Math.round(dimmer.state.level ?? 0);
    body += `
      <div class="mt-2">
        <div class="flex items-baseline justify-between">
          <span class="text-sm text-slate-600">${t('devices.brightness')}</span>
          <span class="text-xs text-slate-500 tabular-nums">${lvl}%</span>
        </div>
        <input type="range" min="0" max="100" step="1" value="${lvl}"
          data-dimmer-level data-device="${device.id}"
          class="w-full mt-1 accent-amber-500" />
      </div>`;
  }
  // HSBColorActuator: rgb is a signed 32-bit ARGB int; mask low 24 bits for the
  // colour input, re-add full alpha when writing back.
  if (color?.state && typeof color.state.rgb === 'number') {
    const hex = '#' + (color.state.rgb & 0xFFFFFF).toString(16).padStart(6, '0');
    body += `
      <div class="mt-2 flex items-center gap-2">
        <span class="text-sm text-slate-600">${t('devices.color')}</span>
        <input type="color" value="${hex}"
          data-color-set data-device="${device.id}"
          class="h-7 w-10 rounded border border-slate-300 cursor-pointer bg-white" />
      </div>`;
  }
  // ImpulseSwitch: momentary relay (e.g. garage door). Single trigger button.
  if (impulse) {
    body += `
      <button data-action="impulse" data-device="${device.id}"
        class="w-full mt-2 px-3 py-2 rounded-md font-medium text-sm
        bg-slate-100 text-slate-700 hover:bg-slate-200">
        ${t('devices.trigger')}
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
    const current = temp.state?.temperature?.toFixed?.(1) ?? '-';
    body += `
      <div class="mt-2">
        <div class="flex items-baseline gap-2">
          <span class="text-2xl font-light tabular-nums">${current}°</span>
          <span class="text-xs text-slate-500">${t('devices.current')}</span>
        </div>
        <div class="mt-1.5">${renderSetpointControl(device.id, climate.state?.setpointTemperature)}</div>
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
  // Motorised shutter / blinds (ShutterControl). level is 0.0=closed .. 1.0=open.
  if (shutterCtl?.state) {
    const level = shutterCtl.state.level ?? 0;
    const pct = Math.round(level * 100);
    const op = shutterCtl.state.operationState; // STOPPED | OPENING | CLOSING
    const opTxt = op === 'OPENING' ? t('devices.shutterOpening')
                : op === 'CLOSING' ? t('devices.shutterClosing') : '';
    body += `
      <div class="mt-2">
        <div class="flex items-baseline gap-2">
          <span class="text-sm text-slate-600">${t('devices.shutterPosition', pct)}</span>
          ${opTxt ? `<span class="text-xs text-sky-700 inline-flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse"></span>${opTxt}</span>` : ''}
        </div>
        <input type="range" min="0" max="100" step="1" value="${pct}"
          data-shutter-level data-device="${device.id}"
          class="w-full mt-1 accent-sky-600" />
        <div class="mt-1 grid grid-cols-3 gap-1">
          <button data-action="shutter-set" data-device="${device.id}" data-level="1"
            class="px-2 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200">
            ${t('devices.shutterOpen')}</button>
          <button data-action="shutter-stop" data-device="${device.id}"
            class="px-2 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200">
            ${t('devices.shutterStop')}</button>
          <button data-action="shutter-set" data-device="${device.id}" data-level="0"
            class="px-2 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200">
            ${t('devices.shutterClose')}</button>
        </div>
      </div>`;
  }
  if (energy?.state) {
    body += `<div class="mt-2 text-xs text-slate-500">
      ${energy.state.powerConsumption ?? 0} W · ${(energy.state.energyConsumption/1000).toFixed(2)} kWh
    </div>`;
  }
  // HeatingCircuit (central heating valve circuit): mode toggle + setpoint slider.
  // AUTOMATIC follows the schedule; MANUAL holds the chosen target.
  if (heatingCircuit?.state) body += renderHeatingCircuit(device.id, heatingCircuit.state);
  // AirQualityLevel (Twinguard): purity in ppm, coloured by the combined rating.
  if (airQuality?.state?.purity != null) {
    const r = airQuality.state.combinedRating;
    body += `
      <div class="mt-2 flex items-center gap-2 text-sm">
        <span class="text-slate-600">${t('devices.airQuality')}</span>
        <span class="tabular-nums font-medium ${ratingColor(r)}">${airQuality.state.purity} ppm</span>
        ${r ? `<span class="text-xs ${ratingColor(r)}">${t('rating.' + r)}</span>` : ''}
      </div>`;
  }
  // MultiLevelSensor illuminance (motion detector): Gen2 reports a lux integer,
  // Gen1 a LOW|MEDIUM|HIGH string — show whichever the device sends.
  if (illuminanceSvc?.state?.illuminance != null) {
    const lx = illuminanceSvc.state.illuminance;
    const txt = typeof lx === 'number' ? `${Math.round(lx)} lx` : t('illuminance.' + lx, lx);
    body += `
      <div class="mt-2 flex items-center gap-1.5 text-sm text-slate-600">
        <img src="svg/lightbulb-on.svg" style="width:16px;height:16px" alt="" />
        <span>${t('devices.illuminance')}</span>
        <span class="tabular-nums font-medium">${txt}</span>
      </div>`;
  }
  if (silentMode) {
    const silent = silentMode.state?.mode === 'MODE_SILENT';
    body += `
      <button data-action="toggle-silent" data-device="${device.id}" data-on="${silent}"
        title="${t('devices.silentTitle')}"
        class="mt-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
        ${silent ? 'bg-indigo-100 text-indigo-800 hover:bg-indigo-200'
                 : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">
        ${t(silent ? 'devices.silentOn' : 'devices.silentOff')}
      </button>`;
  }
  const meta = [];
  // Battery status. The real SHC only reports a *problem* — a low/critical
  // battery surfaces as an entry in the device's `faults`; a healthy battery
  // sends no level at all. So we treat the presence of a BatteryLevel service
  // as "this device is battery-powered" and show OK unless a fault says
  // otherwise. The demo (and some devices like the Outdoor Siren) instead
  // expose BatteryLevel.state.warningLevel, which we honour as a fallback.
  // Possible levels: OK, LOW_BATTERY, CRITICAL_LOW, CRITICAL_LOW_BATTERY,
  // INSERT_BATTERY, NOT_AVAILABLE.
  const faultEntries = Array.isArray(device.faults)
    ? device.faults : (device.faults?.entries || []);
  const batteryFault = faultEntries.find(f =>
    f.type === 'LOW_BATTERY' || f.type === 'CRITICAL_LOW_BATTERY');
  const batteryLevel =
    batteryFault              ? batteryFault.type :
    battery?.state?.warningLevel ? battery.state.warningLevel :
    battery                   ? 'OK' : null;
  if (batteryLevel && batteryLevel !== 'NOT_AVAILABLE') {
    const map = {
      OK:                    { icon: 'battery-high', cls: 'text-emerald-700', label: t('battery.ok') },
      LOW_BATTERY:           { icon: 'battery-medium', cls: 'text-amber-700',   label: t('battery.low') },
      CRITICAL_LOW:          { icon: 'battery-low', cls: 'text-rose-700',    label: t('battery.critical') },
      CRITICAL_LOW_BATTERY:  { icon: 'battery-low', cls: 'text-rose-700',    label: t('battery.critical') },
      INSERT_BATTERY:        { icon: 'battery-off-outline',  cls: 'text-rose-700',    label: t('battery.insert') },
    };
    const b = map[batteryLevel] || { icon: 'battery-high', cls: 'text-slate-600', label: batteryLevel };
    meta.push(`<span class="${b.cls} inline-flex items-center gap-1"><img src="svg/${b.icon}.svg" style="width:16px;height:16px" alt="" /> ${b.label}</span>`);
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
          ${hasSettings(services) ? `<button data-action="settings" data-device="${device.id}"
            title="${t('settings.title')}" aria-label="${t('settings.title')}"
            class="text-slate-400 hover:text-slate-700 leading-none p-0.5">
            <img src="svg/cog.svg" style="width:18px;height:18px" alt="" /></button>` : ''}
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
  if (action === 'settings') {
    openDeviceSettings(device);
    return;
  }
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
  } else if (action === 'toggle-silent') {
    const newMode = btn.dataset.on === 'true' ? 'MODE_NORMAL' : 'MODE_SILENT';
    btn.classList.add('pulse');
    try {
      await api(`/api/devices/${encodeURIComponent(device)}/services/SilentMode/state`, {
        method: 'PUT',
        body: { '@type': 'silentModeState', mode: newMode },
      });
      const svc = serviceOf(device, 'SilentMode');
      if (svc) svc.state = { ...(svc.state || {}), '@type': 'silentModeState', mode: newMode };
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
  } else if (action === 'shutter-set') {
    const level = parseFloat(btn.dataset.level); // 1=open, 0=closed
    btn.classList.add('pulse');
    try {
      await api(`/api/devices/${encodeURIComponent(device)}/services/ShutterControl/state`, {
        method: 'PUT',
        body: { '@type': 'shutterControlState', level },
      });
      const svc = serviceOf(device, 'ShutterControl');
      if (svc) svc.state = { ...(svc.state || {}), '@type': 'shutterControlState', level };
      renderDevices();
    } catch (err) { alert(t('error.generic', err.message)); }
  } else if (action === 'toggle-binary') {
    const on = !(btn.dataset.on === 'true');
    btn.classList.add('pulse');
    try {
      await api(`/api/devices/${encodeURIComponent(device)}/services/BinarySwitch/state`, {
        method: 'PUT',
        body: { '@type': 'binarySwitchState', on },
      });
      const svc = serviceOf(device, 'BinarySwitch');
      if (svc) svc.state = { ...(svc.state || {}), '@type': 'binarySwitchState', on };
      renderDevices();
    } catch (err) { alert(t('error.generic', err.message)); }
  } else if (action === 'impulse') {
    btn.classList.add('pulse');
    try {
      await api(`/api/devices/${encodeURIComponent(device)}/services/ImpulseSwitch/state`, {
        method: 'PUT',
        body: {
          '@type': 'impulseSwitchState',
          impulseState: true,
          instantOfLastImpulse: new Date().toISOString(),
          impulseLength: serviceOf(device, 'ImpulseSwitch')?.state?.impulseLength ?? 6,
        },
      });
    } catch (err) { alert(t('error.generic', err.message)); }
  } else if (action === 'shutter-stop') {
    // No documented stop endpoint; the SHC accepts a partial PUT setting
    // operationState=STOPPED (same as the Bosch app / boschshcpy).
    btn.classList.add('pulse');
    try {
      await api(`/api/devices/${encodeURIComponent(device)}/services/ShutterControl/state`, {
        method: 'PUT',
        body: { '@type': 'shutterControlState', operationState: 'STOPPED' },
      });
      const svc = serviceOf(device, 'ShutterControl');
      if (svc) svc.state = { ...(svc.state || {}), operationState: 'STOPPED' };
      renderDevices();
    } catch (err) { alert(t('error.generic', err.message)); }
  } else if (action === 'heat-mode') {
    const mode = btn.dataset.mode; // AUTOMATIC | MANUAL
    btn.classList.add('pulse');
    try {
      await api(`/api/devices/${encodeURIComponent(device)}/services/HeatingCircuit/state`, {
        method: 'PUT',
        body: { '@type': 'heatingCircuitState', operationMode: mode },
      });
      const svc = serviceOf(device, 'HeatingCircuit');
      if (svc) svc.state = { ...(svc.state || {}), '@type': 'heatingCircuitState', operationMode: mode };
      renderDevices();
    } catch (err) { alert(t('error.generic', err.message)); }
  }
}

// Per-device settings dialog (⚙). Builds a form from whichever configurable
// services the device exposes and writes each change straight to the SHC via
// `PUT /services/{svc}/state` (mostly undocumented — see [[project_shc_undocumented_crud]]).
function openDeviceSettings(deviceId) {
  const device = state.devices.find(d => d.id === deviceId);
  if (!device) return;
  const svc = id => serviceOf(deviceId, id);

  const row = (label, control) => `
    <label class="flex items-center justify-between gap-3 py-2 border-b border-slate-100 last:border-0">
      <span class="text-sm text-slate-700">${label}</span>
      <span class="shrink-0">${control}</span>
    </label>`;
  const checkbox = (set, on) =>
    `<input type="checkbox" data-set="${set}" ${on ? 'checked' : ''} class="w-4 h-4 accent-blue-600 cursor-pointer">`;
  const select = (set, options) =>
    `<select data-set="${set}" class="border border-slate-300 rounded-md px-2 py-1 text-sm">${options}</select>`;

  const sections = [];

  const thermo = svc('Thermostat');
  if (thermo?.state?.['@type'] === 'childLockState') {
    sections.push(row(t('settings.childLock'), checkbox('childLock', thermo.state.childLock === 'ON')));
  }

  // ChildProtection (childLockActive bool) — micromodule dimmer/relay/shutter, BSM.
  // Distinct from the thermostat's own childLock (ThermostatService).
  const childProt = svc('ChildProtection');
  if (childProt?.state?.childLockActive != null) {
    sections.push(row(t('settings.childLock'), checkbox('childProtection', childProt.state.childLockActive === true)));
  }

  const off = svc('TemperatureOffset');
  const model = (device.deviceModel || '').toUpperCase();
  const trvUnderRoomThermostat = TRV_MODELS.includes(model)
    && state.devices.some(d => d.roomId === device.roomId
        && ROOM_THERMOSTAT_MODELS.includes((d.deviceModel || '').toUpperCase()));
  if (off?.state && !trvUnderRoomThermostat) {
    const { offset = 0, minOffset = -3.5, maxOffset = 3.5, stepSize = 0.1 } = off.state;
    sections.push(row(t('settings.tempOffset'),
      `<input type="number" data-set="tempOffset" value="${offset}" min="${minOffset}" max="${maxOffset}"
         step="${stepSize}" class="w-20 text-right border border-slate-300 rounded-md px-2 py-1 text-sm tabular-nums"> °C`));
  }

  const psc = svc('PowerSwitchConfiguration');
  if (psc?.state) {
    const opts = (psc.state.supportedStatesAfterPowerOutage || ['LAST_STATE', 'ON', 'OFF'])
      .map(v => `<option value="${v}"${v === psc.state.stateAfterPowerOutage ? ' selected' : ''}>${t('settings.powerOutage.' + v)}</option>`).join('');
    sections.push(row(t('settings.powerOutage'), select('powerOutage', opts)));
  }

  const vib = svc('VibrationSensor');
  if (vib?.state) {
    sections.push(row(t('settings.vibEnabled'), checkbox('vibEnabled', vib.state.enabled === true)));
    const opts = ['HIGH', 'MEDIUM', 'LOW']
      .map(v => `<option value="${v}"${v === vib.state.sensitivity ? ' selected' : ''}>${t('settings.sensitivity.' + v)}</option>`).join('');
    sections.push(row(t('settings.vibSensitivity'), select('vibSensitivity', opts)));
  }

  const byp = svc('Bypass');
  if (byp?.state) {
    const cfg = byp.state.configuration || {};
    sections.push(row(t('settings.bypassEnabled'), checkbox('bypassEnabled', cfg.enabled === true)));
    sections.push(row(t('settings.bypassTimeout'),
      `<input type="number" data-set="bypassTimeout" value="${cfg.timeout ?? 5}" min="0"
         class="w-20 text-right border border-slate-300 rounded-md px-2 py-1 text-sm tabular-nums"> s`));
  }

  // WRC2 universal switch: map each button press to a scenario. keyCode is
  // inverted vs. position — keyCode 2 = top button (Bosch app "Button 1"),
  // keyCode 1 = bottom; list top first. Writing scenarioIdAssociations is
  // undocumented but accepted (see [[project_keypadtrigger_writable]]).
  const keypad = svc('KeypadTrigger');
  if (keypad?.state?.switchType === 'ScenarioTrigger' && state.scenarios.length) {
    const assoc = keypad.state.scenarioIdAssociations || {};
    const opts = selId =>
      `<option value="">${t('devices.keypadNone')}</option>` +
      state.scenarios.map(s => `<option value="${s.id}"${s.id === selId ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    const rows = [
      ['2_SHORT', 'devices.keypadBtnTopShort'],
      ['2_LONG',  'devices.keypadBtnTopLong'],
      ['1_SHORT', 'devices.keypadBtnBottomShort'],
      ['1_LONG',  'devices.keypadBtnBottomLong'],
    ];
    sections.push(`
      <div class="py-2 border-b border-slate-100 last:border-0">
        <div class="text-sm text-slate-700 mb-1">${t('devices.keypadAssign')}</div>
        ${rows.map(([key, lbl]) => `
          <label class="flex items-center gap-2 mt-1">
            <span class="w-28 shrink-0 text-xs text-slate-500">${t(lbl)}</span>
            <select data-keypad-trigger data-device="${deviceId}" data-key="${key}"
              class="flex-1 min-w-0 border border-slate-300 rounded-md px-2 py-1 text-xs">${opts(assoc[key])}</select>
          </label>`).join('')}
      </div>`);
  }

  if (!sections.length) return;

  showModal(`
    <h4 class="font-medium mb-1 truncate">${t('settings.title')}</h4>
    <p class="text-xs text-slate-500 mb-2 truncate">${escapeHtml(device.name || device.id)}</p>
    <div>${sections.join('')}</div>
    <div class="mt-4 flex justify-end">
      <button id="m-close" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.close')}</button>
    </div>`);
  $('#m-close').onclick = hideModal;

  // Write a state change and mirror it locally so the card reflects it on close.
  const put = async (svcId, body, el) => {
    try {
      await api(`/api/devices/${encodeURIComponent(deviceId)}/services/${svcId}/state`, { method: 'PUT', body });
      const s = serviceOf(deviceId, svcId);
      if (s) s.state = { ...(s.state || {}), ...body };
      renderDevices();
    } catch (err) {
      alert(t('error.generic', err.message));
      if (el) openDeviceSettings(deviceId); // re-open with the true state on failure
    }
  };

  const card = $('#modal-card');
  card.querySelector('[data-set="childLock"]')?.addEventListener('change', e =>
    put('Thermostat', { '@type': 'childLockState', childLock: e.target.checked ? 'ON' : 'OFF' }, e.target));
  card.querySelector('[data-set="childProtection"]')?.addEventListener('change', e =>
    put('ChildProtection', { '@type': 'childProtectionState', childLockActive: e.target.checked }, e.target));
  card.querySelector('[data-set="tempOffset"]')?.addEventListener('change', e =>
    put('TemperatureOffset', { '@type': 'temperatureOffsetState', offset: parseFloat(e.target.value) }, e.target));
  card.querySelector('[data-set="powerOutage"]')?.addEventListener('change', e =>
    put('PowerSwitchConfiguration', { '@type': 'powerSwitchConfigurationState', stateAfterPowerOutage: e.target.value }, e.target));
  const putVib = () => put('VibrationSensor', {
    '@type': 'vibrationSensorState',
    enabled: card.querySelector('[data-set="vibEnabled"]').checked,
    sensitivity: card.querySelector('[data-set="vibSensitivity"]').value,
  });
  card.querySelector('[data-set="vibEnabled"]')?.addEventListener('change', putVib);
  card.querySelector('[data-set="vibSensitivity"]')?.addEventListener('change', putVib);
  const putBypass = () => put('Bypass', {
    '@type': 'bypassState',
    configuration: {
      ...(svc('Bypass')?.state?.configuration || {}),
      enabled: card.querySelector('[data-set="bypassEnabled"]').checked,
      timeout: parseInt(card.querySelector('[data-set="bypassTimeout"]').value, 10),
    },
  });
  card.querySelector('[data-set="bypassEnabled"]')?.addEventListener('change', putBypass);
  card.querySelector('[data-set="bypassTimeout"]')?.addEventListener('change', putBypass);
  card.querySelectorAll('[data-keypad-trigger]').forEach(el => el.addEventListener('change', onKeypadScenarioChange));
}

// Debounce setpoint PUTs per device: clicking the number-input arrows fires a
// `change` event each step, which would flood the SHC with one request per
// click. Wait until the user has settled on a value (~700 ms) and send only the
// latest. Keyed by device id so two thermostats don't cancel each other.
const tempDebounce = new Map();

function onTemperatureChange(e) {
  const deviceId = e.currentTarget.dataset.device;
  // Radiator thermostats accept 5–30 °C; clamp so a typed out-of-range value
  // (number inputs don't enforce min/max on manual entry) isn't sent to the SHC.
  const value = Math.min(30, Math.max(5, parseFloat(e.currentTarget.value)));
  e.currentTarget.value = value;
  clearTimeout(tempDebounce.get(deviceId));
  tempDebounce.set(deviceId, setTimeout(async () => {
    tempDebounce.delete(deviceId);
    try {
      await api(`/api/devices/${encodeURIComponent(deviceId)}/services/RoomClimateControl/state`, {
        method: 'PUT',
        body: { '@type': 'climateControlState', setpointTemperature: value },
      });
      // Mirror locally and re-render so both the card and the room badge slider
      // reflect the new target. The demo SHC emits no long-poll events, so
      // without this the other control stays stale until a manual refresh.
      const s = serviceOf(deviceId, 'RoomClimateControl');
      if (s) s.state = { ...(s.state || {}), setpointTemperature: value };
      renderDevices();
    } catch (err) { alert('Fehler: ' + err.message); }
  }, 1000));
}

// Debounce HeatingCircuit setpoint PUTs per device (slider drag / wheel).
const heatDebounce = new Map();

function onHeatingSetpointChange(e) {
  const deviceId = e.currentTarget.dataset.device;
  const value = Math.min(30, Math.max(5, parseFloat(e.currentTarget.value)));
  e.currentTarget.value = value;
  clearTimeout(heatDebounce.get(deviceId));
  heatDebounce.set(deviceId, setTimeout(async () => {
    heatDebounce.delete(deviceId);
    try {
      await api(`/api/devices/${encodeURIComponent(deviceId)}/services/HeatingCircuit/state`, {
        method: 'PUT',
        body: { '@type': 'heatingCircuitState', setpointTemperature: value },
      });
      const s = serviceOf(deviceId, 'HeatingCircuit');
      if (s) s.state = { ...(s.state || {}), '@type': 'heatingCircuitState', setpointTemperature: value };
      renderDevices();
    } catch (err) { alert(t('error.generic', err.message)); }
  }, 1000));
}

// Debounce shutter level PUTs per device: dragging the slider fires many
// `change` events. Wait until settled (~700 ms) and send only the latest level.
const shutterDebounce = new Map();

function onShutterLevelChange(e) {
  const deviceId = e.currentTarget.dataset.device;
  const level = parseInt(e.currentTarget.value, 10) / 100; // 0.0=closed .. 1.0=open
  clearTimeout(shutterDebounce.get(deviceId));
  shutterDebounce.set(deviceId, setTimeout(async () => {
    shutterDebounce.delete(deviceId);
    try {
      await api(`/api/devices/${encodeURIComponent(deviceId)}/services/ShutterControl/state`, {
        method: 'PUT',
        body: { '@type': 'shutterControlState', level },
      });
      const svc = serviceOf(deviceId, 'ShutterControl');
      if (svc) svc.state = { ...(svc.state || {}), '@type': 'shutterControlState', level };
    } catch (err) { alert(t('error.generic', err.message)); }
  }, 700));
}

// Debounce dimmer (MultiLevelSwitch) PUTs per device while the slider is dragged.
const dimmerDebounce = new Map();

function onDimmerLevelChange(e) {
  const deviceId = e.currentTarget.dataset.device;
  const level = parseInt(e.currentTarget.value, 10); // 0–100
  clearTimeout(dimmerDebounce.get(deviceId));
  dimmerDebounce.set(deviceId, setTimeout(async () => {
    dimmerDebounce.delete(deviceId);
    try {
      await api(`/api/devices/${encodeURIComponent(deviceId)}/services/MultiLevelSwitch/state`, {
        method: 'PUT',
        body: { '@type': 'multiLevelSwitchState', level },
      });
      const svc = serviceOf(deviceId, 'MultiLevelSwitch');
      if (svc) svc.state = { ...(svc.state || {}), '@type': 'multiLevelSwitchState', level };
    } catch (err) { alert(t('error.generic', err.message)); }
  }, 700));
}

// KeypadTrigger (WRC2): assign/clear the scenario bound to one button event.
// Sends the full state back with a merged scenarioIdAssociations map; an empty
// selection removes that button's mapping. PUT is undocumented (see [[project_shc_undocumented_crud]]).
async function onKeypadScenarioChange(e) {
  const el = e.currentTarget;
  const deviceId = el.dataset.device;
  const key = el.dataset.key;
  const value = el.value; // '' = no scenario
  const svc = serviceOf(deviceId, 'KeypadTrigger');
  if (!svc) return;
  const assoc = { ...(svc.state?.scenarioIdAssociations || {}) };
  if (value) assoc[key] = value; else delete assoc[key];
  const newState = { ...(svc.state || {}), '@type': 'keypadTriggerState', scenarioIdAssociations: assoc };
  try {
    await api(`/api/devices/${encodeURIComponent(deviceId)}/services/KeypadTrigger/state`, {
      method: 'PUT',
      body: newState,
    });
    svc.state = newState;
  } catch (err) { alert(t('error.generic', err.message)); }
}

// HSBColorActuator: convert the colour-input hex to Bosch's signed 32-bit ARGB
// int (full alpha) before writing. The `|` operator already yields a signed int.
function onColorChange(e) {
  const deviceId = e.currentTarget.dataset.device;
  const hex = e.currentTarget.value.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const rgb = (0xff << 24) | (r << 16) | (g << 8) | b; // signed 32-bit
  (async () => {
    try {
      await api(`/api/devices/${encodeURIComponent(deviceId)}/services/HSBColorActuator/state`, {
        method: 'PUT',
        body: { '@type': 'colorState', rgb },
      });
      const svc = serviceOf(deviceId, 'HSBColorActuator');
      if (svc) svc.state = { ...(svc.state || {}), '@type': 'colorState', rgb };
    } catch (err) { alert(t('error.generic', err.message)); }
  })();
}


export { DEVICE_CATEGORIES, deviceCategory, deviceSortRank, renderDevices, renderTypeFilterOptions, updateTypeFilterBadge, updateStatusFilterButtons, renderDeviceList, messageRoomId, activeMessagesForRoom, renderRoomMessageBadge, renderRoomClimateBadge, deviceIcon, commQualityInfo, safeRenderDeviceCard, renderDeviceCard, onDeviceAction, onTemperatureChange, onHeatingSetpointChange, onShutterLevelChange, onDimmerLevelChange, onColorChange, onKeypadScenarioChange };
