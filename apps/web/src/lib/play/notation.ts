// THE ONE display formatter for chord names AND song keys on the player
// (design proposal v1.4, P1.5: "one chord vocabulary, guitarist notation
// everywhere, by one display formatter used by card and chart; stored data
// unchanged").
//
// Pure and dependency-free so node:test loads it directly
// (test/play-notation.test.mjs) and ChordPhone.helpers.ts can import it with an
// explicit `.ts` specifier.
//
//   * Chords: Harte ("A:min7", "G:7/5", "C#:hdim7/5") -> guitarist notation
//     ("Am7", "G7/D", "C♯m7♭5/G♯"). Every quality of the grammar and every bass
//     interval token is spelled; the bass by its interval's letter (C/B♭, not
//     C/A♯). Anything not known exactly (a parenthesised extension such as
//     "min(9)", an unlisted shorthand) is shown as its Harte label, never as a
//     guess. Roots are spelled as stored (A♯ stays A♯ even in a B♭ song).
//   * Keys: the worker writes "<sharp-spelled root> major|minor" (tagger/
//     bpm_key.py). Shown with the spelling a musician expects: flats where
//     conventional (major F B♭ E♭ A♭ D♭; minor D G C F B♭ E♭), sharps for
//     E B F♯ C♯ G♯ minor (and F♯ major).
//   * On screen: the ♭ / ♯ glyphs. In accessible names: the words "flat" and
//     "sharp" ("C sharp minor 7 flat 5 over G sharp"), because a screen reader
//     reads "♯" inconsistently and "#" as "number".

export interface Spelled {
  /** What is painted: guitarist notation with ♭ / ♯ glyphs. */
  readonly text: string;
  /** What is spoken: the same name in words, for aria-labels. */
  readonly spoken: string;
}

export const FLAT = '♭'; // ♭
export const SHARP = '♯'; // ♯

// ── chords ───────────────────────────────────────────────────────────────────

/** Harte shorthand -> lead-sheet suffix (ASCII; glyphs are applied after). */
const QUALITY: Readonly<Record<string, string>> = Object.freeze({
  '': '', maj: '', min: 'm', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4', maj6: '6', min6: 'm6',
  maj7: 'maj7', min7: 'm7', '7': '7', dim7: 'dim7', hdim7: 'm7b5', minmaj7: 'm(maj7)', maj9: 'maj9',
  min9: 'm9', '9': '9', '11': '11', '13': '13', min11: 'm11', '5': '5', '1': '',
  // The rest of the worker's grammar (harte.ts HARTE_QUALITIES) and of the
  // extended vocabulary: shown as guitarist names, never as raw Harte.
  add9: 'add9', add11: 'add11', add6: '6', aug7: '7#5', min13: 'm13', maj13: 'maj13', 'sus4(b7)': '7sus4',
});

/** Lead-sheet suffix -> words. */
const QUALITY_SPOKEN: Readonly<Record<string, string>> = Object.freeze({
  '': '', m: 'minor', dim: 'diminished', aug: 'augmented', sus2: 'sus 2', sus4: 'sus 4', '6': '6', m6: 'minor 6',
  maj7: 'major 7', m7: 'minor 7', '7': '7', dim7: 'diminished 7', m7b5: 'minor 7 flat 5', 'm(maj7)': 'minor major 7',
  maj9: 'major 9', m9: 'minor 9', '9': '9', '11': '11', '13': '13', m11: 'minor 11', '5': '5',
  add9: 'add 9', add11: 'add 11', '7#5': '7 sharp 5', m13: 'minor 13', maj13: 'major 13', '7sus4': '7 sus 4',
});

