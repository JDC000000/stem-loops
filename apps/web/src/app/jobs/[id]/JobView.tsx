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
 *   - Story 1.2: `<Player>` is the view for a `done` job.
 *   - Story 6.1 (2026-11-14): the job page does NOT show loops. `<LoopResults>`
 *     moved to /loops, the loop downloader's own page; this page links there
 *     with the job preselected (`/loops?job=<id>`).
 *   - The standalone `<section aria-label="Chords">` moved INTO `<Player>`, so
 *     the chord track can be given `positionSec` from the engine snapshot
 *     (Story 3.4). Mounting it here could not do that — the engine lives in
 *     Player, and that is exactly the wiring that was missing.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Job } from '@stem-loops/types';
import { JobProgress } from '@/components/JobProgress';
import Player from '@/components/play/Player';
import { formatExpiresIn, isDemoRow } from '@/lib/retention';
import { jobLabel } from '@/lib/job-label';
import { failedJobMessage } from '@/lib/error-copy';
import { jobTrimNote } from '@/lib/input-trim';
import {
  ACTIVE_STALL_MS,
  BACKOFF_POLL_MS,
  POLL_MS,
  QUEUED_STALL_MS,
  SLOW_POLL_MS,
  nextPollStep,
  readPoll,
  type PollOutcome,
  type Stall,
} from '@/lib/job-poll';

const TERMINAL = new Set(['done', 'failed']);

/**
 * What the page SAYS about a job that is not done and not failed. Neither of
 * these stops the poll — see the effect below.
 * `unreachable`: the poll itself keeps failing (5xx, network, not-a-job body).
 *   `status` is the last response's status, or `null` when `fetch` itself
 *   rejected; the copy differs, because "check your connection" is false when
 *   our own server answered 500.
 * `stalled`: the poll works, and the job has gone quiet for longer than the
 * pipeline's own timeouts and the reaper's window explain (see lib/job-poll.ts).
 */
type Trouble =
  | { readonly kind: 'unreachable'; readonly status: number | null }
  | { readonly kind: 'stalled'; readonly stall: Stall };

const minutes = (ms: number) => Math.round(ms / 60000);

// An <a class="jp-primary"> is sized by stem-color.css; a <button> is not, so it is sized here.
const actionButton: React.CSSProperties = {
  marginTop: 16,
  minHeight: 48,
  padding: '0 18px',
  border: 0,
  borderRadius: 'var(--radius-md)',
  fontWeight: 700,
};

/**
 * The back arrow on the player (coordinator note 6, 2026-11-17): "Back to
 * library" when signed in, "Back to home" when signed out — never a compound
 * label. The library is /history until Slice 2 renames it.
 */
export function backLink(signedIn: boolean): { href: string; label: string } {
  return signedIn ? { href: '/history', label: 'Back to library' } : { href: '/', label: 'Back to home' };
}

/**
 * The player's Song info lines: the trim note and the deletion time, in neutral
 * text. A demo song (is_demo, migration 040, #289) is kept until 2099, so its
 * countdown is not shown ("deleted in ~27,000 days").
 */
export function songInfoLines(job: Job, now: number = Date.now()): string[] {
  const lines: string[] = [];
  const trim = jobTrimNote(job);
  if (trim) lines.push(trim);
  const expires = job.expires_at ? new Date(job.expires_at).getTime() : NaN;
  lines.push(
    'On Free, files are deleted after 24 hours; on Pro and Studio they stay in your library.' +
      (Number.isFinite(expires) && !isDemoRow(job) ? ` This song is deleted ${formatExpiresIn(expires, now)}.` : ''),
  );
  return lines;
}

