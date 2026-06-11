import { state, $, $$, t, api, escapeHtml, loadAll, roomName, deviceName } from './core.js';
import { showModal, hideModal, confirmModal, promptModal } from './modals.js';
import { autoFieldInput, autoFieldDefault, PROFILE_OPTS, intrusionProfileLabel, openAutomationEditor } from './automations.js';

// =========================================================================
//  Scenario editor (guided create/edit form)
// =========================================================================
// Scenario actions have a different shape than automation actions:
// { deviceId, deviceServiceId, targetState: { '@type', … } }. Only the
// verified intrusion action is editable; anything else is kept verbatim (the
// local API also returns empty actions for shutter/climate scenarios, so those
// simply aren't represented here). `match` identifies an existing action,
// `parse` reads it into field values, `build` reassembles it.
function boolLabel(o) { return t(o === 'true' ? 'sceForm.on' : 'sceForm.off'); }
const SCENARIO_ACTION_TYPES = {
  intrusion: {
    match: (a) => a.deviceServiceId === 'IntrusionDetectionControl',
    fields: [
      { key: 'value', kind: 'select', options: ['SYSTEM_ARMED', 'SYSTEM_DISARMED'], default: 'SYSTEM_ARMED', rerenderOnChange: true },
      { key: 'profile', kind: 'select', options: PROFILE_OPTS, optLabel: intrusionProfileLabel, default: '0',
        showIf: (v) => v.value === 'SYSTEM_ARMED' },
    ],
    parse: (a) => ({ value: a.targetState?.value || 'SYSTEM_ARMED', profile: a.targetState?.activeProfile ?? '0' }),
    build: (v) => ({
      deviceId: 'intrusionDetectionSystem',
      deviceServiceId: 'IntrusionDetectionControl',
      targetState: { '@type': 'intrusionDetectionControlState', value: v.value,
        activeProfile: v.value === 'SYSTEM_ARMED' ? v.profile : '0' },
    }),
  },
  power: {
    match: (a) => a.deviceServiceId === 'PowerSwitch',
    fields: [
      { key: 'deviceId', kind: 'device', services: ['PowerSwitch'] },
      { key: 'switchState', kind: 'select', options: ['ON', 'OFF'], default: 'ON' },
    ],
    parse: (a) => ({ deviceId: a.deviceId, switchState: a.targetState?.switchState || 'ON' }),
    build: (v) => ({ deviceId: v.deviceId, deviceServiceId: 'PowerSwitch',
      targetState: { '@type': 'powerSwitchState', switchState: v.switchState } }),
  },
  climate: {
    match: (a) => a.deviceServiceId === 'RoomClimateControl',
    fields: [
      { key: 'deviceId', kind: 'device', idPrefix: 'roomClimateControl_',
        itemLabel: (d) => roomName(d.roomId || (d.id || '').replace('roomClimateControl_', '')) },
      { key: 'roomControlMode',     kind: 'select', options: ['HEATING', 'OFF'], default: 'HEATING' },
      { key: 'operationMode',       kind: 'select', options: ['MANUAL', 'AUTOMATIC'], default: 'MANUAL' },
      { key: 'setpointTemperature', kind: 'number', default: 20, min: 5 },
      { key: 'boostMode',           kind: 'select', options: ['true', 'false'], default: 'false', optLabel: boolLabel },
    ],
    parse: (a) => { const s = a.targetState || {}; return {
      deviceId: a.deviceId, roomControlMode: s.roomControlMode || 'HEATING',
      operationMode: s.operationMode || 'MANUAL', setpointTemperature: s.setpointTemperature ?? 20,
      boostMode: String(!!s.boostMode) }; },
    build: (v) => ({ deviceId: v.deviceId, deviceServiceId: 'RoomClimateControl',
      targetState: { '@type': 'climateControlState', operationMode: v.operationMode,
        setpointTemperature: Number(v.setpointTemperature) || 0, boostMode: v.boostMode === 'true',
        roomControlMode: v.roomControlMode, setPointTemperatureOffset: 0,
        isSetPointTemperatureOffsetActive: false, setPointTemperatureOffsetActiveValue: 0 } }),
  },
  camera_privacy: {
    match: (a) => a.deviceServiceId === 'PrivacyMode',
    fields: [
      { key: 'deviceId', kind: 'device', services: ['PrivacyMode', 'CameraNotification'] },
      { key: 'value', kind: 'select', options: ['ENABLED', 'DISABLED'], default: 'ENABLED' },
    ],
    parse: (a) => ({ deviceId: a.deviceId, value: a.targetState?.value || 'ENABLED' }),
    build: (v) => ({ deviceId: v.deviceId, deviceServiceId: 'PrivacyMode',
      targetState: { '@type': 'privacyModeState', value: v.value } }),
  },
  camera_notification: {
    match: (a) => a.deviceServiceId === 'CameraNotification',
    fields: [
      { key: 'deviceId', kind: 'device', services: ['PrivacyMode', 'CameraNotification'] },
      { key: 'value', kind: 'select', options: ['ENABLED', 'DISABLED'], default: 'ENABLED' },
    ],
    parse: (a) => ({ deviceId: a.deviceId, value: a.targetState?.value || 'ENABLED' }),
    build: (v) => ({ deviceId: v.deviceId, deviceServiceId: 'CameraNotification',
      targetState: { '@type': 'cameraNotificationState', value: v.value } }),
  },
  presence: {
    match: (a) => a.deviceServiceId === 'PresenceSimulationConfiguration',
    fields: [{ key: 'enabled', kind: 'select', options: ['true', 'false'], default: 'true', optLabel: boolLabel }],
    parse: (a) => ({ enabled: String(!!a.targetState?.enabled) }),
    build: (v) => ({ deviceId: 'presenceSimulationService', deviceServiceId: 'PresenceSimulationConfiguration',
      targetState: { '@type': 'presenceSimulationConfigurationState', enabled: v.enabled === 'true' } }),
  },
  // Momentary relay (e.g. Haustüröffner). The Bosch app always fires impulseState:true;
  // the SHC self-resets after the relay's configured pulse length.
  impulse: {
    match: (a) => a.deviceServiceId === 'ImpulseSwitch',
    fields: [{ key: 'deviceId', kind: 'device', services: ['ImpulseSwitch'] }],
    parse: (a) => ({ deviceId: a.deviceId }),
    build: (v) => ({ deviceId: v.deviceId, deviceServiceId: 'ImpulseSwitch',
      targetState: { '@type': 'ImpulseSwitchState', impulseState: true } }),
  },
};
// The SHC's scenario icon set, each mapped to a matching MDI svg in public/svg/
// (no Bosch icon assets ship). Order mirrors the Bosch app's icon grid.
const SCENARIO_ICONS = [
  { id: 'icon_scenario_own_scenario',         icon: 'auto-fix' },
  { id: 'icon_scenario_switch',               icon: 'power' },
  { id: 'icon_scenario_coming_home',          icon: 'home-import-outline' },
  { id: 'icon_scenario_leaving_home',         icon: 'home-export-outline' },
  { id: 'icon_scenario_go_to_vacation',       icon: 'airplane-takeoff' },
  { id: 'icon_scenario_return_from_vacation', icon: 'airplane-landing' },
  { id: 'icon_scenario_good_night',           icon: 'weather-night' },
  { id: 'icon_scenario_good_morning',         icon: 'weather-sunset-up' },
  { id: 'icon_scenario_relax',                icon: 'spa' },
  { id: 'icon_scenario_shutter_up',           icon: 'window-shutter-open' },
  { id: 'icon_scenario_shutter_down',         icon: 'window-shutter' },
  { id: 'icon_scenario_yoga',                 icon: 'meditation' },
  { id: 'icon_scenario_bath',                 icon: 'duck' },
  { id: 'icon_scenario_reading',              icon: 'book-open-variant' },
  { id: 'icon_scenario_music',                icon: 'music' },
  { id: 'icon_scenario_movie_evening',        icon: 'movie-open' },
  { id: 'icon_scenario_cooking',              icon: 'pot-steam' },
  { id: 'icon_scenario_barbecue',             icon: 'grill' },
  { id: 'icon_scenario_romantic_dinner',      icon: 'silverware-fork-knife' },
  { id: 'icon_scenario_workout',              icon: 'bike' },
  { id: 'icon_scenario_party',                icon: 'party-popper' },
  { id: 'icon_scenario_pet_scenario',         icon: 'cat' },
];
const sceIconSvg = (id) => (SCENARIO_ICONS.find(ic => ic.id === id) || SCENARIO_ICONS[0]).icon;

