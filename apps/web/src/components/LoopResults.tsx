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
        </div>
        <button
          type="button"
          onClick={onZip}
          disabled={zipping || !loops.length}
          style={{
            minHeight: 48, padding: '0 18px', fontWeight: 700, cursor: 'pointer',
            background: 'var(--accent)', color: 'var(--accent-text)', border: 'none',
            borderRadius: 10,
          }}
        >
          {zipping ? 'Zipping…' : '⬇ Download All (ZIP)'}
        </button>
      </header>

      {/* Stem filter tabs — guitar shown as its own column alongside the rest. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0' }}>
        {['all', ...stems].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStem(s)}
            style={{
              minHeight: 44, padding: '0 14px', textTransform: 'capitalize', cursor: 'pointer',
              borderRadius: 999, fontSize: 14,
              background: stem === s ? 'var(--accent-muted)' : 'var(--bg-card)',
              color: stem === s ? 'var(--accent)' : 'var(--text-secondary)',
              border: `1px solid ${stem === s ? 'var(--accent)' : 'var(--border-default)'}`,
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