export default function JobView({ id, signedIn = true }: { id: string; signedIn?: boolean }) {
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
          // SAY SO, DO NOT STOP. Returning here is what made a five-minute
          // outage permanent: the panel stayed up until the user clicked, where
          // the version before this feature self-healed. The slow poll is the
          // path back that does not need a click.
          setTrouble({ kind: 'unreachable', status: step.status });
          timer.current = setTimeout(poll, SLOW_POLL_MS);
          return;
        case 'terminal':
          setJob(step.job);
          setTrouble(null);
          return;
        case 'stalled':
          // SAY SO, DO NOT STOP. Returning here lost a legitimately slow job:
          // queued behind another and finishing later, the page said "nothing
          // has picked it up" and then never looked again, so the finished
          // track never appeared. `terminal` and `continue` below clear the
          // panel, so a late finish both renders AND retracts the claim.
          setJob(step.job);
          setTrouble({ kind: 'stalled', stall: step.stall });
          timer.current = setTimeout(poll, SLOW_POLL_MS);
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
  // THE TOKEN IS IN SCOPE AND THE FALLBACK IS DEAD. What stood here claimed the
  // opposite — that `--sl-gutter` lived only in src/styles/landing.css, that
  // this route is outside the (landing) group so the token was "NOT in scope",
  // and that the `16px` was therefore "LOAD-BEARING". All three were false:
  //   • `--sl-gutter` is declared at `:root` in src/styles/design-tokens.css,
  //     which src/app/globals.css imports and src/app/layout.tsx imports — so
  //     it resolves on every route, this one included.
  //   • It is 16px at :root and 32px above the 760px breakpoint, so a desktop
  //     job page gets a 32px gutter, not 16px. The fallback value was not even
  //     the right number for the widths it was supposed to cover.
  //   • landing.css:28 says outright that the token lives in design-tokens.css.
  // Believing that comment is what put the wrong container widths (904/712
  // instead of the real 872/680) in #207's evidence table, twice.
  //
  // WHY THE FALLBACK STAYS ANYWAY, which is a different claim from the one
  // above. It is dead code — the token resolves, so nothing reads it — but it
  // is deliberate dead code: play-player.test.mjs's
  // "the gutter token is in scope on this route" gate pins all three links of
  // the import chain AND pins this fallback, on the reasoning that an
  // unresolvable `var()` is invalid at computed-value time and would take the
  // whole padding shorthand down with it, 48px top and 96px bottom included,
  // rather than degrade. That decision is recorded there, so it is not
  // re-litigated here.
  //
  // ONE THING THAT DECISION DID NOT HAVE, for whoever picks it up: the
  // fallback's VALUE is wrong for most of the widths it would cover. If the
  // chain ever broke, this page would render a 16px gutter at every width,
  // including the desktop widths where the token is 32px — so it is not a
  // faithful degradation, it is a different layout that happens not to crash.
  // The alternative reading is that there is no silent-failure mode to guard
  // at all: the only way the token stops resolving is globals.css dropping
  // design-tokens.css, which takes every colour, font and spacing token on the
  // page with it and is loud. Left as it is, and flagged.
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
        Start a new song →
      </Link>
    </div>
  );

  // Story 1.2 — the player is the PRIMARY view, and (design v1.4, P1.1) it is
  // the whole screen: a fixed, non-scrolling surface whose own header replaces
  // the site nav. Nothing else renders around it, so nothing sits behind it in
  // the tab order: the "Start a new song" link, the trim note, the deletion
  // time and "Download loops" (Story 6.1: loops live on /loops) moved to its
  // back arrow, ⋯ menu and Song info.
  if (job && job.status === 'done' && !missing && !(trouble?.kind === 'unreachable' && !TERMINAL.has(job.status))) {
    return (
      <main>
        <Player
          jobId={job.id}
          loops={job.loops}
          enabled
          title={jobLabel(job)}
          bpm={job.bpm ?? null}
          musicalKey={job.musical_key ?? null}
          back={backLink(signedIn)}
          songInfo={songInfoLines(job)}
          loopsHref={`/loops?job=${job.id}`}
        />
      </main>
    );
  }

  return (
    <main style={wrap}>
      {back}
      {missing ? (
        <div style={{ width: '100%', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h1 style={{ margin: 0, fontSize: 'var(--text-xl)', color: 'var(--text-primary)' }}>We couldn&apos;t find that job.</h1>
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>On Free, files are deleted after 24 hours, so it may have expired.</p>
        </div>
      ) : trouble?.kind === 'unreachable' && !(job && TERMINAL.has(job.status)) ? (
        <div
          className="jp-failed"
          role="alert"
          data-testid="job-unreachable"
          style={{ width: '100%', maxWidth: 560, padding: '20px 24px', borderRadius: 'var(--radius-lg)', background: 'var(--status-failed-bg)' }}
        >
          <h1 style={{ margin: '0 0 8px', fontSize: 'var(--text-xl)' }}>We can&apos;t get an update right now</h1>
          <p style={{ margin: 0 }}>
            {trouble.status === null
              ? "This page couldn't reach the server for the last few tries, so we don't know where your track is. " +
                'It may well be fine. Check your connection and try again.'
              : `Our server answered the last few tries with an error (${trouble.status}), so we don't know where your ` +
                'track is. It may well be fine, and this is our fault, not your connection. ' +
                'We are still checking in the background.'}
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
            borderRadius: 'var(--radius-lg)',
            background: 'var(--status-failed-bg)',
          }}
        >
          <h1 style={{ margin: '0 0 8px', fontSize: 'var(--text-xl)' }}>Something went wrong</h1>
          <p style={{ margin: 0 }}>
            {failedJobMessage(job)}
          </p>
          <Link href="/" className="jp-primary" style={{ marginTop: 16 }}>
            Start a new song
          </Link>
        </div>
      ) : trouble?.kind === 'stalled' ? (
        <div
          className="jp-failed"
          role="alert"
          data-testid="job-stalled"
          style={{ width: '100%', maxWidth: 560, padding: '20px 24px', borderRadius: 'var(--radius-lg)', background: 'var(--status-failed-bg)' }}
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
              Start a new song →
            </Link>
          </div>
        </div>
      ) : (
        <>
          <h1 style={{ fontSize: 'var(--text-2xl)', margin: 0, textAlign: 'center' }}>
            {job.title?.trim() || job.original_filename || job.youtube_url || 'Your track'}
          </h1>
          <p style={{ margin: '-16px 0 0', color: 'var(--text-muted)' }}>Processing…</p>
          <TrimNote job={job} />
          <JobProgress job={job} />
        </>
      )}
    </main>
  );
}

/**
 * One line telling the visitor their track was trimmed, e.g. "Using the first 5:00 of a 6:12
 * track." Renders nothing for a track that was not (lib/input-trim.ts; the worker records the
 * trim on the downloading/completed job event and GET /api/jobs/:id exposes it).
 */
function TrimNote({ job }: { job: Job }) {
  const note = jobTrimNote(job);
  if (!note) return null;
  return (
    <p data-testid="trim-note" style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--text-sm, 13px)' }}>
      {note}
    </p>
  );
}
