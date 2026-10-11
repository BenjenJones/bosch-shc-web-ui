import { state, $, notifyNewMessage, loadAll } from './core.js';
import { renderDevices } from './devices.js';
import { renderSecurity } from './security.js';
import { renderMessages, archiveMessage } from './messages.js';
import { renderScenarios } from './scenarios.js';
import { renderHealth } from './health.js';
import { renderPairingBanner } from './pairing.js';

function connectEvents() {
  // Full literal class strings per state — Tailwind's JIT only emits classes
  // it can find verbatim in the source, so we can't build `bg-${x}-500`.
  const DOT = {
    emerald: 'inline-block w-2.5 h-2.5 rounded-full bg-emerald-500',
    amber:   'inline-block w-2.5 h-2.5 rounded-full bg-amber-500',
    rose:    'inline-block w-2.5 h-2.5 rounded-full bg-rose-500',
  };
  const dot = (color) => $('#event-dot').className = DOT[color];

  // Keeping the stream alive on phones: when the app goes to the background
  // the OS freezes or drops the connection. Coming back, the EventSource is
  // either silently dead (still "open", no events) or — behind HA ingress —
  // its automatic reconnect hits a 401 from an expired ingress session, after
  // which EventSource gives up for good (readyState CLOSED). So:
  //  - the server sends a status heartbeat every 25 s; no sign of life for
  //    STALE_MS → reconnect,
  //  - CLOSED → reconnect ourselves with backoff,
  //  - back in the foreground after a while → reconnect right away,
  //  - after a reconnect that followed an outage, reload all data (events
  //    were missed). Only once the stream is open again, so an expired
  //    ingress session can't bounce us to our own login screen.
  const STALE_MS = 70e3;
  let ev = null, lastSeen = 0, retryTimer = null, retryDelay = 2000;
  let hiddenAt = null, refreshOnOpen = false;

  const scheduleReconnect = () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  };
  const reconnectNow = () => { retryDelay = 2000; refreshOnOpen = true; open(); };

  function open() {
    clearTimeout(retryTimer);
    if (ev) ev.close();
    ev = new EventSource('api/events');
    // EventSource open/error only tells us about the browser↔proxy link. The
    // lamp should reflect the proxy↔SHC link, which the server reports via a
    // `status` event. So: open → amber (link up, SHC status not known yet);
    // status event → green/red per the server; error (proxy lost) → red.
    ev.onopen = () => {
      dot('amber');
      lastSeen = Date.now();
      retryDelay = 2000;
      if (refreshOnOpen) { refreshOnOpen = false; loadAll().catch(() => {}); }
    };
    ev.onerror = () => {
      dot('rose');
      // While CONNECTING the browser retries by itself; CLOSED means it gave up.
      if (ev.readyState === EventSource.CLOSED) { refreshOnOpen = true; scheduleReconnect(); }
    };
    ev.addEventListener('status', onStatus);
    ev.onmessage = onMessage;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = null;
    if (away > 15e3 || Date.now() - lastSeen > STALE_MS || ev?.readyState !== EventSource.OPEN) reconnectNow();
  });
  window.addEventListener('online', reconnectNow);
  setInterval(() => {
    if (!document.hidden && ev && Date.now() - lastSeen > STALE_MS) reconnectNow();
  }, 15e3);

  function onStatus(e) {
    lastSeen = Date.now();
    let s; try { s = JSON.parse(e.data); } catch { return; }
    dot(s.connected ? 'emerald' : 'rose');
    if (!!s.pairingLost !== !!state.pairing.lost) {
      state.pairing.lost = !!s.pairingLost;
      renderPairingBanner();
    }
  }

  function onMessage(msg) {
    lastSeen = Date.now();
    let events; try { events = JSON.parse(msg.data); } catch { return; }
    let touchedDev = false, touchedMsg = false, touchedSec = false, touchedScn = false;
    for (const e of events) {
      if (e['@type'] === 'DeviceServiceData') {
        const idx = state.services.findIndex(s => s.id === e.id && s.deviceId === e.deviceId);
        if (idx >= 0) {
          const merged = { ...state.services[idx], ...e };
          // A cleared fault (e.g. battery replaced) arrives as an event without
          // `faults` — drop the old one instead of keeping it via the merge.
          if (!('faults' in e)) delete merged.faults;
          state.services[idx] = merged;
        } else state.services.push(e);
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
    if (touchedDev || touchedMsg) { renderDevices(); renderHealth(); }
    if (touchedSec) renderSecurity();
    if (touchedMsg) renderMessages();
    if (touchedScn) renderScenarios();
  }

  open();
}

export { connectEvents };
