// Tests for the codegen-emitted apps/web/src/chord/alphabet.ts.
//
// Run: pnpm --filter web test
//
// This file is hand-written (NOT emitted by codegen_alphabet.py). It asserts
// both the shape of the generated TS mirror and that it stays in lockstep
// with the Python alphabet — the hardcoded ALPHABET_SHA below is the single
// value the Python module (apps/training/model/alphabet.py, PR-Y1.4b) emits
// today. If that SHA changes, Python and TS must both change together and
// this constant must be updated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHABET_SHA,
  ALPHABET_VERSION,
  ROOTS,
  QUALITY_LABELS,
  BASS_LABELS,
  QUALITIES,
  labels,
  N_ROOT,
  N_QUALITY,
  N_BASS,
  QUALITY_N_INDEX,
  BASS_SAME_INDEX,
  BASS_N_INDEX,
  NUM_CHORD_LABELS,
  NUM_LABELS,
  LEGACY_N_INDEX,
  LEGACY_X_INDEX,
  encodeFactored,
  decodeFactored,
  isValidHarte,
  canonicalRoot,
  labelIndex,
  labelAt,
  AlphabetDriftError,
  assertAlphabetSha,
} from '../alphabet.ts';

// The canonical SHA pinned by Python alphabet.py in PR-Y1.4b. Any change here
// MUST be mirrored in apps/training/model/alphabet.py and re-emitted via
// `python scripts/codegen_alphabet.py`.
const EXPECTED_ALPHABET_SHA =
  'ffa3e7f03c6722f83951694762b247b79e72846f3740b31ca803a7ad37e44b49';

// ---------------------------------------------------------------------------
// Alphabet shape
// ---------------------------------------------------------------------------

test('ALPHABET_SHA matches the Python canonical value', () => {
  assert.equal(ALPHABET_SHA, EXPECTED_ALPHABET_SHA);
  assert.equal(ALPHABET_VERSION, 'y1-v1.5-factored');
});

test('factored alphabet sizes match decision record v1.5', () => {
  assert.equal(N_ROOT, 12);
  assert.equal(N_QUALITY, 25);
  assert.equal(N_BASS, 13);
  assert.equal(ROOTS.length, N_ROOT);
  assert.equal(QUALITY_LABELS.length, N_QUALITY);
  assert.equal(BASS_LABELS.length, N_BASS);
});

test('roots are the 12 chromatic pitch classes in semitone order', () => {
  const expected = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  for (let i = 0; i < expected.length; i++) {
    assert.equal(ROOTS[i], expected[i]);
  }
});

test('quality labels have correct index positions', () => {
  // Canonical ordering pinned in alphabet.py v1.5.
  const expectedQualities = {
    maj: 0,
    min: 1,
    dim: 2,
    aug: 3,
    sus2: 4,
    sus4: 5,
    maj6: 6,
    min6: 7,
    maj7: 8,
    min7: 9,
    7: 10,
    dim7: 11,
    hdim7: 12,
    minmaj7: 13,
    maj9: 14,
    min9: 15,
    9: 16,
    11: 17,
    13: 18,
    add9: 19,
    add11: 20,
    5: 21,
    add6: 22,
    aug7: 23,
    N: 24,
  };
  for (const [label, idx] of Object.entries(expectedQualities)) {
    assert.equal(
      QUALITY_LABELS[idx],
      label,
      `QUALITY_LABELS[${idx}] expected ${label}, got ${QUALITY_LABELS[idx]}`,
    );
  }
  assert.equal(QUALITY_N_INDEX, 24);
});

test('bass labels have correct index positions', () => {
  assert.equal(BASS_LABELS[0], 'same');
  for (let i = 1; i <= 11; i++) {
    assert.equal(BASS_LABELS[i], String(i));
  }
  assert.equal(BASS_LABELS[12], 'N');
  assert.equal(BASS_SAME_INDEX, 0);
  assert.equal(BASS_N_INDEX, 12);
});

