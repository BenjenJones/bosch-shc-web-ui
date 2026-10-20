import { state, $, $$, t, escapeHtml, roomName, serviceOf, deviceUpdateInfo, deviceBatteryLevel, deviceFaults } from './core.js';
import { deviceIcon, commQualityInfo, batteryInfo, faultChip, requestCommQualityTest } from './devices.js';

// =========================================================================
//  Health tab — one place to see which devices need attention: unreachable,
//  low battery, faults, poor signal, pending firmware updates. Purely derived
//  from state.devices/services/messages, so live events keep it current.
// =========================================================================

// Severity scale shared by issues and rows: 3 error, 2 warning, 1 info, 0 ok.
const SEV_CHIP = {
  3: { box: 'bg-rose-50 text-rose-700',   dot: 'bg-rose-500' },
  2: { box: 'bg-amber-50 text-amber-800', dot: 'bg-amber-500' },
  1: { box: 'bg-blue-50 text-blue-800',   dot: 'bg-blue-600' },
};
const KINDS = ['offline', 'battery', 'faults', 'signal', 'updates'];
// Worst first; unknown/fetching sort last.
const CQ_ORDER = ['BAD', 'MEDIUM', 'NORMAL', 'GOOD', 'FETCHING', 'UNKNOWN'];

// Tile filter (null = show all issues) and collapsed <details> sections.
let kindFilter = null;
const SECT_KEY = 'healthSectionsOpen';
const openSections = (() => {
  try { return JSON.parse(localStorage.getItem(SECT_KEY)) || { batteries: true }; }
  catch { return { batteries: true }; }
})();

// Real, physical devices only — skip the per-room virtual climate controllers
// and room-less virtual entities (intrusion system, SHC itself, …) unless
// they report a battery or radio link.
function healthDevices() {
  return state.devices.filter(d => d.deviceModel !== 'ROOM_CLIMATE_CONTROL' &&
    (d.roomId || serviceOf(d.id, 'BatteryLevel') || serviceOf(d.id, 'CommunicationQuality')));
}

function batterySeverity(level) {
  if (!level || level === 'OK' || level === 'NOT_AVAILABLE') return 0;
  if (level === 'LOW_BATTERY') return 2;
  if (/CRITICAL|INSERT/.test(level)) return 3;
  return 1;
}

const chip = (sev, label, title = '') => {
  const c = SEV_CHIP[sev];
  return `<span class="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded text-xs font-medium ${c.box}"
    ${title ? `title="${escapeHtml(title)}"` : ''}>
    <span class="w-1.5 h-1.5 rounded-full ${c.dot}"></span>${escapeHtml(label)}</span>`;
};

// All issues of one device: [{ kind, severity, html }].
function deviceIssues(d) {
  const issues = [];
  // UNAVAILABLE, COMMUNICATION_ERROR, … — anything but a healthy or
  // not-applicable (UNDEFINED, virtual devices) status.
  if (d.status && d.status !== 'AVAILABLE' && d.status !== 'UNDEFINED') {
    issues.push({ kind: 'offline', severity: 3, html: chip(3, t('health.chipOffline'), d.status) });
  }
  const level = deviceBatteryLevel(d);
  const bSev = batterySeverity(level);
  if (bSev) {
    issues.push({ kind: 'battery', severity: bSev,
      html: chip(bSev, t('health.chipBattery', batteryInfo(level).label), level) });
  }
  for (const f of deviceFaults(d)) {
    issues.push({ kind: 'faults', severity: f.category === 'WARNING' ? 2 : 3, html: faultChip(f) });
  }
  const q = serviceOf(d.id, 'CommunicationQuality')?.state?.quality;
  if (q === 'BAD') {
    issues.push({ kind: 'signal', severity: 2,
      html: chip(2, t('health.chipSignal', commQualityInfo(q).label), q) });
  }
  const u = deviceUpdateInfo(d);
  if (u.hasUpdate) {
    issues.push({ kind: 'updates', severity: 1,
      html: chip(1, t('health.chipUpdate', u.targetVersion || ''), u.stateText || '') });
  }
  return issues;
}

