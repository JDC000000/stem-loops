'use client';

import { useEffect, useRef } from 'react';
import type { Loop } from '@stem-loops/types';
import { useAudition } from '@/hooks/useAudition';
import '@/styles/loop-card.css';

type LoopWithUrl = Loop & { signed_url?: string | null };

export function LoopCard({ loop }: { loop: LoopWithUrl }) {
  const waveRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<{ destroy: () => void } | null>(null);
  const { playing, loading, toggle } = useAudition(loop.signed_url);

  // Render the waveform from precomputed peaks — never fetch the full WAV just to draw.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!waveRef.current || !loop.waveform_peaks?.length) return;
      const WaveSurfer = (await import('wavesurfer.js')).default;
      if (cancelled || !waveRef.current) return;
      const ws = WaveSurfer.create({
        container: waveRef.current,
        height: 48,
        waveColor: 'var(--wf-bar-idle, #2a2a2a)',
        progressColor: 'var(--accent, #a3e635)',
        cursorColor: 'transparent',
        interact: false,
        peaks: [loop.waveform_peaks as number[]],
        duration: (loop.duration_ms ?? 4000) / 1000,
      });
      wsRef.current = ws;
    })();
    return () => {
      cancelled = true;
      wsRef.current?.destroy();
      wsRef.current = null;
    };
  }, [loop.id, loop.waveform_peaks, loop.duration_ms]);

  function onDragStart(e: React.DragEvent) {
    if (!loop.signed_url) return;
    // Chrome DownloadURL drag → drop into a DAW / file manager imports the WAV.
    e.dataTransfer.setData('DownloadURL', `audio/wav:${loop.filename}:${loop.signed_url}`);
    e.dataTransfer.effectAllowed = 'copy';
  }

  return (
    <div className="loop-card" draggable onDragStart={onDragStart}>
      <div className="section-marker">
        {loop.section_label} · {loop.energy_class}
      </div>

      <div ref={waveRef} className="loop-card-waveform" aria-label={`${loop.stem} loop waveform`} />

      <div className="tags-row">
        <span className="tag tag-stem">{loop.stem}</span>
        <span className="tag tag-bpm">{loop.bpm} BPM</span>
        <span className="tag tag-key">{loop.musical_key}</span>
        <span className="tag tag-section">{loop.section_label}</span>
        <span className="tag tag-energy">{loop.energy_class}</span>
      </div>

      <div className="action-row">
        <button
          type="button"
          className="play-btn"
          onClick={toggle}
          disabled={loading || !loop.signed_url}
          aria-pressed={playing}
        >
          {loading ? '…' : playing ? '⏸ Stop' : '▶ Play'}
        </button>
        <a
          className="btn-download-wav"
          href={loop.signed_url ?? '#'}
          download={loop.filename}
          aria-disabled={!loop.signed_url}
        >
          ⬇ WAV
        </a>
        <span className="drag-handle" title="Drag into your DAW" aria-hidden>
          ⠿
        </span>
      </div>
    </div>
  );
}
