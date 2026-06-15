# Changelog

## 2026-06-15

- (Dashboard) Control motorised shutters/blinds from the device card — position slider (`ShutterControl` level), Open/Stop/Close buttons and an Opening/Closing status badge.
- (Dashboard) Control lights from the device card — on/off for `BinarySwitch` devices (e.g. Hue, micromodule light/switch that expose no `PowerSwitch`), a brightness slider (`MultiLevelSwitch`) and a colour picker (`HSBColorActuator`).
- (Dashboard) Trigger momentary relays (`ImpulseSwitch`, e.g. garage door) with a single button.
- (Demo) Seed light/switch states (brightness, colour, on/off, impulse) so the new controls are testable; add matching `build-dataset.js` fallback generators.

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