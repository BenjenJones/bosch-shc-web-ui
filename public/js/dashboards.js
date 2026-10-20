import { state, $, $$, t, api, escapeHtml, isAdmin, roomName, deviceName, isMessageActive } from './core.js';
import { safeRenderDeviceCard, wireDeviceControls, renderRoomClimateBadge, renderRoomMessageBadge, renderRoomShutterGroup,
  shutterDevices, renderShutterGroup, deviceSortRank } from './devices.js';
import { sceIconSvg } from './scenarios.js';
import { alarmCardHtml, wireAlarmButtons } from './security.js';
import { healthDevices, deviceIssues, HEALTH_KINDS } from './health.js';
import { messageTitle, severityFromMessage } from './messages.js';
import { fillSparklines, fetchSeries, renderLineChart, renderBarChart, energyBars, METRIC_ORDER, METRIC_DEFS, RANGES } from './charts.js';
import { periodRange } from './energy.js';
import { showModal, hideModal, confirmModal, promptModal } from './modals.js';
import { selectTab } from './tabs.js';

// =========================================================================
//  Custom dashboards — admin-built pages of widgets on a free 12-column
//  grid, each shown as its own tab ("dash:<id>"). Stored server-side
//  (/api/dashboards, see dashboards.js in the repo root), so every browser
//  sees the same set; which one a browser opens at start or shows in kiosk
//  mode is a per-browser choice (localStorage).
//
//  Edit mode works on a deep copy (`edit.draft`) and PUTs the whole list on
//  "Done". Widgets are moved/resized with pointer events; others are pushed
//  down out of the way (recomputed from their positions at drag start, so
//  they spring back when the dragged widget moves on). Below 640 px the grid
//  stacks the widgets in reading order and editing is off.
// =========================================================================
const COLS = 12;
const ROW = 40;   // px per grid row — keep in sync with .dash-grid in app.css
const GAP = 12;   // px gap — idem
const MAX_H = 40;
const START_KEY = 'startTab';
const KIOSK_KEY = 'kioskDashboard';

// Default size per widget type and which types render without a panel
// frame (they bring their own card markup).
const TYPES = {
  device:   { w: 4,  h: 5, bare: true },
  scenario: { w: 3,  h: 2, bare: true },
  room:     { w: 12, h: 8 },
  chart:    { w: 6,  h: 6 },
  energy:   { w: 6,  h: 4 },
  health:   { w: 4,  h: 4 },
  messages: { w: 6,  h: 5 },
  security: { w: 6,  h: 5, bare: true },
  clock:    { w: 4,  h: 3 },
  text:     { w: 4,  h: 3 },
  shutters: { w: 12, h: 2 },
  divider:  { w: 12, h: 1, bare: true },
};
// Types whose content follows live SHC state; the rest (chart, energy
// totals, text, clock) is not re-rendered on every event.
const LIVE = new Set(['device', 'scenario', 'room', 'health', 'messages', 'security', 'shutters', 'energy']);

const attr = (s) => escapeHtml(s ?? '').replace(/"/g, '&quot;');
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clone = (o) => JSON.parse(JSON.stringify(o));
const locale = () => (state.lang === 'en' ? 'en-GB' : 'de-DE');
const num = (v, dec = 2) => (v ?? 0).toLocaleString(locale(), { minimumFractionDigits: dec, maximumFractionDigits: dec });

let currentId = null;       // dashboard shown in the tab (null = other tab)
let edit = null;            // { id, draft: [...dashboards] } while editing
let clockTimer = null;
let renderedLang = null;  // language of the last full render

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, v) { try { v == null ? localStorage.removeItem(key) : localStorage.setItem(key, v); } catch { /* ignore */ } },
};
const findDash = (id, list = state.dashboards) => list.find(d => d.id === id);
const kioskDashboard = () => findDash(store.get(KIOSK_KEY));
const narrow = () => window.matchMedia('(max-width: 639px)').matches;

// ---- per-browser choices ---------------------------------------------------
// Start page: any tab name; we only ever store dashboard tabs ("dash:<id>").
function startTab() {
  const v = store.get(START_KEY);
  if (v?.startsWith('dash:') && !findDash(v.slice(5))) return null;
  return v;
}
function setKioskDashboard(id) { store.set(KIOSK_KEY, id); }

