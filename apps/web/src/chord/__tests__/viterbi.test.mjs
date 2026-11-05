<<<<<<< HEAD
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
=======
// Run: pnpm --filter web test   (node >= 22.6, built-in type stripping + test runner)
//
// Viterbi decoder tests. Pure math — no fixtures, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viterbi } from '../viterbi.ts';

const LOG = Math.log;

/** Helper: build a flat (nFrames * nStates) logits array from a nested array. */
function flat(rows) {
  const n = rows.length;
  const s = rows[0].length;
  const out = new Float32Array(n * s);
  for (let t = 0; t < n; t++) for (let j = 0; j < s; j++) out[t * s + j] = rows[t][j];
  return out;
}

/** Helper: build a flat (S * S) transition matrix from a 2D array of probs. */
function trans(rows) {
  const s = rows.length;
  const out = new Float32Array(s * s);
  for (let i = 0; i < s; i++) for (let j = 0; j < s; j++) out[i * s + j] = rows[i][j];
  return out;
}

test('empty/zero inputs return empty path and zero score', () => {
  const r = viterbi({
    logits: new Float32Array(0),
    nFrames: 0,
    nStates: 3,
    transition: new Float32Array(9),
  });
  assert.equal(r.path.length, 0);
  assert.equal(r.score, 0);
});

test('1-state trivial: path is always [0, 0, ..., 0]', () => {
  const n = 7;
  const r = viterbi({
    logits: new Float32Array(n), // all zeros = log(1)
    nFrames: n,
    nStates: 1,
    transition: new Float32Array([0]), // log(1)
  });
  assert.equal(r.path.length, n);
  for (let i = 0; i < n; i++) assert.equal(r.path[i], 0);
  assert.ok(Number.isFinite(r.score));
});

test('2-state: strong self-transition keeps the path pinned to state 0', () => {
  // Emissions are flat; transitions strongly prefer self.
  const T = trans([
    [LOG(0.99), LOG(0.01)],
    [LOG(0.01), LOG(0.99)],
  ]);
  const start = new Float32Array([LOG(0.99), LOG(0.01)]); // start biased to state 0
  const r = viterbi({
    logits: flat([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]),
    nFrames: 5,
    nStates: 2,
    transition: T,
    startProb: start,
  });
  assert.deepEqual(Array.from(r.path), [0, 0, 0, 0, 0]);
});

test('2-state: strong forward-transition drives the path to switch', () => {
  // Emissions flat and uniform; transitions strongly prefer 0 -> 1 and 1 -> 1.
  // Starting state is 0 (via start prior); one step later we should be in 1.
  const T = trans([
    [LOG(0.01), LOG(0.99)],
    [LOG(0.01), LOG(0.99)],
  ]);
  const start = new Float32Array([LOG(0.99), LOG(0.01)]);
  const r = viterbi({
    logits: flat([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]),
    nFrames: 4,
    nStates: 2,
    transition: T,
    startProb: start,
  });
  assert.equal(r.path[0], 0);
  for (let i = 1; i < 4; i++) assert.equal(r.path[i], 1);
});

test('known-answer 4-frame x 3-state problem (hand-computed)', () => {
  // Hand-computed. States {0,1,2}, uniform start.
  // Emissions:
  //   t=0: [0.6, 0.3, 0.1]
  //   t=1: [0.1, 0.7, 0.2]
  //   t=2: [0.2, 0.1, 0.7]
  //   t=3: [0.7, 0.2, 0.1]
  // Transition (rows = from, cols = to):
  //   [0.7 0.2 0.1]
  //   [0.1 0.7 0.2]
  //   [0.2 0.1 0.7]
  //
  // Walking the DP by hand, best path = [1, 1, 2, 0]:
  //   - starting in state 1 at t=0 is cheaper than starting in state 0 THEN
  //     paying the 0->1 transition cost at t=1, because the per-frame argmax
  //     switches (0,1,2,0) and the transitions are self-favouring.
  //   - path score (log-prob):
  //       log(1/3) + log(0.3)                 // start + e[0,1]
  //     + log(0.7) + log(0.7)                 // T[1->1] + e[1,1]
  //     + log(0.2) + log(0.7)                 // T[1->2] + e[2,2]
  //     + log(0.2) + log(0.7)                 // T[2->0] + e[3,0]
  //     = log(1/3) + log(0.3) + 4*log(0.7) + 2*log(0.2)
  //     ~ -6.948
  //   The competing path [0,1,2,0] costs log(0.6)+log(0.2)+log(0.7)+log(0.2)+log(0.7)+log(0.2)+log(0.7) + log(1/3) ~ -7.508.
  const E = flat([
    [LOG(0.6), LOG(0.3), LOG(0.1)],
    [LOG(0.1), LOG(0.7), LOG(0.2)],
    [LOG(0.2), LOG(0.1), LOG(0.7)],
    [LOG(0.7), LOG(0.2), LOG(0.1)],
  ]);
  const T = trans([
    [LOG(0.7), LOG(0.2), LOG(0.1)],
    [LOG(0.1), LOG(0.7), LOG(0.2)],
    [LOG(0.2), LOG(0.1), LOG(0.7)],
  ]);
  const r = viterbi({ logits: E, nFrames: 4, nStates: 3, transition: T });
  assert.deepEqual(Array.from(r.path), [1, 1, 2, 0]);
  const expected = LOG(1 / 3) + LOG(0.3) + 4 * LOG(0.7) + 2 * LOG(0.2);
  assert.ok(Math.abs(r.score - expected) < 1e-4, `score ${r.score} != expected ${expected}`);
});

test('1000-frame random logits produce no NaN/Inf and a valid path', () => {
  const T = 1000;
  const S = 10;
  // Deterministic PRNG for reproducibility.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const logits = new Float32Array(T * S);
  for (let i = 0; i < logits.length; i++) logits[i] = LOG(rand() + 1e-3);
  // A nearly-uniform transition matrix (log-probs, each row sums to 1).
  const transition = new Float32Array(S * S);
  for (let i = 0; i < S; i++) {
    const row = new Array(S);
    let sum = 0;
    for (let j = 0; j < S; j++) {
      row[j] = rand() + 1e-3;
      sum += row[j];
    }
    for (let j = 0; j < S; j++) transition[i * S + j] = LOG(row[j] / sum);
  }
  const r = viterbi({ logits, nFrames: T, nStates: S, transition });
  assert.equal(r.path.length, T);
  for (let t = 0; t < T; t++) {
    assert.ok(r.path[t] >= 0 && r.path[t] < S, `path[${t}] = ${r.path[t]} out of range`);
  }
  assert.ok(Number.isFinite(r.score), `score should be finite, got ${r.score}`);
  assert.ok(!Number.isNaN(r.score));
});

test('throws on shape mismatches', () => {
  assert.throws(
    () =>
      viterbi({
        logits: new Float32Array(10),
        nFrames: 3,
        nStates: 3,
        transition: new Float32Array(9),
      }),
    /logits length/,
  );
  assert.throws(
    () =>
      viterbi({
        logits: new Float32Array(9),
        nFrames: 3,
        nStates: 3,
        transition: new Float32Array(10),
      }),
    /transition length/,
  );
  assert.throws(
    () =>
      viterbi({
        logits: new Float32Array(9),
        nFrames: 3,
        nStates: 3,
        transition: new Float32Array(9),
        startProb: new Float32Array(2),
      }),
    /startProb length/,
  );
});
>>>>>>> origin/v3/main