test('legacy flat-60 alphabet is preserved for smoother/viterbi compat', () => {
  assert.equal(QUALITIES.length, 5);
  assert.deepEqual([...QUALITIES], ['maj', 'min', 'dim', 'aug', 'sus']);
  assert.equal(NUM_CHORD_LABELS, 60);
  // labels[] holds the 62-slot legacy flat list: 60 chord labels + N + X.
  assert.equal(labels.length, 62);
  // The exported NUM_LABELS is the chord-label count for PR-Y1.5a's smoother,
  // which never indexes N/X through this constant.
  assert.equal(NUM_LABELS, 60);
  assert.equal(labels[0], 'C:maj');
  assert.equal(labels[59], 'B:sus');
  assert.equal(labels[LEGACY_N_INDEX], 'N');
  assert.equal(labels[LEGACY_X_INDEX], 'X');
});

// ---------------------------------------------------------------------------
// Factored encode / decode — the task spec's load-bearing cases
// ---------------------------------------------------------------------------

test('encodeFactored("C:maj") → {root:0, quality:0, bass:0}', () => {
  assert.deepEqual(encodeFactored('C:maj'), { root: 0, quality: 0, bass: 0 });
});

test('encodeFactored("C:7") → {root:0, quality:10, bass:0}', () => {
  assert.deepEqual(encodeFactored('C:7'), { root: 0, quality: 10, bass: 0 });
});

test('encodeFactored("C:maj/5") → {root:0, quality:0, bass:7}', () => {
  // Harte interval "5" = perfect fifth = 7 semitones above root.
  assert.deepEqual(encodeFactored('C:maj/5'), { root: 0, quality: 0, bass: 7 });
});

test('encodeFactored("N") → N-slot tuple', () => {
  assert.deepEqual(encodeFactored('N'), {
    root: 0,
    quality: QUALITY_N_INDEX,
    bass: BASS_N_INDEX,
  });
});

test('encodeFactored("X") → null (caller marks out-of-vocab)', () => {
  assert.equal(encodeFactored('X'), null);
});

test('encodeFactored("garbage") → null', () => {
  assert.equal(encodeFactored('garbage'), null);
  assert.equal(encodeFactored(''), null);
  assert.equal(encodeFactored('H:maj'), null); // German H — not a letter in NAT_PC
  assert.equal(encodeFactored('C:unknown_quality'), null);
});

test('encodeFactored handles bare roots as "maj"', () => {
  assert.deepEqual(encodeFactored('C'), { root: 0, quality: 0, bass: 0 });
  assert.deepEqual(encodeFactored('G'), { root: 7, quality: 0, bass: 0 });
});

test('encodeFactored handles every supported quality shorthand', () => {
  // Non-N quality slots — 24 of them.
  for (let q = 0; q < QUALITY_N_INDEX; q++) {
    const label = QUALITY_LABELS[q];
    const encoded = encodeFactored(`C:${label}`);
    assert.notEqual(encoded, null, `shorthand "C:${label}" failed to encode`);
    assert.equal(encoded.root, 0);
    assert.equal(encoded.quality, q);
    assert.equal(encoded.bass, 0);
  }
});

test('encodeFactored handles all 12 slash basses correctly', () => {
  // Harte "1" is unison (0 semitones, collapses to BASS_SAME_INDEX).
  assert.equal(encodeFactored('C:maj/1')?.bass, BASS_SAME_INDEX);
  // Harte degree → semitone table from Python _DEG_SEMITONES.
  const expected = {
    2: 2,
    b3: 3,
    3: 4,
    4: 5,
    b5: 6,
    5: 7,
    b6: 8,
    6: 9,
    b7: 10,
    7: 11,
  };
  for (const [tok, semis] of Object.entries(expected)) {
    const encoded = encodeFactored(`C:maj/${tok}`);
    assert.equal(
      encoded?.bass,
      semis,
      `slash /${tok} expected bass=${semis}, got ${encoded?.bass}`,
    );
  }
});

