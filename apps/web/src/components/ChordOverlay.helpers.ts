// Pure helpers for the ChordOverlay React component.
//
// Factored into its own `.ts` file so Node's --experimental-strip-types
// can load it without touching the `.tsx` (which Node refuses). Keeping
// behaviour testable without jsdom is the point of this split.

import {
  QUALITY_LABELS,
  decodeFactored,
  encodeFactored,
  labelIndex,
  nearestChords,
} from '../chord/alphabet.ts';
import type {
  ChordObservation,
  ChordUnavailableReason,
  PlayChordsResult,
} from '../chord/play-chords-loader.ts';

/** What a span means musically. 'none' = N (no chord), 'unknown' = X. */
export type RunKind = 'chord' | 'none' | 'unknown';

/**
 * One renderable span. The label STRING is what gets displayed; `chordClass`
 * is optional metadata (index in the flat 60-label HMM vocabulary) used only
 * by the chord-picker and the paused variant-Y smoother. It is null for any
 * label outside that vocabulary (slash chords, 9ths, sus, N, X, ...).
 */
export interface OverlayRun {
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
  label: string;
  kind: RunKind;
  chordClass: number | null;
}

export interface ChordEdit {
  startFrame: number;
  endFrame: number;
  originalCls: number | null;
  newCls: number;
  timestampMs: number;
}

// Frames/sec used to derive startFrame/endFrame for worker observations.
export const CHORDS_FRAMES_PER_SEC = 10;
// Default horizontal scale of the timeline: pixels per second of audio. Used as
// the default argument of the geometry helpers below.
export const PX_PER_SEC = 80;
/**
 * The FLOOR of the per-job zoom ceiling, and the cap on the MINIMUM zoom
 * (fitPxPerSec). It is NOT the maximum zoom any more -- see
 * zoomCeilingPxPerSec, which derives that from the job's own chord data.
 *
 * It used to be the maximum, and as a maximum it was underived: 80px/sec is
 * not a statement about any text. The derivation in readablePxPerSec exceeds
 * it whenever the typical run is under 0.982s, and a chord could not be read
 * at ANY zoom the slider reached once its run fell under ~0.52s -- one chord
 * per beat at 115bpm, which is ordinary music. Kept as the floor so that
 * raising the ceiling can only ever ADD zoom range to a job, never remove it.
 */
export const MAX_PX_PER_SEC = PX_PER_SEC;
// Below this container width the timeline switches from one horizontal strip to
// wrapped rows (a phone cannot show a readable strip; see layoutRows).
export const NARROW_BREAKPOINT_PX = 560;
// Wrapped view: seconds of audio per row at the default and the two extremes.
export const WRAP_DEFAULT_ROW_SEC = 8;
export const WRAP_MAX_ROW_SEC = 16;

/** Classify a Harte label: N -> 'none', X (or empty/blank) -> 'unknown'. */
export function classifyLabel(label: string): RunKind {
  const l = typeof label === 'string' ? label.trim() : '';
  if (l === 'N') return 'none';
  if (l === '' || l === 'X') return 'unknown';
  return 'chord';
}

/** Class index in the 60-label vocabulary, or null. Never -1. */
export function classIndexOrNull(label: string): number | null {
  const i = labelIndex(label);
  return i < 0 ? null : i;
}

/** Text shown on the chip: explicit symbols for N and X, label otherwise. */
export function displayText(run: Pick<OverlayRun, 'kind' | 'label'>): string {
  if (run.kind === 'none') return 'N.C.';
  if (run.kind === 'unknown') return '?';
  return run.label;
}

/** Accessible name, spelled out so N / X / chord are distinguishable. */
export function runAriaLabel(run: Pick<OverlayRun, 'kind' | 'label'>): string {
  if (run.kind === 'none') return 'No chord';
  if (run.kind === 'unknown') return 'Unknown chord';
  return `${run.label} \u2014 edit`;
}

// ---------------------------------------------------------------------------
// The monotone-runs invariant
// ---------------------------------------------------------------------------
//
// Several things in this file are only correct when the run list is sorted by
// `startSec` and no two runs overlap: `activeRunIndex`'s binary search (a
// binary search over an unsorted array is undefined by construction) and, with
// it, the O(1) hint fast path. The invariant used to be an ASSUMPTION stated in
// a comment. Nothing produced it: `toObservations` in play-chords-loader.ts
// copies the worker's `segments` array through in wire order without sorting or
// de-overlapping it, and the ChordSource contract in
// apps/worker/src/worker/chord_source.py requires neither. (The Klangio
// provider does repair its own rows today — see `_parse_klangio_response` —
// but that is one provider's behaviour, not the contract the web is handed, and
// `replicate` / `internal` are still unimplemented.)
//
// So the invariant is now PRODUCED, here, and carried on the array itself:
//
//   - `observationsToRuns` repairs its output into monotone, non-overlapping
//     order and marks it.
//   - `activeRunIndex` consults the `hint` ONLY on a marked array. On anything
//     else the hint is ignored outright, so it cannot change the answer even
//     for input that is not monotone at all.
//
// A marker on the array (rather than a per-call O(n) check) is what keeps the
// per-frame cost at O(1): one property read, no element reads. Deriving a new
// array (`.slice()`, `.filter()`, `.map()`) drops the mark, which costs the
// fast path and never correctness. Build runs with `observationsToRuns`, or
// call `markMonotoneRuns` when you have established the invariant yourself.

// Symbol.for, not Symbol(): several tests in this repo load modules twice (via
// transpile-to-data-URL), and a mark written by one module instance has to be
// readable by the other, or the fast path silently dies under test only.
const MONOTONE_RUNS = Symbol.for('stem-loops.chord.monotoneRuns');

/**
 * Assert, on the array, that it is sorted by `startSec` with no overlaps.
 * Only call this when that is actually true — it is a promise, not a check.
 */
export function markMonotoneRuns<T extends readonly Pick<OverlayRun, 'startSec' | 'endSec'>[]>(
  runs: T,
): T {
  try {
    Object.defineProperty(runs, MONOTONE_RUNS, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Frozen or otherwise sealed: no mark, so callers lose the fast path and
    // keep the right answer. Never a throw on a render path.
  }
  return runs;
}

/**
 * True if this exact array object carries the monotone-runs promise.
 *
 * An OWN-property check, deliberately. A plain `runs[MONOTONE_RUNS]` read walks
 * the prototype chain, so one `Object.defineProperty(Array.prototype, ...)`
 * anywhere in the page would mark EVERY array and put every run list back on
 * the hint fast path — re-opening the defect this whole mechanism exists to
 * close. Prototype pollution is needed to reach it, which makes it unlikely,
 * but this is the one read the correctness argument rests on, so it does not
 * get to be approximately right.
 */
export function hasMonotoneRunsMark(runs: readonly unknown[]): boolean {
  return (
    Object.prototype.hasOwnProperty.call(runs, MONOTONE_RUNS) &&
    (runs as unknown as Record<symbol, unknown>)[MONOTONE_RUNS] === true
  );
}

/**
 * Verify the invariant by inspection. O(n) — for tests and assertions, NOT for
 * the render path (that is what the mark is for).
 */
export function runsAreMonotone(
  runs: readonly Pick<OverlayRun, 'startSec' | 'endSec'>[],
): boolean {
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (!Number.isFinite(r.startSec) || !Number.isFinite(r.endSec)) return false;
    if (r.endSec < r.startSec) return false;
    if (i > 0 && r.startSec < runs[i - 1].endSec) return false;
  }
  return true;
}

/**
 * The same audit for the FRAME spans, which are a separate claim about the same
 * runs and were separately wrong before this PR. Split out rather than folded
 * into `runsAreMonotone` because most callers hold runs typed as
 * `Pick<OverlayRun, 'startSec' | 'endSec'>` and have no frames to check.
 */
