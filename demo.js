/**
 * Demo-Modus-Starter (`npm run demo`).
 *
 * Statt server.js mit Demo-Sonderwegen zu durchsetzen, läuft hier echte
 * Abstraktion:
 *
 *   1. Ein Demo-SHC (demo/shc-server.js) bildet die `/smarthome/...`-API der
 *      echten Box über HTTP nach, gespeist aus dem Demo-Datensatz.
 *   2. Eine temporäre config.json lässt server.js sich — wie im Test-Harness —
 *      per `shcProtocol:'http'` ganz normal mit diesem Demo-SHC verbinden.
 *      Keine echten Zertifikate, kein Login, keine echte Box.
 *   3. Eine temporäre Archiv-NDJSON seedet die (server-lokale) Nachrichten-
 *      historie. Mutationen (Dismiss/Archivieren) landen nur in dieser
 *      Tempdatei — die echten Daten bleiben unangetastet.
 *
 * Läuft auf einem eigenen Port (Default 3001, override via
 * BOSCH_SHC_DEMO_PORT), damit er parallel zum echten Server (3000) laufen kann.
 *
 *   npm run demo   ->   http://localhost:3001
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const UI_PORT  = parseInt(process.env.BOSCH_SHC_DEMO_PORT, 10) || 3001;
const SHC_PORT = parseInt(process.env.BOSCH_SHC_DEMO_SHC_PORT, 10) || 8454;
const SHC_HOST = '127.0.0.1';

// 1. Demo-SHC starten.
const shcApp = require('./demo/shc-server.js');
shcApp.listen(SHC_PORT, SHC_HOST, () => {
  console.log(`▶ Demo-SHC (in-memory) auf http://${SHC_HOST}:${SHC_PORT}`);
});

// 2./3. Temporäre Config + Archiv-Seed schreiben, Pfade per env an server.js.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bosch-shc-demo-'));
const configFile  = path.join(tmp, 'config.json');
const archiveFile = path.join(tmp, 'messages-archive.ndjson');

fs.writeFileSync(configFile, JSON.stringify({
  shcProtocol: 'http',
  shcIp: SHC_HOST,
  shcPort: SHC_PORT,
  authEnabled: false,
  uiPort: UI_PORT,
  clientId: 'oss_bosch_shc_web_ui',
}, null, 2));

// Archiv-Seed aus dem Datensatz (bereits mit Zeitstempeln versehen) als NDJSON.
const { store } = require('./demo/demo-data.js');
const ndjson = (store.messageArchive || []).map(m => JSON.stringify(m)).join('\n');
fs.writeFileSync(archiveFile, ndjson ? ndjson + '\n' : '');

process.env.BOSCH_SHC_CONFIG_FILE          = configFile;
process.env.BOSCH_SHC_AUTH_FILE            = path.join(tmp, 'auth.json'); // ungenutzt (Auth aus)
process.env.BOSCH_SHC_MESSAGE_ARCHIVE_FILE = archiveFile;

// Tempverzeichnis beim Beenden aufräumen.
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* egal */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// 4. Normalen UI-Server booten — der findet jetzt eine gültige Config vor und
//    verbindet sich gegen den Demo-SHC.
require('./server.js');
