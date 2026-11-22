// Run: pnpm --filter web test
// Which nav item is current on the set-list pages (B2 follow-up): "Song library".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAtOrUnder, isSongLibraryPath } from './nav-current.ts';

test('isAtOrUnder: the root and pages under it, never a sibling that shares the prefix', () => {
  assert.equal(isAtOrUnder('/sets', '/sets'), true);
  assert.equal(isAtOrUnder('/sets/demo', '/sets'), true);
  assert.equal(isAtOrUnder('/sets/3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b', '/sets'), true);
  assert.equal(isAtOrUnder('/setsx', '/sets'), false);
  assert.equal(isAtOrUnder('/set', '/sets'), false);
  assert.equal(isAtOrUnder('/', '/sets'), false);
  assert.equal(isAtOrUnder('', '/sets'), false);
});

test('Song library is current on /history, /sets and /sets/<id>', () => {
  for (const p of ['/history', '/sets', '/sets/demo', '/sets/3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b']) {
    assert.equal(isSongLibraryPath(p), true, p);
  }
});

test('Song library is not current anywhere else', () => {
  for (const p of ['', '/', '/history/x', '/historyx', '/setsx', '/jobs/abc', '/jobs/abc?set=demo', '/loops', '/account', '/pricing', '/login']) {
    assert.equal(isSongLibraryPath(p), false, p);
  }
});