/** Semitones above the root of each (natural) Harte degree, 1..13. */
const DEGREE_SEMIS: Readonly<Record<number, number>> = Object.freeze({
  1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11, 8: 12, 9: 14, 10: 16, 11: 17, 12: 19, 13: 21,
});
const ROOT_PC: Readonly<Record<string, number>> = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });
const LETTERS = 'CDEFGAB';
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** A Harte bass interval ("b7", "#4", "bb3", "5", "10"), or null if it is not one. */
function parseInterval(tok: string): { semis: number; degree: number; acc: number } | null {
  const m = /^(b*|#*)(\d+)$/.exec(tok);
  if (!m) return null;
  const degree = Number(m[2]);
  const base = DEGREE_SEMIS[degree];
  if (base === undefined) return null;
  const acc = m[1].startsWith('#') ? m[1].length : -m[1].length;
  return { semis: base + acc, degree, acc };
}

/**
 * The bass NOTE for a root and a Harte bass interval, spelled the way the
 * interval names it: the LETTER is the root's letter plus the interval number
 * (a 3rd above C is some E, a b7 above C is some B), and the accidental is
 * whatever makes that letter the right pitch. So C/b7 is C/B♭ (not A♯), Gm/b6
 * is Gm/E♭, C/b3 is C/E♭, A/6 is A/F♯, B♭/b7 is B♭/A♭, F+/#5 is F+/C♯,
 * C♯/3 is C♯/E♯. Every interval token of the grammar is spelled (#1, b4, bb3,
 * #6, #7, 8, 10, 12 included).
 *
 * The one exception: a spelling that would need a DOUBLE accidental (G♭/b3 =
 * B♭♭) is written as the plain note instead, in the direction of the
 * interval's own accidental (flats for a b-interval, sharps for a #-interval,
 * the root's direction for a natural one): G♭/b3 -> G♭/A.
 */
function bassNote(root: { name: string; pc: number }, tok: string): string | null {
  const iv = parseInterval(tok);
  if (!iv) return null;
  const pc = (((root.pc + iv.semis) % 12) + 12) % 12;
  const letter = LETTERS[(LETTERS.indexOf(root.name[0]) + iv.degree - 1) % 7];
  let acc = (((pc - ROOT_PC[letter]) % 12) + 12) % 12;
  if (acc > 6) acc -= 12;
  if (Math.abs(acc) <= 1) return letter + (acc < 0 ? 'b' : acc > 0 ? '#' : '');
  const flats = iv.acc < 0 || (iv.acc === 0 && (root.name.includes('b') || root.name === 'F'));
  return (flats ? FLAT_NAMES : SHARP_NAMES)[pc];
}

function parseRoot(s: string): { name: string; pc: number } | null {
  const m = /^([A-G])((?:#|b)*)$/.exec(s);
  if (!m) return null;
  let pc = ROOT_PC[m[1]];
  for (const ch of m[2]) pc += ch === '#' ? 1 : -1;
  return { name: s, pc: ((pc % 12) + 12) % 12 };
}

/**
 * Harte -> ASCII lead-sheet symbol, or null when the label cannot be spelled
 * exactly. "A:min7" -> "Am7", "G:7/5" -> "G7/D", "Bb:maj" -> "Bb", "C:1" -> "C",
 * "C#:hdim7/5" -> "C#m7b5/G#".
 */
export function chordAscii(harte: string): string | null {
  if (typeof harte !== 'string') return null;
  const label = harte.trim();
  const slash = label.indexOf('/');
  const body = slash >= 0 ? label.slice(0, slash) : label;
  const bassTok = slash >= 0 ? label.slice(slash + 1) : null;
  const colon = body.indexOf(':');
  const root = parseRoot(colon >= 0 ? body.slice(0, colon) : body);
  const shorthand = colon >= 0 ? body.slice(colon + 1) : '';
  if (!root || !(shorthand in QUALITY)) return null;
  let out = root.name + QUALITY[shorthand];
  // A parenthesised Harte shorthand ("min(9)", "(1,3,5)") is not in QUALITY
  // unless it is one we spell ("sus4(b7)"), so it falls through to null above.
  if (bassTok !== null && bassTok !== '1') {
    const bass = bassNote(root, bassTok);
    if (bass === null) return null;
    out += '/' + bass;
  }
  return out;
}

/** ASCII accidentals -> glyphs: "C#m7b5/G#" -> "C♯m7♭5/G♯", "Bb" -> "B♭". */
export function toGlyphs(ascii: string): string {
  return ascii
    .replace(/([A-G])#/g, `$1${SHARP}`)
    .replace(/([A-G])b/g, `$1${FLAT}`)
    .replace(/b(\d)/g, `${FLAT}$1`)
    .replace(/#(\d)/g, `${SHARP}$1`);
}

/** "C#" -> "C sharp", "Bb" -> "B flat". */
function noteSpoken(ascii: string): string {
  return ascii.charAt(0) + ascii.slice(1).replace(/#/g, ' sharp').replace(/b/g, ' flat');
}

/** An ASCII lead-sheet symbol (as chordAscii returns) in words. */
export function chordSpoken(ascii: string): string {
  const m = /^([A-G](?:#|b)?)(.*?)(?:\/([A-G](?:#|b)?))?$/.exec(ascii);
  if (!m) return ascii;
  const quality = QUALITY_SPOKEN[m[2]];
  if (quality === undefined) return ascii;
  const parts = [noteSpoken(m[1])];
  if (quality) parts.push(quality);
  let out = parts.join(' ');
  if (m[3]) out += ` over ${noteSpoken(m[3])}`;
  return out;
}

/**
 * The player's chord name. Falls back to the raw label (both text and spoken)
 * for anything chordAscii cannot spell exactly.
 */
export function spellChord(harte: string): Spelled {
  const ascii = chordAscii(harte);
  if (ascii === null) {
    const raw = typeof harte === 'string' ? harte : '';
    return { text: raw, spoken: raw };
  }
  return { text: toGlyphs(ascii), spoken: chordSpoken(ascii) };
}

// ── keys ─────────────────────────────────────────────────────────────────────

/** Conventional spelling by pitch class (C = 0). */
const MAJOR_KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

/**
 * "A# major" -> { text: "B♭ major", spoken: "B flat major" }. Accepts any root
 * spelling (sharps, flats, naturals) and "major" / "minor" in any case.
 * Null for anything else (and null / blank), so the caller hides the key.
 */
export function spellKey(raw: unknown): Spelled | null {
  if (typeof raw !== 'string') return null;
  const m = /^\s*([A-Ga-g])((?:#|b|♯|♭)?)\s+(major|minor|maj|min)\s*$/i.exec(raw);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2];
  const root = parseRoot(letter + acc);
  if (!root) return null;
  const minor = /^min/i.test(m[3]);
  const name = (minor ? MINOR_KEY_NAMES : MAJOR_KEY_NAMES)[root.pc];
  const mode = minor ? 'minor' : 'major';
  return { text: `${toGlyphs(name)} ${mode}`, spoken: `${noteSpoken(name)} ${mode}` };
}

// ── tempo ────────────────────────────────────────────────────────────────────

/** jobs.bpm (numeric; node-pg may hand a string) -> "102 BPM", or null to hide. */
export function formatBpm(raw: unknown): string | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${Math.round(n)} BPM`;
}

/**
 * The header's "Detected" line: "102 BPM · A major". Null when neither is
 * known (then nothing is shown). `spoken` is for an sr-only copy if needed.
 */
export function songFacts(bpm: unknown, key: unknown): Spelled | null {
  const b = formatBpm(bpm);
  const k = spellKey(key);
  const text = [b, k?.text].filter(Boolean).join(' · ');
  if (!text) return null;
  const spoken = [b, k?.spoken].filter(Boolean).join(', ');
  return { text, spoken };
}
