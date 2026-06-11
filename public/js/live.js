import { state, $, notifyNewMessage } from './core.js';
import { renderDevices } from './devices.js';
import { renderSecurity } from './security.js';
import { renderMessages, archiveMessage } from './messages.js';
import { renderScenarios } from './scenarios.js';

function connectEvents() {
  const ev = new EventSource('/api/events');
  ev.onopen  = () => $('#event-dot').className = 'inline-block w-2.5 h-2.5 rounded-full bg-emerald-500';
  ev.onerror = () => $('#event-dot').className = 'inline-block w-2.5 h-2.5 rounded-full bg-rose-500';
  ev.onmessage = (msg) => {
    let events; try { events = JSON.parse(msg.data); } catch { return; }
    let touchedDev = false, touchedMsg = false, touchedSec = false, touchedScn = false;
    for (const e of events) {
      if (e['@type'] === 'DeviceServiceData') {
        const idx = state.services.findIndex(s => s.id === e.id && s.deviceId === e.deviceId);
        if (idx >= 0) state.services[idx] = { ...state.services[idx], ...e };
        else state.services.push(e);
        touchedDev = true;
        // Update IDS state live
        if (e.deviceId === 'intrusionDetectionSystem' && e.id === 'IntrusionDetectionControl') {
          state.intrusion = e; touchedSec = true;
        }
      } else if (e['@type'] === 'message') {
        const idx = state.messages.findIndex(m => m.id === e.id);
        if (e.deleted) {
          // A deletion event is a bare stub — just the id + `deleted: true`,
          // no messageCode/arguments/timestamp. Archive the *original* message
          // we're already holding, not the stub, then drop it from the active
          // list. If we never saw the original (e.g. dismissed on this client
          // and already removed), only archive the stub when nothing richer is
          // already in the archive, so we never clobber a full entry.
          const original = idx >= 0 ? state.messages[idx] : null;
          if (original) {
            archiveMessage(original);
            state.messages.splice(idx, 1);
          } else if (!state.messageArchive.some(m => m.id === e.id)) {
            archiveMessage(e);
          }
        } else if (idx >= 0) {
          state.messages[idx] = e;
        } else {
          state.messages.unshift(e);
          notifyNewMessage(e);
        }
        touchedMsg = true;
      } else if (e['@type'] === 'userDefinedState') {
        const idx = state.userdefinedstates.findIndex(u => u.id === e.id);
        if (idx >= 0) state.userdefinedstates[idx] = e;
        touchedScn = true;
      }
    }
    // Messages also drive the per-room marker on the Devices tab, so refresh
    // the device list when either devices or messages changed.
    if (touchedDev || touchedMsg) renderDevices();
    if (touchedSec) renderSecurity();
    if (touchedMsg) renderMessages();
    if (touchedScn) renderScenarios();
  };
}

export { connectEvents };
