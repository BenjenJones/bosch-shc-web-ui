// Vitest global setup: re-build the bundled OpenAPI spec, then start a Prism
// mock server on port 4010 (matches the port server.js will hit via the test
// config). The Prism process stays alive for the whole test run and is
// killed in teardown.
//
// `--errors` flag flips Prism from "be friendly, smooth over violations"
// into "return 422 the moment something doesn't match the spec" — which is
// the entire point: if server.js sends a wrong body, the test fails.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEC      = path.join(__dirname, 'openapi', '_bundled.yml');
const MERGE     = path.join(__dirname, 'scripts', 'merge-openapi.mjs');
// Resolve Prism's actual Node entry (./dist/index.js) and spawn it directly
// with `node`. Bypassing the .cmd/.sh wrapper in node_modules/.bin means we
// don't need `shell: true` — and without a shell wrapper, prismProc.pid IS
// the prism process itself, so plain process.kill() works on every OS.
const require   = createRequire(import.meta.url);
const PRISM_JS  = require.resolve('@stoplight/prism-cli/dist/index.js');

let prismProc;

function waitForPrism(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.request({ host: '127.0.0.1', port, path: '/smarthome/devices', method: 'GET' }, (res) => {
        res.resume();
        if (res.statusCode === 200 || res.statusCode === 404 || res.statusCode === 422) return resolve();
        retry();
      });
      req.on('error', retry);
      req.end();
      function retry() {
        if (Date.now() > deadline) return reject(new Error('Prism did not start within ' + timeoutMs + 'ms'));
        setTimeout(tick, 200);
      }
    };
    tick();
  });
}

export async function setup() {
  // Build bundled spec if missing or stale relative to the merge script.
  const merge = spawnSync(process.execPath, [MERGE], { stdio: 'inherit' });
  if (merge.status !== 0) throw new Error('merge-openapi failed');
  if (!fs.existsSync(SPEC)) throw new Error(`bundled spec not produced at ${SPEC}`);

  prismProc = spawn(process.execPath, [PRISM_JS, 'mock', SPEC, '-p', '4010', '--errors', '-v', 'error'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prismProc.stderr.on('data', (b) => process.stderr.write('[prism] ' + b.toString()));
  prismProc.on('exit', (code) => {
    if (code && code !== null && code !== 143) console.error(`[prism] exited with code ${code}`);
  });

  await waitForPrism(4010);
}

export async function teardown() {
  if (!prismProc || prismProc.killed) return;
  // Spawned with `node prism/dist/index.js` (no shell wrapper) so pid IS
  // the prism process on every OS — plain kill() suffices everywhere.
  prismProc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  try { prismProc.kill('SIGKILL'); } catch {}
}
