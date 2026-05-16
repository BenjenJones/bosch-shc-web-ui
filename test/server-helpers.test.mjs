// Unit tests for pure helpers exposed from server.js via module.exports
// `_internals`. We import server.js the same way api.test.mjs does — env
// vars first, then dynamic import — so the test config still drives boot.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.BOSCH_SHC_CONFIG_FILE = path.join(__dirname, 'fixtures', 'config.json');
process.env.BOSCH_SHC_NO_LISTEN   = '1';

let internals;
beforeAll(async () => {
  const mod = await import('../server.js');
  internals = (mod.default || mod)._internals;
});

describe('adaptIntrusionState', () => {
  // The UI was written against the older device-service-style response, but
  // server.js now hits the documented /intrusion/states/system. The adapter
  // collapses arming + alarm states back into the single `state.value` the
  // UI checks. These tests pin that mapping so a refactor in either
  // direction can't break the alarm view silently.

  test('disarmed → SYSTEM_DISARMED, profile 0', () => {
    const adapted = internals.adaptIntrusionState({
      armingState: { state: 'SYSTEM_DISARMED' },
      alarmState:  { value: 'ALARM_OFF' },
      activeConfigurationProfile: { profileId: '0' },
    });
    expect(adapted.state.value).toBe('SYSTEM_DISARMED');
    expect(adapted.state.activeConfigurationProfile).toBe('0');
  });

  test('armed → SYSTEM_ARMED', () => {
    const adapted = internals.adaptIntrusionState({
      armingState: { state: 'SYSTEM_ARMED' },
      alarmState:  { value: 'ALARM_OFF' },
      activeConfigurationProfile: { profileId: '1' },
    });
    expect(adapted.state.value).toBe('SYSTEM_ARMED');
    expect(adapted.state.activeConfigurationProfile).toBe('1');
  });

  test('arming countdown → SYSTEM_ARMING + remainingTimeUntilArmed surfaced', () => {
    const adapted = internals.adaptIntrusionState({
      armingState: { state: 'SYSTEM_ARMING', remainingTimeUntilArmed: 12000 },
      alarmState:  { value: 'ALARM_OFF' },
      activeConfigurationProfile: { profileId: '0' },
    });
    expect(adapted.state.value).toBe('SYSTEM_ARMING');
    expect(adapted.state.remainingTimeUntilArmed).toBe(12000);
  });

  test('alarm ringing overrides arming state → SYSTEM_ALARM', () => {
    const adapted = internals.adaptIntrusionState({
      armingState: { state: 'SYSTEM_ARMED' },
      alarmState:  { value: 'ALARM_ON' },
      activeConfigurationProfile: { profileId: '0' },
    });
    expect(adapted.state.value).toBe('SYSTEM_ALARM');
  });

  test('alarm muted overrides arming state → MUTE_ALARM', () => {
    const adapted = internals.adaptIntrusionState({
      armingState: { state: 'SYSTEM_ARMED' },
      alarmState:  { value: 'ALARM_MUTED' },
      activeConfigurationProfile: { profileId: '0' },
    });
    expect(adapted.state.value).toBe('MUTE_ALARM');
  });

  test('null payload passes through unchanged', () => {
    expect(internals.adaptIntrusionState(null)).toBe(null);
  });

  test('missing fields fall back to disarmed/profile-0', () => {
    const adapted = internals.adaptIntrusionState({});
    expect(adapted.state.value).toBe('SYSTEM_DISARMED');
    expect(adapted.state.activeConfigurationProfile).toBe('0');
    expect(adapted.state.remainingTimeUntilArmed).toBe(null);
  });

  test('preserves the upstream payload on `raw` for richer-fielded clients', () => {
    const raw = { armingState: { state: 'SYSTEM_DISARMED' }, somethingExtra: 'keep me' };
    const adapted = internals.adaptIntrusionState(raw);
    expect(adapted.raw).toBe(raw);
  });
});

