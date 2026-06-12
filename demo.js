/**
 * Demo-Modus-Starter.
 *
 * Setzt BOSCH_SHC_DEMO=1 und startet den normalen Server. In diesem Modus
 * verbindet sich der Server NICHT mit einer echten SHC (keine config.json,
 * keine Zertifikate, kein Login nötig) — stattdessen serviert er den
 * in-memory Beispielhaushalt aus demo/demo-data.js. So lässt sich die UI mit
 * allen bekannten Gerätetypen anschauen, auch ohne die Hardware.
 *
 * Läuft auf einem eigenen Port (Default 3001, override via
 * BOSCH_SHC_DEMO_PORT), damit er parallel zum echten Server (3000) laufen kann.
 *
 *   npm run demo   ->   http://localhost:3001
 */
process.env.BOSCH_SHC_DEMO = '1';
require('./server.js');
