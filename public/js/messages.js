import { state, $, $$, t, api, escapeHtml, deviceName, roomName, I18N } from './core.js';
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
  // Hide messages flagged as deleted
  const visible = state.messages.filter(m => !m.deleted);
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

  // Second list: no-longer-active messages, newest archived first.
  const archive = [...state.messageArchive].sort((a, b) => (b.archivedAt||0) - (a.archivedAt||0));
  const archiveHtml = `
    <div class="mt-8">
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-semibold text-slate-600">${t('messages.archive.title')}</h3>
        ${archive.length ? `<button data-archive-clear
          class="text-xs text-slate-400 hover:text-rose-600">${t('messages.archive.clear')}</button>` : ''}
      </div>
      ${archive.length
        ? `<ul class="bg-white rounded-lg border border-slate-200 divide-y">
            ${archive.map(m => archiveItem(m, dateLocale)).join('')}
          </ul>`
        : `<p class="text-slate-500 text-sm">${t('messages.archive.none')}</p>`}
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
        if (msg) await archiveMessage(msg);
        state.messages = state.messages.filter(x => x.id !== id);
        renderMessages();
        renderDeviceList(); // drop the room marker now that the message is gone
      } catch (err) { alert(t('error.generic', err.message)); }
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

  // Clear the whole archive.
  const clearBtn = $('#tab-messages [data-archive-clear]');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    if (!confirm(t('messages.archive.clearConfirm'))) return;
    try {
      await api('/api/messages/archive', { method: 'DELETE' });
      state.messageArchive = [];
      renderMessages();
    } catch (err) { alert(t('error.generic', err.message)); }
  });
}


export { messageTitle, severityFromMessage, describeArguments, renderMessages, archiveMessage };
