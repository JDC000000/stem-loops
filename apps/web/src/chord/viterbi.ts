// PR-Y1.5a DEP STUB — replace on merge
// -------------------------------------
// PR-Y1.5a (in flight) ships the real Viterbi forward-only decoder (O(T*N))
// with backtrack over the HMM transition matrix, plus the `smoothChordSequence`
// entry point used by the overlay. This placeholder gives PR-Y1.6 enough
// surface to run the pipeline end-to-end against the stub model.
//
// The output shape and semantics match the Y1.5a contract so callers do not
// need to change when Y1.5a lands — only this file is replaced.
//
// Decision record: claude/phase-2-y1-chord-model-decision.md v1.3 §Decoder.

import { N_CHORD_CLASSES } from './alphabet.ts';
import { logTransitionMatrix } from './transition.ts';

export interface SmoothedChordFrame {
  /** Class index in [0, N_CHORD_CLASSES). */
  cls: number;
  /** Frame index (0-based). */
  frame: number;
  /** Log-probability of this frame under the best path. */
  logProb: number;
}

/**
 * Viterbi decode of per-frame logits.
 *
 * @param logits Float32Array of length T*N (row-major, T frames × N classes).
 * @param nFrames T.
 * @param nClasses N (defaults to the 60-class alphabet).
 * @returns Array of {cls, frame, logProb} in frame order.
 */
export function smoothChordSequence(
  logits: Float32Array,
  nFrames: number,
  nClasses: number = N_CHORD_CLASSES,
): SmoothedChordFrame[] {
  if (nFrames <= 0) return [];
  if (logits.length !== nFrames * nClasses) {
    throw new Error(
      `logits length ${logits.length} != nFrames*nClasses ${nFrames * nClasses}`,
    );
  }
  const trans = logTransitionMatrix(nClasses);

  // dp[t * N + c] = best log-prob of a path ending in class c at frame t.
  const dp = new Float32Array(nFrames * nClasses);
  // bp[t * N + c] = argmax class at frame t-1 that produced dp[t,c].
  const bp = new Int32Array(nFrames * nClasses);

  // Frame 0: uniform prior → dp[0,c] = logits[0,c] + log(1/N)
  const uniform = Math.log(1 / nClasses);
  for (let c = 0; c < nClasses; c++) {
    dp[c] = logits[c] + uniform;
    bp[c] = -1;
  }

  for (let t = 1; t < nFrames; t++) {
    const prevBase = (t - 1) * nClasses;
    const curBase = t * nClasses;
    for (let c = 0; c < nClasses; c++) {
      let best = -Infinity;
      let argBest = 0;
      for (let p = 0; p < nClasses; p++) {
        const score = dp[prevBase + p] + trans[p * nClasses + c];
        if (score > best) {
          best = score;
          argBest = p;
        }
      }
      dp[curBase + c] = best + logits[curBase + c];
      bp[curBase + c] = argBest;
    }
  }

  // Backtrack from the best class at the last frame.
  const lastBase = (nFrames - 1) * nClasses;
  let bestLast = 0;
  let bestLastScore = dp[lastBase];
  for (let c = 1; c < nClasses; c++) {
    if (dp[lastBase + c] > bestLastScore) {
      bestLastScore = dp[lastBase + c];
      bestLast = c;
    }
  }

  const out: SmoothedChordFrame[] = new Array(nFrames);
  let cur = bestLast;
  for (let t = nFrames - 1; t >= 0; t--) {
    out[t] = { cls: cur, frame: t, logProb: dp[t * nClasses + cur] };
    if (t > 0) cur = bp[t * nClasses + cur];
  }
  return out;
}
