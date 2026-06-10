import { $, t } from './core.js';

function showModal(html) {
  $('#modal-card').innerHTML = html;
  $('#modal-root').classList.remove('hidden');
}
function hideModal() {
  $('#modal-root').classList.add('hidden');
  // If we previously switched to a wider modal, reset to normal width
  $('#modal-card').classList.remove('max-w-2xl');
  $('#modal-card').classList.add('max-w-md');
}
function initModals() {
  $('#modal-root').addEventListener('click', (e) => {
    if (e.target.id === 'modal-root') hideModal();
  });
}

function confirmModal(message, onConfirm) {
  showModal(`
    <p class="text-sm">${message}</p>
    <div class="mt-4 flex justify-end gap-2">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="m-ok" class="px-3 py-1.5 text-sm bg-rose-600 text-white rounded-md">${t('modal.confirm')}</button>
    </div>`);
  $('#m-cancel').onclick = hideModal;
  $('#m-ok').onclick = async () => {
    try { await onConfirm(); hideModal(); }
    catch (err) { alert(t('error.generic', err.message)); }
  };
}
function promptModal(title, defaultValue, onSave) {
  showModal(`
    <h4 class="font-medium mb-2">${title}</h4>
    <input id="m-input" class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
      value="${(defaultValue||'').replace(/"/g, '&quot;')}" />
    <div class="mt-4 flex justify-end gap-2">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="m-ok" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md">${t('modal.save')}</button>
    </div>`);
  const input = $('#m-input'); input.focus(); input.select();
  $('#m-cancel').onclick = hideModal;
  $('#m-ok').onclick = async () => {
    const v = input.value.trim();
    if (!v) return;
    try { await onSave(v); hideModal(); }
    catch (err) { alert(t('error.generic', err.message)); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#m-ok').click(); });
}

export { showModal, hideModal, confirmModal, promptModal, initModals };
