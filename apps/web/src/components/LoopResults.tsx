'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Job, Loop } from '@stem-loops/types';
import { LoopCard } from '@/components/LoopCard';
import { downloadLoopPack } from '@/lib/zipLoops';

// Stable stem order for the filter tabs (guitar is first-class, never 'piano').
// THE stem order, the mixer's (Story 2.1; brand book A3). test/brand-tokens.test.mjs pins it.
const STEM_ORDER = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];

/** How often to re-poll while a cut is running, in ms. */
export const CUT_POLL_MS = 2500;
/** Stop polling a cut that has not finished after this long, and say so. */
export const CUT_POLL_MAX_MS = 10 * 60 * 1000;

type LoopRow = Loop & { signed_url?: string | null };

/** A loop whose WAV exists in R2. Migration 033: `cut_at` null means described, not cut. */
export function isCut(loop: Pick<LoopRow, 'cut_at'>): boolean {
  return loop.cut_at !== null && loop.cut_at !== undefined;
}

export interface LoopResultsDeps {
  /** POST /api/jobs/:id/loops — ask for the cut. */
  requestCut: (jobId: string) => Promise<void>;
  /**
   * Re-read this job's loop rows so freshly cut ones (and their signed URLs) arrive.
   * Returns the rows, or nothing when it could not read them (the poll just tries again).
   */
  refresh: (jobId: string) => Promise<LoopRow[] | null | void>;
  /** Download-all. Injectable so a test need not drive a real Blob/anchor. */
  zip: typeof downloadLoopPack;
}

const defaultDeps: LoopResultsDeps = {
  requestCut: async (jobId) => {
    const res = await fetch(`/api/jobs/${jobId}/loops`, { method: 'POST' });
    if (!res.ok) throw new Error(`cut request failed: ${res.status}`);
  },
  // NOT a page reload. A reload reset `cutting` mid-cut, so the page came back
  // showing part of the set beside a "Cut N loops" button and stopped polling (W4
  // browser journey j1), and it re-fetched every stem each time. The job page's own
  // poll has stopped (the job is `done`), so this component reads the rows itself.
  refresh: async (jobId) => {
    const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { loops?: unknown } | null;
    return Array.isArray(body?.loops) ? (body.loops as LoopRow[]) : null;
  },
  zip: downloadLoopPack,
};