export function runFramesAreMonotone(
  runs: readonly Pick<OverlayRun, 'startFrame' | 'endFrame'>[],
): boolean {
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (!Number.isInteger(r.startFrame) || !Number.isInteger(r.endFrame)) return false;
    if (r.endFrame < r.startFrame) return false;
    if (i > 0 && r.startFrame < runs[i - 1].endFrame) return false;
  }
  return true;
}

/**
 * Convert worker observations (seconds, Harte strings) into renderable runs.
 * EVERY observation yields a run; none is dropped — not for lacking a class
 * index, and not for arriving out of order or overlapping its neighbour.
 *
 * REPAIR, in this order, so the result always satisfies the monotone-runs
 * invariant above (and is marked as such):
 *   1. sort by `startSec`, ties broken by `endSec` — stable, so equal spans
 *      keep their wire order;
 *   2. clamp a negative or non-finite `startSec` to 0, and a `startSec` that is
 *      still behind its predecessor up to it;
 *   3. clamp `endSec` to at least `startSec` (a backwards span becomes
 *      zero-length rather than negative);
 *   4. trim an overlap by pulling the EARLIER run's `endSec` back to the later
 *      run's `startSec` — the same TRIM DIRECTION as `_parse_klangio_response`
 *      worker-side.
 *
 * The row policy deliberately does NOT match the worker's, and the difference
 * is worth knowing before you reason across the two. Python DROPS a row with a
 * bad shape, a non-finite time, `end <= 0`, `end <= start`, or a duplicate
 * start; this function KEEPS and clamps all five, because by the time data
 * reaches the browser the worker's artifact is the only copy and a user is
 * better served by a chip in the wrong shape than by a hole in the timeline.
 * Tie-breaking differs too: Python sorts stably on `start` alone, this sorts
 * ties by `endSec`, so on equal starts the SHORTER run is the one that
 * collapses. So `[[0,5,'C:maj'],[0,2,'G:maj']]` is one segment worker-side and
 * two runs here, the second zero-length.
 *
 * A run that was entirely swallowed by its predecessor becomes zero-length,
 * which `covers` already treats as covering no instant: it still renders as a
 * chip (nothing is dropped) but can never be the sounding chord. Chips and the
 * marker both derive from these repaired seconds, so overlapping worker data
 * can no longer draw chips on top of each other either.
 *
 * `startFrame`/`endFrame` are a faithful quantisation of the repaired seconds:
 * `round(sec * CHORDS_FRAMES_PER_SEC)`, with `endFrame` floored at `startFrame`
 * rather than at `startFrame + 1`. Because `round` is monotone and the repaired
 * seconds satisfy `prev.endSec <= next.startSec`, that gives the frame spans the
 * same invariant the seconds have — `runs[i].endFrame <= runs[i + 1].startFrame`
 * for every pair — which the old `startFrame + 1` floor broke for any run
 * shorter than half a frame, zero-length ones included: a run repaired to zero
 * seconds still claimed one frame, and that frame sat inside its successor's.
 *
 * This drops the previous "every run occupies at least one frame" floor. Nothing
 * reads these fields: `chord_edits` has no frame columns (migration 025 stores
 * `start_sec`/`end_sec`), neither `/api/chord-edits` nor `edit-collector.ts`
 * looks at them, and `onChordEdit` is unwired (see the header of
 * ChordOverlay.tsx). The seconds are what the collector would carry, and the
 * DB's `end_sec > start_sec` CHECK would reject a zero-length span there
 * anyway. So the floor was buying a shape no consumer wanted, at the cost of a
 * frame span that contradicted its own run.
 */
export function observationsToRuns(obs: readonly ChordObservation[]): OverlayRun[] {
  const ordered = obs
    .map((o, i) => ({ o, i }))
    .sort((a, b) => a.o.startSec - b.o.startSec || a.o.endSec - b.o.endSec || a.i - b.i)
    .map((e) => e.o);

  const out: OverlayRun[] = [];
  for (const o of ordered) {
    const prev = out.length > 0 ? out[out.length - 1] : null;
    const floor = prev ? prev.startSec : 0;
    const rawStart = Number.isFinite(o.startSec) ? o.startSec : 0;
    const startSec = Math.max(floor, rawStart, 0);
    const rawEnd = Number.isFinite(o.endSec) ? o.endSec : startSec;
    const endSec = Math.max(startSec, rawEnd);
    // Trim the predecessor rather than shifting this run: a chord's start time
    // is the thing a player reads off the timeline, so it is the one we keep.
    // Its frame span is re-derived from the trimmed seconds so the two never
    // disagree in a chord-edit payload.
    if (prev && prev.endSec > startSec) {
      prev.endSec = startSec;
      prev.endFrame = Math.max(
        prev.startFrame,
        Math.round(startSec * CHORDS_FRAMES_PER_SEC),
      );
    }

    const startFrame = Math.max(0, Math.round(startSec * CHORDS_FRAMES_PER_SEC));
    const endFrame = Math.max(startFrame, Math.round(endSec * CHORDS_FRAMES_PER_SEC));
    const kind = classifyLabel(o.label);
    out.push({
      startFrame,
      endFrame,
      startSec,
      endSec,
      label: o.label,
      kind,
      chordClass: kind === 'chord' ? classIndexOrNull(o.label) : null,
    });
  }
  return markMonotoneRuns(out);
}

export interface ChipBox {
  leftPx: number;
  widthPx: number;
}

/**
 * Absolute position of a chip from its real time span. Nothing here depends
 * on any other run, so a missing/unknown span cannot shift later chips.
 */
export function chipBox(run: Pick<OverlayRun, 'startSec' | 'endSec'>, pxPerSec = PX_PER_SEC): ChipBox {
  const start = Math.max(0, run.startSec);
  const end = Math.max(start, run.endSec);
  return { leftPx: start * pxPerSec, widthPx: (end - start) * pxPerSec };
}

/** Total timeline width in px (end of the last-ending run). */
export function timelineWidthPx(runs: readonly Pick<OverlayRun, 'endSec'>[], pxPerSec = PX_PER_SEC): number {
  let max = 0;
  for (const r of runs) if (r.endSec > max) max = r.endSec;
  return max * pxPerSec;
}

/** Build the ChordEdit payload the overlay forwards to `onChordEdit`. */
export function buildChordEdit(
  run: Pick<OverlayRun, 'startFrame' | 'endFrame' | 'chordClass'>,
  newCls: number,
  now: () => number = Date.now,
): ChordEdit {
  return {
    startFrame: run.startFrame,
    endFrame: run.endFrame,
    originalCls: run.chordClass,
    newCls,
    timestampMs: now(),
  };
}

/** Alternatives shown in the chord-edit popover. Hard-cap at 10 per decision record. */
export function popoverAlternatives(forCls: number | null | undefined, k = 10): number[] {
  // Out-of-vocabulary current chord (null) -> no neighbours; never index with -1.
  if (forCls === null || forCls === undefined || !Number.isInteger(forCls) || forCls < 0) return [];
  return nearestChords(forCls, k);
}

// ---------------------------------------------------------------------------
// Chord-edit alternatives (label based, works for the full factored vocabulary)
// ---------------------------------------------------------------------------

export interface ChordAlternative {
  /** Harte label, canonical sharp spelling, always valid for the collector. */
  label: string;
  /** Index in the legacy flat-60 vocabulary, or null (slash, 9th, sus, N, X ...). */
  cls: number | null;
  /** Why it is offered; surfaced as a tooltip. */
  reason: 'neighbour' | 'inversion' | 'quality' | 'relative' | 'degree' | 'none' | 'unknown';
}

export interface AlternativeContext {
  /** Labels of the chords immediately before / after this one in the track. */
  prevLabel?: string | null;
  nextLabel?: string | null;
}

