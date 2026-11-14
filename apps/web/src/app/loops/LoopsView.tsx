'use client';

/**
 * The /loops body (Story 6): pick a song you have already split, ask for its
 * loops, download them.
 *
 * WHAT THIS PAGE DOES NOT DO. It cuts nothing itself. The cut is the worker's
 * (migration 033, #211): the pipeline RECORDS every loop and encodes none, and
 * `POST /api/jobs/:id/loops` asks `worker/loop_cutter.py` to make the 24-bit
 * WAVs. That flow, its polling and its download controls all live in
 * <LoopResults>, which this page mounts unchanged in behaviour. So the loops a
 * user gets here are byte-for-byte the ones the job page used to offer: same
 * bar length, same 24-bit WAV, same per-stem files, same names.
 *
 * WHAT WAS REUSED FROM PR #208 (closed 2026-11-12). #208 built /loops with a
 * BROWSER cutter (Opus stems decoded and sliced in JS). Jon held it for the
 * server-side cut, which then landed as #211, and #208 was closed. Kept from it:
 * the route shape (gated server page + client body + one-line chrome layout),
 * the picker (this browser's songs plus a paste field, nothing auto-selected),
 * and the page-level CSS. Dropped: the whole browser cutter (lib/loops/cut.ts,
 * plan.ts, wav.ts), because it is a second loop implementation of lower
 * quality than the one that now exists.
 *
 * WHY THE SONG PICKER READS THIS BROWSER'S HISTORY AND THE NAV DOES NOT.
 * SignedInChrome sets out why the nav must never resolve a job from the
 * per-browser history store. None of that applies here: the nav links to
 * /loops with no id, and the viewer picks a song explicitly.
 *
 * THE 24-HOUR RULE (Jon, 2026-11-14). Loops can be requested only within 24
 * hours of the job. Older songs stay in the list, marked closed, and selecting
 * one shows a disabled Cut control with a plain explanation
 * (lib/loops/availability.ts). No retention change.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Job } from '@stem-loops/types';
import { LoopResults } from '@/components/LoopResults';
import { getStoredHistoryEntries } from '@/lib/history';
import { formatExpiresIn } from '@/lib/retention';
import {
  LOOPS_CLOSED_COPY,
  LOOPS_WINDOW_MS,
  jobIdFrom,
  loopsWindowOpen,
  type LoopsClosedReason,
} from '@/lib/loops/availability';

/** One song this browser knows about. `at` is when it was started (ms). */
export interface SongEntry {
  readonly id: string;
  readonly at: number;
}

type LoadedJob = Job & { original_filename?: string | null };

/** What fetching a job came back with. */
export type JobFetch =
  | { readonly kind: 'ok'; readonly job: LoadedJob }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'error' };

/** `state` from GET /api/jobs/:id/stems, or null when it could not be read. */
export type StemsState = 'ready' | 'partial' | 'unavailable' | 'encode_failed' | null;

/** Everything this page reaches outside itself, so a test can count the calls. */
export interface LoopsViewDeps {
  listSongs(): SongEntry[];
  fetchJob(id: string, signal?: AbortSignal): Promise<JobFetch>;
  fetchStemsState(id: string, signal?: AbortSignal): Promise<StemsState>;
  /** Keep the address bar on /loops?job=<id> so the view can be bookmarked. */
  setUrl(id: string | null): void;
  now(): number;
}

export const productionDeps: LoopsViewDeps = {
  listSongs: () => getStoredHistoryEntries(),
  fetchJob: async (id, signal) => {
    try {
      const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store', signal });
      if (res.status === 404) return { kind: 'not_found' };
      if (!res.ok) return { kind: 'error' };
      return { kind: 'ok', job: (await res.json()) as LoadedJob };
    } catch {
      return { kind: 'error' };
    }
  },
  fetchStemsState: async (id, signal) => {
    try {
      const res = await fetch(`/api/jobs/${id}/stems`, { cache: 'no-store', signal });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as { state?: unknown } | null;
      const s = body?.state;
      return s === 'ready' || s === 'partial' || s === 'unavailable' || s === 'encode_failed' ? s : null;
    } catch {
      return null;
    }
  },
  setUrl: (id) => {
    try {
      window.history.replaceState(null, '', id ? `/loops?job=${id}` : '/loops');
    } catch {
      /* the view still works without the address bar following it */
    }
  },
  now: () => Date.now(),
};

