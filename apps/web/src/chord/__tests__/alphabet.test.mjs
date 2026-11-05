<<<<<<< HEAD
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
=======
// Run: pnpm --filter web test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  labels,
  labelIndex,
  labelAt,
  isValidHarte,
  canonicalRoot,
  NUM_LABELS,
  ROOTS,
  QUALITIES,
} from '../alphabet.ts';

test('alphabet is 60 labels and index order is roots x qualities', () => {
  assert.equal(NUM_LABELS, 60);
  assert.equal(labels.length, 60);
  assert.equal(labels[0], 'C:maj');
  assert.equal(labels[1], 'C:min');
  assert.equal(labels[4], 'C:min7');
  assert.equal(labels[5], 'C#:maj');
  assert.equal(labels[59], 'B:min7');
  // Index arithmetic: idx = root * 5 + quality
  for (let r = 0; r < ROOTS.length; r++) {
    for (let q = 0; q < QUALITIES.length; q++) {
      const expected = `${ROOTS[r]}:${QUALITIES[q]}`;
      assert.equal(labels[r * QUALITIES.length + q], expected);
    }
  }
});

test('labels array is frozen', () => {
  assert.throws(() => {
    // @ts-expect-error — testing immutability
    labels[0] = 'MUTATED';
  });
});

test('labelIndex round-trips for every canonical label', () => {
  for (let i = 0; i < NUM_LABELS; i++) {
    assert.equal(labelIndex(labels[i]), i);
    assert.equal(labelAt(i), labels[i]);
  }
});

test('labelIndex("C:maj") = 0, labelIndex("G:7") = 37', () => {
  // G is root index 7, quality "7" is index 2 → 7*5 + 2 = 37
  assert.equal(labelIndex('C:maj'), 0);
  assert.equal(labelIndex('G:7'), 37);
  assert.equal(labelIndex('A:min7'), 9 * 5 + 4);
  assert.equal(labelIndex('B:min7'), 59);
});

test('labelIndex accepts flat spellings via enharmonic normalisation', () => {
  assert.equal(labelIndex('Bb:7'), labelIndex('A#:7'));
  assert.equal(labelIndex('Db:maj'), labelIndex('C#:maj'));
  assert.equal(labelIndex('Eb:min'), labelIndex('D#:min'));
  assert.equal(labelIndex('Cb:maj'), labelIndex('B:maj'));
  assert.equal(labelIndex('E#:min7'), labelIndex('F:min7'));
});

test('labelIndex returns -1 for invalid, N, X, empty', () => {
  assert.equal(labelIndex(''), -1);
  assert.equal(labelIndex('N'), -1);
  assert.equal(labelIndex('X'), -1);
  assert.equal(labelIndex('C'), -1); // no colon, no quality
  assert.equal(labelIndex('C:'), -1); // empty quality
  assert.equal(labelIndex('C:9'), -1); // unsupported quality
  assert.equal(labelIndex('C:dim'), -1); // not in 60-label scheme
  assert.equal(labelIndex('H:maj'), -1); // German H — not a root letter
  assert.equal(labelIndex('C#b:maj'), -1); // malformed accidental
  assert.equal(labelIndex('C maj'), -1); // space, no colon
  // @ts-expect-error — defence against non-string input
  assert.equal(labelIndex(123), -1);
  // @ts-expect-error — defence against null
  assert.equal(labelIndex(null), -1);
});

test('isValidHarte accepts all 60 labels plus N and X', () => {
  for (const l of labels) assert.equal(isValidHarte(l), true, l);
  assert.equal(isValidHarte('N'), true);
  assert.equal(isValidHarte('X'), true);
  // Flat spellings also valid via enharmonic.
  assert.equal(isValidHarte('Bb:7'), true);
  // Invalid cases rejected.
  assert.equal(isValidHarte('C'), false);
  assert.equal(isValidHarte('n'), false); // case-sensitive
  assert.equal(isValidHarte('x'), false);
  assert.equal(isValidHarte('C:dim'), false);
  assert.equal(isValidHarte(''), false);
});

test('canonicalRoot maps flats to sharps and rejects garbage', () => {
  assert.equal(canonicalRoot('C'), 'C');
  assert.equal(canonicalRoot('C#'), 'C#');
  assert.equal(canonicalRoot('Db'), 'C#');
  assert.equal(canonicalRoot('Bb'), 'A#');
  assert.equal(canonicalRoot('H'), null);
  assert.equal(canonicalRoot('cb'), null); // lowercase
  assert.equal(canonicalRoot('C##'), null);
  assert.equal(canonicalRoot(''), null);
});

test('labelAt throws on out-of-range', () => {
  assert.throws(() => labelAt(-1), RangeError);
  assert.throws(() => labelAt(60), RangeError);
  assert.throws(() => labelAt(1.5), RangeError);
});
>>>>>>> origin/v3/main