// ---- navigation ------------------------------------------------------------
// One tab per dashboard, right after the built-in "Dashboard" (devices) tab,
// plus a "+" for admins. Rebuilt after every load/save.
function renderDashboardNav() {
  $$('[data-dash-nav]').forEach(el => el.remove());
  const nav = $('nav [data-tab="devices"]');
  const opt = $('#tab-select option[value="devices"]');
  const list = state.dashboards;
  [...list].reverse().forEach(d => {
    nav?.insertAdjacentHTML('afterend', `
      <button data-tab="dash:${attr(d.id)}" data-dash-nav
        class="tab whitespace-nowrap text-slate-500 hover:text-slate-800 border-b-2 border-transparent pb-1.5">${escapeHtml(d.name)}</button>`);
    opt?.insertAdjacentHTML('afterend', `<option value="dash:${attr(d.id)}" data-dash-nav>${escapeHtml(d.name)}</option>`);
  });
  if (isAdmin()) {
    const last = list.length ? $$('nav [data-dash-nav]').pop() : nav;
    last?.insertAdjacentHTML('afterend', `
      <button type="button" data-dash-nav data-dash-create title="${attr(t('dash.add'))}" aria-label="${attr(t('dash.add'))}"
        class="text-slate-400 hover:text-slate-800 border-b-2 border-transparent pb-1.5 px-1">+</button>`);
  }
  // Keep the highlight on the open dashboard; fall back if it was deleted.
  if (currentId) {
    if (findDash(currentId)) selectTab('dash:' + currentId);
    else selectTab('devices');
  }
}

function createDashboard() {
  promptModal(t('dash.newName'), '', async (name) => {
    const d = { id: newId('d'), name, widgets: [] };
    await save([...state.dashboards, d]);
    selectTab('dash:' + d.id);
    startEdit();
  });
}

async function save(list) {
  state.dashboards = await api('api/dashboards', { method: 'PUT', body: list });
  renderDashboardNav();
}

// ---- grid ------------------------------------------------------------------
const placeStyle = (w) => `grid-column:${w.x + 1} / span ${w.w};grid-row:${w.y + 1} / span ${w.h}`;
const bottom = (list) => list.reduce((m, w) => Math.max(m, w.y + w.h), 0);
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const sorted = (list) => [...list].sort((a, b) => a.y - b.y || a.x - b.x);

function gridHtml(dash, editing) {
  const ws = sorted(dash.widgets);
  // While editing, a spacer keeps a few empty rows below the last widget so
  // there is room to drop things further down.
  const spacer = editing ? `<div data-dash-spacer aria-hidden="true" style="grid-column:1;grid-row:${bottom(ws) + 4}"></div>` : '';
  return `<div class="dash-grid${editing ? ' editing' : ''}" data-dash-grid="${attr(dash.id)}">
    ${ws.map(w => widgetHtml(w, editing)).join('')}${spacer}
  </div>`;
}

function widgetHtml(w, editing) {
  const bare = TYPES[w.type]?.bare;
  const tools = editing ? `
    <div class="dash-tools">
      <button type="button" data-w-config title="${attr(t('dash.widgetSettings'))}" aria-label="${attr(t('dash.widgetSettings'))}">⚙</button>
      <button type="button" data-w-remove title="${attr(t('dash.removeWidget'))}" aria-label="${attr(t('dash.removeWidget'))}">×</button>
    </div>
    <div class="dash-resize" data-w-resize title="${attr(t('dash.resize'))}"></div>` : '';
  return `<div class="dash-w${bare ? '' : ' dash-panel bg-white border border-slate-200 rounded-lg'}" data-w="${attr(w.id)}" style="${placeStyle(w)}">
    <div class="dash-body" data-w-body>${safeBody(w)}</div>${tools}
  </div>`;
}

function safeBody(w) {
  try { return bodyHtml(w); }
  catch (err) {
    console.error('dashboard widget', w, err);
    return `<p class="text-xs text-rose-600">${escapeHtml(t('error.generic', err.message))}</p>`;
  }
}

const heading = (text, extra = '') =>
  `<h3 class="text-sm font-medium mb-2 flex items-center gap-2 min-w-0"><span class="truncate">${escapeHtml(text)}</span>${extra}</h3>`;
const missing = () => `<p class="text-sm text-slate-500">${t('dash.notFound')}</p>`;
const gotoLink = (tab) => `<button type="button" data-dash-goto="${tab}" class="ml-auto shrink-0 text-xs font-normal text-blue-600 hover:underline">${t('dash.showAll')}</button>`;

