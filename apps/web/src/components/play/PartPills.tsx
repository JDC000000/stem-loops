'use client';

import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { StemName, StemState } from '@/lib/play/types';
import {
  PILLS_HOW,
  PILL_SHORT,
  type PillOp,
  longPressOps,
  pillStems,
  pillView,
  tapOps,
  unavailableNote,
} from '@/lib/play/part-pills';
import styles from './PartPills.module.css';

/** Long-press threshold: the same 500 ms as the section chips (design v1.4, P2.1). */
export const PILL_LONG_PRESS_MS = 500;
/** A finger that moves this far is not holding the pill. */
export const PILL_SLOP_PX = 10;
/** How long after a long-press is released its click may still arrive (as SectionLoop). */
export const PILL_SWALLOW_MS = 700;

export interface PartPillsProps {
  readonly stems: readonly StemState[];
  readonly onGain: (stem: StemName, gain: number) => void;
  readonly onMute: (stem: StemName, muted: boolean) => void;
  readonly onSolo: (stem: StemName, soloed: boolean) => void;
}

/**
 * The "my part" pills (Phase A D5): one row on the play screen, Gtr · Bass ·
 * Keys · Drums · Vox (+ Other), each a 44px button.
 *
 *   tap / Enter / Space   100% -> 30% -> muted -> 100%
 *   long-press / S        solo; again to un-solo
 *
 * Each pill is a button with aria-pressed (changed from the full song) and an
 * accessible name that states the level, so a screen reader reads the new
 * state on the focused pill. No live region: the play screen has none by
 * design (DECISION.md:44). The long-press is 500 ms, cancelled when the pointer
 * moves, and swallows the click its release produces (as the section chips).
 */
export function PartPills({ stems, onGain, onMute, onSolo }: PartPillsProps) {
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
  const note = unavailableNote(shown);

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
      run(longPressOps(s));
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
      run(longPressOps(s));
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
              aria-describedby={!v.available && note ? 'part-pills-note' : undefined}
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
                run(tapOps(s));
              }}
            >
              <span className={styles.name}>{PILL_SHORT[s.name]}</span> <span className={styles.state}>{v.state}</span>
              <span className={styles.bar} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {note ? (
        <p className={styles.note} id="part-pills-note" data-testid="part-pills-note">
          {note}
        </p>
      ) : null}
    </fieldset>
  );
}

export default PartPills;
