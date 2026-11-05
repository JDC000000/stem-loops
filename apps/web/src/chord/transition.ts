// PR-Y1.5a DEP STUB — replace on merge
// -------------------------------------
// PR-Y1.5a (in flight) ships the real log-transition matrix for the Viterbi
// decoder (self-loop bias + music-theoretic transitions). This placeholder
// gives PR-Y1.6 enough to compile and run the end-to-end pipeline against
// the stub model. Delete on Y1.5a merge — imports keep the same path.
//
// Decision record: claude/phase-2-y1-chord-model-decision.md v1.3 §Decoder.

import { N_CHORD_CLASSES } from './alphabet.ts';

/** Log-probability self-loop bias (stickiness). Y1.5a tunes against eval. */
export const SELF_LOOP_LOG_BIAS = Math.log(10);

/**
 * (N, N) log-transition matrix. Placeholder: uniform off-diagonal with a
 * self-loop bias. Returns a Float32Array of length N*N indexed as row*N+col.
 */
export function logTransitionMatrix(
  nClasses: number = N_CHORD_CLASSES,
): Float32Array {
  const m = new Float32Array(nClasses * nClasses);
  const offDiag = Math.log(1 / nClasses);
  const diag = offDiag + SELF_LOOP_LOG_BIAS;
  for (let i = 0; i < nClasses; i++) {
    for (let j = 0; j < nClasses; j++) {
      m[i * nClasses + j] = i === j ? diag : offDiag;
    }
  }
  return m;
}
