// Pure helpers for the ChordOverlay React component.
//
// Factored into its own `.ts` file so Node's --experimental-strip-types
// can load it without touching the `.tsx` (which Node refuses). Keeping
// behaviour testable without jsdom is the point of this split.

import { nearestChords } from '../chord/alphabet.ts';
import type { ChordRun } from '../chord/smoother.ts';

export interface ChordEdit {
  startFrame: number;
  endFrame: number;
  originalCls: number;
  newCls: number;
  timestampMs: number;
}

/** Build the ChordEdit payload the overlay forwards to `onChordEdit`. */
export function buildChordEdit(
  run: ChordRun,
  newCls: number,
  now: () => number = Date.now,
): ChordEdit {
  return {
    startFrame: run.startFrame,
    endFrame: run.endFrame,
    originalCls: run.cls,
    newCls,
    timestampMs: now(),
  };
}

/** Alternatives shown in the chord-edit popover. Hard-cap at 10 per decision record. */
export function popoverAlternatives(forCls: number, k = 10): number[] {
  return nearestChords(forCls, k);
}
