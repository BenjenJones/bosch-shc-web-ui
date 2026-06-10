import { state, $, $$, t, api, escapeHtml, loadAll, roomName } from './core.js';
import { deviceCategory } from './devices.js';
import { showModal, hideModal } from './modals.js';

// =========================================================================
//  Automation editor (guided create form)
// =========================================================================
// Data-driven type registry. Each trigger/action type lists the fields that
// make up its string-encoded `configuration`; `top` fields live directly on
// the trigger/action object instead (e.g. an action's delayInSeconds). ONLY
// types with a schema verified against a real GET body belong here — guessing
// keys produces automations the SHC silently accepts but never fires. To add a
// type, GET an existing rule that uses it and mirror its fields (see the
// project memory on undocumented CRUD). Each field `key` needs an i18n label
// under `autoForm.field.<key>`, each type name one under `autoForm.type.<Type>`.
// A device field selects a deviceId; it filters state.devices by `services`
// (most robust — matches any device exposing one of these services), or by
// `category`/`models` as fallbacks. A `toConfig(values)` on a type overrides
// the generic "every field → one configuration key" packing — needed where the
// payload shape is conditional (e.g. intrusion's null-vs-array profiles).
const DELAY_TOP = { key: 'delayInSeconds', kind: 'number', default: 0, min: 0 };
// Reused field shapes for the many threshold/comparison types.
const CMP = { key: 'comparisonMode', kind: 'select', options: ['LESS_THAN', 'GREATER_THAN'], default: 'LESS_THAN' };
const thr = (def) => ({ key: 'threshold', kind: 'number', default: def });
const SC = { key: 'shutterContactId', kind: 'device', services: ['ShutterContact'] };
const PLUG = (key) => ({ key, kind: 'device', services: ['PowerMeter'] });
const CAM = (key) => ({ key, kind: 'device', services: ['PrivacyMode', 'CameraNotification'] });
const WALL = { key: 'deviceId', kind: 'device', models: ['RTH2', 'THB', 'RTH', 'RT2'] };
const RCC = (key) => ({ key, kind: 'device', idPrefix: 'roomClimateControl_',
  itemLabel: (d) => roomName(d.roomId || (d.id || '').replace('roomClimateControl_', '')) });
// Intrusion config profiles share the names the security tab already uses.
function intrusionProfileLabel(p) {
  const key = { 0: 'security.fullProtection', 1: 'security.partial', 2: 'security.custom' }[p];
  return key ? t(key) : t('autoForm.profileN', p);
}
const PROFILE_OPTS = ['0', '1', '2'];

