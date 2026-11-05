// Live chord overlay — Variant Y (free tier) wedge component.
// Decision record: claude/phase-2-y1-chord-model-decision.md v1.3 §1.6a.
//
// Pipeline: tab-capture → cqt-frontend → chordnet-session → smoothChordSequence
//           → run-length collapse → timeline render.
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

import { N_CHORD_CLASSES, chordLabel } from '../chord/alphabet.ts';
import {
  type ChordnetSession,
  loadChordnetSession,
  resolveModelUrl,
} from '../chord/chordnet-session.ts';
import { computeCQT, loadCqtPlan } from '../chord/cqt-frontend.ts';
import { collapseRuns, type ChordRun } from '../chord/smoother.ts';
import {
  type TabCapture,
  UnsupportedBrowserError,
  checkTabCaptureSupport,
  startTabCapture,
} from '../chord/tab-capture.ts';
import { smoothChordSequence } from '../chord/viterbi.ts';
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
}) => {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const [popoverFor, setPopoverFor] = useState<ChordRun | null>(null);
  const sessionRef = useRef<ChordnetSession | null>(null);
  const captureRef = useRef<TabCapture | null>(null);

  // Early feature-detect so we can show the banner without starting capture.
  const support = useMemo(() => {
    if (typeof window === 'undefined') return { supported: true } as const;
    return checkTabCaptureSupport();
  }, []);

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
      const [, session] = await Promise.all([
        loadCqtPlan(),
        loadChordnetSession(resolvedUrl),
      ]);
      sessionRef.current = session;

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
          const seq = smoothChordSequence(logits, nFrames);
          const runs = collapseRuns(seq);
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
        {state.phase !== 'capturing' ? (
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
            aria-label={`${chordLabel(run.cls)} — edit`}
          >
            {chordLabel(run.cls)}
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
            Change {chordLabel(popoverFor.cls)}
          </div>
          <div style={popoverGridStyle}>
            {popoverAlternatives(popoverFor.cls, 10).map((cls) => (
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
