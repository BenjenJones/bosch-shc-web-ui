import { state, $, t, api, escapeHtml, isAdmin } from './core.js';
import { showModal, hideModal } from './modals.js';

// =========================================================================
//  Pairing health — when the SHC rejects our client certificate the server
//  reports `pairingLost` (via /api/setup/status and the SSE status event).
//  Typical cause: another install paired with the same client id, or the
//  client was removed in the Bosch app. Admins can re-pair from here without
//  losing users, history or settings (POST /api/setup/repair).
// =========================================================================

function renderPairingBanner() {
  const el = $('#pairing-banner');
  if (!el) return;
  if (!state.pairing?.lost) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="rounded-lg border border-rose-200 bg-rose-50 text-rose-800 p-3 text-sm flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
      <div>
        <div class="font-medium">${t('pairing.lostTitle')}</div>
        <div class="text-xs mt-0.5">${t(isAdmin() ? 'pairing.lostHint' : 'pairing.lostHintUser')}</div>
      </div>
      ${isAdmin() ? `<button data-repair class="shrink-0 px-3 py-1.5 text-sm bg-rose-600 text-white rounded-md hover:bg-rose-700">${t('pairing.repair')}</button>` : ''}
    </div>`;
}

function openRepairModal() {
  showModal(`
    <h4 class="font-medium mb-1">${t('pairing.repairTitle')}</h4>
    <p class="text-xs text-slate-500 mb-3">${t('pairing.repairIntro')}</p>
    <label class="text-xs text-slate-500 block mb-1" for="rp-ip">${t('setup.ipLabel')}</label>
    <input id="rp-ip" class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm mb-3"
      value="${escapeHtml(state.pairing?.shcIp || state.info?.shcIpAddress || '')}" />
    <div class="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-900 mb-3">${t('setup.pairHint')}</div>
    <label class="text-xs text-slate-500 block mb-1" for="rp-pass">${t('setup.passLabel')}</label>
    <input id="rp-pass" type="password" autocomplete="off" class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
    <p id="rp-msg" class="hidden text-xs mt-2"></p>
    <div class="mt-4 flex justify-end gap-2">
      <button id="rp-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="rp-ok" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">${t('pairing.repair')}</button>
    </div>`);
  $('#rp-pass').focus();
  $('#rp-cancel').onclick = hideModal;
  const msg = (text, ok) => {
    const m = $('#rp-msg');
    m.textContent = text;
    m.classList.remove('hidden');
    m.classList.toggle('text-rose-600', !ok);
    m.classList.toggle('text-emerald-700', !!ok);
  };
  $('#rp-ok').onclick = async () => {
    const password = $('#rp-pass').value;
    if (!password) return;
    $('#rp-ok').disabled = true;
    try {
      const r = await api('api/setup/repair', { method: 'POST', body: { password, shcIp: $('#rp-ip').value.trim() } });
      msg(t('pairing.done', r.clientId), true);
      setTimeout(() => location.reload(), 1500);
    } catch (err) {
      msg(t('error.generic', err.message), false);
      $('#rp-ok').disabled = false;
    }
  };
  $('#rp-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#rp-ok').click(); });
}

// Delegated once from boot: banner button and the Admin → Controller button.
function initPairing() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-repair]')) openRepairModal();
  });
}

export { initPairing, renderPairingBanner, openRepairModal };
