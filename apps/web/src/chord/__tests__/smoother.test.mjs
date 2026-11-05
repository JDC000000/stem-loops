// Run: pnpm --filter web test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoothChordSequence } from '../smoother.ts';

test('empty input returns empty output', () => {
  assert.deepEqual(smoothChordSequence([]), []);
});

test('confidences length mismatch throws', () => {
  assert.throws(
    () => smoothChordSequence(['C:maj', 'C:maj'], [1]),
    /confidences length/,
  );
});

test('uniform high-confidence sequence survives smoothing intact', () => {
  // High confidence throughout means the emission cost of any flip dwarfs
  // any transition gain — the raw sequence should pass through unchanged.
  const raw = ['C:maj', 'C:maj', 'G:maj', 'C:maj', 'C:maj'];
  const out = smoothChordSequence(raw);
  assert.deepEqual(out, raw);
});

test('low-confidence flip inside a stable run flattens to the surroundings', () => {
  // The G in the middle is marked low-confidence (0.3) and the surroundings
  // are confident C:maj. The music-theory prior (self > diatonic switch)
  // overrides and the G collapses back to C.
  const raw = ['C:maj', 'C:maj', 'G:maj', 'C:maj', 'C:maj'];
  const confidences = [1, 1, 0.3, 1, 1];
  const out = smoothChordSequence(raw, confidences);
  assert.deepEqual(out, ['C:maj', 'C:maj', 'C:maj', 'C:maj', 'C:maj']);
});

test('higher stickiness smooths more aggressively', () => {
  // With a very high self-prior, even a moderately confident single-frame
  // flip gets smoothed away.
  const raw = ['C:maj', 'C:maj', 'G:maj', 'C:maj', 'C:maj'];
  const conf = [1, 1, 0.7, 1, 1];
  const stickyLow = smoothChordSequence(raw, conf, 0.5);
  const stickyHi = smoothChordSequence(raw, conf, 0.999);
  // At 0.5 the sequence may still keep the G; at 0.999 it must not.
  assert.equal(stickyHi[2], 'C:maj');
  // Sanity: low stickiness keeps the G when confidence is reasonable.
  assert.equal(stickyLow[2], 'G:maj');
});

test('N and X labels pass through unchanged', () => {
  const raw = ['C:maj', 'N', 'C:maj', 'X', 'C:maj'];
  const out = smoothChordSequence(raw);
  assert.equal(out[0], 'C:maj');
  assert.equal(out[1], 'N');
  assert.equal(out[2], 'C:maj');
  assert.equal(out[3], 'X');
  assert.equal(out[4], 'C:maj');
});

test('output labels are all canonical Harte (sharps), even for flat inputs', () => {
  const raw = ['Bb:7', 'Bb:7', 'Bb:7'];
  const out = smoothChordSequence(raw);
  for (const l of out) assert.equal(l, 'A#:7');
});

test('a sustained run is kept, a one-frame excursion is dropped', () => {
  // A longer-form test: the chord changes in the middle for exactly one frame
  // with moderate confidence. Classic use case for H-3: Klangio sometimes
  // predicts a wrong chord on a single beat.
  const raw = [
    'C:maj', 'C:maj', 'C:maj', 'C:maj',
    'F:maj', // single-frame flip
    'C:maj', 'C:maj', 'C:maj', 'C:maj',
  ];
  const conf = [1, 1, 1, 1, 0.4, 1, 1, 1, 1];
  const out = smoothChordSequence(raw, conf);
  for (const l of out) assert.equal(l, 'C:maj');
});

test('a sustained change is preserved (no over-smoothing)', () => {
  // When the flip is held for several frames, Viterbi should accept it.
  const raw = [
    'C:maj', 'C:maj', 'C:maj',
    'F:maj', 'F:maj', 'F:maj', 'F:maj',
    'C:maj', 'C:maj',
  ];
  const out = smoothChordSequence(raw);
  assert.deepEqual(out.slice(0, 3), ['C:maj', 'C:maj', 'C:maj']);
  assert.deepEqual(out.slice(3, 7), ['F:maj', 'F:maj', 'F:maj', 'F:maj']);
  assert.deepEqual(out.slice(7), ['C:maj', 'C:maj']);
});

test('unknown labels are ignored (treated as uniform emission)', () => {
  // A single unknown label in the middle of a confident C run should not
  // derail the smoothed output — the transition prior takes over.
  const raw = ['C:maj', 'C:maj', 'XYZZY', 'C:maj', 'C:maj'];
  const out = smoothChordSequence(raw);
  // Surroundings held; middle was uniform, so Viterbi picks the self-
  // transition from C:maj.
  for (const l of out) assert.equal(l, 'C:maj');
});
