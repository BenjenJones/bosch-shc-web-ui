import { state, $, $$, t, api, escapeHtml, isAdmin, roomName } from './core.js';
import { deviceIcon } from './devices.js';
import { renderBarChart } from './charts.js';

// =========================================================================
//  Energy tab — consumption of all energy counters (PowerMeter) per calendar
//  period (day / week / month / year, browsable), costs from the configured
//  tariffs, comparison with the previous period and a per-device ranking.
//  Numbers come from /api/energy (deltas of the recorded counter readings,
//  see history.js).
// =========================================================================
const PERIODS = ['day', 'week', 'month', 'year'];
const view = { period: 'month', offset: 0 };
let tariffs = [];
let loadSeq = 0;

const locale = () => (state.lang === 'en' ? 'en-GB' : 'de-DE');
const num = (v, dec = 2) => (v ?? 0).toLocaleString(locale(), { minimumFractionDigits: dec, maximumFractionDigits: dec });
const money = (v) => (v ?? 0).toLocaleString(locale(), { style: 'currency', currency: 'EUR' });

// Calendar period → { from, to, bucket, slots: [bucket start ts], label }.
// Weeks start on Monday. `slots` lists every bucket of the period so the
// chart axis stays complete even for the (partly future) current period.
function periodRange(period, offset) {
  const now = new Date();
  let from, to, bucket;
  if (period === 'day') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
    bucket = 'hour';
  } else if (period === 'week') {
    const monday = now.getDate() - ((now.getDay() + 6) % 7);
    from = new Date(now.getFullYear(), now.getMonth(), monday + offset * 7);
    to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7);
    bucket = 'day';
  } else if (period === 'month') {
    from = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
    bucket = 'day';
  } else {
    from = new Date(now.getFullYear() + offset, 0, 1);
    to = new Date(from.getFullYear() + 1, 0, 1);
    bucket = 'month';
  }
  const slots = [];
  for (const d = new Date(from); d < to;) {
    slots.push(d.getTime());
    if (bucket === 'hour') d.setHours(d.getHours() + 1);
    else if (bucket === 'day') d.setDate(d.getDate() + 1);
    else d.setMonth(d.getMonth() + 1);
  }
  const L = locale();
  const label = period === 'day'
    ? from.toLocaleDateString(L, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : period === 'week'
      ? `${t('energy.week', isoWeek(from))} · ${from.toLocaleDateString(L, { day: '2-digit', month: '2-digit' })}–${new Date(to - 1).toLocaleDateString(L, { day: '2-digit', month: '2-digit', year: 'numeric' })}`
      : period === 'month'
        ? from.toLocaleDateString(L, { month: 'long', year: 'numeric' })
        : String(from.getFullYear());
  return { from: from.getTime(), to: to.getTime(), bucket, slots, label };
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - y0) / 864e5 + 1) / 7);
}

const fetchEnergy = (from, to, bucket) =>
  api(`api/energy?from=${from}&to=${to}&bucket=${bucket}`);

function slotLabels(ts, bucket) {
  const d = new Date(ts), L = locale();
  if (bucket === 'hour') return [d.toLocaleTimeString(L, { hour: '2-digit' }), d.toLocaleTimeString(L, { hour: '2-digit', minute: '2-digit' })];
  if (bucket === 'month') return [d.toLocaleDateString(L, { month: 'short' }), d.toLocaleDateString(L, { month: 'long', year: 'numeric' })];
  return [view.period === 'week' ? d.toLocaleDateString(L, { weekday: 'short' }) : String(d.getDate()),
          d.toLocaleDateString(L, { weekday: 'short', day: '2-digit', month: '2-digit' })];
}

// Current total power of all metering devices (live state, not history).
const livePower = () => state.services
  .filter(s => s.id === 'PowerMeter' && typeof s.state?.powerConsumption === 'number')
  .reduce((a, s) => a + s.state.powerConsumption, 0);

async function loadEnergy() {
  const root = $('#tab-energy');
  if (!root || root.classList.contains('hidden')) return;
  const seq = ++loadSeq;
  const cur = periodRange(view.period, view.offset);
  // Compare like with like: for the running period only the same elapsed
  // span of the previous one.
  const prev = periodRange(view.period, view.offset - 1);
  const elapsed = Math.min(Date.now(), cur.to) - cur.from;
  const prevTo = view.offset === 0 ? Math.min(prev.to, prev.from + elapsed) : prev.to;
  if (!root.innerHTML) root.innerHTML = `<p class="text-sm text-slate-500">${t('history.loading')}</p>`;
  let data, before;
  try {
    [data, before, { tariffs }] = await Promise.all([
      fetchEnergy(cur.from, cur.to, cur.bucket),
      fetchEnergy(prev.from, prevTo, prev.bucket),
      api('api/energy/tariffs'),
    ]);
  } catch (err) {
    root.innerHTML = `<p class="text-sm text-rose-600">${escapeHtml(t('error.generic', err.message))}</p>`;
    return;
  }
  if (seq !== loadSeq) return; // a newer request (period change) won
  renderEnergy(cur, data, before);
}