function bodyHtml(w) {
  const c = w.cfg || {};
  switch (w.type) {
    case 'device': {
      const dev = state.devices.find(d => d.id === c.deviceId);
      return dev ? safeRenderDeviceCard(dev, { showRoom: true }) : `<div class="card h-full bg-white border border-slate-200 rounded-lg p-3">${missing()}</div>`;
    }
    case 'scenario': {
      const s = state.scenarios.find(x => x.id === c.scenarioId);
      if (!s) return `<div class="card h-full bg-white border border-slate-200 rounded-lg p-3">${missing()}</div>`;
      return `<button type="button" data-fav-scenario="${attr(s.id)}"
        class="card w-full h-full bg-white border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-3 px-4 text-left text-lg font-medium">
        <img src="svg/${sceIconSvg(s.iconId)}.svg" alt="" style="width:28px;height:28px" class="shrink-0" />
        <span class="truncate">${escapeHtml(s.name || s.id)}</span>
      </button>`;
    }
    case 'room': {
      if (!state.rooms.some(r => r.id === c.roomId)) return missing();
      const devs = state.devices.filter(d => d.roomId === c.roomId && d.status !== 'DISCOVERED')
        .sort((a, b) => deviceSortRank(a) - deviceSortRank(b) || (a.name || a.id).localeCompare(b.name || b.id, 'de'));
      return `
        <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-2 mb-2">
          <h3 class="text-sm uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
            ${escapeHtml(c.title || roomName(c.roomId))}${renderRoomMessageBadge(c.roomId)}
          </h3>
          <div class="flex flex-col gap-1 w-full sm:w-auto sm:items-end">
            ${renderRoomClimateBadge(c.roomId)}${renderRoomShutterGroup(c.roomId)}
          </div>
        </div>
        <div class="dash-cards">${devs.map(d => safeRenderDeviceCard(d)).join('')}</div>`;
    }
    case 'chart': {
      const dev = state.devices.find(d => d.id === c.deviceId);
      const title = c.title || `${dev ? deviceName(dev.id) : t('dash.notFound')} · ${t('history.m.' + (c.metric || 'temperature'))}`;
      if (!state.historyAvailable) return heading(title) + `<p class="text-sm text-slate-500">${t('history.unavailable')}</p>`;
      return heading(title, dev ? `<button type="button" data-history="${attr(dev.id)}" data-history-metric="${attr(c.metric || '')}"
          class="ml-auto shrink-0 text-xs font-normal text-blue-600 hover:underline">${t('history.r.' + (c.range || '24h'))}</button>` : '')
        + `<div data-dash-chart></div>`;
    }
    case 'energy': return energyHtml(c);
    case 'health': return healthHtml(c);
    case 'messages': return messagesHtml(c);
    case 'security': return alarmCardHtml();
    case 'clock':
      return `<div class="h-full flex flex-col justify-center">
        <div data-dash-time class="text-4xl font-light tabular-nums"></div>
        <div data-dash-date class="text-slate-500 mt-1"></div>
      </div>`;
    case 'text':
      return (c.title ? heading(c.title) : '') + `<div class="text-sm whitespace-pre-line">${escapeHtml(c.text || '')}</div>`;
    case 'shutters': {
      const devs = shutterDevices(null);
      return devs.length ? `<div class="h-full flex items-center">${renderShutterGroup('all', devs, t('devices.allShutters', devs.length))}</div>`
        : `<p class="text-sm text-slate-500">${t('dash.noShutters')}</p>`;
    }
    case 'divider':
      // One column wide → vertical line; otherwise a horizontal rule with an
      // optional section title.
      if (w.w === 1) return `<div class="h-full flex justify-center"><span class="border-l border-slate-300"></span></div>`;
      return `<div class="h-full flex items-center gap-3">
        ${c.title ? `<span class="text-sm uppercase tracking-wide text-slate-500 shrink-0">${escapeHtml(c.title)}</span>` : ''}
        <span class="flex-1 border-t border-slate-300"></span>
      </div>`;
    default: return '';
  }
}

// Energy totals come from /api/energy (cached 5 min); live power from state.
const ENERGY_TTL = 5 * 60e3;
let energyCache = null; // { at, day, month, priced }
function energyHtml(c) {
  const power = state.services.filter(s => s.id === 'PowerMeter' && typeof s.state?.powerConsumption === 'number')
    .reduce((a, s) => a + s.state.powerConsumption, 0);
  const e = energyCache;
  const tile = (label, value) => `<div><div class="text-xs text-slate-500">${label}</div><div class="text-xl font-light tabular-nums">${value}</div></div>`;
  const money = (v) => (v ?? 0).toLocaleString(locale(), { style: 'currency', currency: 'EUR' });
  return heading(c.title || t('tab.energy'), gotoLink('energy')) + `
    <div class="grid grid-cols-2 gap-3" data-dash-energy>
      ${tile(t('dash.today'), e ? `${num(e.day.kwh)} <span class="text-sm">kWh</span>` : '…')}
      ${tile(t('dash.thisMonth'), e ? `${num(e.month.kwh)} <span class="text-sm">kWh</span>` : '…')}
      ${tile(t('energy.livePower'), `${num(power, 0)} <span class="text-sm">W</span>`)}
      ${e?.hasTariff ? tile(`${t('energy.cost')} · ${t('dash.thisMonth')}`, money(e.month.cost)) : ''}
    </div>`;
}
async function loadEnergyCache() {
  if (energyCache && energyCache.at > Date.now() - ENERGY_TTL) return false;
  const day = periodRange('day', 0), month = periodRange('month', 0);
  const [d, m, tr] = await Promise.all([
    api(`api/energy?from=${day.from}&to=${day.to}&bucket=${day.bucket}`),
    api(`api/energy?from=${month.from}&to=${month.to}&bucket=${month.bucket}`),
    api('api/energy/tariffs'),
  ]);
  energyCache = { at: Date.now(), day: d, month: m, hasTariff: (tr.tariffs || []).length > 0 };
  return true;
}

