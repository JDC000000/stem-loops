// 60-label Harte chord alphabet (phase-2 Y1 decision record v1.3).
//
// 12 roots x 5 qualities = 60 labels, indexed 0..59.
//
// Layout (so labelIndex is pure arithmetic):
//   idx = rootIndex * 5 + qualityIndex
// Roots in semitone order from C using sharps as the canonical accidental:
//   C, C#, D, D#, E, F, F#, G, G#, A, A#, B
// Qualities in the fixed order:
//   maj, min, 7, maj7, min7
//
// N (no-chord) and X (unknown) are NOT in the 60-label alphabet — they are
// outer symbols the smoother treats specially. `isValidHarte` accepts N and X
// alongside the 60 labels; `labelIndex` does not (returns -1 for them).
//
// TODO (PR-Y1.7): generate this file from `apps/training/model/alphabet.py`
// (PR-Y1.4) so the Python training vocab and the JS runtime vocab cannot drift.
// Until then, if you change this file you MUST update alphabet.py in lockstep,
// and vice versa.

export const ROOTS = Object.freeze([
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const);

export const QUALITIES = Object.freeze([
  'maj',
  'min',
  '7',
  'maj7',
  'min7',
] as const);

export type Root = (typeof ROOTS)[number];
export type Quality = (typeof QUALITIES)[number];

/** The 60 canonical Harte labels, in index order (0 = "C:maj", 59 = "B:min7"). */
export const labels: readonly string[] = Object.freeze(
  ROOTS.flatMap((r) => QUALITIES.map((q) => `${r}:${q}`)),
);

export const NUM_LABELS = labels.length; // 60

const LABEL_TO_INDEX: ReadonlyMap<string, number> = new Map(
  labels.map((l, i) => [l, i] as const),
);

// Enharmonic normalisation: map flat spellings back to the canonical sharp.
// Harte notation sometimes emits flats ("Bb:7"); we accept them on input but
// always produce sharps on output.
const ENHARMONIC: Readonly<Record<string, Root>> = Object.freeze({
  Db: 'C#',
  Eb: 'D#',
  Gb: 'F#',
  Ab: 'G#',
  Bb: 'A#',
  // Edge enharmonics occasionally produced by analysis tools.
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
 * Index of a Harte label in the 60-label alphabet, or -1 if not present.
 * Accepts flat spellings on input ("Bb:7" -> 59? no, "A#:7" index).
 * Does NOT accept "N" or "X" (they are outside the alphabet; use isValidHarte).
 */
export function labelIndex(harte: string): number {
  if (typeof harte !== 'string' || harte.length === 0) return -1;
  const colon = harte.indexOf(':');
  if (colon < 0) return -1;
  const rootRaw = harte.slice(0, colon);
  const quality = harte.slice(colon + 1);
  const root = canonicalRoot(rootRaw);
  if (!root) return -1;
  const canonical = `${root}:${quality}`;
  const idx = LABEL_TO_INDEX.get(canonical);
  return idx === undefined ? -1 : idx;
}

/**
 * True for any of the 60 Harte labels OR the sentinel labels N and X.
 * (Accepts flat spellings via `labelIndex`.)
 */
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
