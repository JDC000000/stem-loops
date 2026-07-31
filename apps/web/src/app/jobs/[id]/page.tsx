'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Job } from '@stem-loops/types';
import { JobProgress } from '@/components/JobProgress';
import { LoopResults } from '@/components/LoopResults';

const POLL_MS = 2000;
const TERMINAL = new Set(['done', 'failed']);

export default function JobPage({ params }: { params: { id: string } }) {
  const [job, setJob] = useState<Job | null>(null);
  const [missing, setMissing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let stopped = false;

    async function poll() {
      try {
        const res = await fetch(`/api/jobs/${params.id}`, { cache: 'no-store' });
        if (res.status === 404) {
          if (!stopped) setMissing(true);
          return;
        }
        // Any other non-2xx (429 from the new poll throttle, a transient 500) is a
        // response we must not parse into job state — it has no `status` field, so the
        // old code stored an error payload as the job and kept polling at full rate.
        // Back off and retry instead, which is also what makes the throttle recoverable.
        if (!res.ok) {
          if (!stopped) timer.current = setTimeout(poll, res.status === 429 ? POLL_MS * 15 : POLL_MS * 2);
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
  }, [params.id]);

  const wrap: React.CSSProperties = {
    maxWidth: 960,
    margin: '0 auto',
    padding: '48px 24px 96px',
    fontFamily: 'var(--font-sans)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 28,
  };

  const back = (
    <div style={{ width: '100%', maxWidth: 960 }}>
      <Link href="/" style={{ color: 'var(--text-muted)', fontSize: 'var(--text-md)', textDecoration: 'none' }}>
        ← New track
      </Link>
    </div>
  );

  return (
    <main style={wrap}>
      {back}
      {missing ? (
        <p style={{ color: 'var(--text-muted)' }}>We couldn&apos;t find that job. It may have expired.</p>
      ) : !job ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : job.status === 'failed' ? (
        <div
          style={{
            width: '100%',
            maxWidth: 560,
            padding: '20px 24px',
            borderRadius: 12,
            background: 'var(--status-failed-bg)',
            color: 'var(--status-failed)',
          }}
        >
          <h2 style={{ margin: '0 0 8px', fontSize: 'var(--text-xl)' }}>Something went wrong</h2>
          <p style={{ margin: 0 }}>
            {job.error_message_user ?? 'This track could not be processed. Please try another file.'}
          </p>
          <Link href="/" style={{ display: 'inline-block', marginTop: 16, color: 'var(--accent)', fontWeight: 600 }}>
            Try another track →
          </Link>
        </div>
      ) : job.status === 'done' ? (
        <LoopResults job={{ ...job, title: job.original_filename ?? undefined }} />
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
