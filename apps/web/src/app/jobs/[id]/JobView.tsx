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

const POLL_MS = 2000;
const TERMINAL = new Set(['done', 'failed']);

export default function JobView({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [missing, setMissing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let stopped = false;

    async function poll() {
      try {
        const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
        if (res.status === 404) {
          if (!stopped) setMissing(true);
          return;
        }
        const data = (await res.json()) as Job;
        if (stopped) return;
        setJob(data);
        if (!TERMINAL.has(data.status)) timer.current = setTimeout(poll, POLL_MS);
      } catch {
        if (!stopped) timer.current = setTimeout(poll, POLL_MS * 2);
      }
    }

    poll();
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id]);

  // GUTTER: the token, never a literal. Found across #197 + #194 — neither PR
  // could see it alone. This was a hard-coded `24px`, and the mixer's entire
  // 360px layout budget is computed against the app's 16px gutter. At 360px the
  // extra 8px per side ate the mixer's whole margin: channels landed at exactly
  // 46.00px and "VOCALS" truncated to "VOCA…" — reintroducing the very defect
  // #194's 5c3c181 was written to fix. An inline literal is what made the drift
  // invisible to both sides, so the number is gone.
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