// Per-quality ordered "what did the detector most likely confuse this with".
// First the simplification (extended -> its core), then the sibling a human ear
// confuses it with. Names are QUALITY_LABELS entries.
const QUALITY_SWAPS: Readonly<Record<string, readonly string[]>> = {
  maj: ['min', '7', 'maj7', 'sus4', 'add9', 'sus2'],
  min: ['maj', 'min7', 'min6', 'dim', 'sus4'],
  '7': ['maj', 'min7', 'maj7', '9', 'sus4'],
  maj7: ['maj', '7', 'maj9', 'maj6', 'min7'],
  min7: ['min', '7', 'hdim7', 'min9', 'maj'],
  dim: ['dim7', 'hdim7', 'min', 'maj'],
  aug: ['maj', 'aug7', '7', 'min'],
  sus2: ['sus4', 'maj', 'add9', 'min'],
  sus4: ['maj', 'sus2', '7', 'min'],
  maj6: ['maj', 'maj7', 'min7', 'add6'],
  min6: ['min', 'min7', 'hdim7', 'maj6'],
  dim7: ['dim', 'hdim7', 'min', '7'],
  hdim7: ['min7', 'dim7', 'dim', 'min'],
  minmaj7: ['min', 'min7', 'maj7', 'min6'],
  maj9: ['maj7', 'maj', 'add9', '9'],
  min9: ['min7', 'min', '9', 'min6'],
  '9': ['7', 'maj', 'maj9', 'min9'],
  '11': ['7', '9', 'sus4', 'min7'],
  '13': ['7', '9', 'maj', 'maj7'],
  add9: ['maj', 'maj9', 'sus2', 'min'],
  add11: ['maj', 'sus4', 'add9', 'min'],
  '5': ['maj', 'min', 'sus4', 'sus2'],
  add6: ['maj6', 'maj', 'add9', 'min7'],
  aug7: ['aug', '7', 'maj', 'min'],
};
const GENERIC_SWAPS = ['maj', 'min', '7', 'maj7', 'min7', 'sus4', 'dim'] as const;

// Chord tones (semitones above the root) a bass note can sit on, per quality.
// Only the commonly-inverted tones: 3rd, 5th, and 7th when the chord has one.
const INVERSION_BASS: Readonly<Record<string, readonly number[]>> = {
  maj: [4, 7], min: [3, 7], '7': [4, 7, 10], maj7: [4, 7, 11], min7: [3, 7, 10],
  dim: [3, 6], aug: [4, 8], sus2: [7], sus4: [7], maj6: [4, 7], min6: [3, 7],
  hdim7: [3, 6, 10], dim7: [3, 6, 9], minmaj7: [3, 7, 11], maj9: [4, 7, 11],
  min9: [3, 7, 10], '9': [4, 7, 10], add9: [4, 7], add6: [4, 7], aug7: [4, 8, 10],
};
const BASS_TOKEN: Readonly<Record<number, string>> = {
  3: 'b3', 4: '3', 6: 'b5', 7: '5', 8: 'b6', 9: '6', 10: 'b7', 11: '7',
};

/** Canonical label from factored indices, or null if it cannot be formed. */
function safeDecode(root: number, quality: number, bass: number): string | null {
  try {
    return decodeFactored(root, quality, bass);
  } catch {
    return null;
  }
}

function qIdx(name: string): number {
  return (QUALITY_LABELS as readonly string[]).indexOf(name);
}

/** Identity key so 'C', 'C:maj' and 'C:maj/1' are the same chord. */
function chordKey(label: string): string {
  const f = encodeFactored(label);
  return f ? `f:${f[0]}:${f[1]}:${f[2]}` : `s:${label}`;
}

/**
 * Musically-ranked shortlist for the chord-edit popover. Works for ANY label
 * the worker can emit; never throws; never returns an empty list for a chord
 * (N and X are always offered, so there is at least one correction path).
 *
 * Order (earlier = higher priority; truncated to `k` chords, then N / X):
 *  1. previous / next chord in the track: a mis-detection is often a smear
 *     of its neighbour.
 *  2. inversion fix: slash chord -> same chord in root position, then other
 *     inversions; root-position chord -> its 1st/2nd inversions
 *     ("right chord, wrong bass").
 *  3. quality swaps on the same root (simplification first, then siblings).
 *  4. relative major/minor, dominant (V) and subdominant (IV): the usual
 *     function-substitution errors.
 * The collector accepts any valid Harte label, so none of these are restricted
 * to the legacy flat-60 set.
 */
export function chordAlternatives(
  label: string,
  ctx: AlternativeContext = {},
  k = 10,
): ChordAlternative[] {
  const limit = Number.isInteger(k) && k > 0 ? k : 10;
  const kind = classifyLabel(label);
  const seen = new Set<string>([chordKey(kind === 'chord' ? label : kind === 'none' ? 'N' : 'X')]);
  const chords: ChordAlternative[] = [];
  const add = (l: string | null, reason: ChordAlternative['reason']) => {
    if (!l || chords.length >= limit) return;
    if (classifyLabel(l) !== 'chord') return;
    const key = chordKey(l);
    if (seen.has(key)) return;
    seen.add(key);
    const i = labelIndex(l);
    chords.push({ label: l, cls: i < 0 ? null : i, reason });
  };

  add(ctx.prevLabel ?? null, 'neighbour');
  add(ctx.nextLabel ?? null, 'neighbour');

  const f = kind === 'chord' ? encodeFactored(label) : null;
  if (f && f[0] < 12) {
    const [root, quality, bass] = f;
    const qName = QUALITY_LABELS[quality];
    const qs = (names: readonly string[], b: number, reason: ChordAlternative['reason']) => {
      for (const n of names) {
        const qi = qIdx(n);
        if (qi >= 0) add(safeDecode(root, qi, b), reason);
      }
    };
    // 2. inversions
    const tones = INVERSION_BASS[qName] ?? [];
    if (bass !== 0) {
      add(safeDecode(root, quality, 0), 'inversion');
      for (const t of tones) if (t !== bass && BASS_TOKEN[t]) add(slash(root, quality, t), 'inversion');
    } else {
      for (const t of tones.slice(0, 2)) if (BASS_TOKEN[t]) add(slash(root, quality, t), 'inversion');
    }
    // 3. quality swaps (root position; the bass rarely survives a quality fix)
    qs(QUALITY_SWAPS[qName] ?? GENERIC_SWAPS, 0, 'quality');
    // 4. function neighbours
    const isMinor = /^(min|dim|hdim7)/.test(qName);
    const rel = isMinor ? (root + 3) % 12 : (root + 9) % 12;
    add(safeDecode(rel, qIdx(isMinor ? 'maj' : 'min'), 0), 'relative');
    add(safeDecode((root + 7) % 12, qIdx(isMinor ? 'min' : 'maj'), 0), 'degree');
    add(safeDecode((root + 5) % 12, qIdx(isMinor ? 'min' : 'maj'), 0), 'degree');
    add(safeDecode((root + 7) % 12, qIdx('7'), 0), 'degree');
  }

  const out = chords.slice(0, limit);
  if (kind !== 'none') out.push({ label: 'N', cls: null, reason: 'none' });
  if (kind !== 'unknown') out.push({ label: 'X', cls: null, reason: 'unknown' });
  return out;
}

function slash(root: number, quality: number, semis: number): string | null {
  const base = safeDecode(root, quality, 0);
  const tok = BASS_TOKEN[semis];
  return base && tok ? `${base}/${tok}` : null;
}

/** Display text for an alternative button. */
export function alternativeText(a: Pick<ChordAlternative, 'label' | 'reason'>): string {
  if (a.reason === 'none') return 'N.C.';
  if (a.reason === 'unknown') return '?';
  return a.label;
}

