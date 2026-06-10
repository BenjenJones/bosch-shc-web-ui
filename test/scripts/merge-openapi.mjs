// Merges all Bosch SHC OpenAPI YAMLs into one bundled spec we can feed to Prism.
//
// The Bosch repo ships 25 separate specs — one for MainResources and one per
// device class. Each shares the same server base URL (`/smarthome`) and many
// share component names (AdvancedError, etc.). We merge by:
//   • taking the union of all paths
//   • taking the union of all components/{schemas,requestBodies,parameters},
//     prefixing component keys with the source file when names collide
//   • rewriting $ref strings inside copied subtrees to point at the (possibly
//     renamed) keys
//
// We then patch the bundled spec with paths server.js relies on that aren't
// in any of the Bosch YAMLs (clients, /services, device PUT/DELETE, etc.)
// so Prism mocks them too instead of returning 404.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SPEC_DIR  = path.resolve(__dirname, '..', 'openapi');
const OUT_FILE  = path.join(SPEC_DIR, '_bundled.yml');

const SECTIONS = ['schemas', 'requestBodies', 'parameters', 'responses'];

function loadSpec(file) {
  const text = fs.readFileSync(path.join(SPEC_DIR, file), 'utf8');
  return yaml.load(text);
}

function rewriteRefs(node, renameMap) {
  if (Array.isArray(node)) {
    node.forEach((n) => rewriteRefs(n, renameMap));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        // expected form: #/components/<section>/<name>
        const m = v.match(/^#\/components\/(\w+)\/(.+)$/);
        if (m) {
          const [, section, name] = m;
          const newName = renameMap[`${section}/${name}`];
          if (newName) node[k] = `#/components/${section}/${newName}`;
        }
      } else {
        rewriteRefs(v, renameMap);
      }
    }
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function merge(bundled, spec, sourceLabel) {
  // Build a rename map for components that collide and differ.
  const renameMap = {};
  const targetComponents = (bundled.components ||= {});
  const srcComponents = spec.components || {};

  for (const section of SECTIONS) {
    const srcSection = srcComponents[section];
    if (!srcSection) continue;
    const tgtSection = (targetComponents[section] ||= {});
    for (const [name, value] of Object.entries(srcSection)) {
      if (tgtSection[name] && !deepEqual(tgtSection[name], value)) {
        const newName = `${name}_${sourceLabel}`;
        renameMap[`${section}/${name}`] = newName;
      }
    }
  }

  // Copy components (with rename if needed), rewriting their internal refs.
  for (const section of SECTIONS) {
    const srcSection = srcComponents[section];
    if (!srcSection) continue;
    const tgtSection = (targetComponents[section] ||= {});
    for (const [name, value] of Object.entries(srcSection)) {
      const targetName = renameMap[`${section}/${name}`] || name;
      if (tgtSection[targetName]) continue;
      const clone = JSON.parse(JSON.stringify(value));
      rewriteRefs(clone, renameMap);
      tgtSection[targetName] = clone;
    }
  }

  // Copy paths (rewriting refs); on duplicate path, merge methods.
  // Prism doesn't strip the spec's server base path from incoming requests,
  // so we prefix every spec path with the source spec's base path. For most
  // specs that's `/smarthome` (port 8444); ShcInfo lives on `/public` (port
  // 8446). Derive from the first servers[] entry so we don't have to special-
  // case files by name.
  let basePath = '';
  try {
    const u = new URL(spec.servers?.[0]?.url || 'http:///');
    basePath = u.pathname.replace(/\/$/, '');
  } catch { /* default to empty */ }
  const tgtPaths = (bundled.paths ||= {});
  for (const [pathKey, pathItem] of Object.entries(spec.paths || {})) {
    const clone = JSON.parse(JSON.stringify(pathItem));
    rewriteRefs(clone, renameMap);
    const prefixed = `${basePath}${pathKey}`;
    if (!tgtPaths[prefixed]) {
      tgtPaths[prefixed] = clone;
    } else {
      for (const [method, op] of Object.entries(clone)) {
        if (!tgtPaths[prefixed][method]) tgtPaths[prefixed][method] = op;
      }
    }
  }
}

const bundled = {
  openapi: '3.0.0',
  info: {
    title: 'Bosch SHC - bundled local API (test mock)',
    version: '3.2',
    description: 'Auto-generated bundle of all Bosch SHC OpenAPI specs for Prism mocking. See test/scripts/merge-openapi.mjs.',
  },
  // Paths in this bundle already include the /smarthome prefix (Prism does not
  // strip the server base path), so the server entry is just for documentation.
  servers: [{ url: 'http://localhost:8444' }],
  paths: {},
  components: {},
};

const files = fs.readdirSync(SPEC_DIR)
  .filter((f) => f.endsWith('.yml') && !f.startsWith('_'))
  .sort();

for (const file of files) {
  const label = file.replace(/-local-openapi-v3\.yml$/, '').replace(/[^A-Za-z0-9]/g, '');
  const spec = loadSpec(file);
  merge(bundled, spec, label);
}

// =========================================================================
//  Patch in endpoints that server.js uses but Bosch never documented.
//  These are routes verified to work against real hardware (Bosch app, Postman
//  collection, community libraries). Marked clearly so it's obvious they
//  weren't auto-imported.
// =========================================================================
const PATCH_PATHS = {
  // server.js calls /smarthome/information (works on real SHC firmware and
  // returns the firmware version + softwareUpdateState the UI needs). The
  // officially documented /public/information is only the pre-pairing
  // discovery endpoint and lacks those fields, so we deliberately mock the
  // working undocumented path here.
  '/information': {
    get: {
      summary: '[patched] /smarthome/information — undocumented but the only source for firmware/update state.',
      responses: {
        '200': {
          description: 'Controller info.',
          content: { 'application/json': { example: {
            '@type': 'shcInformation',
            version: '12.34.5',
            updateState: 'NO_UPDATE_AVAILABLE',
            shcGeneration: 'SHC_2',
            macAddress: 'aa:bb:cc:dd:ee:ff',
          }}},
        },
      },
    },
  },
  // Aggregated services across all devices — used by the Admin tab.
  '/services': {
    get: {
      summary: '[patched] List all services across all devices.',
      responses: {
        '200': {
          description: 'Services list.',
          content: { 'application/json': { example: [] }},
        },
      },
    },
  },
  '/clients': {
    get: {
      summary: '[patched] List paired clients (mobile devices & integrations).',
      responses: {
        '200': {
          description: 'Clients list.',
          content: { 'application/json': { example: [
            { '@type': 'client', id: 'oss_local_ui', name: 'OSS Local UI', primaryRole: 'ROLE_RESTRICTED_CLIENT' },
          ]}},
        },
      },
    },
  },
  '/clients/{clientId}': {
    delete: {
      summary: '[patched] Remove a paired client.',
      parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '204': { description: 'Removed.' } },
    },
  },
  // server.js renames devices via PUT /devices/{id} with body { name }.
  '/devices/{deviceId}': {
    put: {
      summary: '[patched] Rename / update a device.',
      parameters: [{ name: 'deviceId', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          properties: { name: { type: 'string' }, iconId: { type: 'string' }, roomId: { type: 'string' } },
        }}},
      },
      responses: { '200': { description: 'OK', content: { 'application/json': { example: { ok: true } }}}, '204': { description: 'OK' } },
    },
    delete: {
      summary: '[patched] Remove a device.',
      parameters: [{ name: 'deviceId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '204': { description: 'Deleted.' } },
    },
  },
  // Rooms: create (POST /rooms) and delete (DELETE /rooms/{id}) are undocumented
  // but accepted by real firmware — see project notes. Rename PUT below.
  '/rooms': {
    post: {
      summary: '[patched] Create a room.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          properties: { '@type': { type: 'string' }, name: { type: 'string' }, iconId: { type: 'string' } },
        }}},
      },
      responses: { '200': { description: 'Created.', content: { 'application/json': { example: { ok: true } }}}, '201': { description: 'Created.' }, '204': { description: 'Created.' } },
    },
  },
  '/rooms/{roomId}': {
    put: {
      summary: '[patched] Rename / update a room.',
      parameters: [{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          properties: { name: { type: 'string' }, iconId: { type: 'string' } },
        }}},
      },
      responses: { '200': { description: 'OK', content: { 'application/json': { example: { ok: true } }}}, '204': { description: 'OK' } },
    },
    delete: {
      summary: '[patched] Delete a room.',
      parameters: [{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '204': { description: 'Deleted.' }, '200': { description: 'Deleted.' } },
    },
  },
  '/messages/{messageId}': {
    delete: {
      summary: '[patched] Dismiss a message.',
      parameters: [{ name: 'messageId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '204': { description: 'Dismissed.' } },
    },
  },
  // Automations: create (POST) and delete (DELETE) — undocumented, accepted by
  // firmware. The body for create is a full automationRule (kept loose here).
  '/automation/rules': {
    post: {
      summary: '[patched] Create an automation rule.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { '200': { description: 'Created.', content: { 'application/json': { example: { ok: true } }}}, '201': { description: 'Created.' }, '204': { description: 'Created.' } },
    },
  },
  '/automation/rules/{automationId}': {
    put: {
      summary: '[patched] Update an automation rule (enable/disable).',
      parameters: [{ name: 'automationId', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          properties: { enabled: { type: 'boolean' }, name: { type: 'string' } },
        }}},
      },
      responses: { '200': { description: 'OK', content: { 'application/json': { example: { ok: true } }}}, '204': { description: 'OK' } },
    },
    delete: {
      summary: '[patched] Delete an automation rule.',
      parameters: [{ name: 'automationId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '204': { description: 'Deleted.' }, '200': { description: 'Deleted.' } },
    },
  },
  // Scenarios: create (POST), update (PUT), delete (DELETE) — undocumented.
  '/scenarios': {
    post: {
      summary: '[patched] Create a scenario.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { '200': { description: 'Created.', content: { 'application/json': { example: { ok: true } }}}, '201': { description: 'Created.' }, '204': { description: 'Created.' } },
    },
  },
  '/scenarios/{scenarioId}': {
    put: {
      summary: '[patched] Update a scenario.',
      parameters: [{ name: 'scenarioId', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { '200': { description: 'OK', content: { 'application/json': { example: { ok: true } }}}, '204': { description: 'OK' } },
    },
    delete: {
      summary: '[patched] Delete a scenario.',
      parameters: [{ name: 'scenarioId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '204': { description: 'Deleted.' }, '200': { description: 'Deleted.' } },
    },
  },
  // User-defined states: create (POST) and delete (DELETE) — undocumented.
  '/userdefinedstates': {
    post: {
      summary: '[patched] Create a user-defined state.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          properties: { '@type': { type: 'string' }, name: { type: 'string' }, state: { type: 'boolean' } },
        }}},
      },
      responses: { '200': { description: 'Created.', content: { 'application/json': { example: { ok: true } }}}, '201': { description: 'Created.' }, '204': { description: 'Created.' } },
    },
  },
  '/userdefinedstates/{userDefinedStateId}': {
    delete: {
      summary: '[patched] Delete a user-defined state.',
      parameters: [{ name: 'userDefinedStateId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '204': { description: 'Deleted.' }, '200': { description: 'Deleted.' } },
    },
  },
  // server.js POSTs to /automation/rules/{id}/triggers (the trigger-sub-path
  // probe tries several candidates; the documented `/trigger` is a PUT only).
  '/automation/rules/{automationId}/triggers': {
    post: {
      summary: '[patched] Manually trigger an automation rule (probed sub-path).',
      parameters: [{ name: 'automationId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '202': { description: 'Triggered.' }, '204': { description: 'Triggered.' } },
    },
  },
  // Long polling / JSON-RPC. Body shape is JSON-RPC 2.0; we keep the schema
  // loose because Bosch never specified it formally.
  '/remote/json-rpc': {
    post: {
      summary: '[patched] Long-polling JSON-RPC endpoint (RE/subscribe, RE/longPoll, RE/unsubscribe).',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          required: ['jsonrpc', 'method'],
          properties: {
            jsonrpc: { type: 'string', enum: ['2.0'] },
            method:  { type: 'string' },
            params:  {},
            id:      {},
          },
        }}},
      },
      responses: { '200': { description: 'OK', content: { 'application/json': { example: {
        jsonrpc: '2.0', result: [], id: null,
      }}}}},
    },
  },
};

// =========================================================================
//  Bosch spec bugfixes — places where the YAMLs disagree with what the real
//  SHC firmware actually accepts. Each entry has the upstream symptom in a
//  comment so a future reader can re-verify.
// =========================================================================
const params = (bundled.components.parameters ||= {});
// MainResources references `automationIdPathParam` but never declares it.
params.automationIdPathParam ||= {
  name: 'automationId', in: 'path', required: true,
  description: 'Identifier of the automation rule.',
  schema: { type: 'string' },
};

// `SetpointTemperatureState` is typed `string` with an enum containing the
// literal placeholder `"..."`. Real firmware accepts numeric setpoints
// (e.g. 21.5) — every Bosch client and the boschshcpy library send numbers.
// Loosen the schema so legitimate numeric payloads aren't flagged as wrong.
const schemas = (bundled.components.schemas ||= {});
if (schemas.SetpointTemperatureState) {
  schemas.SetpointTemperatureState = {
    type: 'number',
    minimum: 5,
    maximum: 30,
    description: 'Target temperature in °C (patched: spec lists enum-of-strings incl. "..." placeholder; real SHC takes a number).',
  };
}

// MainResources' PUT /userdefinedstates/{id}/state has no requestBody (so
// Prism returns 415), and its declared 200 response uses `text/plain: string`
// with `example: true` — YAML parses that as a boolean and Prism then 500s
// because the generated response doesn't match its own schema. Replace the
// whole operation with one that mirrors real-firmware behaviour: takes a
// JSON boolean, returns 204.
const udsPath = bundled.paths['/smarthome/userdefinedstates/{userDefinedStateId}/state'];
if (udsPath?.put) {
  udsPath.put = {
    summary: '[patched] Set a user-defined state to a boolean value.',
    parameters: udsPath.put.parameters || [],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'boolean' } } },
    },
    responses: { '204': { description: 'State updated.' } },
  };
}

for (const [p, item] of Object.entries(PATCH_PATHS)) {
  const prefixed = `/smarthome${p}`;
  if (!bundled.paths[prefixed]) {
    bundled.paths[prefixed] = item;
  } else {
    for (const [method, op] of Object.entries(item)) {
      bundled.paths[prefixed][method] ||= op;
    }
  }
}

fs.writeFileSync(OUT_FILE, yaml.dump(bundled, { lineWidth: 200 }));
console.log(`✔ Wrote ${OUT_FILE}`);
console.log(`  paths: ${Object.keys(bundled.paths).length}`);
console.log(`  schemas: ${Object.keys(bundled.components.schemas || {}).length}`);