type View =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'closed'; readonly reason: LoopsClosedReason }
  | { readonly kind: 'error' }
  | { readonly kind: 'processing'; readonly job: LoadedJob }
  | { readonly kind: 'failed'; readonly job: LoadedJob }
  | { readonly kind: 'ready'; readonly job: LoadedJob; readonly closed: LoopsClosedReason | null };

/** "abcd1234…" — enough of the id to tell two songs apart in a list. */
const shortId = (id: string) => `${id.slice(0, 8)}…`;

function ago(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

export default function LoopsView({
  initialJobId = null,
  deps = productionDeps,
}: {
  initialJobId?: string | null;
  deps?: LoopsViewDeps;
}) {
  const [songs, setSongs] = useState<SongEntry[] | null>(null);
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState(false);
  const [view, setView] = useState<View>(initialJobId ? { kind: 'loading' } : { kind: 'none' });
  const [attempt, setAttempt] = useState(0);

  // localStorage only exists in the browser, so it is read in an effect, the
  // same shape as app/history/page.tsx.
  useEffect(() => {
    setSongs(deps.listSongs());
  }, [deps]);

  const pick = useCallback(
    (id: string | null) => {
      setJobId(id);
      deps.setUrl(id);
    },
    [deps],
  );

  useEffect(() => {
    if (!jobId) {
      setView({ kind: 'none' });
      return;
    }
    // Wait for the list: it is what tells an old song from a mistyped link.
    if (songs === null) return;
    // A song this browser KNOWS is past the window is closed without a request:
    // the API would answer 404 and say less than we already know.
    const known = songs.find((s) => s.id === jobId);
    if (known && !loopsWindowOpen({ createdAtMs: known.at }, deps.now())) {
      setView({ kind: 'closed', reason: 'expired' });
      return;
    }
    setView({ kind: 'loading' });
    const ac = new AbortController();
    let live = true;
    (async () => {
      const r = await deps.fetchJob(jobId, ac.signal);
      if (!live) return;
      if (r.kind === 'not_found') {
        setView({ kind: 'closed', reason: known ? 'expired' : 'not_found' });
        return;
      }
      if (r.kind === 'error') {
        setView({ kind: 'error' });
        return;
      }
      const job = r.job;
      if (job.status === 'failed') return setView({ kind: 'failed', job });
      if (job.status !== 'done') return setView({ kind: 'processing', job });
      // Story 6.7: a job that kept no stems (pre-V3-J2) cannot be cut on demand,
      // because the cutter slices the retained stem WAVs. Only asked when there
      // is something left to cut, so a fully cut job costs no extra request.
      const uncut = (job.loops ?? []).some((l) => l.cut_at == null);
      let closed: LoopsClosedReason | null = null;
      if (uncut) {
        const state = await deps.fetchStemsState(jobId, ac.signal);
        if (!live) return;
        if (state === 'unavailable') closed = 'no_stems';
      }
      setView({ kind: 'ready', job, closed });
    })();
    return () => {
      live = false;
      ac.abort();
    };
  }, [jobId, songs, deps, attempt]);

  const now = deps.now();
  const list = songs ?? [];

  return (
    <main className="lp-wrap">
      <header className="lp-head">
        <h1 className="lp-h1">Download loops</h1>
        <p className="lp-lede">
          Bar-length loops from a song you have split: up to 10 per stem, as 24-bit WAV files named by stem, BPM, key,
          section and number.
        </p>
        <p className="lp-note" data-testid="lp-window-note">
          <strong>Loops are cut only when you ask, within 24 hours of splitting the song.</strong> After that the
          song&apos;s audio is deleted on our end and there is nothing left to cut from.
        </p>
      </header>

      <section className="lp-songs" aria-labelledby="lp-songs-h">
        <h2 id="lp-songs-h" className="lp-h2">
          Pick a song
        </h2>
        {songs === null ? null : list.length === 0 ? (
          <p className="lp-muted" data-testid="lp-no-songs">
            No songs on this browser yet.{' '}
            <a href="/" className="lp-link">
              Start a new song →
            </a>
          </p>
        ) : (
          <ul className="lp-song-list" data-testid="lp-song-list">
            {list.map((s) => {
              const open = loopsWindowOpen({ createdAtMs: s.at }, now);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className="lp-song"
                    data-testid="lp-song"
                    data-open={String(open)}
                    aria-pressed={jobId === s.id}
                    onClick={() => pick(s.id)}
                  >
                    <span className="lp-song-id">{shortId(s.id)}</span>
                    <span className="lp-song-when">split {ago(now - s.at)}</span>
                    <span className={`lp-song-clock${open ? '' : ' lp-song-closed'}`}>
                      {open ? `loops close ${formatExpiresIn(s.at + LOOPS_WINDOW_MS, now)}` : 'loops closed'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <form
          className="lp-paste"
          onSubmit={(e) => {
            e.preventDefault();
            const id = jobIdFrom(paste);
            setPasteError(id === null);
            if (id) pick(id);
          }}
        >
          <label className="lp-paste-label" htmlFor="lp-paste-input">
            Or paste a song link
          </label>
          <div className="lp-paste-row">
            <input
              id="lp-paste-input"
              className="lp-input"
              value={paste}
              onChange={(e) => {
                setPaste(e.target.value);
                setPasteError(false);
              }}
              placeholder="https://stem-loops.com/jobs/…"
              spellCheck={false}
              aria-invalid={pasteError}
              aria-describedby={pasteError ? 'lp-paste-error' : undefined}
            />
            <button type="submit" className="lp-secondary">
              Open
            </button>
          </div>
          {pasteError && (
            <p id="lp-paste-error" className="lp-field-error" role="alert">
              That does not look like a song link. Copy it from the address bar of the song&apos;s page.
            </p>
          )}
        </form>
      </section>

      {jobId && (
        <section className="lp-job" aria-labelledby="lp-job-h" data-testid="lp-job" data-view={view.kind}>
          <div className="lp-job-head">
            <h2 id="lp-job-h" className="lp-h2">
              {view.kind === 'ready' || view.kind === 'processing' || view.kind === 'failed'
                ? view.job.original_filename || shortId(jobId)
                : shortId(jobId)}
            </h2>
            {(view.kind === 'ready' || view.kind === 'processing') && (
              <a href={`/jobs/${jobId}`} className="lp-link lp-to-player">
                Open in the player →
              </a>
            )}
          </div>

          {view.kind === 'loading' ? (
            <p className="lp-muted" role="status">
              Loading…
            </p>
          ) : view.kind === 'closed' ? (
            <div className="lp-closed" data-testid="lp-closed" data-reason={view.reason}>
              <button
                type="button"
                className="jp-primary lp-cut"
                disabled
                aria-describedby="lp-closed-why"
                data-testid="cut-loops"
              >
                Cut loops
              </button>
              <p id="lp-closed-why" className="lp-closed-why">
                {LOOPS_CLOSED_COPY[view.reason]}
              </p>
              <a href="/" className="lp-link">
                Start a new song →
              </a>
            </div>
          ) : view.kind === 'error' ? (
            <div className="lp-error" role="alert">
              <p>We could not load that song just now. This is on our end. Try again in a moment.</p>
              <button type="button" className="lp-secondary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </div>
          ) : view.kind === 'failed' ? (
            <p className="lp-muted" role="status">
              This song did not finish splitting, so it has no loops.{' '}
              <a href="/" className="lp-link">
                Start a new song →
              </a>
            </p>
          ) : view.kind === 'processing' ? (
            <p className="lp-muted" role="status">
              This song is still being split. Its loops can be cut once it is ready.
            </p>
          ) : view.kind === 'ready' ? (
            (view.job.loops ?? []).length === 0 ? (
              <p className="lp-muted" role="status" data-testid="lp-no-loops">
                We found no steady beat in this song, so there are no bar-length loops to cut. The stems and chords
                are still in the player.
              </p>
            ) : (
              <LoopResults
                job={{ ...view.job, title: view.job.original_filename ?? undefined }}
                closed={view.closed}
              />
            )
          ) : null}
        </section>
      )}

      <footer className="lp-foot">
        <p className="lp-muted">
          Songs, stems and loops are deleted 24 hours after a song is split, so download what you want to keep.
          Splitting a song does not change who owns it; see the{' '}
          <a href="/terms" className="lp-link">
            terms
          </a>
          .
        </p>
      </footer>
    </main>
  );
}