function renderEnergy(cur, data, before) {
  const root = $('#tab-energy');
  if (!data.available) {
    root.innerHTML = `<p class="bg-white border border-slate-200 rounded-lg p-6 text-sm text-slate-600">${t('history.unavailable')}</p>`;
    return;
  }
  const metering = state.services.some(s => s.id === 'PowerMeter');
  const byTs = new Map(data.buckets.map((ts, i) => [ts, data.totals[i]]));
  const bars = cur.slots.map(ts => [ts, byTs.get(ts) || 0, ...slotLabels(ts, cur.bucket)]);
  const delta = before.kwh > 0 ? (data.kwh - before.kwh) / before.kwh : null;
  const power = livePower();
  const hasTariff = tariffs.length > 0;

  const tile = (label, value, sub = '') => `
    <div class="bg-white rounded-lg border border-slate-200 p-3">
      <div class="text-xs text-slate-500">${label}</div>
      <div class="text-2xl font-light tabular-nums mt-0.5">${value}</div>
      ${sub ? `<div class="text-xs text-slate-500 mt-0.5">${sub}</div>` : ''}
    </div>`;
  const deltaTxt = delta == null ? '–'
    : `<span class="${delta > 0 ? 'text-amber-700' : 'text-emerald-700'}">${delta > 0 ? '▲' : '▼'} ${num(Math.abs(delta) * 100, 0)} %</span>`;
  const costTxt = hasTariff ? money(data.cost) : '–';
  const costSub = !hasTariff ? t('energy.noTariff') : (data.priced ? '' : t('energy.costPartial'));

  const top = data.devices[0]?.kwh || 0;
  const rows = data.devices.filter(d => d.kwh > 0 || state.devices.some(x => x.id === d.deviceId)).map(d => {
    const dev = state.devices.find(x => x.id === d.deviceId);
    const share = data.kwh > 0 ? d.kwh / data.kwh : 0;
    const now = state.services.find(s => s.deviceId === d.deviceId && s.id === 'PowerMeter')?.state?.powerConsumption;
    return `
      <li>
        <button type="button" data-history="${escapeHtml(d.deviceId)}" data-history-metric="energy" class="w-full text-left py-2 flex items-center gap-3 hover:bg-slate-50 rounded-md px-1">
          ${dev ? `<img src="svg/${deviceIcon(dev)}.svg" style="width:18px;height:18px" class="shrink-0" alt="" />` : '<span class="w-[18px] shrink-0"></span>'}
          <span class="min-w-0 flex-1">
            <span class="block truncate">${escapeHtml(dev ? (dev.name || dev.id) : t('energy.removedDevice'))}</span>
            <span class="block text-xs text-slate-500 truncate">${[dev?.roomId ? escapeHtml(roomName(dev.roomId)) : '', now != null ? t('energy.now', num(now, 0)) : ''].filter(Boolean).join(' · ')}</span>
            <span class="block h-1.5 mt-1 rounded-full bg-slate-100 overflow-hidden"><span class="block h-full chart-share" style="width:${top ? (d.kwh / top * 100).toFixed(1) : 0}%"></span></span>
          </span>
          <span class="text-right shrink-0 tabular-nums">
            <span class="block">${num(d.kwh)} kWh</span>
            <span class="block text-xs text-slate-500">${num(share * 100, 0)} %${hasTariff ? ' · ' + money(d.cost) : ''}</span>
          </span>
        </button>
      </li>`;
  }).join('');

  root.innerHTML = `
    <div class="space-y-4 max-w-4xl">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="inline-flex text-sm border border-slate-300 rounded-md overflow-hidden bg-white">
          ${PERIODS.map((p, i) => `<button data-e-period="${p}" class="px-3 py-1.5 ${i ? 'border-l border-slate-300' : ''} ${view.period === p ? 'bg-blue-600 text-white' : 'hover:bg-slate-100'}">${t('energy.p.' + p)}</button>`).join('')}
        </div>
        <div class="flex items-center gap-2">
          <button data-e-shift="-1" class="w-8 h-8 rounded-md border border-slate-300 bg-white hover:bg-slate-100" aria-label="${t('energy.prev')}">‹</button>
          <span class="text-sm font-medium min-w-[10rem] text-center">${escapeHtml(cur.label)}</span>
          <button data-e-shift="1" class="w-8 h-8 rounded-md border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40" aria-label="${t('energy.next')}" ${view.offset >= 0 ? 'disabled' : ''}>›</button>
          ${view.offset ? `<button data-e-today class="text-xs text-blue-600 hover:underline">${t('energy.current')}</button>` : ''}
        </div>
      </div>
      ${!metering && !data.devices.length ? `<p class="bg-white border border-slate-200 rounded-lg p-6 text-sm text-slate-600">${t('energy.noMeters')}</p>` : `
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        ${tile(t('energy.consumption'), `${num(data.kwh)} <span class="text-base">kWh</span>`)}
        ${tile(t('energy.cost'), costTxt, costSub)}
        ${tile(t('energy.compare'), deltaTxt, view.offset === 0 ? t('energy.compareHintRunning') : t('energy.compareHint'))}
        ${tile(t('energy.livePower'), `${num(power, 0)} <span class="text-base">W</span>`)}
      </div>
      <div class="bg-white rounded-lg border border-slate-200 px-4 py-3">
        <h2 class="font-medium mb-2">${t('energy.chartTitle')}</h2>
        <div id="energy-chart"></div>
      </div>
      <div class="bg-white rounded-lg border border-slate-200 px-4 py-3">
        <h2 class="font-medium mb-1">${t('energy.devices')}</h2>
        ${rows ? `<ul class="divide-y divide-slate-200">${rows}</ul>` : `<p class="text-sm text-slate-500 py-2">${t('history.noData')}</p>`}
      </div>`}
      ${renderTariffs()}
    </div>`;

  const chart = $('#energy-chart');
  if (chart) renderBarChart(chart, bars, { def: { unit: 'kWh', dec: 2 } });
  wireEnergy(root);
}

