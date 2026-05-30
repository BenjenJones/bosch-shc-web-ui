import { state, $, $$, t, api, escapeHtml, deviceName, roomName, I18N } from './core.js';

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


export { messageTitle, severityFromMessage, describeArguments, renderMessages };