function healthHtml(c) {
  const rows = healthDevices().map(d => deviceIssues(d)).filter(i => i.length);
  const counts = Object.fromEntries(HEALTH_KINDS.map(k => [k, rows.filter(r => r.some(i => i.kind === k)).length]));
  const worst = (k) => Math.max(0, ...rows.flat().filter(i => i.kind === k).map(i => i.severity));
  const tone = (sev) => sev >= 3 ? 'text-rose-700' : sev === 2 ? 'text-amber-700' : 'text-slate-600';
  const body = rows.length ? `<ul class="text-sm space-y-1">${HEALTH_KINDS.filter(k => counts[k]).map(k => `
      <li class="flex justify-between gap-2 ${tone(worst(k))}"><span>${t('health.' + k)}</span><span class="tabular-nums font-medium">${counts[k]}</span></li>`).join('')}</ul>`
    : `<p class="text-sm text-emerald-700">${t('health.allGood')}</p>`;
  return heading(c.title || t('tab.health'), gotoLink('health')) + body;
}

function messagesHtml(c) {
  const list = state.messages.filter(isMessageActive).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const dot = { error: 'bg-rose-500', warning: 'bg-amber-500', info: 'bg-sky-500' };
  const body = list.length ? `<ul class="text-sm divide-y divide-slate-200">${list.slice(0, 20).map(m => {
      const src = m.sourceName || (m.sourceId && deviceName(m.sourceId)) || '';
      const when = m.timestamp ? new Date(m.timestamp).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      return `<li class="py-1.5 flex items-start gap-2">
        <span class="mt-1.5 w-2 h-2 rounded-full shrink-0 ${dot[severityFromMessage(m)] || 'bg-slate-400'}"></span>
        <span class="min-w-0"><span class="block truncate">${escapeHtml(messageTitle(m.messageCode?.name || 'UNKNOWN'))}</span>
        <span class="block text-xs text-slate-500 truncate">${escapeHtml([src, when].filter(Boolean).join(' · '))}</span></span>
      </li>`;
    }).join('')}</ul>`
    : `<p class="text-sm text-slate-500">${t('messages.none')}</p>`;
  return heading(`${c.title || t('tab.messages')} (${list.length})`, gotoLink('messages')) + body;
}

// ---- async widget content (charts, energy) ----------------------------------
const CHART_TTL = 5 * 60e3;
const chartCache = new Map(); // `${series}|${range}` -> { at, data }

// Pixel height available for a chart: what is left of the widget below the
// heading (minus the panel's bottom padding). Stacked on phones the widget
// has no fixed height, so derive it from its row count there.
function chartHeight(w, el) {
  const frame = el.closest('[data-w]');
  if (narrow() || !frame) return Math.max(120, w.h * ROW + (w.h - 1) * GAP - 24 - 28);
  return Math.max(120, frame.clientHeight - el.offsetTop - 12);
}

async function cachedSeries(series, from, to, res, key) {
  const hit = chartCache.get(key);
  if (hit && hit.at > Date.now() - CHART_TTL) return hit.data;
  const data = await fetchSeries(series, from, to, res);
  chartCache.set(key, { at: Date.now(), data });
  return data;
}

const drawSeq = new WeakMap(); // chart element -> latest draw, so a slow one can't win
async function drawChart(w, el) {
  const c = w.cfg || {};
  const seq = (drawSeq.get(el) || 0) + 1;
  drawSeq.set(el, seq);
  const stale = () => drawSeq.get(el) !== seq;
  const metric = c.metric || 'temperature', range = RANGES[c.range] ? c.range : '24h';
  const def = METRIC_DEFS[metric];
  if (!c.deviceId || !def) return;
  const to = Date.now(), from = to - RANGES[range];
  const height = chartHeight(w, el);
  try {
    if (def.bars) {
      const res = range === '24h' ? 'hour' : 'day';
      const pad = res === 'hour' ? 3600e3 : 864e5;
      const r = await cachedSeries(`${c.deviceId}|energy`, from - pad, to, res, `${c.deviceId}|energy|${range}`);
      if (stale()) return;
      renderBarChart(el, energyBars(r.points, range), { def, height });
      return;
    }
    const wanted = [{ metric, label: t('history.m.' + metric), cls: 'chart-s1' }];
    if (metric === 'temperature') wanted.push({ metric: 'setpoint', label: t('history.m.setpoint'), cls: 'chart-s2', dashed: true, step: true });
    const results = await Promise.all(wanted.map(x =>
      cachedSeries(`${c.deviceId}|${x.metric}`, from, to, 'auto', `${c.deviceId}|${x.metric}|${range}`)));
    if (stale()) return;
    const series = wanted.map((x, i) => ({ ...x, step: x.step || def.step, points: results[i].points }))
      .filter((s, i) => i === 0 || s.points.length);
    renderLineChart(el, series, { from, to, rangeKey: range, res: results[0].res, def, height });
  } catch (err) {
    el.innerHTML = `<p class="text-sm text-rose-600">${escapeHtml(t('error.generic', err.message))}</p>`;
  }
}

