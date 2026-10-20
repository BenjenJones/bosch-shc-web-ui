# Installation & updates

Step-by-step guides for every way to run the Bosch SHC Web UI. Pick **one**:

| You have … | Use | Effort |
| --- | --- | --- |
| Home Assistant OS / Supervised | [Home Assistant add-on](#home-assistant-add-on) | a few clicks |
| A NAS (Synology, QNAP, Unraid) or any machine with Docker | [Docker](#docker) | one file |
| A Raspberry Pi / Linux box without Docker | [Node.js on Linux](#nodejs-on-linux-raspberry-pi-debian-ubuntu) | ~15 min |
| A Windows PC that is always on | [Node.js on Windows](#nodejs-on-windows) | ~15 min |

All of them end in the same place: open `http://<ip-of-that-machine>:3000` and follow the [pairing wizard](#first-start-pairing-with-the-shc).

**What you need in any case:** a Bosch Smart Home Controller (I or II) on the same network, already set up in the Bosch app, and its **system password** (the one you chose when setting it up).

---

## Home Assistant add-on

1. In Home Assistant open **Settings → Add-ons → Add-on Store**.
2. Top right **⋮ → Repositories**, add `https://github.com/BenjenJones/bosch-shc-web-ui`, then **Close**.
3. Find **Bosch SHC Web UI** in the store, click **Install**, then **Start**.
4. Optionally enable **Show in sidebar**.
5. Click **Open Web UI** (or **Bosch SHC** in the sidebar) and [pair](#first-start-pairing-with-the-shc).

**Updates:** Home Assistant shows them like for any other add-on (*Settings → Updates*). Pairing, users and history are kept.

The UI opens inside Home Assistant (ingress), including remote access via Nabu Casa. Direct access via `http://<home-assistant-ip>:3000` works as well; clear the port in the add-on's *Network* settings if you don't want that. To embed the UI in a dashboard card, see `frame_ancestors` in the add-on's *Configuration* tab.

---

## Docker

A ready-made image for `amd64` (Intel/AMD) and `arm64` (Raspberry Pi 4/5, most current NAS) is published at `ghcr.io/benjenjones/bosch-shc-web-ui`. No git, no Node.js, nothing to build.

Everything the UI stores (pairing, login, certificates, history) lives in the `/data` volume, so it survives updates and restarts.

### Docker Compose (recommended)

1. Create a folder, e.g. `bosch-shc-ui`, and save [`docker-compose.yml`](../docker-compose.yml) into it:
   ```bash
   mkdir bosch-shc-ui && cd bosch-shc-ui
   curl -fsSLO https://raw.githubusercontent.com/BenjenJones/bosch-shc-web-ui/main/docker-compose.yml
   ```
2. Optionally adjust the time zone (`TZ`) or the port (left side of `"3000:3000"`) in the file.
3. Start it:
   ```bash
   docker compose up -d
   ```
4. Open `http://<ip>:3000` and [pair](#first-start-pairing-with-the-shc).

**Update:**
```bash
docker compose pull && docker compose up -d
```

### Plain `docker run`

```bash
docker run -d --name bosch-shc-ui --restart unless-stopped \
  -p 3000:3000 -e TZ=Europe/Berlin -v bosch-shc-data:/data \
  ghcr.io/benjenjones/bosch-shc-web-ui:latest
```

**Update:** `docker pull ghcr.io/benjenjones/bosch-shc-web-ui:latest`, then `docker rm -f bosch-shc-ui` and run the command above again. The data stays in the `bosch-shc-data` volume.

### Synology (Container Manager)

1. Install **Container Manager** from the Package Center.
2. In **File Station** create a folder, e.g. `docker/bosch-shc-ui`.
3. **Container Manager → Project → Create**:
   - *Project name*: `bosch-shc-ui`
   - *Path*: the folder from step 2
   - *Source*: **Create docker-compose.yml** and paste the content of [`docker-compose.yml`](../docker-compose.yml)
4. **Next → Next → Done.** The image is downloaded and the container starts.
5. Open `http://<nas-ip>:3000` and [pair](#first-start-pairing-with-the-shc).

**Update:** Container Manager marks the image with *Update available* under **Image** — select it and choose **Update**. Alternatively stop the project, delete the image under **Image** and start the project again; it downloads the newest version. Your data stays in the project folder's volume.

### Unraid

1. **Docker → Add Container**.
2. *Name* `bosch-shc-ui`, *Repository* `ghcr.io/benjenjones/bosch-shc-web-ui:latest`, *Network type* `bridge`.
3. **Add another Path, Port, Variable…**
   - *Port*: container `3000`, host `3000`
   - *Path*: container `/data`, host `/mnt/user/appdata/bosch-shc-ui`
   - *Variable*: key `TZ`, value `Europe/Berlin`
4. **Apply**, then open `http://<unraid-ip>:3000`.

**Update:** on the Docker tab click **Check for updates**, then **apply update**.

### Portainer

**Stacks → Add stack**, name `bosch-shc-ui`, paste [`docker-compose.yml`](../docker-compose.yml) into the web editor, **Deploy the stack**. Update: open the stack, **Pull and redeploy**.

---

## Node.js on Linux (Raspberry Pi, Debian, Ubuntu)

Runs the UI directly with Node.js as a system service that starts at boot.

**1. Install Node.js (current LTS) and git**
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v     # must be v22.13 or newer
```

**2. Download the UI**
```bash
sudo git clone https://github.com/BenjenJones/bosch-shc-web-ui.git /opt/bosch-shc-web-ui
cd /opt/bosch-shc-web-ui
sudo npm ci
sudo npm run build:css
```

**3. Create the service**
```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin bosch-shc
sudo cp deploy/bosch-shc-ui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bosch-shc-ui
```

**4.** Open `http://<ip-of-the-pi>:3000` and [pair](#first-start-pairing-with-the-shc).

Useful commands:
```bash
systemctl status bosch-shc-ui      # is it running?
journalctl -u bosch-shc-ui -f      # live log
sudo systemctl restart bosch-shc-ui
```

The service keeps its data in `/var/lib/bosch-shc-ui`, separate from the code — an update never touches it.

**Update:**
```bash
cd /opt/bosch-shc-web-ui
sudo git pull
sudo npm ci
sudo npm run build:css
sudo systemctl restart bosch-shc-ui
```

<details>
<summary>Moving an existing install (data next to the code) to the service</summary>

Older installs keep `config.json`, `auth.json`, `certs/`, `history.sqlite*` and `messages-archive.ndjson` in the project folder. Move them to the service's data folder once (with the service stopped):

```bash
sudo systemctl stop bosch-shc-ui
sudo mkdir -p /var/lib/bosch-shc-ui
cd /path/to/old/bosch-shc-web-ui
sudo cp -a config.json auth.json certs history.sqlite* messages-archive.ndjson /var/lib/bosch-shc-ui/ 2>/dev/null
sudo chown -R bosch-shc:bosch-shc /var/lib/bosch-shc-ui
sudo systemctl start bosch-shc-ui
```

If `config.json` contains absolute `certPath`/`keyPath` values, change them to `certs/client-cert.pem` and `certs/client-key.pem`.
</details>

To reset a forgotten admin password with the service setup:
```bash
cd /opt/bosch-shc-web-ui
sudo -u bosch-shc env BOSCH_SHC_DATA_DIR=/var/lib/bosch-shc-ui node setup.js --auth-only
sudo systemctl restart bosch-shc-ui
```

---

## Node.js on Windows

**1. Install Node.js and Git** — in PowerShell:
```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```
Close and reopen PowerShell afterwards so both are on the `PATH`.

**2. Download the UI**
```powershell
git clone https://github.com/BenjenJones/bosch-shc-web-ui.git C:\bosch-shc-web-ui
cd C:\bosch-shc-web-ui
npm ci
npm run build:css
```

**3. Start automatically with Windows** — in PowerShell **as Administrator**:
```powershell
$action   = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument 'server.js' -WorkingDirectory 'C:\bosch-shc-web-ui'
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Bosch SHC Web UI' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest
Start-ScheduledTask -TaskName 'Bosch SHC Web UI'

# allow other devices (phone, tablet) to reach port 3000
New-NetFirewallRule -DisplayName 'Bosch SHC Web UI' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

**4.** Open `http://localhost:3000` and [pair](#first-start-pairing-with-the-shc).

The UI now runs in the background, also when nobody is logged in. Data stays in `C:\bosch-shc-web-ui` (`config.json`, `auth.json`, `certs\`, `history.sqlite`, `dashboards.json`) — `git pull` doesn't touch these files.

**Update** — PowerShell as Administrator:
```powershell
Stop-ScheduledTask -TaskName 'Bosch SHC Web UI'
cd C:\bosch-shc-web-ui
git pull
npm ci
npm run build:css
Start-ScheduledTask -TaskName 'Bosch SHC Web UI'
```

---

## First start: pairing with the SHC

On first start the UI has no connection yet and shows a three-step wizard:

1. Enter the **IP address of your SHC** (shown in your router's device list, or in the Bosch app's controller details).
2. Press the **button on the front of the SHC** until its LED blinks, then enter the **system password** and submit quickly — pairing mode only lasts a short time.
3. Decide whether the UI should require a **login**. Recommended if anyone else on your network shouldn't be able to switch your devices. If yes, set an admin username and password. You can also skip this and turn login on (or off) later under *Admin → Login*.

The page reloads and shows your devices. In the Bosch app the UI appears as a connected client (`oss_bosch_shc_web_ui_…`).

| Problem | What's going on |
| --- | --- |
| *"SHC registration failed"* | The SHC wasn't in pairing mode (LED not blinking) or the system password is wrong. Press the button again and retry right away. |
| *"certificate generation failed"* | Usually the data folder isn't writable — the wizard shows the exact error. The certificate is created by Node itself, no OpenSSL needed. |
| Wizard never appears | The UI is already paired. To start over, stop it and delete `config.json`, `auth.json` and `certs/` from the data folder. |

---

## Update notifications

The UI checks GitHub twice a day for a newer release and shows an **Update** badge next to the title (hover for the versions, click for the changelog). The check sends no data except a normal web request to `api.github.com`. Turn it off with `"updateCheck": false` in `config.json` or the environment variable `BOSCH_SHC_UPDATE_CHECK=0`. In the Home Assistant add-on the badge shows too; install the update under *Settings → Updates* as usual. Turn it off there with the add-on option `update_check: false`.

## Backup

Back up the data folder — it contains everything:

| Install | Data folder |
| --- | --- |
| Home Assistant add-on | included in Home Assistant backups |
| Docker | the `/data` volume (`docker run --rm -v bosch-shc-data:/data -v "$PWD":/backup alpine tar czf /backup/bosch-shc-ui.tgz -C /data .`) |
| Linux service | `/var/lib/bosch-shc-ui` |
| Windows / plain `npm start` | `config.json`, `auth.json`, `certs/`, `history.sqlite*`, `messages-archive.ndjson`, `dashboards.json` in the project folder |

The files in `certs/` are the key to your SHC — keep the backup private.

## Uninstall

1. Remove the client `oss_bosch_shc_web_ui_…` from the SHC — in the Bosch app's list of connected devices / clients.
2. Remove the add-on / container (`docker compose down -v` also deletes the data volume) / service (`sudo systemctl disable --now bosch-shc-ui`, delete `/opt/bosch-shc-web-ui` and `/var/lib/bosch-shc-ui`) / scheduled task (`Unregister-ScheduledTask -TaskName 'Bosch SHC Web UI'`) and the folder.