const AUTOMATION_TRIGGER_TYPES = {
  ShutterContactTrigger: { group: 'device', fields: [
    SC, { key: 'triggerState', kind: 'select', options: ['ON_OPEN', 'ON_CLOSED'], default: 'ON_OPEN' },
  ] },
  ShutterContactReminderTrigger: { group: 'device', fields: [
    SC, { key: 'triggerState', kind: 'select', options: ['OPEN', 'CLOSED'], default: 'OPEN' },
    { key: 'remindAfterSeconds', kind: 'number', default: 600, min: 0 },
  ] },
  ShutterContactButtonPressTrigger: { group: 'device', fields: [
    SC, { key: 'buttonPressState', kind: 'select', options: ['ON_SHORT_PRESS', 'ON_LONG_PRESS'], default: 'ON_SHORT_PRESS' },
  ] },
  ShutterContactVibrationTrigger: { group: 'device', fields: [
    SC, { key: 'vibrationState', kind: 'select', options: ['ON_VIBRATION_DETECTED'], default: 'ON_VIBRATION_DETECTED' },
  ] },
  SmartPlugOnOffTrigger: { group: 'device', fields: [
    PLUG('smartPlugId'), { key: 'triggerState', kind: 'select', options: ['ON', 'OFF'], default: 'ON' },
  ] },
  SmartPlugPowerConsumptionTrigger_v2: { group: 'device', fields: [
    PLUG('deviceId'),
    { key: 'thresholdWatt', kind: 'number', default: 10, min: 0 },
    { key: 'durationSeconds', kind: 'number', default: 10, min: 0 }, CMP,
  ] },
  WallThermostatTemperatureThresholdTrigger: { group: 'device', fields: [WALL, thr(20), CMP] },
  WallThermostatHumidityThresholdTrigger:    { group: 'device', fields: [WALL, thr(50), CMP] },
  RoomClimateControlMeasuredTemperatureTrigger: { group: 'device', fields: [RCC('deviceId'), thr(20), CMP] },
  RoomHumidityThresholdTrigger: { group: 'device', fields: [{ key: 'roomId', kind: 'room' }, thr(50), CMP] },
  IndoorCameraMotionTrigger: { group: 'device', fields: [CAM('cameraId')] },
  IndoorCameraAudioTrigger:  { group: 'device', fields: [CAM('cameraId')] },
  KeypadButtonPressTrigger: { group: 'device', fields: [
    { key: 'deviceId', kind: 'device', category: 'switch' },
    { key: 'keyName', kind: 'select', options: ['BUTTON_1', 'BUTTON_2', 'BUTTON_3', 'BUTTON_4'], default: 'BUTTON_1' },
    { key: 'buttonEvent', kind: 'select', options: ['PRESS_SHORT', 'PRESS_LONG'], default: 'PRESS_SHORT' },
  ], toConfig: (v) => ({
    deviceId: v.deviceId, keyName: v.keyName,
    keyCode: Number(String(v.keyName).split('_')[1]) || 1, buttonEvent: v.buttonEvent,
  }) },
  AstroTimeEventTrigger: { group: 'time', fields: [
    { key: 'eventType', kind: 'select', options: ['SUNRISE', 'SUNSET'], default: 'SUNRISE' },
    { key: 'offsetInMinutes', kind: 'number', default: 0 },
  ] },
  DailyTimerTrigger: { group: 'time', fields: [{ key: 'time', kind: 'time', default: '08:00' }] },
  UserDefinedStateTrigger: { group: 'state', fields: [
    { key: 'stateId', kind: 'uds' },
    { key: 'stateChange', kind: 'select', options: ['TO_ACTIVE', 'TO_INACTIVE'], default: 'TO_ACTIVE' },
  ] },
};