// Charts are drawn at a fixed pixel size, so each chart widget is watched and
// redrawn whenever its frame changes size: resizing it in the editor (live
// while dragging), window resizes, kiosk, phone rotation. The first callback
// after observe() does the initial draw. Data comes from chartCache.
const chartFrames = new Map(); // widget frame -> { w, el, size }
const chartObserver = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const entry = chartFrames.get(target);
    if (!entry) continue;
    if (!target.isConnected) { chartObserver.unobserve(target); chartFrames.delete(target); continue; }
    // Stacked on phones the height follows the content — only width counts.
    const size = narrow() ? `${target.clientWidth}` : `${target.clientWidth}x${target.clientHeight}`;
    if (size === entry.size) continue;
    entry.size = size;
    drawChart(entry.w, entry.el);
  }
}) : null;

function watchChart(w, el) {
  const frame = el.closest('[data-w]');
  if (!chartObserver || !frame) { drawChart(w, el); return; }
  for (const f of chartFrames.keys()) if (!f.isConnected) { chartObserver.unobserve(f); chartFrames.delete(f); }
  chartFrames.set(frame, { w, el, size: null });
  chartObserver.observe(frame);
}

// Wire controls and fill async content of the widgets under `root`.
function afterRender(root, dash, { charts = true } = {}) {
  wireDeviceControls(root);
  wireAlarmButtons(root);
  fillSparklines(root);
  updateClocks();
  if (charts) for (const el of $$('[data-dash-chart]', root)) {
    const w = dash.widgets.find(x => x.id === el.closest('[data-w]')?.dataset.w);
    if (w) watchChart(w, el);
  }
  if ($('[data-dash-energy]', root)) {
    loadEnergyCache().then(changed => {
      if (!changed) return;
      for (const body of $$('[data-dash-energy]', root)) {
        const w = dash.widgets.find(x => x.id === body.closest('[data-w]')?.dataset.w);
        const b = body.closest('[data-w-body]');
        if (w && b) b.innerHTML = safeBody(w);
      }
    }).catch(() => { /* totals stay "…" */ });
  }
}

function updateClocks() {
  const now = new Date();
  for (const el of $$('[data-dash-time]')) el.textContent = now.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  for (const el of $$('[data-dash-date]')) el.textContent = now.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  if (!clockTimer && $('[data-dash-time]')) clockTimer = setInterval(() => {
    if (!$('[data-dash-time]')) { clearInterval(clockTimer); clockTimer = null; return; }
    updateClocks();
  }, 15000);
}

// ---- tab view ----------------------------------------------------------------
function toolbarHtml(dash) {
  const isStart = startTab() === 'dash:' + dash.id;
  const isKioskDash = store.get(KIOSK_KEY) === dash.id;
  if (edit) {
    const i = edit.draft.findIndex(d => d.id === dash.id);
    const btn = (attrs, label, cls = 'border border-slate-300 bg-white hover:bg-slate-100') =>
      `<button type="button" ${attrs} class="px-3 py-1.5 text-sm rounded-md ${cls}">${label}</button>`;
    return `
      <div class="flex flex-wrap items-center gap-2 mb-3">
        ${btn('data-dash-add', '+ ' + t('dash.addWidget'), 'bg-blue-600 text-white hover:bg-blue-700')}
        ${btn('data-dash-rename', t('dash.rename'))}
        ${btn(`data-dash-move="-1" ${i <= 0 ? 'disabled' : ''} title="${attr(t('dash.moveLeft'))}"`, '◀')}
        ${btn(`data-dash-move="1" ${i >= edit.draft.length - 1 ? 'disabled' : ''} title="${attr(t('dash.moveRight'))}"`, '▶')}
        ${btn('data-dash-delete', t('dash.delete'), 'border border-rose-300 text-rose-700 bg-white hover:bg-rose-50')}
        <span class="flex-1"></span>
        ${btn('data-dash-cancel', t('modal.cancel'))}
        ${btn('data-dash-done', t('dash.done'), 'bg-blue-600 text-white hover:bg-blue-700')}
      </div>`;
  }
  return `
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3 text-sm text-slate-600">
      <label class="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" data-dash-start class="accent-blue-600" ${isStart ? 'checked' : ''} />${t('dash.startPage')}</label>
      <label class="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" data-dash-kiosk class="accent-blue-600" ${isKioskDash ? 'checked' : ''} />${t('dash.kiosk')}</label>
      <span class="flex-1"></span>
      ${isAdmin() ? `<button type="button" data-dash-edit class="hidden sm:inline-block px-3 py-1.5 text-sm rounded-md border border-slate-300 bg-white hover:bg-slate-100">${t('dash.edit')}</button>` : ''}
    </div>`;
}

