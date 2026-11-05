// High-level wrapper: feed raw chord labels (e.g. per-beat output from
// Klangio) through the Viterbi decoder with the music-theory transition
// matrix, and get back temporally smoothed labels.
//
// Role (H-3 hedge, phase-2 Y1 pre-mortem): if the CRF head of the trained
// chord model can't be exported to ONNX, smoothChordSequence is the JS-side
// replacement. It also cleans the current Klangio code path's per-beat
// outputs, which arrive unsmoothed.

import { labelIndex, labelAt, chordLabel, NUM_LABELS } from './alphabet.ts';
import {
  buildTransition,
  defaultTransition,
  DEFAULT_SELF_PROB,
  DEFAULT_DIATONIC_PROB,
  DEFAULT_UNRELATED_PROB,
} from './transition.ts';
import { viterbi } from './viterbi.ts';

// Harte-shape detector used by the T5 passthrough branch: a valid-shape chord
// label starts with a diatonic letter, optional accidental, and optional
// `:quality` suffix. Matches Klangio's full output vocabulary (dim, aug,
// sus2/4, maj6, min6, dim7, hdim7, minmaj7, bare-root triads), NOT N/X, and
// NOT garbage like "XYZZY". See T5 of y1-test-coverage-audit.md.
const CHORD_SHAPE_RE = /^[A-G](#|b)?(:[a-z0-9]+)?$/;

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
      // Observation outside the 60-label alphabet.
      //
      // T5 fix (y1-test-coverage-audit.md): if the token has the SHAPE of a
      // chord label (root + optional accidental + optional :quality) — e.g.
      // Klangio emits C:dim, F:aug, G:sus4, A:maj6, D:min6, bare-root triads
      // — preserve it. The 60-label Viterbi only smooths within its own
      // vocabulary; rewriting one of these to a neighbouring major/minor is
      // strictly worse than preserving the provider's call.
      //
      // For any other non-chord-shaped token (genuine garbage like "XYZZY")
      // the old behaviour stands: emit uniform, let Viterbi's transition
      // prior pick a neighbour.
      if (CHORD_SHAPE_RE.test(raw)) {
        passthrough[t] = raw;
      }
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

// ────────────────────────── ChordOverlay plumbing ──────────────────────────
// PR-Y1.6 — the live chord overlay consumes raw ChordNet logits (Float32,
// row-major nFrames × NUM_LABELS) and wants a run-length-encoded timeline.
// These helpers live in smoother.ts because the smoothing + run-length pass
// is the composed operation callers want to import together.

/**
 * A run-length segment of the smoothed chord stream.
 *
 * - `startFrame` inclusive, `endFrame` exclusive (half-open, same as the
 *   iteration invariant in `collapseRuns`).
 * - `startSec`/`endSec` are `frame * frameSec`, where `frameSec` is the
 *   seconds-per-hop at inference time (= cqtPlan.hop / cqtPlan.sr).
 * - `label` is `chordLabel(chordClass)` — pre-computed so render code can
 *   pass it straight to `<span>{run.label}</span>` without re-calling into
 *   the alphabet module.
 */
export interface ChordRun {
  /** Inclusive first frame index. */
  startFrame: number;
  /** Exclusive last frame index (so `endFrame - startFrame` = run length). */
  endFrame: number;
  /** Inclusive start time in seconds (= startFrame * frameSec). */
  startSec: number;
  /** Exclusive end time in seconds (= endFrame * frameSec). */
  endSec: number;
  /** Chord class index in the 60-label alphabet [0, NUM_LABELS). */
  chordClass: number;
  /** `chordLabel(chordClass)` — the Harte label for render. */
  label: string;
}

/**
 * Run-length-encode a per-frame chord class sequence.
 *
 * Adjacent frames with the same `chordClass` collapse into one `ChordRun`.
 * `frameSec` is the seconds-per-hop at inference time — the caller must
 * compute this from the CQT plan (`plan.hop / plan.sr`) so startSec/endSec
 * are meaningful across different sample rates / hop lengths.
 *
 * Empty input → empty output (no error). Works on both `number[]` and
 * `Uint16Array` (what Viterbi returns) via the ArrayLike<number> shape.
 */
export function collapseRuns(
  chordClasses: ArrayLike<number>,
  frameSec: number,
): ChordRun[] {
  const n = chordClasses.length;
  if (n === 0) return [];
  const runs: ChordRun[] = [];
  let runStart = 0;
  // Walk one past the end to flush the final run without duplicating logic.
  for (let i = 1; i <= n; i++) {
    if (i === n || chordClasses[i] !== chordClasses[runStart]) {
      const cls = chordClasses[runStart];
      runs.push({
        startFrame: runStart,
        endFrame: i,
        startSec: runStart * frameSec,
        endSec: i * frameSec,
        chordClass: cls,
        label: chordLabel(cls),
      });
      runStart = i;
    }
  }
  return runs;
}

/**
 * Smooth raw per-frame logits (ChordNet output) into chord class indices.
 *
 * Shape: `logits` is row-major `nFrames × NUM_LABELS`. Returns a `Uint16Array`
 * of length `nFrames` whose values are the Viterbi best-path chord-class
 * indices. Degenerate inputs (`nFrames === 0`) return an empty array.
 *
 * Why this exists in smoother.ts rather than the component: the overlay
 * calls this once per captured audio chunk, and having smoothing +
 * collapseRuns imported from the same module makes the pipeline obvious at
 * the call site. See ChordOverlay.tsx for the full pipeline.
 */
export function smoothChordLogits(
  logits: Float32Array,
  nFrames: number,
): Uint16Array {
  if (nFrames <= 0) return new Uint16Array(0);
  // Use the cached default transition prior — same music-theory priors as
  // smoothChordSequence (self=0.95, diatonic=0.01, unrelated=0.001).
  const transition = defaultTransition();
  const { path } = viterbi({
    logits,
    nFrames,
    nStates: NUM_LABELS,
    transition,
  });
  return path;
}
