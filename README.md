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
- Trigger at the press of a button

**Security**
- Arm / disarm intrusion detection (full, partial, custom)
- Mute an active alarm
- Toggle user-defined states (Present, Vacation, …)

**Admin** (mirrors the app's *Settings* area)
- Controller overview with firmware and update status
- List and remove mobile devices / clients
- Rename rooms
- Rename or remove devices, with per-device **firmware update status**
- Enable/disable automations and trigger them manually
- Inspect raw device JSON to see which services and fields a device exposes

**Messages**
- Translated titles for known codes (low battery, update available, …)
- Severity classification derived from `messageCode.category` and `flags`
- Source (device name) and timestamp formatted to your locale
- Collapsible raw-JSON view for details
- Per-message dismissal
- Tab badge showing the count of important messages

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

```bash
# 3. Start the UI
npm start
# → http://localhost:3000
```

## Security notes

- Setup uses `rejectUnauthorized: false` because the SHC presents a self-signed certificate. For a hardened deployment, Bosch recommends additional **host/CA pinning** — the required CAs are published in the official repo and can be wired into `server.js` (the `ca:` option of `https.Agent`).
- The certificates in `certs/` are your key to the SHC — don't commit them, don't share them. They are already covered by `.gitignore`.
- The UI server listens on `0.0.0.0:3000` by default (port configurable via `config.json` → `uiPort`). If you don't want it reachable from the LAN, bind it to `127.0.0.1` instead.

## Bosch licensing

The client id `oss_local_ui` follows the `oss_…` naming convention required by Bosch's terms. Per Bosch, the SHC API may only be used for **private, non-commercial purposes**.

## Extending

The backend proxy (`server.js`) is intentionally thin — adding a new endpoint usually means adding one entry to `GET_ENDPOINTS` or a single new route. The UI (`public/index.html`) renders generically from the `services` array; further service types can be added inside `renderDeviceCard()` (e.g. `ShutterControl`, `MultiLevelSwitch`, `BinarySwitch`, `IntrusionDetectionControl`).

The translation dictionary lives at the top of the `<script>` block in `public/index.html` (`I18N`); add new keys to both `de` and `en`.

## Troubleshooting

| Problem                    | Possible cause                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Setup: `401 Unauthorized`  | wrong system password                                                                                      |
| Setup: `400 Bad Request`   | SHC not in pairing mode, or client id already taken                                                        |
| Server start: `EADDRINUSE` | port 3000 already in use — change `uiPort` in `config.json`                                                |
| UI loads but no devices    | inspect `/api/devices` in the browser DevTools → Network                                                   |
| Live indicator red         | long-polling broke — check the server logs                                                                 |
| `503` from SHC on a `PUT`  | usually a wrong payload schema — open the device's *info* (ⓘ) in **Admin** to see the actual service state |

## License

MIT for this wrapper — see [LICENSE](LICENSE). The Bosch SHC API itself is governed by Bosch's terms (see the official repo).
