/**
 * Demo-SHC — ein lokaler HTTP-Server, der die Local-REST-API des echten Bosch
 * Smart Home Controllers nachbildet (`/smarthome/...`), gespeist aus dem
 * in-memory Datensatz in demo-data.js.
 *
 * Damit braucht der eigentliche UI-Server (server.js) *keinen* Demo-Sonderweg:
 * er verbindet sich — wie im Test-Harness gegen Prism — per `shcProtocol:'http'`
 * ganz normal mit dieser Adresse, statt mit der echten Box über mTLS. Die
 * Abstraktion ist also die HTTP-Schnittstelle selbst.
 *
 * Gestartet wird der Demo-SHC von demo.js (via `npm run demo`).
 */

const express = require('express');
const demo = require('./demo-data.js');

const app = express();
// strict:false, damit auch skalare Bodies (z. B. bare boolean beim
// userdefinedstates-State-PUT) geparst werden — wie im echten UI-Server.
app.use(express.json({ strict: false }));

// Alles an den Router in demo-data.js. `originalUrl` (ohne Query) ist der
// roh-kodierte Pfad, genau wie ihn shcRequest() erzeugt — demo.handle()
// dekodiert die Segmente selbst (Geräte-IDs mit ':' / '#').
app.use(async (req, res) => {
  const urlPath = req.originalUrl.split('?')[0];
  try {
    const result = await demo.handle(req.method, urlPath, req.body);
    res.json(result === undefined ? {} : result);
  } catch (err) {
    // Fehlerform wie die echte Box (JsonRestExceptionResponseEntity), damit
    // server.js' Fehlerdurchreichung unverändert funktioniert.
    res.status(err.status || 500).json({
      '@type': 'JsonRestExceptionResponseEntity',
      errorCode: err.status === 404 ? 'ENTITY_NOT_FOUND' : 'DEMO_ERROR',
      message: err.message,
      statusCode: err.status || 500,
    });
  }
});

module.exports = app;
