# Bosch SHC – Local Web UI

> **Disclaimer**
> This is an **unofficial, private hobby project** with **no affiliation** to Robert Bosch GmbH or Bosch Smart Home GmbH. "Bosch" and "Smart Home Controller" are trademarks of their respective owners. Use of the local Bosch SHC API is restricted to **private, non-commercial use** per Bosch's terms — see [bosch-shc-api-docs](https://github.com/BoschSmartHome/bosch-shc-api-docs). Use at your own risk; no warranty (see [LICENSE](LICENSE)).

A small, self-hostable web UI for the **Bosch Smart Home Controller**, built on top of the official [bosch-shc-api-docs](https://github.com/BoschSmartHome/bosch-shc-api-docs).

The UI is bilingual (English / German) — switch languages from the header.

## Architecture

```
Browser (UI) ──HTTP──▶ Node.js proxy (mTLS) ──HTTPS:8444──▶ Bosch SHC
                              │
                              └── long polling ─▶ Server-Sent Events ─▶ UI
```

The proxy is required because browsers cannot present client certificates (mTLS) to third-party hosts — but the SHC requires exactly that.

## Features

**Dashboard**
- Devices grouped by room, with collapsible room sections
- Filter bar (search by name, model, room) and expand/collapse-all buttons
- Per room with a room thermostat: temperature and humidity shown in the room header
- Switchable plugs / lights
- Heating setpoint (RoomClimateControl) including humidity
- Temperature, window/door contact, power consumption, battery status
- Communication-quality indicator (Wi-Fi-strength icon, color-coded)
- Camera controls: privacy mode, push notifications, light (where supported)
- **Live updates** without reload via long polling

**Scenarios**
- Enable/disable automations
- Toggle user defined states

**Security**
- Arm / disarm intrusion detection (full, partial, custom)
- Mute an active alarm
- Toggle user-defined states (Present, Vacation, …)

**Admin** (mirrors the app's *Settings* area)
- Controller overview with firmware and update status
- List and remove mobile devices / clients
- Rename rooms
- Rename or remove devices, with per-device **firmware update status**
- Inspect raw device JSON to see which services and fields a device exposes

**Messages**
- Translated titles for known codes (low battery, update available, …)
- Severity classification derived from `messageCode.category` and `flags`
- Source (device name) and timestamp formatted to your locale
- Collapsible raw-JSON view for details
- Per-message dismissal
- Tab badge showing the count of important messages
- Messages can be activated to also trigger browser notifications

**Authentication (optional)**
- Enabled at setup time — if disabled, the UI is open
- Admin account created during setup; passwords are stored as scrypt hashes with a per-user salt in `auth.json`
- Login issues an `HttpOnly` session cookie that stays valid indefinitely on the same device
- **Users tab** (admin only): create users with an initial password, reset a user's password, delete users — new users and password-reset users are forced to change their password on next login
- **Sessions tab** (admin only): see every active session (device, IP, last activity) and revoke individual sessions on demand
- Admin-only API endpoints (`/api/clients`, device & room rename/delete, user/session management) reject normal users on the server — the UI hides those tabs to match

## Requirements

- **Node.js ≥ 18**
- **OpenSSL** (for the one-time certificate generation — built in on macOS/Linux; on Windows available e.g. via Git Bash)
- Bosch Smart Home Controller (I or II) on the same network, already set up via the Bosch app
- The **system password** of the SHC (the one you chose during initial app setup)

## Installation

```bash
# 1. Install dependencies
npm install

# 2. Run setup (generates a certificate + registers a client with the SHC)
npm run setup
```

Setup will prompt for the **SHC IP address** and the **system password**. Right before answering, press the **front button on the SHC** until the LED starts blinking — that's pairing mode. The script then writes `certs/client-cert.pem`, `certs/client-key.pem`, and `config.json`.

Finally, setup asks whether the UI should be **protected by a login**. Answer `y` to create an initial admin account; password hash and sessions are then stored in `auth.json` (also gitignored). Answer `n` to leave the UI open. You can change the choice later by re-running `npm run setup`.

```bash
# 3. Start the UI
npm start
# → http://localhost:3000
```

`npm start` runs a `prestart` hook that compiles Tailwind CSS from `public/tailwind.src.css` into `public/tailwind.css` (gitignored). The CSS is fully self-hosted — no CDN — and tree-shaken to only the utilities the UI actually uses (~16 KB minified). If you ever serve `public/` without going through `npm start`, run `npm run build:css` first.

### Managing users (when auth is enabled)

After signing in as the admin you'll see three additional tabs:

- **Admin** — controller info, rooms, devices, paired Bosch clients
- **Users** — create new users with an initial password (they're forced to change it on first login), reset passwords, delete users
- **Sessions** — view every active session (user, device, IP, last activity) and revoke individual sessions; the revoked device is bounced back to the login screen on its next request

Regular users see only the Dashboard, Scenarios, Security and Messages tabs and can change their own password via the account button in the header.

## Security notes

- Setup uses `rejectUnauthorized: false` because the SHC presents a self-signed certificate. For a hardened deployment, Bosch recommends additional **host/CA pinning** — the required CAs are published in the official repo and can be wired into `server.js` (the `ca:` option of `https.Agent`).
- The certificates in `certs/` are your key to the SHC — don't commit them, don't share them. They are already covered by `.gitignore`.
- The UI server listens on `0.0.0.0:3000` by default (port configurable via `config.json` → `uiPort`). If you don't want it reachable from the LAN, bind it to `127.0.0.1` instead.
- `auth.json` contains password hashes (scrypt, per-user salt) and active session tokens. Treat it like a secret — it's already gitignored. Sessions are persisted so they survive server restarts; revoke a session from the **Sessions** tab to force a device to sign in again.

## Bosch licensing

The client id `oss_bosch_shc_web_ui` follows the `oss_…` naming convention required by Bosch's terms. Per Bosch, the SHC API may only be used for **private, non-commercial purposes**.

## Extending

The backend proxy (`server.js`) is intentionally thin — adding a new endpoint usually means adding one entry to `GET_ENDPOINTS` or a single new route. The UI (`public/index.html`) renders generically from the `services` array; further service types can be added inside `renderDeviceCard()` (e.g. `ShutterControl`, `MultiLevelSwitch`, `BinarySwitch`, `IntrusionDetectionControl`).

The translation dictionaries live in `public/i18n/de.json` and `public/i18n/en.json`; add new keys to both.

For frontend iteration, `npm run watch:css` rebuilds `public/tailwind.css` on every change to `public/index.html` or `public/app.js` so new utility classes show up without restarting the server.

## Troubleshooting

| Problem                              | Possible cause                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Setup: `401 Unauthorized`            | wrong system password                                                                                      |
| Setup: `400 Bad Request`             | SHC not in pairing mode, or client id already taken                                                        |
| Server start: `EADDRINUSE`           | port 3000 already in use — change `uiPort` in `config.json`                                                |
| Server start: `auth.json is missing` | `authEnabled` is true in `config.json` but `auth.json` was deleted — re-run `npm run setup`                |
| UI loads but no devices              | inspect `/api/devices` in the browser DevTools → Network                                                   |
| Live indicator red                   | long-polling broke — or the session was revoked; check the server logs / refresh and re-login              |
| Forgot the admin password            | re-run `npm run setup` — it rewrites the admin in `auth.json`, keeps existing regular users, and clears all sessions |
| `503` from SHC on a `PUT`            | usually a wrong payload schema — open the device's *info* (ⓘ) in **Admin** to see the actual service state |

## License

MIT for this wrapper — see [LICENSE](LICENSE). The Bosch SHC API itself is governed by Bosch's terms (see the official repo).
