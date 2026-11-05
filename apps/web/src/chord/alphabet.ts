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

// ─── Compat exports consumed by PR-Y1.6 (ChordOverlay + chordnet-session) ───
// Added when merging PR #85 forward onto PR #79's alphabet shape.

/** Alias of NUM_LABELS. Preserved for ChordOverlay/chordnet-session callers. */
export const N_CHORD_CLASSES = NUM_LABELS;

/** Alias of labelAt — the chord label for a class index. */
export function chordLabel(cls: number): string {
  return labelAt(cls);
}

/**
 * Return up to k nearest chord class indices to `forCls` in the alphabet,
 * excluding forCls itself. "Nearest" is defined as:
 *   1. same root, different quality (closest — rotation inside the 5 qualities)
 *   2. same quality, neighbouring roots (±1, ±2, ±5, ±7 semitones — fifths/fourths first)
 * Falls back to filling from wrap-around indices if fewer than k are available.
 *
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
  // 1. Same root, other qualities
  for (let q = 0; q < nQualities && out.length < k; q++) {
    if (q !== qualIdx) push(rootIdx * nQualities + q);
  }
  // 2. Same quality, by harmonic distance (±5=P4, ±7=P5, ±2=M2, ±1=m2)
  const deltas = [5, 7, -5, -7, 2, -2, 1, -1, 3, -3, 4, -4, 6, -6];
  for (const d of deltas) {
    if (out.length >= k) break;
    const r = ((rootIdx + d) % 12 + 12) % 12;
    push(r * nQualities + qualIdx);
  }
  // 3. Fall back to other quality-at-neighbour-root to top up
  for (let d = 1; d < 12 && out.length < k; d++) {
    for (const sign of [1, -1]) {
      const r = ((rootIdx + sign * d) % 12 + 12) % 12;
      for (let q = 0; q < nQualities && out.length < k; q++) {
        if (q === qualIdx) continue;
        push(r * nQualities + q);
      }
    }
  }
  return out.slice(0, k);
}
