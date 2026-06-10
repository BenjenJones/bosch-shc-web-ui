import { $, $$, loadAll, setLang, setTheme, toggleNotify } from './core.js';
import { loadUsers } from './users.js';
import { loadSessions } from './sessions.js';

const ALL_TABS = ['devices','scenarios','security','messages','admin','users','sessions'];

function selectTab(name) {
  if (!ALL_TABS.includes(name)) return;
  $$('.tab').forEach(x => {
    const active = x.dataset.tab === name;
    x.classList.toggle('border-blue-600', active);
    x.classList.toggle('font-medium',     active);
    x.classList.toggle('border-transparent', !active);
    x.classList.toggle('text-slate-500',     !active);
  });
  ALL_TABS.forEach(n =>
    $('#tab-' + n).classList.toggle('hidden', n !== name));
  // Keep the mobile <select> in sync when the change was initiated by a
  // button click on a wider viewport.
  const sel = $('#tab-select');
  if (sel && sel.value !== name) sel.value = name;
  // Lazy loads for admin tabs (used to be wired as separate click handlers
  // at the bottom of the file — kept here so they fire regardless of
  // whether the tab was picked via the buttons or the mobile dropdown).
  if (name === 'users')    loadUsers();
  if (name === 'sessions') loadSessions();
}
// Header/tab controls + the mobile hamburger menu. Called once from boot.
function initTabs() {
  $$('.tab').forEach(tabEl =>
    tabEl.addEventListener('click', () => selectTab(tabEl.dataset.tab)));
  $('#tab-select')?.addEventListener('change', (e) => selectTab(e.target.value));
  $('#refresh').addEventListener('click', loadAll);
  $$('#lang-switch [data-lang]').forEach(b =>
    b.addEventListener('click', () => setLang(b.dataset.lang))
  );
  $$('#theme-switch [data-theme-set]').forEach(b =>
    b.addEventListener('click', () => setTheme(b.dataset.themeSet))
  );
  $('#notify-toggle')?.addEventListener('click', toggleNotify);

  // Mobile header menu — hamburger toggles the controls panel that's inline on
  // ≥sm and a dropdown on smaller screens. CSS handles layout via `sm:`
  // variants; JS only flips the `hidden` class.
  const toggle = $('#menu-toggle');
  const panel  = $('#menu-panel');
  if (!toggle || !panel) return;
  const setOpen = (open) => {
    panel.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(panel.classList.contains('hidden'));
  });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
  });
  panel.addEventListener('click', (e) => {
    if (e.target.closest('button')) setOpen(false);
  });
}

export { ALL_TABS, selectTab, initTabs };
