#!/usr/bin/env node
/**
 * One-time setup for the Bosch SHC.
 *
 * This file does two things:
 *  1. Exports a small library of helpers (ensureCerts, registerClient,
 *     writeConfig, …) used by both the CLI flow at the bottom of this file
 *     AND by the in-app web wizard exposed at /api/setup/* in server.js.
 *  2. When invoked directly (`node setup.js` / `npm run setup`), runs the
 *     classic interactive CLI flow.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const readline = require('readline');
const { execSync } = require('child_process');

// All runtime-writable state lives under DATA_DIR. Defaults to this source
// dir (unchanged for bare `npm start`); in a container set BOSCH_SHC_DATA_DIR
// to a mounted volume (e.g. /data) so pairing/auth/certs survive restarts and
// image updates.
const DATA_DIR    = process.env.BOSCH_SHC_DATA_DIR
  ? path.resolve(process.env.BOSCH_SHC_DATA_DIR)
  : __dirname;
const CERT_DIR    = path.join(DATA_DIR, 'certs');
const CERT_FILE   = path.join(CERT_DIR, 'client-cert.pem');
const KEY_FILE    = path.join(CERT_DIR, 'client-key.pem');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUTH_FILE   = path.join(DATA_DIR, 'auth.json');

// Per Bosch terms: client id must start with "oss_"
const CLIENT_ID   = 'oss_bosch_shc_web_ui';
const CLIENT_NAME = 'oss_bosch_shc_web_ui';

// =========================================================================
//  Shared helpers — used by the CLI flow and the web wizard alike.
// =========================================================================

function ensureCerts() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) return { generated: false };
  fs.mkdirSync(CERT_DIR, { recursive: true });
  // openssl is documented as a requirement; we don't ship a JS fallback to
  // keep the dependency surface small. The web wizard surfaces a clear error
  // if it isn't on PATH.
  execSync(
    `openssl req -x509 -nodes -days 9999 -newkey rsa:2048 ` +
    `-keyout "${KEY_FILE}" -out "${CERT_FILE}" ` +
    `-subj "/CN=${CLIENT_ID}"`,
    { stdio: 'pipe' }
  );
  return { generated: true };
}

function formatCertForBosch(pem) {
  // Bosch expects the cert string with \r before/after the BEGIN/END lines
  // and no CR/LF inside (see the Bosch Postman docs).
  const oneLine = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  return `-----BEGIN CERTIFICATE-----\r${oneLine}\r-----END CERTIFICATE-----`;
}

function registerClient(shcIp, password, certPem) {
  const body = JSON.stringify({
    '@type': 'client',
    id: CLIENT_ID,
    name: CLIENT_NAME,
    primaryRole: 'ROLE_RESTRICTED_CLIENT',
    certificate: formatCertForBosch(certPem),
  });
  const options = {
    host: shcIp,
    port: 8443,
    method: 'POST',
    path: '/smarthome/clients',
    rejectUnauthorized: false,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Systempassword': Buffer.from(password, 'utf8').toString('base64'),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else {
          const err = new Error(`SHC responded with ${res.statusCode}: ${data}`);
          err.status = res.statusCode; err.body = data;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, passwordHash: hash };
}

function writeConfig({ shcIp, authEnabled }) {
  const config = {
    shcIp,
    certPath: path.relative(DATA_DIR, CERT_FILE),
    keyPath:  path.relative(DATA_DIR, KEY_FILE),
    clientId: CLIENT_ID,
    uiPort: 3000,
    authEnabled: !!authEnabled,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

function writeAuth({ adminUsername, adminPassword }) {
  // Re-running setup with auth enabled: keep existing regular users (the
  // admin is rewritten from this run), but drop ALL sessions — re-pairing
  // is the documented "recover admin access" path, and stale sessions
  // must not outlive a password rotation.
  const { salt, passwordHash } = hashPassword(adminPassword);
  const adminUser = {
    username: adminUsername,
    salt, passwordHash,
    role: 'admin',
    mustChangePassword: false,
    createdAt: Date.now(),
  };
  let keepUsers = [];
  try {
    const prev = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (Array.isArray(prev?.users)) {
      keepUsers = prev.users.filter(u =>
        u && u.role !== 'admin' && u.username !== adminUser.username);
    }
  } catch (_) { /* no previous file */ }
  const authData = { users: [adminUser, ...keepUsers], sessions: [] };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
  return { keptUsers: keepUsers.length };
}

function removeAuthFile() {
  if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
}

module.exports = {
  DATA_DIR,
  CERT_DIR, CERT_FILE, KEY_FILE, CONFIG_FILE, AUTH_FILE,
  CLIENT_ID, CLIENT_NAME,
  ensureCerts, formatCertForBosch, registerClient,
  hashPassword, writeConfig, writeAuth, removeAuthFile,
};