export function LoopResults({
  job,
  deps = defaultDeps,
}: {
  job: Job & { title?: string | null };
  deps?: LoopResultsDeps;
}) {
  // Rows read by the cut poll win over the props once there are any.
  const [fresh, setFresh] = useState<LoopRow[] | null>(null);
  const loops = useMemo(() => (fresh ?? job.loops ?? []) as LoopRow[], [fresh, job.loops]);
  // Bumped after every refresh, so a reply with an unchanged pending count still
  // schedules the next poll (the effect would otherwise not re-run).
  const [pollTick, setPollTick] = useState(0);
  const cutStarted = useRef<number | null>(null);
  const [stem, setStem] = useState<string>('all');
  const [zipping, setZipping] = useState(false);
  const [cutting, setCutting] = useState(false);
  const [cutError, setCutError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Migration 033: the worker records every loop and encodes none of them, so a
  // job can be `done` with a full set of rows and nothing yet in R2. Only a cut
  // row has bytes to offer; an uncut one has no signed URL (the API withholds
  // it) and must not be presented as a download.
  const cutLoops = useMemo(() => loops.filter(isCut), [loops]);
  const pending = loops.length - cutLoops.length;

  const stems = useMemo(() => {
    const present = new Set(cutLoops.map((l) => l.stem));
    return STEM_ORDER.filter((s) => present.has(s));
  }, [cutLoops]);

  const shown = stem === 'all' ? cutLoops : cutLoops.filter((l) => l.stem === stem);
  const title = job.title || 'stem-loops';

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Once a cut is running, nothing pushes the finished rows here — poll until
  // the refresh brings them in. `pending` reaching 0 ends it via the re-render.
  useEffect(() => {
    if (!cutting || pending === 0) return;
    if (cutStarted.current !== null && Date.now() - cutStarted.current > CUT_POLL_MAX_MS) {
      setCutting(false);
      setCutError('The cut is taking longer than expected. Refresh the page to check on it.');
      return;
    }
    let live = true;
    timer.current = setTimeout(async () => {
      try {
        const rows = await deps.refresh(job.id);
        if (live && rows) setFresh(rows);
      } catch {
        /* a failed read is retried on the next tick */
      }
      if (live) setPollTick((n) => n + 1);
    }, CUT_POLL_MS);
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [cutting, pending, deps, job.id, pollTick]);

  useEffect(() => {
    if (pending === 0) setCutting(false);
  }, [pending]);

  const onCut = useCallback(async () => {
    setCutError(null);
    setCutting(true);
    cutStarted.current = Date.now();
    try {
      await deps.requestCut(job.id);
    } catch {
      setCutting(false);
      setCutError('Could not start the cut. Try again.');
    }
  }, [deps, job.id]);

  async function onZip() {
    setZipping(true);
    try {
      await deps.zip(cutLoops, title);
    } finally {
      setZipping(false);
    }
  }

  return (
    <section className="loop-results" style={{ width: '100%', maxWidth: 960 }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, color: 'var(--text-primary)' }}>
            {cutLoops.length ? 'Loops ready' : 'Loops'}
          </h2>
          <p style={{ margin: '4px 0 0', color: 'var(--text-muted)' }}>
            {cutLoops.length ? `${cutLoops.length} ${cutLoops.length === 1 ? 'loop' : 'loops'} · ` : ''}
            {job.bpm} BPM · {job.musical_key}
          </p>
        </div>
        {pending > 0 ? (
          <button
            type="button"
            onClick={onCut}
            disabled={cutting}
            aria-busy={cutting}
            className="jp-primary"
            data-testid="cut-loops"
            style={{
              minHeight: 48, padding: '0 18px', fontWeight: 700,
              border: 'none', borderRadius: 'var(--radius-md)',
            }}
          >
            {cutting ? 'Cutting…' : `Cut ${pending} ${pending === 1 ? 'loop' : 'loops'}`}
          </button>
        ) : (
          <button
            type="button"
            onClick={onZip}
            disabled={zipping || !cutLoops.length}
            aria-busy={zipping}
            className="jp-primary"
            data-testid="zip-loops"
            style={{
              minHeight: 48, padding: '0 18px', fontWeight: 700,
              border: 'none', borderRadius: 'var(--radius-md)',
            }}
          >
            {zipping ? 'Zipping…' : 'Download all (ZIP)'}
          </button>
        )}
      </header>

      {pending > 0 && (
        <p data-testid="cut-explainer" style={{ margin: '12px 0 0', color: 'var(--text-muted)', fontSize: 14 }}>
          {cutting
            ? `Cutting ${pending} 24-bit ${pending === 1 ? 'WAV' : 'WAVs'} from this song’s stems. This takes a moment.`
            : `${pending} ${pending === 1 ? 'loop is' : 'loops are'} ready to cut. Press the button to make 24-bit WAVs you can download.`}
        </p>
      )}
      {cutError && (
        <p role="alert" data-testid="cut-error" style={{ margin: '12px 0 0', color: 'var(--status-failed)', fontSize: 14 }}>
          {cutError}
        </p>
      )}

      {/* Stem filter tabs — guitar shown as its own column alongside the rest. Each stem
          filter wears its stem hue (stem-color.css); the chosen one is aria-pressed. */}
      {cutLoops.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0' }}>
          {['all', ...stems].map((s) => (
            <button
              key={s}
              type="button"
              className="jp-filter"
              data-stem={s === 'all' ? undefined : s}
              aria-pressed={stem === s}
              onClick={() => setStem(s)}
              style={{
                minHeight: 44, padding: '0 14px', cursor: 'pointer',
                borderRadius: 'var(--radius-full)', fontSize: 14,
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div
        className="loop-grid"
        style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
      >
        {shown.map((loop) => (
          <LoopCard key={loop.id} loop={loop} />
        ))}
      </div>
    </section>
  );
}
