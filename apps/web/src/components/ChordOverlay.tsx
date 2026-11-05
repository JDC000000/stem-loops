// Live chord overlay — Variant Y (free tier) wedge component.
// Decision record: claude/phase-2-y1-chord-model-decision.md v1.3 §1.6a.
//
// Pipeline: tab-capture → cqt-frontend → chordnet-session → smoothChordLogits
//           → collapseRuns → timeline render.
//
// Edits a user makes on the timeline hook into PR-Y1.7's edit-collector via
// the `onChordEdit` prop (this component owns no state beyond the UI).
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

import { N_CHORD_CLASSES, chordLabel, labelIndex } from '../chord/alphabet.ts';
import {
  type ChordnetSession,
  loadChordnetSession,
  resolveModelUrl,
} from '../chord/chordnet-session.ts';
import { computeCQT, loadCqtPlan } from '../chord/cqt-frontend.ts';
import {
  collapseRuns,
  smoothChordLogits,
  type ChordRun,
} from '../chord/smoother.ts';
import {
  type ChordObservation,
  usePlayChords,
} from '../chord/play-chords-loader.ts';
import {
  type TabCapture,
  UnsupportedBrowserError,
  checkTabCaptureSupport,
  startTabCapture,
} from '../chord/tab-capture.ts';
import {
  type ChordEdit,
  buildChordEdit,
  popoverAlternatives,
} from './ChordOverlay.helpers.ts';

export type { ChordEdit };

export interface ChordOverlayProps {
  onStart?: () => void;
  onStop?: () => void;
  /** Fired when the user picks a replacement chord from the popover. */
  onChordEdit?: (edit: ChordEdit) => void;
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

// Scale used when mapping play.chords.json seconds → ChordRun frames. The
// overlay's chip-width formula uses `frames * 8px` (see chipStyle), so 10
// frames/sec gives each second ~80px — roughly one bar at 120 BPM / 4/4,
// matching the density the live-capture path renders at.
const CHORDS_FRAMES_PER_SEC = 10;

/**
 * Convert ChordObservation[] (seconds-based, Harte labels) → ChordRun[]
 * (frame-based, class indices). N/X observations are dropped — they have no
 * class index in the 60-label alphabet and the chip row is better off empty
 * at those spans than cluttered with no-chord fillers.
 */
export function observationsToRuns(obs: readonly ChordObservation[]): ChordRun[] {
  const runs: ChordRun[] = [];
  for (const o of obs) {
    const cls = labelIndex(o.label);
    if (cls < 0) continue;
    const startFrame = Math.max(0, Math.round(o.startSec * CHORDS_FRAMES_PER_SEC));
    const endFrame = Math.max(startFrame + 1, Math.round(o.endSec * CHORDS_FRAMES_PER_SEC));
    runs.push({ cls, startFrame, endFrame });
  }
  return runs;
}

interface State {
  phase: 'idle' | 'loading' | 'capturing' | 'error';
  runs: ChordRun[];
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
  modelUrl,
  jobId,
}) => {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const [popoverFor, setPopoverFor] = useState<ChordRun | null>(null);
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

  // Push the loaded observations into the shared `state.runs` so the render
  // path below is identical to the live-capture one. On null (loading / 404)
  // keep whatever was there — a transient re-fetch shouldn't blank the UI.
  useEffect(() => {
    if (!isCompletedJobMode) return;
    if (completedJobChords === null) return;
    setState({
      phase: 'capturing',
      runs: observationsToRuns(completedJobChords),
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
          const runs = collapseRuns(classes, frameSec);
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
    (run: ChordRun, newCls: number) => {
      onChordEdit?.(buildChordEdit(run, newCls));
      setPopoverFor(null);
    },
    [onChordEdit],
  );

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
            aria-label="Chord data source: completed job"
          >
            {completedJobChords === null ? 'LOADING' : 'JOB'}
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

      <div style={timelineStyle} data-testid="chord-timeline">
        {state.runs.length === 0 && state.phase === 'capturing' ? (
          <div style={emptyStyle}>Listening…</div>
        ) : null}
        {state.runs.map((run, idx) => (
          <button
            type="button"
            key={`${run.startFrame}-${run.endFrame}-${idx}`}
            onClick={() => setPopoverFor(run)}
            style={{
              ...chipStyle,
              width: `${Math.max(32, (run.endFrame - run.startFrame) * 8)}px`,
            }}
            data-testid={`chord-chip-${idx}`}
            aria-label={`${run.label} — edit`}
          >
            {run.label}
          </button>
        ))}
      </div>

      {popoverFor ? (
        <div
          role="dialog"
          aria-label="Pick a different chord"
          style={popoverStyle}
          data-testid="chord-popover"
        >
          <div style={popoverHeaderStyle}>
            Change {popoverFor.label}
          </div>
          <div style={popoverGridStyle}>
            {popoverAlternatives(popoverFor.chordClass, 10).map((cls) => (
              <button
                type="button"
                key={cls}
                onClick={() => handlePickAlternative(popoverFor, cls)}
                data-testid={`alt-${cls}`}
                style={altButtonStyle}
              >
                {chordLabel(cls)}
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
  display: 'flex',
  gap: '0.25rem',
  overflowX: 'auto',
  padding: '0.25rem 0',
  minHeight: '36px',
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
  gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
  gap: '0.25rem',
};
const altButtonStyle: CSSProperties = {
  background: '#374151',
  color: '#fff',
  border: 'none',
  padding: '0.25rem 0.5rem',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '0.75rem',
};

export default ChordOverlay;
