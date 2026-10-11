# TODO

Roadmap for the Bosch SHC Web UI. Hard rule for every item: **standalone mode
(plain `node server.js` / Docker, no Home Assistant) must keep working.**
HA-specific behaviour is always an optional extra detected at runtime.

## Planned

- [x] **Health overview** — one list across all devices: battery level (sorted
      worst first), poor communication quality, device faults / unavailable
      devices, pending firmware updates.
- [x] **Grouped shutter control** — open/close/stop per room and for all
      shutters, plus a percentage slider.
- [x] **Heating boost mode** — show and toggle boost on room climate control.
- [x] **PWA** — web app manifest + service worker so the UI can be installed
      to the home screen.
- [x] **Favourites / kiosk view** — pin devices and scenarios; compact view
      with large buttons for wall tablets.
- [x] **Home Assistant ingress** — optional sidebar panel via the Supervisor
      (`ingress: true`). Requires all UI/API URLs to be relative so the app
      works under `/api/hassio_ingress/<token>/` *and* at `/` standalone.
- [x] **History & charts** — record SSE events (temperature, humidity, power,
      contacts) to SQLite (`node:sqlite`) in the data dir.
  - Tiered retention, configurable in the Admin tab (not only as add-on option):
    raw events 14 days, hourly min/max/avg 2 years, daily aggregates unlimited.
  - Nightly job aggregates and prunes.
  - Per-room sparkline, per-device 24 h / 7 d chart.
- [x] **Energy dashboard** — hourly snapshots of the PowerMeter
      `energyConsumption` counter (Wh); consumption = delta. Day / week / month
      / year per plug, top consumers, optional cost with €/kWh price (with
      valid-from date for tariff changes). Retention default unlimited,
      configurable.
- [x] **Room climate: schedule ↔ manual** — toggle `operationMode` per room
      (documented as read-only; writing it — like `boostMode` — is confirmed
      to work on the real SHC).

## Later

- [ ] **Roles** — besides admin/user: read-only and guest (restricted to
      selected rooms).
- [ ] **Audit log** — who switched what and when.

## Not planned

- Heating schedule editor — the weekly heating profiles are not exposed by any
  documented service (RoomClimateControl only reports `activeScheduleId`);
  probing undocumented endpoints would conflict with Bosch's API terms
  (no reverse engineering). Schedules stay in the Bosch app; the UI can
  switch a room between schedule and manual.
- Switch program editor for plugs — `PowerSwitchProgram` reports a weekly
  profile, but the SHC rejects writing it, and the Bosch app offers no such
  editor either (only manual/automatic and an on-duration).

- External push notifications (ntfy / Telegram / webhook) — not for now.
- Backup / export of rooms, scenarios, automations.
- Keyboard shortcuts / command palette.
