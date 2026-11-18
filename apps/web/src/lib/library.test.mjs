// Run: pnpm --filter web test
// The /history list: library rows (server deadline) merged with this browser's anonymous history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listedSongs, LIBRARY_NOTE_SIGNED_IN, LIBRARY_NOTE_SIGNED_OUT } from './library.ts';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const H = 3600 * 1000;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

test('a library song older than 24 h is listed with the SERVER deadline and its file name', () => {
  const out = listedSongs(
    [{ id: A, original_filename: 'tune.mp3', created_at: iso(NOW - 10 * D), expires_at: iso(NOW + 40 * D) }],
    [],
    NOW,
  );
  assert.deepEqual(out, [{ id: A, label: 'tune.mp3', createdAtMs: NOW - 10 * D, expiresAtMs: NOW + 40 * D, source: 'library', isDemo: false, thumbUrl: null }]);
});

test('a browser-only entry keeps Free\'s 24 h and drops out after it', () => {
  const out = listedSongs([], [{ id: B, at: NOW - 2 * H }, { id: C, at: NOW - 25 * H }], NOW);
  assert.deepEqual(out.map((s) => [s.id, s.expiresAtMs, s.source]), [[B, NOW + 22 * H, 'browser']]);
});

test('the library row wins over the same id in this browser; newest first; expired rows left out', () => {
  const out = listedSongs(
    [
      { id: A, created_at: iso(NOW - 3 * D), expires_at: iso(NOW + 27 * D) },
      { id: C, created_at: iso(NOW - 40 * D), expires_at: iso(NOW - 1) },
    ],
    [{ id: A, at: NOW - 1 * H }, { id: B, at: NOW - 1 * H }],
    NOW,
  );
  assert.deepEqual(out.map((s) => [s.id, s.source]), [[B, 'browser'], [A, 'library']]);
});

test('notes: Free\'s 24 hours stays exact; the paid library names both terms', () => {
  assert.equal(LIBRARY_NOTE_SIGNED_OUT, 'Files are deleted after 24 hours.');
  assert.match(LIBRARY_NOTE_SIGNED_IN, /^On Free, songs are deleted 24 hours after you start them\./);
  assert.match(LIBRARY_NOTE_SIGNED_IN, /while you are subscribed, and for 30 days after your plan ends\.$/);
  assert.doesNotMatch(LIBRARY_NOTE_SIGNED_IN + LIBRARY_NOTE_SIGNED_OUT, /on our side|forever|unlimited/i);
});

// ── demo songs (V3 Slice 0, migration 040) ──
// A demo row's expires_at is the far-future DEMO_RETAINED_UNTIL. It must be LISTED (a finite
// date: lib/library.ts drops a non-finite one, which is why the SQL does not return
// 'infinity') and flagged isDemo so /history shows no "deleted in ~27,000 days".
test('a demo row (is_demo, expires 2099-12-31) is listed, flagged isDemo; others are not', async () => {
  const { DEMO_RETAINED_UNTIL } = await import('./retention.ts');
  const out = listedSongs(
    [
      { id: A, title: 'Lucky Ticket', created_at: iso(NOW - 3 * D), expires_at: DEMO_RETAINED_UNTIL, is_demo: true },
      { id: C, created_at: iso(NOW - 1 * D), expires_at: iso(NOW + 29 * D), is_demo: false },
    ],
    [{ id: B, at: NOW - 1 * H }],
    NOW,
  );
  assert.deepEqual(
    out.map((s) => [s.id, s.isDemo, s.expiresAtMs]),
    [
      [B, false, NOW + 23 * H],
      [C, false, NOW + 29 * D],
      [A, true, Date.parse('2099-12-31T00:00:00Z')],
    ],
  );
});

test("'infinity' would have dropped the demo from the list: the finite date is load-bearing", () => {
  // node-pg hands 'infinity'::timestamptz to JSON as null (Infinity -> Date NaN).
  for (const expires_at of [null, 'infinity', 'Infinity']) {
    assert.deepEqual(listedSongs([{ id: A, created_at: iso(NOW), expires_at, is_demo: true }], [], NOW), []);
  }
});
