// Capo / transpose (Phase C, C4): the pure shift + spelling layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampTranspose, parseKey, spellingFor, transposeHarte, transposeLabel, transposeBadge, transposeSummary,
  readTranspose, writeTranspose, TRANSPOSE_KEY_PREFIX,
} from '../src/lib/play/transpose.ts';
import { spellChord } from '../src/lib/play/notation.ts';

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const pcOf = (n) => (SHARP.indexOf(n) >= 0 ? SHARP.indexOf(n) : FLAT.indexOf(n));

test('every semitone shift of every root, both spellings (12 roots x 13 shifts)', () => {
  for (let r = 0; r < 12; r++) {
    for (let t = -6; t <= 6; t++) {
      const want = (r + t + 12) % 12;
      assert.equal(transposeHarte(`${SHARP[r]}:maj`, t, 'sharp'), t === 0 ? `${SHARP[r]}:maj` : `${SHARP[want]}:maj`);
      assert.equal(transposeHarte(`${FLAT[r]}:min7`, t, 'flat'), t === 0 ? `${FLAT[r]}:min7` : `${FLAT[want]}:min7`);
    }
  }
  // +1 exactly (off-by-one guard): C -> C#, B -> C
  assert.equal(transposeHarte('C:maj', 1, 'sharp'), 'C#:maj');
  assert.equal(transposeHarte('B:maj', 1, 'sharp'), 'C:maj');
  assert.equal(transposeHarte('C:maj', -1, 'flat'), 'B:maj');
  assert.equal(transposeHarte('A:min', -2, 'sharp'), 'G:min');
});

test('12 keys x 12 roots: the spelling follows the new key (major and minor)', () => {
  // The new key's accidentals: flat keys spell flats, sharp keys spell sharps.
  const flatMajor = new Set([0, 1, 3, 5, 8, 10]);
  const flatMinor = new Set([0, 2, 3, 5, 7, 10]);
  for (let k = 0; k < 12; k++) {
    for (const minor of [false, true]) {
      const key = `${SHARP[k]} ${minor ? 'minor' : 'major'}`;
      for (let r = 0; r < 12; r++) {
        const out = transposeLabel(`${SHARP[r]}:maj`, 0, key);
        assert.equal(out, `${SHARP[r]}:maj`, 'zero shift is the identity');
      }
      for (const t of [-5, -2, 3, 6]) {
        const newPc = (k + t + 12) % 12;
        const flats = (minor ? flatMinor : flatMajor).has(newPc);
        assert.equal(spellingFor(key, t), flats ? 'flat' : 'sharp', `${key} ${t}`);
        for (let r = 0; r < 12; r++) {
          const want = (flats ? FLAT : SHARP)[(r + t + 12) % 12];
          assert.equal(transposeLabel(`${SHARP[r]}:min`, t, key), `${want}:min`, `${key} ${t} root ${SHARP[r]}`);
        }
      }
    }
  }
});

test('the key picks the accidental: A major capo 2 is G shapes, E major -> Eb is flats', () => {
  assert.equal(transposeLabel('A:maj', -2, 'A major'), 'G:maj');
  assert.equal(transposeLabel('C#:min', -2, 'A major'), 'B:min');
  // A major down 4 = F major: flats
  assert.equal(transposeLabel('D:maj', -4, 'A major'), 'Bb:maj');
  // E major up 3 = G major: sharp key? G is sharp -> F# not Gb
  assert.equal(transposeLabel('B:maj', 3, 'E major'), 'D:maj');
  assert.equal(transposeLabel('E:maj', 6, 'E major'), 'Bb:maj'); // new key Bb major: flats
  // Bb major up 1 is B major (sharps); down 1 is A major
  assert.equal(transposeLabel('Bb:maj', 1, 'A# major'), 'B:maj');
  // F major (flat key) up 1 = F# major: sharp
  assert.equal(transposeLabel('F:maj', 1, 'F major'), 'F#:maj');
  // sharp-spelled storage in a flat target key is re-spelled flat
  assert.equal(transposeLabel('G:maj', 3, 'C major'), 'Bb:maj');
  assert.equal(transposeLabel('G#:maj', 0, 'C major'), 'G#:maj');
  // no / bad key: sharps up, flats down
  assert.equal(transposeLabel('C:maj', 1, null), 'C#:maj');
  assert.equal(transposeLabel('C:maj', -1, null), 'B:maj');
  assert.equal(transposeLabel('C:maj', 2, 'garbage'), 'D:maj');
  assert.equal(transposeLabel('D:maj', -1, undefined), 'Db:maj');
});

