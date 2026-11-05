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
}
