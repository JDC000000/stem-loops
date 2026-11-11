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
import type { ChordPlayheadProps } from '../lib/play/types.ts';
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
  alternativeText,
  buildChordEdit,
  buildChordLabelEdit,
  chipBox,
  chipDensity,
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
  markMonotoneRuns,
  observationsToRuns,
  playheadGeometry,
  ppsToSlider,
  resolveAutoScroll,
  rootHue,
  rulerTicks,
  runAriaLabel,
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
}) => {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const [popoverFor, setPopoverFor] = useState<{ run: OverlayRun; idx: number } | null>(null);
  // Zoom: null = fit-to-width (the default); otherwise explicit px/sec.
  const [userPps, setUserPps] = useState<number | null>(null);
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const [widthPx, setWidthPx] = useState(0);
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
    const measure = () => setWidthPx(Math.floor(wrapEl.getBoundingClientRect().width));
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
  const defaultPps = narrow
    ? clampPxPerSec(rowWidthPx / WRAP_DEFAULT_ROW_SEC, minPps)
    : minPps;
  const pps = userPps === null ? defaultPps : clampPxPerSec(userPps, minPps);
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
        return renderChip(run, idx, box.leftPx, box.widthPx, chipH, null, setPopoverFor);
      }),
    [state.runs, pps, chipH],
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
  const wrapped = useMemo(() => {
    const rows = layoutRows(state.runs, rowWidthPx / pps, pps);
    const byRun: { rowIndex: number; leftPx: number; widthPx: number }[][] = state.runs.map(() => []);
    rows.forEach((row, ri) => {
      for (const seg of row.segments) {
        byRun[seg.runIndex]?.push({ rowIndex: ri, leftPx: seg.leftPx, widthPx: seg.widthPx });
      }
    });
    return { rows, byRun };
  }, [state.runs, rowWidthPx, pps]);

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
              ),
            )}
          </div>
        </div>
      )),
    [wrapped.rows, state.runs, rowWidthPx, chipH],
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

      {(!isCompletedJobMode || completedStatus.showTimeline) && state.runs.length > 0 ? (
        <div style={zoomBarStyle} data-testid="zoom-bar">
          <button
            type="button"
            style={zoomBtnStyle}
            aria-label="Zoom out"
            data-testid="zoom-out"
            disabled={!measured || pps <= minPps * 1.001}
            onClick={() => setZoom(clampPxPerSec(pps / 1.5, minPps))}
          >
            {'−'}
          </button>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(ppsToSlider(pps, minPps) * 1000)}
            disabled={!measured || minPps >= MAX_PX_PER_SEC}
            aria-label="Timeline zoom"
            data-testid="zoom-slider"
            style={{ flex: 1, minWidth: 80, accentColor: '#60a5fa' }}
            onChange={(e) => setZoom(sliderToPps(Number(e.target.value) / 1000, minPps))}
          />
          <button
            type="button"
            style={zoomBtnStyle}
            aria-label="Zoom in"
            data-testid="zoom-in"
            disabled={!measured || pps >= MAX_PX_PER_SEC * 0.999}
            onClick={() => setZoom(clampPxPerSec(pps * 1.5, minPps))}
          >
            +
          </button>
          <button
            type="button"
            style={{ ...zoomBtnStyle, width: 'auto', padding: '0 0.75rem' }}
            data-testid="zoom-fit"
            disabled={userPps === null}
            onClick={() => setZoom(null)}
          >
            {narrow ? 'Reset' : 'Fit'}
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
          {isPlaying ? (
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
                Now {activeRun ? displayText(activeRun) : '\u2014'}
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
                ? `${formatTime(dur)} total · ${Math.round(rowWidthPx / pps)}s per row · zoom for more or less per row`
                : scrollInfo.total - scrollInfo.client > 1
                  ? `Showing ${formatTime(scrollInfo.left / pps)}–${formatTime((scrollInfo.left + scrollInfo.client) / pps)} of ${formatTime(dur)} · scroll sideways or zoom out`
                  : `Whole track (${formatTime(dur)}) shown · zoom in for detail`}
            </div>
          ) : null}
        </div>
      ) : null}

      {popoverFor ? (
        <div
          role="dialog"
          aria-label="Pick a different chord"
          style={popoverStyle}
          data-testid="chord-popover"
        >
          <div style={popoverHeaderStyle}>
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
    </div>
  );
};

export { N_CHORD_CLASSES };

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
) {
  const w = Math.max(1, widthPx - 1); // 1px gap so adjacent chips stay distinct
  const density = chipDensity(w);
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
        padding: density === 'full' ? '0 0.5rem' : '0',
        ...(density === 'tight' ? { fontSize: '0.625rem' } : null),
        ...(density === 'tick' ? { color: 'transparent' } : null),
        borderRadius: density === 'tick' ? '2px' : '6px',
        ...(continuedRow !== null ? { opacity: 0.85, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 } : null),
      }}
      data-testid={continuedRow === null ? `chord-chip-${idx}` : `chord-chip-${idx}-r${continuedRow}`}
      data-kind={run.kind}
      data-density={density}
      title={run.kind === 'chord' ? run.label : runAriaLabel(run)}
      aria-label={runAriaLabel(run)}
    >
      {displayText(run)}
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
const nowChordStyle: CSSProperties = {
  background: 'rgba(244,114,182,0.18)',
  border: `1px solid ${PLAYHEAD_COLOR}`,
  color: '#fbcfe8',
  padding: '0.125rem 0.5rem',
  borderRadius: '999px',
  fontSize: '0.75rem',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
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
  fontVariantNumeric: 'tabular-nums',
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

export default ChordOverlay;
