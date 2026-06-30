'use client';

import { useEffect, useState } from 'react';
import type { Job } from '@stem-loops/types';
import { JobProgress } from '@/components/JobProgress';
import { JobError } from '@/components/JobError';
import { LoopResults } from '@/components/LoopResults';
import { addToHistory } from '@/lib/history';

const TERMINAL = new Set(['done', 'failed']);

export default function JobPage({ params }: { params: { id: string } }) {
  const [job, setJob] = useState<Job | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      const res = await fetch(`/api/jobs/${params.id}`);
      if (!res.ok) return;
      const data = await res.json();
      if (stopped) return;
      setJob(data.job);
      if (timer && TERMINAL.has(data.job.status)) {
        clearInterval(timer);
        timer = null;
      }
    };

    poll();
    timer = setInterval(poll, 2000);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [params.id]);

  // Record completed jobs in anonymous history (P3-7/11).
  useEffect(() => {
    if (job?.status === 'done') addToHistory(params.id);
  }, [job?.status, params.id]);

  async function copyShare() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the URL is still visible to copy manually */
    }
  }

  const done = job?.status === 'done';

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: done ? 'flex-start' : 'center',
        gap: 24,
        padding: 24,
      }}
    >
      {!job ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading job…</p>
      ) : job.status === 'failed' ? (
        <JobError errorCode={job.error_code ?? 'INTERNAL_ERROR'} />
      ) : done ? (
        <LoopResults job={job} />
      ) : (
        <JobProgress job={job} />
      )}

      {!done && <ShareBox id={params.id} copied={copied} onCopy={copyShare} />}
    </main>
  );
}

function ShareBox({ id, copied, onCopy }: { id: string; copied: boolean; onCopy: () => void }) {
  const href = typeof window !== 'undefined' ? window.location.href : `https://stem-loops.com/jobs/${id}`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: 560, width: '100%', flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Share:</span>
      <code
        style={{
          flex: '1 1 200px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          background: 'var(--bg-elevated)', color: 'var(--text-secondary)', padding: '8px 12px',
          borderRadius: 8, fontSize: 13,
        }}
      >
        {href}
      </code>
      <button
        onClick={onCopy}
        style={{
          minHeight: 44, padding: '0 16px', background: 'var(--bg-card)', color: 'var(--text-primary)',
          border: '1px solid var(--border-default)', borderRadius: 8, cursor: 'pointer',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
