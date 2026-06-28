// Unit tests for the client-side message visibility logic in public/js/core.js.
//
// core.js is a browser ES module. It only touches the DOM inside functions,
// but it reads `localStorage` once at module-eval time (to pick the initial
// language/theme). We stub that one global before the dynamic import so the
// module loads under plain Node — no jsdom required. (`navigator` already
// exists in Node and core.js tolerates a missing `.language`.)
import { describe, test, expect, beforeAll } from 'vitest';

globalThis.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};

let isMessageActive, state;
beforeAll(async () => {
  const mod = await import('../public/js/core.js');
  isMessageActive = mod.isMessageActive;
  state = mod.state;
});

// isMessageActive backs both the messages tab list and the per-room badges.
// It hides messages the SHC reports as deleted AND messages the user "marked
// read" — i.e. ones we couldn't DELETE (ENTITY_NOT_DELETABLE) so we archived
// locally instead. Archived ids must stay suppressed even though the SHC keeps
// re-listing them on every reload.
describe('isMessageActive (active-message visibility)', () => {
  test('plain active message is visible', () => {
    state.messageArchive = [];
    expect(isMessageActive({ id: 'm1' })).toBe(true);
  });

  test('SHC-deleted message is hidden', () => {
    state.messageArchive = [];
    expect(isMessageActive({ id: 'm1', deleted: true })).toBe(false);
  });

  test('archived ("marked read") message is hidden', () => {
    state.messageArchive = [{ id: 'm1' }];
    expect(isMessageActive({ id: 'm1' })).toBe(false);
  });

  test('a different id is unaffected by the archive', () => {
    state.messageArchive = [{ id: 'm1' }];
    expect(isMessageActive({ id: 'm2' })).toBe(true);
  });

  test('filters a mixed list down to the genuinely active ones', () => {
    state.messageArchive = [{ id: 'read' }];
    const msgs = [
      { id: 'active' },
      { id: 'gone', deleted: true },
      { id: 'read' },
    ];
    expect(msgs.filter(isMessageActive).map(m => m.id)).toEqual(['active']);
  });
});