// Full render of the dashboard tab.
function renderDashboardTab() {
  const root = $('#tab-dashboard');
  if (!root || !currentId) return;
  const list = edit ? edit.draft : state.dashboards;
  const dash = findDash(currentId, list);
  if (!dash) { root.innerHTML = ''; return; }
  const empty = !dash.widgets.length && !edit
    ? `<p class="bg-white border border-slate-200 rounded-lg p-6 text-sm text-slate-600">${t('dash.empty')}${isAdmin() ? ' ' + t('dash.emptyAdmin') : ''}</p>` : '';
  root.innerHTML = toolbarHtml(dash) + (empty || gridHtml(dash, !!edit));
  renderedLang = state.lang;
  afterRender(root, dash);
}

// Live update (SSE / reload): only the widgets that show live state, and
// nothing while editing — the draft must not be disturbed mid-drag.
function refreshLive(root, dash) {
  for (const body of $$('[data-w-body]', root)) {
    const w = dash.widgets.find(x => x.id === body.closest('[data-w]')?.dataset.w);
    if (!w || !LIVE.has(w.type)) continue;
    body.innerHTML = safeBody(w);
  }
  afterRender(root, dash, { charts: false });
}

function refreshDashboard() {
  if (edit || !currentId || !state.loaded) return;
  const root = $('#tab-dashboard');
  const dash = findDash(currentId);
  if (!root || !dash) return;
  // First render after load, a dashboard switch or a language change → full render.
  const grid = $('[data-dash-grid]', root);
  if (!grid || grid.dataset.dashGrid !== dash.id || renderedLang !== state.lang) renderDashboardTab();
  else refreshLive(root, dash);
}

// Called by tabs.js when a tab is selected; id = dashboard id or null.
function showDashboard(id) {
  if (edit && edit.id !== id) edit = null; // leaving the tab drops unsaved edits
  currentId = id;
  if (id) renderDashboardTab();
  else if ($('#tab-dashboard')) $('#tab-dashboard').innerHTML = '';
}

// ---- kiosk -----------------------------------------------------------------
// Kiosk content when this browser picked a dashboard for it; null otherwise.
function kioskDashboardHtml() {
  const dash = kioskDashboard();
  return dash ? gridHtml(dash, false) : null;
}
function wireKioskDashboard(root) {
  const dash = kioskDashboard();
  if (dash) afterRender(root, dash);
}

// ---- editing ---------------------------------------------------------------
function startEdit() {
  if (!isAdmin() || !currentId) return;
  edit = { id: currentId, draft: clone(state.dashboards) };
  renderDashboardTab();
}
const draftDash = () => edit && findDash(edit.id, edit.draft);

async function finishEdit() {
  const draft = edit.draft;
  try {
    await save(draft);
    edit = null;
    renderDashboardTab();
  } catch (err) { alert(t('error.generic', err.message)); }
}

// Re-applies grid positions of the draft to the DOM without re-rendering
// widget content (keeps drags smooth).
function applyPositions(root, dash) {
  for (const w of dash.widgets) {
    const el = $(`[data-w="${CSS.escape(w.id)}"]`, root);
    if (el) el.setAttribute('style', placeStyle(w));
  }
  const spacer = $('[data-dash-spacer]', root);
  if (spacer) spacer.style.gridRow = String(bottom(dash.widgets) + 4);
}

// Push every widget that overlaps `fixed` (directly or via the chain) down.
// Others start from their positions at drag start (`orig`).
function resolveCollisions(dash, fixed, orig) {
  for (const w of dash.widgets) if (w !== fixed) { w.x = orig.get(w.id).x; w.y = orig.get(w.id).y; }
  const placed = [fixed];
  for (const w of sorted(dash.widgets.filter(x => x !== fixed))) {
    let hit;
    while ((hit = placed.find(p => overlaps(p, w)))) w.y = hit.y + hit.h;
    placed.push(w);
  }
}

