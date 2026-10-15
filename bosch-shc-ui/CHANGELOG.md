# Changelog

## 2026-10-15

- (Dashboard) Rooms with a humidity sensor (e.g. Room Thermostat II, Twinguard) show a 24 h humidity sparkline next to the humidity value; clicking it opens the history chart on the humidity tab.
- (Dashboard) Device cards with active messages show a bell with the message count, tinted by the most severe message. Clicking it lists the device's messages in a dialog, where they can be dismissed just like on the *Messages* tab.
- (Dashboard) On touch screens the room header no longer shows the setpoint slider — it was too easy to change the target by accident while scrolling. Only − / + (0.5 °C steps) around the target remain; desktop keeps the slider.
- (Auth) Fix: without user management, opening the *Sessions* tab crashed the request (`Cannot read properties of undefined (reading 'token')`); deleting a user had the same flaw. The *Users* and *Sessions* tabs are now hidden when user management is off.

## 2026-10-11 - 3

- (Live) Fix: after the HA app (or a browser tab) was in the background, the live lamp stayed red until you switched views. The live stream now reconnects on its own — on return to the foreground, when the server heartbeat (every 25 s) goes missing, and when the browser gives up after an error such as an expired HA ingress session — and reloads the data once it is back.

## 2026-10-11 - 2

- (Pairing) Fix: two installations (e.g. HA add-on and a local server) paired with the same fixed client id, so pairing one silently invalidated the other ("certificate unknown"). Every new pairing now registers its own client id (`oss_bosch_shc_web_ui_xxxxxx`) with a fresh certificate. When the SHC rejects the certificate, the UI shows a banner and admins can **re-pair** in place (banner or *Admin → Controller*) without losing users, history or settings. Existing pairings keep working unchanged.

## 2026-10-11

- (Dashboard) Calmer device cards: the header shows only name and signal (status pill only when a device is not available); favourite, history and settings moved to a footer next to battery/valve. The virtual room climate controller is titled "Room climate".
- (Dashboard) Room climate cards get a *Schedule / Manual* toggle (follow the heating schedule from the Bosch app or hold the set temperature).
- (Energy) New *Energy* tab: consumption of all metering devices per day/week/month/year (browsable), cost from configurable electricity prices with valid-from dates (tariff changes), comparison with the previous period, live total power, consumption chart and a per-device ranking with share and cost. Based on the recorded energy-counter history.
- (History) Sensor history with charts: values are recorded into SQLite (live events + a 15-minute snapshot) with tiered retention (individual 14 d, hourly 730 d, daily unlimited — configurable under Admin → History). Device cards get a chart button (24 h / 7 d / 30 d / 1 y; min/max band, setpoint overlay, energy as consumption bars), rooms show a 24 h temperature sparkline. Requires Node ≥ 22.5 (`node:sqlite`); older Node runs without history. The demo seeds a year of synthetic history.
- (Add-on) Home Assistant ingress: the UI now appears as a "Bosch SHC" sidebar panel, served through HA (remote access/HTTPS included). All UI URLs are relative, so it runs under the ingress sub-path and behind any sub-path reverse proxy; standalone use at `/` is unchanged. Framing by HA is only allowed for genuine ingress requests (from the Supervisor); the UI's own login still applies in the panel.
- (Dashboard) Favourites: pin devices and scenarios with ☆; pinned items appear in a section at the top of the dashboard, scenarios as one-tap buttons. Stored per browser. Cards outside their room show the room name.
- (Kiosk) New kiosk view for wall tablets (header button or `?kiosk`): clock and favourites only, larger controls, screen kept awake where supported; remembered across reloads until exited.
- (PWA) The UI can be installed as an app ("Install app" / "Add to Home Screen"): web app manifest, icons, and a network-first service worker that keeps the app shell available offline (API calls and the live stream are never cached). Requires HTTPS with a trusted certificate or `localhost`; plain HTTP keeps working without install. The browser title bar follows the light/dark theme.
- (Dashboard) Grouped shutter control: rooms with two or more shutters get open/stop/close buttons and an average-position slider in the room header; with two or more shutters overall, an "All shutters" bar sits above the rooms. A shutter that fails doesn't stop the others; failures are reported once.
- (Dashboard) Boost mode: room climate controls that support it show a Boost toggle on the card, and an active boost is shown in the room header.
- (Health) New *Health* tab: summary tiles and an issue list for unreachable devices, low/critical batteries, device faults, poor signal and pending firmware updates (tiles filter the list), plus a list of all battery devices and of signal quality, worst first. The tab badge counts devices with warnings or errors and updates live.

## 2026-10-10