describe('verifyPassword / hashPassword (auth round-trip)', () => {
  test('hash then verify returns true with the right password', () => {
    const { salt, passwordHash } = internals.hashPassword('correct horse battery staple');
    expect(internals.verifyPassword('correct horse battery staple', salt, passwordHash)).toBe(true);
  });

  test('wrong password fails verify', () => {
    const { salt, passwordHash } = internals.hashPassword('correct horse battery staple');
    expect(internals.verifyPassword('wrong', salt, passwordHash)).toBe(false);
  });

  test('right password but wrong salt fails verify', () => {
    const { passwordHash } = internals.hashPassword('correct horse battery staple', 'salt-a');
    expect(internals.verifyPassword('correct horse battery staple', 'salt-b', passwordHash)).toBe(false);
  });

  test('verify of an unexpected-length hash returns false rather than throwing (timingSafeEqual would otherwise)', () => {
    // Truncated stored hash. We rely on the length check to short-circuit;
    // crypto.timingSafeEqual throws on differing lengths.
    const { salt } = internals.hashPassword('any');
    expect(internals.verifyPassword('any', salt, 'abcd')).toBe(false);
  });
});

describe('readCookie', () => {
  // server.js's readCookie does its own parsing rather than pulling in a
  // cookie-parser dep. The flows that depend on it (session-cookie
  // resolution, logout) reach in via dotted accessors that the unit tests
  // here pin down once.
  const req = (cookie) => ({ headers: { cookie } });

  test('returns null when no Cookie header is present', () => {
    expect(internals.readCookie({ headers: {} }, 'shc_session')).toBe(null);
  });

  test('returns null when the cookie name is not in the header', () => {
    expect(internals.readCookie(req('foo=bar; baz=qux'), 'shc_session')).toBe(null);
  });

  test('extracts a single cookie at the start of the header', () => {
    expect(internals.readCookie(req('shc_session=abc'), 'shc_session')).toBe('abc');
  });

  test('extracts a cookie that is not first in the header', () => {
    expect(internals.readCookie(req('other=x; shc_session=def; trailing=y'), 'shc_session')).toBe('def');
  });

  test('decodes percent-encoded values (URL-safe base64 ids round-trip cleanly)', () => {
    const token = 'aB+/cD==';
    const encoded = encodeURIComponent(token);
    expect(internals.readCookie(req(`shc_session=${encoded}`), 'shc_session')).toBe(token);
  });

  test('does not match a cookie whose name is a prefix of another', () => {
    // `shc_session_x=…` must NOT be returned when asking for `shc_session`.
    expect(internals.readCookie(req('shc_session_x=trap'), 'shc_session')).toBe(null);
  });
});

describe('publicUser', () => {
  test('strips secret-bearing fields (salt, passwordHash) from the user record', () => {
    const u = {
      username: 'alice',
      role: 'admin',
      mustChangePassword: false,
      salt: 'shouldNotLeak',
      passwordHash: 'shouldNotLeak',
      createdAt: 123,
    };
    const pub = internals.publicUser(u);
    expect(pub).toEqual({ username: 'alice', role: 'admin', mustChangePassword: false });
    expect(pub).not.toHaveProperty('salt');
    expect(pub).not.toHaveProperty('passwordHash');
  });

  test('null in → null out (used during failed session lookups)', () => {
    expect(internals.publicUser(null)).toBe(null);
  });

  test('mustChangePassword is normalized to boolean', () => {
    expect(internals.publicUser({ username: 'a', role: 'user' })).toMatchObject({ mustChangePassword: false });
    expect(internals.publicUser({ username: 'a', role: 'user', mustChangePassword: true })).toMatchObject({ mustChangePassword: true });
  });
});

describe('newToken', () => {
  test('returns a URL-safe base64 string of 43 characters (32 bytes)', () => {
    const t = internals.newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('two consecutive calls produce different tokens', () => {
    expect(internals.newToken()).not.toBe(internals.newToken());
  });
});