// Tariff list: everyone sees it; admins can edit.
function renderTariffs() {
  const edit = isAdmin();
  const row = (tf, i) => `
    <div class="flex items-center gap-2 py-1" data-tariff-row="${i}">
      <input type="date" value="${escapeHtml(tf.validFrom)}" data-tariff-from ${edit ? '' : 'disabled'}
        class="border border-slate-300 rounded-md px-2 py-1 text-sm bg-white" />
      <input type="number" min="0" max="100" step="0.0001" value="${tf.price}" data-tariff-price ${edit ? '' : 'disabled'}
        class="w-28 border border-slate-300 rounded-md px-2 py-1 text-sm text-right tabular-nums bg-white" />
      <span class="text-xs text-slate-500">€/kWh</span>
      ${edit ? `<button data-tariff-del="${i}" class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded ml-auto">${t('admin.remove')}</button>` : ''}
    </div>`;
  return `
    <details class="bg-white rounded-lg border border-slate-200" data-tariffs ${tariffs.length ? '' : 'open'}>
      <summary class="cursor-pointer select-none px-4 py-3 font-medium">${t('energy.tariffs', tariffs.length)}</summary>
      <div class="px-4 pb-3">
        <p class="text-xs text-slate-500 mb-2">${t('energy.tariffHint')}</p>
        <div id="tariff-rows">${tariffs.map(row).join('') || `<p class="text-sm text-slate-500">${t('energy.noTariff')}</p>`}</div>
        ${edit ? `
          <div class="mt-3 flex items-center justify-between gap-2">
            <button id="tariff-add" class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('energy.addTariff')}</button>
            <button id="tariff-save" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">${t('modal.save')}</button>
          </div>` : ''}
      </div>
    </details>`;
}

function readTariffRows(root) {
  return $$('[data-tariff-row]', root).map(r => ({
    validFrom: $('[data-tariff-from]', r).value,
    price: Number($('[data-tariff-price]', r).value),
  }));
}

function wireEnergy(root) {
  $$('[data-e-period]', root).forEach(b => b.addEventListener('click', () => {
    view.period = b.dataset.ePeriod; view.offset = 0; loadEnergy();
  }));
  $$('[data-e-shift]', root).forEach(b => b.addEventListener('click', () => {
    view.offset = Math.min(0, view.offset + Number(b.dataset.eShift)); loadEnergy();
  }));
  $('[data-e-today]', root)?.addEventListener('click', () => { view.offset = 0; loadEnergy(); });
  // Tariff editing works on the rows currently in the DOM, so unsaved edits
  // survive adding/removing a row.
  const rerenderTariffs = (list) => {
    tariffs = list;
    const d = $('[data-tariffs]', root);
    d.outerHTML = renderTariffs();
    $('[data-tariffs]', root).open = true;
    wireEnergy(root);
  };
  $('#tariff-add', root)?.addEventListener('click', () => {
    const list = readTariffRows(root);
    const last = list[list.length - 1];
    rerenderTariffs([...list, { validFrom: new Date().toISOString().slice(0, 10), price: last?.price ?? 0.3 }]);
  });
  $$('[data-tariff-del]', root).forEach(b => b.addEventListener('click', () => {
    const list = readTariffRows(root);
    list.splice(Number(b.dataset.tariffDel), 1);
    rerenderTariffs(list);
  }));
  $('#tariff-save', root)?.addEventListener('click', async () => {
    try {
      await api('api/energy/tariffs', { method: 'PUT', body: { tariffs: readTariffRows(root) } });
      loadEnergy();
    } catch (err) { alert(t('error.generic', err.message)); }
  });
}

export { loadEnergy, periodRange, isoWeek };
