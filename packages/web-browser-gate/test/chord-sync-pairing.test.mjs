// #378 item 1: chord-sync samples pair on the displayed text as well as the clock.
// Pure Node (no browser): scripts/chord-sync-pairing.mjs, with the production formatter from apps/web.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedStarts, pairChanges } from '../scripts/chord-sync-pairing.mjs';
import { leadSheetSymbol } from '../../../apps/web/src/components/ChordPhone.helpers.ts';
import { classifyLabel } from '../../../apps/web/src/components/ChordOverlay.helpers.ts';

// The same mapping the measurement runs in the page (window.__display).
const shown = (label) => leadSheetSymbol({ kind: classifyLabel(label), label });
const runsOf = (spec) => spec.map(([startSec, label]) => ({ startSec, label, text: shown(label) }));
// An event with a clean output clock: heardPos === rawPos, no route compensation.
const ev = (text, rawPos) => ({ text, rawPos, comp: 0, ct: 0, ctxOut: 0, perf: 0, ctxPerf: 1 });

test('correct pair: same text inside the clock window', () => {
  const exp = expectedStarts(runsOf([[0, 'C'], [10, 'G:maj7']]));
  assert.deepEqual(exp.map((x) => [x.start, x.text]), [[10, 'Gmaj7']]);
  const a = pairChanges(exp, [ev('Gmaj7', 10.03)]);
  assert.equal(a.rows.length, 1);
  assert.equal(a.rows[0].exp, 0);
  assert.equal(Math.round(a.rows[0].lag_render), 30);
  assert.deepEqual([a.misses.length, a.spurious.length, a.textMismatches.length, a.pairedBehindClock], [0, 0, 0, 0]);
});

test('clock-near but wrong text: not paired, counted as a miss AND an extra, and as a text mismatch', () => {
  const exp = expectedStarts(runsOf([[0, 'C'], [10, 'G']]));
  const a = pairChanges(exp, [ev('Gmaj7', 10.03)]);
  assert.equal(a.rows.length, 0);
  assert.deepEqual(a.misses.map((m) => m.text), ['G']);
  assert.deepEqual(a.spurious, [0]);
  assert.equal(a.textMismatches.length, 1);
  assert.deepEqual([a.textMismatches[0].text, a.textMismatches[0].nearestText], ['Gmaj7', 'G']);
});

test('the #378 row: G shown 141 ms late after G:maj7 started pairs with G, not G:maj7', () => {
  const exp = expectedStarts(runsOf([[0, 'C'], [10, 'G'], [10.1, 'G:maj7']]));
  const a = pairChanges(exp, [ev('G', 10.141), ev('Gmaj7', 10.13 + 0.1)]);
  assert.deepEqual(a.rows.map((r) => [r.text, r.expText, Math.round(r.lag_render)]), [['G', 'G', 141], ['Gmaj7', 'Gmaj7', 130]]);
  assert.equal(a.pairedBehindClock, 1);
  assert.deepEqual([a.misses.length, a.spurious.length, a.textMismatches.length], [0, 0, 0]);
});

test('Simple-mode label equivalence: a triad label and its raw spelling draw the same text', () => {
  // The simplifier writes plain triads as "G" (triadLabel); a neighbouring run can keep "G:maj".
  assert.equal(shown('G:maj'), shown('G'));
  const exp = expectedStarts(runsOf([[0, 'C'], [4, 'G:maj'], [6, 'G'], [8, 'E:min']]));
  // G:maj -> G is NOT an expected change (the DOM text does not change there): no false miss.
  assert.deepEqual(exp.map((x) => [x.start, x.text]), [[4, 'G'], [8, 'Em']]);
  const a = pairChanges(exp, [ev('G', 4.02), ev('Em', 8.02)]);
  assert.deepEqual(a.rows.map((r) => [r.label, r.text]), [['G:maj', 'G'], ['E:min', 'Em']]);
  assert.deepEqual([a.misses.length, a.spurious.length, a.textMismatches.length], [0, 0, 0]);
});

test('extras that are not text mismatches: first chord at start, end-of-song dash, out of window', () => {
  const exp = expectedStarts(runsOf([[0, 'C'], [10, 'G']]));
  const a = pairChanges(exp, [ev('C', 0.01), ev('G', 10.02), ev('—', 30), ev('C', 40)]);
  assert.equal(a.rows.length, 1);
  assert.deepEqual(a.spurious, [0, 2, 3]);
  assert.equal(a.textMismatches.length, 0);
});
