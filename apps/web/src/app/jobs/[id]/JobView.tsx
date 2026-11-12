'use client';

/**
 * The job page's client body. Lifted out of `page.tsx` unchanged except for the
 * play-along seam, because `page.tsx` had to become a Server Component to hold
 * the sign-in gate (Story 1.5) — `getUser()` reads cookies, and the only
 * authenticated-page pattern in this repo is a server `getUser()` + `redirect`
 * (see src/app/account/page.tsx, src/app/trial/page.tsx). A Server Component
 * cannot hold this component's polling loop, and `src/app/trial/` already sets
 * the precedent of a colocated client child beside a gated server page.
 *
 * What changed relative to the pre-seam version, and why:
 *   - Story 1.2: `<Player>` is mounted FIRST for a `done` job. The player is the
 *     primary view; `<LoopResults>` stays, below it.
 *   - The standalone `<section aria-label="Chords">` moved INTO `<Player>`, so
 *     the chord track can be given `positionSec` from the engine snapshot
 *     (Story 3.4). Mounting it here could not do that — the engine lives in
 *     Player, and that is exactly the wiring that was missing.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Job } from '@stem-loops/types';
import { JobProgress } from '@/components/JobProgress';
import { LoopResults } from '@/components/LoopResults';
import Player from '@/components/play/Player';
import { formatExpiresIn } from '@/lib/retention';
import {
  ACTIVE_STALL_MS,
  BACKOFF_POLL_MS,
  POLL_MS,
  QUEUED_STALL_MS,
  nextPollStep,
  readPoll,
  type PollOutcome,
  type Stall,
} from '@/lib/job-poll';

const TERMINAL = new Set(['done', 'failed']);

/**
 * The page's terminal states for a job that is not done and not failed.
 * `unreachable`: the poll itself keeps failing (5xx, network, not-a-job body).
 * `stalled`: the poll works, and the job has gone quiet for longer than the
 * pipeline's own timeouts and the reaper's window explain (see lib/job-poll.ts).
 */
type Trouble = { readonly kind: 'unreachable' } | { readonly kind: 'stalled'; readonly stall: Stall };

const minutes = (ms: number) => Math.round(ms / 60000);

// An <a class="jp-primary"> is sized by stem-color.css; a <button> is not, so it is sized here.
const actionButton: React.CSSProperties = {
  marginTop: 16,
  minHeight: 48,
  padding: '0 18px',
  border: 0,
  borderRadius: 10,
  fontWeight: 700,
};

