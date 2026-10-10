'use client';

// Below-the-fold pieces that use the example's real data: the pipeline art, the
// before/after compare, the WAV download and the "go to the input" links.
import { useEffect, useMemo, useRef, useState } from 'react';
import { DEMO_WAV_FILENAME, DEMO_WAV_URL } from '@/lib/public-config';
import { type AbChoice, useDemo } from './DemoProvider';
import { type DemoData, SILENT_PEAKS, STEM_ORDER, driftMs, envPath, stemOf } from './demo-data';
import { Ic, Wave } from './Icons';

export function PipeSongArt() {
  const { data } = useDemo();
  const d = useMemo(() => (data ? envPath(data.ctx.song.peaks) : ''), [data]);
  return (
    <div className="pipe-song" id="pipe-song" aria-hidden="true">
      {data && <Wave d={d} />}
    </div>
  );
}

export function PipeStemsArt() {
  const { data } = useDemo();
  const rows = useMemo(
    () => (data ? STEM_ORDER.map((n) => ({ n, d: envPath(stemOf(data, '8bar', n)?.peaks ?? SILENT_PEAKS) })) : []),
    [data],
  );
  return (
    <div className="pipe-stems" id="pipe-stems" aria-hidden="true">
      {rows.map(({ n, d }) => (
        <div className="pipe-stem" key={n}>
          <span className="mono">{n}</span>
          <div className="w">
            <Wave d={d} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function PipeCutArt() {
  const { data } = useDemo();
  const d = useMemo(() => (data ? envPath(stemOf(data, '8bar', 'drums')?.peaks ?? SILENT_PEAKS) : ''), [data]);
  return (
    <div className="pipe-cut" id="pipe-cut" aria-hidden="true" style={{ '--region': '100%' } as React.CSSProperties}>
      {data && (
        <>
          <Wave d={d} />
          <Wave d={d} variant="loop" />
          <div className="bracket" />
        </>
      )}
    </div>
  );
}

function abPeaks(data: DemoData, v: AbChoice): number[] {
  if (v === 'drums') return stemOf(data, '4bar', 'drums')?.peaks ?? SILENT_PEAKS;
  if (data.before?.['4bar']) return data.before['4bar'];
  // fallback: the whole-song peaks for the same window, normalised
  const P = data.ctx.song.peaks;
  const a = Math.floor(data.ctx.loop.start_fraction * P.length);
  const b = Math.ceil(data.ctx.loop.nested_end_fraction['4bar'] * P.length);
  const sl = P.slice(a, b);
  const mx = Math.max(...sl) || 1;
  return sl.map((x) => x / mx);
}

export function AbCompare() {
  const { data, status, abOn, audio, toggleAb, switchAb, retryAudio } = useDemo();
  const [choice, setChoice] = useState<AbChoice>('before');
  const ref = useRef<HTMLFieldSetElement>(null);
  const ready = status === 'ready' && !!data;
  const d = useMemo(() => (data ? envPath(abPeaks(data, choice)) : ''), [data, choice]);

  // inert while the sample is missing (React 18 has no `inert` prop)
  useEffect(() => {
    ref.current?.toggleAttribute('inert', status === 'failed');
  }, [status]);

  return (
    <fieldset className="ab" id="ab" ref={ref}>
      <legend className="label">Hear the split: the original, then one stem</legend>
      <div className="ab-row">
        <div className="seg" id="ab-seg">
          {(
            [
              ['before', 'Original mix'],
              ['drums', 'Drums stem'],
            ] as const
          ).map(([v, label]) => (
            <label className="seg-opt" key={v}>
              <input
                type="radio"
                name="ab"
                value={v}
                checked={choice === v}
                disabled={!ready}
                onChange={() => {
                  setChoice(v);
                  switchAb(v);
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <button
          type="button"
          className={`btn btn-secondary btn-play${abOn ? ' is-active' : ''}`}
          id="ab-play"
          disabled={!ready}
          onClick={() => toggleAb(choice)}
        >
          <Ic name={abOn ? 'stop' : 'play'} />
          <span>{abOn ? 'Stop' : 'Play'}</span>
        </button>
      </div>
      <div className="ab-wave" id="ab-wave" aria-hidden="true" style={{ '--region': '100%' } as React.CSSProperties}>
        {data && (
          <>
            <Wave d={d} />
            {choice !== 'before' && <Wave d={d} variant="loop" />}
          </>
        )}
        <div className="playhead" />
      </div>
      <p className="hint" id="ab-note" aria-live="polite">
        {audio.abError ? (
          <>
            <strong>That clip didn’t load.</strong>{' '}
            <button type="button" className="link-btn" onClick={retryAudio}>
              Try again
            </button>
          </>
        ) : (
          <>
            The first 4 bars of the drums file above, against the original mix at the same spot (MP3 preview). It also repeats long:
            about {data ? driftMs(data, 4) : 62}&nbsp;ms per 4&#8209;bar loop. Expect a little bleed on dense mixes.
          </>
        )}
      </p>
    </fieldset>
  );
}

// Cross-origin <a download> is ignored by browsers, so fetch the WAV (the host sends CORS)
// and save it under its real name; if that fails, fall back to a plain navigation.
export function DemoWavDownload() {
  const [busy, setBusy] = useState(false);
  if (!DEMO_WAV_URL) return null;
  return (
    <a
      className="btn btn-secondary btn-dl"
      href={DEMO_WAV_URL}
      download={DEMO_WAV_FILENAME}
      aria-busy={busy ? true : undefined}
      onClick={async (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
          const r = await fetch(DEMO_WAV_URL);
          if (!r.ok) throw new Error(String(r.status));
          const url = URL.createObjectURL(await r.blob());
          const a = document.createElement('a');
          a.href = url;
          a.download = DEMO_WAV_FILENAME;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } catch {
          window.location.href = DEMO_WAV_URL;
        } finally {
          setBusy(false);
        }
      }}
    >
      <Ic name="down" />
      <span>Download WAV</span>
    </a>
  );
}

// Scroll to the tool and focus the input (the file row's Replace if a file is picked).
export function ToInputLink({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <a
      className={className}
      href="#tool"
      onClick={(e) => {
        e.preventDefault();
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        document.getElementById('tool')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        const picked = document.getElementById('picked');
        const target =
          picked && !picked.hidden
            ? document.getElementById('picked-replace')
            : (document.getElementById('source') ?? document.getElementById('file-btn'));
        target?.focus({ preventScroll: true });
      }}
    >
      {children}
    </a>
  );
}
