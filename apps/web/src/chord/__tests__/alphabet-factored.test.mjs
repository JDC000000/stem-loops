// Run: pnpm --filter web test
// Parity of the generated factored alphabet against ground truth computed by
// alphabet.py (fixtures/alphabet-parity.json, written by `make alphabet-generate`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALPHABET_SHA,
  assertAlphabetSha,
  encodeFactored,
  decodeFactored,
  ROOTS,
  NUM_ROOTS,
  ROOT_N_INDEX,
  QUALITY_LABELS,
  N_QUALITY,
  QUALITY_N_INDEX,
  BASS_LABELS,
  N_BASS,
  BASS_SAME_INDEX,
  BASS_N_INDEX,
  QUALITIES,
  labelIndex,
} from '../alphabet.ts';

const fx = JSON.parse(
  readFileSync(new URL('./fixtures/alphabet-parity.json', import.meta.url), 'utf8'),
);

test('shape constants match the factored scheme', () => {
  assert.equal(NUM_ROOTS, 12);
  assert.equal(ROOT_N_INDEX, 12);
  assert.equal(ROOTS.length, 12);
  assert.equal(N_QUALITY, 25);
  assert.equal(QUALITY_LABELS.length, 25);
  assert.equal(QUALITY_LABELS[QUALITY_N_INDEX], 'N');
  assert.equal(N_BASS, 13);
  assert.equal(BASS_LABELS.length, 13);
  assert.equal(BASS_SAME_INDEX, 0);
  assert.equal(BASS_N_INDEX, 12);
  for (const q of QUALITIES) assert.ok(QUALITY_LABELS.includes(q), q);
});

test('embedded ALPHABET_SHA equals the Python value; assertAlphabetSha detects mismatch', () => {
  assert.match(ALPHABET_SHA, /^[0-9a-f]{64}$/);
  assert.equal(ALPHABET_SHA, fx.alphabet_sha);
  assert.doesNotThrow(() => assertAlphabetSha(ALPHABET_SHA));
  assert.throws(() => assertAlphabetSha('0'.repeat(64)), /alphabet mismatch/);
});

test('encodeFactored matches Python for every fixture input', () => {
  const entries = Object.entries(fx.encode);
  assert.ok(entries.length >= 90);
  for (const [input, expected] of entries) {
    assert.deepEqual(encodeFactored(input), expected, JSON.stringify(input));
  }
});

test('decodeFactored matches Python for the full 13x25x13 grid (incl. errors)', () => {
  assert.equal(fx.decode.length, 13 * 25 * 13);
  for (const [r, q, b, expected] of fx.decode) {
    if (expected === null) {
      assert.throws(() => decodeFactored(r, q, b), RangeError, `${r},${q},${b}`);
    } else {
      assert.equal(decodeFactored(r, q, b), expected, `${r},${q},${b}`);
    }
  }
});

test('real Klangio tokens that the flat 60 could not carry now land', () => {
  assert.deepEqual(encodeFactored('E:min7'), [4, QUALITY_LABELS.indexOf('min7'), 0]);
  assert.deepEqual(encodeFactored('A:7'), [9, QUALITY_LABELS.indexOf('7'), 0]);
  // slash chord: G:7/5 -> bass 7 semitones above root
  assert.deepEqual(encodeFactored('G:7/5'), [7, QUALITY_LABELS.indexOf('7'), 7]);
  // dim/sus4/hdim7/maj9/add9 have a slot in the factored head, none in the flat 60
  for (const l of ['C:dim', 'C:sus4', 'C:hdim7', 'C:maj9', 'C:add9']) {
    assert.equal(labelIndex(l), -1, l);
    assert.notEqual(encodeFactored(l), null, l);
  }
});

test('round-trip: decode(encode(x)) is identity on all 24 qualities x 12 roots', () => {
  for (let r = 0; r < 12; r++) {
    for (let q = 0; q < QUALITY_N_INDEX; q++) {
      const s = decodeFactored(r, q, 0);
      assert.deepEqual(encodeFactored(s), [r, q, 0], s);
    }
  }
});

test('N and X', () => {
  assert.deepEqual(encodeFactored('N'), [ROOT_N_INDEX, QUALITY_N_INDEX, BASS_N_INDEX]);
  assert.equal(encodeFactored('X'), null);
  assert.equal(decodeFactored(ROOT_N_INDEX, QUALITY_N_INDEX, BASS_N_INDEX), 'N');
});