test('encodeFactored handles maj(9) → add9, maj(11) → add11', () => {
  assert.deepEqual(encodeFactored('C:maj(9)'), {
    root: 0,
    quality: QUALITY_LABELS.indexOf('add9'),
    bass: 0,
  });
  assert.deepEqual(encodeFactored('C:maj(11)'), {
    root: 0,
    quality: QUALITY_LABELS.indexOf('add11'),
    bass: 0,
  });
  // maj(9) is also written as maj(add9).
  assert.deepEqual(encodeFactored('C:maj(add9)'), encodeFactored('C:maj(9)'));
});

test('encodeFactored handles 7 with any parens as plain 7 (lossy)', () => {
  // 7(b9), 7(#9), 7(#11), 7(b13) all collapse onto plain 7.
  assert.equal(encodeFactored('C:7(b9)')?.quality, 10);
  assert.equal(encodeFactored('C:7(#11)')?.quality, 10);
});

test('encodeFactored accepts flat-spelled roots (Cbb, F##)', () => {
  // Bb is A# in sharps. B is root-pc 11, flat moves to 10, so Bb pc=10.
  // ROOTS.indexOf("A#") === 10.
  assert.equal(encodeFactored('Bb:maj')?.root, 10);
  // Cb is B (pc 11).
  assert.equal(encodeFactored('Cb:maj')?.root, 11);
  // F## is G (pc 7).
  assert.equal(encodeFactored('F##:maj')?.root, 7);
  // Cbb is Bb (pc 10).
  assert.equal(encodeFactored('Cbb:maj')?.root, 10);
});

// ---------------------------------------------------------------------------
// Decode and round-trip
// ---------------------------------------------------------------------------

test('decodeFactored(0,0,0) → "C:maj"', () => {
  assert.equal(decodeFactored(0, 0, 0), 'C:maj');
});

test('decodeFactored(N-quality) → "N" regardless of root/bass', () => {
  assert.equal(decodeFactored(0, QUALITY_N_INDEX, BASS_N_INDEX), 'N');
  assert.equal(decodeFactored(5, QUALITY_N_INDEX, 0), 'N');
});

test('decodeFactored for slash chords uses Harte interval names', () => {
  assert.equal(decodeFactored(0, 0, 7), 'C:maj/5');
  assert.equal(decodeFactored(0, 10, 10), 'C:7/b7');
  assert.equal(decodeFactored(0, 1, 3), 'C:min/b3');
});

test('decodeFactored throws on out-of-range indices', () => {
  assert.throws(() => decodeFactored(-1, 0, 0), RangeError);
  assert.throws(() => decodeFactored(12, 0, 0), RangeError);
  assert.throws(() => decodeFactored(0, -1, 0), RangeError);
  assert.throws(() => decodeFactored(0, 25, 0), RangeError);
  assert.throws(() => decodeFactored(0, 0, -1), RangeError);
  assert.throws(() => decodeFactored(0, 0, 13), RangeError);
  assert.throws(() => decodeFactored(1.5, 0, 0), RangeError);
});

test('round-trip: every decoded canonical label round-trips through encode', () => {
  // All 24 non-N qualities × 12 roots × {same-bass, bass=5}.
  let roundTripped = 0;
  for (let r = 0; r < N_ROOT; r++) {
    for (let q = 0; q < QUALITY_N_INDEX; q++) {
      for (const bass of [BASS_SAME_INDEX, 5, 7]) {
        const label = decodeFactored(r, q, bass);
        const re = encodeFactored(label);
        assert.notEqual(re, null, `round-trip null for (${r},${q},${bass}) label=${label}`);
        assert.equal(re.root, r, `root drift on round-trip of ${label}`);
        assert.equal(re.quality, q, `quality drift on round-trip of ${label}`);
        assert.equal(re.bass, bass, `bass drift on round-trip of ${label}`);
        roundTripped += 1;
      }
    }
  }
  assert.equal(roundTripped, N_ROOT * 24 * 3);
});

test('round-trip: N decodes to "N" and re-encodes to the N-slot tuple', () => {
  const nLabel = decodeFactored(0, QUALITY_N_INDEX, BASS_N_INDEX);
  assert.equal(nLabel, 'N');
  assert.deepEqual(encodeFactored(nLabel), {
    root: 0,
    quality: QUALITY_N_INDEX,
    bass: BASS_N_INDEX,
  });
});

