// PR-Y1.5a DEP STUB — replace on merge
// -------------------------------------
// PR-Y1.5a (in flight) ships the final-pass smoother: run-length collapse +
// min-duration filter on top of the Viterbi output so the overlay does not
// flicker on single-frame glitches. This placeholder gives PR-Y1.6 enough
// surface; the output type matches Y1.5a's contract.
//
// Decision record: claude/phase-2-y1-chord-model-decision.md v1.3 §Decoder.

import type { SmoothedChordFrame } from './viterbi.ts';

export interface ChordRun {
  /** Chord class index in [0, N_CHORD_CLASSES). */
  cls: number;
  /** Inclusive start frame. */
  startFrame: number;
  /** Exclusive end frame. */
  endFrame: number;
}

/** Collapse a per-frame chord sequence into {start,end} runs. */
export function collapseRuns(seq: SmoothedChordFrame[]): ChordRun[] {
  if (seq.length === 0) return [];
  const runs: ChordRun[] = [];
  let startFrame = seq[0].frame;
  let cur = seq[0].cls;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].cls !== cur) {
      runs.push({ cls: cur, startFrame, endFrame: seq[i].frame });
      cur = seq[i].cls;
      startFrame = seq[i].frame;
    }
  }
  runs.push({ cls: cur, startFrame, endFrame: seq[seq.length - 1].frame + 1 });
  return runs;
}
