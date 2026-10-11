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

// From "separating" on, the song exists as stems: the bar shows the stem key from then.
const STEM_STAGES = new Set(['separating', 'extracting', 'uploading', 'done']);

// The stems the user asked for, in the lane order the rest of the site uses.
const STEM_ORDER = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'];

// One equal segment per requested stem: a 22% tint for the track, full hue for the fill.
function stemKey(stems: string[], tint: boolean): string {
  const step = 100 / stems.length;
  const stops = stems.map((s, i) => {
    const c = tint ? `color-mix(in srgb, var(--stem-${s}) 22%, #2a2a2a)` : `var(--stem-${s})`;
    return `${c} ${(i * step).toFixed(3)}% ${((i + 1) * step).toFixed(3)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

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
  // The jobs API returns requested_stems (route.ts selects it); the generated Job type omits it.
  const asked = new Set((job as Job & { requested_stems?: string[] | null }).requested_stems ?? []);
  const requested = STEM_ORDER.filter((s) => asked.has(s));
  const keyStems = requested.length ? requested : STEM_ORDER;
  const keyVars = {
    '--sl-req-track': stemKey(keyStems, true),
    '--sl-req-strip': stemKey(keyStems, false),
  } as React.CSSProperties;

  return (
    <div style={{ width: '100%', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)', fontSize: 15 }}>
        <span>
          <span aria-live="polite">{label}</span>
          {startedAt && job.status !== 'done' ? `… ${elapsed}s` : ''}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>{pct}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="jp-progress"
        style={{ ...keyVars, width: '100%', height: 10, borderRadius: 999, overflow: 'hidden' }}
      >
        <div
          className={`jp-progress-fill${STEM_STAGES.has(job.status) ? ' is-stems' : ''}`}
          style={{ width: `${pct}%`, height: '100%', borderRadius: 999 }}
        />
      </div>
    </div>
  );
}
