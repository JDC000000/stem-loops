<<<<<<< HEAD
// PR-Y1.5a DEP STUB — replace on merge
// -------------------------------------
// PR-Y1.5a (in flight on another agent) ships the canonical 60-class Harte
// chord alphabet with its full catalogue of qualities, root enharmonic
// handling, and the "no-chord" sentinel. This file is a minimal placeholder
// that gives PR-Y1.6 (Variant Y browser integration) enough surface to
// compile and test end-to-end against the stub ONNX. When Y1.5a lands this
// file is DELETED and callers pick up the real module at the same path —
// imports do not change.
//
// Scope of the placeholder: 12 roots × 5 qualities + "N" (no-chord) = 61
// labels; we trim to 60 to match the stub model's output head width. The
// Harte formatter is a straight concatenation ("C:maj"); Y1.5a's version
// understands shorthand and inversions and must replace this.
//
// Decision record: claude/phase-2-y1-chord-model-decision.md v1.3 §Alphabet.

export const CHORD_ROOTS = [
=======
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
>>>>>>> origin/v3/main
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
<<<<<<< HEAD
] as const;

export type ChordRoot = (typeof CHORD_ROOTS)[number];

// Quality set chosen to match the stub head (60 classes = 12 roots × 5
// qualities). Y1.5a will replace with the decision-record quality set.
export const CHORD_QUALITIES = ['maj', 'min', '7', 'maj7', 'min7'] as const;

export type ChordQuality = (typeof CHORD_QUALITIES)[number];

export const N_CHORD_CLASSES = CHORD_ROOTS.length * CHORD_QUALITIES.length; // 60

/** Harte-shorthand label for a class index in [0, N_CHORD_CLASSES). */
export function chordLabel(idx: number): string {
  if (!Number.isInteger(idx) || idx < 0 || idx >= N_CHORD_CLASSES) {
    throw new RangeError(
      `chord index ${idx} out of range [0, ${N_CHORD_CLASSES})`,
    );
  }
  const root = CHORD_ROOTS[Math.floor(idx / CHORD_QUALITIES.length)];
  const qual = CHORD_QUALITIES[idx % CHORD_QUALITIES.length];
  return `${root}:${qual}`;
}

/**
 * Nearest-neighbour classes by root distance for the chord-edit popover.
 * Y1.5a replaces with a real Harte distance; this is a simple circle-of-roots
 * tie-breaker so the UI has something sensible to show.
 */
export function nearestChords(idx: number, k = 10): number[] {
  if (!Number.isInteger(idx) || idx < 0 || idx >= N_CHORD_CLASSES) {
    throw new RangeError(`chord index ${idx} out of range`);
  }
  const rootIdx = Math.floor(idx / CHORD_QUALITIES.length);
  const qualIdx = idx % CHORD_QUALITIES.length;
  const scored: Array<{ cls: number; d: number }> = [];
  for (let r = 0; r < CHORD_ROOTS.length; r++) {
    const rd = Math.min(
      (r - rootIdx + 12) % 12,
      (rootIdx - r + 12) % 12,
    );
    for (let q = 0; q < CHORD_QUALITIES.length; q++) {
      const cls = r * CHORD_QUALITIES.length + q;
      if (cls === idx) continue;
      const qd = q === qualIdx ? 0 : 1;
      scored.push({ cls, d: rd * 10 + qd });
    }
  }
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, k).map((s) => s.cls);
=======
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
>>>>>>> origin/v3/main
}