/**
 * Label-level edit for the collector. buildChordEdit's class-index shape cannot
 * express slash chords / 9ths / N / X, and the /api/chord-edits route takes
 * Harte label strings, so this additive payload carries them.
 */
export interface ChordLabelEdit {
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
  originalLabel: string;
  newLabel: string;
  timestampMs: number;
}

export function buildChordLabelEdit(
  run: Pick<OverlayRun, 'startFrame' | 'endFrame' | 'startSec' | 'endSec' | 'label'>,
  newLabel: string,
  now: () => number = Date.now,
): ChordLabelEdit {
  return {
    startFrame: run.startFrame,
    endFrame: run.endFrame,
    startSec: run.startSec,
    endSec: run.endSec,
    originalLabel: run.label,
    newLabel,
    timestampMs: now(),
  };
}

// ---------------------------------------------------------------------------
// Zoom, ruler, wrapped layout
// ---------------------------------------------------------------------------

/** Duration of the track in seconds (end of the last-ending run). */
export function durationSec(runs: readonly Pick<OverlayRun, 'endSec'>[]): number {
  let max = 0;
  for (const r of runs) if (Number.isFinite(r.endSec) && r.endSec > max) max = r.endSec;
  return max;
}

/** px/sec at which the whole track exactly fits `widthPx`, capped at the max. */
export function fitPxPerSec(durSec: number, widthPx: number): number {
  if (!(durSec > 0) || !(widthPx > 0)) return MAX_PX_PER_SEC;
  return Math.min(MAX_PX_PER_SEC, widthPx / durSec);
}

export function clampPxPerSec(pps: number, minPps: number, maxPps = MAX_PX_PER_SEC): number {
  if (!Number.isFinite(pps)) return minPps;
  return Math.min(maxPps, Math.max(Math.min(minPps, maxPps), pps));
}

/** Slider position 0..1 <-> px/sec on a log scale (zoom feels even). */
export function ppsToSlider(pps: number, minPps: number, maxPps = MAX_PX_PER_SEC): number {
  if (!(maxPps > minPps) || !(pps > 0)) return 0;
  const t = Math.log(pps / minPps) / Math.log(maxPps / minPps);
  return Math.min(1, Math.max(0, t));
}
export function sliderToPps(t: number, minPps: number, maxPps = MAX_PX_PER_SEC): number {
  if (!(maxPps > minPps)) return minPps;
  const c = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  return minPps * Math.pow(maxPps / minPps, c);
}

export interface RulerTick {
  sec: number;
  leftPx: number;
  label: string;
}

const TICK_STEPS_SEC = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600] as const;

/** m:ss (h:mm:ss never needed: tracks are capped at 5 minutes). */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Ruler marks that stay legible at every zoom: the smallest "nice" step whose
 * on-screen spacing is at least `minSpacingPx`.
 */
export function rulerTicks(durSec: number, pxPerSec: number, minSpacingPx = 64): RulerTick[] {
  if (!(durSec > 0) || !(pxPerSec > 0)) return [];
  const step = TICK_STEPS_SEC.find((s) => s * pxPerSec >= minSpacingPx) ?? TICK_STEPS_SEC[TICK_STEPS_SEC.length - 1];
  const ticks: RulerTick[] = [];
  for (let t = 0; t <= durSec + 1e-9; t += step) {
    ticks.push({ sec: t, leftPx: t * pxPerSec, label: formatTime(t) });
  }
  return ticks;
}

export interface RowSegment {
  runIndex: number;
  leftPx: number;
  widthPx: number;
  /** True when this is the continuation of a chip that began on an earlier row. */
  continued: boolean;
}
export interface TimelineRow {
  startSec: number;
  segments: RowSegment[];
}

/**
 * Wrapped layout for narrow screens: the timeline is cut into rows of
 * `rowSec` seconds; a run crossing a row boundary is split across rows. Within
 * a row, left = (startSec - rowStart) * pxPerSec, the same time-proportional
 * invariant as the strip, so an N or X never shifts later chips.
 */
export function layoutRows(
  runs: readonly Pick<OverlayRun, 'startSec' | 'endSec'>[],
  rowSec: number,
  pxPerSec: number,
): TimelineRow[] {
  const dur = durationSec(runs);
  if (!(rowSec > 0) || !(dur > 0)) return [];
  const nRows = Math.max(1, Math.ceil(dur / rowSec - 1e-9));
  const rows: TimelineRow[] = Array.from({ length: nRows }, (_, i) => ({ startSec: i * rowSec, segments: [] }));
  runs.forEach((run, runIndex) => {
    const start = Math.max(0, run.startSec);
    const end = Math.max(start, run.endSec);
    const first = Math.min(nRows - 1, Math.floor(start / rowSec + 1e-9));
    const last = Math.min(nRows - 1, Math.max(first, Math.ceil(end / rowSec - 1e-9) - 1));
    for (let r = first; r <= last; r++) {
      const a = Math.max(start, r * rowSec);
      const b = Math.min(end, (r + 1) * rowSec);
      rows[r].segments.push({
        runIndex,
        leftPx: (a - r * rowSec) * pxPerSec,
        widthPx: Math.max(0, b - a) * pxPerSec,
        continued: r > first,
      });
    }
  });
  return rows;
}

/** Hue (0-330) per root so repeated harmony is visible at a glance when zoomed out. */
export function rootHue(label: string): number | null {
  const f = encodeFactored(label);
  return f && f[0] < 12 ? f[0] * 30 : null;
}

// ---------------------------------------------------------------------------
// Chip text metrics
// ---------------------------------------------------------------------------
//
// WHY THERE IS A TABLE HERE AND NOT A CONSTANT.
//
// chipDensity used to answer "can this chip show its label?" with two hardcoded
// pixel thresholds (34 / 14) that were never derived from any label. At the
// 16px the chips actually render at, "F#:min7" is 61.6px wide, so a chip could
// be `full` (>= 34px) and still be unable to show a third of its own name --
// and a chip below 14px was painted `color: transparent`, i.e. it kept a text
// node the user could not see. Both bugs are the same mistake: deciding what
// text fits without measuring text.
//
// The real measurement happens in the browser (ChordOverlay passes a canvas
// `measureText` measurer). This table is the headless fallback and the unit of
// account for the tests. Its advances were MEASURED, not guessed: Chromium
// 1280x900 on the job page's own font stack (-apple-system ... sans-serif,
// weight 400, proportional digits -- the chips declare no font-variant-numeric)
// at 16px, via a hidden span. Re-measured against every one of the 7,754 labels
// of the real alphabet: the table is never more than 0.008px under the DOM
// width (the digit, ':' '.' '-' '(' ')' and space advances changed when the
// chips dropped tabular digits; the earlier table was tabular-calibrated and
// under-estimated 170 labels by up to 0.32px against the shipped chip).

/** Font size chips render their label at (inherited; 1rem). */
export const CHIP_FONT_PX = 16;
/** Font size the `tight` density drops to (0.625rem). */
export const CHIP_TIGHT_FONT_PX = 10;
/** Horizontal padding a `full` chip spends on `padding: 0 0.5rem`. */
export const CHIP_FULL_PAD_PX = 16;
/** A `tight` chip has no padding; keep 2px so the glyphs are not flush to the edge. */
export const CHIP_TIGHT_PAD_PX = 2;
/** renderChip takes 1px off every chip so neighbours stay visually distinct. */
export const CHIP_GAP_PX = 1;

