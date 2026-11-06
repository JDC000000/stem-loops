// Run: pnpm --filter web test
// Table test for the shared Harte validator (route.ts + edit-collector.ts) and
// a drift guard against the reference chord_source.py and migration 029.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HARTE_RE, HARTE_QUALITIES } from '../harte.ts';

const ACCEPT = ['C', 'C:maj', 'F#:7', 'G:7/5', 'A:min/b3', 'C#:maj7/b7', 'Bb:sus4/5', 'N', 'X', 'C:maj/13', 'C:maj/#5', 'C:maj/1'];
const REJECT = ['C:zzz', 'H:maj', 'C:maj/14', 'C:maj/0', 'N/3', 'X/5', 'c:maj', 'C:maj/', 'C:/3', '', 'C:maj7x', 'C:maj/C'];

test('accepts valid Harte labels incl. slash chords', () => {
  for (const l of ACCEPT) assert.ok(HARTE_RE.test(l), `should accept ${l}`);
});

test('rejects invalid Harte labels', () => {
  for (const l of REJECT) assert.ok(!HARTE_RE.test(l), `should reject ${l}`);
});

test('every alphabet quality (24 + N handled separately) is accepted', () => {
  assert.equal(HARTE_QUALITIES.length, 24);
  for (const q of HARTE_QUALITIES) assert.ok(HARTE_RE.test(`D:${q}`), q);
});

test('quality list matches chord_source.py (reference)', () => {
  const py = readFileSync(new URL('../../../../worker/src/worker/chord_source.py', import.meta.url), 'utf8');
  const block = py.match(/_HARTE_QUALITIES = \(([\s\S]*?)\n\)/)[1];
  const pyQ = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...HARTE_QUALITIES], pyQ);
});

test('migration 029 CHECK uses the same quality list', () => {
  const sql = readFileSync(new URL('../../../../worker/migrations/029_v3_chord_edits_harte_slash.sql', import.meta.url), 'utf8');
  assert.ok(sql.includes(`(${HARTE_QUALITIES.join('|')})`));
});