- (Dashboard) Fix battery badge showing "OK" for a device with low battery — the SHC reports `LOW_BATTERY` as a fault on the BatteryLevel *service*, not on the device. Faults are now read from the service, the device and active battery messages; unknown levels no longer show a full battery, and a cleared fault in a live event is no longer kept from the previous state.
- (Dashboard) Show other device faults (any service's `faults`, e.g. TRV `VALVE_NO_MOTOR_ERROR`) as a red/amber badge on the device card; unknown fault codes are shown raw.

## 2026-08-30

- (Build) Fix `npm start` failing when installed without dev dependencies (`npm install --omit=dev`) — the `prestart` CSS build needs the `tailwindcss` binary, so `@tailwindcss/cli` moved from `devDependencies` to `dependencies` ([#6](https://github.com/BenjenJones/bosch-shc-web-ui/issues/6)).
- (Build) Apply non-breaking `npm audit fix` for dev tooling — fast-uri, js-yaml, nanoid and postcss advisories. Production deps remain at 0 vulnerabilities.

## 2026-07-19

- (Messages) Inactive messages are now grouped by day and collapsible — the whole archive plus each day is a foldable section, with the open/closed state remembered across reloads (per calendar day). The most recent day starts open.

## 2026-07-13

- (System) Fix live events silently stopping — the SHC returns a JSON-RPC error in a 200 body when a long-poll subscription expires (e.g. after an SHC restart), which wasn't detected, so the loop kept polling a dead subscription: connection lamp stayed green but no events reached the UI. Now the error is caught and the client re-subscribes automatically.

## 2026-06-28

- (System) fix wrong connected state
- (Dashboard) Thermostats show heating paused, due to open windows
- (Messages) Archive active messages (mark as read)
  - However, deleting an active-archived message, will cause it to reappear under active messages

## 2026-06-20

- (Dashboard) Control heating circuits (`HEATING_CIRCUIT`) from the device card — AUTOMATIC/MANUAL mode toggle and a 5–30 °C target slider (`HeatingCircuit`, debounced PUT). New device type with radiator icon and sort/category placement.
- (Dashboard) Show air quality on Twinguard cards — purity in ppm coloured by the combined rating (`AirQualityLevel`).
- (Dashboard) Show brightness on motion detectors — `MultiLevelSensor` illuminance (Gen2 lux value / Gen1 LOW·MEDIUM·HIGH).
- (Dashboard) Per-device settings dialog (⚙) gains child lock for non-thermostat actuators (`ChildProtection`, `childLockActive`) — micromodule dimmer/relay/shutter and BSM light switches.
- (Demo) Seed states so the new controls are testable — a heating-circuit device, motion-detector illuminance and a `ChildProtection` state.

## 2026-06-19

- (Dashboard) Climate on Room badge level

## 2026-06-18

- (HomeAssistant) Integration as Home Assistant App

## 2026-06-15

- (Dashboard) Control motorised shutters/blinds from the device card — position slider (`ShutterControl` level), Open/Stop/Close buttons and an Opening/Closing status badge.
- (Dashboard) Control lights from the device card — on/off for `BinarySwitch` devices (e.g. Hue, micromodule light/switch that expose no `PowerSwitch`), a brightness slider (`MultiLevelSwitch`) and a colour picker (`HSBColorActuator`).
- (Dashboard) Trigger momentary relays (`ImpulseSwitch`, e.g. garage door) with a single button.
- (Dashboard) Per-device settings dialog (⚙ on the card) — child lock (`Thermostat`), temperature offset (`TemperatureOffset`), state after power outage (`PowerSwitchConfiguration`), vibration sensor enable/sensitivity (`VibrationSensor`), pause/bypass (`Bypass`) and universal-switch (WRC2) button→scenario mapping (`KeypadTrigger`, upper/lower × short/long). Shown only for devices that expose the matching service.
- (Admin) Assign a device to a room from the device list (`roomId` dropdown).
- (Admin) Stack the sections into a full-width, collapsible accordion (open/closed state persisted) so the device list has room to breathe.
- (Admin) Group managed devices by type; the type groups start collapsed and behave as an exclusive accordion (opening one closes the others).
- (Admin) Drop the virtual `ROOM_CLIMATE_CONTROL` meta-device from the managed-devices list — it only models room temperature control via the room thermostat.
- (Dashboard) Hide the temperature-offset setting on a radiator thermostat (TRV) when a room thermostat shares its room — the room thermostat drives the temperature there. Offset is shown in °C.
- (Demo) Seed states so the new controls/settings are testable — light/switch (brightness, colour, on/off, impulse), WRC2 button→scenario mappings, and config services (child lock, temperature offset, power-outage state, vibration, bypass); add matching `build-dataset.js` fallback generators. Co-locate the demo room thermostat with the radiator thermostat to exercise the offset-hiding rule.

## 2026-06-12

- (Demo) Add demo mode — `npm run demo` runs a self-contained demo SHC that mimics the controller's `/smarthome/*` HTTP API; the normal UI server connects to it via `shcProtocol: 'http'`, so `server.js` carries no demo-specific code. Separate port (3001, override `BOSCH_SHC_DEMO_PORT`); no SHC, certs or login required, runs alongside a real instance.
- (Demo) Add `demo/build-dataset.js` (`npm run demo:build`) — generates an anonymized, committed dataset under `demo/dataset/` from local `examples/*` exports: one device per model, automations covering every trigger/condition/action type, scenarios per action type. IDs/serials/UUIDs replaced with placeholders, device names genericized, push messages scrubbed; `examples/` is gitignored.
- (Dashboard) Show a battery badge on battery-powered devices — green "OK", amber/red on `LOW_BATTERY`/`CRITICAL_LOW_BATTERY` from device `faults`.
- (Dashboard) Silent mode on thermostats is switchable again — toggles `MODE_SILENT`/`MODE_NORMAL` (was display-only).
- (Demo) Seed active and archived system messages (low battery, software update, unreachable, …) referencing demo devices; dismiss/archive works in memory.

## 2026-06-11

- (Server) Optional native HTTPS via `config.json` → `uiTls` (`certPath`/`keyPath`); falls back to HTTP when unset.
- (Font) Include "Cascadia Code" as FontFace
- (Messages) Add archived messages.
- (Dashboard) Show a marker on rooms that have active messages.
- (Dashboard) Show in the room badge how many devices are switched on.
- (Setup) Add `npm run setup:auth` — (re)set the admin login from the console without re-pairing the SHC.

## 2026-06-10

- (Dashboard) Show Open/Closed Status on Room Badge 

## 2026-05-30

- (Scenarios) Added Automations Editor PoC
- (Scenarios) Added Scenarios Editor PoC
- (Scenarios) Added States Editor