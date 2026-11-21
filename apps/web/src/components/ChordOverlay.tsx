// Live chord overlay — Variant Y (free tier) wedge component.
// Decision record: claude/phase-2-y1-chord-model-decision.md v1.3 §1.6a.
//
// Pipeline: tab-capture → cqt-frontend → chordnet-session → smoothChordLogits
//           → collapseRuns → timeline render.
//
// NOT WIRED (parked 2026-11-05). This component exposes `onChordEdit` and
// `onChordLabelEdit`, but NOTHING consumes them: jobs/[id]/page.tsx mounts
// <ChordOverlay jobId={...} /> with no handler, so every correction a user
// makes is dropped on the floor. The write path behind them is also
// incomplete -- play.chords.json carries neither `track_hash` nor
// `alphabet_sha`, both of which /api/chord-edits requires and chord_edits
// has as NOT NULL, and no part of the system computes a track_hash at all.
// The props are kept as the integration seam, deliberately: the flywheel
// feeds the Y1 chord model, and Variant Y is paused pending a WASM librosa
// port, so there is no consumer for the data yet. Do not describe this path
// as working, and do not wire a handler without closing the write path first.
// Full finding + the four options considered: issue #135.
// This component owns no state beyond the UI.
'use client';

import {
  type CSSProperties,
  type FC,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { N_CHORD_CLASSES } from '../chord/alphabet.ts';
import {
  type ChordnetSession,
  loadChordnetSession,
  resolveModelUrl,
} from '../chord/chordnet-session.ts';
import { computeCQT, loadCqtPlan } from '../chord/cqt-frontend.ts';
import { collapseRuns, smoothChordLogits } from '../chord/smoother.ts';
import { usePlayChords } from '../chord/play-chords-loader.ts';
import {
  type TabCapture,
  UnsupportedBrowserError,
  checkTabCaptureSupport,
  startTabCapture,
} from '../chord/tab-capture.ts';
import type { ChordPlayheadProps, LoopRegion } from '../lib/play/types.ts';
import {
  type BeatGrid,
  type LineBox,
  type PhoneModel,
  CELL_HEAD_PX,
  SLOT_PAD_PX,
  beatInCell,
  beatsUntil,
  buildPhoneModel,
  cellIndexAt,
  layoutLine,
  leadSheetSymbol,
  lineIndexOfCell,
  nextChord,
  nextLineIndex,
  phoneBarLabel,
  phoneSlotLabel,
  positionLabel,
  spokenSymbol,
  TALL_NOW_PX,
  TALLER_NOW_PX,
  growScale,
  grownFontPx,
  stageChromePx,
} from './ChordPhone.helpers.ts';
import {
  type ChordAlternative,
  type ChordEdit,
  type ChordLabelEdit,
  type OverlayRun,
  MAX_PX_PER_SEC,
  NARROW_BREAKPOINT_PX,
  WRAP_DEFAULT_ROW_SEC,
  WRAP_MAX_ROW_SEC,
  activeRunIndex,
  alternativeSpoken,
  alternativeText,
  buildChordEdit,
  buildChordLabelEdit,
  chipBox,
  CHIP_FULL_PAD_PX,
  CHIP_TIGHT_FONT_PX,
  CURRENT_CHORD_FONT_PX,
  chipContentPx,
  chipDensity,
  densityCounts,
  segmentDensityCounts,
  zoomCeilingPxPerSec,
  MAX_TIMELINE_PX,
  estimateLabelPx,
  estimateStageLabelPx,
  makeCanvasMeasurer,
  readablePxPerSec,
  CHIP_FONT_PX,
  type LabelMeasure,
  chordAlternatives,
  classIndexOrNull,
  classifyLabel,
  clampPxPerSec,
  completedJobStatus,
  displayText,
  durationSec,
  fitPxPerSec,
  formatTime,
  isManualScroll,
  layoutRows,
  layoutTapRows,
  wrapPaintBudgetPx,
  markMonotoneRuns,
  observationsToRuns,
  playheadGeometry,
  ppsToSlider,
  resolveAutoScroll,
  rootHue,
  rulerTicks,
  runAriaLabel,
  spokenText,
  sliderToPps,
  timelineWidthPx,
} from './ChordOverlay.helpers.ts';

export type { ChordEdit, ChordLabelEdit };

// Visual constants for the timeline.
const RULER_H = 20;
const GUTTER_PX = 44; // row-time labels in the wrapped (narrow) layout
const CHIP_H_STRIP = 36;
const CHIP_H_WRAP = 44; // touch target
const WRAP_ROW_GAP_PX = 6; // gap between wrapped rows; the playhead ring needs it

/**
 * `Partial<ChordPlayheadProps>` is how Story 3's one new prop arrives, and the
 * `Partial` is load-bearing: the existing mount in jobs/[id]/page.tsx passes
 * `jobId` only, so `positionSec` MUST be optional or that page stops compiling.
 * Extending the contract type rather than restating it means the compiler, not
 * a comment, is what keeps this in step with lib/play/types.ts.
 */
export interface ChordOverlayProps extends Partial<ChordPlayheadProps> {
  onStart?: () => void;
  onStop?: () => void;
  /**
   * Fired when the user picks a replacement chord that exists in the legacy
   * flat-60 vocabulary. Shape unchanged (class indices). Slash chords, 9ths,
   * sus, N and X have no class index, so they are NOT delivered here; use
   * `onChordLabelEdit` to collect every correction.
   */
  onChordEdit?: (edit: ChordEdit) => void;
  /** Fired for EVERY picked correction, carrying Harte label strings. */
  onChordLabelEdit?: (edit: ChordLabelEdit) => void;
  /** Override for tests. */
  modelUrl?: string;
  /**
   * Completed-job mode. When set, the overlay skips the live tab-capture path
   * entirely and renders the chord timeline produced by the worker (Klangio /
   * future internal model), loaded from R2 via `usePlayChords`. Omit (or pass
   * null) to get the default live-capture mode.
   */
  jobId?: string | null;
  /**
   * The job's beat grid (from its loops rows; see beatGridFromLoops). The
   * phone view draws bars with it when it fits the chords; absent or a poor
   * fit, the phone view shows a plain chord sequence (no invented beats).
   */
  beatGrid?: BeatGrid | null;
  /** Song sections: the phone view's "where am I" and its per-section re-anchoring. */
  sections?: readonly LoopRegion[];
  /** The section loop being played, if any (the phone view's Next follows it). */
  loop?: LoopRegion | null;
  /**
   * What to render (design v1.4, P1.1 / P1.2):
   *   'both'  (default) the phone chord view on narrow widths with the full
   *           chord chart below it, as before;
   *   'stage' the player's CHORD STAGE only: Now / Next, the beat row and two
   *           bar lines, at every width, filling its container. No chart, no
   *           zoom. When the song has no chords, `emptyStage` is rendered;
   *   'chart' the full chord chart only ("See all chords").
   */
  view?: 'both' | 'stage' | 'chart';
  /**
   * Stage view only: what to show when this song has no chords (P1.2
   * no-chords state). A function is given WHY when chords are unavailable
   * (the provider's reason, e.g. "usually on our end"; a load failure's "Refresh
   * the page"), or null when the song simply has none.
   */
  emptyStage?: ReactNode | ((reason: string | null) => ReactNode);
  /**
   * Stage view only: told the current and next chord names whenever they
   * change (never per frame), so the Mix sheet's header can show them while it
   * covers the stage. `null` when there is no current chord.
   */
  onNowNext?: (v: NowNext | null) => void;
}

/** The chord names the Mix sheet header shows (P1.3 "mixing by ear"). */
export interface NowNext {
  readonly now: string;
  readonly nowSpoken: string;
  readonly next: string;
  readonly nextSpoken: string;
}

export { observationsToRuns };

interface State {
  phase: 'idle' | 'loading' | 'capturing' | 'error';
  runs: OverlayRun[];
  unsupportedMessage?: string;
  errorMessage?: string;
  provider?: 'webgpu' | 'wasm';
}

const INITIAL_STATE: State = { phase: 'idle', runs: [] };

/** Browser-UI bar listing recent chord runs. */
export const ChordOverlay: FC<ChordOverlayProps> = ({
  onStart,
  onStop,
  onChordEdit,
  onChordLabelEdit,
  modelUrl,
  jobId,
  // Story 3. `null`/absent = not playing: no marker, no auto-scroll, and the
  // timeline renders exactly as it did before this prop existed.
  positionSec = null,
  beatGrid = null,
  sections,
  loop = null,
  view = 'both',
  emptyStage = null,
  onNowNext,
}) => {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const [popoverFor, setPopoverFor] = useState<{ run: OverlayRun; idx: number } | null>(null);
  // Zoom: null = fit-to-width (the default); otherwise explicit px/sec.
  const [userPps, setUserPps] = useState<number | null>(null);
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const [widthPx, setWidthPx] = useState(0);
  // The stage view also reads its height, to let Now and the bars grow into spare room.
  const [heightPx, setHeightPx] = useState(0);
  const [scrollInfo, setScrollInfo] = useState({ left: 0, client: 0, total: 0 });
  // Story 3 criterion 4: set once the user scrolls by hand, so auto-scroll
  // stops fighting them. It lifts itself again in the auto-scroll effect.
  const [followSuspended, setFollowSuspended] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const centerSecRef = useRef<number | null>(null);
  // The scrollLeft WE last set. Anything else is the user (see isManualScroll).
  const lastAutoLeftRef = useRef(0);
  // Last sounding chord, as an O(1) lookup hint. A cache only: activeRunIndex
  // returns the same answer with a stale hint, an absent one or a hostile one.
  const activeHintRef = useRef(-1);
  const sessionRef = useRef<ChordnetSession | null>(null);
  const captureRef = useRef<TabCapture | null>(null);

  // Completed-job mode: load the worker-written chord timeline from R2 instead
  // of running tab capture. A truthy jobId makes the component ignore the
  // feature-detect path below and swap the start/stop controls out of the UI.
  const completedJobChords = usePlayChords(jobId ?? null);
  const isCompletedJobMode = Boolean(jobId);

  // Early feature-detect so we can show the banner without starting capture.
  // Completed-job mode bypasses this: tab capture never runs there.
  const support = useMemo(() => {
    if (isCompletedJobMode) return { supported: true } as const;
    if (typeof window === 'undefined') return { supported: true } as const;
    return checkTabCaptureSupport();
  }, [isCompletedJobMode]);

  const completedStatus = completedJobStatus(completedJobChords);

  // Push the loaded observations into the shared `state.runs` so the render
  // path below is identical to the live-capture one. Only `ready` carries
  // observations; loading / unavailable are rendered from `completedStatus`.
  useEffect(() => {
    if (!isCompletedJobMode) return;
    if (completedJobChords.status !== 'ready') return;
    setState({
      phase: 'capturing',
      runs: observationsToRuns(completedJobChords.observations),
    });
  }, [isCompletedJobMode, completedJobChords]);

  useEffect(() => {
    return () => {
      // Cleanup on unmount.
      if (captureRef.current) void captureRef.current.stop();
      if (sessionRef.current) void sessionRef.current.dispose();
    };
  }, []);

  const handleStart = useCallback(async () => {
    if (state.phase === 'loading' || state.phase === 'capturing') return;
    setState({ phase: 'loading', runs: [] });
    onStart?.();
    try {
      const resolvedUrl = modelUrl ?? resolveModelUrl();
      // Load plan + model in parallel. Plan hash is verified inside loadCqtPlan.
      const [plan, session] = await Promise.all([
        loadCqtPlan(),
        loadChordnetSession(resolvedUrl),
      ]);
      sessionRef.current = session;
      // Seconds per hop at inference time. Must come from the plan — the
      // CQT training/runtime parity gate asserts we share these numbers.
      const frameSec = plan.hop / plan.sr;

      const capture = await startTabCapture({
        sampleRate: 22050,
        bufferSeconds: 5,
        chunkSeconds: 1,
      });
      captureRef.current = capture;

      capture.onAudioChunk(async (chunk) => {
        try {
          if (!sessionRef.current) return;
          const { frames, nFrames } = await computeCQT(chunk);
          if (nFrames === 0) return;
          const logits = await sessionRef.current.runFrames(frames, nFrames);
          // Logits → Viterbi best-path class indices → run-length segments.
          const classes = smoothChordLogits(logits, nFrames);
          // collapseRuns walks the frame array once and emits
          // startSec = i * frameSec with endSec = the next run's startSec, so
          // its output is sorted and contiguous by construction. `.map` makes a
          // new array, which drops the mark, so re-assert it here — otherwise
          // the live path pays a binary search every frame for nothing.
          const runs: OverlayRun[] = markMonotoneRuns(
            collapseRuns(classes, frameSec).map((r) => ({
              startFrame: r.startFrame,
              endFrame: r.endFrame,
              startSec: r.startSec,
              endSec: r.endSec,
              label: r.label,
              kind: classifyLabel(r.label),
              chordClass: classIndexOrNull(r.label) ?? r.chordClass,
            })),
          );
          setState((s) => ({ ...s, runs }));
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('chord overlay: chunk failed', err);
        }
      });
      capture.onError((err) => {
        setState({
          phase: 'error',
          runs: [],
          errorMessage: err.message,
        });
      });

      setState({
        phase: 'capturing',
        runs: [],
        provider: session.provider,
      });
    } catch (err) {
      if (err instanceof UnsupportedBrowserError) {
        setState({
          phase: 'error',
          runs: [],
          unsupportedMessage: err.message,
        });
        return;
      }
      setState({
        phase: 'error',
        runs: [],
        errorMessage: (err as Error).message,
      });
    }
  }, [modelUrl, onStart, state.phase]);

  const handleStop = useCallback(async () => {
    if (captureRef.current) {
      await captureRef.current.stop();
      captureRef.current = null;
    }
    if (sessionRef.current) {
      await sessionRef.current.dispose();
      sessionRef.current = null;
    }
    setState(INITIAL_STATE);
    onStop?.();
  }, [onStop]);

  const handlePickAlternative = useCallback(
    (run: OverlayRun, alt: ChordAlternative) => {
      // Legacy collector path: unchanged shape, only for labels that have a
      // flat-60 class index (never -1, never labelAt).
      if (alt.cls !== null) onChordEdit?.(buildChordEdit(run, alt.cls));
      onChordLabelEdit?.(buildChordLabelEdit(run, alt.label));
      setPopoverFor(null);
    },
    [onChordEdit, onChordLabelEdit],
  );

  // ---- timeline geometry ---------------------------------------------------
  useEffect(() => {
    if (!wrapEl) return;
    const measure = () => {
      const r = wrapEl.getBoundingClientRect();
      setWidthPx(Math.floor(r.width));
      setHeightPx(Math.floor(r.height));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(wrapEl);
    return () => ro.disconnect();
  }, [wrapEl]);

  // O(n) over the runs, so memoised: `positionSec` changes every frame and
  // must not re-walk 159 runs to re-derive a duration that cannot have moved.
  const dur = useMemo(() => durationSec(state.runs), [state.runs]);
  const measured = widthPx > 0;
  const narrow = measured && widthPx < NARROW_BREAKPOINT_PX;
  const rowWidthPx = Math.max(120, widthPx - GUTTER_PX);
  // Strip: the minimum zoom is "whole track fits". Wrapped: rows of at most 16s.
  const minPps = narrow
    ? Math.min(MAX_PX_PER_SEC, rowWidthPx / WRAP_MAX_ROW_SEC)
    : fitPxPerSec(dur, widthPx);
  // Real text metrics for the chips: FAMILY and WEIGHT are read off the element
  // the chips inherit them from; the SIZE is not read, it is declared (every
  // chip carries an inline px font size, see renderChip). Built once per
  // container element and memoised per (label, size); nothing
  // here runs per frame. Falls back to the calibrated table when there is no
  // canvas (SSR, happy-dom, a hardened browser that returns a null context).
  // The measuring itself lives in makeCanvasMeasurer (a pure, exported factory
  // over a narrow 2D-context interface) so that the path which runs in every
  // real browser is reachable from a test. This hook only sources the context
  // and the font off the element the chips inherit from. happy-dom's
  // getContext('2d') returns null, so without that split the production
  // measurer would be executed by no test at all.
  const measureLabel = useMemo<LabelMeasure>(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined' || !wrapEl) {
      return estimateLabelPx;
    }
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = document.createElement('canvas').getContext('2d');
    } catch {
      ctx = null;
    }
    const cs = window.getComputedStyle(wrapEl);
    return makeCanvasMeasurer(ctx, {
      fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight,
    });
  }, [wrapEl]);

  // THE DEFAULT ZOOM. The strip used to default to fit-the-whole-track, which
  // for a 3:33 track in a 904px container is 4.2px/sec -- every chip a 7px
  // sliver, every chord name invisible. It now defaults to the zoom this job's
  // own chord data needs to print its names (see readablePxPerSec), floored at
  // fit-to-width so a short track still fills the strip. The wrapped (narrow)
  // layout already derived its default from seconds-per-row and already read
  // correctly; it is unchanged.
  //
  // NOTE THE MISSING THIRD ARGUMENT, because it is deliberate and it is the one
  // place MAX_PX_PER_SEC still decides a default. `readablePxPerSec` caps its
  // own answer at MAX_PX_PER_SEC, so the DEFAULT never goes above 80px/sec even
  // where the derivation asks for more, while the CEILING below does. The two
  // caps answer different questions: the ceiling is "how far may the user
  // reach", which must be derived from the text or chords become unreadable
  // forever; the default is "how much of the song does the first view show",
  // which is a product choice and not a claim about any text.
  //
  // What that costs, measured: on a song at one chord per beat at 160bpm (533
  // runs of 0.375s) the derivation wants 214.9px/sec and the default stays at
  // 80, where 246 of 533 chords are nameless. They are all REACHABLE now and
  // the hint line says so, which is the difference this PR is about -- but the
  // default on such a song is still worse than the rule would make it. Left
  // deliberately: lifting it would default a dense song to a ~4s window, which
  // is a separate decision about the first view and wants its own measurement.
  const readablePps = useMemo(
    () => readablePxPerSec(state.runs, measureLabel),
    [state.runs, measureLabel],
  );

  // THE MAXIMUM ZOOM. Was the bare MAX_PX_PER_SEC constant, which bounded
  // nothing: a chord whose run is under ~0.52s (one per beat at 115bpm) could
  // not be read at ANY zoom the slider reached, so on a song with real dynamic
  // range between its sections nearly half the chords had no name and no way
  // to get one. It is now derived from the job's chord data -- the zoom at
  // which even the SHORTEST run carries the LONGEST name at full size -- and
  // floored at MAX_PX_PER_SEC so a job can only gain range, never lose it.
  //
  // The wrapped layout folds the same painted length into rows instead of
  // scrolling it, and a row is DOM, so it gets the tighter of the two budgets.
  const maxPps = useMemo(
    () =>
      zoomCeilingPxPerSec(state.runs, measureLabel, {
        durSec: dur,
        maxPaintedPx: narrow
          ? wrapPaintBudgetPx(state.runs.length, rowWidthPx)
          : MAX_TIMELINE_PX,
      }),
    [state.runs, measureLabel, dur, narrow, rowWidthPx],
  );

  const defaultPps = narrow
    ? clampPxPerSec(rowWidthPx / WRAP_DEFAULT_ROW_SEC, minPps, maxPps)
    : clampPxPerSec(readablePps, minPps, maxPps);
  const pps = userPps === null ? defaultPps : clampPxPerSec(userPps, minPps, maxPps);

  const canZoomFurther = pps < maxPps * 0.999;
  const chipH = narrow ? CHIP_H_WRAP : CHIP_H_STRIP;

  const setZoom = useCallback(
    (next: number | null) => {
      const el = scrollRef.current;
      if (el && !narrow && pps > 0) centerSecRef.current = (el.scrollLeft + el.clientWidth / 2) / pps;
      setUserPps(next);
    },
    [narrow, pps],
  );

  const syncScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A scroll we did not cause is the user taking over: back off (Story 3
    // criterion 4). Every programmatic scroll records its target in
    // lastAutoLeftRef first, so our own scrolls do not trip this.
    if (isManualScroll(el.scrollLeft, lastAutoLeftRef.current)) {
      lastAutoLeftRef.current = el.scrollLeft;
      setFollowSuspended(true);
    }
    setScrollInfo((p) =>
      p.left === el.scrollLeft && p.client === el.clientWidth && p.total === el.scrollWidth
        ? p
        : { left: el.scrollLeft, client: el.clientWidth, total: el.scrollWidth },
    );
  }, []);

  // After a zoom change keep the same moment centred, then refresh scroll state.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && centerSecRef.current !== null) {
      const next = Math.max(0, centerSecRef.current * pps - el.clientWidth / 2);
      // Ours, not the user's — so syncScroll below must not read this as a
      // manual scroll. Record what the element ACTUALLY took, not what we
      // asked for: the scrollLeft setter clamps to scrollWidth - clientWidth
      // (CSSOM View), so zooming out while parked in the last half-screen
      // lands short of `next`, and recording `next` would read that gap as the
      // user taking over and silently suspend auto-follow.
      el.scrollLeft = next;
      lastAutoLeftRef.current = el.scrollLeft;
      centerSecRef.current = null;
    }
    syncScroll();
  }, [pps, widthPx, state.runs, syncScroll]);

  // ---- chord playhead (Story 3) -------------------------------------------
  // `positionSec` changes at animation frequency, so this block is written so
  // that a new position costs an O(1) lookup and moves two absolutely
  // positioned <div>s. It must NOT cost 159 chip re-renders, which is why the
  // chips below are memoised on geometry only and know nothing about position.
  const activeIdx = activeRunIndex(state.runs, positionSec, activeHintRef.current);
  // Only fires when the sounding chord CHANGES, not every frame.
  useEffect(() => {
    if (activeIdx >= 0) activeHintRef.current = activeIdx;
  }, [activeIdx]);
  // Stepped: a function of the run and the zoom, never of positionSec. Stable
  // by reference between chord changes, so effects keyed on it stay quiet.
  const playhead = useMemo(
    () => playheadGeometry(state.runs, activeIdx, pps),
    [state.runs, activeIdx, pps],
  );
  const activeRun = activeIdx >= 0 ? state.runs[activeIdx] : null;

  // ---- phone view (Stories 3 / 4.8 on phones) ------------------------------
  // The stage view draws the phone model at every width (it IS the player's
  // chord stage); the default view keeps it to narrow widths, as before.
  const stage = view === 'stage';
  const wantPhone = (narrow || stage) && view !== 'chart';
  const phoneModel = useMemo(
    () => (wantPhone ? buildPhoneModel(state.runs, beatGrid, sections, dur) : null),
    [wantPhone, state.runs, beatGrid, sections, dur],
  );
  const showPhone = wantPhone && measured && !!phoneModel && phoneModel.cells.length > 0;
  // "Playing" for LAYOUT purposes: a usable position arrived. Deliberately
  // distinct from "a chord is sounding" — positionSec can legitimately sit in
  // a gap Klangio left, and the Now-row must not vanish when it does.
  const isPlaying =
    typeof positionSec === 'number' && Number.isFinite(positionSec) && positionSec >= 0;

  // Chips, memoised WITHOUT the playhead. Reusing the same element references
  // lets React bail out of the whole chip subtree when only the position has
  // changed. Together with the ruler and width memos below, that is what makes
  // "a frame costs the marker" true: the per-frame render then allocates only
  // the handful of control elements and the two marker <div>s, and touches
  // nothing that is O(number of runs).
  const stripChips = useMemo(
    () =>
      state.runs.map((run, idx) => {
        const box = chipBox(run, pps);
        return renderChip(run, idx, box.leftPx, box.widthPx, chipH, null, setPopoverFor, measureLabel);
      }),
    [state.runs, pps, chipH, measureLabel],
  );

  // The ruler and the timeline width are the other two things a frame used to
  // rebuild. Both are O(n) or O(ticks) and neither can be moved by
  // `positionSec`, so both are memoised on the geometry that CAN move them.
  // Without this the per-frame claim above was false: every frame re-walked
  // the runs twice (durationSec, timelineWidthPx) and rebuilt every ruler tick.
  const timelineTotalPx = useMemo(() => timelineWidthPx(state.runs, pps), [state.runs, pps]);
  const rulerTickEls = useMemo(
    () =>
      rulerTicks(dur, pps).map((t) => (
        <span key={t.sec} style={{ ...tickStyle, left: `${t.leftPx}px` }} data-testid={`tick-${t.sec}`}>
          {t.label}
        </span>
      )),
    [dur, pps],
  );

  // Wrapped (narrow) layout. `byRun` turns "which segments belong to run i"
  // into an array index instead of a per-frame scan over every segment.
  // QA-68: layoutTapRows, not bare layoutRows, so every chip is a >= 24px tap
  // target (short chords widen, over-full rows split; see fitRowsToTap).
  // `split` is whether any row was split, which makes the hint's "Ns per row"
  // an upper bound.
  const wrapped = useMemo(() => {
    const rows = layoutTapRows(state.runs, rowWidthPx / pps, pps, rowWidthPx);
    const split = rows.length > layoutRows(state.runs, rowWidthPx / pps, pps).length;
    const byRun: { rowIndex: number; leftPx: number; widthPx: number }[][] = state.runs.map(() => []);
    rows.forEach((row, ri) => {
      for (const seg of row.segments) {
        byRun[seg.runIndex]?.push({ rowIndex: ri, leftPx: seg.leftPx, widthPx: seg.widthPx });
      }
    });
    return { rows, byRun, split };
  }, [state.runs, rowWidthPx, pps]);

  // CHIPS the user cannot read at this zoom -- not RUNS. The wrapped layout
  // splits a run that crosses a row boundary and each piece is narrower than
  // the run, so the run-based count is wrong there: measured in Chromium at
  // 390px on a 400-chord song it said 354 where 379 chips rendered nameless.
  // This number is shown to the user, so it has to be the one on screen.
  const nameless = useMemo(
    () =>
      narrow
        ? segmentDensityCounts(state.runs, wrapped.rows, measureLabel).tick
        : densityCounts(state.runs, pps, measureLabel).tick,
    [narrow, state.runs, wrapped.rows, pps, measureLabel],
  );

  const wrappedRows = useMemo(
    () =>
      wrapped.rows.map((row, ri) => (
        <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          <span style={rowLabelStyle}>{formatTime(row.startSec)}</span>
          <div style={{ position: 'relative', height: chipH, width: rowWidthPx, flex: 'none' }}>
            {row.segments.map((seg) =>
              renderChip(
                state.runs[seg.runIndex],
                seg.runIndex,
                seg.leftPx,
                seg.widthPx,
                chipH,
                seg.continued ? ri : null,
                setPopoverFor,
                measureLabel,
              ),
            )}
          </div>
        </div>
      )),
    [wrapped.rows, state.runs, rowWidthPx, chipH, measureLabel],
  );

  // Keep the sounding chord visible — on chord change only. `playhead` is
  // reference-stable within a chord, so this does not run per frame.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || narrow || !playhead) return;
    const decision = resolveAutoScroll({
      activeLeftPx: playhead.leftPx,
      activeWidthPx: playhead.widthPx,
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
      totalWidth: el.scrollWidth,
      suspended: followSuspended,
    });
    if (decision.suspended !== followSuspended) setFollowSuspended(decision.suspended);
    if (decision.scrollLeftTarget !== null) {
      // Same rule as the zoom effect: record what the element took. The target
      // is already clamped against el.scrollWidth/clientWidth here, so this is
      // belt-and-braces rather than a fix — one rule, no second convention.
      el.scrollLeft = decision.scrollLeftTarget;
      lastAutoLeftRef.current = el.scrollLeft;
      syncScroll();
    }
  }, [playhead, narrow, followSuspended, syncScroll]);

  const popover = (
    <>
      {popoverFor ? (
        <div
          role="dialog"
          aria-label="Pick a different chord"
          style={popoverStyle}
          data-testid="chord-popover"
        >
          {/* Painted with the glyphs ("Change F♯m7"); named in words for a
              screen reader, which reads "♯" inconsistently (review L-4). A
              heading, because ARIA does not allow a name on a generic div. */}
          <div
            style={popoverHeaderStyle}
            data-testid="chord-popover-header"
            role="heading"
            aria-level={2}
            aria-label={`Change ${spokenText(popoverFor.run)}`}
          >
            Change {displayText(popoverFor.run)}
          </div>
          <div style={popoverGridStyle}>
            {chordAlternatives(popoverFor.run.label, {
              prevLabel: state.runs[popoverFor.idx - 1]?.label ?? null,
              nextLabel: state.runs[popoverFor.idx + 1]?.label ?? null,
            }).map((alt) => (
              <button
                type="button"
                key={alt.label}
                onClick={() => handlePickAlternative(popoverFor.run, alt)}
                data-testid={`alt-${alt.label}`}
                data-reason={alt.reason}
                title={altTitle(alt)}
                aria-label={alternativeSpoken(alt)}
                style={altButtonStyle}
              >
                {alternativeText(alt)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPopoverFor(null)}
            style={{ ...altButtonStyle, marginTop: '0.5rem' }}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </>
  );

  // ---- the player's chord stage (view="stage", design v1.4 P1.2) ----------
  if (stage) {
    const noChords =
      isCompletedJobMode &&
      (completedJobChords.status === 'unavailable' ||
        (completedJobChords.status === 'ready' && completedJobChords.observations.length === 0));
    return (
      <div ref={setWrapEl} data-testid="chord-overlay" data-view="stage" style={stageRootStyle}>
        {noChords ? (
          typeof emptyStage === 'function'
            ? emptyStage(completedJobChords.status === 'unavailable' ? completedStatus.message : null)
            : emptyStage
        ) : showPhone ? (
          <PhoneChords
            runs={state.runs}
            model={phoneModel!}
            positionSec={isPlayingPos(positionSec) ? positionSec : null}
            activeIdx={activeIdx}
            widthPx={widthPx}
            loop={loop}
            onOpen={setPopoverFor}
            onNowNext={onNowNext}
            heightPx={heightPx}
          />
        ) : (
          <p role="status" style={stageWaitStyle} data-testid="completed-job-message" data-state={completedJobChords.status}>
            {completedStatus.message ?? ''}
          </p>
        )}
        {popover}
      </div>
    );
  }

  const bannerMessage =
    !support.supported && support.message
      ? support.message
      : state.unsupportedMessage;

  return (
    <div data-testid="chord-overlay" style={containerStyle}>
      {bannerMessage ? (
        <div role="alert" style={bannerStyle} data-testid="unsupported-banner">
          {bannerMessage}
        </div>
      ) : null}

      <div style={controlsStyle}>
        {isCompletedJobMode ? (
          // Completed-job mode owns no start/stop — the timeline is prebaked.
          // Render a status pill while the fetch is in flight so the empty
          // chip row doesn't look like a no-op.
          <span
            style={providerPillStyle}
            data-testid="completed-job-pill"
            aria-label={`Chord data status: ${completedStatus.pill.toLowerCase()}`}
          >
            {completedStatus.pill}
          </span>
        ) : state.phase !== 'capturing' ? (
          <button
            type="button"
            onClick={handleStart}
            disabled={
              state.phase === 'loading' || !support.supported
            }
            data-testid="start-overlay"
            style={buttonStyle}
          >
            {state.phase === 'loading' ? 'Starting…' : 'Start live overlay'}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStop}
            data-testid="stop-overlay"
            style={buttonStyle}
          >
            Stop
          </button>
        )}
        {state.provider ? (
          <span
            style={providerPillStyle}
            data-testid="provider-pill"
            aria-label={`Inference backend: ${state.provider}`}
          >
            {state.provider.toUpperCase()}
          </span>
        ) : null}
      </div>

      {state.errorMessage ? (
        <div role="alert" style={errorStyle} data-testid="error-toast">
          {state.errorMessage}
        </div>
      ) : null}

      {isCompletedJobMode && completedStatus.message ? (
        <div
          role="status"
          style={emptyStyle}
          data-testid="completed-job-message"
          data-state={completedJobChords.status}
        >
          {completedStatus.message}
        </div>
      ) : null}

      {showPhone && (!isCompletedJobMode || completedStatus.showTimeline) ? (
        <>
          <PhoneChords
            runs={state.runs}
            model={phoneModel!}
            positionSec={isPlayingPos(positionSec) ? positionSec : null}
            activeIdx={activeIdx}
            widthPx={widthPx}
            loop={loop}
            onOpen={setPopoverFor}
          />
          <h3 style={allChordsHeadingStyle} data-testid="all-chords-heading">All chords</h3>
        </>
      ) : null}

      {(!isCompletedJobMode || completedStatus.showTimeline) && state.runs.length > 0 ? (
        <div style={zoomBarStyle} data-testid="zoom-bar">
          <button
            type="button"
            style={zoomBtnStyle}
            aria-label="Zoom out"
            data-testid="zoom-out"
            disabled={!measured || pps <= minPps * 1.001}
            onClick={() => setZoom(clampPxPerSec(pps / 1.5, minPps, maxPps))}
          >
            {'−'}
          </button>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(ppsToSlider(pps, minPps, maxPps) * 1000)}
            disabled={!measured || minPps >= maxPps}
            aria-label="Timeline zoom"
            data-testid="zoom-slider"
            // height: the 44px touch bar (--touch-min). An unsized range input is
            // about 16px tall, which j7 measured at 146x16 (390) and 116x16 (360);
            // Chromium keeps the track centred, so only the hit area grows.
            // marginBlock: 0 is load-bearing, not tidying. Chromium's UA sheet gives
            // this control `margin: 2px`, so height alone makes the flex line 48px and
            // pushes everything below the chord timeline down 4px at every width,
            // desktop included (measured; `margin-block: 0` puts the bar back at 44).
            style={{ flex: 1, minWidth: 80, height: 'var(--touch-min, 44px)', marginBlock: 0, accentColor: '#60a5fa' }}
            onChange={(e) => setZoom(sliderToPps(Number(e.target.value) / 1000, minPps, maxPps))}
          />
          <button
            type="button"
            style={zoomBtnStyle}
            aria-label="Zoom in"
            data-testid="zoom-in"
            disabled={!measured || !canZoomFurther}
            onClick={() => setZoom(clampPxPerSec(pps * 1.5, minPps, maxPps))}
          >
            +
          </button>
          <button
            type="button"
            style={{ ...zoomBtnStyle, width: 'auto', padding: '0 0.75rem' }}
            data-testid="zoom-reset"
            disabled={userPps === null}
            onClick={() => setZoom(null)}
          >
            {/* Not 'Fit': the default is no longer whole-track, it is the zoom
                this job's chord names need. Whole-track is still one drag of the
                slider (or the - button) away, and the hint line below says which
                of the two the user is looking at. */}
            Reset
          </button>
        </div>
      ) : null}

      {!isCompletedJobMode || completedStatus.showTimeline ? (
        <div
          ref={setWrapEl}
          style={{ position: 'relative', visibility: measured ? 'visible' : 'hidden' }}
          data-testid="chord-timeline"
          data-layout={narrow ? 'wrapped' : 'strip'}
          data-px-per-sec={pps.toFixed(3)}
        >
          <style>{SCROLLBAR_CSS}</style>
          {state.runs.length === 0 && state.phase === 'capturing' ? (
            <div style={emptyStyle}>Listening…</div>
          ) : null}
          {narrow ? (
            <div
              style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: WRAP_ROW_GAP_PX }}
              data-testid="chord-rows"
            >
              {wrappedRows}
              {/* Playhead ring, drawn OUTSIDE the memoised rows so a chord
                  change never re-renders a chip. A run split across rows gets
                  a ring on each of its pieces. */}
              {playhead
                ? wrapped.byRun[playhead.runIndex]?.map((seg, i) => (
                    <div
                      key={`ph-${seg.rowIndex}-${i}`}
                      data-testid="chord-playhead-ring"
                      data-run-index={playhead.runIndex}
                      aria-hidden="true"
                      style={{
                        ...playheadRingStyle,
                        top: `${seg.rowIndex * (chipH + WRAP_ROW_GAP_PX)}px`,
                        left: `${GUTTER_PX + seg.leftPx}px`,
                        width: `${Math.max(2, seg.widthPx - 1)}px`,
                        height: `${chipH}px`,
                      }}
                    />
                  ))
                : null}
            </div>
          ) : (
            <>
              <div
                ref={scrollRef}
                className="co-scroll"
                style={timelineStyle}
                onScroll={syncScroll}
                data-testid="chord-scroll"
                tabIndex={0}
                role="region"
                aria-label="Chord timeline, scrolls horizontally"
              >
                <div style={{ position: 'relative', width: `${timelineTotalPx}px`, height: RULER_H + chipH }}>
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: RULER_H, overflow: 'hidden' }} data-testid="time-ruler" aria-hidden="true">
                    {rulerTickEls}
                  </div>
                  <div style={{ position: 'absolute', top: RULER_H, left: 0, right: 0, height: chipH }}>
                    {stripChips}
                  </div>
                  {/* The marker. Two nodes, outside the memoised chips: a line
                      that STEPS to each chord change (Chordify, not a smooth
                      score) and a ring round the chord being heard. Both are
                      pointer-events:none, so nothing here is a control — the
                      only control on this timeline is still the zoom slider. */}
                  {playhead ? (
                    <>
                      <div
                        data-testid="chord-playhead"
                        data-run-index={playhead.runIndex}
                        data-left-px={playhead.leftPx.toFixed(2)}
                        aria-hidden="true"
                        style={{ ...playheadLineStyle, left: `${playhead.leftPx}px`, height: RULER_H + chipH }}
                      />
                      <div
                        data-testid="chord-playhead-ring"
                        data-run-index={playhead.runIndex}
                        aria-hidden="true"
                        style={{
                          ...playheadRingStyle,
                          top: `${RULER_H}px`,
                          left: `${playhead.leftPx}px`,
                          width: `${Math.max(2, playhead.widthPx - 1)}px`,
                          height: `${chipH}px`,
                        }}
                      />
                    </>
                  ) : null}
                </div>
              </div>
              {scrollInfo.left > 1 ? <div style={{ ...fadeStyle, left: 0, background: 'linear-gradient(90deg, rgba(0,0,0,0.7), transparent)' }} aria-hidden="true" /> : null}
              {scrollInfo.total - scrollInfo.client - scrollInfo.left > 1 ? (
                <div style={{ ...fadeStyle, right: 0, background: 'linear-gradient(270deg, rgba(0,0,0,0.7), transparent)' }} aria-hidden="true" />
              ) : null}
            </>
          )}
          {/* Now-playing readout and the re-engage affordance. Deliberately
              BELOW the timeline, nowhere near the zoom bar: the zoom slider
              must not read as transport (Story 3 criterion 5). No aria-live —
              a chord a second would make a screen reader unusable. */}
          {isPlaying && !showPhone ? (
            <div style={playheadBarStyle} data-testid="playhead-bar" data-sounding={playhead && activeRun ? 'true' : 'false'}>
              {/* Mounted for the whole of playback, not just while a chord is
                  sounding, so the ~28px row cannot appear and disappear as
                  playback crosses a gap between chords and shove the hint line
                  (and everything under the timeline) up and down. The CHIP is
                  what toggles; the row keeps its height. Still absent entirely
                  when not playing, which is Story 3 criterion 6. */}
              <span
                style={{ ...nowChordStyle, visibility: playhead && activeRun ? 'visible' : 'hidden' }}
                data-testid="playhead-now"
                data-run-index={activeIdx}
                aria-hidden={playhead && activeRun ? undefined : true}
              >
                {/* Story 3.7 / A11: the CURRENT chord is the largest text in
                    the chord track. "Now" is a small label; the name is
                    CURRENT_CHORD_FONT_PX. textContent stays "Now <name>". */}
                <span style={nowLabelStyle}>Now</span>{' '}
                <span style={nowNameStyle} data-testid="playhead-now-name">
                  {activeRun ? displayText(activeRun) : '\u2014'}
                </span>
              </span>
              {!narrow && followSuspended ? (
                <button
                  type="button"
                  style={followBtnStyle}
                  data-testid="playhead-follow"
                  onClick={() => setFollowSuspended(false)}
                >
                  Follow playback
                </button>
              ) : null}
            </div>
          ) : null}

          {state.runs.length > 0 ? (
            <div style={hintStyle} data-testid="timeline-hint">
              {narrow
                ? `${formatTime(dur)} total · ${wrapped.split ? 'up to ' : ''}${Math.round(rowWidthPx / pps)}s per row · zoom for more or less per row`
                : scrollInfo.total - scrollInfo.client > 1
                  ? `Showing ${formatTime(scrollInfo.left / pps)}–${formatTime((scrollInfo.left + scrollInfo.client) / pps)} of ${formatTime(dur)} · scroll sideways or zoom out`
                  : `Whole track (${formatTime(dur)}) shown · zoom in for detail`}
              {/* The chords that are too short to name AT THIS ZOOM, and
                  whether zooming in reaches them. Without this the raised
                  ceiling is a capability nothing tells the user about: the
                  chips in a fast bridge are colour blocks, and a colour block
                  does not advertise that it has a name one drag away. */}
              {nameless > 0 ? (
                <span data-testid="timeline-nameless">
                  {` · ${nameless} too short to name here${canZoomFurther ? ' · zoom in to read them' : ''}`}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {popover}
    </div>
  );
};

export { N_CHORD_CLASSES };

function isPlayingPos(p: number | null): p is number {
  return typeof p === 'number' && Number.isFinite(p) && p >= 0;
}

function altTitle(a: ChordAlternative): string {
  switch (a.reason) {
    case 'neighbour': return 'The chord next to this one';
    case 'inversion': return 'Same chord, different bass note';
    case 'quality': return 'Same root, different chord type';
    case 'relative': return 'Relative major/minor';
    case 'degree': return 'Dominant or subdominant';
    case 'none': return 'No chord (silence or non-harmonic)';
    case 'unknown': return 'Mark as unknown';
  }
}

/** One chip, shared by the strip and the wrapped layout. */
function renderChip(
  run: OverlayRun,
  idx: number,
  leftPx: number,
  widthPx: number,
  heightPx: number,
  continuedRow: number | null,
  open: (v: { run: OverlayRun; idx: number }) => void,
  measureLabel: LabelMeasure,
) {
  // CHIP_GAP_PX, not a bare 1: fullChipPx reserves this same gap when deciding
  // a label fits, so the number that decides and the number that renders are
  // one value. It was the last untied literal of the family #207 closed for
  // padding and font-size.
  const w = chipContentPx(widthPx);
  const text = displayText(run);
  const density = chipDensity(w, measureLabel(text, CHIP_FONT_PX));
  const hue = run.kind === 'chord' ? rootHue(run.label) : null;
  return (
    <button
      type="button"
      key={continuedRow === null ? `${run.startFrame}-${run.endFrame}-${idx}` : `${run.startFrame}-${run.endFrame}-${idx}-r${continuedRow}`}
      onClick={() => open({ run, idx })}
      style={{
        ...chipStyle,
        ...(hue !== null ? { background: `hsl(${hue} 50% 30%)` } : null),
        ...(run.kind === 'none' ? restChipStyle : null),
        ...(run.kind === 'unknown' ? unknownChipStyle : null),
        position: 'absolute',
        top: 0,
        left: `${leftPx}px`,
        width: `${w}px`,
        height: `${heightPx}px`,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        boxSizing: 'border-box',
        // Narrow chips drop their padding, then their label (they become
        // colour ticks); zooming in restores both.
        //
        // THESE COME FROM THE CONSTANTS chipDensity DECIDES WITH, and must keep
        // doing so. They were `'0 0.5rem'` and `'0.625rem'` -- numerically equal
        // to CHIP_FULL_PAD_PX and CHIP_TIGHT_FONT_PX at a 16px root, but tied to
        // them by nothing. The number that decides a label fits and the number
        // that renders were four independent values in two files, and no test
        // referenced the rendered pair. Measured: widening the padding literal
        // alone to `0 1rem` clipped 20 desktop and 25 mobile chord names with
        // all 1210 tests passing -- this PR's own defect, reintroduced, with a
        // green suite. Written as one number each, that edit cannot be made.
        // (The comment below this chip's styles announces a later polish PR;
        // padding and font-size are the first things such a pass touches.)
        padding: density === 'full' ? `0 ${CHIP_FULL_PAD_PX / 2}px` : '0',
        // EVERY chip declares its font size, in px, from the constants the
        // measurer and chipDensity use. Only `tight` used to, and `full`
        // INHERITED (1rem) while the measurer assumed CHIP_FONT_PX: a browser
        // whose default font size is 20px rendered every full chip 25% wider
        // than the width that decided it fit, with no code change anywhere
        // (measured: 21 chips clipped 13.2px at the ceiling, 29 clipped 15.2px
        // at the default). A px size the browser cannot re-base makes the size
        // that is measured and the size that renders one number. The cost is
        // that chord names no longer follow the user's default font size; the
        // sizing pass should do that on purpose (scale CHIP_FONT_PX, measure at
        // the scaled size) rather than by inheritance.
        // A tick has no text node, so its size is moot; it gets the full one.
        fontSize: `${density === 'tight' ? CHIP_TIGHT_FONT_PX : CHIP_FONT_PX}px`,
        borderRadius: density === 'tick' ? '2px' : '6px',
        ...(continuedRow !== null ? { opacity: 0.85, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 } : null),
      }}
      data-testid={continuedRow === null ? `chord-chip-${idx}` : `chord-chip-${idx}-r${continuedRow}`}
      data-kind={run.kind}
      data-density={density}
      // The chord's DISPLAYED name (guitarist notation), never the Harte data
      // label: the tooltip shows what the chip shows, and the real-Chromium
      // chip-fit gate reads a tick's name off `title` to prove the tick was
      // justified -- it must measure the string that would have been painted.
      title={run.kind === 'chord' ? text : runAriaLabel(run)}
      aria-label={runAriaLabel(run)}
    >
      {/* A tick is too narrow for any legible size, so it renders as a colour
          block with NO text node. It used to render the label at
          `color: transparent`: in the DOM, satisfying every text-content
          assertion, and invisible on screen. The chord is still on
          `aria-label` and `title`, which is where an unreadable-but-present
          label belongs. */}
      {density === 'tick' ? null : text}
    </button>
  );
}

// WebKit has no inline way to style scrollbars; Firefox/Chrome also get
// scrollbar-color/-width inline on the scroller. An always-visible track is
// the point: overlay scrollbars on macOS/iOS hide until touched.
const SCROLLBAR_CSS = `
.co-scroll{scrollbar-width:auto;scrollbar-color:rgba(255,255,255,.55) rgba(255,255,255,.12)}
.co-scroll::-webkit-scrollbar{height:12px}
.co-scroll::-webkit-scrollbar-track{background:rgba(255,255,255,.12);border-radius:6px}
.co-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.55);border-radius:6px;border:2px solid transparent;background-clip:padding-box}
`;

// ---------------- inline styles ----------------
// Visual polish happens in a later PR — these are plain, dark-mode-safe
// defaults so the component renders without any CSS wiring.
const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.75rem',
  background: 'rgba(0,0,0,0.6)',
  color: '#fff',
  borderRadius: '8px',
  minHeight: '96px',
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
};
const controlsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
};
const bannerStyle: CSSProperties = {
  background: '#fff3cd',
  color: '#664d03',
  padding: '0.5rem 0.75rem',
  borderRadius: '6px',
  fontSize: '0.875rem',
};
const errorStyle: CSSProperties = {
  background: '#f8d7da',
  color: '#842029',
  padding: '0.5rem 0.75rem',
  borderRadius: '6px',
  fontSize: '0.875rem',
};
const buttonStyle: CSSProperties = {
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  padding: '0.5rem 1rem',
  borderRadius: '6px',
  cursor: 'pointer',
  fontWeight: 600,
};
const providerPillStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.15)',
  padding: '0.125rem 0.5rem',
  borderRadius: '999px',
  fontSize: '0.75rem',
  letterSpacing: '0.05em',
};
const timelineStyle: CSSProperties = {
  overflowX: 'scroll', // 'scroll' (not 'auto') so the track is always drawn
  overflowY: 'hidden',
  padding: '0.25rem 0 0.5rem',
  minHeight: '36px',
};
const allChordsHeadingStyle: CSSProperties = {
  margin: '8px 0 0',
  fontSize: '14px',
  fontWeight: 600,
  color: 'rgba(255,255,255,0.85)',
};
const zoomBarStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.5rem' };
const zoomBtnStyle: CSSProperties = {
  background: '#374151',
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  minWidth: 44,
  width: 44,
  height: 44,
  fontSize: '1.125rem',
  cursor: 'pointer',
};
const tickStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  height: RULER_H,
  paddingLeft: 4,
  borderLeft: '1px solid rgba(255,255,255,0.35)',
  fontSize: '0.6875rem',
  lineHeight: `${RULER_H}px`,
  color: 'rgba(255,255,255,0.7)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
};
const fadeStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 28,
  width: 28,
  pointerEvents: 'none',
};
const hintStyle: CSSProperties = {
  color: 'rgba(255,255,255,0.65)',
  fontSize: '0.75rem',
  paddingTop: 4,
};
// Playhead. Amber/pink, pointer-events:none, no border-radius on the line:
// unmistakably an indicator and never a handle, so it cannot be confused with
// the zoom slider (which stays blue, interactive, and in its own bar above).
const PLAYHEAD_COLOR = '#f472b6';
const playheadLineStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  width: 2,
  background: PLAYHEAD_COLOR,
  pointerEvents: 'none',
  zIndex: 2,
};
const playheadRingStyle: CSSProperties = {
  position: 'absolute',
  boxSizing: 'border-box',
  border: `2px solid ${PLAYHEAD_COLOR}`,
  borderRadius: 6,
  background: 'rgba(244,114,182,0.16)',
  pointerEvents: 'none',
  zIndex: 1,
};
const playheadBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  paddingTop: 4,
};
// The "Now" readout: the current chord at reading size (Story 3.7, brand book
// v2.2 A11: >= 20px, weight 600). Sizes are px on purpose, like the chips: the
// real-Chromium gate measures what renders, and a px size is what it measures.
// Colours unchanged (a token/colour pass is a separate PR).
const nowChordStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 8,
  background: 'rgba(244,114,182,0.18)',
  border: `1px solid ${PLAYHEAD_COLOR}`,
  color: '#fbcfe8',
  padding: '2px 12px',
  borderRadius: '6px',
  whiteSpace: 'nowrap',
};
const nowLabelStyle: CSSProperties = {
  fontSize: '14px',
  fontWeight: 500,
};
const nowNameStyle: CSSProperties = {
  fontSize: `${CURRENT_CHORD_FONT_PX}px`,
  fontWeight: 600,
  lineHeight: 1.25,
  color: '#fff',
};
const followBtnStyle: CSSProperties = {
  background: 'transparent',
  color: '#fbcfe8',
  border: `1px solid ${PLAYHEAD_COLOR}`,
  borderRadius: '6px',
  padding: '0.125rem 0.5rem',
  fontSize: '0.75rem',
  cursor: 'pointer',
};
const rowLabelStyle: CSSProperties = {
  width: GUTTER_PX,
  flex: 'none',
  fontSize: '0.6875rem',
  color: 'rgba(255,255,255,0.65)',
  fontVariantNumeric: 'tabular-nums',
};
const emptyStyle: CSSProperties = {
  color: 'rgba(255,255,255,0.6)',
  fontStyle: 'italic',
  padding: '0.25rem',
};
const chipStyle: CSSProperties = {
  background: '#1e40af',
  color: '#fff',
  border: 'none',
  padding: '0.25rem 0.5rem',
  borderRadius: '6px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  // Deliberately NO font property here, and none on any element above a chip
  // (the container's fontFamily is the one the measurer reads). Canvas 2D has
  // no font-variant-numeric, no font-feature-settings, no letter-spacing, and
  // it is told one size and one weight: the zoom ceiling and chipDensity size
  // chips with that canvas measurer. A chip that renders tabular digits is
  // wider than the width that decided it fits (measured in Chromium: C:11 by
  // 7.4px, up to 15.2px across the alphabet), so it clips; so does a heavier
  // weight, a larger size or any tracking. Proportional digits make the canvas
  // width and the rendered width agree to within 0.01px at 16px.
  // test/chord-default-zoom.test.mjs ALLOWLISTS what a chip and each of its
  // ancestors may declare, so a font property here fails the suite whatever it
  // is spelled. The ruler and the time readouts keep tabular digits; they are
  // not sized by the measurer.
};
// N (no chord): muted, dashed outline. X (unknown): amber, dotted outline.
const restChipStyle: CSSProperties = {
  background: 'transparent',
  border: '1px dashed rgba(255,255,255,0.5)',
  color: 'rgba(255,255,255,0.7)',
};
const unknownChipStyle: CSSProperties = {
  background: '#78350f',
  border: '1px dotted #fbbf24',
  color: '#fde68a',
};
const popoverStyle: CSSProperties = {
  background: '#111827',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: '8px',
  padding: '0.75rem',
};
const popoverHeaderStyle: CSSProperties = {
  fontWeight: 600,
  marginBottom: '0.5rem',
  fontSize: '0.875rem',
};
const popoverGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))',
  gap: '0.25rem',
};
const altButtonStyle: CSSProperties = {
  background: '#374151',
  color: '#fff',
  border: 'none',
  minHeight: 44,
  padding: '0.25rem 0.5rem',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '0.75rem',
};

