import { $, $$, t } from './core.js';

function applySetupTexts() {
  // Plain-text labels — set textContent so any markup in the dictionary is
  // treated as literal text (XSS-safe).
  $$('#setup-root [data-setup-text]').forEach(el => {
    el.textContent = t('setup.' + el.dataset.setupText);
  });
  // Opt-in HTML strings (currently only `authHint`, which references the
  // `npm run setup` command in a <code> tag). Keep the set small and the
  // dictionary trustworthy — i18n files are bundled, not user-supplied.
  $$('#setup-root [data-setup-text-html]').forEach(el => {
    el.innerHTML = t('setup.' + el.dataset.setupTextHtml);
  });
}

function showSetupStep(name) {
  $$('#setup-root [data-step]').forEach(el => el.classList.toggle('hidden', el.dataset.step !== name));
  // Each step has its own inline error <p> — reset all of them when we move
  $$('#setup-root [data-setup-error]').forEach(el => { el.classList.add('hidden'); el.textContent = ''; });
}

function showSetupError(scope, msg) {
  // `scope` is the currently-visible [data-step] element id ('pair' or 'auth')
  const el = $(`#setup-root [data-step="${scope}"] [data-setup-error]`);
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.detail || data.error || `HTTP ${res.status}`;
    const err = new Error(msg); err.status = res.status; err.payload = data;
    throw err;
  }
  return data;
}

// Collected wizard state. All three screens fill into this object; the
// single POST to /api/setup happens only on the last step. Survives a step-2
// SHC-registration failure (so the user doesn't lose their auth choice when
// they have to retry).
const setupDraft = {
  shcIp: '',
  authEnabled: false,
  adminUsername: '',
  adminPassword: '',
};

function wireSetupWizard() {
  // Step 1: IP -> Step 2 (auth)
  $('[data-step-next="ip"]').addEventListener('click', () => {
    const ip = $('#setup-ip').value.trim();
    if (!ip) { $('#setup-ip').focus(); return; }
    setupDraft.shcIp = ip;
    showSetupStep('auth');
  });

  // Step 2 (auth-choice "no"): go straight to pairing with authEnabled=false
  $('[data-auth-choice="no"]').addEventListener('click', () => {
    setupDraft.authEnabled = false;
    showSetupStep('pair');
    setTimeout(() => $('#setup-pass').focus(), 0);
  });

  // Step 2 (auth-choice "yes"): reveal admin fields, then a second click
  // captures them and advances to pairing.
  $('[data-auth-choice="yes"]').addEventListener('click', () => {
    $('[data-auth-fields]').classList.remove('hidden');
    setTimeout(() => $('#setup-admin-user').focus(), 0);
  });
  $('[data-auth-confirm]').addEventListener('click', () => {
    const user = $('#setup-admin-user').value.trim();
    const pass = $('#setup-admin-pass').value;
    if (!user)                    return showSetupError('auth', t('setup.errUsername'));
    if (!pass || pass.length < 4) return showSetupError('auth', t('setup.errPassword'));
    setupDraft.authEnabled   = true;
    setupDraft.adminUsername = user;
    setupDraft.adminPassword = pass;
    showSetupStep('pair');
    setTimeout(() => $('#setup-pass').focus(), 0);
  });

  // Step 3: pairing-mode reminder + SHC password — the one and only POST.
  $('[data-step-next="pair"]').addEventListener('click', async () => {
    const password = $('#setup-pass').value;
    if (!password) { $('#setup-pass').focus(); return; }
    const btn  = $('[data-step-next="pair"]');
    const originalLabel = btn.textContent;
    btn.disabled = true; btn.textContent = t('setup.pairBusy');
    try {
      await postJSON('/api/setup', {
        shcIp:         setupDraft.shcIp,
        password,
        authEnabled:   setupDraft.authEnabled,
        adminUsername: setupDraft.adminUsername,
        adminPassword: setupDraft.adminPassword,
      });
      showSetupStep('done');
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      showSetupError('pair', err.message);
      btn.disabled = false; btn.textContent = originalLabel;
    }
  });
}

export { applySetupTexts, showSetupStep, showSetupError, postJSON, wireSetupWizard };