// =========================================================================
//  CLI flow — only runs when invoked directly, never when require()'d.
// =========================================================================
if (require.main === module) {
  const ask = (question, { hidden = false } = {}) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      process.stdin.on('data', () => {});
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
      rl._writeToOutput = function (str) {
        if (str.includes(question)) rl.output.write(str);
        else rl.output.write('*');
      };
    } else {
      rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
    }
  });

  // Prompt for a new password twice (hidden), enforcing the minimum length.
  // Shared by the full setup and the admin-only flow.
  const askNewPassword = async (label = 'Admin password') => {
    while (true) {
      const p1 = await ask(`${label}: `, { hidden: true });
      process.stdout.write('\n');
      if (!p1)            { console.log('  Password may not be empty.'); continue; }
      if (p1.length < 4)  { console.log('  Please use at least 4 characters.'); continue; }
      const p2 = await ask(`Repeat ${label.toLowerCase()}: `, { hidden: true });
      process.stdout.write('\n');
      if (p1 !== p2)      { console.log('  Passwords did not match — try again.'); continue; }
      return p1;
    }
  };

  // --- Full setup: pair with the SHC, optionally enable a login. ---
  async function runFullSetup() {
    console.log('=== Bosch SHC - local UI setup ===\n');

    const shcIp = await ask('IP address of your Bosch SHC (e.g. 192.168.1.50): ');
    if (!shcIp) throw new Error('No IP provided.');

    const { generated } = ensureCerts();
    console.log(generated ? '✔ Certificates generated.' : '✔ Certificates already exist in ./certs');
    const certPem = fs.readFileSync(CERT_FILE, 'utf8');

    console.log('\n⚠  Now press the front button on the SHC until the LED blinks');
    console.log('   (pairing mode). Then continue here.\n');
    await ask('   Ready? Press Enter … ');

    const password = await ask('SHC system password: ', { hidden: true });
    process.stdout.write('\n');

    console.log('⏳ Registering client with the SHC …');
    const result = await registerClient(shcIp, password, certPem);
    console.log(`✔ Registration successful (HTTP ${result.status}).`);

    console.log('\n--- Optional: protect the UI with a login ---');
    const authAnswer = (await ask('Require a user login to access the UI? (y/N): ')).toLowerCase();
    const authEnabled = ['y','yes','j','ja'].includes(authAnswer);

    let adminUsername = null, adminPassword = null;
    if (authEnabled) {
      adminUsername = (await ask('Admin username [admin]: ')) || 'admin';
      adminPassword = await askNewPassword();
    }

    writeConfig({ shcIp, authEnabled });
    console.log('✔ config.json saved.');

    if (authEnabled) {
      const { keptUsers } = writeAuth({ adminUsername, adminPassword });
      console.log(`✔ auth.json saved (admin: ${adminUsername}, kept ${keptUsers} non-admin user(s), all sessions cleared).`);
    } else {
      removeAuthFile();
    }
    console.log('\nDone! Start the UI with:  npm start');
    console.log('   → http://localhost:3000');
  }

  // --- Admin-only: rewrite the admin login without re-pairing the SHC. ---
  // Touches auth.json (+ flips authEnabled on in config.json) only; never
  // generates certs or talks to the controller. Use this to (re)set the admin
  // username/password or to recover access after a forgotten password.
  async function runAuthOnly() {
    console.log('=== Bosch SHC - admin login setup (no SHC re-pairing) ===\n');
    if (!fs.existsSync(CONFIG_FILE)) {
      throw new Error('config.json not found — run `npm run setup` first to pair with the SHC.');
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

    const adminUsername = (await ask('Admin username [admin]: ')) || 'admin';
    const adminPassword = await askNewPassword();

    const { keptUsers } = writeAuth({ adminUsername, adminPassword });
    console.log(`✔ auth.json saved (admin: ${adminUsername}, kept ${keptUsers} non-admin user(s), all sessions cleared).`);

    // Patch the existing config in place (preserving uiPort/shcProtocol/etc.)
    // so the login is actually enforced even if auth was previously off.
    if (!config.authEnabled) {
      config.authEnabled = true;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      console.log('✔ config.json updated (authEnabled: true).');
    }
    console.log('\nDone! Restart the UI if it is running:  npm start');
  }

  const authOnly = process.argv.slice(2).some(a => ['--auth-only', '--admin', 'auth'].includes(a));

  (async () => {
    try {
      if (authOnly) await runAuthOnly();
      else          await runFullSetup();
    } catch (err) {
      console.error('\n✖ Setup failed:', err.message);
      if (!authOnly) {
        console.error('\nTips:');
        console.error('  • Is the SHC in pairing mode (LED blinking)?');
        console.error('  • Correct system password (the one from the app during initial setup)?');
        console.error('  • SHC IP correct and on the same network?');
      }
      process.exit(1);
    }
  })();
}