const AUTOMATION_CONDITION_TYPES = {
  ShutterContactCondition: { group: 'device', fields: [
    SC, { key: 'conditionState', kind: 'select', options: ['OPEN', 'CLOSED'], default: 'CLOSED' },
  ] },
  SmartPlugOnOffCondition: { group: 'device', fields: [
    PLUG('smartPlugId'), { key: 'conditionState', kind: 'select', options: ['ON', 'OFF'], default: 'ON' },
  ] },
  WallThermostatTemperatureThresholdCondition: { group: 'device', fields: [WALL, thr(20), CMP] },
  WallThermostatHumidityCondition:             { group: 'device', fields: [WALL, thr(50), CMP] },
  RoomClimateControlMeasuredTemperatureCondition: { group: 'device', fields: [RCC('deviceId'), thr(20), CMP] },
  RoomClimateControlRoomControlModeCondition: { group: 'device', fields: [
    RCC('rccId'), { key: 'roomControlMode', kind: 'select', options: ['HEATING', 'OFF'], default: 'HEATING' },
  ] },
  RoomHumidityCondition: { group: 'device', fields: [{ key: 'roomId', kind: 'room' }, thr(50), CMP] },
  AstroTimeCondition: { group: 'time', fields: [
    { key: 'astroTimeConditionType', kind: 'select', options: ['DAYTIME', 'NIGHTTIME'], default: 'DAYTIME' },
    { key: 'startOffsetInMinutes', kind: 'number', default: 0 },
  ] },
  TimePeriodCondition: { group: 'time', fields: [
    { key: 'startTime', kind: 'time', default: '08:00' },
    { key: 'endTime',   kind: 'time', default: '22:00' },
  ] },
  WeekdaysCondition: { group: 'time', fields: [
    { key: 'weekdays', kind: 'multi', options: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'], default: [] },
  ] },
  IntrusionDetectionSystemArmedDisarmedCondition: { group: 'service', fields: [
    { key: 'conditionState', kind: 'select', options: ['SYSTEM_ARMED', 'SYSTEM_DISARMED'], default: 'SYSTEM_ARMED', rerenderOnChange: true },
    { key: 'profiles', kind: 'multi', options: PROFILE_OPTS, optLabel: intrusionProfileLabel, default: ['0'],
      showIf: (v) => v.conditionState === 'SYSTEM_ARMED' },
  ], toConfig: (v) => ({
    conditionState:   v.conditionState,
    // ARMED carries a profile array (can be multiple), DISARMED carries null.
    selectedProfiles: v.conditionState === 'SYSTEM_ARMED' ? (v.profiles || []) : null,
  }), fromConfig: (c) => ({ conditionState: c.conditionState, profiles: c.selectedProfiles || [] }) },
  UserDefinedStateCondition: { group: 'state', fields: [
    { key: 'stateId', kind: 'uds' },
    { key: 'state', kind: 'select', options: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  ] },
};

const AUTOMATION_ACTION_TYPES = {
  CustomPushNotificationAction: { group: 'notification', top: [DELAY_TOP], fields: [{ key: 'message', kind: 'text' }] },
  SmartPlugOnOffAction: { group: 'device', top: [DELAY_TOP], fields: [
    PLUG('smartPlugId'), { key: 'action', kind: 'select', options: ['TURN_ON', 'TURN_OFF'], default: 'TURN_ON' },
  ], toConfig: (v) => ({
    smartPlugId: v.smartPlugId, action: v.action,
    // Bosch sends these as explicit nulls when unused.
    temporaryTurnOnTime: null, operationMode: null, addEnergySnapshot: null, energySnapshotName: null,
    overwriteOldestEnergySnapshotIfNeeded: null, resetPowerConsumption: null,
  }) },
  ThermostatSilentModeAction: { group: 'device', top: [DELAY_TOP], fields: [
    { key: 'deviceId', kind: 'device', services: ['SilentMode'] },
    { key: 'mode', kind: 'select', options: ['MODE_NORMAL', 'MODE_SILENT'], default: 'MODE_NORMAL' },
  ] },
  IndoorCameraAction: { group: 'device', top: [DELAY_TOP], fields: [
    CAM('cameraId'),
    { key: 'actionEnableCamera', kind: 'select', options: ['TURN_ON', 'TURN_OFF'], default: 'TURN_ON' },
    { key: 'actionEnableCameraNotification', kind: 'select', options: ['TURN_NOTIFICATION_ON', 'TURN_NOTIFICATION_OFF'], default: 'TURN_NOTIFICATION_ON' },
  ] },
  IntrusionDetectionSystemArmDisarmAction: { group: 'service', top: [DELAY_TOP], fields: [
    { key: 'action', kind: 'select', options: ['SYSTEM_ARMED', 'SYSTEM_DISARMED'], default: 'SYSTEM_ARMED', rerenderOnChange: true },
    { key: 'profile', kind: 'select', options: PROFILE_OPTS, optLabel: intrusionProfileLabel, default: '0',
      showIf: (v) => v.action === 'SYSTEM_ARMED' },
  ], toConfig: (v) => ({
    action: v.action, selectedProfile: v.action === 'SYSTEM_ARMED' ? v.profile : null,
  }), fromConfig: (c) => ({ action: c.action, profile: c.selectedProfile ?? '0' }) },
  PresenceSimulationEnableDisableAction: { group: 'service', top: [DELAY_TOP], fields: [
    { key: 'action', kind: 'select', options: ['SYSTEM_ENABLED', 'SYSTEM_DISABLED'], default: 'SYSTEM_ENABLED' },
  ] },
  UserDefinedStateAction: { group: 'state', top: [DELAY_TOP], fields: [
    { key: 'stateId', kind: 'uds' },
    { key: 'state', kind: 'select', options: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  ] },
  ScenarioAction: { group: 'scenario', top: [DELAY_TOP], fields: [{ key: 'scenarioId', kind: 'scenario' }] },
};

// Working copy while the editor modal is open.
let autoDraft = null;

function autoRegistry(kind) {
  return kind === 't' ? AUTOMATION_TRIGGER_TYPES
    : kind === 'c' ? AUTOMATION_CONDITION_TYPES
    : AUTOMATION_ACTION_TYPES;
}
function autoSpecFields(spec) {
  return [...(spec.top || []), ...spec.fields];
}
// Devices eligible for a device-typed field, most-robust filter first.
function autoDevices(field) {
  return state.devices.filter(d => {
    if (field.idPrefix) return (d.id || '').startsWith(field.idPrefix);
    if (field.services) return field.services.some(svc =>
      state.services.some(s => s.deviceId === d.id && s.id === svc));
    if (field.category) return deviceCategory(d) === field.category;
    if (field.models)   return field.models.includes((d.deviceModel || '').toUpperCase());
    return false;
  });
}
// The list backing a reference-typed field (room / user-defined state / scenario).
function autoRefList(kind) {
  return kind === 'room' ? state.rooms
    : kind === 'uds' ? state.userdefinedstates
    : kind === 'scenario' ? state.scenarios
    : kind === 'device' ? null : null;
}
function autoFieldDefault(f) {
  if ('default' in f) return Array.isArray(f.default) ? [...f.default] : f.default;
  if (f.kind === 'device') return autoDevices(f)[0]?.id || '';
  if (f.kind === 'multi')  return [];
  if (autoRefList(f.kind)) return autoRefList(f.kind)[0]?.id || '';
  if (f.kind === 'select') return f.options[0];
  return '';
}
// Seed an entry's values from the field defaults so the form is never empty.
function autoDefaults(spec) {
  const v = {};
  for (const f of autoSpecFields(spec)) v[f.key] = autoFieldDefault(f);
  return v;
}
function autoNewEntry(kind) {
  const type = Object.keys(autoRegistry(kind))[0];
  return { type, values: autoDefaults(autoRegistry(kind)[type]) };
}
// Reverse of build(): turn an existing trigger/condition/action object from the
// SHC back into an editable draft entry. Types not in the registry are kept
// opaque (rendered read-only, re-sent verbatim) so editing never drops them.
function autoEntryToDraft(kind, entry) {
  const spec = autoRegistry(kind)[entry.type];
  if (!spec) return { type: entry.type, unsupported: true, raw: entry };
  let cfg = {};
  try { cfg = entry.configuration ? JSON.parse(entry.configuration) : {}; } catch { /* keep {} */ }
  const values = spec.fromConfig ? { ...spec.fromConfig(cfg) } : {};
  for (const f of (spec.top || []))
    if (!(f.key in values)) values[f.key] = entry[f.key] ?? autoFieldDefault(f);
  for (const f of spec.fields)
    if (!(f.key in values)) values[f.key] = (f.key in cfg) ? cfg[f.key] : autoFieldDefault(f);
  return { type: entry.type, values };
}
function autoCoerce(field, value) {
  if (field.kind === 'number') return Number(value) || 0;
  if (field.kind === 'multi')  return Array.isArray(value) ? value : [];
  return value ?? '';
}

function autoFieldInput(field, value, ref) {
  const cls = 'w-full mt-0.5 border border-slate-300 rounded-md px-2 py-1 text-sm bg-white';
  const attrs = `data-af="${ref}" data-key="${field.key}" class="${cls}"`;
  // device + room/uds/scenario all render an id→name <select>.
  const refItems = field.kind === 'device' ? autoDevices(field) : autoRefList(field.kind);
  if (refItems) {
    const itemLabel = (it) => field.itemLabel ? field.itemLabel(it) : (it.name || it.id);
    const opts = refItems.map(it =>
      `<option value="${escapeHtml(it.id)}" ${it.id === value ? 'selected' : ''}>${escapeHtml(itemLabel(it))}</option>`);
    // Preserve a stored id that the filter doesn't surface (e.g. a camera whose
    // service isn't listed, or a removed device) so editing keeps it — and
    // still resolve its real name from the full device/ref list if known.
    if (value && !refItems.some(it => it.id === value)) {
      const all = field.kind === 'device' ? state.devices : (autoRefList(field.kind) || []);
      const known = all.find(it => it.id === value);
      const lbl = known ? (field.itemLabel ? field.itemLabel(known) : (known.name || known.id)) : value;
      opts.unshift(`<option value="${escapeHtml(value)}" selected>${escapeHtml(lbl)}</option>`);
    }
    return `<select ${attrs}>${opts.join('') || `<option value="">${t('autoForm.noDevices')}</option>`}</select>`;
  }
  const optLabel = (o) => field.optLabel ? field.optLabel(o) : o;
  if (field.kind === 'select') {
    return `<select ${attrs}>${field.options.map(o =>
      `<option value="${o}" ${o === value ? 'selected' : ''}>${escapeHtml(String(optLabel(o)))}</option>`).join('')}</select>`;
  }
  if (field.kind === 'multi') {
    const sel = Array.isArray(value) ? value : [];
    return `<div data-af="${ref}" data-key="${field.key}" data-multi="1" class="flex flex-wrap gap-1 mt-0.5">
      ${field.options.map(o => `
        <label class="inline-flex items-center gap-1 text-xs border rounded px-1.5 py-0.5 cursor-pointer ${
          sel.includes(o) ? 'bg-blue-50 border-blue-400' : 'border-slate-300'}">
          <input type="checkbox" value="${o}" ${sel.includes(o) ? 'checked' : ''} class="accent-blue-600" />${escapeHtml(String(optLabel(o)))}
        </label>`).join('')}
    </div>`;
  }
  if (field.kind === 'time') {
    return `<input type="time" ${attrs} value="${escapeHtml(String(value ?? field.default ?? ''))}" />`;
  }
  if (field.kind === 'number') {
    return `<input type="number" ${attrs} value="${value ?? field.default ?? ''}"${
      field.min != null ? ` min="${field.min}"` : ''} />`;
  }
  return `<input type="text" ${attrs} value="${escapeHtml(String(value ?? ''))}" />`;
}

function autoRow(kind, entry, idx) {
  const ref = kind + idx;
  // Types not in the registry (e.g. RoomClimateAction) are shown read-only and
  // preserved verbatim on save — never silently dropped.
  if (entry.unsupported) {
    return `
    <div class="border border-amber-200 bg-amber-50 rounded-md p-2 mb-2 flex items-center justify-between gap-2">
      <div class="text-xs text-amber-800 min-w-0">
        <div class="font-medium truncate">${escapeHtml(entry.type)}</div>
        <div>${t('autoForm.unsupported')}</div>
      </div>
      <button data-row-del="${ref}" type="button" class="text-rose-600 hover:bg-rose-50 px-2 py-1 rounded text-sm shrink-0">✕</button>
    </div>`;
  }
  const reg = autoRegistry(kind);
  const spec = reg[entry.type];
  // Group the type options by their app-style category (Geräte / Zeit / …).
  const groups = {};
  for (const [tp, sp] of Object.entries(reg)) (groups[sp.group || 'other'] ??= []).push(tp);
  const typeOpts = Object.entries(groups).map(([g, types]) =>
    `<optgroup label="${t('autoForm.group.' + g)}">${types.map(tp =>
      `<option value="${tp}" ${tp === entry.type ? 'selected' : ''}>${t('autoForm.type.' + tp)}</option>`).join('')}</optgroup>`
  ).join('');
  return `
    <div class="border border-slate-200 rounded-md p-2 mb-2">
      <div class="flex items-center gap-2 mb-2">
        <select data-row-type="${ref}" class="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm bg-white">${typeOpts}</select>
        <button data-row-del="${ref}" type="button" class="text-rose-600 hover:bg-rose-50 px-2 py-1 rounded text-sm">✕</button>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        ${autoSpecFields(spec).filter(f => !f.showIf || f.showIf(entry.values)).map(f => `
          <label class="text-xs text-slate-600 block">${t('autoForm.field.' + f.key)}
            ${autoFieldInput(f, entry.values[f.key], ref)}
          </label>`).join('')}
      </div>
    </div>`;
}

function openAutomationEditor(existing) {
  if (existing) {
    autoDraft = {
      id: existing.id,
      name: existing.name || '',
      enabled: existing.enabled,
      triggers:   (existing.automationTriggers   || []).map(e => autoEntryToDraft('t', e)),
      conditions: (existing.automationConditions || []).map(e => autoEntryToDraft('c', e)),
      actions:    (existing.automationActions     || []).map(e => autoEntryToDraft('a', e)),
      conditionLogicalOp: existing.conditionLogicalOp || 'AND',
    };
  } else {
    // Start empty like the Bosch app: the user adds Wenn/Und/Dann blocks as needed.
    autoDraft = { name: '', triggers: [], conditions: [], actions: [], conditionLogicalOp: 'AND' };
  }
  renderAutomationEditor();
}

function autoListFor(kind, d) {
  return kind === 't' ? d.triggers : kind === 'c' ? d.conditions : d.actions;
}

// Wenn / Und / Dann are shown one-at-a-time on tabs to keep the dialog short.
const AUTO_TABS = [
  { kind: 't', titleKey: 'autoForm.triggers',   addKey: 'autoForm.addTrigger',   addId: 'af-add-t' },
  { kind: 'c', titleKey: 'autoForm.conditions', addKey: 'autoForm.addCondition', addId: 'af-add-c' },
  { kind: 'a', titleKey: 'autoForm.actions',    addKey: 'autoForm.addAction',    addId: 'af-add-a' },
];

function renderAutomationEditor() {
  const d = autoDraft;
  const prevScroll = $('#af-scroll')?.scrollTop;
  const active = d.activeTab || 't';
  // Only restore scroll on an in-tab re-render (e.g. toggling a field); a tab
  // switch should start at the top.
  const sameTab = d._renderedTab === active;
  d._renderedTab = active;
  const activeTab = AUTO_TABS.find(tb => tb.kind === active);
  const list = autoListFor(active, d);
  const logicSel = active === 'c' && d.conditions.length > 1 ? `
    <select id="af-logic" class="text-xs border border-slate-300 rounded-md px-1 py-0.5 bg-white">
      ${['AND', 'OR'].map(o => `<option value="${o}" ${o === d.conditionLogicalOp ? 'selected' : ''}>${t('autoForm.logic.' + o)}</option>`).join('')}
    </select>` : '';
  const tabBar = AUTO_TABS.map(tb => {
    const n = autoListFor(tb.kind, d).length;
    const on = tb.kind === active;
    return `<button data-af-tab="${tb.kind}" type="button"
      class="px-3 py-1.5 text-sm border-b-2 -mb-px ${on
        ? 'border-blue-600 text-blue-600 font-medium' : 'border-transparent text-slate-500 hover:text-slate-700'}">
      ${t(tb.titleKey)} <span class="text-[11px] text-slate-400">(${n})</span></button>`;
  }).join('');
  showModal(`
    <h4 class="font-medium mb-3">${t(d.id ? 'modal.editAutomation' : 'modal.newAutomation')}</h4>
    <label class="block text-xs text-slate-600 mb-3">${t('autoForm.name')}
      <input id="af-name" class="w-full mt-0.5 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
        value="${escapeHtml(d.name)}" />
    </label>
    <div class="flex border-b border-slate-200 mb-3">${tabBar}</div>
    <div id="af-scroll" class="max-h-[50vh] overflow-auto pr-1">
      <div class="flex items-center justify-end gap-2 mb-2">${logicSel}
        <button id="${activeTab.addId}" type="button" class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t(activeTab.addKey)}</button>
      </div>
      ${list.map((e, i) => autoRow(active, e, i)).join('') || `<p class="text-xs text-slate-400 mb-2">${t('autoForm.empty')}</p>`}
    </div>
    <div class="mt-4 flex justify-end gap-2">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="af-save" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md">${t('modal.save')}</button>
    </div>`);
  $('#modal-card').classList.remove('max-w-md');
  $('#modal-card').classList.add('max-w-2xl');
  if (sameTab && prevScroll != null && $('#af-scroll')) $('#af-scroll').scrollTop = prevScroll;

  $('#m-cancel').onclick = hideModal;
  $('#af-name').addEventListener('input', (e) => { d.name = e.target.value; });
  $$('#modal-card [data-af-tab]').forEach(b => b.addEventListener('click', () => {
    d.activeTab = b.dataset.afTab; renderAutomationEditor();
  }));
  $('#' + activeTab.addId).onclick = () => { list.push(autoNewEntry(active)); renderAutomationEditor(); };
  $('#af-logic')?.addEventListener('change', (e) => { d.conditionLogicalOp = e.target.value; });
  const listFor = (ref) => autoListFor(ref[0], d);
  $$('#modal-card [data-row-del]').forEach(b => b.onclick = () => {
    listFor(b.dataset.rowDel).splice(+b.dataset.rowDel.slice(1), 1);
    renderAutomationEditor();
  });
  $$('#modal-card [data-row-type]').forEach(sel => sel.addEventListener('change', () => {
    const ref = sel.dataset.rowType, kind = ref[0];
    listFor(ref)[+ref.slice(1)] = { type: sel.value, values: autoDefaults(autoRegistry(kind)[sel.value]) };
    renderAutomationEditor();
  }));
  $$('#modal-card [data-af]:not([data-multi])').forEach(inp => inp.addEventListener('input', () => {
    const ref = inp.dataset.af;
    const entry = listFor(ref)[+ref.slice(1)];
    entry.values[inp.dataset.key] = inp.value;
    // Some fields toggle others' visibility (e.g. ARMED ↔ profile) — re-render.
    const field = autoRegistry(ref[0])[entry.type]?.fields.find(f => f.key === inp.dataset.key);
    if (field?.rerenderOnChange) renderAutomationEditor();
  }));
  // Multi-value (checkbox) fields collect every checked option into an array.
  $$('#modal-card [data-multi]').forEach(box => box.addEventListener('change', () => {
    const arr = [...box.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value);
    listFor(box.dataset.af)[+box.dataset.af.slice(1)].values[box.dataset.key] = arr;
    renderAutomationEditor();
  }));
  $('#af-save').onclick = submitAutomation;
}

async function submitAutomation() {
  const d = autoDraft;
  const name = (d.name || '').trim();
  if (!name) return alert(t('autoForm.needName'));
  // The SHC accepts almost any combination (some rules have only conditions, or
  // only an action), so just require that the rule does *something*.
  if (!d.triggers.length && !d.conditions.length && !d.actions.length)
    return alert(t('autoForm.needSomething'));
  // GET body == POST body (minus id). `top` fields sit on the object; the rest
  // is packed into the double-encoded `configuration` string — unless the type
  // defines toConfig() for a non-1:1 shape.
  const build = (kind) => (entry) => {
    if (entry.unsupported) return entry.raw;   // re-emit verbatim
    const spec = autoRegistry(kind)[entry.type];
    const obj = { type: entry.type };
    for (const f of (spec.top || [])) obj[f.key] = autoCoerce(f, entry.values[f.key]);
    let cfg;
    if (spec.toConfig) {
      cfg = spec.toConfig(entry.values);
    } else {
      cfg = {};
      for (const f of spec.fields) cfg[f.key] = autoCoerce(f, entry.values[f.key]);
    }
    obj.configuration = JSON.stringify(cfg);
    return obj;
  };
  const body = {
    '@type': 'automationRule',
    name,
    // Editing keeps the rule's current on/off state; new rules start enabled.
    enabled: d.id ? !!d.enabled : true,
    automationTriggers:   d.triggers.map(build('t')),
    automationConditions: d.conditions.map(build('c')),
    automationActions:    d.actions.map(build('a')),
    conditionLogicalOp:   d.conditionLogicalOp || 'AND',
  };
  if (d.id) body.id = d.id;
  try {
    await api(d.id ? `/api/automations/${encodeURIComponent(d.id)}` : '/api/automations',
      { method: d.id ? 'PUT' : 'POST', body });
    hideModal();
    await loadAll();
  } catch (err) { alert(t('error.generic', err.message)); }
}

export { PROFILE_OPTS, intrusionProfileLabel, AUTOMATION_TRIGGER_TYPES, AUTOMATION_CONDITION_TYPES, AUTOMATION_ACTION_TYPES, autoRegistry, autoSpecFields, autoDevices, autoRefList, autoFieldDefault, autoDefaults, autoNewEntry, autoEntryToDraft, autoCoerce, autoFieldInput, autoRow, openAutomationEditor, autoListFor, renderAutomationEditor, submitAutomation };