let sceDraft = null;

function sceActionToDraft(a) {
  for (const [type, spec] of Object.entries(SCENARIO_ACTION_TYPES))
    if (spec.match(a)) return { type, values: spec.parse(a) };
  return { unsupported: true, raw: a };
}
function sceNewAction() {
  const type = Object.keys(SCENARIO_ACTION_TYPES)[0];
  return { type, values: sceActionDefaults(type) };
}

function openScenarioEditor(existing) {
  sceDraft = existing
    ? { id: existing.id, name: existing.name || '', iconId: existing.iconId || SCENARIO_ICONS[0].id,
        actions: (existing.actions || []).map(sceActionToDraft) }
    : { name: '', iconId: SCENARIO_ICONS[0].id, actions: [] };
  renderScenarioEditor();
}

function sceActionRow(entry, idx) {
  const ref = 's' + idx;
  if (entry.unsupported) {
    const svc = entry.raw.deviceServiceId || entry.raw.deviceId || '?';
    return `
    <div class="border border-amber-200 bg-amber-50 rounded-md p-2 mb-2 flex items-center justify-between gap-2">
      <div class="text-xs text-amber-800 min-w-0">
        <div class="font-medium truncate">${escapeHtml(svc)}</div>
        <div>${t('autoForm.unsupported')}</div>
      </div>
      <button data-sce-del="${idx}" type="button" class="text-rose-600 hover:bg-rose-50 px-2 py-1 rounded text-sm shrink-0">✕</button>
    </div>`;
  }
  const spec = SCENARIO_ACTION_TYPES[entry.type];
  const typeOpts = Object.keys(SCENARIO_ACTION_TYPES).map(tp =>
    `<option value="${tp}" ${tp === entry.type ? 'selected' : ''}>${t('sceForm.action.' + tp)}</option>`).join('');
  return `
    <div class="border border-slate-200 rounded-md p-2 mb-2">
      <div class="flex items-center gap-2 mb-2">
        <select data-sce-type="${idx}" class="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm bg-white">${typeOpts}</select>
        <button data-sce-del="${idx}" type="button" class="text-rose-600 hover:bg-rose-50 px-2 py-1 rounded text-sm">✕</button>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        ${spec.fields.filter(f => !f.showIf || f.showIf(entry.values)).map(f => `
          <label class="text-xs text-slate-600 block">${t('autoForm.field.' + f.key)}
            ${autoFieldInput(f, entry.values[f.key], ref)}
          </label>`).join('')}
      </div>
    </div>`;
}

