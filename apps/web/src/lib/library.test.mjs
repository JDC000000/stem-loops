// Run: pnpm --filter web test
// The /history list: library rows (server deadline) merged with this browser's anonymous history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listedSongs, filterSongs, sortSongs, bpmKey, searchFold, readLastOpened, recordLastOpened, stateChip,
  LIBRARY_NOTE_SIGNED_IN, LIBRARY_NOTE_SIGNED_OUT, REMAKE_LABEL, AUDIO_EXPIRED, LAST_OPENED_KEY,
} from './library.ts';

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
  assert.deepEqual(out, [{
    key: A, id: A, entryId: null, label: 'tune.mp3', meta: null, createdAtMs: NOW - 10 * D, expiresAtMs: NOW + 40 * D,
    source: 'library', isDemo: false, thumbUrl: null, state: 'unknown', isUpload: false, searchText: 'tune.mp3',
  }]);
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
  // Phase B, B1 (PB-1): on Free the AUDIO goes at 24 h; the song stays in the library.
  assert.match(LIBRARY_NOTE_SIGNED_IN, /^On Free, a song’s audio, stems, loops and chord file are deleted 24 hours after you start it\. Its title, BPM and key stay in your library until you remove the song or delete your account, and you can re-make it\./);
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


// ── Phase B, B1: expired songs, BPM · key, search, sort, last opened ──
const E1 = '11111111-0000-4000-8000-0000000000e1';
const E2 = '11111111-0000-4000-8000-0000000000e2';

test('an expired entry is listed with state expired, its BPM · key, Re-make for a link, Upload again for an upload', () => {
  const out = listedSongs([], [], NOW, [
    { entry_id: E1, input_kind: 'youtube', youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Never', bpm: 113.4, musical_key: 'A major', created_at: iso(NOW - 3 * D) },
    { entry_id: E2, input_kind: 'upload', original_filename: 'take.wav', title: null, created_at: iso(NOW - 2 * D) },
  ]);
  assert.deepEqual(out.map((s) => [s.key, s.id, s.entryId, s.state, s.label, s.meta, s.isUpload, s.expiresAtMs]), [
    [`entry:${E2}`, null, E2, 'expired', 'take.wav', null, true, null],
    [`entry:${E1}`, null, E1, 'expired', 'Never', '113 BPM · A major', false, null],
  ]);
  assert.equal(out[1].thumbUrl, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  assert.equal(stateChip('expired'), AUDIO_EXPIRED);
  assert.equal(AUDIO_EXPIRED, 'Audio expired');
  assert.equal(REMAKE_LABEL, 'Re-make · uses 1 of your songs');
});

test('bpmKey: either half, rounded, nothing for neither', () => {
  assert.equal(bpmKey(119.6, 'G minor'), '120 BPM · G minor');
  assert.equal(bpmKey(null, 'G minor'), 'G minor');
  assert.equal(bpmKey(96, null), '96 BPM');
  assert.equal(bpmKey(0, ' '), null);
  assert.equal(bpmKey(NaN, undefined), null);
});

test('search: title words in any order, case and accents folded; artist only for demo songs', () => {
  const demoId = '9c5ba587-0000-4000-8000-000000000001'; // DEMO_SONGS Lucky Ticket's prefix
  const plainId = 'aaaaaaaa-1111-4000-8000-000000000009';
  const songs = listedSongs(
    [
      { id: demoId, title: 'Lucky Ticket', created_at: iso(NOW - D), expires_at: '2099-12-31T00:00:00Z', is_demo: true },
      { id: plainId, title: 'Café Royal', created_at: iso(NOW - D), expires_at: iso(NOW + D) },
    ],
    [], NOW,
    [{ entry_id: E1, youtube_url: 'https://youtu.be/dQw4w9WgXcQ', title: 'I’m Asking You', created_at: iso(NOW - 2 * D) }],
  );
  const ids = (q) => filterSongs(songs, q).map((s) => s.id ?? s.entryId);
  assert.deepEqual(ids('royal'), [demoId, plainId], '"royal": the title Café Royal and the demo artist The Royal Sundowners');
  assert.deepEqual(ids('sundowners'), [demoId], 'a demo song matches its artist (DEMO_SONGS)');
  assert.deepEqual(ids('CAFE'), [plainId], 'accents and case folded');
  assert.deepEqual(ids("i'm asking"), [E1], 'curly apostrophe folded');
  assert.deepEqual(ids('ticket lucky'), [demoId], 'every word, any order');
  assert.deepEqual(ids('   '), songs.map((s) => s.id ?? s.entryId), 'blank query = everything');
  assert.deepEqual(ids('zzz'), []);
  assert.equal(searchFold('  A  b '), 'a b');
});

test('search: a non-demo row never matches the demo artist (artist search is demo-only)', () => {
  const songs = listedSongs([{ id: 'aaaaaaaa-1111-4000-8000-00000000000a', title: 'Offline', created_at: iso(NOW), expires_at: iso(NOW + D) }], [], NOW);
  assert.deepEqual(filterSongs(songs, 'royal sundowners'), []);
});

test('search filters 200 rows in well under 300 ms', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
    title: `Song number ${i} by somebody`, created_at: iso(NOW - i * H), expires_at: iso(NOW + D),
  }));
  const songs = listedSongs(rows, [], NOW);
  const t0 = performance.now();
  let n = 0;
  for (const q of ['song', 'number 19', 'somebody 1', 'nothing here', 's']) n += filterSongs(songs, q).length;
  const ms = performance.now() - t0;
  assert.ok(n > 0);
  assert.ok(ms < 300, `5 searches over 200 rows took ${ms.toFixed(1)} ms`);
});

