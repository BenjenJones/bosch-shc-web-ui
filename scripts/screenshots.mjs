// =========================================================================
//  Screenshot generator for the README / docs.
//
//    npm run screenshots            → docs/img/*.png
//
//  Boots the demo (demo.js — anonymized dataset + a year of synthetic
//  history, no real SHC or personal data involved) on its own port, drives
//  it with playwright-core and saves one PNG per view. Uses an installed
//  Chrome by default (no browser download); override with
//  SCREENSHOT_CHANNEL=msedge, or SCREENSHOT_CHANNEL=chromium after
//  `npx playwright install chromium` (e.g. in CI).
//
//  Language: SCREENSHOT_LANG=de|en (default en — the README is English).
// =========================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, 'docs', 'img');
const PORT = Number(process.env.SCREENSHOT_PORT) || 3091;
const SHC_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/`;
const LANG = process.env.SCREENSHOT_LANG || 'en';
const CHANNEL = process.env.SCREENSHOT_CHANNEL || 'chrome';

// Pinned in the screenshots' favourites / kiosk view (demo dataset ids).
const FAVORITES = {
  device: ['hdm:ZigBee:90a5f7b696ca5616', 'hdm:ZigBee:358e310bee9f4e26', 'hdm:ZigBee:b001c93a64f7653a', 'hdm:HomeMaticIP:3014F711AEEE5B597C270A80'],
  scenario: ['425cf9f4-6f24-4d91-88b4-1c2dafd28657', 'b510ceed-0fe5-45dd-85c6-44ad41c8007c'],
};

// Custom dashboard for the README (demo dataset ids). Its tab shows in every
// shot's navigation, like on an install that uses the feature.
const DASHBOARD = (en) => [{ id: 'overview', name: en ? 'Overview' : 'Übersicht', widgets: [
  { id: 'clock', type: 'clock', x: 0, y: 0, w: 3, h: 3, cfg: {} },
  { id: 'home', type: 'scenario', x: 3, y: 0, w: 3, h: 2, cfg: { scenarioId: '425cf9f4-6f24-4d91-88b4-1c2dafd28657' } },
  { id: 'door', type: 'scenario', x: 3, y: 2, w: 3, h: 2, cfg: { scenarioId: 'b510ceed-0fe5-45dd-85c6-44ad41c8007c' } },
  { id: 'energy', type: 'energy', x: 6, y: 0, w: 6, h: 4, cfg: {} },
  { id: 'div1', type: 'divider', x: 0, y: 4, w: 12, h: 1, cfg: { title: en ? 'Climate' : 'Klima' } },
  { id: 'chart', type: 'chart', x: 0, y: 5, w: 8, h: 6, cfg: { deviceId: 'hdm:ZigBee:90a5f7b696ca5616', metric: 'temperature', range: '7d' } },
  { id: 'health', type: 'health', x: 8, y: 5, w: 4, h: 3, cfg: {} },
  { id: 'note', type: 'text', x: 8, y: 8, w: 4, h: 3, cfg: { title: en ? 'Note' : 'Notiz', text: en ? 'Bins out on Thursday\nFilter change in May' : 'Donnerstag Müll rausstellen\nFilterwechsel im Mai' } },
  { id: 'div2', type: 'divider', x: 0, y: 11, w: 12, h: 1, cfg: { title: en ? 'Devices' : 'Geräte' } },
  { id: 'twinguard', type: 'device', x: 0, y: 12, w: 4, h: 5, cfg: { deviceId: 'hdm:ZigBee:b001c93a64f7653a' } },
  { id: 'plug', type: 'device', x: 4, y: 12, w: 4, h: 5, cfg: { deviceId: 'hdm:ZigBee:358e310bee9f4e26' } },
  { id: 'shutters', type: 'shutters', x: 8, y: 12, w: 4, h: 2, cfg: {} },
  { id: 'shutter', type: 'device', x: 8, y: 14, w: 4, h: 3, cfg: { deviceId: 'hdm:HomeMaticIP:3014F711AEEE5B597C270A80' } },
] }];

async function waitForServer(url, ms = 30e3) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`demo did not come up on ${url}`);
}

const demo = spawn(process.execPath, ['demo.js'], {
  cwd: ROOT,
  env: { ...process.env, BOSCH_SHC_DEMO_PORT: String(PORT), BOSCH_SHC_DEMO_SHC_PORT: String(SHC_PORT),
    // Fresh dashboards, not the ones kept from interactive demo runs.
    BOSCH_SHC_DEMO_DASHBOARDS_FILE: path.join(os.tmpdir(), `bosch-shc-shots-dashboards-${process.pid}.json`) },
  stdio: ['ignore', 'inherit', 'inherit'],
});
// Stop only the process we started (by its PID) — never anything by name.
const stopDemo = () => { if (demo.exitCode == null) demo.kill(); };
process.on('exit', stopDemo);

let browser;
try {
  await waitForServer(BASE + 'api/setup/status');
  const put = await fetch(BASE + 'api/dashboards', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(DASHBOARD(LANG === 'en')),
  });
  if (!put.ok) throw new Error(`seeding the dashboard failed: ${put.status}`);
  fs.mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch(CHANNEL === 'chromium' ? {} : { channel: CHANNEL });

  // Fresh context per shot: own localStorage (theme, language, favourites).
  async function shot(name, { theme = 'light', width = 1280, height = 900, mobile = false, query = '', favorites = false, prepare } = {}) {
    const ctx = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: mobile ? 3 : 1.5,
      isMobile: mobile, hasTouch: mobile, colorScheme: theme, reducedMotion: 'reduce',
    });
    await ctx.addInitScript(([lang, theme, favs]) => {
      localStorage.setItem('lang', lang);
      localStorage.setItem('theme', theme);
      localStorage.setItem('favorites', JSON.stringify(favs));
    }, [LANG, theme, favorites ? FAVORITES : { device: [], scenario: [] }]);
    const page = await ctx.newPage();
    await page.goto(BASE + query, { waitUntil: 'networkidle' });
    await page.waitForSelector('#tab-devices > *', { state: 'attached' });
    // Green live lamp = SSE stream up and the server's SHC link reported.
    await page.waitForSelector('#event-dot.bg-emerald-500', { timeout: 15e3 })
      .catch(() => console.warn(`  ! ${name}: live lamp not green`));
    if (prepare) await prepare(page);
    await page.waitForTimeout(400); // let charts/sparklines settle
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    console.log('  ✓', path.relative(ROOT, file));
    await ctx.close();
  }

  const tab = (name) => async (page) => {
    await page.click(`[data-tab="${name}"]`);
    await page.waitForSelector(`#tab-${name} > *`);
    await page.waitForLoadState('networkidle');
  };

  await shot('dashboard', { height: 1000 });
  await shot('dashboard-dark', { theme: 'dark', height: 1000 });
  await shot('history', {
    prepare: async (page) => {
      // The room thermostat's chart: temperature with the setpoint overlay.
      await page.click('[data-history="hdm:ZigBee:90a5f7b696ca5616"]:not([data-room-setpoint])');
      await page.waitForSelector('#modal-card svg');
      await page.waitForLoadState('networkidle');
    },
  });
  const dashboard = async (page) => {
    await page.click('[data-tab="dash:overview"]');
    await page.waitForSelector('#tab-dashboard [data-dash-chart] svg');
    await page.waitForLoadState('networkidle');
  };
  await shot('custom-dashboard', { height: 1000, prepare: dashboard });
  await shot('dashboard-editor', {
    height: 1000,
    prepare: async (page) => {
      await dashboard(page);
      await page.click('[data-dash-edit]');
      await page.waitForSelector('.dash-grid.editing [data-dash-chart] svg');
    },
  });
  await shot('energy', { prepare: tab('energy') });
  await shot('health', { prepare: tab('health') });
  await shot('kiosk', { query: '?kiosk', width: 1180, height: 820, favorites: true });
  await shot('mobile', { width: 390, height: 844, mobile: true });
  console.log(`▶ screenshots written to ${path.relative(ROOT, OUT)}`);
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  stopDemo();
}
