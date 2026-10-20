/**
 * Synthetischer Verlauf für den Demo-Modus.
 *
 * Erzeugt für jede Messgröße des Demo-Datensatzes (Temperatur, Feuchte,
 * Sollwert, Leistung/Energiezähler, Kontakte, Ventil, Luftqualität, Rollläden,
 * Helligkeit) plausible Werte über ein Jahr: die letzten 14 Tage im
 * 15-Minuten-Raster (wie der echte Sampler), davor stündlich. Tages- und
 * Jahresgang + etwas Rauschen; alles deterministisch (fester Seed), damit
 * Screenshots reproduzierbar sind. Die Kurven enden auf den aktuellen
 * Demo-Werten, der Energiezähler auf dem aktuellen Zählerstand.
 */

const { extractMetrics, HOUR, DAY } = require('../history.js');

// Kleiner deterministischer PRNG (mulberry32).
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

const localHour = (ts) => { const d = new Date(ts); return d.getHours() + d.getMinutes() / 60; };
const daySine = (ts, peakHour) => Math.cos(((localHour(ts) - peakHour) / 24) * 2 * Math.PI);
// -1 im Winter (Januar) … +1 im Sommer (Juli)
const season = (ts) => -Math.cos(((new Date(ts).getMonth() + new Date(ts).getDate() / 31) / 12) * 2 * Math.PI);

// Generator je Metrik: (ts, rand, current) -> Wert
const MODELS = {
  temperature: (ts, r, cur) => cur + 0.8 * daySine(ts, 17) + 1.2 * season(ts) + (r() - 0.5) * 0.3,
  externalTemperature: (ts, r, cur) => cur + 0.5 * daySine(ts, 19) + 1.5 * season(ts) + (r() - 0.5) * 0.2,
  humidity:    (ts, r, cur) => cur + 6 * daySine(ts, 6) + 5 * season(ts) + (r() - 0.5) * 3,
  setpoint:    (ts, _r, cur) => { const h = localHour(ts); return h >= 6 && h < 22 ? cur : cur - 3; },
  valve:       (ts, r) => Math.max(0, Math.round((40 - 35 * season(ts)) * (0.5 - 0.5 * daySine(ts, 15)) + (r() - 0.5) * 10)),
  purity:      (ts, r) => Math.round(650 + 300 * daySine(ts, 4) + r() * 120),
  shutter:     (ts) => { const h = localHour(ts); return h >= 7 && h < 21 ? 100 : 0; },
  illuminance: (ts, r) => Math.max(0, Math.round(400 * Math.max(0, daySine(ts, 13)) * (1.3 + 0.7 * season(ts)) + r() * 20)),
  contact:     (ts, r) => { const h = localHour(ts); return h >= 7 && h < 22 && r() < 0.08 ? 1 : 0; },
  // Leistung: meist Standby, abends gelegentlich ein Verbraucher mit 60–2000 W.
  power:       (ts, r) => { const h = localHour(ts); return (h >= 17 && h < 23 && r() < 0.35) ? Math.round(60 + r() * 1900) : Math.round(r() * 3); },
};

function seedDemoHistory(history, services, now = Date.now()) {
  if (!history.available) return 0;
  const current = new Map(services.flatMap(extractMetrics).map(p => [p.series, p.value]));
  const series = [...current.keys()];

  // Zeitraster: 1 Jahr stündlich, die letzten 14 Tage alle 15 Minuten.
  const end = Math.floor(now / (15 * 60e3)) * 15 * 60e3;
  const fineFrom = end - 14 * DAY;
  const times = [];
  for (let ts = Math.floor((end - 365 * DAY) / HOUR) * HOUR; ts < fineFrom; ts += HOUR) times.push(ts);
  for (let ts = fineFrom; ts <= end; ts += 15 * 60e3) times.push(ts);

  // Pro Serie Werte erzeugen; Energie = Integral der Leistung derselben
  // Steckdose, rückwärts so verankert, dass der Zähler heute stimmt.
  const values = new Map();
  for (const s of series) {
    const metric = s.split('|')[1];
    const model = MODELS[metric];
    if (!model) continue;
    const r = rng(hash(s));
    const cur = current.get(s);
    values.set(s, times.map(ts => model(ts, r, cur)));
  }
  for (const s of series) {
    const [dev, metric] = s.split('|');
    if (metric !== 'energy') continue;
    const power = values.get(`${dev}|power`);
    if (!power) continue;
    const wh = [];
    let acc = 0;
    for (let i = 0; i < times.length; i++) {
      const dtH = i ? (times[i] - times[i - 1]) / HOUR : 0;
      acc += power[i] * dtH;
      wh.push(acc);
    }
    const offset = Math.max(0, current.get(s) - acc);
    values.set(s, wh.map(v => Math.round(offset + v)));
  }

  // Eine Transaktion für alles — sonst kostet jeder Zeitpunkt einen Commit.
  let n = 0;
  history.batch(() => {
    for (let i = 0; i < times.length; i++) {
      const points = [];
      for (const [s, vals] of values) {
        const v = vals[i];
        if (Number.isFinite(v)) points.push({ series: s, value: Math.round(v * 10) / 10 });
      }
      history.record(points, times[i]);
      n += points.length;
    }
  });
  history.prune(now);
  return n;
}

module.exports = { seedDemoHistory };
