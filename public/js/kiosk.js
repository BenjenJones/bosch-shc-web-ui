import { $, t, state } from './core.js';
import { wireDeviceControls } from './devices.js';
import { favDevices, favScenarios, renderFavScenarioButtons, renderFavDeviceCards } from './favorites.js';

// =========================================================================
//  Kiosk view — for wall tablets: clock + favourites only, larger controls,
//  no tabs/toolbar, screen kept awake. Entered via the header button or the
//  URL `?kiosk` (handy as a tablet bookmark / PWA start URL) and remembered
//  per browser, so a reload stays in kiosk. `<html data-kiosk>` drives the
//  layout switch in app.css.
// =========================================================================
const KIOSK_KEY = 'kiosk';
let active = false;
let clockTimer = null;
let wakeLock = null;

const isKiosk = () => active;

async function requestWakeLock() {
  // Secure context only (HTTPS / localhost); silently unavailable otherwise.
  try { wakeLock = await navigator.wakeLock?.request('screen') ?? null; }
  catch { wakeLock = null; }
}

function updateClock() {
  const root = $('#kiosk-view');
  if (!root) return;
  const locale = state.lang === 'en' ? 'en-GB' : 'de-DE';
  const now = new Date();
  const time = root.querySelector('[data-kiosk-time]');
  const date = root.querySelector('[data-kiosk-date]');
  if (time) time.textContent = now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (date) date.textContent = now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
}

function renderKiosk() {
  const root = $('#kiosk-view');
  // Before the first loadAll() there are no texts/data yet; renderDevices()
  // calls us again once they are.
  if (!root || !active || !state.loaded) return;
  const empty = !favDevices().length && !favScenarios().length;
  root.innerHTML = `
    <div class="mb-5">
      <div data-kiosk-time class="text-5xl font-light tabular-nums"></div>
      <div data-kiosk-date class="text-slate-500 mt-1"></div>
    </div>
    ${empty
      ? `<p class="bg-white border border-slate-200 rounded-lg p-6 text-slate-600">${t('kiosk.empty')}</p>`
      : `<div class="space-y-4">${renderFavScenarioButtons({ big: true })}${renderFavDeviceCards()}</div>`}`;
  wireDeviceControls(root);
  updateClock();
}

function setKiosk(on) {
  active = on;
  try { on ? localStorage.setItem(KIOSK_KEY, '1') : localStorage.removeItem(KIOSK_KEY); } catch { /* ignore */ }
  document.documentElement.toggleAttribute('data-kiosk', on);
  clearInterval(clockTimer);
  clockTimer = null;
  if (on) {
    renderKiosk();
    clockTimer = setInterval(updateClock, 15000);
    requestWakeLock();
    window.scrollTo(0, 0);
  } else {
    // Drop ?kiosk so a reload after leaving doesn't jump straight back in.
    const url = new URL(location.href);
    if (url.searchParams.has('kiosk')) {
      url.searchParams.delete('kiosk');
      history.replaceState(null, '', url);
    }
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    $('#kiosk-view').innerHTML = '';
  }
}

// Called once from boot, before data is loaded: switches the layout right
// away (no dashboard flash); the content follows with the first renderDevices.
function initKiosk() {
  $('#kiosk-enter')?.addEventListener('click', () => setKiosk(true));
  $('#kiosk-exit')?.addEventListener('click', () => setKiosk(false));
  // The browser releases the wake lock when the tab is hidden; take it again.
  document.addEventListener('visibilitychange', () => {
    if (active && document.visibilityState === 'visible') requestWakeLock();
  });
  let stored = false;
  try { stored = localStorage.getItem(KIOSK_KEY) === '1'; } catch { /* ignore */ }
  if (new URLSearchParams(location.search).has('kiosk') || stored) setKiosk(true);
}

export { initKiosk, isKiosk, renderKiosk, setKiosk };
