'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { type RunState, stripLegend } from '@/lib/play/sections';
import styles from './SectionLoop.module.css';

/** Long-press threshold (design v1.4, P2.1; D4). */
export const LONG_PRESS_MS = 500;
/** A finger that moves this far is scrolling the strip, not pressing a chip. */
export const LONG_PRESS_SLOP_PX = 10;

/**
 * How long after the long-press is RELEASED (pointerup / pointercancel) its
 * click may still arrive. The flag is held for as long as the pointer stays
 * down — a 2-second hold must still swallow its release click (review R1 on
 * #288) — and dropped this long after the release, so a click that never comes
 * cannot eat a later activation.
 *
 * pointerleave is NOT a release (Slice 1b, review nit on #288): a mouse held
 * down can slide off the chip and back before letting go. Starting the window
 * there let it expire mid-hold, so the eventual release click read as a tap and
 * undid the loop. Leaving only cancels a long-press that has not fired yet. If
 * the button is released elsewhere no click reaches the chip at all, and the
 * next pointerdown or key press clears the flag.
 */
export const SWALLOW_WINDOW_MS = 700;

// The strip's two one-time hints live with the rules they describe.
export { RUN_HINT, STRIP_HINT } from '@/lib/play/sections';

export interface SectionStripProps {
  /** Display names, in strip order ("Part 1", "Part 2", ...). */
  readonly names: readonly string[];
  /** Each section's start, shown after the name ("Part 3 · 1:50"). */
  readonly times?: readonly string[];
  /** Each section's colour slot (nameRegions `tone`); absent = no colour. */
  readonly tones?: readonly number[];
  /** The section under the playhead (aria-current; kept scrolled into view), or -1. */
  readonly current?: number;
  /** The run on screen: looping, or remembered while the loop is off. */
  readonly state: RunState;
  /** A tap, click, Enter or Space on chip `i`: jump (the table lives in tapChip). */
  readonly onTap: (i: number) => void;
  /** Long-press or Shift+Enter on chip `i`: loop (the table lives in holdChip). */
  readonly onLongPress: (i: number) => void;
  /** A line under the strip (STRIP_HINT or RUN_HINT), or nothing. */
  readonly hint?: string | null;
}

/** How many chips sit outside the strip's visible box, above and below (the "+N" cue). */
export interface Overflow {
  readonly above: number;
  readonly below: number;
}
export const NO_OVERFLOW: Overflow = Object.freeze({ above: 0, below: 0 });

/** Count the chips of `list` that are not fully inside its visible box. */
export function countOverflow(list: HTMLElement): Overflow {
  const l = list.getBoundingClientRect();
  let above = 0;
  let below = 0;
  for (const chip of Array.from(list.querySelectorAll<HTMLElement>('button[data-index]'))) {
    const c = chip.getBoundingClientRect();
    if (c.bottom > l.bottom + 0.5) below += 1;
    else if (c.top < l.top - 0.5) above += 1;
  }
  return { above, below };
}

/** The cue's text: "+3 more ↓" (the way to scroll); "" when every chip is visible. */
export function overflowText(o: Overflow): string {
  const n = o.above + o.below;
  if (n === 0) return '';
  return `+${n} more ${o.below > 0 ? '\u2193' : '\u2191'}`;
}

// useLayoutEffect warns under server rendering; the strip measures only in a browser.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Scroll `list` (only it, never the page) so `chip` is fully inside it. */
export function scrollChipIntoList(list: HTMLElement, chip: HTMLElement): void {
  const l = list.getBoundingClientRect();
  const c = chip.getBoundingClientRect();
  if (c.top < l.top) list.scrollTop += c.top - l.top;
  else if (c.bottom > l.bottom) list.scrollTop += c.bottom - l.bottom;
}

/**
 * The section strip (design v1.4 P1.1 + P2.1; D2 + D4, 2026-11-21): chips that
 * WRAP onto rows, at most two rows tall (then the strip scrolls and keeps the
 * current section in view), in a fieldset whose legend says how to use it and
 * names the run. Stateless about the run itself: `state` comes from the
 * player, which owns it, so what is pressed can never disagree with what the
 * engine loops.
 *
 * Chips are buttons with `aria-pressed` (true while looping). Tap, Enter or
 * Space = JUMP. Long-press (touch or mouse) or Shift+Enter = LOOP: 500 ms,
 * cancelled when the pointer moves (so scrolling the strip never triggers it),
 * and the click that follows its release is SWALLOWED, or the release would
 * read as a tap and stop the loop it just started.
 */
