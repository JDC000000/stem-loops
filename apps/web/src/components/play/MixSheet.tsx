'use client';

import type { StemName, StemState } from '@/lib/play/types';
import type { Part, PresetId } from '@/lib/play/presets';
import type { NowNext } from '@/components/ChordOverlay';
import Mixer from './Mixer';
import { Presets } from './Presets';
import { Sheet } from './Sheet';
import styles from './MixSheet.module.css';

export interface MixSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly returnFocus?: () => HTMLElement | null;
  readonly jobId: string;
  readonly stems: readonly StemState[];
  readonly onGain: (stem: StemName, gain: number) => void;
  readonly onMute: (stem: StemName, muted: boolean) => void;
  readonly onSolo: (stem: StemName, soloed: boolean) => void;
  readonly part: Part | null;
  readonly onPreset: (id: PresetId, part: Part) => void;
  readonly onPart: (part: Part) => void;
  /** The chord names under the playhead; null when the song has no chords. */
  readonly nowNext: NowNext | null;
  /** Shown instead of the chords when there are none ("Pre-chorus 1 · bar 3"). */
  readonly whereText?: string | null;
  readonly playing: boolean;
  readonly canPlay: boolean;
  readonly onTogglePlay: () => void;
}

/**
 * The Mix sheet (design v1.4, P1.3): a modal bottom sheet over the stage with
 * the header pinned (title, the Now/Next chord names so the harmony stays in
 * view while mixing, play/pause and Close), the presets pinned under it, and
 * the six stem rows scrolling below. Kept MOUNTED while closed (`hidden`) so
 * the Mixer's per-job memory (sessionStorage, Story 2.7) is restored when the
 * song loads, not when the sheet first opens.
 */
export function MixSheet({
  open,
  onClose,
  returnFocus,
  jobId,
  stems,
  onGain,
  onMute,
  onSolo,
  part,
  onPreset,
  onPart,
  nowNext,
  whereText = null,
  playing,
  canPlay,
  onTogglePlay,
}: MixSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} labelledBy="mix-title" keepMounted returnFocus={returnFocus} testId="mix-sheet">
      <div className={styles.head}>
        <h2 id="mix-title" className={styles.title}>
          Mix
        </h2>
        {nowNext ? (
          <>
            <span className={styles.sr}>{`Now ${nowNext.nowSpoken}${nowNext.next ? `, next ${nowNext.nextSpoken}` : ''}`}</span>
            <span className={styles.now} data-testid="mix-now" aria-hidden="true">
              {nowNext.now}
            </span>
            {nowNext.next ? (
              <span className={styles.next} aria-hidden="true">
                next {nowNext.next}
              </span>
            ) : null}
          </>
        ) : whereText ? (
          <span className={styles.next}>{whereText}</span>
        ) : null}
        <button
          type="button"
          className={styles.round}
          aria-label={playing ? 'Pause' : 'Play'}
          disabled={!canPlay}
          onClick={onTogglePlay}
        >
          {playing ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <button type="button" className={styles.close} onClick={onClose} data-autofocus>
          Close
        </button>
      </div>
      <Presets stems={stems} part={part} onPreset={onPreset} onPart={onPart} idPrefix="mix-presets" />
      <div className={styles.list} role="group" aria-label="Stems">
        <Mixer stems={stems} onGain={onGain} onMute={onMute} onSolo={onSolo} jobId={jobId} layout="rows" />
      </div>
    </Sheet>
  );
}

export default MixSheet;
