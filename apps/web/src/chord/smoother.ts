// High-level wrapper: feed raw chord labels (e.g. per-beat output from
// Klangio) through the Viterbi decoder with the music-theory transition
// matrix, and get back temporally smoothed labels.
//
// Role (H-3 hedge, phase-2 Y1 pre-mortem): if the CRF head of the trained
// chord model can't be exported to ONNX, smoothChordSequence is the JS-side
// replacement. It also cleans the current Klangio code path's per-beat
// outputs, which arrive unsmoothed.

import { labelIndex, labelAt, NUM_LABELS } from './alphabet.ts';
import {
  buildTransition,
  DEFAULT_SELF_PROB,
  DEFAULT_DIATONIC_PROB,
  DEFAULT_UNRELATED_PROB,
} from './transition.ts';
import { viterbi } from './viterbi.ts';

/** Floor to keep log(0) out of the emission tensor. 1e-6 is deep enough that
 *  a high-confidence label dominates, shallow enough that reciprocal
 *  cases (confidence ~ 1/60) stay numerically useful. */
const EPS = 1e-6;

/** Clamp a confidence into (EPS, 1 - EPS) to keep logs finite on both ends. */
function clampConf(c: number): number {
  if (!Number.isFinite(c)) return 1 - EPS;
  if (c < EPS) return EPS;
  if (c > 1 - EPS) return 1 - EPS;
  return c;
}

/**
 * Smooth a sequence of raw chord labels with a Viterbi decoder.
 *
 * - `rawLabels[i]` is the per-frame prediction (Harte form: "C:maj", "G:7",
 *    "A:min7"). N and X are passed through unchanged (they are outside the
 *    60-label alphabet and carry no chord identity to smooth).
 * - `confidences[i]` (optional, defaults to 1.0) scales the emission weight.
 *    A low confidence lets the transition prior override the raw pick.
 * - `stickiness` (optional, defaults to {@link DEFAULT_SELF_PROB} = 0.95) is
 *    the self-transition prior. Higher = more aggressive smoothing. The
 *    diatonic and unrelated priors are scaled inversely so the gap between
 *    staying and switching actually widens with stickiness (naively raising
 *    self_prob alone leaves the ratio self/diatonic unchanged, so Viterbi
 *    behaviour barely moves).
 *
 * Output is always in canonical Harte form (sharp spellings only).
 */
export function smoothChordSequence(
  rawLabels: string[],
  confidences?: number[],
  stickiness?: number,
): string[] {
  const n = rawLabels.length;
  if (n === 0) return [];
  if (confidences && confidences.length !== n) {
    throw new Error(
      `smoothChordSequence: confidences length ${confidences.length} != rawLabels length ${n}`,
    );
  }

  const selfP = stickiness ?? DEFAULT_SELF_PROB;
  // Scale non-self priors so the "switch cost" moves with stickiness.
  // At the default (selfP == DEFAULT_SELF_PROB) this collapses to the
  // documented defaults; at selfP = 0.5 non-self priors are ~10x larger
  // (easier to switch); at selfP = 0.999 they shrink ~50x (very sticky).
  const scale = (1 - selfP) / (1 - DEFAULT_SELF_PROB);
  const transition = buildTransition({
    selfProb: selfP,
    diatonicProb: DEFAULT_DIATONIC_PROB * scale,
    unrelatedProb: DEFAULT_UNRELATED_PROB * scale,
  });

  // Build emission logits. For each frame:
  //   - If the raw label is in the 60-label alphabet, emit log(conf) at that
  //     index and log((1 - conf) / (S - 1)) elsewhere (floored at log(EPS)).
  //   - If the raw label is N, X, or unknown, emit a uniform log-prior so the
  //     transition prior drives the pick at that frame.
  const logits = new Float32Array(n * NUM_LABELS);
  // Track frames where the smoothed output should be forced back to the raw
  // sentinel label (N, X) rather than taking Viterbi's chord pick.
  const passthrough: (string | null)[] = new Array(n).fill(null);

  const logUniform = Math.log(1 / NUM_LABELS);

  for (let t = 0; t < n; t++) {
    const raw = rawLabels[t];
    const off = t * NUM_LABELS;
    if (raw === 'N' || raw === 'X') {
      passthrough[t] = raw;
      for (let s = 0; s < NUM_LABELS; s++) logits[off + s] = logUniform;
      continue;
    }
    const idx = labelIndex(raw);
    if (idx < 0) {
      // Unknown label — pass through to uniform, but don't force-replace
      // the Viterbi pick, since the caller clearly meant *some* chord.
      for (let s = 0; s < NUM_LABELS; s++) logits[off + s] = logUniform;
      continue;
    }
    const conf = clampConf(confidences ? confidences[t] : 1);
    const logCorrect = Math.log(conf);
    const logOther = Math.log(Math.max((1 - conf) / (NUM_LABELS - 1), EPS));
    for (let s = 0; s < NUM_LABELS; s++) {
      logits[off + s] = s === idx ? logCorrect : logOther;
    }
  }

  const { path } = viterbi({
    logits,
    nFrames: n,
    nStates: NUM_LABELS,
    transition,
  });

  const out: string[] = new Array(n);
  for (let t = 0; t < n; t++) {
    const forced = passthrough[t];
    out[t] = forced !== null ? forced : labelAt(path[t]);
  }
  return out;
}