function startDrag(e, el, mode) {
  const dash = draftDash();
  const grid = el.closest('[data-dash-grid]');
  const w = dash?.widgets.find(x => x.id === el.dataset.w);
  if (!w || !grid) return;
  e.preventDefault();
  const rect = grid.getBoundingClientRect();
  const colStep = (rect.width + GAP) / COLS, rowStep = ROW + GAP;
  const start = { x: w.x, y: w.y, w: w.w, h: w.h, px: e.clientX, py: e.clientY };
  const orig = new Map(dash.widgets.map(x => [x.id, { x: x.x, y: x.y }]));
  el.classList.add('dragging');
  const target = e.currentTarget;
  target.setPointerCapture?.(e.pointerId);
  const move = (ev) => {
    const dx = Math.round((ev.clientX - start.px) / colStep);
    const dy = Math.round((ev.clientY - start.py) / rowStep);
    if (mode === 'move') {
      w.x = Math.min(COLS - w.w, Math.max(0, start.x + dx));
      w.y = Math.max(0, start.y + dy);
    } else {
      w.w = Math.min(COLS - w.x, Math.max(1, start.w + dx));
      w.h = Math.min(MAX_H, Math.max(1, start.h + dy));
    }
    resolveCollisions(dash, w, orig);
    applyPositions(grid, dash);
  };
  const up = () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    el.classList.remove('dragging');
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

// ---- widget config dialog ----------------------------------------------------
const roomSorted = () => [...state.rooms].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'de'));
const selectedAttr = (a, b) => (a === b ? 'selected' : '');

// <option>s of all configured devices, grouped by room.
function deviceOptions(selected, filter = () => true) {
  const groups = roomSorted().map(r => {
    const devs = state.devices.filter(d => d.roomId === r.id && d.status !== 'DISCOVERED' && filter(d))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, 'de'));
    return devs.length ? `<optgroup label="${attr(r.name)}">${devs.map(d =>
      `<option value="${attr(d.id)}" ${selectedAttr(d.id, selected)}>${escapeHtml(d.deviceModel === 'ROOM_CLIMATE_CONTROL' ? t('dash.roomClimate') : (d.name || d.id))}</option>`).join('')}</optgroup>` : '';
  }).join('');
  return `<option value="">${t('dash.choose')}</option>${groups}`;
}

const field = (label, control) =>
  `<label class="block text-sm mb-3"><span class="block text-xs text-slate-500 mb-1">${label}</span>${control}</label>`;
const inputCls = 'w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white';

function configFields(type, c) {
  const title = field(t('dash.f.title'), `<input data-cfg="title" class="${inputCls}" value="${attr(c.title)}" />`);
  switch (type) {
    case 'device':
      return field(t('dash.f.device'), `<select data-cfg="deviceId" class="${inputCls}">${deviceOptions(c.deviceId)}</select>`);
    case 'scenario':
      return field(t('dash.f.scenario'), `<select data-cfg="scenarioId" class="${inputCls}">
        <option value="">${t('dash.choose')}</option>
        ${state.scenarios.map(s => `<option value="${attr(s.id)}" ${selectedAttr(s.id, c.scenarioId)}>${escapeHtml(s.name || s.id)}</option>`).join('')}</select>`);
    case 'room':
      return field(t('dash.f.room'), `<select data-cfg="roomId" class="${inputCls}">
        <option value="">${t('dash.choose')}</option>
        ${roomSorted().map(r => `<option value="${attr(r.id)}" ${selectedAttr(r.id, c.roomId)}>${escapeHtml(r.name)}</option>`).join('')}</select>`) + title;
    case 'chart':
      return field(t('dash.f.device'), `<select data-cfg="deviceId" class="${inputCls}">${deviceOptions(c.deviceId)}</select>`)
        + field(t('dash.f.metric'), `<select data-cfg="metric" class="${inputCls}">${METRIC_ORDER.filter(m => m !== 'setpoint').map(m =>
            `<option value="${m}" ${selectedAttr(m, c.metric || 'temperature')}>${t('history.m.' + m)}</option>`).join('')}</select>`)
        + field(t('dash.f.range'), `<select data-cfg="range" class="${inputCls}">${Object.keys(RANGES).map(r =>
            `<option value="${r}" ${selectedAttr(r, c.range || '24h')}>${t('history.r.' + r)}</option>`).join('')}</select>`)
        + title;
    case 'text':
      return title + field(t('dash.f.text'), `<textarea data-cfg="text" rows="4" class="${inputCls}">${escapeHtml(c.text || '')}</textarea>`);
    case 'energy': case 'health': case 'messages': case 'divider':
      return title;
    default:
      return '';
  }
}

// Chart: offer only the metrics the chosen device actually records.
async function narrowMetrics() {
  const dev = $('#modal-card [data-cfg="deviceId"]')?.value;
  const sel = $('#modal-card [data-cfg="metric"]');
  if (!dev || !sel) return;
  let metrics;
  try { metrics = (await api(`api/history/series?deviceId=${encodeURIComponent(dev)}`)).metrics || []; }
  catch { return; }
  const keep = METRIC_ORDER.filter(m => metrics.includes(m) && m !== 'setpoint');
  if (!keep.length) return;
  const cur = keep.includes(sel.value) ? sel.value : keep[0];
  sel.innerHTML = keep.map(m => `<option value="${m}" ${selectedAttr(m, cur)}>${t('history.m.' + m)}</option>`).join('');
}

