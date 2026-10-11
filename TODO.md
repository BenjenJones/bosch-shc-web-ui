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
- [ ] **Favourites / kiosk view** — pin devices and scenarios; compact view
      with large buttons for wall tablets.
- [ ] **Home Assistant ingress** — optional sidebar panel via the Supervisor
      (`ingress: true`). Requires all UI/API URLs to be relative so the app
      works under `/api/hassio_ingress/<token>/` *and* at `/` standalone.
- [ ] **History & charts** — record SSE events (temperature, humidity, power,
      contacts) to SQLite (`node:sqlite`) in the data dir.
  - Tiered retention, configurable in the Admin tab (not only as add-on option):
    raw events 14 days, hourly min/max/avg 2 years, daily aggregates unlimited.
  - Nightly job aggregates and prunes.
  - Per-room sparkline, per-device 24 h / 7 d chart.
- [ ] **Energy dashboard** — hourly snapshots of the PowerMeter
      `energyConsumption` counter (Wh); consumption = delta. Day / week / month
      / year per plug, top consumers, optional cost with €/kWh price (with
      valid-from date for tariff changes). Retention default unlimited,
      configurable.
- [ ] **Heating schedule editor** — view/edit weekly profiles of
      RoomClimateControl. Verify against a real SHC first whether the endpoint
      is writable (undocumented).

## Later

- [ ] **Roles** — besides admin/user: read-only and guest (restricted to
      selected rooms).
- [ ] **Audit log** — who switched what and when.

## Not planned

- External push notifications (ntfy / Telegram / webhook) — not for now.
- Backup / export of rooms, scenarios, automations.
- Keyboard shortcuts / command palette.