test('slash bass and qualities survive (interval bass moves with the root)', () => {
  assert.equal(transposeHarte('C:maj/3', 2, 'sharp'), 'D:maj/3');
  assert.equal(transposeHarte('C#:hdim7/5', -2, 'sharp'), 'B:hdim7/5');
  assert.equal(transposeHarte('G:7/b7', 5, 'sharp'), 'C:7/b7');
  assert.equal(transposeHarte('A:min7', 3, 'sharp'), 'C:min7');
  assert.equal(transposeHarte('Bb:sus4(b7)', 1, 'sharp'), 'B:sus4(b7)');
  assert.equal(transposeHarte('E:min(9)', 2, 'sharp'), 'F#:min(9)');
  // note-name bass moves too
  assert.equal(transposeHarte('C/E', 2, 'sharp'), 'D/F#');
  assert.equal(transposeHarte('C', 2, 'sharp'), 'D');
  // as shown to the player
  assert.equal(spellChord(transposeLabel('C#:hdim7/5', -2, 'A major')).text, 'Bm7♭5/F♯');
  assert.equal(spellChord(transposeLabel('G:7/5', 2, 'C major')).text, 'A7/E');
  assert.equal(spellChord(transposeLabel('E:maj/3', -4, 'E major')).text, 'C/E');
  assert.equal(spellChord(transposeLabel('A:min7/b7', -3, 'A minor')).text, 'F♯m7/E');
});

test('N, X, blanks and unknown text pass through; 0 is the identity', () => {
  for (const l of ['N', 'X', '', '  ', 'Bogus', 'H:maj']) assert.equal(transposeHarte(l, 3, 'sharp'), l);
  assert.equal(transposeLabel('N', 4, 'A major'), 'N');
  assert.equal(transposeLabel('Bb:maj/3', 0, 'F major'), 'Bb:maj/3');
  assert.equal(transposeHarte(undefined, 2, 'sharp'), undefined);
});

test('clamp, badge, summary, parseKey', () => {
  assert.equal(clampTranspose(9), 6);
  assert.equal(clampTranspose(-9), -6);
  assert.equal(clampTranspose(2.4), 2);
  assert.equal(clampTranspose('3'), 0);
  assert.equal(clampTranspose(NaN), 0);
  assert.equal(transposeBadge(0), '');
  assert.equal(transposeBadge(-2), 'Capo 2');
  assert.equal(transposeBadge(2), '+2');
  assert.equal(transposeSummary(0), 'Off');
  assert.equal(transposeSummary(-5), 'Capo 5');
  assert.equal(transposeSummary(1), '+1 semitone');
  assert.equal(transposeSummary(3), '+3 semitones');
  assert.deepEqual(parseKey('A# major'), { pc: 10, minor: false });
  assert.deepEqual(parseKey('Bb minor'), { pc: 10, minor: true });
  assert.deepEqual(parseKey('F♯ major'), { pc: 6, minor: false });
  assert.equal(parseKey('nope'), null);
  assert.equal(parseKey(null), null);
  void pcOf;
});

test('storage is per job, best-effort, and a broken value is 0', () => {
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const prev = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
  try {
    writeTranspose('a', -2);
    writeTranspose('b', 4);
    assert.equal(readTranspose('a'), -2);
    assert.equal(readTranspose('b'), 4);
    assert.equal(readTranspose('c'), 0);
    assert.equal(store.get(TRANSPOSE_KEY_PREFIX + 'a'), '-2');
    writeTranspose('a', 0);
    assert.equal(store.has(TRANSPOSE_KEY_PREFIX + 'a'), false);
    store.set(TRANSPOSE_KEY_PREFIX + 'z', 'junk');
    assert.equal(readTranspose('z'), 0);
    store.set(TRANSPOSE_KEY_PREFIX + 'z', '99');
    assert.equal(readTranspose('z'), 6);
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('x'); } },
      configurable: true,
    });
    assert.equal(readTranspose('a'), 0);
    assert.doesNotThrow(() => writeTranspose('a', 3));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: prev, configurable: true });
  }
});
