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
}
