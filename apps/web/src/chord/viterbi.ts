<<<<<<< HEAD
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
=======
// Viterbi decoder — pure TS, zero deps, typed-array first.
//
// Why this exists: H-3 hedge from phase-2 y1 pre-mortem — if torch.onnx.export
// on the CRF-structured chord model fails, we smooth chord labels on the JS side
// with this classical Viterbi. Also cleans Klangio per-beat outputs for free.
//
// Shape: logits are flat (nFrames * nStates) row-major so they drop in straight
// from an ORT-Web Float32 tensor with no copy. Everything lives in the log
// domain to stay numerically sane across long sequences.

export interface ViterbiInput {
  /** Flat logits, row-major (nFrames * nStates). Interpreted as log-probs or
   *  unnormalised log-scores — Viterbi only cares about relative ordering. */
  logits: Float32Array;
  nFrames: number;
  nStates: number;
  /** Row-major (nStates * nStates), log-prob of state i -> state j at
   *  [i * nStates + j]. */
  transition: Float32Array;
  /** Optional log-prior over starting states (length nStates). Uniform if omitted. */
  startProb?: Float32Array;
}

export interface ViterbiOutput {
  /** Decoded best-path state per frame. */
  path: Uint16Array;
  /** Total log-probability of the best path. */
  score: number;
}

/**
 * Standard DP Viterbi.
 *  - Time: O(T * S^2)
 *  - Memory: 2 x rolling score vectors (S floats) + full backpointer matrix (T*S uint16).
 *  - Backpointers are Uint16Array so S must be <= 65_535 (we live well under).
 *
 * Degenerate inputs are returned as empty/zero rather than throwing — the
 * caller is often a wrapper (smoother.ts) that may feed an empty slice.
 */
export function viterbi(input: ViterbiInput): ViterbiOutput {
  const { logits, nFrames, nStates, transition, startProb } = input;

  if (nFrames <= 0 || nStates <= 0) {
    return { path: new Uint16Array(0), score: 0 };
  }
  if (logits.length !== nFrames * nStates) {
    throw new Error(
      `viterbi: logits length ${logits.length} != nFrames*nStates ${nFrames * nStates}`,
    );
  }
  if (transition.length !== nStates * nStates) {
    throw new Error(
      `viterbi: transition length ${transition.length} != nStates^2 ${nStates * nStates}`,
    );
  }
  if (startProb && startProb.length !== nStates) {
    throw new Error(
      `viterbi: startProb length ${startProb.length} != nStates ${nStates}`,
    );
  }

  // Uniform log-prior if none supplied.
  const logUniform = Math.log(1 / nStates);

  // Rolling score vectors — only need t and t-1.
  let prev = new Float32Array(nStates);
  let curr = new Float32Array(nStates);
  const back = new Uint16Array(nFrames * nStates);

  // t = 0
  for (let s = 0; s < nStates; s++) {
    const pi = startProb ? startProb[s] : logUniform;
    prev[s] = pi + logits[s];
  }

  // t >= 1
  for (let t = 1; t < nFrames; t++) {
    const frameOff = t * nStates;
    for (let j = 0; j < nStates; j++) {
      // Find argmax_i (prev[i] + transition[i -> j]).
      let bestI = 0;
      let bestVal = prev[0] + transition[j]; // i=0 -> j at [0*S + j]
      for (let i = 1; i < nStates; i++) {
        const v = prev[i] + transition[i * nStates + j];
        if (v > bestVal) {
          bestVal = v;
          bestI = i;
        }
      }
      curr[j] = bestVal + logits[frameOff + j];
      back[frameOff + j] = bestI;
    }
    // Swap rolling buffers.
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  // Terminate: pick the best state at the final frame.
  let endBest = 0;
  let endScore = prev[0];
  for (let s = 1; s < nStates; s++) {
    if (prev[s] > endScore) {
      endScore = prev[s];
      endBest = s;
    }
  }

  // Backtrack.
  const path = new Uint16Array(nFrames);
  path[nFrames - 1] = endBest;
  for (let t = nFrames - 1; t > 0; t--) {
    path[t - 1] = back[t * nStates + path[t]];
  }

  return { path, score: endScore };
>>>>>>> origin/v3/main
}
