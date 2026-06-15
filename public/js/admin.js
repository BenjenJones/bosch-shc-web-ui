import { state, $, $$, t, api, escapeHtml, loadAll, roomName, deviceName, deviceUpdateInfo } from './core.js';
import { showModal, hideModal, confirmModal, promptModal } from './modals.js';
import { DEVICE_CATEGORIES, deviceCategory, deviceIcon } from './devices.js';

// Collapsed-state of the admin accordion sections, persisted so it survives the
// re-render that loadAll() triggers (e.g. after a room change).
const ADMIN_SECT_KEY = 'adminSectionsCollapsed';
function loadAdminCollapsed() {
  try { return JSON.parse(localStorage.getItem(ADMIN_SECT_KEY)) || {}; } catch { return {}; }
}
function saveAdminCollapsed(o) {
  try { localStorage.setItem(ADMIN_SECT_KEY, JSON.stringify(o)); } catch { /* ignore */ }
}

// One collapsible accordion section (full width, stacked).
function section(id, title, bodyHtml, { collapsed, badge = '' } = {}) {
  return `
    <details data-section="${id}" ${collapsed ? '' : 'open'}
      class="card bg-white rounded-lg border border-slate-200 overflow-hidden">
      <summary class="cursor-pointer select-none px-6 py-4 font-medium flex items-center justify-between gap-2 list-none">
        <span class="flex items-center gap-2">${title}${badge}</span>
        <span class="chevron text-slate-400 text-xs transition-transform">▼</span>
      </summary>
      <div class="px-6 pb-6 pt-1">${bodyHtml}</div>
    </details>`;
}

