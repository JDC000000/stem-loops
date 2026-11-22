// Set lists (#322; Phase B, B2): the shared rules in src/lib/set-lists.ts (pure, client-safe)
// and the shape of migration 044 (read from disk; the database behaviour of the same
// migration is exercised against a real Postgres in set-lists-pg.test.mjs, CI only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DELETE_LIST_NOTE,
  DEMO_SET,
  DEMO_SET_ID,
  DEMO_SET_NAME,
  DEMO_SET_SLUGS,
  MAX_SET_LISTS,
  MAX_SET_LIST_SONGS,
  canAddList,
  canAddSong,
  checkSetListName,
  defaultSetListName,
  isSetId,
  itemStateLabel,
  moveItem,
  nextInSet,
  playHref,
  skippedNotice,
} from '../src/lib/set-lists.ts';
import { DEMO_SONGS } from '../src/lib/demo-catalog.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(WEB, '..', '..');
const SQL = readFileSync(join(REPO, 'apps/worker/migrations/044_v3_set_lists.sql'), 'utf8');
const DOWN = readFileSync(join(REPO, 'apps/worker/migrations/down/044_v3_set_lists_down.sql'), 'utf8');
const code = SQL.replace(/--[^\n]*/g, '');

// ── constants and the Demo set ──────────────────────────────────────────────

test('limits are 50 lists and 200 songs (#322)', () => {
  assert.equal(MAX_SET_LISTS, 50);
  assert.equal(MAX_SET_LIST_SONGS, 200);
});

test('limit edges: the 50th list and the 200th song are allowed, the 51st / 201st are not', () => {
  assert.equal(canAddList(0), true);
  assert.equal(canAddList(49), true);
  assert.equal(canAddList(50), false);
  assert.equal(canAddSong(199), true);
  assert.equal(canAddSong(200), false);
});

test('the Demo set is code-defined: "Demo set", #322 order (I’m Asking You, Offline, Lucky Ticket), from DEMO_SONGS', () => {
  assert.equal(DEMO_SET_ID, 'demo');
  assert.equal(DEMO_SET_NAME, 'Demo set');
  assert.deepEqual(DEMO_SET_SLUGS, ['im-asking-you', 'offline', 'lucky-ticket']);
  assert.deepEqual(DEMO_SET.map((s) => s.title), ['I’m Asking You', 'Offline', 'Lucky Ticket']);
  for (const s of DEMO_SET) assert.ok(DEMO_SONGS.includes(s), `${s.slug} comes from the catalog`);
});

test('the copy: deleting a list never deletes songs (AC 3)', () => {
  assert.equal(DELETE_LIST_NOTE, 'Deleting a list never deletes songs.');
});

// ── names ───────────────────────────────────────────────────────────────────

test('names: trimmed, 1-60 characters (code points), no control characters', () => {
  assert.deepEqual(checkSetListName('  JAMS  '), { ok: true, name: 'JAMS' });
  assert.deepEqual(checkSetListName('Friday   gig'), { ok: true, name: 'Friday gig' });
  assert.equal(checkSetListName('').ok, false);
  assert.equal(checkSetListName('   ').ok, false);
  assert.equal(checkSetListName(42).ok, false);
  assert.equal(checkSetListName(null).ok, false);
  assert.equal(checkSetListName('a'.repeat(60)).ok, true);
  assert.equal(checkSetListName('a'.repeat(61)).ok, false);
  assert.equal(checkSetListName('🎸'.repeat(60)).ok, true, '60 code points is 60 characters to Postgres');
  assert.equal(checkSetListName('🎸'.repeat(61)).ok, false);
  assert.equal(checkSetListName('a\u0000b').ok, false);
});

test('the prefilled name is the first free "Set list N", compared case-insensitively (AC 7)', () => {
  assert.equal(defaultSetListName([]), 'Set list 1');
  assert.equal(defaultSetListName(['Set list 1']), 'Set list 2');
  assert.equal(defaultSetListName(['set LIST 1', 'Set list 3']), 'Set list 2');
  assert.equal(defaultSetListName(['JAMS']), 'Set list 1');
});

// ── Next song (AC 7) ────────────────────────────────────────────────────────

const it = (i, state, job = `j${i}`) => ({ item_id: `i${i}`, position: i, source: 'link', title: `Song ${i}`, state, job_id: state === 'ready' || state === 'processing' ? job : null });

test('next song: the next READY item; expired, unavailable and processing items are skipped and counted', () => {
  const items = [it(0, 'ready'), it(1, 'expired'), it(2, 'unavailable'), it(3, 'processing'), it(4, 'ready')];
  const r = nextInSet(items, 'j0');
  assert.equal(r.next?.item_id, 'i4');
  assert.equal(r.skipped, 3);
  assert.equal(r.index, 0);
  assert.equal(skippedNotice(r.skipped), 'Skipped 3 songs that can’t play now.');
  assert.equal(skippedNotice(1), 'Skipped 1 song that can’t play now.');
  assert.equal(skippedNotice(0), '');
});

test('next song: the adjacent item when it can play (nothing skipped)', () => {
  const r = nextInSet([it(0, 'ready'), it(1, 'ready'), it(2, 'ready')], 'j1');
  assert.deepEqual([r.next?.item_id, r.skipped, r.index], ['i2', 0, 1]);
});

test('next song: never runs past the end, never wraps to the top', () => {
  const items = [it(0, 'ready'), it(1, 'ready'), it(2, 'ready')];
  assert.equal(nextInSet(items, 'j2').next, null);
  const tail = [it(0, 'ready'), it(1, 'ready'), it(2, 'expired')];
  const r = nextInSet(tail, 'j1');
  assert.equal(r.next, null);
  assert.equal(r.skipped, 1);
});