// ===========================================================================
// Phone chord view (Stories 3 and 4.8 on phone widths, under
// NARROW_BREAKPOINT_PX). Jon on a phone, 2026-11-15: "You just see a whole
// large list of different chords. You don't know where you're at ... especially
// chords when you have two chords in one bar."
//
//   1. a Now card: where you are ("Chorus 2 · bar 3/16"), the CURRENT chord at
//      NOW_PX, the beat of the bar, and the NEXT chord with "in N beats" (it
//      follows a section loop back to its start);
//   2. the line being played and the next one. In bars mode a bar with two
//      chords is ONE cell split by beats; in sequence mode (no trustworthy
//      grid) one cell per chord, and no beats are shown at all.
// The model, the fit test and the layout are pure: ChordPhone.helpers.ts.
// Nothing slides or scrolls by itself (lines page when playback crosses one),
// so there is no motion to reduce. No aria-live: a chord a second would make a
// screen reader unusable; the current bar and chord carry aria-current. The
// full song stays below ("All chords"), every chord reachable and editable (#212).
// ===========================================================================
interface PhoneChordsProps {
  runs: readonly OverlayRun[];
  model: PhoneModel;
  positionSec: number | null;
  activeIdx: number;
  widthPx: number;
  loop: LoopRegion | null;
  onOpen: (v: { run: OverlayRun; idx: number }) => void;
  onNowNext?: (v: NowNext | null) => void;
  /** The stage's height (stage view); 0 = unknown, nothing grows. */
  heightPx?: number;
}

