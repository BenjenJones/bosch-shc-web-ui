import { state, $, $$, t, api, escapeHtml, serviceOf, deviceName } from './core.js';
import { showModal, hideModal } from './modals.js';
import { renderDevices } from './devices.js';

// =========================================================================
//  Switch program (PowerSwitchProgram) — weekly on/off schedule of plugs and
//  light switches. State shape (as reported by the SHC):
//    { operationMode: 'AUTOMATIC'|'MANUAL',
//      schedule: { profiles: [{ day: 'MONDAY', switchPoints: [
//        { startTimeMinutes: 390, value: { '@type': 'switchStateSwitchPointValue', switchState: 'ON' } } ] }, …] } }
//  The state is documented (read); writing it back via PUT …/state is not part
//  of the documented API but uses the same generic state endpoint as every
//  other service.
// =========================================================================
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const SP_TYPE = 'switchStateSwitchPointValue';

let draft = null; // { deviceId, operationMode, days: { MONDAY: [{ min, on }] … } }

const locale = () => (state.lang === 'en' ? 'en-GB' : 'de-DE');
// Weekday names from Intl (2026-10-12 is a Monday).
const dayLabel = (i, style = 'short') =>
  new Date(2026, 9, 12 + i).toLocaleDateString(locale(), { weekday: style });
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// SHC state → editable draft (sorted, de-duplicated by time).
function toDraft(deviceId, st) {
  const days = Object.fromEntries(DAYS.map(d => [d, []]));
  for (const p of st?.schedule?.profiles || []) {
    if (!days[p.day]) continue;
    const pts = new Map();
    for (const sp of p.switchPoints || []) {
      const min = Math.max(0, Math.min(1439, Math.round(Number(sp.startTimeMinutes) || 0)));
      pts.set(min, sp.value?.switchState === 'ON');
    }
    days[p.day] = [...pts].map(([min, on]) => ({ min, on })).sort((a, b) => a.min - b.min);
  }
  return { deviceId, operationMode: st?.operationMode === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL', days };
}

// Draft → SHC state. A day without points gets "off from 00:00" so every
// profile stays valid (that's also what the SHC reports for unused days).
function fromDraft(d) {
  return {
    '@type': 'powerSwitchProgramState',
    operationMode: d.operationMode,
    schedule: {
      profiles: DAYS.map(day => ({
        day,
        switchPoints: (d.days[day].length ? d.days[day] : [{ min: 0, on: false }]).map(p => ({
          startTimeMinutes: p.min,
          value: { '@type': SP_TYPE, switchState: p.on ? 'ON' : 'OFF' },
        })),
      })),
    },
  };
}

// On/off segments of one day for the timeline bar. Before the day's first
// switch point the state carries over from the previous day's last point.
function daySegments(d, dayIdx) {
  const pts = d.days[DAYS[dayIdx]];
  let carry = false;
  for (let i = 1; i <= 7; i++) {
    const prev = d.days[DAYS[(dayIdx - i + 7) % 7]];
    if (prev.length) { carry = prev[prev.length - 1].on; break; }
  }
  const segs = [];
  let from = 0, on = carry;
  for (const p of pts) {
    if (p.min > from) segs.push({ from, to: p.min, on });
    from = p.min; on = p.on;
  }
  segs.push({ from, to: 1440, on });
  return segs.filter(s => s.to > s.from);
}

function renderEditor() {
  const d = draft;
  const rows = DAYS.map((day, i) => `
    <div class="py-2 border-b border-slate-200 last:border-0">
      <div class="flex items-center gap-2">
        <span class="w-9 shrink-0 text-sm font-medium">${escapeHtml(dayLabel(i))}</span>
        <div class="relative flex-1 h-3 rounded bg-slate-100 overflow-hidden" aria-hidden="true">
          ${daySegments(d, i).filter(s => s.on).map(s =>
            `<span class="absolute inset-y-0 bg-sky-500" style="left:${(s.from / 14.4).toFixed(2)}%;width:${((s.to - s.from) / 14.4).toFixed(2)}%"></span>`).join('')}
        </div>
      </div>
      <div class="flex flex-wrap gap-1 mt-1.5 pl-11">
        ${d.days[day].map((p, j) => `
          <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${p.on ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-600'}">
            <span class="tabular-nums">${hhmm(p.min)}</span> ${t(p.on ? 'program.on' : 'program.off')}
            <button type="button" data-sp-del="${day}:${j}" class="leading-none opacity-60 hover:opacity-100" aria-label="${t('admin.remove')}">×</button>
          </span>`).join('') || `<span class="text-xs text-slate-400">${t('program.noPoints')}</span>`}
      </div>
    </div>`).join('');

  showModal(`
    <div class="flex items-start justify-between gap-2 mb-3">
      <div>
        <h4 class="font-medium">${escapeHtml(deviceName(d.deviceId))}</h4>
        <p class="text-xs text-slate-500">${t('program.title')}</p>
      </div>
      <button id="p-close" class="text-slate-400 hover:text-slate-700 text-xl leading-none px-1" aria-label="${t('modal.cancel')}">×</button>
    </div>
    <div class="flex items-center gap-1.5 mb-1">
      ${['AUTOMATIC', 'MANUAL'].map(m => `<button data-p-mode="${m}"
        class="flex-1 px-2 py-1 rounded-md text-xs font-medium ${d.operationMode === m ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">${t(m === 'AUTOMATIC' ? 'program.auto' : 'program.manual')}</button>`).join('')}
    </div>
    <p class="text-xs text-slate-500 mb-2">${t(d.operationMode === 'AUTOMATIC' ? 'program.autoHint' : 'program.manualHint')}</p>
    <div class="max-h-[50vh] overflow-y-auto pr-1">${rows}</div>
    <div class="mt-3 pt-3 border-t border-slate-200">
      <div class="text-xs text-slate-500 mb-1.5">${t('program.addTitle')}</div>
      <div class="flex flex-wrap gap-1 mb-2" id="p-days">
        ${DAYS.map((day, i) => `<label class="inline-flex items-center gap-1 text-xs border border-slate-300 rounded px-1.5 py-0.5 cursor-pointer">
          <input type="checkbox" value="${day}" ${i < 5 ? 'checked' : ''} />${escapeHtml(dayLabel(i))}</label>`).join('')}
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <input type="time" id="p-time" value="07:00" step="60" class="border border-slate-300 rounded-md px-2 py-1 text-sm bg-white" />
        <select id="p-on" class="border border-slate-300 rounded-md px-2 py-1 text-sm bg-white">
          <option value="1">${t('program.on')}</option><option value="0">${t('program.off')}</option>
        </select>
        <button id="p-add" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md hover:bg-slate-100">${t('program.add')}</button>
      </div>
    </div>
    <div class="mt-4 flex justify-end gap-2">
      <button id="p-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.cancel')}</button>
      <button id="p-save" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">${t('modal.save')}</button>
    </div>`);
  $('#modal-card').classList.remove('max-w-md');
  $('#modal-card').classList.add('max-w-2xl');

  $('#p-close').onclick = hideModal;
  $('#p-cancel').onclick = hideModal;
  $$('[data-p-mode]').forEach(b => b.onclick = () => { d.operationMode = b.dataset.pMode; renderEditor(); });
  $$('[data-sp-del]').forEach(b => b.onclick = () => {
    const [day, j] = b.dataset.spDel.split(':');
    d.days[day].splice(Number(j), 1);
    renderEditor();
  });
  $('#p-add').onclick = () => {
    const [h, m] = ($('#p-time').value || '').split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    const min = h * 60 + m, on = $('#p-on').value === '1';
    const days = $$('#p-days input:checked').map(i => i.value);
    if (!days.length) return;
    for (const day of days) {
      // Same time on the same day: the new point replaces the old one.
      d.days[day] = [...d.days[day].filter(p => p.min !== min), { min, on }].sort((a, b) => a.min - b.min);
    }
    renderEditor();
  };
  $('#p-save').onclick = async () => {
    const body = fromDraft(d);
    try {
      await api(`api/devices/${encodeURIComponent(d.deviceId)}/services/PowerSwitchProgram/state`, { method: 'PUT', body });
      const svc = serviceOf(d.deviceId, 'PowerSwitchProgram');
      if (svc) svc.state = { ...(svc.state || {}), ...body };
      hideModal();
      renderDevices();
    } catch (err) { alert(t('error.generic', err.message)); }
  };
}

function openProgramEditor(deviceId) {
  draft = toDraft(deviceId, serviceOf(deviceId, 'PowerSwitchProgram')?.state);
  renderEditor();
}

export { openProgramEditor, toDraft, fromDraft, daySegments, DAYS };
