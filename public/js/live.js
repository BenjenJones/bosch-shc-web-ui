import { state, $, notifyNewMessage } from './core.js';
import { renderDevices } from './devices.js';
import { renderSecurity } from './security.js';
import { renderMessages } from './messages.js';
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
        // existing update or brand new?
        const idx = state.messages.findIndex(m => m.id === e.id);
        if (idx >= 0) state.messages[idx] = e;
        else {
          state.messages.unshift(e);
          if (!e.deleted) notifyNewMessage(e);
        }
        touchedMsg = true;
      } else if (e['@type'] === 'userDefinedState') {
        const idx = state.userdefinedstates.findIndex(u => u.id === e.id);
        if (idx >= 0) state.userdefinedstates[idx] = e;
        touchedScn = true;
      }
    }
    if (touchedDev) renderDevices();
    if (touchedSec) renderSecurity();
    if (touchedMsg) renderMessages();
    if (touchedScn) renderScenarios();
  };
}

export { connectEvents };
