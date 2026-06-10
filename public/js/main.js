// =========================================================================
//  Entry point — wires the per-module init() listeners, then boots the app.
//  Loaded as <script type="module">, so it runs after the DOM is parsed and
//  every imported module has evaluated.
// =========================================================================
import { $, loadI18N, applyStaticTexts, state, loadAll, t } from './core.js';
import { initModals } from './modals.js';
import { initTabs } from './tabs.js';
import { initAuth, loadAuthStatus, applyRoleVisibility, showLogin, hideLogin } from './auth.js';
import { connectEvents } from './live.js';
import { applySetupTexts, wireSetupWizard } from './setup.js';

initModals();
initTabs();
initAuth();

(async () => {
  try {
    await loadI18N();

    // Setup wizard takes priority over everything else — if the server has
    // no config.json yet, nothing in /api/* (except auth/status and the
    // /api/setup/* endpoints) will respond, so we'd just see errors. Show
    // the wizard instead and bail out of the normal boot path.
    try {
      const r = await fetch('/api/setup/status');
      const data = await r.json();
      if (data.needed) {
        applySetupTexts();
        wireSetupWizard();
        $('#setup-root').classList.remove('hidden');
        setTimeout(() => $('#setup-ip').focus(), 0);
        return;
      }
    } catch (_) { /* fall through; server will surface the underlying issue */ }

    await loadAuthStatus();
    applyStaticTexts();

    if (state.auth.enabled && !state.auth.authenticated) {
      showLogin('login');
      return;
    }
    if (state.auth.user?.mustChangePassword) {
      showLogin('change');
      return;
    }

    hideLogin();
    applyRoleVisibility();
    await loadAll();
    connectEvents();
  } catch (err) {
    document.body.insertAdjacentHTML('afterbegin',
      `<div class="bg-rose-100 text-rose-800 p-3 text-sm">${t('error.loading', err.message)}</div>`);
  }
})();
