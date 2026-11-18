// THE ONE display formatter for chords AND keys (design v1.4, P1.5):
// src/lib/play/notation.ts. Guitarist notation, flats where conventional, the
// ♭/♯ glyphs on screen and the words "flat"/"sharp" in accessible names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chordAscii, chordSpoken, formatBpm, songFacts, spellChord, spellKey, toGlyphs } from '../src/lib/play/notation.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

test('chords: Harte -> guitarist notation, glyphs on screen (C, Am7, G7, C/E ...)', () => {
  const cases = {
    'C:maj': 'C', 'C': 'C', 'A:min7': 'Am7', 'G:7': 'G7', 'C:maj/3': 'C/E', 'G:7/5': 'G7/D', 'E:min': 'Em',
    'Bb:maj': 'B♭', 'F#:min7': 'F♯m7', 'Eb:7/b7': 'E♭7/D♭', 'C:hdim7': 'Cm7♭5', 'D:sus4': 'Dsus4', 'A:dim7': 'Adim7',
    'C#:hdim7/5': 'C♯m7♭5/G♯', 'F:maj7/3': 'Fmaj7/A', 'C:1': 'C', 'G:5': 'G5', 'C#:minmaj7': 'C♯m(maj7)',
  };
  for (const [h, want] of Object.entries(cases)) assert.equal(spellChord(h).text, want, h);
});

test('chords: the 360px test case C#m7b5/G# — ASCII, glyphs and words', () => {
  assert.equal(chordAscii('C#:hdim7/5'), 'C#m7b5/G#');
  assert.equal(toGlyphs('C#m7b5/G#'), 'C♯m7♭5/G♯');
  assert.deepEqual(spellChord('C#:hdim7/5'), { text: 'C♯m7♭5/G♯', spoken: 'C sharp minor 7 flat 5 over G sharp' });
  assert.equal(spellChord('G#:min').spoken, 'G sharp minor');
  assert.equal(spellChord('G#:maj').text, 'G♯');
});

