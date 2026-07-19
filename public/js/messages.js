import { state, $, $$, t, api, escapeHtml, deviceName, roomName, I18N, isMessageActive } from './core.js';
import { renderDeviceList } from './devices.js';

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

// Shared inner block (title, source, date, args, technical details) used by
// both the active list and the archive list below it.
function messageInner(m, dateLocale) {
  const codeName = m.messageCode?.name || 'UNKNOWN';
  const title = messageTitle(codeName);
  let source = m.sourceName || (m.sourceId && deviceName(m.sourceId)) || m.sourceId || '';
  if (m.location) source = m.location + ' - ' + source;
  const date = m.timestamp ? new Date(Number(m.timestamp)).toLocaleString(dateLocale) : '';
  const archivedAt = m.archivedAt ? new Date(Number(m.archivedAt)).toLocaleString(dateLocale) : '';
  const argsHtml = describeArguments(m.arguments);
  return `
    <div class="flex-1 min-w-0">
      <div class="font-medium">${title}</div>
      <div class="text-xs text-slate-500 mt-0.5">
        ${source ? `<span>${source}</span>` : ''}
        ${source && date ? ' · ' : ''}
        ${date ? `<span>${date}</span>` : ''}
      </div>
      ${archivedAt ? `<div class="text-xs text-slate-500 mt-0.5">${t('messages.archive.at', archivedAt)}</div>` : ''}
      ${argsHtml ? `<div class="text-xs mt-1.5">${argsHtml}</div>` : ''}
      <details class="mt-1.5 text-xs text-slate-400">
        <summary class="cursor-pointer hover:text-slate-600">${t('messages.technical')}</summary>
        <pre class="mt-1 bg-slate-50 p-2 rounded overflow-auto">${escapeHtml(JSON.stringify(m, null, 2))}</pre>
      </details>
    </div>`;
}

function activeItem(m, dateLocale) {
  const sev = severityFromMessage(m);
  const sevClass = {
    error:   'bg-rose-100 text-rose-700',
    warning: 'bg-amber-100 text-amber-700',
    info:    'bg-slate-100 text-slate-600',
  }[sev];
  const sevLabel = t(`messages.sev.${sev}`);
  return `
    <li class="p-4 text-sm flex items-start gap-3">
      <span class="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${sevClass} mt-0.5">${sevLabel}</span>
      ${messageInner(m, dateLocale)}
      <button data-dismiss="${m.id}" title="${t('messages.dismiss')}"
        class="text-slate-400 hover:text-rose-600 text-xl leading-none">×</button>
    </li>`;
}

function archiveItem(m, dateLocale) {
  return `
    <li class="p-4 text-sm flex items-start gap-3 opacity-75">
      <span class="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 mt-0.5">${t('messages.archive.badge')}</span>
      ${messageInner(m, dateLocale)}
      <button data-archive-del="${m.id}" title="${t('messages.archive.delete')}"
        class="text-slate-400 hover:text-rose-600 text-xl leading-none">×</button>
    </li>`;
}

// Collapsed-state of the archive (whole list + per-day groups), persisted so it
// survives the re-render each dismiss/delete triggers. Keys: 'outer' for the
// whole archive, day-bucket ms for each day group.
const ARCH_COLLAPSE_KEY = 'msgArchiveCollapsed';
function loadArchCollapsed() {
  try { return JSON.parse(localStorage.getItem(ARCH_COLLAPSE_KEY)) || {}; } catch { return {}; }
}
function saveArchCollapsed(o) {
  try { localStorage.setItem(ARCH_COLLAPSE_KEY, JSON.stringify(o)); } catch { /* ignore */ }
}