export function SectionLoop({ names, times, tones, current = -1, state, onTap, onLongPress, hint = null }: SectionStripProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const swallow = useRef(false);
  const swallowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState<Overflow>(NO_OVERFLOW);
  const measure = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const next = countOverflow(el);
    setOverflow((o) => (o.above === next.above && o.below === next.below ? o : next));
  }, []);

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

  // Keep the current section in view when the strip is taller than two rows
  // and scrolls. Only the strip moves, and instantly (nothing to reduce).
  useEffect(() => {
    const el = listRef.current;
    if (!el || current < 0 || !(el.scrollHeight > el.clientHeight)) return;
    const chip = el.querySelector<HTMLElement>(`button[data-index="${current}"]`);
    if (chip) scrollChipIntoList(el, chip);
    measure();
  }, [current, measure]);

  // The "+N more" cue (review B1/M2 on #330): whenever chips do not all fit
  // (a short phone, a long song), say how many are out of view and which way.
  const count = names.length;
  useIsoLayoutEffect(() => {
    measure();
    const el = listRef.current;
    if (!el) return undefined;
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const ro = RO ? new RO(measure) : null;
    ro?.observe(el);
    globalThis.addEventListener?.('resize', measure);
    return () => {
      ro?.disconnect();
      globalThis.removeEventListener?.('resize', measure);
    };
  }, [count, measure]);

  if (names.length === 0) return null;

  const down = (i: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    cancel();
    clearSwallow();
    start.current = { x: e.clientX, y: e.clientY };
    timer.current = setTimeout(() => {
      timer.current = null;
      // Held: swallow the click that follows the RELEASE. The expiry window is
      // armed at release (see `release`), never here.
      swallow.current = true;
      onLongPress(i);
    }, LONG_PRESS_MS);
  };
  /** The pointer let go: end the press, and start the swallow window if armed. */
  const release = () => {
    cancel();
    if (swallow.current && !swallowTimer.current) swallowTimer.current = setTimeout(clearSwallow, SWALLOW_WINDOW_MS);
  };
  /** The pointer left the chip, still down: cancel a pending long-press, nothing else. */
  const leave = () => cancel();
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s) return;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > LONG_PRESS_SLOP_PX) cancel();
  };

  return (
    <fieldset className={styles.root} data-testid="section-strip">
      <legend className={styles.srOnly}>{stripLegend(names, state)}</legend>
      <div className={styles.listWrap}>
        <div className={styles.list} ref={listRef} onScroll={measure}>
          {names.map((name, i) => {
            const inRun = !!state.run && i >= state.run.lo && i <= state.run.hi;
            const pressed = inRun && state.on;
            const time = times?.[i];
            const tone = tones?.[i];
            return (
              <button
                key={`${i}-${name}`}
                type="button"
                className={styles.chip}
                data-index={i}
                data-tone={tone}
                data-run={inRun ? (state.on ? 'on' : 'remembered') : undefined}
                aria-pressed={pressed}
                aria-current={i === current ? 'true' : undefined}
                aria-keyshortcuts="Shift+Enter"
                onPointerDown={down(i)}
                onPointerMove={move}
                onPointerUp={release}
                onPointerCancel={release}
                onPointerLeave={leave}
                onContextMenu={(e) => e.preventDefault()}
                onKeyDown={(e) => {
                  clearSwallow();
                  if (e.key === 'Enter' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
                    // The keyboard's long-press: loop this section.
                    e.preventDefault();
                    if (!e.repeat) onLongPress(i);
                  }
                }}
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
                <span className={styles.label}>
                  {name}
                  {time ? (
                    <span className={styles.time}>
                      <span className={styles.sep}>{' · '}</span>
                      {time}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
        {overflowText(overflow) ? (
          // Not a control (swipe the strip; every chip is in the tab order), so it
          // is hidden from assistive tech, which reaches every chip anyway.
          <span className={styles.more} data-testid="section-more" data-dir={overflow.below > 0 ? 'down' : 'up'} aria-hidden="true">
            {overflowText(overflow)}
          </span>
        ) : null}
      </div>
      {hint ? (
        <p className={styles.hint} data-testid="section-hint">
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}

export default SectionLoop;