test('next song: a song that is not in the list has no next (index -1)', () => {
  assert.deepEqual(nextInSet([it(0, 'ready')], 'other'), { next: null, skipped: 0, index: -1 });
});

test('playHref keeps ?set= so the next player shows Next song too', () => {
  assert.equal(playHref('abc', 'demo'), '/jobs/abc?set=demo');
});

test('move up / move down swap neighbours and do nothing at an edge', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
});

test('item state labels', () => {
  assert.equal(itemStateLabel('ready'), null);
  assert.equal(itemStateLabel('expired'), 'Audio expired');
  assert.equal(itemStateLabel('unavailable'), 'Unavailable');
  assert.equal(itemStateLabel('processing'), 'Processing');
});

test('?set= accepts the Demo set or a uuid, nothing else', () => {
  assert.equal(isSetId('demo'), true);
  assert.equal(isSetId('3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b'), true);
  for (const bad of ['', 'DEMO', '../x', 'javascript:alert(1)', null, undefined]) assert.equal(isSetId(bad), false, String(bad));
});

// ── migration 044, as written ───────────────────────────────────────────────

test('044: set_lists.user_id NOT NULL, FK to users ON DELETE CASCADE; no is_demo column (the Demo set is code)', () => {
  assert.match(code, /user_id\s+uuid\s+NOT NULL REFERENCES public\.users\(id\) ON DELETE CASCADE/);
  const table = code.match(/CREATE TABLE IF NOT EXISTS public\.set_lists \(([\s\S]*?)\n\);/)[1];
  assert.doesNotMatch(table, /is_demo/);
});

test('044: names are unique per user CASE-INSENSITIVELY, and 1-60 trimmed characters', () => {
  assert.match(code, /CREATE UNIQUE INDEX IF NOT EXISTS set_lists_user_name_key\s+ON public\.set_lists \(user_id, lower\(name\)\)/);
  assert.match(code, /CHECK \(name = btrim\(name\) AND char_length\(name\) BETWEEN 1 AND 60\)/);
});

test('044: items: job_id NULLABLE and ON DELETE SET NULL (never CASCADE: AC 5); list FK cascades', () => {
  assert.match(code, /job_id\s+uuid\s+NULL REFERENCES public\.jobs\(id\) ON DELETE SET NULL/);
  assert.doesNotMatch(code, /REFERENCES public\.jobs\(id\) ON DELETE CASCADE/);
  assert.match(code, /set_list_id uuid\s+NOT NULL REFERENCES public\.set_lists\(id\) ON DELETE CASCADE/);
});

test('044: the position unique is DEFERRABLE INITIALLY DEFERRED (atomic reorder), plus url and job uniques', () => {
  assert.match(code, /CONSTRAINT set_list_songs_position_key UNIQUE \(set_list_id, position\) DEFERRABLE INITIALLY DEFERRED/);
  assert.match(code, /CONSTRAINT set_list_songs_url_key UNIQUE \(set_list_id, youtube_url\)/);
  assert.match(code, /CONSTRAINT set_list_songs_job_key UNIQUE \(set_list_id, job_id\)/);
  assert.match(code, /source IN \('link', 'upload', 'demo'\)/);
});

test('044: RLS backend-only on both tables, anon/authenticated revoked, the marker present', () => {
  for (const t of ['set_lists', 'set_list_songs']) {
    assert.match(code, new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
    assert.match(code, new RegExp(`CREATE POLICY stemloops_app_all ON public\\.${t}\\s+FOR ALL TO stemloops_app USING \\(true\\) WITH CHECK \\(true\\)`));
    assert.match(code, new RegExp(`REVOKE ALL ON public\\.${t} FROM anon, authenticated`));
  }
  assert.match(SQL, /^-- rls-backend-only: set_lists, set_list_songs$/m);
});

test('044: tombstone backstop trigger deletes the lists, as SECURITY DEFINER with a pinned search_path (any tombstoning role); not executable by PUBLIC/anon/authenticated', () => {
  assert.match(code, /AFTER UPDATE OF deleted_at ON public\.users[\s\S]*WHEN \(NEW\.deleted_at IS NOT NULL\)[\s\S]*EXECUTE FUNCTION public\.delete_set_lists_for_tombstoned_user\(\)/);
  assert.match(code, /DELETE FROM public\.set_lists WHERE user_id = NEW\.id;/);
  assert.match(code, /REVOKE ALL ON FUNCTION public\.delete_set_lists_for_tombstoned_user\(\) FROM PUBLIC;/);
  assert.match(code, /REVOKE ALL ON FUNCTION public\.delete_set_lists_for_tombstoned_user\(\) FROM anon, authenticated;/);
  const fn = code.match(/CREATE OR REPLACE FUNCTION public\.delete_set_lists_for_tombstoned_user\(\)([\s\S]*?)AS \$\$/)[1];
  assert.match(fn, /SECURITY DEFINER/);
  assert.match(fn, /SET search_path = public, pg_temp/);
  assert.equal((code.match(/SECURITY DEFINER/g) ?? []).length, 1, 'no other definer function');
});

test('044 down: drops what 044 made and its ledger row', () => {
  for (const re of [/DROP TRIGGER IF EXISTS users_tombstone_delete_set_lists ON public\.users/, /DROP FUNCTION IF EXISTS public\.delete_set_lists_for_tombstoned_user\(\)/,
    /DROP TABLE IF EXISTS public\.set_list_songs/, /DROP TABLE IF EXISTS public\.set_lists/, /DELETE FROM public\._migrations WHERE filename = '044_v3_set_lists\.sql'/]) {
    assert.match(DOWN, re);
  }
});
