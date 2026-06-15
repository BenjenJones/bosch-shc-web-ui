/**
 * Demo-Datensatz-Generator.
 *
 *   node demo/build-dataset.js
 *
 * Liest die *lokalen, echten* Exporte unter examples/ (gitignored, da aus einem
 * realen SHC) und erzeugt einen kompakten, anonymisierten Datensatz unter
 * demo/dataset/, der eingecheckt werden kann. Ziel: mindestens ein Beispiel je
 * Typ — ein Gerät pro deviceModel, Automationen die jeden Trigger-/Bedingungs-/
 * Aktionstyp mindestens einmal abdecken, Szenarien je Aktionstyp.
 *
 * Anonymisierung (siehe Entscheidungen):
 *  - IDs/Serials/State-UUIDs  -> deterministische Platzhalter, Cross-Refs
 *    (Automation -> Gerät/State) bleiben konsistent.
 *  - Gerätenamen              -> generisch ("Licht 1", "Türkontakt 1"); System-
 *    /Virtualgeräte (-RoomClimateControl-, RoomLightControl, …) behalten ihren
 *    technischen Namen.
 *  - Freitext in Push-Aktionen -> generisch.
 *  - Zeitstempel/Energiewerte  -> bleiben unverändert (bewusst).
 *
 * Service-Zustände stammen aus dem realen examples/services.json (je Service-ID
 * als Vorlage, geklont + anonymisiert). Für Service-IDs ohne reale Vorlage gibt
 * es einen kleinen Generator-Fallback; alle übrigen Services bleiben ohne state
 * — genau wie bei der echten Box (z. B. BatteryLevel).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EX = path.join(__dirname, '..', 'examples');
const OUT = path.join(__dirname, 'dataset');
const has = (f) => fs.existsSync(path.join(EX, f));
const rd = (f) => JSON.parse(fs.readFileSync(path.join(EX, f), 'utf8'));
const first = (...names) => names.find(has);

// Quellen — bevorzugt die reichhaltigen 02_*-Exporte (mehr Modelle/Typen),
// sonst die einfachen Namen. Service-States nur aus services.json.
const devicesSrc     = first('02_devices.json', 'devices.json');
const automationsSrc = first('02_automations.json', 'automations.json');
const scenarioFiles  = ['02_scenarios.json', 'scenarios.json', 'testscenarios.json'].filter(has);

if (!devicesSrc) { console.error('✖ keine examples/<devices>.json gefunden'); process.exit(1); }

const devicesRaw     = rd(devicesSrc);
const automationsRaw = automationsSrc ? rd(automationsSrc) : [];
const realServices   = has('services.json') ? rd('services.json') : [];

// =========================================================================
//  Anonymisierung — globale, deterministische ID-Abbildung
// =========================================================================
const hex = (seed, n) => crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, n);
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isDeviceId = (v) => typeof v === 'string' && v.startsWith('hdm:');
// Virtuelle/System-IDs sind nicht sensibel und werden von der UI als Schlüssel
// gebraucht — unverändert lassen.
const isSystemId = (id) => /^(roomClimateControl_|roomLightControl_|boilerControl_)/.test(id)
  || ['intrusionDetectionSystem', 'smokeDetectionSystem', 'presenceSimulationService', 'ventilationService'].includes(id);

const idMap = new Map();
function anonId(realId) {
  if (typeof realId !== 'string') return realId;
  if (isSystemId(realId)) return realId;
  if (idMap.has(realId)) return idMap.get(realId);
  // Kind-Kanäle (…#2/#3): an die Eltern-Abbildung hängen.
  if (realId.includes('#')) {
    const [base, child] = realId.split('#');
    const out = anonId(base) + '#' + child;
    idMap.set(realId, out);
    return out;
  }
  let out;
  if (realId.startsWith('hdm:ZigBee:')) out = 'hdm:ZigBee:' + hex(realId, 16);
  else if (realId.startsWith('hdm:HomeMaticIP:')) out = 'hdm:HomeMaticIP:3014F711A' + hex(realId, 15).toUpperCase();
  else if (realId.startsWith('hdm:PhilipsHueBridge:HueLight_')) out = 'hdm:PhilipsHueBridge:HueLight_' + hex(realId, 16) + '-0b_' + hex(realId + 'b', 12);
  else if (realId.startsWith('hdm:PhilipsHueBridge:HueBridge_')) out = 'hdm:PhilipsHueBridge:HueBridge_' + hex(realId, 12);
  else if (realId.startsWith('hdm:homeconnect:')) out = 'hdm:homeconnect:DEMO-' + hex(realId, 12).toUpperCase();
  else if (isUuid(realId)) out = anonUuid(realId);
  else out = realId; // unbekanntes Muster (z. B. PhilipsHueBridgeManager) – belassen
  idMap.set(realId, out);
  return out;
}
function anonUuid(real) {
  if (idMap.has(real)) return idMap.get(real);
  const h = hex('uuid' + real, 32);
  const u = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  idMap.set(real, u);
  return u;
}
const anonSerial = (s) => (typeof s === 'string' ? hex('serial' + s, 16).toUpperCase() : s);

// Deep-Walk: ersetzt in beliebigen Objekten/Strings ID-/UUID-artige Werte.
function anonDeep(val) {
  if (Array.isArray(val)) return val.map(anonDeep);
  if (val && typeof val === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(val)) o[k] = anonDeep(v);
    return o;
  }
  if (isDeviceId(val) || isSystemId(val)) return anonId(val);
  if (isUuid(val)) return anonUuid(val);
  return val;
}

// =========================================================================
//  Geräte — eins pro deviceModel, anonymisiert + generische Namen
// =========================================================================
const NAME_LABEL = {
  HUE_LIGHT: 'Licht', MICROMODULE_LIGHT_ATTACHED: 'Licht', MICROMODULE_LIGHT_CONTROL: 'Lichtsteuerung',
  PLUG_COMPACT: 'Steckdose', PLUG_COMPACT_DUAL: 'Doppelsteckdose',
  SWD: 'Fensterkontakt', SWD2: 'Türkontakt', SWD2_PLUS: 'Türkontakt', SWD2_DUAL: 'Türkontakt',
  TRV: 'Heizkörperthermostat', RTH2_BAT: 'Raumthermostat',
  SD: 'Rauchmelder', MD2: 'Bewegungsmelder', WLS: 'Wassermelder', TWINGUARD: 'Twinguard',
  WRC2: 'Universalschalter', MULTISWITCH: 'Twist', BBL: 'Rollladen', MICROMODULE_RELAY: 'Relais',
  HUE_BRIDGE: 'Hue Bridge', HOMECONNECT_WASHER: 'Waschmaschine', BOILER: 'Heizung',
};
const nameCounters = {};
const isSystemName = (n) => /^-.*-$/.test(n || '') || n === 'RoomLightControl' || n === 'PhilipsHueBridgeManager';
function genericName(d) {
  if (isSystemName(d.name)) return d.name;
  const label = NAME_LABEL[d.deviceModel] || d.deviceModel;
  nameCounters[label] = (nameCounters[label] || 0) + 1;
  return `${label} ${nameCounters[label]}`;
}

// Dedupe auf ein Gerät je Modell (erstes Vorkommen gewinnt).
const seenModel = new Set();
const keptRaw = devicesRaw.filter(d => {
  if (seenModel.has(d.deviceModel)) return false;
  seenModel.add(d.deviceModel);
  return true;
});
const keptRealIds = new Set(keptRaw.map(d => d.id));

// Geräte-Referenz (echte ID) auf ein im Demo-Set vorhandenes Gerät auflösen:
// behaltene IDs direkt, sonst der eine behaltene Vertreter desselben
// deviceModel. Nötig, weil das Dedupe auf 1-pro-Modell die meisten Geräte
// entfernt — Automationen/Szenarien würden sonst auf nicht vorhandene IDs
// zeigen, und der Editor zeigt dann die rohe ID statt eines Namens.
const realIdToModel = new Map(devicesRaw.map(d => [d.id, d.deviceModel]));
const modelToKeptAnonId = new Map();
for (const d of keptRaw) modelToKeptAnonId.set(d.deviceModel, anonId(d.id));
function resolveDeviceRef(realId) {
  if (keptRealIds.has(realId)) return anonId(realId);
  const model = realIdToModel.get(realId);
  if (model && modelToKeptAnonId.has(model)) return modelToKeptAnonId.get(model);
  return anonId(realId); // unbekannt — anonymisiert belassen
}

const devices = keptRaw.map(d => {
  const out = { ...d };
  out.id = anonId(d.id);
  if (d.serial) out.serial = d.serial.startsWith('hdm:') || isSystemId(d.serial) ? anonId(d.serial) : anonSerial(d.serial);
  if (d.parentDeviceId) out.parentDeviceId = anonId(d.parentDeviceId);
  // Kind-Referenzen auf die behaltenen Geräte beschränken + remappen.
  out.childDeviceIds = (d.childDeviceIds || []).filter(c => keptRealIds.has(c)).map(anonId);
  if (d.profileConfiguration) out.profileConfiguration = anonDeep(d.profileConfiguration);
  out.name = genericName(d);
  return out;
});

// =========================================================================
//  Service-States — reale Vorlagen je Service-ID + kleine Fallback-Generatoren
// =========================================================================
const r1 = (n) => Math.round(n * 10) / 10;
const h01 = (s) => (parseInt(hex(s, 8), 16) % 10000) / 10000;
const stateLib = new Map(); // serviceId -> [state, …]
for (const s of realServices) {
  if (!s.state) continue;
  if (!stateLib.has(s.id)) stateLib.set(s.id, []);
  stateLib.get(s.id).push(s.state);
}
const GEN = {
  ShutterControl: (d) => ({ '@type': 'shutterControlState', level: Math.round(h01(d.id + 'sl') * 100) / 100, operationState: 'STOPPED' }),
  BinarySwitch: (d) => ({ '@type': 'binarySwitchState', on: h01(d.id + 'bs') > 0.5 }),
  MultiLevelSwitch: (d) => ({ '@type': 'multiLevelSwitchState', level: Math.round(h01(d.id + 'ml') * 100) }),
  // rgb is a signed 32-bit ARGB int (full alpha); pick a warm-ish demo colour.
  HSBColorActuator: (d) => ({ '@type': 'colorState', rgb: (0xff << 24) | (255 << 16) | (Math.round(120 + h01(d.id + 'co') * 100) << 8) | 40 }),
  ImpulseSwitch: () => ({ '@type': 'impulseSwitchState', impulseState: false, instantOfLastImpulse: '', impulseLength: 6 }),
  AirQualityLevel: (d) => ({
    '@type': 'airQualityLevelState', combinedRating: 'GOOD',
    temperature: r1(20 + h01(d.id + 'aq') * 3), temperatureRating: 'GOOD',
    humidity: Math.round(40 + h01(d.id + 'aqh') * 20), humidityRating: 'GOOD',
    purity: 300 + Math.round(h01(d.id + 'pu') * 400), purityRating: 'GOOD',
  }),
};
const services = [];
for (const d of devices) {
  for (const sid of d.deviceServiceIds || []) {
    const svc = { '@type': 'DeviceServiceData', id: sid, deviceId: d.id, path: `/devices/${d.id}/services/${sid}` };
    const pool = stateLib.get(sid);
    if (pool && pool.length) {
      // deterministische Auswahl + Anonymisierung etwaiger IDs/UUIDs im State
      svc.state = anonDeep(pool[Math.floor(h01(d.id + sid) * pool.length)]);
    } else if (GEN[sid]) {
      svc.state = GEN[sid](d);
    }
    services.push(svc);
  }
}

// =========================================================================
//  Automationen — minimale Abdeckung aller Trigger-/Bedingungs-/Aktionstypen
// =========================================================================
const seen = { t: new Set(), c: new Set(), a: new Set() };
const pickedAuto = [];
for (const r of automationsRaw) {
  const fresh = (arr, set) => (arr || []).some(x => !set.has(x.type));
  if (fresh(r.automationTriggers, seen.t) || fresh(r.automationConditions, seen.c) || fresh(r.automationActions, seen.a)) {
    pickedAuto.push(r);
    (r.automationTriggers   || []).forEach(x => seen.t.add(x.type));
    (r.automationConditions || []).forEach(x => seen.c.add(x.type));
    (r.automationActions    || []).forEach(x => seen.a.add(x.type));
  }
}
const anonConfig = (str) => {
  let o; try { o = JSON.parse(str); } catch { return str; }
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (k === 'message' && typeof v === 'string') o[k] = 'Demo-Benachrichtigung';
    else if (isDeviceId(v) || isSystemId(v)) o[k] = resolveDeviceRef(v);
    else if (isUuid(v)) o[k] = anonUuid(v);
  }
  return JSON.stringify(o);
};
const anonEntries = (list) => (list || []).map(e => ({ ...e, configuration: anonConfig(e.configuration) }));
const automations = pickedAuto.map(r => ({
  '@type': r['@type'], id: anonUuid(r.id), name: r.name, enabled: r.enabled,
  automationTriggers: anonEntries(r.automationTriggers),
  automationConditions: anonEntries(r.automationConditions),
  automationActions: anonEntries(r.automationActions),
  conditionLogicalOp: r.conditionLogicalOp,
}));

// =========================================================================
//  Szenarien — je Aktions-Service-ID mindestens eins
// =========================================================================
// Szenario-Aktion auf ein Demo-Gerät auflösen, das den benötigten Service
// wirklich anbietet (testscenarios referenzieren IDs außerhalb des
// Geräte-Exports — die ließen sich sonst nicht auf ein vorhandenes Gerät
// abbilden). Fallback: Modell-basierte Auflösung.
const serviceIdToKept = new Map();
for (const d of keptRaw) for (const sid of d.deviceServiceIds || []) {
  if (!serviceIdToKept.has(sid)) serviceIdToKept.set(sid, anonId(d.id));
}
const resolveScenarioRef = (a) => serviceIdToKept.get(a.deviceServiceId) || resolveDeviceRef(a.deviceId);

const seenScAct = new Set();
const scenarios = [];
for (const f of scenarioFiles) {
  for (const sc of rd(f)) {
    const fresh = (sc.actions || []).some(a => !seenScAct.has(a.deviceServiceId));
    if (!fresh) continue;
    (sc.actions || []).forEach(a => seenScAct.add(a.deviceServiceId));
    scenarios.push({
      '@type': 'scenario', id: anonUuid(sc.id), name: sc.name, iconId: sc.iconId,
      actions: (sc.actions || []).map(a => ({ ...a, deviceId: resolveScenarioRef(a), targetState: anonDeep(a.targetState) })),
    });
  }
}

// =========================================================================
//  User-defined states — aus den (anonymisierten) State-Referenzen der
//  ausgewählten Automationen ableiten, generische Namen.
// =========================================================================
const stateIds = new Set();
for (const r of automations) {
  for (const e of [...r.automationTriggers, ...r.automationConditions, ...r.automationActions]) {
    let o; try { o = JSON.parse(e.configuration); } catch { continue; }
    if (o.stateId) stateIds.add(o.stateId);
  }
}
const userdefinedstates = [...stateIds].map((id, i) => ({
  '@type': 'userDefinedState', id, name: `Status ${i + 1}`, state: i % 3 === 0,
}));

// =========================================================================
//  Räume — aus den roomIds der behaltenen Geräte, mit Namens-Mapping.
// =========================================================================
const ROOM_NAMES = {
  hz_1: ['icon_room_kitchen', 'Küche'], hz_2: ['icon_room_bedroom', 'Schlafzimmer'],
  hz_3: ['icon_room_bathroom', 'Badezimmer'], hz_4: ['icon_room_living_room', 'Wohnzimmer'],
  hz_5: ['icon_room_hallway', 'Flur'], hz_6: ['icon_room_storage', 'Abstellkammer'],
  hz_7: ['icon_room_terrace', 'Terrasse'], hz_8: ['icon_room_office', 'Arbeitszimmer'],
};
const roomIds = [...new Set(devices.map(d => d.roomId).filter(Boolean))].sort();
const rooms = roomIds.map(id => {
  const [iconId, name] = ROOM_NAMES[id] || ['icon_room_misc', id];
  return { '@type': 'room', id, iconId, name };
});

// =========================================================================
//  Systemmeldungen — aktive + (zum Archivieren vorgesehene) Beispiele, die auf
//  vorhandene Demo-Geräte zeigen. Ohne timestamp/archivedAt — die stempelt
//  demo-data.js beim Laden, damit die Daten immer "frisch" wirken. Nur
//  messageCodes, für die die UI Titel kennt (i18n msg.*).
// =========================================================================
const roomNameOf = (d) => (rooms.find(r => r.id === d.roomId) || {}).name || d.roomId || '';
const hasService = (d, sid) => (d.deviceServiceIds || []).includes(sid);
const pickDev = (pred) => devices.find(pred);
const mkMsg = (code, category, dev, { flags = [], args = {} } = {}) => ({
  '@type': 'message', id: anonUuid('msg-' + code + '-' + (dev ? dev.id : 'shc')),
  messageCode: { '@type': 'messageCode', name: code, category },
  sourceType: 'DEVICE', sourceId: dev ? dev.id : null, sourceName: dev ? dev.name : null,
  location: dev ? roomNameOf(dev) : null, flags, arguments: args,
});

const batteryDev   = pickDev(d => hasService(d, 'BatteryLevel') && d.deviceModel === 'TRV') || pickDev(d => hasService(d, 'BatteryLevel'));
const updateDev    = pickDev(d => d.deviceModel === 'PLUG_COMPACT') || devices[0];
const unreachDev   = pickDev(d => d.status === 'COMMUNICATION_ERROR') || pickDev(d => d.deviceModel === 'HUE_LIGHT');
const contactDev   = pickDev(d => hasService(d, 'ShutterContact'));
const smokeDev     = pickDev(d => d.deviceModel === 'SD' || d.deviceModel === 'TWINGUARD');
const critBattDev  = pickDev(d => hasService(d, 'BatteryLevel') && d.deviceModel === 'SD') || batteryDev;

const messages = [
  mkMsg('LOW_BATTERY', 'WARNING', batteryDev, { flags: ['USER_ACTION_REQUIRED'], args: { deviceModel: batteryDev?.deviceModel } }),
  mkMsg('SOFTWARE_UPDATE_AVAILABLE', 'NOTICE', updateDev, { args: { swInstalledVersion: '10.20.1965', swUpdateAvailableVersion: '10.21.2200' } }),
  mkMsg('DEVICE_UNREACHABLE', 'WARNING', unreachDev, { flags: ['USER_ACTION_REQUIRED'] }),
].filter(m => m.sourceId);

const messagesArchive = [
  mkMsg('CRITICAL_LOW_BATTERY', 'WARNING', critBattDev, { args: { deviceModel: critBattDev?.deviceModel } }),
  mkMsg('TILT_DETECTION', 'WARNING', contactDev),
  mkMsg('CHECK_INSTALLATION', 'NOTICE', smokeDev),
].filter(m => m.sourceId);

// =========================================================================
//  Schreiben
// =========================================================================
fs.mkdirSync(OUT, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + '\n');
write('rooms.json', rooms);
write('devices.json', devices);
write('services.json', services);
write('scenarios.json', scenarios);
write('automations.json', automations);
write('userdefinedstates.json', userdefinedstates);
write('messages.json', messages);
write('messages-archive.json', messagesArchive);

console.log('✔ demo/dataset geschrieben:');
console.log(`  rooms ${rooms.length}  devices ${devices.length} (1 je Modell)  services ${services.length} (${services.filter(s => s.state).length} mit state)`);
console.log(`  scenarios ${scenarios.length}  automations ${automations.length} (Trigger ${seen.t.size}/Bedingungen ${seen.c.size}/Aktionen ${seen.a.size})  states ${userdefinedstates.length}`);
console.log(`  messages ${messages.length} aktiv / ${messagesArchive.length} archiviert`);
