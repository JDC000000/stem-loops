'use client';

import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { type RunState, stripLegend } from '@/lib/play/sections';
import styles from './SectionLoop.module.css';

/** Long-press threshold (design v1.4, P2.1). */
export const LONG_PRESS_MS = 500;
/** A finger that moves this far is scrolling the strip, not pressing a chip. */
export const LONG_PRESS_SLOP_PX = 10;

/**
 * How long after a long-press its release click may still arrive. Past this the
 * swallow flag is dropped, so a long-press whose click never comes (the finger
 * slid off, or the browser suppressed it) cannot eat a later activation.
 */
export const SWALLOW_WINDOW_MS = 700;

/** The one-time hint after the first extend (P2.1 "signposting the change"). */
export const RUN_HINT = 'Looping these — tap one to loop it alone.';

export interface SectionStripProps {
  /** Display names, in strip order ("Verse 1", "Chorus 1", ...). */
  readonly names: readonly string[];
  /** The run on screen: looping, or remembered while the loop is off. */
  readonly state: RunState;
  /** A tap, click, Enter or Space on chip `i`. The P2.1 table lives in tapSection. */
  readonly onTap: (i: number) => void;
  /** Long-press on chip `i`: loop only this. */
  readonly onLongPress: (i: number) => void;
  /** Show the one-time hint under the strip. */
  readonly hint?: boolean;
}

/**
 * The section strip (design v1.4, P1.1 + P2.1): one row of chips that scrolls
 * sideways, in a fieldset whose legend names the run. Stateless about the run
 * itself: `state` comes from the player, which owns it, so what is pressed can
 * never disagree with what the engine loops.
 *
 * Chips are buttons with `aria-pressed`. Enter/Space = tap. Long-press (touch
 * or mouse) is "loop only this": 500 ms, cancelled when the pointer moves (so
 * scrolling the strip never triggers it), and the click that follows its
 * release is SWALLOWED, or the release would read as a tap and undo it.
 */
export function SectionLoop({ names, state, onTap, onLongPress, hint = false }: SectionStripProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const swallow = useRef(false);
  const swallowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

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

  // Keep the run's ends in view (P2.1 auto-scroll): the far end first, then the
  // near end, so on a run wider than the strip its START wins.
  const lo = state.run?.lo ?? -1;
  const hi = state.run?.hi ?? -1;
  useEffect(() => {
    const el = listRef.current;
    if (!el || lo < 0) return;
    const chips = el.querySelectorAll<HTMLElement>('button[data-index]');
    for (const i of [hi, lo]) chips[i]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [lo, hi]);

  if (names.length === 0) return null;

  const down = (i: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    cancel();
    clearSwallow();
    start.current = { x: e.clientX, y: e.clientY };
    timer.current = setTimeout(() => {
      timer.current = null;
      swallow.current = true;
      // The release click arrives right after pointerup; if it never does,
      // the flag must not outlive this window.
      swallowTimer.current = setTimeout(clearSwallow, SWALLOW_WINDOW_MS);
      onLongPress(i);
    }, LONG_PRESS_MS);
  };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s) return;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > LONG_PRESS_SLOP_PX) cancel();
  };

  return (
    <fieldset className={styles.root} data-testid="section-strip">
      <legend className={styles.srOnly}>{stripLegend(names, state)}</legend>
      <div className={styles.list} ref={listRef}>
        {names.map((name, i) => {
          const inRun = !!state.run && i >= state.run.lo && i <= state.run.hi;
          const pressed = inRun && state.on;
          return (
            <button
              key={`${i}-${name}`}
              type="button"
              className={styles.chip}
              data-index={i}
              data-run={inRun ? (state.on ? 'on' : 'remembered') : undefined}
              aria-pressed={pressed}
              onPointerDown={down(i)}
              onPointerMove={move}
              onPointerUp={cancel}
              onPointerCancel={cancel}
              onPointerLeave={cancel}
              onContextMenu={(e) => e.preventDefault()}
              onKeyDown={clearSwallow}
              onClick={(e) => {
                // Only a POINTER click (detail >= 1) can be the long-press's
                // release. Keyboard, switch and AT activation dispatch a click
                // with detail 0 and is never swallowed.
                if (swallow.current && e.detail > 0) {
                  clearSwallow();
                  return;
                }
                clearSwallow();
                onTap(i);
              }}
            >
              {name}
            </button>
          );
        })}
      </div>
      {hint ? (
        <p className={styles.hint} data-testid="section-hint">
          {RUN_HINT}
        </p>
      ) : null}
    </fieldset>
  );
}

export default SectionLoop;