function sceActionDefaults(type) {
  const values = {};
  for (const f of SCENARIO_ACTION_TYPES[type].fields) values[f.key] = autoFieldDefault(f);
  return values;
}

function renderScenarioEditor() {
  const d = sceDraft;
  const prevScroll = $('#sce-scroll')?.scrollTop;
  showModal(`
    <h4 class="font-medium mb-3">${t(d.id ? 'modal.editScenario' : 'modal.newScenario')}</h4>
    <label class="block text-xs text-slate-600 mb-3">${t('autoForm.name')}
      <input id="sce-name" class="w-full mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
        value="${escapeHtml(d.name)}" />
    </label>
    <div class="text-xs text-slate-600 mb-1">${t('sceForm.icon')}</div>
    <div class="grid grid-cols-6 sm:grid-cols-8 gap-1 mb-3">
      ${SCENARIO_ICONS.map(ic => `
        <button type="button" data-sce-icon="${ic.id}" title="${t('sceIcon.' + ic.id)}"
          class="aspect-square flex items-center justify-center rounded-md border ${
            ic.id === d.iconId ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}">
          <img src="svg/${ic.icon}.svg" alt="" style="width:22px;height:22px" /></button>`).join('')}
    </div>
    <div class="flex items-center justify-between mb-1">
      <span class="text-xs uppercase tracking-wide text-slate-500">${t('sceForm.actions')}</span>
      <button id="sce-add" type="button" class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('sceForm.addAction')}</button>
    </div>
    <div id="sce-scroll" class="max-h-[45vh] overflow-auto pr-1">
      ${d.actions.map((e, i) => sceActionRow(e, i)).join('') || `<p class="text-xs text-slate-400 mb-2">${t('autoForm.empty')}</p>`}
    </div>
    <div class="mt-4 flex justify-end gap-2">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="sce-save" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md">${t('modal.save')}</button>
    </div>`);
  $('#modal-card').classList.remove('max-w-md');
  $('#modal-card').classList.add('max-w-2xl');
  if (prevScroll != null && $('#sce-scroll')) $('#sce-scroll').scrollTop = prevScroll;

  $('#m-cancel').onclick = hideModal;
  $('#sce-name').addEventListener('input', (e) => { d.name = e.target.value; });
  $$('#modal-card [data-sce-icon]').forEach(b => b.onclick = () => {
    d.iconId = b.dataset.sceIcon; renderScenarioEditor();
  });
  $('#sce-add').onclick = () => { d.actions.push(sceNewAction()); renderScenarioEditor(); };
  $$('#modal-card [data-sce-del]').forEach(b => b.onclick = () => {
    d.actions.splice(+b.dataset.sceDel, 1); renderScenarioEditor();
  });
  $$('#modal-card [data-sce-type]').forEach(sel => sel.addEventListener('change', () => {
    const i = +sel.dataset.sceType;
    d.actions[i] = { type: sel.value, values: sceActionDefaults(sel.value) };
    renderScenarioEditor();
  }));
  $$('#modal-card [data-af]:not([data-multi])').forEach(inp => inp.addEventListener('input', () => {
    const entry = d.actions[+inp.dataset.af.slice(1)];
    entry.values[inp.dataset.key] = inp.value;
    const field = SCENARIO_ACTION_TYPES[entry.type]?.fields.find(f => f.key === inp.dataset.key);
    if (field?.rerenderOnChange) renderScenarioEditor();
  }));
  $('#sce-save').onclick = submitScenario;
}