const maxSeverity = (issues) => issues.reduce((m, i) => Math.max(m, i.severity), 0);
const byName = (a, b) => (a.name || a.id).localeCompare(b.name || b.id);
const roomLabel = (d) => d.roomId ? roomName(d.roomId) : t('health.noRoom');

function deviceHead(d) {
  return `
    <div class="flex items-center gap-2 min-w-0">
      <img src="svg/${deviceIcon(d)}.svg" style="width:18px;height:18px" class="shrink-0" alt="" />
      <div class="min-w-0">
        <div class="truncate">${escapeHtml(d.name || d.id)}</div>
        <div class="text-xs text-slate-500 truncate">${escapeHtml(roomLabel(d))} · ${escapeHtml(d.deviceModel || '')}</div>
      </div>
    </div>`;
}

function section(key, title, body) {
  return `
    <details data-health-sect="${key}" class="bg-white rounded-lg border border-slate-200" ${openSections[key] ? 'open' : ''}>
      <summary class="cursor-pointer select-none px-4 py-3 font-medium">${title}</summary>
      <div class="px-4 pb-3">${body}</div>
    </details>`;
}

// Tab badge: number of devices with at least one warning or error.
function updateHealthBadge(rows) {
  const badge = $('#health-badge');
  if (!badge) return;
  const n = rows.filter(r => r.severity >= 2).length;
  const hasError = rows.some(r => r.severity >= 3);
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
  badge.classList.toggle('bg-rose-500', hasError);
  badge.classList.toggle('bg-amber-500', !hasError);
}

