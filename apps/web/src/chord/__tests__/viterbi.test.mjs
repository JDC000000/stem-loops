import { test } from 'node:test';
import assert from 'node:assert/strict';

import { N_CHORD_CLASSES } from '../alphabet.ts';
import { collapseRuns } from '../smoother.ts';
import { smoothChordSequence } from '../viterbi.ts';

test('smoothChordSequence: empty input returns []', () => {
  const r = smoothChordSequence(new Float32Array(0), 0);
  assert.deepEqual(r, []);
});

test('smoothChordSequence: pointed logits pick the pointed class', () => {
  const T = 3;
  const N = N_CHORD_CLASSES;
  const logits = new Float32Array(T * N);
  // Favour class 7 strongly at every frame.
  for (let t = 0; t < T; t++) logits[t * N + 7] = 100;
  const seq = smoothChordSequence(logits, T);
  assert.equal(seq.length, 3);
  assert.deepEqual(
    seq.map((f) => f.cls),
    [7, 7, 7],
  );
  assert.deepEqual(
    seq.map((f) => f.frame),
    [0, 1, 2],
  );
});

test('smoothChordSequence: length mismatch throws', () => {
  assert.throws(
    () => smoothChordSequence(new Float32Array(5), 2),
    /logits length/,
  );
});

test('smoothChordSequence: self-loop bias prevents 1-frame flips', () => {
  const T = 5;
  const N = N_CHORD_CLASSES;
  const logits = new Float32Array(T * N);
  // Class 0 wins at t=0,1,3,4 by a lot. At t=2, class 1 wins by only 0.5.
  for (let t = 0; t < T; t++) {
    logits[t * N + 0] = 10;
    if (t === 2) logits[t * N + 1] = 10.5;
  }
  const seq = smoothChordSequence(logits, T);
  // With a self-loop bias of log(10) ≈ 2.3, staying in class 0 across t=2
  // scores higher than switching to class 1 for one frame.
  assert.deepEqual(
    seq.map((f) => f.cls),
    [0, 0, 0, 0, 0],
  );
});

test('collapseRuns: groups contiguous same-class frames', () => {
  const seq = [
    { cls: 0, frame: 0, logProb: 0 },
    { cls: 0, frame: 1, logProb: 0 },
    { cls: 1, frame: 2, logProb: 0 },
    { cls: 1, frame: 3, logProb: 0 },
    { cls: 2, frame: 4, logProb: 0 },
  ];
  const runs = collapseRuns(seq);
  assert.deepEqual(runs, [
    { cls: 0, startFrame: 0, endFrame: 2 },
    { cls: 1, startFrame: 2, endFrame: 4 },
    { cls: 2, startFrame: 4, endFrame: 5 },
  ]);
});

test('collapseRuns: empty input returns []', () => {
  assert.deepEqual(collapseRuns([]), []);
});