export default function JobView({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [missing, setMissing] = useState(false);
  // Appended AFTER the two above on purpose: test/job-page-render.test.mjs seeds
  // `useState` positionally as [job, missing].
  const [trouble, setTrouble] = useState<Trouble | null>(null);
  // Bumped by "Try again" / "Check again": re-runs the polling effect.
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let stopped = false;
    let failures = 0;

    async function poll() {
      let outcome: PollOutcome;
      try {
        outcome = await readPoll(await fetch(`/api/jobs/${id}`, { cache: 'no-store' }));
      } catch {
        outcome = { kind: 'error', status: null };
      }
      if (stopped) return;
      const step = nextPollStep(outcome, failures, Date.now());
      failures = step.failures;
      switch (step.action) {
        case 'missing':
          setMissing(true);
          return;
        case 'retry':
          // NEVER store a failed poll as the job: a 5xx envelope has no `status`,
          // and used to render "Processing… 0%" for as long as the server stayed down.
          timer.current = setTimeout(poll, BACKOFF_POLL_MS);
          return;
        case 'unreachable':
          setTrouble({ kind: 'unreachable' });
          return;
        case 'terminal':
          setJob(step.job);
          setTrouble(null);
          return;
        case 'stalled':
          setJob(step.job);
          setTrouble({ kind: 'stalled', stall: step.stall });
          return;
        case 'continue':
          setJob(step.job);
          setTrouble(null);
          timer.current = setTimeout(poll, POLL_MS);
          return;
      }
    }

    poll();
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id, attempt]);

  // GUTTER: the token, never a literal. Found across #197 + #194 — neither PR
  // could see it alone. This was a hard-coded `24px`, and the mixer's entire
  // 360px layout budget is computed against the app's 16px gutter.
  //
  // ⚠️ SCOPE OF THE MEASUREMENT, stated precisely because an earlier draft of
  // this comment overstated it. On a tree that HAS #194's 5c3c181, its reviewer
  // measured the extra 8px per side eating the mixer's margin: channels at
  // exactly 46.00px (360 − 48 − 24 − 2 = 286 of usable width) and "VOCALS"
  // truncated to "VOCA…". That is NOT reproducible on THIS branch: 5c3c181 is
  // not an ancestor here (`git merge-base --is-ancestor` says so), and measured
  // on this tree channels land at 52.00px with no clipping at 320 / 360 / 390.
  // So the hard-coded 24px is a latent defect that lands the moment #194
  // merges, not a live one — which is reason to fix it now, not reason to
  // claim a truncation this branch does not show. An inline literal is what
  // made the drift invisible to both sides, so the number is gone.
  //
  // ⚠️ THE FALLBACK IS LOAD-BEARING, not belt-and-braces. `--sl-gutter` is
  // defined in src/styles/landing.css, which is imported ONLY by
  // app/(landing)/layout.tsx and app/not-found.tsx. This route is not in the
  // (landing) group, so the token is NOT in scope here. A bare
  // `var(--sl-gutter)` would be invalid at computed-value time and take the
  // WHOLE shorthand down with it — padding would compute to 0 and the 48px top
  // and 96px bottom would vanish too. `16px` is landing.css's own base value,
  // so this renders identically to every other page at mobile widths and
  // automatically picks up the token if this route is ever brought into scope.
  const wrap: React.CSSProperties = {
    maxWidth: 960,
    margin: '0 auto',
    padding: '48px var(--sl-gutter, 16px) 96px',
    fontFamily: 'var(--font-sans)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 28,
  };

  const back = (
    <div style={{ width: '100%', maxWidth: 960 }}>
      <Link href="/" className="jp-back" style={{ fontSize: 'var(--text-md)', textDecoration: 'none' }}>
        ← New track
      </Link>
    </div>
  );

  return (
    <main style={wrap}>
      {back}
      {missing ? (
        <div style={{ width: '100%', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h1 style={{ margin: 0, fontSize: 'var(--text-xl)', color: 'var(--text-primary)' }}>We couldn&apos;t find that job.</h1>
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>Files are deleted after 24 hours, so it may have expired.</p>
        </div>
      ) : trouble?.kind === 'unreachable' && !(job && TERMINAL.has(job.status)) ? (
        <div
          className="jp-failed"
          role="alert"
          data-testid="job-unreachable"
          style={{ width: '100%', maxWidth: 560, padding: '20px 24px', borderRadius: 12, background: 'var(--status-failed-bg)' }}
        >
          <h1 style={{ margin: '0 0 8px', fontSize: 'var(--text-xl)' }}>We can&apos;t get an update right now</h1>
          <p style={{ margin: 0 }}>
            This page couldn&apos;t reach the server for the last few tries, so we don&apos;t know where your track is.
            It may well be fine. Check your connection and try again.
          </p>
          <button
            type="button"
            className="jp-primary"
            style={actionButton}
            onClick={() => {
              setTrouble(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : !job ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : job.status === 'failed' ? (
        <div
          className="jp-failed"
          style={{
            width: '100%',
            maxWidth: 560,
            padding: '20px 24px',
            borderRadius: 12,
            background: 'var(--status-failed-bg)',
          }}
        >
          <h1 style={{ margin: '0 0 8px', fontSize: 'var(--text-xl)' }}>Something went wrong</h1>
          <p style={{ margin: 0 }}>
            {job.error_message_user ?? 'This track could not be processed. Please try another file.'}
          </p>
          <Link href="/" className="jp-primary" style={{ marginTop: 16 }}>
            Try another track →
          </Link>
        </div>
      ) : job.status === 'done' ? (
        <>
          {/* Story 1.2 — the player is the PRIMARY view. Jon: "Everybody
              uploading songs wants to see the player and toggle and play
              along." The loop downloader is secondary and sits below it. */}
          <Player jobId={job.id} loops={job.loops} enabled />
          <LoopResults job={{ ...job, title: job.original_filename ?? undefined }} />
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--text-sm, 13px)' }}>
            Files are deleted after 24 hours.
            {job.expires_at ? ` Yours expire ${formatExpiresIn(new Date(job.expires_at).getTime())}.` : ''}
          </p>
        </>
      ) : trouble?.kind === 'stalled' ? (
        <div
          className="jp-failed"
          role="alert"
          data-testid="job-stalled"
          style={{ width: '100%', maxWidth: 560, padding: '20px 24px', borderRadius: 12, background: 'var(--status-failed-bg)' }}
        >
          <h1 style={{ margin: '0 0 8px', fontSize: 'var(--text-xl)' }}>This is taking too long</h1>
          <p style={{ margin: 0 }}>
            {trouble.stall === 'queued'
              ? `Your track has been waiting in line for more than ${minutes(QUEUED_STALL_MS)} minutes and nothing has picked it up.`
              : `Your track stopped making progress more than ${minutes(ACTIVE_STALL_MS)} minutes ago.`}{' '}
            It may still finish, so you can check again, or start over with the track.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 16 }}>
            <button
              type="button"
              className="jp-primary"
              style={{ ...actionButton, marginTop: 0 }}
              onClick={() => {
                setTrouble(null);
                setAttempt((n) => n + 1);
              }}
            >
              Check again
            </button>
            <Link href="/" className="jp-back" style={{ fontSize: 'var(--text-md)' }}>
              Try another track →
            </Link>
          </div>
        </div>
      ) : (
        <>
          <h1 style={{ fontSize: 'var(--text-2xl)', margin: 0, textAlign: 'center' }}>
            {job.original_filename ?? job.youtube_url ?? 'Your track'}
          </h1>
          <p style={{ margin: '-16px 0 0', color: 'var(--text-muted)' }}>Processing…</p>
          <JobProgress job={job} />
        </>
      )}
    </main>
  );
}
