// =========================================================================
//  Custom dashboards — admin-built pages of widgets on a free 12-column grid,
//  shown as their own tabs in the UI. Stored globally (one JSON file in the
//  data dir); which dashboard a browser opens at start or shows in kiosk mode
//  is chosen per browser, client-side.
//
//  Shape: [{ id, name, widgets: [{ id, type, x, y, w, h, cfg }] }]
//  x/w in grid columns (0–11 / 1–12), y/h in grid rows. `cfg` holds the
//  widget's settings (deviceId, metric, …) — only whitelisted keys survive.
// =========================================================================
const fs = require('node:fs');

const COLS = 12;
const MAX_DASHBOARDS = 50;
const MAX_WIDGETS = 200;
const MAX_ROWS = 500;
const MAX_H = 40;
const WIDGET_TYPES = ['device', 'scenario', 'room', 'chart', 'energy', 'health', 'messages', 'security', 'clock', 'text', 'shutters', 'divider'];
const CFG_KEYS = ['deviceId', 'scenarioId', 'roomId', 'metric', 'range', 'title', 'text'];

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};

function sanitizeWidget(w, i) {
  if (!w || typeof w !== 'object') throw bad(`widget ${i}: object required`);
  if (!WIDGET_TYPES.includes(w.type)) throw bad(`widget ${i}: unknown type "${w.type}"`);
  const wCols = int(w.w, 1, COLS);
  const cfg = {};
  for (const k of CFG_KEYS) {
    const v = w.cfg?.[k];
    if (typeof v === 'string' && v.trim()) cfg[k] = v.trim().slice(0, k === 'text' ? 2000 : 200);
  }
  return {
    id: str(w.id, 64) || `w${i}`,
    type: w.type,
    x: int(w.x, 0, COLS - wCols),
    y: int(w.y, 0, MAX_ROWS),
    w: wCols,
    h: int(w.h, 1, MAX_H),
    cfg,
  };
}

// Validates and normalises a whole list (the PUT body). Throws a 400 error
// on structural problems; clamps out-of-range numbers instead of rejecting.
function sanitizeDashboards(list) {
  if (!Array.isArray(list)) throw bad('dashboards must be an array');
  if (list.length > MAX_DASHBOARDS) throw bad(`at most ${MAX_DASHBOARDS} dashboards`);
  const ids = new Set();
  return list.map((d, i) => {
    if (!d || typeof d !== 'object') throw bad(`dashboard ${i}: object required`);
    const id = str(d.id, 64);
    if (!id) throw bad(`dashboard ${i}: id required`);
    if (ids.has(id)) throw bad(`duplicate dashboard id "${id}"`);
    ids.add(id);
    const name = str(d.name, 60);
    if (!name) throw bad(`dashboard ${i}: name required`);
    const widgets = Array.isArray(d.widgets) ? d.widgets : [];
    if (widgets.length > MAX_WIDGETS) throw bad(`dashboard ${i}: at most ${MAX_WIDGETS} widgets`);
    return { id, name, widgets: widgets.map(sanitizeWidget) };
  });
}

function openDashboards(file) {
  let list = [];
  try {
    list = sanitizeDashboards(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read dashboards:', err.message);
  }
  return {
    get: () => list,
    // Throws (400) on invalid input; the file is only written when valid.
    set(next) {
      const clean = sanitizeDashboards(next);
      if (file !== ':memory:') fs.writeFileSync(file, JSON.stringify(clean, null, 2));
      list = clean;
      return list;
    },
  };
}

module.exports = { openDashboards, sanitizeDashboards, WIDGET_TYPES, COLS };
