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