test('chords: spoken names never contain a glyph or "#", and say "over" for the bass', () => {
  for (const h of ['Bb:maj', 'Eb:7/b7', 'F#:min7', 'C#:hdim7/5', 'Ab:maj7/3', 'C:maj/3']) {
    const { spoken } = spellChord(h);
    assert.doesNotMatch(spoken, /[♭♯#]/, h);
  }
  assert.equal(spellChord('C:maj/3').spoken, 'C over E');
  assert.equal(spellChord('Eb:7/b7').spoken, 'E flat 7 over D flat');
  assert.equal(chordSpoken('Am7'), 'A minor 7');
});

test('chords: anything not spelled exactly is the Harte label, never a guess', () => {
  for (const h of ['D:min(9)', 'G:weird', 'H:maj', 'C:maj/x', '']) assert.equal(spellChord(h).text, h, h);
  assert.equal(spellChord(undefined).text, '');
  assert.equal(chordAscii(null), null);
});

test('glyphs: only accidentals change — "sus", "dim", "maj", "add" and "b" inside words are untouched', () => {
  assert.equal(toGlyphs('Bbsus4'), 'B♭sus4');
  assert.equal(toGlyphs('Cdim7'), 'Cdim7');
  assert.equal(toGlyphs('Abmaj7/Eb'), 'A♭maj7/E♭');
  assert.equal(toGlyphs('C7#9'), 'C7♯9');
});

test('keys: flats where conventional — major F B♭ E♭ A♭ D♭; minor D G C F B♭ E♭', () => {
  // The worker writes sharp-spelled roots (tagger/bpm_key.py _NOTES).
  const major = { 'C major': 'C major', 'C# major': 'D♭ major', 'D# major': 'E♭ major', 'F major': 'F major', 'F# major': 'F♯ major', 'G# major': 'A♭ major', 'A# major': 'B♭ major', 'A major': 'A major', 'B major': 'B major', 'E major': 'E major', 'G major': 'G major', 'D major': 'D major' };
  for (const [raw, want] of Object.entries(major)) assert.equal(spellKey(raw).text, want, raw);
  const minor = { 'D minor': 'D minor', 'G minor': 'G minor', 'C minor': 'C minor', 'F minor': 'F minor', 'A# minor': 'B♭ minor', 'D# minor': 'E♭ minor' };
  for (const [raw, want] of Object.entries(minor)) assert.equal(spellKey(raw).text, want, raw);
});

test('keys: sharps for E B F♯ C♯ G♯ minor (and A minor stays natural)', () => {
  const minor = { 'E minor': 'E minor', 'B minor': 'B minor', 'F# minor': 'F♯ minor', 'C# minor': 'C♯ minor', 'G# minor': 'G♯ minor', 'A minor': 'A minor' };
  for (const [raw, want] of Object.entries(minor)) assert.equal(spellKey(raw).text, want, raw);
});

test('keys: words in the accessible name; any input spelling of the same key gives one answer', () => {
  assert.deepEqual(spellKey('A# major'), { text: 'B♭ major', spoken: 'B flat major' });
  assert.deepEqual(spellKey('Bb major'), { text: 'B♭ major', spoken: 'B flat major' });
  assert.deepEqual(spellKey('B♭ major'), { text: 'B♭ major', spoken: 'B flat major' });
  assert.deepEqual(spellKey('g# MINOR'), { text: 'G♯ minor', spoken: 'G sharp minor' });
  assert.deepEqual(spellKey('C# min'), { text: 'C♯ minor', spoken: 'C sharp minor' });
});

test('keys: null, blank and garbage are hidden (null), never "undefined" or a guess', () => {
  for (const v of [null, undefined, '', '  ', 'H major', 'C mixolydian', 'major', 42, {}]) assert.equal(spellKey(v), null, String(v));
});

test('BPM: jobs.bpm rounded to an integer; node-pg numeric strings accepted; null/0/NaN hidden', () => {
  assert.equal(formatBpm(101.6), '102 BPM');
  assert.equal(formatBpm(102.4), '102 BPM');
  assert.equal(formatBpm('82.50'), '83 BPM');
  for (const v of [null, undefined, 0, -3, NaN, '', 'fast']) assert.equal(formatBpm(v), null, String(v));
});

test('songFacts: "102 BPM · A major", either half alone, nothing when both are unknown', () => {
  assert.deepEqual(songFacts(102.4, 'A major'), { text: '102 BPM · A major', spoken: '102 BPM, A major' });
  assert.deepEqual(songFacts(null, 'A# major'), { text: 'B♭ major', spoken: 'B flat major' });
  assert.deepEqual(songFacts(120, null), { text: '120 BPM', spoken: '120 BPM' });
  assert.equal(songFacts(null, null), null);
});

test('ONE formatter: the stage (ChordPhone.helpers) delegates to it; nothing else on the player spells keys', () => {
  const helpers = readFileSync(join(WEB, 'src/components/ChordPhone.helpers.ts'), 'utf8');
  assert.match(helpers, /import \{ spellChord \} from '\.\.\/lib\/play\/notation\.ts';/);
  assert.match(helpers, /return spellChord\(run\.label\)\.text;/);
  assert.doesNotMatch(helpers, /LEAD_SHEET_QUALITY|SHARP_NAMES|FLAT_NAMES/, 'a second chord-spelling table');
  const screen = readFileSync(join(WEB, 'src/components/play/PlayerScreen.tsx'), 'utf8');
  assert.match(screen, /songFacts\(bpm, musicalKey\)/);
});

// ── slash basses: spelled by the INTERVAL, not by the root (PR #294 review M-2) ─
// Expected values computed OUTSIDE this code (a major-scale table: letter = root
// letter + interval number, accidental = whatever makes that letter the pitch;
// a double accidental is written as the plain note in the direction of the
// interval's accidental), then pasted here as literals. E♯ B♯ F♭ C♭ are kept
// where the interval names them (D♭/b3 is D♭/F♭); see also
// play-notation-exhaustive.test.mjs.
const BASS_TABLE = {
  'C': { 'b2': 'D♭', 'b3': 'E♭', 'b5': 'G♭', 'b6': 'A♭', 'b7': 'B♭', '#4': 'F♯', '#5': 'G♯' },
  'Db': { 'b2': 'D', 'b3': 'F♭', 'b5': 'G', 'b6': 'A', 'b7': 'C♭', '#4': 'G', '#5': 'A' },
  'D': { 'b2': 'E♭', 'b3': 'F', 'b5': 'A♭', 'b6': 'B♭', 'b7': 'C', '#4': 'G♯', '#5': 'A♯' },
  'Eb': { 'b2': 'F♭', 'b3': 'G♭', 'b5': 'A', 'b6': 'C♭', 'b7': 'D♭', '#4': 'A', '#5': 'B' },
  'E': { 'b2': 'F', 'b3': 'G', 'b5': 'B♭', 'b6': 'C', 'b7': 'D', '#4': 'A♯', '#5': 'B♯' },
  'F': { 'b2': 'G♭', 'b3': 'A♭', 'b5': 'C♭', 'b6': 'D♭', 'b7': 'E♭', '#4': 'B', '#5': 'C♯' },
  'F#': { 'b2': 'G', 'b3': 'A', 'b5': 'C', 'b6': 'D', 'b7': 'E', '#4': 'B♯', '#5': 'D' },
  'G': { 'b2': 'A♭', 'b3': 'B♭', 'b5': 'D♭', 'b6': 'E♭', 'b7': 'F', '#4': 'C♯', '#5': 'D♯' },
  'Ab': { 'b2': 'A', 'b3': 'C♭', 'b5': 'D', 'b6': 'F♭', 'b7': 'G♭', '#4': 'D', '#5': 'E' },
  'A': { 'b2': 'B♭', 'b3': 'C', 'b5': 'E♭', 'b6': 'F', 'b7': 'G', '#4': 'D♯', '#5': 'E♯' },
  'Bb': { 'b2': 'C♭', 'b3': 'D♭', 'b5': 'F♭', 'b6': 'G♭', 'b7': 'A♭', '#4': 'E', '#5': 'F♯' },
  'B': { 'b2': 'C', 'b3': 'D', 'b5': 'F', 'b6': 'G', 'b7': 'A', '#4': 'E♯', '#5': 'G' },
};

test('slash basses: 12 roots x b2 b3 b5 b6 b7 #4 #5, spelled as a lead sheet spells them', () => {
  for (const [root, row] of Object.entries(BASS_TABLE)) {
    for (const [iv, bass] of Object.entries(row)) {
      const want = `${toGlyphs(root)}/${bass}`;
      assert.equal(spellChord(`${root}:maj/${iv}`).text, want, `${root}:maj/${iv}`);
    }
  }
  // The review's three, and the minor-chord case.
  assert.equal(spellChord('C:maj/b7').text, 'C/B♭');
  assert.equal(spellChord('G:min/b6').text, 'Gm/E♭');
  assert.equal(spellChord('C:maj/b3').text, 'C/E♭');
  assert.equal(spellChord('C:maj/b7').spoken, 'C over B flat');
  assert.equal(spellChord('G:min/b6').spoken, 'G minor over E flat');
});

test('slash basses: every root spelling x every bass interval is the right PITCH, with at most one accidental', () => {
  const NAT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const SEMIS = { '1': 0, b2: 1, '2': 2, '#2': 3, b3: 3, '3': 4, '4': 5, '#4': 6, b5: 6, '5': 7, '#5': 8, b6: 8,
    '6': 9, bb7: 9, b7: 10, '7': 11, b9: 1, '9': 2, '#9': 3, '11': 5, '#11': 6, b13: 8, '13': 9 };
  const pcOf = (n) => (NAT[n[0]] + (n.includes('#') ? 1 : 0) - (n.length > 1 && n[1] === 'b' ? 1 : 0) + 12) % 12;
  let n = 0;
  for (const L of 'ABCDEFG') for (const a of ['', '#', 'b']) {
    const root = L + a;
    for (const [iv, semis] of Object.entries(SEMIS)) {
      const ascii = chordAscii(`${root}:maj/${iv}`);
      assert.ok(ascii, `${root}:maj/${iv} is unspelled`);
      if (semis === 0) { assert.equal(ascii, root); continue; }
      const bass = ascii.split('/')[1];
      assert.match(bass, /^[A-G](#|b)?$/, `${root}/${iv}: bass ${bass}`);
      assert.equal(pcOf(bass), (pcOf(root) + semis) % 12, `${root}/${iv}: ${bass} is the wrong pitch`);
      // From a natural or flat root a flat interval never gets a sharp bass (the
      // defect: C/b7 was C/A♯), and from a natural or sharp root a sharp
      // interval never gets a flat one. (A♯'s minor third IS C♯: a sharp root
      // may carry a sharp bass on a flat interval.)
      if (iv.startsWith('b') && !root.includes('#')) assert.ok(!bass.includes('#'), `${root}/${iv} -> ${bass}`);
      if (iv.startsWith('#') && !root.includes('b')) assert.ok(!bass.includes('b'), `${root}/${iv} -> ${bass}`);
      n++;
    }
  }
  assert.equal(n, 21 * 22);
});