function renderAdmin() {
  const collapsed = loadAdminCollapsed();
  const sw = state.info.softwareUpdateState || {};
  const swState = sw.swUpdateState || 'UNKNOWN';
  const updateInfo = swState === 'UPDATE_AVAILABLE'
    ? `<span class="text-amber-700">${t('admin.updateAvailable', sw.swUpdateAvailableVersion)}</span>`
    : `<span class="text-emerald-700">${t('admin.upToDate', sw.swInstalledVersion || '-')}</span>`;

  // ---- System -----------------------------------------------------------
  const systemBody = `
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
    </dl>`;

  // ---- Clients ----------------------------------------------------------
  const clientsBody = `
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
    </ul>`;

  // ---- Rooms ------------------------------------------------------------
  const roomsBody = `
    <div class="flex justify-end mb-2">
      <button id="room-add" class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('admin.addRoom')}</button>
    </div>
    <ul class="text-sm divide-y">
      ${state.rooms.map(r => {
        const count = state.devices.filter(d => d.roomId === r.id).length;
        const countLabel = t(count === 1 ? 'admin.deviceCount' : 'admin.deviceCountP', count);
        return `<li class="flex items-center justify-between py-2">
          <div>
            <div>${r.name}</div>
            <div class="text-xs text-slate-500">${r.id} - ${countLabel}</div>
          </div>
          <div class="flex gap-1 shrink-0">
            <button data-room-rename="${r.id}" data-name="${r.name.replace(/"/g,'')}"
              class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('admin.rename')}</button>
            <button data-room-del="${r.id}" data-name="${r.name.replace(/"/g,'')}"
              class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded">${t('admin.remove')}</button>
          </div>
        </li>`;
      }).join('')}
    </ul>`;

  // ---- Manage devices (grouped by type) ---------------------------------
  const roomOptions = (selId) => state.rooms.map(r =>
    `<option value="${r.id}"${r.id === selId ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('');

  const deviceRow = (d) => {
    const u = deviceUpdateInfo(d);
    const fwLine = u.hasUpdate
      ? `<span class="text-amber-700">${t('admin.fwUpdate',
            u.targetVersion ? t('admin.fwUpdateTo', u.targetVersion) : '',
            u.currentVersion ? t('admin.fwUpdateCurrent', u.currentVersion) : '',
            u.stateText ? ` - ${u.stateText}` : '')}</span>`
      : (u.currentVersion ? `<span class="text-emerald-700">${t('admin.fwCurrent', u.currentVersion)}</span>` : '');
    return `
      <div class="flex items-center justify-between py-2 gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <img src="svg/${deviceIcon(d)}.svg" style="width:18px;height:18px" class="shrink-0" alt="" />
          <div class="min-w-0">
            <div class="truncate">${d.name || d.id}</div>
            <div class="text-xs text-slate-500 truncate">${d.deviceModel || ''} · ${d.status || ''}</div>
            ${fwLine ? `<div class="text-xs mt-0.5">${fwLine}</div>` : ''}
          </div>
        </div>
        <div class="flex gap-1 shrink-0 items-center">
          <select data-device-room="${d.id}" title="${t('admin.assignRoom')}"
            class="text-xs border border-slate-300 rounded px-1.5 py-1">
            ${roomOptions(d.roomId)}
          </select>
          <button data-device-inspect="${d.id}"
            class="text-xs text-slate-600 hover:bg-slate-100 px-2 py-1 rounded" title="${t('admin.viewRaw')}">ⓘ</button>
          <button data-device-rename="${d.id}" data-name="${(d.name||'').replace(/"/g,'')}"
            class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded">${t('admin.rename')}</button>
          <button data-device-del="${d.id}" data-name="${(d.name||d.id).replace(/"/g,'')}"
            class="text-xs text-rose-600 hover:bg-rose-50 px-2 py-1 rounded">${t('admin.remove')}</button>
        </div>
      </div>`;
  };

  // Group assigned devices by category, ordered as in DEVICE_CATEGORIES, with
  // an "other" bucket last for models without a category. ROOM_CLIMATE_CONTROL
  // is a virtual meta-device (room temperature control via the room thermostat),
  // not a real device — leave it out.
  const managed = state.devices.filter(d => d.roomId && d.deviceModel !== 'ROOM_CLIMATE_CONTROL');
  const groups = new Map();
  for (const d of managed) {
    const cat = deviceCategory(d) || 'other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(d);
  }
  const catOrder = [...DEVICE_CATEGORIES.map(c => c.id), 'other'];
  const orderedCats = [...groups.keys()].sort((a, b) => catOrder.indexOf(a) - catOrder.indexOf(b));
  const catIcon = (id) => DEVICE_CATEGORIES.find(c => c.id === id)?.icon;

  // Device-type groups start collapsed and behave as an exclusive accordion
  // (opening one closes the others) — see the toggle wiring below.
  const devicesBody = orderedCats.map(cat => {
    const devs = groups.get(cat).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const icon = catIcon(cat);
    return `
      <details data-devcat="${cat}" class="mt-3 first:mt-0">
        <summary class="cursor-pointer select-none list-none flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500 py-1">
          <span class="chevron text-[10px]">▼</span>
          ${icon ? `<img src="svg/${icon}.svg" style="width:16px;height:16px" alt="" />` : ''}
          <span>${t('devices.type.' + cat)} · ${devs.length}</span>
        </summary>
        <div class="divide-y pl-1">${devs.map(deviceRow).join('')}</div>
      </details>`;
  }).join('') || `<p class="text-slate-500 text-sm">${t('admin.noClients')}</p>`;

  const updatesN = managed.filter(d => deviceUpdateInfo(d).hasUpdate).length;
  const devicesBadge = updatesN > 0
    ? `<span class="text-xs ml-2 text-amber-700">${t(updatesN === 1 ? 'admin.updatesAvail' : 'admin.updatesAvailP', updatesN)}</span>`
    : '';

  $('#tab-admin').innerHTML = `
    <div class="space-y-4 max-w-4xl">
      ${section('system',  t('admin.controller'), systemBody, { collapsed: collapsed.system })}
      ${section('clients', t('admin.clients', state.clients.length), clientsBody, { collapsed: collapsed.clients })}
      ${section('rooms',   t('admin.roomsHeader', state.rooms.length), roomsBody, { collapsed: collapsed.rooms })}
      ${section('devices', t('admin.manageDevices', managed.length), devicesBody, { collapsed: collapsed.devices, badge: devicesBadge })}
    </div>`;

  // Persist accordion open/closed state.
  $$('#tab-admin details[data-section]').forEach(d => d.addEventListener('toggle', () => {
    const c = loadAdminCollapsed();
    c[d.dataset.section] = !d.open;
    saveAdminCollapsed(c);
  }));
  // Exclusive accordion: opening one device-type group collapses the others.
  $$('#tab-admin details[data-devcat]').forEach(d => d.addEventListener('toggle', () => {
    if (d.open) $$('#tab-admin details[data-devcat]').forEach(o => { if (o !== d) o.open = false; });
  }));

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

  $$('#tab-admin [data-device-room]').forEach(sel => sel.addEventListener('change', async () => {
    try {
      await api(`/api/devices/${encodeURIComponent(sel.dataset.deviceRoom)}`,
        { method: 'PUT', body: { '@type': 'device', roomId: sel.value } });
      await loadAll();
    } catch (err) { alert(t('error.generic', err.message)); }
  }));

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
    $('#modal-card').classList.remove('max-w-md');
    $('#modal-card').classList.add('max-w-2xl');
  }));
}


export { renderAdmin };