const ADVANCE_16PX: Readonly<Record<string, number>> = Object.freeze({
  A: 11.25, B: 10.4688, C: 11.6875, D: 11.5469, E: 9.6172, F: 9.4453, G: 11.9375,
  N: 12.0547, X: 10.9141,
  a: 8.9844, b: 9.7969, d: 9.7969, g: 9.8125, i: 3.875, j: 3.875, m: 14.0156,
  n: 9.4531, s: 8.4453, u: 9.4609, x: 8.7344,
  '0': 10.0938, '1': 6.5156, '2': 9.7656, '3': 9.8906, '4': 10.3438,
  '5': 9.7344, '6': 9.9219, '7': 9.0625, '8': 9.9063, '9': 9.9219,
  ':': 4.6094, '#': 10.1328, '/': 5.7656, '.': 4.6094, '?': 8.1797,
  '-': 7.3594, '(': 5.8438, ')': 5.8438, ' ': 4.5,
});
// Widest advance in the table: an unlisted glyph must never be UNDER-estimated,
// or a label would be declared to fit when it does not.
const WIDEST_ADVANCE_16PX = 14.0156;

/** A measurer: the rendered width of `label` at `fontPx`, in CSS pixels. */
export type LabelMeasure = (label: string, fontPx: number) => number;

/**
 * Headless fallback measurer. Linear in font size: Chromium's advances scale
 * exactly with font-size for this stack (measured: every label's 10px width is
 * 0.625x its 16px width, to 3dp).
 */
export function estimateLabelPx(label: string, fontPx: number = CHIP_FONT_PX): number {
  if (!label) return 0;
  let w = 0;
  for (const ch of label) w += ADVANCE_16PX[ch] ?? WIDEST_ADVANCE_16PX;
  return (w * fontPx) / CHIP_FONT_PX;
}

/**
 * The 2D-context surface the canvas measurer needs. Narrowed to what is used so
 * a test can supply a fake one: the real measurer is the one that runs in every
 * browser, and it must not be the one path no test executes.
 */
export interface Measurable2DContext {
  font: string;
  measureText(text: string): { width: number };
}

export interface CanvasFontSpec {
  fontFamily: string;
  fontWeight: string;
}

/**
 * The CSS font shorthand for a canvas context. Separate and exported because
 * the ONE thing that can go wrong here is silent: canvas IGNORES an invalid
 * shorthand and keeps whatever the context had. Dropping the `px` unit leaves
 * the context at its default `10px sans-serif`, so every label measures ~1.6x
 * too small -- in the direction that declares text to fit when it does not.
 */
export function canvasFontString(fontWeight: string, fontPx: number, fontFamily: string): string {
  return `${fontWeight} ${fontPx}px ${fontFamily}`;
}

/** Pulls the px size out of a canvas `font` read-back, which normalises the string. */
const FONT_PX_RE = /(?:^|\s)(\d+(?:\.\d+)?)px(?:\s|$)/;

/**
 * THE MEASURER THAT RUNS IN PRODUCTION. Memoised per (label, size).
 *
 * After every assignment it READS `ctx.font` BACK and checks the size actually
 * took. Canvas accepts a bad shorthand silently, so without the read-back a
 * one-character typo would under-measure every label and quietly restore the
 * invisible-chord bug with the whole suite green. A context that cannot be
 * measured, cannot take the font, or returns a non-positive width falls back to
 * the calibrated table rather than reporting a width it did not measure.
 *
 * KNOWN GAP 1 (CLOSED, and the way it closed matters): canvas 2D has no
 * `font-variant-numeric`, so while the chips declared `tabular-nums` the canvas
 * under-measured every digit-bearing label -- always in the unsafe direction.
 * Measured in Chromium over the whole alphabet (every root spelling x 24
 * qualities x every bass spelling, 7,754 labels): up to 15.164px at 16px
 * ("C#:11/11"), 7.4px for "C:11" alone. An earlier note here put the worst case
 * at 1.656px, from a 13-label fixture. It was closed by REMOVING the cause, not
 * by padding for it: the chips no longer declare tabular digits, and canvas and
 * DOM now agree to 0.008px at 16px across all 7,754 labels. Anything that puts a
 * font feature on a chip which canvas cannot express re-opens this.
 *
 * KNOWN GAP 2: the read-back below checks the font SIZE only, never the family
 * or the weight. A context that refused the shorthand but happened to hold a
 * font of the right size and the wrong face would be believed. The realistic
 * shape of that -- a context stuck at its `10px sans-serif` default while 10px
 * is requested -- cannot arise here, because the only caller asks for
 * CHIP_FONT_PX. Widening the guard to the whole normalised string would couple
 * it to each engine's serialisation, which is a worse trade.
 */
