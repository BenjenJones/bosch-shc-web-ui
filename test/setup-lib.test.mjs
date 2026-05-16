// Unit tests for the pure helpers in setup.js (the bits that don't touch
// the SHC, disk, or openssl). The interactive CLI flow at the bottom of
// setup.js is gated behind `require.main === module` so just requiring
// the file here only loads the library half.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const setup   = require('../setup.js');

describe('setup.formatCertForBosch', () => {
  // Bosch's /smarthome/clients endpoint is picky: it wants the cert body as a
  // single base64 chunk surrounded by BEGIN/END markers, each separated by
  // a literal carriage return (\r) — no LF, no internal whitespace. If we
  // ever regress on that, the SHC silently rejects the registration with a
  // useless error, so verify the shape explicitly.
  const SAMPLE_PEM = [
    '-----BEGIN CERTIFICATE-----',
    'MIIBszCCAVigAwIBAgIUYz',
    'AQEBBQUAMA0xCzAJBgNVBA',
    '-----END CERTIFICATE-----',
    '',
  ].join('\n');

  test('removes BEGIN/END markers from the inner block and reattaches with \\r', () => {
    const out = setup.formatCertForBosch(SAMPLE_PEM);
    expect(out.startsWith('-----BEGIN CERTIFICATE-----\r')).toBe(true);
    expect(out.endsWith('\r-----END CERTIFICATE-----')).toBe(true);
    // Body — between the markers — must be one continuous string with no
    // whitespace and exactly one occurrence of every base64 line from the
    // input (concatenated).
    const body = out.replace('-----BEGIN CERTIFICATE-----\r', '').replace('\r-----END CERTIFICATE-----', '');
    expect(body).toBe('MIIBszCCAVigAwIBAgIUYzAQEBBQUAMA0xCzAJBgNVBA');
    expect(/\s/.test(body)).toBe(false);
  });

  test('is idempotent — feeding the formatted cert back in produces the same output', () => {
    const once  = setup.formatCertForBosch(SAMPLE_PEM);
    const twice = setup.formatCertForBosch(once);
    expect(twice).toBe(once);
  });
});

describe('setup.hashPassword', () => {
  test('returns salt + hex hash; same input + same salt = same hash', () => {
    const a = setup.hashPassword('hunter2', 'abc123');
    const b = setup.hashPassword('hunter2', 'abc123');
    expect(a).toEqual(b);
    expect(a.salt).toBe('abc123');
    expect(a.passwordHash).toMatch(/^[0-9a-f]{128}$/); // scrypt 64 bytes -> 128 hex chars
  });

  test('different salt → different hash for the same password', () => {
    const a = setup.hashPassword('hunter2', 'salt-one');
    const b = setup.hashPassword('hunter2', 'salt-two');
    expect(a.passwordHash).not.toBe(b.passwordHash);
  });

  test('auto-generated salt is unique per call', () => {
    const a = setup.hashPassword('hunter2');
    const b = setup.hashPassword('hunter2');
    expect(a.salt).not.toBe(b.salt);
    expect(a.passwordHash).not.toBe(b.passwordHash);
  });
});
