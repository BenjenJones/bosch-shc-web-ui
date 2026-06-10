import { state, $, $$, t, api } from './core.js';

// =========================================================================
//  Tab: Security (intrusion detection + user-defined states)
// =========================================================================
function renderSecurity() {
  const ids = state.intrusion;
  let idsBlock = '';
  if (ids?.state) {
    const value = ids.state.value || 'SYSTEM_DISARMED';
    const armed = value === 'SYSTEM_ARMED';
    const alarm = value === 'SYSTEM_ALARM' || value === 'MUTE_ALARM';
    const profiles = ids.state.activeConfigurationProfile != null
      ? ids.state.activeConfigurationProfile : '0';
    const remaining = ids.state.remainingTimeUntilArmed
      ? `<span class="text-xs text-slate-500">${t('security.remaining', Math.round(ids.state.remainingTimeUntilArmed/1000))}</span>` : '';
    const stateLabel =
      alarm ? t('security.alarmActive') :
      armed ? t('security.armed') :
      value === 'SYSTEM_ARMING' ? t('security.arming') :
      t('security.disarmed');
    idsBlock = `
      <article class="card bg-white rounded-lg p-5 border border-slate-200">
        <h3 class="font-medium">${t('security.alarm')}</h3>
        <div class="mt-2 flex items-center gap-3">
          <span class="inline-block w-3 h-3 rounded-full
            ${alarm ? 'bg-rose-500 pulse' : armed ? 'bg-emerald-500' : 'bg-slate-300'}"></span>
          <span class="font-semibold">${stateLabel}</span>
          ${remaining}
        </div>
        <p class="text-xs text-slate-500 mt-1">${t('security.activeProfile', profiles)}</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <button data-ids="SYSTEM_ARMED" data-profile="0"
            class="px-3 py-2 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700">
            ${t('security.fullProtection')}
          </button>
          <button data-ids="SYSTEM_ARMED" data-profile="1"
            class="px-3 py-2 text-sm rounded-md bg-emerald-100 text-emerald-800 hover:bg-emerald-200">
            ${t('security.partial')}
          </button>
          <button data-ids="SYSTEM_ARMED" data-profile="2"
            class="px-3 py-2 text-sm rounded-md bg-emerald-100 text-emerald-800 hover:bg-emerald-200">
            ${t('security.custom')}
          </button>
          <button data-ids="SYSTEM_DISARMED"
            class="px-3 py-2 text-sm rounded-md bg-slate-100 text-slate-700 hover:bg-slate-200">
            ${t('security.off')}
          </button>
          ${alarm ? `<button data-ids="MUTE_ALARM"
            class="px-3 py-2 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700">
            ${t('security.muteAlarm')}</button>` : ''}
        </div>
      </article>`;
  } else {
    idsBlock = `<article class="card bg-white rounded-lg p-5 border border-slate-200">
      <h3 class="font-medium">${t('security.alarm')}</h3>
      <p class="text-xs text-slate-500 mt-2">${t('security.notConfigured')}</p>
    </article>`;
  }

  $('#tab-security').innerHTML = idsBlock;

  $$('#tab-security [data-ids]').forEach(b => b.addEventListener('click', async () => {
    const value = b.dataset.ids;
    const body = { value };
    if (b.dataset.profile != null) body.activeProfile = b.dataset.profile;
    try { await api('/api/intrusion/state', { method: 'PUT', body }); }
    catch (err) { alert('Fehler: ' + err.message); }
  }));
}


export { renderSecurity };
