// EXHAUSTIVE, not sampled: every root spelling x every bass interval token of
// the Harte grammar, against a reference speller written independently of
// lib/play/notation.ts (QA track C, finding C-09: 76 practical mis-spellings
// such as Gm/A♯ for Gm/B♭ and F+/D♭ for F+/C♯ survived a sampled test).
// Adapted from /home/claude/s17/qa/c-web/notation-exhaustive.test.mjs into
// assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chordAscii, spellChord, toGlyphs } from '../src/lib/play/notation.ts';
import { HARTE_QUALITIES } from '../src/chord/harte.ts';

// Reference speller: letter arithmetic (interval number -> letter steps) + semitones.
const LET = 'CDEFGAB';
const NAT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DEG_SEMI = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11, 8: 0, 9: 2, 10: 4, 11: 5, 12: 7, 13: 9 };
function ref(root, iv) {
  const m = /^(b*|#*)(\d+)$/.exec(iv);
  const acc = m[1];
  const deg = +m[2];
  const semis = DEG_SEMI[deg] + (acc.startsWith('#') ? acc.length : -acc.length);
  const L = root[0];
  let rpc = NAT[L];
  for (const c of root.slice(1)) rpc += c === '#' ? 1 : -1;
  const tl = LET[(LET.indexOf(L) + (deg - 1)) % 7];
  const tpc = (((rpc + semis) % 12) + 12) % 12;
  let d = (((tpc - NAT[tl]) % 12) + 12) % 12;
  if (d > 6) d -= 12;
  return { name: tl + (d > 0 ? '#'.repeat(d) : 'b'.repeat(-d)), pc: tpc, acc: d };
}
const pcOf = (n) => {
  let p = NAT[n[0]];
  for (const c of n.slice(1)) p += c === '#' ? 1 : -1;
  return ((p % 12) + 12) % 12;
};

// QA's 17 roots plus the grammar's other four spellings (E#, B#, Cb, Fb).
const ROOTS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'E#', 'Fb', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B', 'B#', 'Cb'];
// QA's 30 tokens, plus 8, 10, 12 and the remaining single-accidental degrees.
const IVS = [];
for (let d = 1; d <= 13; d++) for (const a of ['', 'b', '#', 'bb']) IVS.push(a + d);

test('every root x every bass interval: the bass is spelled by the interval (letter), or plainly when that needs a double accidental', () => {
  const wrong = [];
  const raw = [];
  for (const r of ROOTS)
    for (const iv of IVS) {
      const h = `${r}:maj/${iv}`;
      const a = chordAscii(h);
      if (a === null) {
        raw.push(h);
        continue;
      }
      const bass = a.includes('/') ? a.split('/')[1] : r;
      const want = ref(r, iv);
      if (iv === '1') {
        if (a !== r) wrong.push(`${h} -> ${a} (bass = root: no slash)`);
      } else if (Math.abs(want.acc) <= 1) {
        if (bass !== want.name) wrong.push(`${h} -> ${toGlyphs(a)} (expected bass ${toGlyphs(want.name)})`);
      } else {
        // A double accidental is written as the plain note: right pitch, <= 1 accidental.
        if (pcOf(bass) !== want.pc || !/^[A-G](#|b)?$/.test(bass)) wrong.push(`${h} -> ${toGlyphs(a)} (expected the pitch of ${want.name}, plainly)`);
      }
    }
  assert.deepEqual(raw, [], `${raw.length} root x interval combos fall back to raw Harte`);
  assert.deepEqual(wrong, [], `${wrong.length} of ${ROOTS.length * IVS.length} mis-spelled`);
});

test("QA C-09's named examples", () => {
  assert.equal(spellChord('G:min/b3').text, 'Gm/B♭');
  assert.equal(spellChord('C:7/b7').text, 'C7/B♭');
  assert.equal(spellChord('F:aug/#5').text, 'Faug/C♯');
  assert.equal(spellChord('Bb:aug/#5').text, 'B♭aug/F♯');
  assert.equal(spellChord('Eb:maj/#9').text, 'E♭/F♯');
  assert.equal(spellChord('C:maj/b7').text, 'C/B♭');
  assert.equal(spellChord('G:min/b6').text, 'Gm/E♭');
  assert.equal(spellChord('C:maj/b3').text, 'C/E♭');
  assert.equal(spellChord('C#:maj/3').text, 'C♯/E♯');
});

test('every quality is spelled and spoken in words, never shown as raw Harte', () => {
  const quals = [...HARTE_QUALITIES, 'maj', 'min', '1', 'min11', 'min13', 'maj13', 'sus4(b7)'];
  for (const q of quals) {
    for (const r of ['A', 'Bb', 'F#']) {
      const s = spellChord(`${r}:${q}`);
      assert.doesNotMatch(s.text, /:/, `${r}:${q} painted as raw Harte "${s.text}"`);
      assert.doesNotMatch(s.spoken, /[:#♭♯]/, `${r}:${q} spoken "${s.spoken}"`);
    }
  }
  assert.deepEqual(spellChord('A:min13'), { text: 'Am13', spoken: 'A minor 13' });
  assert.deepEqual(spellChord('A:maj13'), { text: 'Amaj13', spoken: 'A major 13' });
  assert.deepEqual(spellChord('A:sus4(b7)'), { text: 'A7sus4', spoken: 'A 7 sus 4' });
  assert.deepEqual(spellChord('C:add9'), { text: 'Cadd9', spoken: 'C add 9' });
  assert.deepEqual(spellChord('C:aug7'), { text: 'C7♯5', spoken: 'C 7 sharp 5' });
  // Not known exactly: still shown as Harte, never guessed.
  assert.equal(spellChord('A:min(9)').text, 'A:min(9)');
  assert.equal(spellChord('C:(1,3,5)').text, 'C:(1,3,5)');
});