export function makeCanvasMeasurer(
  ctx: Measurable2DContext | null | undefined,
  spec: CanvasFontSpec,
): LabelMeasure {
  if (!ctx || typeof ctx.measureText !== 'function') return estimateLabelPx;
  const family = spec.fontFamily || 'sans-serif';
  const weight = spec.fontWeight || '400';
  const cache = new Map<string, number>();
  return (label, fontPx = CHIP_FONT_PX) => {
    const key = `${fontPx}|${label}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let px: number;
    try {
      ctx.font = canvasFontString(weight, fontPx, family);
      const took = FONT_PX_RE.exec(String(ctx.font ?? ''));
      const w = ctx.measureText(label).width;
      px =
        took && Math.abs(Number(took[1]) - fontPx) < 0.5 && Number.isFinite(w) && w > 0
          ? w
          : estimateLabelPx(label, fontPx);
    } catch {
      px = estimateLabelPx(label, fontPx);
    }
    cache.set(key, px);
    return px;
  };
}

/** Chip width at which `label` fits at full size, padding and inter-chip gap included. */
export function fullChipPx(labelPx: number): number {
  return labelPx + CHIP_FULL_PAD_PX + CHIP_GAP_PX;
}

/**
 * What a chip of this pixel width can show, decided by MEASURED text and not by
 * a constant. `labelPx` is the label's width at CHIP_FONT_PX.
 *
 *   full  - the label fits at 16px with its padding.
 *   tight - it fits at 10px (the `tight` branch's font size).
 *   tick  - it does not fit at all. The chip is a colour block and renders NO
 *           text node (see renderChip): a label the user cannot read must not
 *           be in the DOM claiming otherwise. The full chord stays on the
 *           chip's `aria-label`/`title`, where a reader can get at it.
 */
export function chipDensity(widthPx: number, labelPx: number): 'full' | 'tight' | 'tick' {
  if (widthPx >= labelPx + CHIP_FULL_PAD_PX) return 'full';
  if (widthPx >= (labelPx * CHIP_TIGHT_FONT_PX) / CHIP_FONT_PX + CHIP_TIGHT_PAD_PX) return 'tight';
  return 'tick';
}

/**
 * Fraction of the track's chord TIME the default zoom must render at full size.
 *
 * 0.5 makes this the DURATION-WEIGHTED MEDIAN run, which is the same statistic
 * the count-median was reaching for, measured against the thing the user
 * actually spends: seconds of song, not number of chips.
 *
 * WHY WEIGHTED, AND WHY NOT A HIGHER FRACTION. Both answers are measurements,
 * not taste. The headless table, 115-chord bimodal song (60 x 4.0s verse +
 * 55 x 0.4s bridge):
 *
 *   fraction  default px/sec   full / tight / tick   window shown of 262s
 *   0.5             19.648        60 /  0 /  55            44.4s
 *   0.9             19.648        60 /  0 /  55            44.4s
 *   0.95           196.484       114 /  1 /   0             4.4s
 *
 * Raising the fraction cannot improve that default until it crosses the whole
 * sparse population at once, and then it collapses a 44s overview to 4.4s --
 * the same cliff one notch further along. The dense half is made readable by
 * RAISING THE CEILING (zoomCeilingPxPerSec), not by zooming the default in.
 *
 * What the weighting fixes is a 4x instability that has nothing to do with the
 * fraction. Move FIVE chords from the sparse half to the dense half and the
 * COUNT median jumps populations: default 19.648 -> 80.000 px/sec, a different
 * product for a rounding-error change in the song. Weighted by time, both
 * mixes return 19.648. A statistic that is a step function of the population
 * mix is wrong wherever it happens to land.
 */
export const READABLE_TIME_FRACTION = 0.5;

/**
 * Total painted length of the timeline, in px, that the derived zoom ceiling
 * may not exceed. The strip paints this as scroll width; the wrapped layout
 * folds the SAME length into rows, so one budget bounds both (rows =
 * paintedPx / rowWidthPx).
 *
 * MEASURED, not guessed. Chromium lays out a scroller of exact width, exact
 * scrollWidth and exact last-child position up to 33,000,000px and saturates
 * at 33,554,428px (2^25 - 4, LayoutUnit's limit), with build+layout flat at
 * 24-31ms throughout -- so for the strip, nothing real bounds this short of
 * the engine. 2,000,000px is 16x inside that, and on the 300s maximum track
 * (MAX_TRACK_SEC) it allows 6,667px/sec, i.e. it only binds on runs under
 * ~0.012s. The 10fps chord detector cannot emit one. It is a guard against
 * malformed data, not a product limit.
 */
export const MAX_TIMELINE_PX = 2_000_000;

/**
 * Rows of DOM the wrapped layout may be zoomed into. Unlike the strip -- whose
 * chip count is invariant in zoom -- a wrapped row is created per rowSec, so
 * here node count really does grow with the ceiling.
 *
 * MEASURED in Chromium at 390x800, 3 nodes per row: build+layout is flat from
 * the 73 rows today's cap produces (26.8ms) to 800 rows (31.5ms), then 2000
 * rows costs 62.2ms and 7000 rows 238.3ms. 800 is the last row count that
 * still costs what today's does.
 */
export const MAX_WRAP_ROWS = 800;

/**
 * Headroom the ZOOM CEILING adds on top of fullChipPx, in px at CHIP_FONT_PX.
 *
 * `full` has zero slack against the canvas measurer by construction: it
 * requires w >= labelPx_canvas + CHIP_FULL_PAD_PX and the chip then renders
 * exactly that much padding. The ceiling puts the job's SHORTEST run at exactly
 * that threshold, so without headroom the top of the slider is the one zoom
 * where the widest label sits on the edge of clipping.
 *
 * What the 2px has to cover is the ~1px integer-rounding artifact of
 * `clientWidth` (recorded in #207) plus the canvas-vs-DOM disagreement. That
 * disagreement is NOT a constant to be sized from a sample: while the chips
 * declared tabular digits it was up to 15.164px over the real alphabet, and a
 * 2px slack sized from 13 labels covered none of it. The fix was to take the
 * tabular digits off the chips (see chipStyle), after which it is 0.008px at
 * 16px over all 7,754 labels. The slack is therefore small BECAUSE the two
 * measurers agree, and stays honest only while they do.
 *
 * It is applied HERE and not in chipDensity on purpose: widening the fit rule
 * itself would change what every chip renders as at every zoom.
 */
export const CEILING_SLACK_PX = 2;

/**
 * Duration-weighted quantile of run length: the longest `d` for which runs of
 * at least `d` seconds account for `fraction` or more of the total time.
 *
 * At fraction 0.5 this is the duration-weighted median. Unlike a count median
 * it is continuous in the population mix -- moving a few chips between two
 * clusters moves the answer by those chips' share of the song, not from one
 * cluster to the other.
 */
export function timeWeightedRunSec(durs: readonly number[], fraction: number): number {
  const a = durs.filter((d) => Number.isFinite(d) && d > 0).sort((x, y) => y - x);
  if (a.length === 0) return 0;
  let total = 0;
  for (const d of a) total += d;
  const target = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0)) * total;
  let acc = 0;
  for (const d of a) {
    acc += d;
    if (acc >= target - 1e-12) return d;
  }
  return a[a.length - 1];
}

/** Widest measured label over the runs, at CHIP_FONT_PX. 0 for no runs. */
export function widestLabelPx(
  runs: readonly Pick<OverlayRun, 'kind' | 'label'>[],
  measure: LabelMeasure = estimateLabelPx,
): number {
  let widest = 0;
  for (const r of runs) {
    const w = measure(displayText(r), CHIP_FONT_PX);
    if (Number.isFinite(w) && w > widest) widest = w;
  }
  return widest;
}

/** Shortest run with a positive duration, in seconds. 0 when there is none. */
export function shortestRunSec(runs: readonly Pick<OverlayRun, 'startSec' | 'endSec'>[]): number {
  let min = Infinity;
  for (const r of runs) {
    const d = r.endSec - r.startSec;
    if (Number.isFinite(d) && d > 0 && d < min) min = d;
  }
  return min === Infinity ? 0 : min;
}

/**
 * THE MAXIMUM ZOOM, derived from this job's own chord data.
 *
 * What bounds how far in a user may zoom is what more zoom can BUY. Above the
 * px/sec at which the job's SHORTEST run is wide enough for the job's LONGEST
 * name at full size, another pixel per second reveals no chord name that was
 * not already readable -- so that is the ceiling, and the 80px/sec constant it
 * replaces was a bound on nothing.
 *
 * It is the mirror image of readablePxPerSec: same numerator, shortest run
 * instead of the typical one. The default says "size the song I spend my time
 * in"; the ceiling says "let me reach the fastest bar in the song".
 *
 *   floor   - MAX_PX_PER_SEC, so the ceiling can only ADD range to a job. A
 *             slow song's shortest run may need less than 80px/sec; dropping
 *             the ceiling to it would take away zoom the user has today, and
 *             a fix that removes a capability is not a fix.
 *   budget  - maxPaintedPx / durSec. See MAX_TIMELINE_PX and MAX_WRAP_ROWS;
 *             binds only on data the detector cannot produce.
 */
export function zoomCeilingPxPerSec(
  runs: readonly Pick<OverlayRun, 'startSec' | 'endSec' | 'kind' | 'label'>[],
  measure: LabelMeasure = estimateLabelPx,
  budget: { durSec?: number; maxPaintedPx?: number } = {},
): number {
  const shortest = shortestRunSec(runs);
  const widest = widestLabelPx(runs, measure);
  if (!(shortest > 0) || !(widest > 0)) return MAX_PX_PER_SEC;
  const useful = (fullChipPx(widest) + CEILING_SLACK_PX) / shortest;
  const paintedPx = budget.maxPaintedPx ?? MAX_TIMELINE_PX;
  const durSec = budget.durSec ?? 0;
  const bound = durSec > 0 && paintedPx > 0 ? paintedPx / durSec : Infinity;
  return Math.max(MAX_PX_PER_SEC, Math.min(useful, Math.max(MAX_PX_PER_SEC, bound)));
}

/**
 * The content width a chip of this box width actually gets: the box less the
 * inter-chip gap. THE ONE RULE, used by renderChip to size the chip and by
 * chipDensity's callers to decide what fits in it. It was a bare `1` in
 * ChordOverlay.tsx against CHIP_GAP_PX in fullChipPx -- the same untied-literal
 * shape #207 closed for the padding and the tight font size, and the last one
 * of that family.
 */
export function chipContentPx(boxWidthPx: number): number {
  return Math.max(1, boxWidthPx - CHIP_GAP_PX);
}

/** The same, from a run and a zoom. */
export function runContentPx(
  run: Pick<OverlayRun, 'startSec' | 'endSec'>,
  pxPerSec: number,
): number {
  return chipContentPx(chipBox(run, pxPerSec).widthPx);
}

export interface DensityCounts {
  full: number;
  tight: number;
  tick: number;
}

/**
 * How many chips can show their name at each size at this zoom. `tick` is the
 * count of chords the user cannot read -- what the hint line reports and what
 * the gates count.
 */
export function densityCounts(
  runs: readonly Pick<OverlayRun, 'startSec' | 'endSec' | 'kind' | 'label'>[],
  pxPerSec: number,
  measure: LabelMeasure = estimateLabelPx,
): DensityCounts {
  const out: DensityCounts = { full: 0, tight: 0, tick: 0 };
  for (const r of runs) {
    out[chipDensity(runContentPx(r, pxPerSec), measure(displayText(r), CHIP_FONT_PX))]++;
  }
  return out;
}

/**
 * The same counts over the WRAPPED layout's row segments rather than over runs.
 *
 * WHY BOTH EXIST. On the strip a run is exactly one chip, so counting runs and
 * counting chips are the same thing. In the wrapped layout `layoutRows` splits
 * a run that crosses a row boundary, and each piece is NARROWER than the run:
 * counting runs there over-states what the user can read and under-states how
 * many nameless chips are on screen. Measured in Chromium at 390px on the
 * jittered-400 song, the run-based count said 354 nameless where 379 chips
 * rendered without a name.
 *
 * It also bounds what the zoom ceiling can promise. On the strip, the ceiling
 * makes every chord readable. In the wrapped layout a boundary can fall
 * anywhere inside a run, so no finite zoom guarantees every PIECE is readable
 * -- which is inherent to wrapping, not to the ceiling, and is why the phone
 * keeps a minority of ticks at any zoom.
 */
export function segmentDensityCounts(
  runs: readonly Pick<OverlayRun, 'kind' | 'label'>[],
  rows: readonly TimelineRow[],
  measure: LabelMeasure = estimateLabelPx,
): DensityCounts {
  const out: DensityCounts = { full: 0, tight: 0, tick: 0 };
  for (const row of rows) {
    for (const seg of row.segments) {
      const run = runs[seg.runIndex];
      if (!run) continue;
      out[chipDensity(chipContentPx(seg.widthPx), measure(displayText(run), CHIP_FONT_PX))]++;
    }
  }
  return out;
}

/**
 * THE DEFAULT ZOOM for the horizontal strip.
 *
 * Derived from this job's own chord data, not from a constant: the px/sec at
 * which a chord of TYPICAL length is wide enough to print the job's LONGEST
 * chord name at full size.
 *
 *   widest  - max measured label width over the runs. Sizing to the widest
 *             name means no chip of typical length has to ellipsise.
 *   typical - the run length at which READABLE_TIME_FRACTION of the track's
 *             chord TIME is in runs at least that long. Sizing to the shortest
 *             run would let one 0.2s passing chord dictate the zoom for the
 *             whole song. This was the count median, which collapses two
 *             populations into one and jumps between them on a few chips; see
 *             READABLE_TIME_FRACTION for the measured instability.
 *
 * The caller still clamps: never below fit-to-width (a short track should fill
 * the strip rather than leave it empty) and never above the job's own ceiling.
 */
export function readablePxPerSec(
  runs: readonly Pick<OverlayRun, 'startSec' | 'endSec' | 'kind' | 'label'>[],
  measure: LabelMeasure = estimateLabelPx,
  maxPps: number = MAX_PX_PER_SEC,
): number {
  if (runs.length === 0) return maxPps;
  const widest = widestLabelPx(runs, measure);
  const durs: number[] = [];
  for (const r of runs) {
    const d = Math.max(0, r.endSec - r.startSec);
    if (d > 0) durs.push(d);
  }
  const typical = timeWeightedRunSec(durs, READABLE_TIME_FRACTION);
  if (!(typical > 0) || !(widest > 0)) return maxPps;
  const need = fullChipPx(widest);
  return Math.min(maxPps, need / typical);
}

/** What the completed-job status area shows for each tri-state value. */
export interface CompletedJobStatus {
  /** Short pill text. */
  pill: 'LOADING' | 'JOB' | 'UNAVAILABLE';
  /** Human sentence; null when the chip timeline alone is the answer. */
  message: string | null;
  /** Whether the chip timeline should render at all. */
  showTimeline: boolean;
}

/** User-facing copy per unavailable reason. Never implies a spinner. */
export function unavailableMessage(reason: ChordUnavailableReason): string {
  switch (reason) {
    case 'too_long':
      return 'Chords aren\u2019t available for this track: chord detection supports tracks up to 5 minutes. Your stems and loops are unaffected.';
    case 'too_short':
      return 'Chords aren\u2019t available for this track: it\u2019s too short for chord detection. Your stems and loops are unaffected.';
    case 'provider_failed':
      return 'Chord detection failed for this track. Your stems and loops are unaffected.';
    case 'not_attempted':
      return 'Chord detection wasn\u2019t run for this track.';
    case 'load_failed':
      return 'We couldn\u2019t load the chords. Refresh the page to try again.';
    default:
      // No artifact and no recorded reason. Don't guess a cause.
      return 'No chords are available for this track. Chord detection works on tracks up to 5 minutes and can fail on others. Your stems and loops are unaffected.';
  }
}

export function completedJobStatus(result: PlayChordsResult): CompletedJobStatus {
  switch (result.status) {
    case 'loading':
      return { pill: 'LOADING', message: 'Loading chords\u2026', showTimeline: false };
    case 'unavailable':
      return { pill: 'UNAVAILABLE', message: unavailableMessage(result.reason), showTimeline: false };
    case 'ready':
      return result.observations.length === 0
        ? { pill: 'JOB', message: 'No chords were detected in this track.', showTimeline: false }
        : { pill: 'JOB', message: null, showTimeline: true };
  }
}

// ---------------------------------------------------------------------------
// Chord playhead (Story 3)
// ---------------------------------------------------------------------------
//
// `positionSec` arrives at animation frequency, so everything here is pure,
// allocation-free and better than O(n) per frame. The position-independent
// parts of the render — the 159 chips on the reference track, the time ruler,
// the timeline width and the track duration — are all memoised in the
// component, so a new position moves the marker and the highlight ring and
// rebuilds nothing over the runs. See the perf note on `activeRunIndex`.

/**
 * Interval convention: a run covers `[startSec, endSec)` — start inclusive,
 * end exclusive.
 *
 * This is NOT a free choice. `ChordObservation` in play-chords-loader.ts
 * documents the artifact that way ("Inclusive region start" / "Exclusive
 * region end"), so the playhead inherits it. At the instant
 * `t === runs[i].endSec === runs[i + 1].startSec`, run i + 1 is the one
 * sounding. Exactly one run can therefore cover any instant, which is what
 * lets the hinted fast path below agree with the binary search.
 *
 * A zero-length run (startSec === endSec) covers nothing, by construction.
 */
function covers(run: Pick<OverlayRun, 'startSec' | 'endSec'>, t: number): boolean {
  return t >= run.startSec && t < run.endSec;
}

/**
 * Index of the run sounding at `positionSec`, or -1 for "no chord is sounding".
 *
 * -1 is returned — and the component then draws NO marker — for every case
 * where highlighting a chip would be a lie:
 *   - `positionSec` is null (Story 3 criterion 6: not playing)
 *   - NaN, Infinity or a non-number
 *   - negative, or before the first run starts
 *   - inside a gap between two runs (Klangio can leave them)
 *   - at or past the end of the last run (including exactly `endSec`)
 *
 * PRECONDITION. `runs` must be sorted by `startSec` with no overlaps — the
 * monotone-runs invariant documented above. The binary search below is only
 * defined on a sorted array, so this is a requirement of the function, not of
 * the fast path. `observationsToRuns` and `collapseRuns` both produce it.
 *
 * PERFORMANCE. Called once per animation frame, so never a linear scan:
 *   - `hint` (the previously active index) is probed first, then `hint + 1`.
 *     Forward playback hits one of those two on essentially every frame, so
 *     the steady-state cost is O(1) with no allocation.
 *   - Otherwise a binary search over the time-sorted runs: O(log n).
 *     159 runs => at most 8 comparisons.
 *
 * `hint` is a pure accelerator, and the reason is NOT that runs happen to be
 * well-formed — nothing upstream of the web guaranteed that, and a fuzz over
 * 20,000 hostile datasets found 18,126 on which the hint changed the answer.
 * It is because the hint is consulted ONLY on an array carrying the
 * monotone-runs mark, where "at most one run covers any instant" is a produced
 * fact rather than an assumption. On any other array the hint is ignored, so a
 * stale, absent or hostile hint changes the cost and never the answer, whatever
 * the data looks like. Both halves are asserted by the hint-equivalence tests.
 */
export function activeRunIndex(
  runs: readonly Pick<OverlayRun, 'startSec' | 'endSec'>[],
  positionSec: number | null | undefined,
  hint?: number | null,
): number {
  if (typeof positionSec !== 'number' || !Number.isFinite(positionSec) || positionSec < 0) return -1;
  const n = runs.length;
  if (n === 0) return -1;

  // O(1): same chord as last frame, or the next one (forward playback). One
  // property read gates it; an unmarked array falls through to the search.
  if (
    typeof hint === 'number' &&
    Number.isInteger(hint) &&
    hint >= 0 &&
    hint < n &&
    hasMonotoneRunsMark(runs)
  ) {
    if (covers(runs[hint], positionSec)) return hint;
    const next = hint + 1;
    if (next < n && covers(runs[next], positionSec)) return next;
  }

  // O(log n): last run whose startSec is at or before the position.
  let lo = 0;
  let hi = n - 1;
  let cand = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid].startSec <= positionSec) {
      cand = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // cand < 0: before the first run. Otherwise it is the only candidate that
  // can cover the position — if it does not, we are in a gap or past the end.
  return cand >= 0 && covers(runs[cand], positionSec) ? cand : -1;
}

export interface PlayheadGeometry {
  /** The sounding run. */
  runIndex: number;
  /** Leading edge of the sounding chord, px. STEPPED — see below. */
  leftPx: number;
  /** Width of the sounding chord, px (the highlight ring). */
  widthPx: number;
}

/**
 * Where the marker sits, Chordify-style.
 *
 * Jon chose a marker that STEPS chord to chord over a continuously scrolling
 * score (2026-11-10). So `leftPx` is the leading edge of the sounding chord —
 * a function of the run, NOT of `positionSec`. It is constant for every
 * position inside one run and jumps only at a chord change. Geometry comes
 * from `chipBox`, the same primitive the chips use, so the marker cannot
 * drift away from the chip it is marking.
 *
 * Returns null when nothing is sounding, which renders no marker at all.
 */
export function playheadGeometry(
  runs: readonly Pick<OverlayRun, 'startSec' | 'endSec'>[],
  runIndex: number,
  pxPerSec = PX_PER_SEC,
): PlayheadGeometry | null {
  if (!Number.isInteger(runIndex) || runIndex < 0 || runIndex >= runs.length) return null;
  const box = chipBox(runs[runIndex], pxPerSec);
  return { runIndex, leftPx: box.leftPx, widthPx: box.widthPx };
}

/** Keep this much of the chord clear of either edge before scrolling. */
export const PLAYHEAD_MARGIN_PX = 48;
/**
 * On a forward scroll, land the sounding chord this far into the view so the
 * chords the user is about to play are the ones on screen. It also means one
 * scroll buys several chords, so auto-scroll fires rarely.
 */
export const PLAYHEAD_LEAD_FRACTION = 0.35;
/** scrollLeft can come back fractionally rounded; below this it is "unchanged". */
export const SCROLL_MATCH_TOLERANCE_PX = 2;

export interface ScrollViewport {
  /** Leading edge of the sounding chord, px (PlayheadGeometry.leftPx). */
  activeLeftPx: number;
  /** Width of the sounding chord, px. */
  activeWidthPx: number;
  /** Current scroller position and size. */
  scrollLeft: number;
  clientWidth: number;
  totalWidth: number;
  /** True once the user has scrolled by hand and we have backed off. */
  suspended: boolean;
  marginPx?: number;
  leadFraction?: number;
}

export interface AutoScrollDecision {
  /** Where to scroll, or null to leave the scroller alone. */
  scrollLeftTarget: number | null;
  /** Suspension state AFTER this decision (auto-scroll re-engages by itself). */
  suspended: boolean;
}

function clampScroll(target: number, clientWidth: number, totalWidth: number): number {
  const max = Math.max(0, totalWidth - clientWidth);
  return Math.min(max, Math.max(0, target));
}

/**
 * Auto-scroll, and the rule for not fighting the user. Story 3 criterion 4.
 *
 * Not suspended: scroll only when the sounding chord has left the comfortable
 * band (`marginPx` in from either edge). A forward scroll puts the chord
 * `leadFraction` into the view; a backward one (after a seek) puts it
 * `marginPx` from the left. A chord already inside the band scrolls nothing,
 * so a steady view stays steady.
 *
 * Suspended: the user has scrolled by hand, so we stay out of the way — until
 * playback leaves the visible range entirely, at which point following again
 * is clearly what they want and suspension lifts itself. "A view that yanks
 * itself back is worse than one that does not follow", so partial visibility
 * is left alone: nothing moves while any part of the sounding chord is on
 * screen.
 */
export function resolveAutoScroll(v: ScrollViewport): AutoScrollDecision {
  const margin = v.marginPx ?? PLAYHEAD_MARGIN_PX;
  const lead = v.leadFraction ?? PLAYHEAD_LEAD_FRACTION;
  if (!(v.clientWidth > 0) || !(v.totalWidth > 0)) {
    return { scrollLeftTarget: null, suspended: v.suspended };
  }

  const viewStart = v.scrollLeft;
  const viewEnd = v.scrollLeft + v.clientWidth;
  const chordStart = v.activeLeftPx;
  const chordEnd = v.activeLeftPx + Math.max(0, v.activeWidthPx);

  if (v.suspended) {
    // Any overlap with the viewport at all => do not move.
    const whollyOutside = chordEnd <= viewStart || chordStart >= viewEnd;
    if (!whollyOutside) return { scrollLeftTarget: null, suspended: true };
    // Playback has moved past what the user was looking at: re-engage.
    const target = clampScroll(chordStart - v.clientWidth * lead, v.clientWidth, v.totalWidth);
    return {
      scrollLeftTarget: Math.abs(target - v.scrollLeft) <= SCROLL_MATCH_TOLERANCE_PX ? null : target,
      suspended: false,
    };
  }

  let target: number | null = null;
  if (chordStart < viewStart + margin) {
    target = chordStart - margin; // behind the view (seek backwards)
  } else if (chordEnd > viewEnd - margin) {
    target = chordStart - v.clientWidth * lead; // ahead of the view (normal play)
  }
  if (target === null) return { scrollLeftTarget: null, suspended: false };

  const clamped = clampScroll(target, v.clientWidth, v.totalWidth);
  return {
    scrollLeftTarget: Math.abs(clamped - v.scrollLeft) <= SCROLL_MATCH_TOLERANCE_PX ? null : clamped,
    suspended: false,
  };
}

/**
 * Did this scroll event come from the user rather than from us?
 *
 * The component records the scrollLeft it last set; anything further away than
 * the tolerance was a hand (or wheel, or trackpad) scroll and suspends
 * auto-scroll. Without this every programmatic scroll would read as a manual
 * one and auto-scroll would switch itself off on the first chord change.
 */
export function isManualScroll(
  observedLeft: number,
  lastAutoLeft: number,
  tolerancePx = SCROLL_MATCH_TOLERANCE_PX,
): boolean {
  if (!Number.isFinite(observedLeft) || !Number.isFinite(lastAutoLeft)) return false;
  return Math.abs(observedLeft - lastAutoLeft) > tolerancePx;
}
