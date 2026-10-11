import { state, $$, t, api, escapeHtml } from './core.js';
import { renderDevices, safeRenderDeviceCard } from './devices.js';
import { renderScenarios, sceIconSvg } from './scenarios.js';

// =========================================================================
//  Favourites — pinned devices and scenarios, shown at the top of the
//  dashboard and as the content of the kiosk view. Stored per browser
//  (localStorage), so each wall tablet / phone keeps its own selection.
//  Order = pin order.
// =========================================================================
const FAV_KEY = 'favorites';
const favs = (() => {
  try {
    const f = JSON.parse(localStorage.getItem(FAV_KEY));
    return { device: Array.isArray(f?.device) ? f.device : [], scenario: Array.isArray(f?.scenario) ? f.scenario : [] };
  } catch { return { device: [], scenario: [] }; }
})();

const isFav = (kind, id) => favs[kind].includes(id);

function toggleFav(kind, id) {
  favs[kind] = isFav(kind, id) ? favs[kind].filter(x => x !== id) : [...favs[kind], id];
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch { /* quota / private mode */ }
  renderDevices();
  renderScenarios();
}

// Pinned items that still exist (a deleted device/scenario silently drops out).
const favDevices   = () => favs.device.map(id => state.devices.find(d => d.id === id)).filter(Boolean);
const favScenarios = () => favs.scenario.map(id => state.scenarios.find(s => s.id === id)).filter(Boolean);

function favButton(kind, id) {
  const on = isFav(kind, id);
  const label = t(on ? 'fav.remove' : 'fav.add');
  return `<button type="button" data-fav="${kind}" data-fav-id="${escapeHtml(id)}" aria-pressed="${on}"
    title="${label}" aria-label="${label}"
    class="fav-btn leading-none p-0.5 text-base ${on ? 'text-amber-600' : 'text-slate-400 hover:text-slate-700'}">${on ? '★' : '☆'}</button>`;
}

// Scenario quick buttons — shared by the dashboard section and the kiosk.
// `big` = kiosk sizing.
function renderFavScenarioButtons({ big = false } = {}) {
  const list = favScenarios();
  if (!list.length) return '';
  return `<div class="grid ${big ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3' : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2'}">
    ${list.map(s => `
      <button data-fav-scenario="${escapeHtml(s.id)}"
        class="card bg-white border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-2 text-left
        ${big ? 'p-5 text-lg font-medium' : 'px-3 py-2 text-sm font-medium'}">
        <img src="svg/${sceIconSvg(s.iconId)}.svg" alt="" style="width:${big ? 28 : 18}px;height:${big ? 28 : 18}px" class="shrink-0" />
        <span class="truncate">${escapeHtml(s.name || s.id)}</span>
      </button>`).join('')}
  </div>`;
}

function renderFavDeviceCards() {
  const list = favDevices();
  if (!list.length) return '';
  return `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">${list.map(d => safeRenderDeviceCard(d, { showRoom: true })).join('')}</div>`;
}

// Dashboard section above the rooms; empty string when nothing is pinned.
function renderFavoritesSection() {
  if (!favDevices().length && !favScenarios().length) return '';
  return `
    <section class="mb-4" data-favorites>
      <h2 class="text-sm uppercase tracking-wide text-slate-500 flex items-center gap-1.5 mb-2 px-1">
        <span class="text-amber-600">★</span>${t('fav.title')}
      </h2>
      <div class="space-y-3">
        ${renderFavScenarioButtons()}
        ${renderFavDeviceCards()}
      </div>
    </section>`;
}

async function triggerScenario(btn) {
  try {
    await api(`api/scenarios/${encodeURIComponent(btn.dataset.favScenario)}/trigger`, { method: 'POST' });
    btn.classList.add('pulse');
    setTimeout(() => btn.classList.remove('pulse'), 1500);
  } catch (err) { alert(t('error.generic', err.message)); }
}

// One delegated listener for stars and favourite scenario buttons anywhere in
// the page, so re-renders never need to re-wire them. Called once from boot.
function initFavorites() {
  document.addEventListener('click', (e) => {
    const star = e.target.closest('[data-fav]');
    if (star) {
      e.preventDefault();
      toggleFav(star.dataset.fav, star.dataset.favId);
      return;
    }
    const sce = e.target.closest('[data-fav-scenario]');
    if (sce) triggerScenario(sce);
  });
}

export { initFavorites, favButton, isFav, toggleFav, favDevices, favScenarios, renderFavoritesSection, renderFavScenarioButtons, renderFavDeviceCards };
