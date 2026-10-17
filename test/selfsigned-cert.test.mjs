// The client certificate is generated in plain Node (selfsigned-cert.js)
// instead of shelling out to openssl. The SHC only accepts it if it looks
// like the openssl one, so pin the properties that matter.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { createSelfSignedCert } = require('../selfsigned-cert.js');
const setup = require('../setup.js');

describe('createSelfSignedCert', () => {
  const { cert, key } = createSelfSignedCert({ commonName: 'oss_bosch_shc_web_ui' });
  const x = new crypto.X509Certificate(cert);

  test('self-signed CA cert with the client id as CN', () => {
    expect(x.subject).toBe('CN=oss_bosch_shc_web_ui');
    expect(x.issuer).toBe('CN=oss_bosch_shc_web_ui');
    expect(x.ca).toBe(true);
    expect(x.verify(x.publicKey)).toBe(true);
  });

  test('RSA 2048 key in PKCS#8 that matches the certificate', () => {
    expect(key.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
    const pk = crypto.createPrivateKey(key);
    expect(pk.asymmetricKeyDetails.modulusLength).toBe(2048);
    expect(x.checkPrivateKey(pk)).toBe(true);
  });

  test('valid for 9999 days by default (GeneralizedTime past 2049)', () => {
    const days = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / 864e5;
    expect(Math.round(days)).toBe(9999);
  });

  test('short validity uses UTCTime and still parses', () => {
    const short = new crypto.X509Certificate(createSelfSignedCert({ commonName: 'x', days: 1 }).cert);
    expect(Math.round((Date.parse(short.validTo) - Date.parse(short.validFrom)) / 864e5)).toBe(1);
  });

  test('loads into a TLS context and survives formatCertForBosch', async () => {
    const tls = await import('node:tls');
    expect(() => tls.createSecureContext({ cert, key })).not.toThrow();
    const formatted = setup.formatCertForBosch(cert);
    const body = formatted.split('\r')[1];
    expect(Buffer.from(body, 'base64').equals(x.raw)).toBe(true);
  });

  test('serial numbers are random and positive', () => {
    const a = new crypto.X509Certificate(createSelfSignedCert({ commonName: 'x' }).cert).serialNumber;
    const b = new crypto.X509Certificate(createSelfSignedCert({ commonName: 'x' }).cert).serialNumber;
    expect(a).not.toBe(b);
    expect(parseInt(a[0], 16)).toBeLessThan(8); // high bit clear
  });
});