function renderHealth() {
  const root = $('#tab-health');
  if (!root) return;
  const devices = healthDevices();
  const rows = devices.map(d => {
    const issues = deviceIssues(d);
    return { d, issues, severity: maxSeverity(issues) };
  });
  updateHealthBadge(rows);

  // ---- Summary tiles ----------------------------------------------------
  const countOf = (kind) => rows.filter(r => r.issues.some(i => i.kind === kind)).length;
  const tiles = KINDS.map(kind => {
    const n = countOf(kind);
    const sev = n === 0 ? 0 : maxSeverity(rows.flatMap(r => r.issues.filter(i => i.kind === kind)));
    const tone = sev >= 3 ? 'bg-rose-50 border-rose-200 text-rose-700'
               : sev === 2 ? 'bg-amber-50 border-amber-200 text-amber-800'
               : sev === 1 ? 'bg-blue-50 border-blue-400 text-blue-800'
               : 'bg-white border-slate-200 text-slate-500';
    const active = kindFilter === kind;
    return `
      <button data-health-kind="${kind}" aria-pressed="${active}"
        class="text-left rounded-lg border p-3 ${tone} ${active ? 'ring-2 ring-blue-600' : ''}">
        <div class="text-2xl font-light tabular-nums">${n}</div>
        <div class="text-xs">${t('health.' + kind)}</div>
      </button>`;
  }).join('');

  // ---- Issue list -------------------------------------------------------
  const problems = rows
    .map(r => kindFilter ? { ...r, issues: r.issues.filter(i => i.kind === kindFilter) } : r)
    .filter(r => r.issues.length)
    .map(r => ({ ...r, severity: maxSeverity(r.issues) }))
    .sort((a, b) => b.severity - a.severity || byName(a.d, b.d));
  const problemsBody = problems.length
    ? `<ul class="divide-y divide-slate-200">${problems.map(r => `
        <li class="py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5">
          ${deviceHead(r.d)}
          <div class="flex flex-wrap gap-1 sm:justify-end">${r.issues.map(i => i.html).join('')}</div>
        </li>`).join('')}</ul>`
    : `<p class="text-sm text-emerald-700 py-2">${t(kindFilter ? 'health.noneOfKind' : 'health.allGood')}</p>`;

  // ---- All battery devices, worst first ---------------------------------
  const batteries = devices
    .map(d => ({ d, level: deviceBatteryLevel(d) }))
    .filter(b => b.level && b.level !== 'NOT_AVAILABLE')
    .sort((a, b) => batterySeverity(b.level) - batterySeverity(a.level) || byName(a.d, b.d));
  const batteriesBody = batteries.length
    ? `<ul class="divide-y divide-slate-200">${batteries.map(({ d, level }) => {
        const b = batteryInfo(level);
        return `
        <li class="py-2 flex items-center justify-between gap-3">
          ${deviceHead(d)}
          <span class="${b.cls} inline-flex items-center gap-1 text-xs shrink-0">
            <img src="svg/${b.icon}.svg" style="width:16px;height:16px" alt="" /> ${escapeHtml(b.label)}</span>
        </li>`;
      }).join('')}</ul>`
    : `<p class="text-sm text-slate-500 py-2">${t('health.noBatteries')}</p>`;

  // ---- Signal quality, worst first --------------------------------------
  const rank = (q) => { const i = CQ_ORDER.indexOf(q); return i < 0 ? CQ_ORDER.length : i; };
  const radios = devices
    .map(d => ({ d, q: serviceOf(d.id, 'CommunicationQuality')?.state?.quality }))
    .filter(r => r.q)
    .sort((a, b) => rank(a.q) - rank(b.q) || byName(a.d, b.d));
  const signalBody = radios.length
    ? `<p class="text-xs text-slate-500 pt-1">${t('health.signalHint')}</p>
      <ul class="divide-y divide-slate-200">${radios.map(({ d, q }) => {
        const cq = commQualityInfo(q);
        const url = `svg/${cq.icon}.svg`;
        return `
        <li class="py-2 flex items-center justify-between gap-3">
          ${deviceHead(d)}
          <span class="inline-flex items-center gap-3 shrink-0">
            <span class="inline-flex items-center gap-1.5 text-xs ${cq.cls}">
              <span class="icon-mask" style="width:16px;height:16px;mask-image:url(${url});-webkit-mask-image:url(${url})"></span>
              ${escapeHtml(cq.label)}</span>
            <button type="button" data-cq-test="${escapeHtml(d.id)}" ${q === 'FETCHING' ? 'disabled' : ''}
              class="text-xs text-blue-600 hover:underline disabled:text-slate-400 disabled:no-underline"
              title="${t('commQuality.testHint')}">${t('commQuality.test')}</button>
          </span>
        </li>`;
      }).join('')}</ul>`
    : `<p class="text-sm text-slate-500 py-2">${t('health.noSignal')}</p>`;

  root.innerHTML = `
    <div class="space-y-4 max-w-4xl">
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">${tiles}</div>
      <div class="bg-white rounded-lg border border-slate-200 px-4 py-3">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="font-medium">${t('health.issues', problems.length)}</h2>
          ${kindFilter ? `<button data-health-kind="${kindFilter}" class="text-xs text-blue-600 hover:underline">${t('health.clearFilter')}</button>` : ''}
        </div>
        ${problemsBody}
      </div>
      ${section('batteries', t('health.batteries', batteries.length), batteriesBody)}
      ${section('signal', t('health.signalList', radios.length), signalBody)}
    </div>`;

  // Clicking the active tile (or "show all") clears the filter.
  $$('[data-cq-test]', root).forEach(b => b.addEventListener('click', () => requestCommQualityTest(b.dataset.cqTest)));
  $$('[data-health-kind]', root).forEach(b => b.addEventListener('click', () => {
    kindFilter = kindFilter === b.dataset.healthKind ? null : b.dataset.healthKind;
    renderHealth();
  }));
  $$('[data-health-sect]', root).forEach(el => el.addEventListener('toggle', () => {
    openSections[el.dataset.healthSect] = el.open;
    try { localStorage.setItem(SECT_KEY, JSON.stringify(openSections)); } catch { /* ignore */ }
  }));
}

export { renderHealth, deviceIssues, batterySeverity };
