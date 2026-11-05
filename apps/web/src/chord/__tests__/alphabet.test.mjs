import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHORD_QUALITIES,
  CHORD_ROOTS,
  N_CHORD_CLASSES,
  chordLabel,
  nearestChords,
} from '../alphabet.ts';

test('alphabet: 12 roots × 5 qualities = 60 classes', () => {
  assert.equal(CHORD_ROOTS.length, 12);
  assert.equal(CHORD_QUALITIES.length, 5);
  assert.equal(N_CHORD_CLASSES, 60);
});

test('chordLabel: idx 0 is C:maj, idx N-1 is B:min7', () => {
  assert.equal(chordLabel(0), 'C:maj');
  assert.equal(chordLabel(1), 'C:min');
  assert.equal(chordLabel(5), 'C#:maj');
  assert.equal(chordLabel(N_CHORD_CLASSES - 1), 'B:min7');
});

test('chordLabel: out-of-range throws', () => {
  assert.throws(() => chordLabel(-1), RangeError);
  assert.throws(() => chordLabel(N_CHORD_CLASSES), RangeError);
  assert.throws(() => chordLabel(1.5), RangeError);
});

test('nearestChords: returns k distinct indices not equal to self', () => {
  const alts = nearestChords(0, 10);
  assert.equal(alts.length, 10);
  assert.equal(new Set(alts).size, 10);
  assert.ok(!alts.includes(0));
});

test('nearestChords: top result shares root when possible', () => {
  // idx 0 = C:maj. The nearest alternative should be another C-root quality.
  const alts = nearestChords(0, 4);
  // Same root (C = 0..4) should come first by circle-of-roots distance.
  for (const cls of alts.slice(0, 4)) {
    assert.ok(cls >= 0 && cls < 5, `expected C-root alt, got idx ${cls}`);
  }
});