function openWidgetDialog(existing) {
  const dash = draftDash();
  if (!dash) return;
  let type = existing?.type || 'device';
  const render = () => {
    const c = existing?.cfg || {};
    showModal(`
      <h4 class="font-medium mb-3">${t(existing ? 'dash.widgetSettings' : 'dash.addWidget')}</h4>
      ${existing ? '' : field(t('dash.f.type'), `<select id="w-type" class="${inputCls}">${Object.keys(TYPES).map(k =>
        `<option value="${k}" ${selectedAttr(k, type)}>${t('dash.type.' + k)}</option>`).join('')}</select>`)}
      <div id="w-fields">${configFields(type, c)}</div>
      <div class="mt-4 flex justify-end gap-2">
        <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
        <button id="m-ok" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md">${t(existing ? 'modal.save' : 'dash.addOk')}</button>
      </div>`);
    $('#w-type')?.addEventListener('change', (e) => { type = e.target.value; render(); });
    $('#modal-card [data-cfg="deviceId"]')?.addEventListener('change', narrowMetrics);
    if (type === 'chart') narrowMetrics();
    $('#m-cancel').onclick = hideModal;
    $('#m-ok').onclick = () => {
      const cfg = {};
      for (const el of $$('#modal-card [data-cfg]')) if (el.value.trim()) cfg[el.dataset.cfg] = el.value.trim();
      const need = { device: 'deviceId', scenario: 'scenarioId', room: 'roomId', chart: 'deviceId' }[type];
      if (need && !cfg[need]) { $(`#modal-card [data-cfg="${need}"]`)?.focus(); return; }
      if (existing) existing.cfg = cfg;
      else {
        const size = TYPES[type];
        dash.widgets.push({ id: newId('w'), type, x: 0, y: bottom(dash.widgets), w: size.w, h: size.h, cfg });
      }
      hideModal();
      renderDashboardTab();
    };
  };
  render();
}

// ---- events ------------------------------------------------------------------
function moveDashboard(dir) {
  const i = edit.draft.findIndex(d => d.id === edit.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= edit.draft.length) return;
  [edit.draft[i], edit.draft[j]] = [edit.draft[j], edit.draft[i]];
  renderDashboardTab();
}

function onClick(e) {
  if (e.target.closest('[data-dash-create]')) { createDashboard(); return; }
  const go = e.target.closest('[data-dash-goto]');
  if (go) { selectTab(go.dataset.dashGoto); return; }
  const root = $('#tab-dashboard');
  if (!root?.contains(e.target)) return;
  if (e.target.closest('[data-dash-edit]')) { if (!narrow()) startEdit(); return; }
  if (!edit) return;
  const dash = draftDash();
  if (e.target.closest('[data-dash-add]')) openWidgetDialog(null);
  else if (e.target.closest('[data-dash-done]')) finishEdit();
  else if (e.target.closest('[data-dash-cancel]')) { edit = null; renderDashboardTab(); }
  else if (e.target.closest('[data-dash-rename]')) promptModal(t('dash.rename'), dash.name, (name) => { dash.name = name; renderDashboardTab(); });
  else if (e.target.closest('[data-dash-move]')) moveDashboard(Number(e.target.closest('[data-dash-move]').dataset.dashMove));
  else if (e.target.closest('[data-dash-delete]')) {
    confirmModal(escapeHtml(t('dash.deleteConfirm', dash.name)), async () => {
      const next = state.dashboards.filter(d => d.id !== dash.id);
      edit = null;
      if (store.get(KIOSK_KEY) === dash.id) store.set(KIOSK_KEY, null);
      if (store.get(START_KEY) === 'dash:' + dash.id) store.set(START_KEY, null);
      await save(next);
    });
  } else {
    const el = e.target.closest('[data-w]');
    const w = el && dash.widgets.find(x => x.id === el.dataset.w);
    if (!w) return;
    if (e.target.closest('[data-w-config]')) openWidgetDialog(w);
    else if (e.target.closest('[data-w-remove]')) {
      dash.widgets = dash.widgets.filter(x => x !== w);
      renderDashboardTab();
    }
  }
}

function onChange(e) {
  if (!currentId) return;
  if (e.target.matches('[data-dash-start]')) store.set(START_KEY, e.target.checked ? 'dash:' + currentId : null);
  if (e.target.matches('[data-dash-kiosk]')) setKioskDashboard(e.target.checked ? currentId : null);
}

function onPointerDown(e) {
  if (!edit || e.button !== 0) return;
  const el = e.target.closest('#tab-dashboard [data-w]');
  if (!el || e.target.closest('[data-w-config],[data-w-remove]')) return;
  startDrag(e, el, e.target.closest('[data-w-resize]') ? 'resize' : 'move');
}

// Delegated listeners, wired once from boot.
function initDashboards() {
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('pointerdown', onPointerDown);
}

export { initDashboards, renderDashboardNav, showDashboard, refreshDashboard, startTab, kioskDashboardHtml, wireKioskDashboard, setKioskDashboard };
