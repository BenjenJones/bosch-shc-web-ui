import { $, $$, t, state, api, isAdmin, escapeHtml, applyStaticTexts, loadAll } from './core.js';
import { showModal, hideModal } from './modals.js';
import { connectEvents } from './live.js';

async function loadAuthStatus() {
  try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
    state.auth = await res.json();
  } catch (_) {
    state.auth = { enabled: false, authenticated: true, user: null };
  }
}

function applyRoleVisibility() {
  const admin = isAdmin();
  // Toggle both the Tailwind class (for buttons) AND the HTML hidden attr
  // (for <option> elements inside the mobile dropdown — Chrome/Edge don't
  // honour `display: none` on options in a <select>, but they do honour
  // the `hidden` attribute).
  $$('.admin-only').forEach(el => {
    el.classList.toggle('hidden', !admin);
    el.hidden = !admin;
  });
  // Account button only makes sense when auth is on
  const acc = $('#account-btn');
  if (acc) acc.classList.toggle('hidden', !state.auth.enabled);
}

// Login overlay: two modes — 'login' (username + password) and 'change'
// (mustChangePassword flow: old password + new password + repeat). Both use
// the same compact form for simplicity.
function showLogin(mode = 'login') {
  const root = $('#login-root');
  const form = $('#login-form');
  const errEl = $('#login-error');
  errEl.classList.add('hidden'); errEl.textContent = '';

  if (mode === 'change') {
    $('#login-title').textContent = t('auth.changeTitle');
    $('#login-sub').textContent   = t('auth.changeSub');
    $('#login-user-label').textContent = t('auth.oldPassword');
    $('#login-pass-label').textContent = t('auth.newPassword');
    $('#login-user').type = 'password';
    $('#login-user').autocomplete = 'current-password';
    $('#login-pass').type = 'password';
    $('#login-pass').autocomplete = 'new-password';
    $('#login-submit').textContent = t('auth.changeBtn');
    form.dataset.mode = 'change';
  } else {
    $('#login-title').textContent = t('auth.loginTitle');
    $('#login-sub').textContent   = t('auth.loginSub');
    $('#login-user-label').textContent = t('auth.username');
    $('#login-pass-label').textContent = t('auth.password');
    $('#login-user').type = 'text';
    $('#login-user').autocomplete = 'username';
    $('#login-pass').type = 'password';
    $('#login-pass').autocomplete = 'current-password';
    $('#login-submit').textContent = t('auth.loginBtn');
    form.dataset.mode = 'login';
  }
  $('#login-user').value = '';
  $('#login-pass').value = '';
  $('#app-shell').classList.add('hidden');
  root.classList.remove('hidden');
  setTimeout(() => $('#login-user').focus(), 0);
}

function hideLogin() {
  $('#login-root').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
}

async function submitLogin(e) {
  e.preventDefault();
  const form = $('#login-form');
  const errEl = $('#login-error');
  errEl.classList.add('hidden'); errEl.textContent = '';
  try {
    if (form.dataset.mode === 'change') {
      const oldPassword = $('#login-user').value;
      const newPassword = $('#login-pass').value;
      if (!newPassword || newPassword.length < 4) {
        errEl.textContent = t('auth.passwordTooShort');
        errEl.classList.remove('hidden');
        return;
      }
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      if (!res.ok) {
        errEl.textContent = t('auth.changeFailed');
        errEl.classList.remove('hidden');
        return;
      }
      // Refresh status and start the app
      await loadAuthStatus();
      hideLogin();
      applyStaticTexts();
      applyRoleVisibility();
      await loadAll();
      connectEvents();
    } else {
      const username = $('#login-user').value.trim();
      const password = $('#login-pass').value;
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        errEl.textContent = t('auth.loginFailed');
        errEl.classList.remove('hidden');
        return;
      }
      const data = await res.json();
      state.auth = { enabled: true, authenticated: true, user: data.user };
      if (data.user?.mustChangePassword) {
        showLogin('change');
        return;
      }
      hideLogin();
      applyStaticTexts();
      applyRoleVisibility();
      await loadAll();
      connectEvents();
    }
  } catch (err) {
    errEl.textContent = t('error.generic', err.message);
    errEl.classList.remove('hidden');
  }
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) { /* ignore */ }
  // Hard reload - simplest way to drop SSE/state and re-enter the login flow.
  location.reload();
}

function openAccountMenu() {
  if (!state.auth.enabled) return;
  showModal(`
    <h4 class="font-medium mb-1">${escapeHtml(state.auth.user?.username || '')}</h4>
    <p class="text-xs text-slate-500 mb-4">${state.auth.user?.role === 'admin' ? t('auth.roleAdmin') : t('auth.roleUser')}</p>
    <div class="flex flex-col gap-2">
      <button id="acc-change" class="w-full px-3 py-2 text-sm border border-slate-300 rounded-md text-left hover:bg-slate-50">${t('auth.changePassword')}</button>
      <button id="acc-logout" class="w-full px-3 py-2 text-sm border border-rose-300 text-rose-700 rounded-md text-left hover:bg-rose-50">${t('auth.logout')}</button>
    </div>
    <div class="mt-4 flex justify-end">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.close')}</button>
    </div>`);
  $('#m-cancel').onclick = hideModal;
  $('#acc-logout').onclick = logout;
  $('#acc-change').onclick = () => {
    hideModal();
    openChangePasswordModal();
  };
}

function openChangePasswordModal() {
  showModal(`
    <h4 class="font-medium mb-3">${t('auth.changePassword')}</h4>
    <label class="text-xs text-slate-500 block mb-1">${t('auth.oldPassword')}</label>
    <input id="cp-old" type="password" autocomplete="current-password"
      class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm mb-2" />
    <label class="text-xs text-slate-500 block mb-1">${t('auth.newPassword')}</label>
    <input id="cp-new" type="password" autocomplete="new-password"
      class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm mb-2" />
    <label class="text-xs text-slate-500 block mb-1">${t('auth.repeatPassword')}</label>
    <input id="cp-rep" type="password" autocomplete="new-password"
      class="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
    <p id="cp-err" class="hidden text-xs text-rose-600 mt-2"></p>
    <div class="mt-4 flex justify-end gap-2">
      <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="m-ok" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md">${t('modal.save')}</button>
    </div>`);
  $('#m-cancel').onclick = hideModal;
  $('#m-ok').onclick = async () => {
    const o = $('#cp-old').value, n = $('#cp-new').value, r = $('#cp-rep').value;
    const err = $('#cp-err');
    err.classList.add('hidden');
    if (!o || !n) { err.textContent = t('auth.allFieldsRequired'); err.classList.remove('hidden'); return; }
    if (n.length < 4) { err.textContent = t('auth.passwordTooShort'); err.classList.remove('hidden'); return; }
    if (n !== r)   { err.textContent = t('auth.passwordsMismatch'); err.classList.remove('hidden'); return; }
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { oldPassword: o, newPassword: n } });
      hideModal();
      alert(t('auth.changeOk'));
    } catch (e) {
      err.textContent = e.message || t('auth.changeFailed');
      err.classList.remove('hidden');
    }
  };
}

function initAuth() {
  $('#account-btn')?.addEventListener('click', openAccountMenu);
  $('#login-form').addEventListener('submit', submitLogin);
}

export { loadAuthStatus, applyRoleVisibility, showLogin, hideLogin, submitLogin, logout, openAccountMenu, openChangePasswordModal, initAuth };
