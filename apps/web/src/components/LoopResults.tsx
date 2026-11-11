'use client';

import { useMemo, useState } from 'react';
import type { Job, Loop } from '@stem-loops/types';
import { LoopCard } from '@/components/LoopCard';
import { downloadLoopPack } from '@/lib/zipLoops';

// Stable stem order for the filter tabs (guitar is first-class, never 'piano').
const STEM_ORDER = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'];

export function LoopResults({ job }: { job: Job & { title?: string | null } }) {
  const loops = useMemo(
    () => (job.loops ?? []) as Array<Loop & { signed_url?: string | null }>,
    [job.loops],
  );
  const [stem, setStem] = useState<string>('all');
  const [zipping, setZipping] = useState(false);

  const stems = useMemo(() => {
    const present = new Set(loops.map((l) => l.stem));
    return STEM_ORDER.filter((s) => present.has(s));
  }, [loops]);

  const shown = stem === 'all' ? loops : loops.filter((l) => l.stem === stem);
  const title = job.title || 'stem-loops';

  async function onZip() {
    setZipping(true);
    try {
      await downloadLoopPack(loops, title);
    } finally {
      setZipping(false);
    }
  }

  return (
    <section className="loop-results" style={{ width: '100%', maxWidth: 960 }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, color: 'var(--text-primary)' }}>Loops ready</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--text-muted)' }}>
            {loops.length} loops · {job.bpm} BPM · {job.musical_key}
          </p>
          {/* The loop downloader now has a page of its own (/loops), where any
              song can be cut at 1, 2, 4 or 8 bars on request rather than only
              at the bar length this job was started with. These results STAY
              here: they are the worker's own cut, already made and already
              paid for, and deleting the section to make a point about where
              loops "belong" would take a working feature away from the job
              page. The link is a plain route with no id and no fragment. */}
          <p style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: 'var(--text-md)' }}>
            Want other bar lengths?{' '}
            <a href="/loops" style={{ color: 'var(--accent)' }}>
              Cut this song on the loops page →
            </a>
          </p>
        </div>
        <button
          type="button"
          onClick={onZip}
          disabled={zipping || !loops.length}
          aria-busy={zipping}
          className="jp-primary"
          style={{
            minHeight: 48, padding: '0 18px', fontWeight: 700,
            border: 'none', borderRadius: 10,
          }}
        >
          {zipping ? 'Zipping…' : '⬇ Download All (ZIP)'}
        </button>
      </header>

      {/* Stem filter tabs — guitar shown as its own column alongside the rest. Each stem
          filter wears its stem hue (stem-color.css); the chosen one is aria-pressed. */}
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
              minHeight: 44, padding: '0 14px', textTransform: 'capitalize', cursor: 'pointer',
              borderRadius: 999, fontSize: 14,
            }}
          >
            {s}
          </button>
        ))}
      </div>

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
