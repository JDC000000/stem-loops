// Run: pnpm --filter web test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultTransition,
  buildTransition,
  loadTransition,
  DEFAULT_SELF_PROB,
  DEFAULT_DIATONIC_PROB,
  DEFAULT_UNRELATED_PROB,
} from '../transition.ts';
import { NUM_LABELS, labelIndex } from '../alphabet.ts';

test('default transition matrix has shape 60 x 60', () => {
  const T = defaultTransition();
  assert.ok(T instanceof Float32Array);
  assert.equal(T.length, NUM_LABELS * NUM_LABELS);
});

test('each row (exp) sums to ~1', () => {
  const T = defaultTransition();
  for (let i = 0; i < NUM_LABELS; i++) {
    let sum = 0;
    for (let j = 0; j < NUM_LABELS; j++) sum += Math.exp(T[i * NUM_LABELS + j]);
    assert.ok(Math.abs(sum - 1) < 1e-4, `row ${i} sum = ${sum}`);
  }
});

test('self-transition > every off-diagonal in each row', () => {
  const T = defaultTransition();
  for (let i = 0; i < NUM_LABELS; i++) {
    const self = T[i * NUM_LABELS + i];
    for (let j = 0; j < NUM_LABELS; j++) {
      if (j === i) continue;
      assert.ok(
        self > T[i * NUM_LABELS + j],
        `row ${i}: self (${self}) not > off-diag j=${j} (${T[i * NUM_LABELS + j]})`,
      );
    }
  }
});

test('diatonic transitions > unrelated transitions (semitone / tritone)', () => {
  const T = defaultTransition();
  const cMaj = labelIndex('C:maj');
  const gMaj = labelIndex('G:maj'); // interval 7 — diatonic
  const dMaj = labelIndex('D:maj'); // interval 2 — diatonic
  const fMaj = labelIndex('F:maj'); // interval 5 — diatonic
  const cSharpMaj = labelIndex('C#:maj'); // interval 1 — unrelated
  const fSharpMaj = labelIndex('F#:maj'); // interval 6 (tritone) — unrelated
  const bMaj = labelIndex('B:maj'); // interval 11 (maj 7th) — unrelated
  for (const diatonic of [gMaj, dMaj, fMaj]) {
    for (const unrelated of [cSharpMaj, fSharpMaj, bMaj]) {
      assert.ok(
        T[cMaj * NUM_LABELS + diatonic] > T[cMaj * NUM_LABELS + unrelated],
        `diatonic ${diatonic} not preferred over unrelated ${unrelated}`,
      );
    }
  }
});

test('same-root quality shifts are diatonic (C:maj -> C:min)', () => {
  // Interval 0 counts as diatonic by design — a chord changing quality on a
  // held root is a common move and should not be scored as "unrelated".
  const T = defaultTransition();
  const cMaj = labelIndex('C:maj');
  const cMin = labelIndex('C:min');
  const cSharpMaj = labelIndex('C#:maj'); // unrelated
  assert.ok(T[cMaj * NUM_LABELS + cMin] > T[cMaj * NUM_LABELS + cSharpMaj]);
});

test('ratio of diatonic : unrelated matches the prior ratio', () => {
  const T = defaultTransition();
  const cMaj = labelIndex('C:maj');
  const gMaj = labelIndex('G:maj'); // diatonic (interval 7)
  const cSharpMaj = labelIndex('C#:maj'); // unrelated (interval 1)
  const diatonicP = Math.exp(T[cMaj * NUM_LABELS + gMaj]);
  const unrelatedP = Math.exp(T[cMaj * NUM_LABELS + cSharpMaj]);
  const expected = DEFAULT_DIATONIC_PROB / DEFAULT_UNRELATED_PROB; // 10
  const actual = diatonicP / unrelatedP;
  assert.ok(Math.abs(actual - expected) < 1e-2, `ratio ${actual} != ${expected}`);
});

test('buildTransition respects selfProb override', () => {
  const T = buildTransition({ selfProb: 0.5 });
  // After row normalisation, self prob should be a larger share when selfProb
  // was 0.95 than when it is 0.5.
  const hi = buildTransition({ selfProb: 0.95 });
  const idx = 0;
  const selfHi = Math.exp(hi[idx * NUM_LABELS + idx]);
  const selfLo = Math.exp(T[idx * NUM_LABELS + idx]);
  assert.ok(selfHi > selfLo, `self prob at 0.95 (${selfHi}) must exceed self at 0.5 (${selfLo})`);
});

test('DEFAULT_* priors are the documented values', () => {
  assert.equal(DEFAULT_SELF_PROB, 0.95);
  assert.equal(DEFAULT_DIATONIC_PROB, 0.01);
  assert.equal(DEFAULT_UNRELATED_PROB, 0.001);
});

test('defaultTransition returns a fresh copy each call', () => {
  const a = defaultTransition();
  const b = defaultTransition();
  assert.notStrictEqual(a, b, 'should be distinct buffers');
  a[0] = 999;
  assert.notEqual(b[0], 999, 'mutating one must not affect the other');
});

test('loadTransition falls back to defaultTransition on failure', async () => {
  const T = await loadTransition('http://127.0.0.1:1/does-not-exist.bin');
  assert.equal(T.length, NUM_LABELS * NUM_LABELS);
  // Fall-back should be numerically identical to the default.
  const D = defaultTransition();
  for (let i = 0; i < 10; i++) assert.ok(Math.abs(T[i] - D[i]) < 1e-6);
});