// Day bucket key (local midnight ms) + human label for an archived message.
function dayKey(m) {
  const ts = Number(m.archivedAt || m.timestamp || 0);
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabel(keyMs, dateLocale) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - keyMs) / 86400000);
  if (diff === 0) return t('messages.archive.today');
  if (diff === 1) return t('messages.archive.yesterday');
  return new Date(keyMs).toLocaleDateString(dateLocale, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

// Group archived messages into day buckets, newest day first, newest message
// first within each day.
function groupByDay(archive) {
  const buckets = new Map();
  for (const m of archive) {
    const k = dayKey(m);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(m);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([k, msgs]) => [k, msgs.sort((x, y) => (y.archivedAt||0) - (x.archivedAt||0))]);
}

// Move a message into the server-side archive. Updates local state
// synchronously (so the next render shows it) and persists best-effort —
// archiving must never block the dismiss it accompanies.
async function archiveMessage(m) {
  if (!m || !m.id) return;
  const entry = { ...m, archivedAt: m.archivedAt || Date.now() };
  state.messageArchive = [entry, ...state.messageArchive.filter(x => x.id !== m.id)];
  try {
    await api('/api/messages/archive', { method: 'POST', body: entry });
  } catch (_) { /* keep the optimistic local copy; it'll reconcile on reload */ }
}

function renderMessages() {
  // Hide deleted messages and ones already archived ("marked read").
  const visible = state.messages.filter(isMessageActive);
  // Badge mit Anzahl der nicht-info-Messages
  const importantCount = visible.filter(m => severityFromMessage(m) !== 'info').length;
  const badge = $('#msg-badge');
  if (importantCount > 0) { badge.textContent = importantCount; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');

  const dateLocale = state.lang === 'en' ? 'en-GB' : 'de-DE';
  const sorted = [...visible].sort((a, b) => (b.timestamp||0) - (a.timestamp||0));

  const activeHtml = visible.length
    ? `<ul class="bg-white rounded-lg border border-slate-200 divide-y">
        ${sorted.map(m => activeItem(m, dateLocale)).join('')}
      </ul>`
    : `<p class="text-slate-500">${t('messages.none')}</p>`;

  // Second list: no-longer-active messages, grouped by day, newest day first.
  // Whole archive and each day group are collapsible; open/closed state is
  // persisted in localStorage. Defaults: outer open, newest day open, rest shut.
  const archive = [...state.messageArchive];
  const days = groupByDay(archive);
  // Drop stored collapse flags for days no longer present (each day-key is an
  // absolute date, so without pruning localStorage grows without bound).
  const collapsed = loadArchCollapsed();
  const liveKeys = new Set(['outer', ...days.map(([k]) => String(k))]);
  const pruned = Object.fromEntries(Object.entries(collapsed).filter(([k]) => liveKeys.has(k)));
  if (Object.keys(pruned).length !== Object.keys(collapsed).length) saveArchCollapsed(pruned);
  const isOpen = (key, dflt) => (key in pruned ? !pruned[key] : dflt);
  const daysHtml = days.map(([k, msgs], i) => `
    <details data-arch-day="${k}" class="bg-white rounded-lg border border-slate-200 overflow-hidden" ${isOpen(k, i === 0) ? 'open' : ''}>
      <summary class="cursor-pointer select-none px-4 py-2.5 flex items-center gap-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
        <span class="flex-1">${dayLabel(k, dateLocale)}</span>
        <span class="text-xs text-slate-400">${msgs.length}</span>
      </summary>
      <ul class="border-t border-slate-200 divide-y">
        ${msgs.map(m => archiveItem(m, dateLocale)).join('')}
      </ul>
    </details>`).join('');
  const archiveHtml = `
    <div class="mt-8">
      ${archive.length
        ? `<details data-arch-outer ${isOpen('outer', true) ? 'open' : ''}>
            <summary class="cursor-pointer select-none mb-2 flex items-center gap-2 list-none">
              <span class="chevron text-slate-400 text-xs transition-transform">▼</span>
              <h3 class="text-sm font-semibold text-slate-600 flex-1">${t('messages.archive.title')}</h3>
              <span class="text-xs text-slate-400">${archive.length}</span>
              <button data-archive-clear
                class="text-xs text-slate-400 hover:text-rose-600">${t('messages.archive.clear')}</button>
            </summary>
            <div class="space-y-2">${daysHtml}</div>
          </details>`
        : `<h3 class="text-sm font-semibold text-slate-600 mb-2">${t('messages.archive.title')}</h3>
           <p class="text-slate-500 text-sm">${t('messages.archive.none')}</p>`}
    </div>`;

  $('#tab-messages').innerHTML = activeHtml + archiveHtml;

  // Dismiss an active message: remove it from the SHC, archive a copy, drop it
  // from the active list.
  $$('#tab-messages [data-dismiss]').forEach(b =>
    b.addEventListener('click', async () => {
      const id = b.dataset.dismiss;
      const msg = state.messages.find(x => x.id === id);
      try {
        await api(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (err) {
        // The SHC won't delete some system messages (update/fault notices tied
        // to an active condition). Treat dismiss as "mark read": archive it
        // locally and suppress it from the active list. Any other error is real.
        const code = err.body?.body?.errorCode;
        if (code !== 'ENTITY_NOT_DELETABLE' && !/ENTITY_NOT_DELETABLE/.test(err.message)) {
          alert(t('error.generic', err.message));
          return;
        }
      }
      if (msg) await archiveMessage(msg);
      state.messages = state.messages.filter(x => x.id !== id);
      renderMessages();
      renderDeviceList(); // drop the room marker now that the message is gone
    })
  );

  // Delete a single archived message.
  $$('#tab-messages [data-archive-del]').forEach(b =>
    b.addEventListener('click', async () => {
      const id = b.dataset.archiveDel;
      try {
        await api(`/api/messages/archive/${encodeURIComponent(id)}`, { method: 'DELETE' });
        state.messageArchive = state.messageArchive.filter(x => x.id !== id);
        renderMessages();
      } catch (err) { alert(t('error.generic', err.message)); }
    })
  );

  // Clear the whole archive. Sits inside the archive <summary>, so stop the
  // click from also toggling the collapsible.
  const clearBtn = $('#tab-messages [data-archive-clear]');
  if (clearBtn) clearBtn.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(t('messages.archive.clearConfirm'))) return;
    try {
      await api('/api/messages/archive', { method: 'DELETE' });
      state.messageArchive = [];
      renderMessages();
    } catch (err) { alert(t('error.generic', err.message)); }
  });

  // Persist archive collapse state (whole list + per-day groups).
  const outer = $('#tab-messages details[data-arch-outer]');
  if (outer) outer.addEventListener('toggle', () => {
    const c = loadArchCollapsed();
    c.outer = !outer.open;
    saveArchCollapsed(c);
  });
  $$('#tab-messages details[data-arch-day]').forEach(d => d.addEventListener('toggle', () => {
    const c = loadArchCollapsed();
    c[d.dataset.archDay] = !d.open;
    saveArchCollapsed(c);
  }));
}


export { messageTitle, severityFromMessage, describeArguments, renderMessages, archiveMessage };
