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

test('first chord at song start: a plain extra (no clock candidate), not a text mismatch', () => {
  const exp = expectedStarts(runsOf([[0, 'C'], [10, 'G']]));
  const a = pairChanges(exp, [ev('C', 0.01)]);
  assert.deepEqual([a.rows.length, a.spurious.length, a.textMismatches.length, a.misses.length], [0, 1, 0, 1]);
});

test('end-of-song dash with an UNPAIRED clock candidate: an extra, never a text mismatch', () => {
  const exp = expectedStarts(runsOf([[0, 'C'], [10, 'G']]));
  // G was never shown; the dash appears 0.5 s after G's start, so G is a live clock candidate.
  const a = pairChanges(exp, [ev('—', 10.5)]);
  assert.deepEqual(a.spurious, [0]);
  assert.equal(a.textMismatches.length, 0);
  assert.deepEqual(a.misses.map((m) => m.text), ['G']);
  // A real wrong chord at the same moment IS a mismatch (the exclusion is the dash only).
  assert.equal(pairChanges(exp, [ev('D', 10.5)]).textMismatches.length, 1);
});

test('the clock window: a right-text change shown > 2 s late is a miss + plain extra; windowMs is honoured', () => {
  const exp = expectedStarts(runsOf([[0, 'C'], [10, 'G']]));
  const late = pairChanges(exp, [ev('G', 12.5)]);
  assert.deepEqual([late.rows.length, late.spurious.length, late.misses.length, late.textMismatches.length], [0, 1, 1, 0]);
  const edge = pairChanges(exp, [ev('G', 11.99)]);
  assert.equal(edge.rows.length, 1);
  const wide = pairChanges(exp, [ev('G', 12.5)], { windowMs: 3000 });
  assert.deepEqual(wide.rows.map((r) => Math.round(r.lag_render)), [2500]);
});

test('pairing is in order: once a later change is paired, an earlier unpaired one cannot be', () => {
  const exp = expectedStarts(runsOf([[0, 'C'], [10, 'G'], [11, 'D']]));
  // G was skipped (the stage went straight to D); a stray "G" after that must not reach back to G's start.
  const a = pairChanges(exp, [ev('D', 11.02), ev('G', 11.5)]);
  assert.deepEqual(a.rows.map((r) => r.text), ['D']);
  assert.deepEqual(a.spurious, [1]);
  assert.deepEqual(a.misses.map((m) => m.text), ['G']);
  // And no expected change is paired twice.
  const b = pairChanges(exp, [ev('D', 11.02), ev('D', 11.3)]);
  assert.deepEqual([b.rows.length, b.spurious.length], [1, 1]);
});

test('route compensation: the shown position is rawPos - comp', () => {
  const exp = expectedStarts(runsOf([[0, 'C'], [10, 'G']]));
  // rawPos is past G's start, but the overlay draws rawPos - 50 ms, still before it: not a pair.
  const before = pairChanges(exp, [{ ...ev('G', 10.03), comp: 0.05 }]);
  assert.deepEqual([before.rows.length, before.spurious.length, before.misses.length], [0, 1, 1]);
  const after = pairChanges(exp, [{ ...ev('G', 10.08), comp: 0.05 }]);
  assert.deepEqual(after.rows.map((r) => [Math.round(r.lag_render), Math.round(r.comp_ms)]), [[80, 50]]);
});

test('the run keeps its loaded kind: a chord run the simplifier relabelled X draws "X", not "?"', () => {
  // As in the page (window.__display): leadSheetSymbol({ kind: run.kind, label }), kind from the LOADED label.
  const draw = (r) => leadSheetSymbol({ kind: r.kind, label: r.label });
  const runs = [{ startSec: 0, label: 'C', kind: 'chord' }, { startSec: 5, label: 'X', kind: 'chord' }, { startSec: 9, label: 'X', kind: 'unknown' }];
  const exp = expectedStarts(runs.map((r) => ({ ...r, text: draw(r) })));
  assert.deepEqual(exp.map((x) => x.text), ['X', '?']);
  const a = pairChanges(exp, [ev('X', 5.02), ev('?', 9.02)]);
  assert.deepEqual([a.rows.length, a.textMismatches.length], [2, 0]);
});