// ── colours (design v1.4 + Jon 2026-11-17) ──────────────────────────────────
// The CURRENT chord, at the playhead, is Amber Gold: token --chord-now, whose
// one job is exactly that (the Now name, the current bar's edge and its chord,
// the Mix sheet header chord). It stays amber while paused: it marks where the
// playhead IS, not that audio is running. Everything else on the stage is
// neutral: bars on --bg-card, the current bar on --bg-selected, past bars'
// chords in --text-muted, coming ones in --text-secondary.
const CHORD_NOW = 'var(--chord-now, #f59e0b)';
const NOW_PX = 72;
const NEXT_PX = 32;
/** The stage's bar background: past, coming and current. */
function phoneCellBg(current: boolean): string {
  return current ? 'var(--bg-selected, #222222)' : 'var(--bg-card, #161616)';
}

interface PhoneLineViewProps {
  model: PhoneModel;
  runs: readonly OverlayRun[];
  box: LineBox;
  lineIndex: number;
  role: 'current' | 'next';
  currentCell: number;
  activeIdx: number;
  positionSec: number | null;
  onOpen: PhoneChordsProps['onOpen'];
  /** Vertical growth into spare stage height (1 = the laid-out size). Widths and fonts are untouched. */
  scale?: number;
}

const PhoneLineView: FC<PhoneLineViewProps> = memo(function PhoneLineView({ model, runs, box, lineIndex, role, currentCell, activeIdx, positionSec, onOpen, scale = 1 }) {
  const bars = model.mode === 'bars';
  const k = Number.isFinite(scale) && scale > 1 ? scale : 1;
  return (
    <div
      data-testid={role === 'current' ? 'phone-line-current' : 'phone-line-next'}
      data-line={lineIndex}
      data-rows={box.rows}
      data-scale={k.toFixed(3)}
      style={{ position: 'relative', height: box.h * k }}
    >
      {box.cells.map((cb) => {
        const cell = model.cells[cb.cell];
        const isCur = cb.cell === currentCell;
        const past = !isCur && positionSec !== null && cell.endSec <= positionSec;
        // Bars mode: each bar is a group NAMED with its place and its chords in
        // order ("Bar 3 of 16, Chorus 2: G 7, B flat"), and the chord buttons
        // are INSIDE it, so a screen reader hears which chords share a bar.
        // Sequence mode has no bars to group.
        return (
          <div
            key={cb.cell}
            role={bars ? 'group' : undefined}
            aria-label={bars ? phoneBarLabel(model, runs, cb.cell) : undefined}
            aria-current={isCur ? 'true' : undefined}
            data-testid={`phone-cell-${cb.cell}`}
            data-cell={cb.cell}
            data-current={isCur ? 'true' : undefined}
            data-slots={cell.slots.length}
            data-start-sec={cell.startSec.toFixed(3)}
            data-end-sec={cell.endSec.toFixed(3)}
            data-stacked={cb.stacked ? 'true' : undefined}
            style={{
              position: 'absolute',
              left: cb.x,
              top: cb.y * k,
              width: cb.w,
              height: cb.h * k,
              boxSizing: 'border-box',
              borderRadius: 6,
              background: phoneCellBg(isCur),
              outline: isCur ? `2px solid ${CHORD_NOW}` : 'none',
              outlineOffset: -2,
            }}
          >
            {bars ? (
              <span style={barNumberStyle} aria-hidden="true" data-testid="phone-bar-number">
                {cell.numberInSection}
              </span>
            ) : null}
            {cb.slots.map((sb, i) => {
              const run = runs[sb.runIndex];
              const slot = cell.slots[i];
              const isCurSlot = isCur && sb.runIndex === activeIdx;
              return (
                <button
                  type="button"
                  key={sb.runIndex}
                  data-testid={`phone-slot-${sb.runIndex}`}
                  data-cell={cb.cell}
                  data-run-index={sb.runIndex}
                  data-start-sec={run.startSec.toFixed(3)}
                  data-end-sec={run.endSec.toFixed(3)}
                  data-current={isCurSlot ? 'true' : undefined}
                  aria-current={isCurSlot ? 'true' : undefined}
                  aria-label={phoneSlotLabel(run, slot.beats)}
                  title={run.label}
                  onClick={() => onOpen({ run, idx: sb.runIndex })}
                  style={{
                    position: 'absolute',
                    left: sb.x - cb.x,
                    top: (sb.y - cb.y) * k,
                    width: sb.w,
                    height: sb.h * k,
                    border: run.kind === 'none' ? '1px dashed var(--border-control, #737373)' : 'none',
                    borderRadius: 4,
                    background: 'transparent',
                    color: isCurSlot ? CHORD_NOW : past ? 'var(--text-muted, #999999)' : 'var(--text-secondary, #e0e0e0)',
                    padding: `0 ${PHONE_SLOT_PAD_PX}px`,
                    boxSizing: 'border-box',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textAlign: 'center',
                    fontSize: grownFontPx(sb.text, sb.fontPx, sb.w, sb.wrap, k),
                    lineHeight: sb.wrap ? 1.05 : 1.2,
                    fontWeight: isCurSlot ? 700 : 500,
                    whiteSpace: sb.wrap ? 'normal' : 'nowrap',
                    overflowWrap: sb.wrap ? 'anywhere' : undefined,
                    overflow: 'hidden',
                    cursor: 'pointer',
                  }}
                >
                  {sb.text}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
});

const PhoneChords: FC<PhoneChordsProps> = ({ runs, model, positionSec, activeIdx, widthPx, loop, onOpen, onNowNext, heightPx = 0 }) => {
  const bars = model.mode === 'bars';
  const cur = cellIndexAt(model, positionSec);
  const line = cur >= 0 ? lineIndexOfCell(model, cur) : 0;
  const next = nextLineIndex(model, line, loop, positionSec);
  // Layout depends on which chord is current (it may take a larger size), so
  // it is recomputed per chord change, never per frame.
  const curBox = useMemo(
    () => (model.lines[line] ? layoutLine(model, runs, model.lines[line], widthPx, activeIdx) : null),
    [model, runs, line, widthPx, activeIdx],
  );
  const nextBox = useMemo(
    () => (next >= 0 && model.lines[next] ? layoutLine(model, runs, model.lines[next], widthPx, -1) : null),
    [model, runs, next, widthPx],
  );
  const nowRun = activeIdx >= 0 ? runs[activeIdx] : null;
  const nx = nextChord(runs, positionSec, activeIdx, loop);
  const nextRun = nx ? runs[nx.runIndex] : null;
  const cell = cur >= 0 ? model.cells[cur] : null;
  const beat = bars && cell && positionSec !== null ? beatInCell(cell, positionSec, model.beatsPerBar) : -1;
  const count = bars && cell && nx ? beatsUntil(cell, nx.inSec, model.beatsPerBar) : null;
  const nowText = nowRun ? leadSheetSymbol(nowRun) : '—';
  const nextText = nextRun ? leadSheetSymbol(nextRun) : '';
  const whenText = nx ? `${nx.wraps ? 'Loops back' : 'Next'}${count !== null ? ` in ${count} beat${count === 1 ? '' : 's'}` : ''}` : '';
  // Use the stage's spare HEIGHT (Jon, 2026-11-17: no empty band between the
  // beat row and the bars): when the 96px step fits beside the laid-out bars the
  // ladder starts there, and what is still spare grows the bar lines, up to
  // GROWN_BAR_PX tall. The fit ladder itself is unchanged.
  // No room for the next line at the smallest Now (a short or zoomed screen):
  // drop it rather than clip it. The current line always stays.
  // Fit EVERYTHING to the measured height (review R2 on #288: never draw a bar
  // line under the section strip). Ladders are tried largest first; for each,
  // the Now name is fitted to the width (P1.2's ladder, unchanged), then the
  // stage needs its chrome + that Now + (Next's own row if it moved) + the bar
  // lines. The first ladder that fits with both lines wins; failing that, the
  // first that fits with the current line alone (the NEXT line is dropped, not
  // clipped). Unknown height: the plain ladders, both lines.
  const wide = widthPx >= WIDE_STAGE_PX;
  const nextPx = wide ? WIDE_NEXT_PX : NEXT_PX;
  const nextW = nx ? Math.max(nameWidthPx(whenText, 13, 1.05), nameWidthPx(nextText, nextPx, 1.12)) : 0;
  const curH = curBox?.h ?? 0;
  const bothH = curH + (nextBox ? nextBox.h + LINE_GAP_PX : 0);
  const ladders: readonly (readonly number[])[] = wide
    ? [WIDE_NOW_SIZES, TALL_NOW_SIZES, NOW_SIZES]
    : [TALLER_NOW_SIZES, TALL_NOW_SIZES, NOW_SIZES];
  const fitFor = (l: readonly number[]) => fitNowName(nowText, widthPx - 4, nextW, l);
  const need = (f: ReturnType<typeof fitNowName>, lines: number) =>
    stageChromePx(f.lines.length * f.px) + (f.nextBelow ? Math.ceil(13 * 1.3 + nextPx * 1.1 + 4) : 0) + lines;
  let fit = fitFor(wide ? WIDE_NOW_SIZES : NOW_SIZES);
  let showNext = !!nextBox;
  if (heightPx > 0) {
    const fits = (lines: number) => {
      for (const l of ladders) {
        const f = fitFor(l);
        if (need(f, lines) <= heightPx) return f;
      }
      return null;
    };
    const withBoth = nextBox ? fits(bothH) : null;
    if (withBoth) fit = withBoth;
    else {
      showNext = false;
      fit = fits(curH) ?? fitFor(NOW_SIZES);
    }
  }
  const linesH = showNext ? bothH : curH;
  const lineScale = growScale(heightPx > 0 ? heightPx - need(fit, linesH) : 0, curBox, showNext ? nextBox : null);

  // The Mix sheet header reads these. Fired on a CHANGE of name, never per frame.
  const nowSpoken = nowRun ? spokenSymbol(nowRun) : '';
  const nextSpoken = nextRun ? spokenSymbol(nextRun) : '';
  useEffect(() => {
    if (!onNowNext) return;
    onNowNext(nowRun ? { now: nowText, nowSpoken, next: nextText, nextSpoken } : null);
  }, [onNowNext, nowRun, nowText, nowSpoken, nextText, nextSpoken]);
  useEffect(() => () => onNowNext?.(null), [onNowNext]);

  return (
    <div
      data-testid="phone-chords"
      data-mode={model.mode}
      data-beats-per-bar={model.beatsPerBar}
      data-reason={model.reason}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: '1 1 auto', minHeight: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 20 }}>
        <span style={positionStyle} data-testid="phone-position">
          {cur >= 0 ? positionLabel(model, cur) : 'Now'}
        </span>
      </div>
      {nowRun ? (
        // The names in words, for a screen reader (the glyph text is hidden from it).
        // Not live: a chord a second would make a screen reader unusable (DECISION.md:44).
        <p style={srOnlyStyle} data-testid="phone-now-spoken">
          {`Now ${nowSpoken}.${nextRun ? ` ${whenText} ${nextSpoken}.` : ''}`}
        </p>
      ) : null}
      <div style={{ display: 'flex', flexWrap: fit.nextBelow ? 'wrap' : 'nowrap', alignItems: 'flex-end', justifyContent: 'space-between', columnGap: NOW_NEXT_GAP_PX, rowGap: 4 }}>
        <span data-testid="playhead-now" data-run-index={activeIdx} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={stageLabelStyle} aria-hidden={nowRun ? true : undefined}>Now</span>
          <span
            data-testid="playhead-now-name"
            data-fit={fit.how}
            aria-hidden={nowRun ? true : undefined}
            style={{ fontSize: fit.px, fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.02em', color: CHORD_NOW, whiteSpace: 'nowrap' }}
          >
            {fit.lines.map((l, i) => (
              <span key={i} style={{ display: 'block' }}>
                {l}
              </span>
            ))}
          </span>
        </span>
        {nextRun && nx ? (
          <span
            style={{ display: 'flex', flexDirection: 'column', alignItems: fit.nextBelow ? 'flex-start' : 'flex-end', flex: 'none', paddingBottom: 6, ...(fit.nextBelow ? { width: '100%' } : null) }}
            data-testid="phone-next"
            data-run-index={nx.runIndex}
            data-wraps={nx.wraps ? 'true' : undefined}
          >
            <span style={stageLabelStyle} data-testid="phone-next-when" aria-hidden="true">
              {whenText}
            </span>
            <span aria-hidden="true" style={{ fontSize: nextPx, lineHeight: 1.1, fontWeight: 600, color: 'var(--text-secondary, #e0e0e0)', whiteSpace: 'nowrap' }} data-testid="phone-next-name">
              {nextText}
            </span>
          </span>
        ) : null}
      </div>
      {beat >= 0 ? (
        <div
          role="img"
          aria-label={`Beat ${beat + 1} of ${model.beatsPerBar}`}
          style={{ display: 'grid', gridTemplateColumns: `repeat(${model.beatsPerBar}, minmax(0, 1fr))`, gap: 6 }}
          data-testid="phone-beats"
          data-beat={beat + 1}
        >
          {Array.from({ length: model.beatsPerBar }, (_, b) => (
            <span
              key={b}
              data-testid="phone-beat-dot"
              data-on={b === beat ? 'true' : undefined}
              style={{ height: 6, borderRadius: 3, background: b <= beat ? 'var(--text-primary, #ffffff)' : 'var(--text-subtle, #666666)' }}
            />
          ))}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: LINE_GAP_PX, marginTop: 'auto' }}>
        {curBox ? (
          <PhoneLineView model={model} runs={runs} box={curBox} lineIndex={line} role="current" currentCell={cur} activeIdx={activeIdx} positionSec={positionSec} onOpen={onOpen} scale={lineScale} />
        ) : null}
        {nextBox && showNext ? (
          <PhoneLineView model={model} runs={runs} box={nextBox} lineIndex={next} role="next" currentCell={-1} activeIdx={-1} positionSec={null} onOpen={onOpen} scale={lineScale} />
        ) : null}
      </div>
    </div>
  );
};

const PHONE_SLOT_PAD_PX = SLOT_PAD_PX;
const NOW_NEXT_GAP_PX = 12;
const LINE_GAP_PX = 6;
/**
 * The Now name's fit ladder, largest first (design v1.4, P1.2: the shipped
 * ladder extended upward, 72 -> ... -> 28). The card never goes below 28px
 * (A11 asks >= 20). Then the slash bass moves to a second line, then Next
 * moves to its own row.
 */
export const NOW_SIZES = [NOW_PX, 64, 56, 44, 40, 36, 32, 28] as const;
/** A stage at least this wide (the desktop column) starts the ladder higher. */
export const WIDE_STAGE_PX = 700;
export const WIDE_NOW_SIZES = [128, 96, ...NOW_SIZES] as const;
export const TALL_NOW_SIZES = [TALL_NOW_PX, ...NOW_SIZES] as const;
export const TALLER_NOW_SIZES = [TALLER_NOW_PX, TALL_NOW_PX, ...NOW_SIZES] as const;
const WIDE_NEXT_PX = 48;
/** Bold text width from the headless advance table, widened by `factor` (conservative; see STAGE_WIDEST_GLYPHS). */
function nameWidthPx(text: string, px: number, factor: number): number {
  return text ? estimateStageLabelPx(text, px) * factor : 0;
}
/**
 * Fit the Now name beside Next so the two NEVER overlap: the largest size that
 * fits on one line; then, at 28px, the slash bass on a second line ("C♯m7♭5" /
 * "/G♯"); then Next moves to its own row below. The real-Chromium gate checks
 * the two boxes never intersect.
 */
export function fitNowName(
  text: string,
  innerPx: number,
  nextPx: number,
  sizes: readonly number[] = NOW_SIZES,
): { px: number; lines: string[]; nextBelow: boolean; how: string } {
  const room = innerPx - (nextPx > 0 ? nextPx + NOW_NEXT_GAP_PX : 0);
  const w = (t: string, px: number) => nameWidthPx(t, px, 1.15);
  for (const px of sizes) if (w(text, px) <= room) return { px, lines: [text], nextBelow: false, how: `one-line-${px}` };
  const min = sizes[sizes.length - 1];
  const slash = text.indexOf('/');
  if (slash > 0) {
    const lines = [text.slice(0, slash), text.slice(slash)];
    if (Math.max(...lines.map((l) => w(l, min))) <= room) return { px: min, lines, nextBelow: false, how: 'two-line' };
  }
  for (const px of sizes) if (w(text, px) <= innerPx) return { px, lines: [text], nextBelow: true, how: `next-below-${px}` };
  return { px: min, lines: slash > 0 ? [text.slice(0, slash), text.slice(slash)] : [text], nextBelow: true, how: 'next-below-min' };
}

const barNumberStyle: CSSProperties = {
  position: 'absolute',
  top: 1,
  left: 5,
  height: CELL_HEAD_PX - 2,
  fontSize: 12,
  lineHeight: `${CELL_HEAD_PX - 2}px`,
  color: 'var(--text-label, #8a8a8a)',
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums',
  pointerEvents: 'none',
};
const positionStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--text-secondary, #e0e0e0)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const stageLabelStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--text-muted, #999999)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  whiteSpace: 'nowrap',
};
const stageRootStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
};
const srOnlyStyle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};
const stageWaitStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  color: 'var(--text-muted, #999999)',
};

export default ChordOverlay;
