import { state, $, $$, t, api, isAdmin, escapeHtml } from './core.js';
import { showModal, hideModal, confirmModal } from './modals.js';
import { loadSessions } from './sessions.js';

async function loadUsers() {
  if (!isAdmin()) return;
  try { state.users = await api('/api/auth/users') || []; }
  catch (_) { state.users = []; }
  renderUsers();
}

function renderUsers() {
  if (!isAdmin()) return;
  const self = state.auth.user?.username;
  const rows = state.users.map(u => {
    const isSelf = u.username === self;
    const mustChange = u.mustChangePassword
      ? `<span class="ml-2 text-[10px] uppercase tracking-wide text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">${t('users.mustChange')}</span>` : '';
    return `<li class="flex items-center justify-between py-2 gap-2">
      <div class="min-w-0">
        <div class="truncate">${escapeHtml(u.username)} ${mustChange}</div>
        <div class="text-xs text-slate-500">${u.role === 'admin' ? t('auth.roleAdmin') : t('auth.roleUser')}${isSelf ? ' · ' + t('users.you') : ''}</div>
      </div>
      <div class="flex gap-1 shrink-0">
        <button data-user-reset="${escapeHtml(u.username)}"
          class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('users.resetPassword')}</button>
        <button data-user-del="${escapeHtml(u.username)}"
          class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded ${isSelf ? 'opacity-30 pointer-events-none' : ''}"
          ${isSelf ? 'disabled' : ''}>${t('admin.remove')}</button>
      </div>
    </li>`;
  }).join('') || `<li class="text-slate-500 py-2">${t('users.none')}</li>`;

  $('#tab-users').innerHTML = `
    <article class="card bg-white rounded-lg p-5 border border-slate-200 mb-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-medium">${t('users.header', state.users.length)}</h3>
        <button id="user-new"
          class="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700">${t('users.create')}</button>
      </div>
      <ul class="text-sm divide-y">${rows}</ul>
    </article>`;

  $('#user-new').onclick = openCreateUserModal;
  $$('#tab-users [data-user-del]').forEach(b => b.addEventListener('click', () =>
    confirmModal(t('users.confirmDelete', b.dataset.userDel), async () => {
      await api(`/api/auth/users/${encodeURIComponent(b.dataset.userDel)}`, { method: 'DELETE' });
      await loadUsers();
      await loadSessions();
    })));
  $$('#tab-users [data-user-reset]').forEach(b => b.addEventListener('click', () =>
    openResetPasswordModal(b.dataset.userReset)));
}

function openCreateUserModal() {
  showModal(`
    <h4 class="font-medium mb-3">${t('users.create')}</h4>
    <label class="text-xs text-slate-500 block mb-1">${t('auth.username')}</label>
    <input id="nu-name" type="text" autocomplete="off"
      class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm mb-2" />
    <label class="text-xs text-slate-500 block mb-1">${t('users.startPassword')}</label>
    <input id="nu-pass" type="text" autocomplete="off"
      class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm mb-2" />
    <label class="flex items-center gap-2 text-sm text-slate-600 mt-2">
      <input id="nu-admin" type="checkbox" /> ${t('users.makeAdmin')}
    </label>
    <p class="text-xs text-slate-500 mt-2">${t('users.startPasswordHint')}</p>
    <p id="nu-err" class="hidden text-xs text-rose-600 mt-2"></p>
    <div class="mt-4 flex justify-end gap-2">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="m-ok" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md">${t('users.create')}</button>
    </div>`);
  $('#nu-name').focus();
  $('#m-cancel').onclick = hideModal;
  $('#m-ok').onclick = async () => {
    const name = $('#nu-name').value.trim();
    const pass = $('#nu-pass').value;
    const role = $('#nu-admin').checked ? 'admin' : 'user';
    const err = $('#nu-err'); err.classList.add('hidden');
    if (!name) { err.textContent = t('auth.allFieldsRequired'); err.classList.remove('hidden'); return; }
    if (pass.length < 4) { err.textContent = t('auth.passwordTooShort'); err.classList.remove('hidden'); return; }
    try {
      await api('/api/auth/users', { method: 'POST', body: { username: name, password: pass, role } });
      hideModal();
      await loadUsers();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  };
}

function openResetPasswordModal(username) {
  showModal(`
    <h4 class="font-medium mb-1">${t('users.resetPassword')}</h4>
    <p class="text-xs text-slate-500 mb-3">${escapeHtml(username)}</p>
    <label class="text-xs text-slate-500 block mb-1">${t('users.newStartPassword')}</label>
    <input id="rp-pass" type="text" autocomplete="off"
      class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
    <p class="text-xs text-slate-500 mt-2">${t('users.resetHint')}</p>
    <p id="rp-err" class="hidden text-xs text-rose-600 mt-2"></p>
    <div class="mt-4 flex justify-end gap-2">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="m-ok" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md">${t('modal.save')}</button>
    </div>`);
  $('#rp-pass').focus();
  $('#m-cancel').onclick = hideModal;
  $('#m-ok').onclick = async () => {
    const pass = $('#rp-pass').value;
    const err = $('#rp-err'); err.classList.add('hidden');
    if (pass.length < 4) { err.textContent = t('auth.passwordTooShort'); err.classList.remove('hidden'); return; }
    try {
      await api(`/api/auth/users/${encodeURIComponent(username)}/reset-password`,
        { method: 'POST', body: { password: pass } });
      hideModal();
      await loadUsers();
      await loadSessions();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  };
}

export { loadUsers, renderUsers, openCreateUserModal, openResetPasswordModal };