async function submitScenario() {
  const d = sceDraft;
  const name = (d.name || '').trim();
  if (!name) return alert(t('autoForm.needName'));
  const actions = d.actions.map(e =>
    e.unsupported ? e.raw : SCENARIO_ACTION_TYPES[e.type].build(e.values));
  const body = { '@type': 'scenario', name, iconId: d.iconId, actions };
  if (d.id) body.id = d.id;
  try {
    await api(d.id ? `/api/scenarios/${encodeURIComponent(d.id)}` : '/api/scenarios',
      { method: d.id ? 'PUT' : 'POST', body });
    hideModal();
    await loadAll();
  } catch (err) { alert(t('error.generic', err.message)); }
}

function renderScenarios() {
  const scenariosBlock = state.scenarios.length
    ? `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        ${state.scenarios.map(s => `
          <div class="card bg-white rounded-lg p-4 border border-slate-200 flex flex-col">
            <button data-scenario="${s.id}" class="text-left grow hover:opacity-80">
              <div class="font-medium flex items-center gap-1.5">
                <img src="svg/${sceIconSvg(s.iconId)}.svg" alt="" style="width:18px;height:18px" />${s.name}</div>
              <div class="text-xs text-slate-500 mt-1">${t('scenarios.tap')}</div>
            </button>
            <div class="flex gap-1 mt-2 pt-2 border-t border-slate-100">
              <button data-scenario-edit="${s.id}" class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('admin.edit')}</button>
              <button data-scenario-del="${s.id}" data-name="${(s.name || s.id).replace(/"/g,'')}"
                class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded">${t('admin.remove')}</button>
            </div>
          </div>`).join('')}
      </div>`
    : `<p class="text-slate-500">${t('scenarios.none')}</p>`;

  const udsBlock = state.userdefinedstates.length
    ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        ${state.userdefinedstates.map(u => `
          <div class="flex items-center justify-between bg-white border border-slate-200 rounded-md p-3 gap-2">
            <span class="font-medium truncate">${u.name}</span>
            <div class="flex items-center gap-1 shrink-0">
              <button data-uds="${u.id}" data-on="${!!u.state}"
                class="text-xs px-2 py-1 rounded
                ${u.state ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}">
                ${t(u.state ? 'security.active' : 'security.inactive')}
              </button>
              <button data-uds-del="${u.id}" data-name="${(u.name || u.id).replace(/"/g,'')}"
                class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded">${t('admin.remove')}</button>
            </div>
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
              <button data-auto-edit="${a.id}"
                class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('admin.edit')}</button>
              <button data-auto-dup="${a.id}"
                class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('admin.duplicate')}</button>
              <button data-auto-del="${a.id}" data-name="${(a.name || a.id).replace(/"/g,'')}"
                class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded">${t('admin.remove')}</button>
            </div>
          </div>`).join('')}
      </div>`
    : `<p class="text-slate-500">${t('admin.noAutomations')}</p>`;

  $('#tab-scenarios').innerHTML = `
    <div class="mb-5 rounded-lg border-2 border-amber-400 bg-amber-50 p-4">
      <div class="flex items-start gap-3">
        <span class="text-2xl leading-none shrink-0" aria-hidden="true">⚠️</span>
        <div>
          <h3 class="font-semibold text-amber-900 mb-1">${t('scenarios.disclaimerTitle')}</h3>
          <p class="text-sm text-amber-800">${t('scenarios.disclaimerBody')}</p>
        </div>
      </div>
    </div>
    <section class="mb-6">
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-sm font-medium text-slate-700">${t('scenarios.scenariosH', state.scenarios.length)}</h2>
        <button id="sce-add-btn" class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('scenarios.addScenario')}</button>
      </div>
      ${scenariosBlock}
    </section>
    <section class="mb-6">
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-sm font-medium text-slate-700">${t('scenarios.statesH', state.userdefinedstates.length)}</h2>
        <button id="uds-add" class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('scenarios.addState')}</button>
      </div>
      ${udsBlock}
    </section>
    <section>
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-sm font-medium text-slate-700">${t('admin.automationsH', state.automations.length)}</h2>
        <button id="auto-add" class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('admin.addAutomation')}</button>
      </div>
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

  $('#tab-scenarios #sce-add-btn')?.addEventListener('click', () => openScenarioEditor());

  $$('#tab-scenarios [data-scenario-edit]').forEach(b => b.addEventListener('click', () => {
    const s = state.scenarios.find(x => x.id === b.dataset.scenarioEdit);
    if (s) openScenarioEditor(s);
  }));

  $$('#tab-scenarios [data-scenario-del]').forEach(b => b.addEventListener('click', () =>
    confirmModal(t('modal.confirmRmScenario', b.dataset.name), async () => {
      await api(`/api/scenarios/${encodeURIComponent(b.dataset.scenarioDel)}`, { method: 'DELETE' });
      await loadAll();
    })));

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

  $('#tab-scenarios #uds-add')?.addEventListener('click', () =>
    promptModal(t('modal.newState'), '', async (name) => {
      await api('/api/userdefinedstates', {
        method: 'POST',
        body: { '@type': 'userDefinedState', name, state: false },
      });
      await loadAll();
    }));

  $$('#tab-scenarios [data-uds-del]').forEach(b => b.addEventListener('click', () =>
    confirmModal(t('modal.confirmRmState', b.dataset.name), async () => {
      await api(`/api/userdefinedstates/${encodeURIComponent(b.dataset.udsDel)}`, { method: 'DELETE' });
      await loadAll();
    })));

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

  $$('#tab-scenarios [data-auto-del]').forEach(b => b.addEventListener('click', () =>
    confirmModal(t('modal.confirmRmAutomation', b.dataset.name), async () => {
      await api(`/api/automations/${encodeURIComponent(b.dataset.autoDel)}`, { method: 'DELETE' });
      await loadAll();
    })));

  $('#tab-scenarios #auto-add')?.addEventListener('click', () => openAutomationEditor());

  $$('#tab-scenarios [data-auto-edit]').forEach(b => b.addEventListener('click', () => {
    const a = state.automations.find(x => x.id === b.dataset.autoEdit);
    if (a) openAutomationEditor(a);
  }));

  $$('#tab-scenarios [data-auto-dup]').forEach(b => b.addEventListener('click', async () => {
    const src = state.automations.find(x => x.id === b.dataset.autoDup);
    if (!src) return;
    // GET body == POST body, minus the id (assigned by the controller). Clone
    // so the live state object stays untouched.
    const { id, ...body } = structuredClone(src);
    body.name = t('admin.copyOf', src.name || src.id);
    try {
      await api('/api/automations', { method: 'POST', body });
      await loadAll();
    } catch (err) { alert(t('error.generic', err.message)); }
  }));
}


export { boolLabel, SCENARIO_ACTION_TYPES, SCENARIO_ICONS, sceIconSvg, sceActionToDraft, sceNewAction, openScenarioEditor, sceActionRow, sceActionDefaults, renderScenarioEditor, submitScenario, renderScenarios };