test('sort: Recent = last opened (else created), Newest = created, A–Z = title', () => {
  const [a, b, c] = ['aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b', 'cccccccc-0000-4000-8000-00000000000c'];
  const songs = listedSongs(
    [
      { id: a, title: 'Zebra', created_at: iso(NOW - 3 * D), expires_at: iso(NOW + D) },
      { id: b, title: 'apple', created_at: iso(NOW - 2 * D), expires_at: iso(NOW + D) },
      { id: c, title: 'Mango', created_at: iso(NOW - 1 * D), expires_at: iso(NOW + D) },
    ],
    [], NOW,
    [{ entry_id: E1, youtube_url: 'https://youtu.be/x', title: 'Kiwi', created_at: iso(NOW - 4 * D) }],
  );
  const ids = (mode, opened) => sortSongs(songs, mode, opened).map((s) => s.id ?? s.entryId);
  assert.deepEqual(ids('newest'), [c, b, a, E1]);
  assert.deepEqual(ids('recent', {}), [c, b, a, E1], 'nothing opened: Recent = created');
  assert.deepEqual(ids('recent', { [a]: NOW - H }), [a, c, b, E1], 'the song opened an hour ago comes first');
  assert.deepEqual(ids('recent', { [a]: NOW - 10 * D }), [c, b, a, E1], 'an open older than creation never sinks a row');
  assert.deepEqual(ids('az'), [b, E1, c, a]);
});

test('last opened: round-trips through storage, ignores junk, keeps the newest 200', () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  recordLastOpened(store, 'aaaaaaaa-0000-4000-8000-00000000000a', 5);
  recordLastOpened(store, 'not-a-job-id', 6);
  assert.deepEqual(readLastOpened(store), { 'aaaaaaaa-0000-4000-8000-00000000000a': 5 });
  for (let i = 0; i < 250; i += 1) recordLastOpened(store, `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, 100 + i);
  const m = readLastOpened(store);
  assert.equal(Object.keys(m).length, 200);
  assert.equal(m['aaaaaaaa-0000-4000-8000-000000000249'], 349);
  mem.set(LAST_OPENED_KEY, '{bad json');
  assert.deepEqual(readLastOpened(store), {});
  mem.set(LAST_OPENED_KEY, '[1,2]');
  assert.deepEqual(readLastOpened(store), {});
  assert.deepEqual(readLastOpened(null), {});
});
