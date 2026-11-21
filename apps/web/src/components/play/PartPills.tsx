'use client';

import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { StemName, StemState } from '@/lib/play/types';
import {
  PILL_LONG_PRESS_MS,
  PILL_SLOP_PX,
  PILL_SWALLOW_MS,
  PILLS_HOW,
  PILL_SHORT,
  type PillOp,
  longPressOps,
  pillStems,
  pillView,
  tapOps,
} from '@/lib/play/part-pills';
import styles from './PartPills.module.css';


export interface PartPillsProps {
  readonly stems: readonly StemState[];
  readonly onGain: (stem: StemName, gain: number) => void;
  readonly onMute: (stem: StemName, muted: boolean) => void;
  readonly onSolo: (stem: StemName, soloed: boolean) => void;
  /**
   * The id of the element that says why a stem is missing (the player's notice
   * bar, which names it). A disabled pill points its aria-describedby there,
   * instead of repeating the reason in a second line under the row (review M1).
   */
  readonly reasonId?: string | null;
}

/**
 * The "my part" pills (Phase A D5): one row on the play screen, Gtr · Bass ·
 * Keys · Drums · Vox (+ Other), each a 44px button.
 *
 *   tap / Enter / Space   100% -> 30% -> muted -> 100%; while a solo is on, a
 *                         tap ends the solo instead (never a hidden change)
 *   long-press / S        solo (at 100%, unmuted); again to un-solo
 *
 * A gesture never leaves the song silent (lib/play/part-pills.ts neverSilent).
 *
 * Each pill is a button with aria-pressed (changed from the full song) and an
 * accessible name that states the level, so a screen reader reads the new
 * state on the focused pill. No live region: the play screen has none by
 * design (DECISION.md:44). The long-press is 500 ms, cancelled when the pointer
 * moves, and swallows the click its release produces (as the section chips).
 */
export function PartPills({ stems, onGain, onMute, onSolo, reasonId = null }: PartPillsProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const swallow = useRef(false);
  const swallowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  const clearSwallow = () => {
    swallow.current = false;
    if (swallowTimer.current) clearTimeout(swallowTimer.current);
    swallowTimer.current = null;
  };
  useEffect(
    () => () => {
      cancel();
      clearSwallow();
    },
    [],
  );

  const shown = pillStems(stems);
  const anySolo = shown.some((s) => s.availability === 'ready' && s.soloed);

  const run = (ops: readonly PillOp[]) => {
    for (const op of ops) {
      if (op.soloed !== undefined) onSolo(op.stem, op.soloed);
      if (op.gain !== undefined) onGain(op.stem, op.gain);
      if (op.muted !== undefined) onMute(op.stem, op.muted);
    }
  };

  const down = (s: StemState) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    cancel();
    clearSwallow();
    if (s.availability !== 'ready') return;
    start.current = { x: e.clientX, y: e.clientY };
    timer.current = setTimeout(() => {
      timer.current = null;
      swallow.current = true;
      run(longPressOps(s, stems));
    }, PILL_LONG_PRESS_MS);
  };
  const release = () => {
    cancel();
    if (swallow.current && !swallowTimer.current) swallowTimer.current = setTimeout(clearSwallow, PILL_SWALLOW_MS);
  };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = start.current;
    if (!p) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > PILL_SLOP_PX) cancel();
  };
  const key = (s: StemState) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    clearSwallow();
    if ((e.key === 's' || e.key === 'S') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      run(longPressOps(s, stems));
    }
  };

  return (
    <fieldset className={styles.root} data-testid="part-pills">
      <legend className={styles.sr}>{PILLS_HOW}</legend>
      <div className={styles.row}>
        {shown.map((s) => {
          const v = pillView(s, anySolo);
          return (
            <button
              key={s.name}
              type="button"
              className={styles.pill}
              data-stem={s.name}
              data-level={v.level}
              data-solo={v.solo ? '' : undefined}
              data-silent={v.silentBySolo ? '' : undefined}
              aria-pressed={v.pressed}
              aria-label={v.ariaLabel}
              aria-keyshortcuts={v.available ? 'S' : undefined}
              aria-disabled={v.available ? undefined : true}
              aria-describedby={!v.available && reasonId ? reasonId : undefined}
              style={{ ['--pill-level' as string]: v.level === 'muted' ? '0%' : `${v.percent}%` }}
              onPointerDown={down(s)}
              onPointerMove={move}
              onPointerUp={release}
              onPointerCancel={release}
              onPointerLeave={cancel}
              onContextMenu={(e) => e.preventDefault()}
              onKeyDown={key(s)}
              onClick={(e) => {
                // Only a pointer click (detail >= 1) can be a long-press's release.
                if (swallow.current && e.detail > 0) {
                  clearSwallow();
                  return;
                }
                clearSwallow();
                run(tapOps(s, stems));
              }}
            >
              <span className={styles.name}>{PILL_SHORT[s.name]}</span> <span className={styles.state}>{v.state}</span>
              <span className={styles.bar} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export default PartPills;
