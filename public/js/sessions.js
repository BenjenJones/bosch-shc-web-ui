import { state, $, $$, t, api, isAdmin, escapeHtml } from './core.js';
import { confirmModal } from './modals.js';

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

export { loadSessions, renderSessions };
