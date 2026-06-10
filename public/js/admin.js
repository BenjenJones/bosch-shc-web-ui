import { state, $, $$, t, api, escapeHtml, loadAll, roomName, deviceName, deviceUpdateInfo } from './core.js';
import { showModal, hideModal, confirmModal, promptModal } from './modals.js';

function renderAdmin() {
  const sw = state.info.softwareUpdateState || {};
  const swState = sw.swUpdateState || 'UNKNOWN';
  const updateInfo = swState === 'UPDATE_AVAILABLE'
    ? `<span class="text-amber-700">${t('admin.updateAvailable', sw.swUpdateAvailableVersion)}</span>`
    : `<span class="text-emerald-700">${t('admin.upToDate', sw.swInstalledVersion || '-')}</span>`;
  $('#tab-admin').innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">

      <!-- System -->
      <article class="card bg-white rounded-lg p-5 border border-slate-200">
        <h3 class="font-medium mb-3">${t('admin.controller')}</h3>
        <dl class="text-sm space-y-1.5">
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.ip')}</dt>             <dd class="tabular-nums">${state.info.shcIpAddress || '-'}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.mac')}</dt>            <dd class="tabular-nums">${state.info.macAddress.toLowerCase().replaceAll(":", "-") || '-'}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.api')}</dt>            <dd class="tabular-nums">${(state.info.apiVersions||[]).join(', ')}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.firmware')}</dt>       <dd class="tabular-nums">${sw.swInstalledVersion || '-'}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.updateStatus')}</dt>   <dd>${updateInfo}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.devices')}</dt>        <dd class="tabular-nums">${state.devices.length}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.rooms')}</dt>          <dd class="tabular-nums">${state.rooms.length}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.scenarios')}</dt>      <dd class="tabular-nums">${state.scenarios.length}</dd></div>
          <div class="flex justify-between"><dt class="text-slate-500">${t('admin.automations')}</dt>    <dd class="tabular-nums">${state.automations.length}</dd></div>
        </dl>
      </article>

      <!-- Mobile devices / clients -->
      <article class="card bg-white rounded-lg p-5 border border-slate-200">
        <h3 class="font-medium mb-3">${t('admin.clients', state.clients.length)}</h3>
        <ul class="text-sm divide-y">
          ${state.clients.map(c => `
            <li class="flex items-center justify-between py-2">
              <div>
                <div>${c.name || c.id}</div>
                <div class="text-xs text-slate-500">${c.id}${c.primaryRole ? ' · ' + c.primaryRole : ''}</div>
              </div>
              <button data-client-del="${c.id}" data-client-name="${(c.name||c.id).replace(/"/g,'')}"
                class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded">${t('admin.remove')}</button>
            </li>`).join('') || `<li class="text-slate-500 py-2">${t('admin.noClients')}</li>`}
        </ul>
      </article>

      <!-- Rooms -->
      <article class="card bg-white rounded-lg p-5 border border-slate-200">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-medium">${t('admin.roomsHeader', state.rooms.length)}</h3>
          <button id="room-add"
            class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('admin.addRoom')}</button>
        </div>
        <ul class="text-sm divide-y">
          ${state.rooms.map(r => {
            const count = state.devices.filter(d => d.roomId === r.id).length;
            const countLabel = t(count === 1 ? 'admin.deviceCount' : 'admin.deviceCountP', count);
            return `<li class="flex items-center justify-between py-2">
              <div>
                <div>${r.name}</div>
                <div class="text-xs text-slate-500">${countLabel}</div>
              </div>
              <div class="flex gap-1 shrink-0">
                <button data-room-rename="${r.id}" data-name="${r.name.replace(/"/g,'')}"
                  class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('admin.rename')}</button>
                <button data-room-del="${r.id}" data-name="${r.name.replace(/"/g,'')}"
                  class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded">${t('admin.remove')}</button>
              </div>
            </li>`;
          }).join('')}
        </ul>
      </article>

      <!-- Manage devices -->
      <article class="card bg-white rounded-lg p-5 border border-slate-200">
        <h3 class="font-medium mb-3">
          ${t('admin.manageDevices', state.devices.filter(d=>d.roomId).length)}
          ${(() => {
            const n = state.devices.filter(d => d.roomId && deviceUpdateInfo(d).hasUpdate).length;
            return n > 0
              ? `<span class="text-xs ml-2 text-amber-700">${t(n === 1 ? 'admin.updatesAvail' : 'admin.updatesAvailP', n)}</span>`
              : '';
          })()}
        </h3>
        <div class="text-sm max-h-96 overflow-auto divide-y">
          ${state.devices.filter(d => d.roomId).map(d => {
            const u = deviceUpdateInfo(d);
            const fwLine = u.hasUpdate
              ? `<span class="text-amber-700">${t('admin.fwUpdate',
                    u.targetVersion ? t('admin.fwUpdateTo', u.targetVersion) : '',
                    u.currentVersion ? t('admin.fwUpdateCurrent', u.currentVersion) : '',
                    u.stateText ? ` - ${u.stateText}` : '')}</span>`
              : (u.currentVersion
                  ? `<span class="text-emerald-700">${t('admin.fwCurrent', u.currentVersion)}</span>`
                  : '');
            return `
            <div class="flex items-center justify-between py-2 gap-2">
              <div class="min-w-0">
                <div class="truncate">${d.name || d.id}</div>
                <div class="text-xs text-slate-500 truncate">
                  ${d.deviceModel || ''} · ${roomName(d.roomId)} · ${d.status||''}
                </div>
                ${fwLine ? `<div class="text-xs mt-0.5">${fwLine}</div>` : ''}
              </div>
              <div class="flex gap-1 shrink-0">
                <button data-device-inspect="${d.id}"
                  class="text-xs text-slate-600 hover:bg-slate-100 px-2 py-1 rounded" title="${t('admin.viewRaw')}">ⓘ</button>
                <button data-device-rename="${d.id}" data-name="${(d.name||'').replace(/"/g,'')}"
                  class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('admin.rename')}</button>
                <button data-device-del="${d.id}" data-name="${(d.name||d.id).replace(/"/g,'')}"
                  class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded">${t('admin.remove')}</button>
              </div>
            </div>`;
          }).join('')}
        </div>
      </article>

    </div>`;

  // Aktionen verdrahten
  $$('#tab-admin [data-client-del]').forEach(b => b.addEventListener('click', () =>
    confirmModal(t('modal.confirmRmClient', b.dataset.clientName), async () => {
      await api(`/api/clients/${encodeURIComponent(b.dataset.clientDel)}`, { method: 'DELETE' });
      await loadAll();
    })));

  $('#tab-admin #room-add')?.addEventListener('click', () =>
    promptModal(t('modal.addRoom'), '', async (name) => {
      await api('/api/rooms', {
        method: 'POST',
        body: { '@type': 'room', name, iconId: 'icon_room_misc' },
      });
      await loadAll();
    }));

  $$('#tab-admin [data-room-rename]').forEach(b => b.addEventListener('click', () =>
    promptModal(t('modal.renameRoom'), b.dataset.name, async (newName) => {
      const room = state.rooms.find(r => r.id === b.dataset.roomRename);
      await api(`/api/rooms/${encodeURIComponent(b.dataset.roomRename)}`, {
        method: 'PUT',
        body: { '@type': 'room', id: room?.id, iconId: room?.iconId, name: newName },
      });
      await loadAll();
    })));

  $$('#tab-admin [data-room-del]').forEach(b => b.addEventListener('click', () =>
    confirmModal(t('modal.confirmRmRoom', b.dataset.name), async () => {
      await api(`/api/rooms/${encodeURIComponent(b.dataset.roomDel)}`, { method: 'DELETE' });
      await loadAll();
    })));

  $$('#tab-admin [data-device-rename]').forEach(b => b.addEventListener('click', () =>
    promptModal(t('modal.renameDevice'), b.dataset.name, async (newName) => {
      await api(`/api/devices/${encodeURIComponent(b.dataset.deviceRename)}`,
        { method: 'PUT', body: { '@type': 'device', name: newName } });
      await loadAll();
    })));

  $$('#tab-admin [data-device-del]').forEach(b => b.addEventListener('click', () =>
    confirmModal(t('modal.confirmRmDevice', b.dataset.name), async () => {
      await api(`/api/devices/${encodeURIComponent(b.dataset.deviceDel)}`, { method: 'DELETE' });
      await loadAll();
    })));

  $$('#tab-admin [data-device-inspect]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.deviceInspect;
    const device = state.devices.find(d => d.id === id);
    const services = state.services.filter(s => s.deviceId === id);
    const noState = t('modal.noState');
    const serviceList = services.map(s =>
      `${s.id}${s.state ? ' = ' + JSON.stringify(s.state) : ' ' + noState}`
    ).join('\n');
    showModal(`
      <h4 class="font-medium mb-2 truncate">${device?.name || id}</h4>
      <p class="text-xs text-slate-500 mb-3">${t('modal.inspectDesc')}</p>
      <div class="space-y-3 max-h-[60vh] overflow-auto">
        <div>
          <div class="text-xs uppercase tracking-wide text-slate-500 mb-1">${t('modal.deviceLabel')}</div>
          <pre class="text-xs bg-slate-50 p-2 rounded overflow-auto">${escapeHtml(JSON.stringify(device, null, 2))}</pre>
        </div>
        <div>
          <div class="text-xs uppercase tracking-wide text-slate-500 mb-1">${t('modal.servicesLabel', services.length)}</div>
          <pre class="text-xs bg-slate-50 p-2 rounded overflow-auto">${escapeHtml(serviceList || t('modal.noServices'))}</pre>
        </div>
      </div>
      <div class="mt-4 flex justify-end">
        <button id="m-cancel" class="px-3 py-1.5 text-sm border border-slate-300 rounded-md">${t('modal.close')}</button>
      </div>`);
    $('#m-cancel').onclick = hideModal;
    // Make the modal a bit wider for the inspect view
    $('#modal-card').classList.remove('max-w-md');
    $('#modal-card').classList.add('max-w-2xl');
  }));

}


export { renderAdmin };
