'use client';

import { useEffect, useState } from 'react';
import type { Job } from '@stem-loops/types';

// Stage bands → overall progress %. separating is the heavy stage.
const STAGE_BANDS: Record<string, [number, number]> = {
  downloading: [0, 15],
  separating: [15, 70],
  extracting: [70, 90],
  uploading: [90, 100],
};

const STAGE_LABEL: Record<string, string> = {
  queued: 'Queued',
  downloading: 'Downloading audio',
  separating: 'Separating stems',
  extracting: 'Extracting loops',
  uploading: 'Uploading',
  done: 'Done',
};

export function JobProgress({ job }: { job: Job }) {
  const events = job.events ?? [];
  const band = STAGE_BANDS[job.status] ?? (job.status === 'done' ? [100, 100] : [0, 0]);
  const latestPct = [...events].reverse().find((e) => e.pct != null)?.pct ?? null;
  const pct = job.status === 'done' ? 100 : latestPct ?? Math.round((band[0] + band[1]) / 2);

  // Live elapsed time for the current stage's most recent `started` event.
  const startedAt = [...events]
    .reverse()
    .find((e) => e.stage === job.status && e.phase === 'started')?.created_at;
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt || job.status === 'done' || job.status === 'failed') return;
    const startMs = new Date(startedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt, job.status]);

  const label = STAGE_LABEL[job.status] ?? job.status;

  return (
    <div style={{ width: '100%', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)', fontSize: 15 }}>
        <span>
          {label}
          {startedAt && job.status !== 'done' ? `… ${elapsed}s` : ''}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>{pct}%</span>
      </div>
      <div style={{ width: '100%', height: 10, background: 'var(--wf-bar-idle)', borderRadius: 999, overflow: 'hidden' }}>
        <div
          style={{
            width: `${pct}%`, height: '100%', background: 'var(--accent)',
            borderRadius: 999, transition: 'width 0.4s ease',
          }}
        />
      </div>
    </div>
  );
}