// ---------------------------------------------------------------------------
// isValidHarte
// ---------------------------------------------------------------------------

test('isValidHarte accepts the N / X sentinels', () => {
  assert.equal(isValidHarte('N'), true);
  assert.equal(isValidHarte('X'), true);
});

test('isValidHarte accepts every canonical factored label', () => {
  for (let r = 0; r < N_ROOT; r++) {
    for (let q = 0; q < QUALITY_N_INDEX; q++) {
      for (const bass of [BASS_SAME_INDEX, 3, 7, 11]) {
        const label = decodeFactored(r, q, bass);
        assert.equal(isValidHarte(label), true, `isValidHarte rejected ${label}`);
      }
    }
  }
});

test('isValidHarte rejects malformed input', () => {
  assert.equal(isValidHarte(''), false);
  assert.equal(isValidHarte('garbage'), false);
  assert.equal(isValidHarte('H:maj'), false);
  // @ts-expect-error — non-string
  assert.equal(isValidHarte(123), false);
  // @ts-expect-error — null
  assert.equal(isValidHarte(null), false);
});

// ---------------------------------------------------------------------------
// Legacy flat-60 API (preserved for smoother/viterbi callers)
// ---------------------------------------------------------------------------

test('canonicalRoot maps flats to sharps and rejects garbage', () => {
  assert.equal(canonicalRoot('C'), 'C');
  assert.equal(canonicalRoot('C#'), 'C#');
  assert.equal(canonicalRoot('Db'), 'C#');
  assert.equal(canonicalRoot('Bb'), 'A#');
  assert.equal(canonicalRoot('H'), null);
  assert.equal(canonicalRoot(''), null);
});

test('labelIndex handles the 60 legacy flat labels', () => {
  assert.equal(labelIndex('C:maj'), 0);
  assert.equal(labelIndex('C:sus'), 4);
  assert.equal(labelIndex('B:sus'), 59);
  // Flat spellings resolve to their sharp sibling.
  assert.equal(labelIndex('Bb:maj'), labelIndex('A#:maj'));
  // N, X, unknown return -1 (they sit outside the chord range).
  assert.equal(labelIndex('N'), -1);
  assert.equal(labelIndex('X'), -1);
  assert.equal(labelIndex(''), -1);
  assert.equal(labelIndex('C:unknown'), -1);
});

test('labelAt returns the legacy label at index, throws on OOB', () => {
  assert.equal(labelAt(0), 'C:maj');
  assert.equal(labelAt(59), 'B:sus');
  assert.throws(() => labelAt(-1), RangeError);
  assert.throws(() => labelAt(60), RangeError);
  assert.throws(() => labelAt(1.5), RangeError);
});

// ---------------------------------------------------------------------------
// Runtime SHA assertion (AlphabetDriftError)
// ---------------------------------------------------------------------------

test('assertAlphabetSha accepts a matching fixture', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      alphabet_version: ALPHABET_VERSION,
      alphabet_sha: ALPHABET_SHA,
    }),
  });
  await assertAlphabetSha(fakeFetch, '/alphabet.v1.5.json');
});

test('assertAlphabetSha throws AlphabetDriftError on SHA mismatch', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      alphabet_version: ALPHABET_VERSION,
      alphabet_sha: '0'.repeat(64),
    }),
  });
  await assert.rejects(() => assertAlphabetSha(fakeFetch), AlphabetDriftError);
});

test('assertAlphabetSha throws on a non-200 fixture response', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  });
  await assert.rejects(() => assertAlphabetSha(fakeFetch), AlphabetDriftError);
});

test('assertAlphabetSha throws on a malformed fixture body', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ bogus: true }),
  });
  await assert.rejects(() => assertAlphabetSha(fakeFetch), AlphabetDriftError);
});

test('assertAlphabetSha wraps a fetch exception as AlphabetDriftError', async () => {
  const fakeFetch = async () => {
    throw new Error('network down');
  };
  await assert.rejects(() => assertAlphabetSha(fakeFetch), AlphabetDriftError);
});
