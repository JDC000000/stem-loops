// AUTO-GENERATED — DO NOT EDIT
// Source of truth: apps/training/model/alphabet.py
// Regenerate with: make alphabet-generate
// CI fails (alphabet-drift) if this file is stale.

export const ALPHABET_SHA = "ffa3e7f03c6722f83951694762b247b79e72846f3740b31ca803a7ad37e44b49";

// ─── Factored heads (13 root x 25 quality x 13 bass) ───
export const ROOTS = Object.freeze([
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const);
export const NUM_ROOTS = 12;
export const ROOT_N_INDEX = 12;

export const QUALITY_LABELS = Object.freeze([
  "maj",
  "min",
  "dim",
  "aug",
  "sus2",
  "sus4",
  "maj6",
  "min6",
  "maj7",
  "min7",
  "7",
  "dim7",
  "hdim7",
  "minmaj7",
  "maj9",
  "min9",
  "9",
  "11",
  "13",
  "add9",
  "add11",
  "5",
  "add6",
  "aug7",
  "N",
] as const);
export const N_QUALITY = 25;
export const QUALITY_N_INDEX = 24;

export const BASS_LABELS = Object.freeze([
  "same",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "N",
] as const);
export const N_BASS = 13;
export const BASS_SAME_INDEX = 0;
export const BASS_N_INDEX = 12;

// Flat HMM subset of QUALITY_LABELS (see HMM_QUALITIES in the generator).
export const QUALITIES = Object.freeze([
  "maj",
  "min",
  "7",
  "maj7",
  "min7",
] as const);

// Encode tables (emitted from alphabet.py private tables).
const FACTORED_SHORTHAND_EXACT: Readonly<Record<string, string>> = Object.freeze({
  "maj": "maj",
  "min": "min",
  "dim": "dim",
  "aug": "aug",
  "sus2": "sus2",
  "sus4": "sus4",
  "maj6": "maj6",
  "min6": "min6",
  "maj7": "maj7",
  "min7": "min7",
  "7": "7",
  "dim7": "dim7",
  "hdim7": "hdim7",
  "minmaj7": "minmaj7",
  "maj9": "maj9",
  "min9": "min9",
  "9": "9",
  "11": "11",
  "13": "13",
  "add9": "add9",
  "add11": "add11",
  "add6": "add6",
  "aug7": "aug7",
  "5": "5",
});
const FACTORED_LOSSY_FALLBACK: Readonly<Record<string, string>> = Object.freeze({
  "maj11": "maj9",
  "maj13": "maj9",
  "min11": "min9",
  "min13": "min9",
  "aug7": "aug7",
});
const DEG_SEMITONES: Readonly<Record<string, number>> = Object.freeze({
  "1": 0,
  "2": 2,
  "3": 4,
  "4": 5,
  "5": 7,
  "6": 9,
  "7": 11,
  "8": 12,
  "9": 14,
  "10": 16,
  "11": 17,
  "12": 19,
  "13": 21,
});
const SEMITONES_TO_HARTE: Readonly<Record<string, string>> = Object.freeze({
  "0": "1",
  "1": "b2",
  "2": "2",
  "3": "b3",
  "4": "3",
  "5": "4",
  "6": "b5",
  "7": "5",
  "8": "b6",
  "9": "6",
  "10": "b7",
  "11": "7",
});

export type Root = (typeof ROOTS)[number];
export type QualityLabel = (typeof QUALITY_LABELS)[number];
/** Qualities of the flat 60-state HMM path (subset of QUALITY_LABELS). */
export type Quality = (typeof QUALITIES)[number];

// ─── Runtime mismatch detection ───────────────────────────────────────────

/**
 * Throws if the model/manifest alphabet hash differs from the one this bundle
 * was generated from. Call with the ALPHABET_SHA recorded in the model
 * manifest (training-run manifest / eval report) before trusting its output.
 */
export function assertAlphabetSha(expected: string): void {
  if (expected !== ALPHABET_SHA) {
    throw new Error(
      `chord alphabet mismatch: model=${expected} browser=${ALPHABET_SHA}. ` +
        'Regenerate with `make alphabet-generate` or redeploy the matching model.',
    );
  }
}

// ─── Flat 60-state HMM vocabulary (existing contract — unchanged) ─────────
//
// idx = rootIndex * QUALITIES.length + qualityIndex, 0 = "C:maj".
// N (no-chord) and X (unknown) are NOT in this alphabet; `isValidHarte`
// accepts them, `labelIndex` returns -1 for them.

/** The 60 canonical Harte labels, in index order (0 = "C:maj", 59 = "B:min7"). */
export const labels: readonly string[] = Object.freeze(
  ROOTS.flatMap((r) => QUALITIES.map((q) => `${r}:${q}`)),
);

export const NUM_LABELS = labels.length; // 60

const LABEL_TO_INDEX: ReadonlyMap<string, number> = new Map(
  labels.map((l, i) => [l, i] as const),
);

const ENHARMONIC: Readonly<Record<string, Root>> = Object.freeze({
  Db: 'C#',
  Eb: 'D#',
  Gb: 'F#',
  Ab: 'G#',
  Bb: 'A#',
  Cb: 'B',
  Fb: 'E',
  'E#': 'F',
  'B#': 'C',
});

const ROOT_RE = /^[A-G](?:#|b)?$/;

/**
 * Canonicalise a Harte root token to its sharp form. Returns null on anything
 * that is not a valid letter-with-optional-accidental token.
 */
export function canonicalRoot(root: string): Root | null {
  if (!ROOT_RE.test(root)) return null;
  if ((ROOTS as readonly string[]).includes(root)) return root as Root;
  const mapped = ENHARMONIC[root];
  return mapped ?? null;
}

/**
 * Index of a Harte label in the 60-label HMM alphabet, or -1 if not present.
 * Accepts flat spellings on input. Does NOT accept "N" or "X".
 */
export function labelIndex(harte: string): number {
  if (typeof harte !== 'string' || harte.length === 0) return -1;
  const colon = harte.indexOf(':');
  if (colon < 0) return -1;
  const rootRaw = harte.slice(0, colon);
  const quality = harte.slice(colon + 1);
  const root = canonicalRoot(rootRaw);
  if (!root) return -1;
  const idx = LABEL_TO_INDEX.get(`${root}:${quality}`);
  return idx === undefined ? -1 : idx;
}

/** True for any of the 60 Harte labels OR the sentinel labels N and X. */
export function isValidHarte(s: string): boolean {
  if (s === 'N' || s === 'X') return true;
  return labelIndex(s) !== -1;
}

/** Inverse of labelIndex. Throws on out-of-range index (caller should clamp). */
export function labelAt(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= NUM_LABELS) {
    throw new RangeError(`labelAt: index ${index} out of range [0, ${NUM_LABELS})`);
  }
  return labels[index];
}

/** Alias of NUM_LABELS. Preserved for ChordOverlay/chordnet-session callers. */
export const N_CHORD_CLASSES = NUM_LABELS;

/** Alias of labelAt — the chord label for a class index. */
export function chordLabel(cls: number): string {
  return labelAt(cls);
}

/**
 * Up to k nearest chord class indices to `forCls`, excluding itself:
 *   1. same root, different quality
 *   2. same quality, neighbouring roots (fifths/fourths first)
 *   3. other qualities at neighbouring roots
 * Used by the chord-edit popover to show alternatives.
 */
export function nearestChords(forCls: number, k = 10): number[] {
  if (!Number.isInteger(forCls) || forCls < 0 || forCls >= NUM_LABELS) {
    return [];
  }
  const nQualities = QUALITIES.length; // 5
  const rootIdx = Math.floor(forCls / nQualities);
  const qualIdx = forCls % nQualities;
  const out: number[] = [];
  const seen = new Set<number>([forCls]);
  const push = (idx: number) => {
    if (idx >= 0 && idx < NUM_LABELS && !seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  };
  for (let q = 0; q < nQualities && out.length < k; q++) {
    if (q !== qualIdx) push(rootIdx * nQualities + q);
  }
  const deltas = [5, 7, -5, -7, 2, -2, 1, -1, 3, -3, 4, -4, 6, -6];
  for (const d of deltas) {
    if (out.length >= k) break;
    const r = (((rootIdx + d) % 12) + 12) % 12;
    push(r * nQualities + qualIdx);
  }
  for (let d = 1; d < 12 && out.length < k; d++) {
    for (const sign of [1, -1]) {
      const r = (((rootIdx + sign * d) % 12) + 12) % 12;
      for (let q = 0; q < nQualities && out.length < k; q++) {
        if (q === qualIdx) continue;
        push(r * nQualities + q);
      }
    }
  }
  return out.slice(0, k);
}

// ─── Factored (root, quality, bass) 13 x 25 x 13 — full chord vocabulary ──
//
// Port of alphabet.py encode_factored / decode_factored. Control flow is
// ported by hand; every lookup table above is emitted from Python.

export type FactoredChord = readonly [root: number, quality: number, bass: number];

const NAT_PC: Readonly<Record<string, number>> = Object.freeze({
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
});

function has(table: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

function parseRootPc(root: string): number | null {
  if (!root) return null;
  const letter = root[0].toUpperCase();
  if (!has(NAT_PC, letter)) return null;
  let pc = NAT_PC[letter];
  for (const ch of root.slice(1)) {
    if (ch === 'b') pc -= 1;
    else if (ch === '#') pc += 1;
    else return null;
  }
  return ((pc % 12) + 12) % 12;
}

function parseInterval(tok: string): number | null {
  if (!tok) return null;
  let shift = 0;
  let i = 0;
  while (i < tok.length && (tok[i] === 'b' || tok[i] === '#')) {
    shift += tok[i] === 'b' ? -1 : 1;
    i += 1;
  }
  const deg = tok.slice(i);
  if (!has(DEG_SEMITONES, deg)) return null;
  return (((DEG_SEMITONES[deg] + shift) % 12) + 12) % 12;
}

function stripParens(harte: string): [string, string[]] {
  const open = harte.indexOf('(');
  if (open < 0) return [harte, []];
  const rest = harte.slice(open + 1);
  const close = rest.indexOf(')');
  if (close < 0) return [harte, []];
  const extras = rest
    .slice(0, close)
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return [harte.slice(0, open), extras];
}

function extrasEq(extras: readonly string[], ...want: string[]): boolean {
  return extras.length === want.length && extras.every((e, i) => e === want[i]);
}

/**
 * Encode a Harte chord string to (root, quality, bass) indices, or null when
 * it falls outside the 25-quality vocabulary (caller treats as X).
 * "N" -> (ROOT_N_INDEX, QUALITY_N_INDEX, BASS_N_INDEX). Mirrors Python.
 */
export function encodeFactored(harte: string): FactoredChord | null {
  if (typeof harte !== 'string') return null;
  if (harte === 'N') return [ROOT_N_INDEX, QUALITY_N_INDEX, BASS_N_INDEX];
  if (harte === 'X') return null;

  let bassTok: string | null = null;
  const slash = harte.indexOf('/');
  if (slash >= 0) {
    bassTok = harte.slice(slash + 1);
    harte = harte.slice(0, slash);
  }

  const [body, extras] = stripParens(harte);
  const colon = body.indexOf(':');
  const rootStr = colon >= 0 ? body.slice(0, colon) : body;
  const shorthand = colon >= 0 ? body.slice(colon + 1) : '';

  const rootPc = parseRootPc(rootStr);
  if (rootPc === null) return null;

  let bassIdx = BASS_SAME_INDEX;
  if (bassTok !== null) {
    const semis = parseInterval(bassTok);
    bassIdx = semis === null || semis === 0 ? BASS_SAME_INDEX : semis;
  }

  let quality: string | null = null;
  const noExtras = extras.length === 0;
  const add9 = extrasEq(extras, '9') || extrasEq(extras, 'add9');
  const add11 = extrasEq(extras, '11') || extrasEq(extras, 'add11');
  if (shorthand === '' && noExtras) quality = 'maj';
  else if (has(FACTORED_SHORTHAND_EXACT, shorthand) && noExtras)
    quality = FACTORED_SHORTHAND_EXACT[shorthand];
  else if (shorthand === 'maj' && add9) quality = 'add9';
  else if (shorthand === 'maj' && add11) quality = 'add11';
  else if (shorthand === 'maj' && extrasEq(extras, '13')) quality = '13';
  else if (shorthand === 'maj6' && add9) quality = 'add6';
  else if (shorthand === 'aug' && extrasEq(extras, 'b7')) quality = 'aug7';
  else if (shorthand === '7') quality = '7';
  else if (has(FACTORED_SHORTHAND_EXACT, shorthand)) quality = FACTORED_SHORTHAND_EXACT[shorthand];
  else if (has(FACTORED_LOSSY_FALLBACK, shorthand)) quality = FACTORED_LOSSY_FALLBACK[shorthand];
  else if (shorthand === '1') quality = '5';
  else return null;

  const qualityIdx = (QUALITY_LABELS as readonly string[]).indexOf(quality);
  if (qualityIdx < 0) return null;
  return [rootPc, qualityIdx, bassIdx];
}

/**
 * Decode (root, quality, bass) to a Harte string. Throws RangeError on
 * out-of-range or degenerate input, exactly where Python raises ValueError.
 */
export function decodeFactored(rootIdx: number, qualityIdx: number, bassIdx: number): string {
  if (!Number.isInteger(rootIdx) || rootIdx < 0 || rootIdx > ROOT_N_INDEX)
    throw new RangeError(`rootIdx ${rootIdx} out of range [0, ${ROOT_N_INDEX}]`);
  if (!Number.isInteger(qualityIdx) || qualityIdx < 0 || qualityIdx >= N_QUALITY)
    throw new RangeError(`qualityIdx ${qualityIdx} out of range [0, ${N_QUALITY})`);
  if (!Number.isInteger(bassIdx) || bassIdx < 0 || bassIdx >= N_BASS)
    throw new RangeError(`bassIdx ${bassIdx} out of range [0, ${N_BASS})`);

  if (qualityIdx === QUALITY_N_INDEX) return 'N';
  if (rootIdx === ROOT_N_INDEX)
    throw new RangeError('rootIdx ROOT_N_INDEX requires qualityIdx === QUALITY_N_INDEX');

  const label = `${ROOTS[rootIdx]}:${QUALITY_LABELS[qualityIdx]}`;
  if (bassIdx === BASS_SAME_INDEX || bassIdx === BASS_N_INDEX) return label;
  return `${label}/${SEMITONES_TO_HARTE[bassIdx]}`;
}
