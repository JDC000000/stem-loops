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
// Maximum horizontal scale of the timeline: pixels per second of audio. This is
// the most-zoomed-in level; the default view is fit-to-width (see fitPxPerSec).
export const PX_PER_SEC = 80;
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

/**
 * Convert worker observations (seconds, Harte strings) into renderable runs.
 * EVERY observation yields a run; none is dropped for lacking a class index.
 */
export function observationsToRuns(obs: readonly ChordObservation[]): OverlayRun[] {
  return obs.map((o) => {
    const startFrame = Math.max(0, Math.round(o.startSec * CHORDS_FRAMES_PER_SEC));
    const endFrame = Math.max(startFrame + 1, Math.round(o.endSec * CHORDS_FRAMES_PER_SEC));
    const kind = classifyLabel(o.label);
    return {
      startFrame,
      endFrame,
      startSec: o.startSec,
      endSec: o.endSec,
      label: o.label,
      kind,
      chordClass: kind === 'chord' ? classIndexOrNull(o.label) : null,
    };
  });
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

/** What a chip of this pixel width can show. */
export function chipDensity(widthPx: number): 'full' | 'tight' | 'tick' {
  if (widthPx >= 34) return 'full';
  if (widthPx >= 14) return 'tight';
  return 'tick';
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
