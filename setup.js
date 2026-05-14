#!/usr/bin/env node
/**
 * One-time setup for the Bosch SHC:
 *  1. Generates a self-signed 2048-bit client certificate (via openssl).
 *  2. Registers the client with the SHC (port 8443) — this requires the SHC
 *     to be in pairing mode (press the front button until the LED blinks).
 *  3. Writes config.json with IP, paths, and client id.
 *
 * Usage:  node setup.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const readline = require('readline');
const { execSync } = require('child_process');

const CERT_DIR = path.join(__dirname, 'certs');
const CERT_FILE = path.join(CERT_DIR, 'client-cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'client-key.pem');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const AUTH_FILE = path.join(__dirname, 'auth.json');

// Per Bosch terms: client id must start with "oss_"
const CLIENT_ID = 'oss_bosch_shc_web_ui';
const CLIENT_NAME = 'oss_bosch_shc_web_ui';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // simple masking of password input
      const stdin = process.openStdin();
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
}

function ensureCerts() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    console.log('✔ Certificates already exist in ./certs');
    return;
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });
  console.log('⏳ Generating self-signed 2048-bit certificate …');
  execSync(
    `openssl req -x509 -nodes -days 9999 -newkey rsa:2048 ` +
    `-keyout "${KEY_FILE}" -out "${CERT_FILE}" ` +
    `-subj "/CN=${CLIENT_ID}"`,
    { stdio: 'inherit' }
  );
  console.log('✔ Certificates generated.');
}

function formatCertForBosch(pem) {
  // Bosch expects the cert string with \r before and after the BEGIN/END lines
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
    rejectUnauthorized: false, // self-signed Bosch cert; see README for CA pinning
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
          reject(new Error(`SHC responded with ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  try {
    console.log('=== Bosch SHC – local UI setup ===\n');

    const shcIp = await ask('IP address of your Bosch SHC (e.g. 192.168.1.50): ');
    if (!shcIp) throw new Error('No IP provided.');

    ensureCerts();
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
    const authEnabled = authAnswer === 'y' || authAnswer === 'yes' || authAnswer === 'j' || authAnswer === 'ja';

    let adminUser = null;
    if (authEnabled) {
      const adminName = (await ask('Admin username [admin]: ')) || 'admin';
      let adminPass = '';
      while (!adminPass) {
        const p1 = await ask('Admin password: ', { hidden: true });
        process.stdout.write('\n');
        if (!p1) { console.log('  Password may not be empty.'); continue; }
        if (p1.length < 4) { console.log('  Please use at least 4 characters.'); continue; }
        const p2 = await ask('Repeat admin password: ', { hidden: true });
        process.stdout.write('\n');
        if (p1 !== p2) { console.log('  Passwords did not match — try again.'); continue; }
        adminPass = p1;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto.scryptSync(adminPass, salt, 64).toString('hex');
      adminUser = {
        username: adminName,
        salt,
        passwordHash,
        role: 'admin',
        mustChangePassword: false,
        createdAt: Date.now(),
      };
    }

    const config = {
      shcIp,
      certPath: path.relative(__dirname, CERT_FILE),
      keyPath: path.relative(__dirname, KEY_FILE),
      clientId: CLIENT_ID,
      uiPort: 3000,
      authEnabled,
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`✔ config.json saved.`);

    if (authEnabled) {
      // Re-running setup with auth enabled: keep existing regular users (the
      // admin is rewritten from this run), but drop ALL sessions — re-running
      // setup is the documented "recover admin access" path, and stale
      // sessions must not be allowed to outlive a password rotation.
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
      console.log(`✔ auth.json saved (admin: ${adminUser.username}, kept ${keepUsers.length} non-admin user(s), all sessions cleared).`);
    } else if (fs.existsSync(AUTH_FILE)) {
      // Auth was disabled — drop the old auth.json so stale users/sessions
      // don't accidentally come back if it gets re-enabled later.
      fs.unlinkSync(AUTH_FILE);
      console.log('✔ Existing auth.json removed (auth disabled).');
    }
    console.log('\nDone! Start the UI with:  npm start');
    console.log('   → http://localhost:3000');
  } catch (err) {
    console.error('\n✖ Setup failed:', err.message);
    console.error('\nTips:');
    console.error('  • Is the SHC in pairing mode (LED blinking)?');
    console.error('  • Correct system password (the one from the app during initial setup)?');
    console.error('  • SHC IP correct and on the same network?');
    process.exit(1);
  }
})();
