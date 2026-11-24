// Capo / transpose (Phase C, C4): shifts the chord NAMES the player shows, by
// -6..+6 semitones. A display layer like Simple chords (chord-mode.ts): the
// audio and the stored chords are never touched. Negative = "Capo N" (the
// shapes you play drop by N frets: the song sounds the same); positive = "+N"
// (the names move up). Remembered per job, best-effort (private mode, a full
// or blocked localStorage means 0, never an error).
//
// Pure and dependency-free so node:test loads it directly
// (test/play-transpose.test.mjs).
//
// Chords are Harte ("A:min7", "C#:hdim7/5", "Bb:maj", "N", "X"). The bass of a
// Harte slash chord is an INTERVAL above the root, so moving the root moves the
// bass with it and the slash survives untouched. A note-name bass ("C/E") is
// moved too. Anything that is not a chord (N, X, blank) or whose root is not
// readable passes through unchanged.

export const MIN_TRANSPOSE = -6;
export const MAX_TRANSPOSE = 6;
export const TRANSPOSE_KEY_PREFIX = 'sl.play.transpose.v1.';

export type Spelling = 'sharp' | 'flat';

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER_PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** -6..+6, whole numbers; anything else (NaN, a string, 40) is clamped or 0. */
export function clampTranspose(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.max(MIN_TRANSPOSE, Math.min(MAX_TRANSPOSE, Math.round(n)));
}

function parseNote(s: string): number | null {
  const m = /^([A-G])((?:#|b)*)$/.exec(s);
  if (!m) return null;
  let pc = LETTER_PC[m[1]];
  for (const ch of m[2]) pc += ch === '#' ? 1 : -1;
  return ((pc % 12) + 12) % 12;
}

function noteName(pc: number, spelling: Spelling): string {
  return (spelling === 'flat' ? FLAT_NAMES : SHARP_NAMES)[((pc % 12) + 12) % 12];
}

// Keys whose signature has flats (conventional spelling, as spellKey in
// notation.ts): major F Bb Eb Ab Db; minor D G C F Bb Eb. C major is "flat":
// the chords outside C are almost always borrowed flats (Bb, Eb, Ab).
const FLAT_MAJOR = new Set([0, 1, 3, 5, 8, 10]);
const FLAT_MINOR = new Set([0, 2, 3, 5, 7, 10]);

/** The key of the song as { pc, minor }, or null ("A# major", "Bb minor", "F♯ major"). */
export function parseKey(raw: unknown): { pc: number; minor: boolean } | null {
  if (typeof raw !== 'string') return null;
  const m = /^\s*([A-Ga-g])(#|b|♯|♭)?\s+(major|minor|maj|min)\s*$/i.exec(raw);
  if (!m) return null;
  const acc = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : (m[2] ?? '');
  const pc = parseNote(m[1].toUpperCase() + acc);
  return pc === null ? null : { pc, minor: /^min/i.test(m[3]) };
}

/**
 * How to spell accidentals for the transposed chords: by the NEW key (the song
 * key moved by `semis`): flats in a flat key, sharps in a sharp key. No known
 * key: sharps going up, flats going down.
 */
export function spellingFor(musicalKey: unknown, semis: number): Spelling {
  const key = parseKey(musicalKey);
  if (!key) return semis < 0 ? 'flat' : 'sharp';
  const pc = (((key.pc + semis) % 12) + 12) % 12;
  return (key.minor ? FLAT_MINOR : FLAT_MAJOR).has(pc) ? 'flat' : 'sharp';
}

/** One Harte chord label moved by `semis`, accidentals spelled `spelling`. */
export function transposeHarte(
  label: string,
  semis: number,
  spelling: Spelling,
  namer: (pc: number) => string = (pc) => noteName(pc, spelling),
): string {
  if (typeof label !== 'string') return label;
  const m = /^(\s*)([A-G](?:#|b)*)(.*)$/.exec(label);
  if (!m) return label; // N, X, blank, anything else
  const rootPc = parseNote(m[2]);
  if (rootPc === null) return label;
  let rest = m[3];
  // Only a ':' quality, a '/' bass or the end may follow the root: otherwise
  // this is not a chord we understand ("Bogus"), left alone.
  if (rest !== '' && rest[0] !== ':' && rest[0] !== '/') return label;
  if (semis === 0) return label;
  const slash = rest.indexOf('/');
  if (slash >= 0) {
    const bass = rest.slice(slash + 1);
    const bassPc = parseNote(bass); // a note-name bass moves; an interval ("3", "b7") does not
    if (bassPc !== null) rest = rest.slice(0, slash + 1) + namer(bassPc + semis);
  }
  return m[1] + namer(rootPc + semis) + rest;
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

/**
 * The label a run shows, for the chosen shift and song key. Roots diatonic to
 * the NEW key are spelled by that key's signature (sharps in a sharp key, flats
 * in a flat key); every other root (a borrowed chord) is a flat (Bb, Eb, Ab),
 * except the two a key always sharpens: the raised 7th of a minor key (C# in D
 * minor, F# in G minor) and #IV in a major key (F# in C major, C# in G major).
 * A note-name bass of a slash chord follows the same rule. Unknown key: as
 * spellingFor (no per-root rule).
 */
export function transposeLabel(label: string, semis: number, musicalKey: unknown): string {
  if (semis === 0) return label;
  const spelling = spellingFor(musicalKey, semis);
  const key = parseKey(musicalKey);
  if (!key) return transposeHarte(label, semis, spelling);
  const keyPc = (((key.pc + semis) % 12) + 12) % 12;
  const diatonic = new Set((key.minor ? MINOR_SCALE : MAJOR_SCALE).map((d) => (keyPc + d) % 12));
  const sharpExtra = key.minor ? (keyPc + 11) % 12 : (keyPc + 6) % 12;
  const namer = (pc: number): string => {
    const p = ((pc % 12) + 12) % 12;
    if (diatonic.has(p)) return noteName(p, spelling);
    return noteName(p, p === sharpExtra ? 'sharp' : 'flat');
  };
  return transposeHarte(label, semis, spelling, namer);
}

/** The small indicator: "" at 0, "Capo 2" below 0, "+2" above. */
export function transposeBadge(semis: number): string {
  if (semis === 0) return '';
  return semis < 0 ? `Capo ${-semis}` : `+${semis}`;
}

/** The value in the menu: "Off", "Capo 2", "+2 semitones". */
export function transposeSummary(semis: number): string {
  if (semis === 0) return 'Off';
  if (semis < 0) return `Capo ${-semis}`;
  return `+${semis} semitone${semis === 1 ? '' : 's'}`;
}

export function readTranspose(jobId: string): number {
  try {
    const v = globalThis.localStorage?.getItem(TRANSPOSE_KEY_PREFIX + jobId);
    if (v === null || v === undefined || !/^-?\d+$/.test(v)) return 0;
    return clampTranspose(Number(v));
  } catch {
    return 0;
  }
}

export function writeTranspose(jobId: string, semis: number): void {
  try {
    const key = TRANSPOSE_KEY_PREFIX + jobId;
    if (clampTranspose(semis) === 0) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, String(clampTranspose(semis)));
  } catch {
    /* not remembered: the choice still holds for this page */
  }
}
