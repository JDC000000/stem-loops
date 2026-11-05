// 60x60 chord-transition matrix for the Viterbi smoother.
//
// Music-theory priors (phase-2 Y1 decision record v1.3):
//   - self (same root AND same quality):                      0.95
//   - diatonic (root interval in a major/minor scale):        0.01
//   - unrelated (semitone / tritone / major-7th away):        0.001
//   - to/from N/X sentinel:                                   0.005 (handled
//       inside smoother.ts; matrix itself is strictly over the 60 labels)
//
// Rows are normalised so each row's exp sums to 1 — the task spec requires
// this, and it keeps Viterbi scores comparable across starting states.
// Stored as log-probabilities in a flat Float32Array (row-major, 60*60).

import { NUM_LABELS, ROOTS, QUALITIES } from './alphabet.ts';

const NUM_ROOTS = ROOTS.length; // 12
const NUM_QUALITIES = QUALITIES.length; // 5

/** Diatonic root intervals (semitones, 0..11). Same-root is included — a root
 *  staying fixed while the quality shifts (C:maj -> C:7) is a common move.
 *
 *  Every interval that is NOT {semitone, tritone, major-7th} = {1, 6, 11} is
 *  diatonic. This captures that chords near each other in the circle of
 *  fifths / relative minor-major pairs are the overwhelmingly common
 *  neighbours in pop/rock corpora (Mauch 2010, Ni 2012). */
const DIATONIC_INTERVALS: ReadonlySet<number> = new Set([0, 2, 3, 4, 5, 7, 8, 9, 10]);

export interface BuildTransitionOptions {
  /** Prior weight for self-transition (same root, same quality). */
  selfProb?: number;
  /** Prior weight for any diatonic non-self neighbour. */
  diatonicProb?: number;
  /** Prior weight for an unrelated (semitone / tritone / maj-7th) neighbour. */
  unrelatedProb?: number;
}

export const DEFAULT_SELF_PROB = 0.95;
export const DEFAULT_DIATONIC_PROB = 0.01;
export const DEFAULT_UNRELATED_PROB = 0.001;

/**
 * Build a row-normalised 60x60 log-prob transition matrix from music-theory
 * priors. Pure function — no I/O.
 */
export function buildTransition(opts: BuildTransitionOptions = {}): Float32Array {
  const selfP = opts.selfProb ?? DEFAULT_SELF_PROB;
  const diatonicP = opts.diatonicProb ?? DEFAULT_DIATONIC_PROB;
  const unrelatedP = opts.unrelatedProb ?? DEFAULT_UNRELATED_PROB;

  const M = new Float32Array(NUM_LABELS * NUM_LABELS);

  // 1) Fill with raw priors.
  for (let i = 0; i < NUM_LABELS; i++) {
    const iRoot = Math.floor(i / NUM_QUALITIES);
    const iQual = i % NUM_QUALITIES;
    for (let j = 0; j < NUM_LABELS; j++) {
      const jRoot = Math.floor(j / NUM_QUALITIES);
      const jQual = j % NUM_QUALITIES;
      const interval = (jRoot - iRoot + NUM_ROOTS) % NUM_ROOTS;
      let p: number;
      if (i === j) {
        p = selfP;
      } else if (DIATONIC_INTERVALS.has(interval)) {
        // Same root but different quality counts as diatonic (interval 0,
        // excluding self handled above).
        p = diatonicP;
      } else {
        p = unrelatedP;
      }
      M[i * NUM_LABELS + j] = p;
      // Suppress unused warning on jQual — reserved for future quality-
      // conditioned priors (e.g. maj7 -> min7 penalty).
      void jQual;
    }
    void iQual;
  }

  // 2) Row-normalise so sum = 1, then log.
  for (let i = 0; i < NUM_LABELS; i++) {
    let sum = 0;
    const off = i * NUM_LABELS;
    for (let j = 0; j < NUM_LABELS; j++) sum += M[off + j];
    const invSum = 1 / sum;
    for (let j = 0; j < NUM_LABELS; j++) {
      M[off + j] = Math.log(M[off + j] * invSum);
    }
  }

  return M;
}

/** Default transition matrix (cached). */
let CACHED_DEFAULT: Float32Array | null = null;
export function defaultTransition(): Float32Array {
  if (CACHED_DEFAULT === null) CACHED_DEFAULT = buildTransition();
  // Return a copy so callers mutating it don't poison the cache.
  return new Float32Array(CACHED_DEFAULT);
}

/**
 * Fetch a precomputed transition matrix from a .bin file (Float32Array,
 * row-major 60*60). Falls back to `defaultTransition()` on any error (network
 * failure, wrong byte length, etc.) — the smoother must never block on this.
 *
 * In Node/test contexts where `fetch` is absent, it falls back silently.
 */
export async function loadTransition(path: string): Promise<Float32Array> {
  try {
    if (typeof fetch !== 'function') return defaultTransition();
    const res = await fetch(path);
    if (!res.ok) return defaultTransition();
    const buf = await res.arrayBuffer();
    const expectedBytes = NUM_LABELS * NUM_LABELS * 4;
    if (buf.byteLength !== expectedBytes) return defaultTransition();
    // Copy so the caller owns a contiguous, aligned Float32Array.
    return new Float32Array(buf.slice(0));
  } catch {
    return defaultTransition();
  }
}
