// Pure helpers for the ChordOverlay React component.
//
// Factored into its own `.ts` file so Node's --experimental-strip-types
// can load it without touching the `.tsx` (which Node refuses). Keeping
// behaviour testable without jsdom is the point of this split.

import { labelIndex, nearestChords } from '../chord/alphabet.ts';
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
// Horizontal scale of the timeline: pixels per second of audio.
export const PX_PER_SEC = 80;

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
