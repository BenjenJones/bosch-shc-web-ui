# TODO

Roadmap for the Bosch SHC Web UI. Hard rule for every item: **standalone mode
(plain `node server.js` / Docker, no Home Assistant) must keep working.**
HA-specific behaviour is always an optional extra detected at runtime.

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
