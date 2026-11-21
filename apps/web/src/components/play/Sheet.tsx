'use client';

import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import styles from './Sheet.module.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A downward drag on the handle longer than this closes the sheet. */
export const SWIPE_CLOSE_PX = 80;

/**
 * The next element Tab should land on inside a trapped dialog, or null to let
 * the browser move focus normally. Pure, so the trap is tested without a DOM.
 */
export function trapTarget<T>(items: readonly T[], active: T | null, shift: boolean): T | null {
  if (items.length === 0) return null;
  const i = active === null ? -1 : items.indexOf(active);
  if (shift) return i <= 0 ? items[items.length - 1] : null;
  return i === -1 || i === items.length - 1 ? items[0] : null;
}

export interface SheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** id of the element that names the dialog. */
  readonly labelledBy: string;
  readonly children: ReactNode;
  /** Keep the content mounted (and its effects running) while closed; it is `hidden`. */
  readonly keepMounted?: boolean;
  /** Where focus goes when the sheet closes (the button that opened it). */
  readonly returnFocus?: () => HTMLElement | null;
  readonly testId?: string;
  /** Show the swipe handle (bottom sheets). */
  readonly handle?: boolean;
  /**
   * false: a NON-MODAL half-height sheet (Phase A D5, the Mix sheet). No scrim,
   * no aria-modal, Tab is not trapped and the page above it stays live, so the
   * stage above it stays visible and usable. Escape (anywhere on the
   * page), Close and a swipe down still close it, and focus still moves in on
   * open and back on close.
   */
  readonly modal?: boolean;
}

/**
 * A modal bottom sheet (design v1.4, P1.3): `role="dialog"`, `aria-modal`,
 * focus moved in on open, Tab trapped inside, Escape / Close / a tap on the
 * backdrop / a swipe down on the handle dismiss it, and focus goes back to
 * whatever opened it. On a short landscape screen it is a right-side panel
 * (Sheet.module.css). With `modal={false}` it is the non-modal variant (see
 * the prop).
 */
export function Sheet({ open, onClose, labelledBy, children, keepMounted = false, returnFocus, testId, handle = true, modal = true }: SheetProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const drag = useRef<number | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const back = useRef(returnFocus);
  back.current = returnFocus;

  useEffect(() => {
    if (!open) return;
    const doc = globalThis.document;
    opener.current = (doc?.activeElement as HTMLElement | null) ?? null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      // The caller's target (the Mix button, the ⋯ button) when it names one;
      // otherwise whatever opened the sheet, if it is still in the page.
      const o = opener.current;
      const usable = o && o.isConnected && o !== globalThis.document?.body ? o : null;
      const target = back.current?.() ?? usable;
      target?.focus?.();
    };
  }, [open]);

  // Non-modal: focus may be anywhere on the page (the sheet does not trap it),
  // so Escape is heard at the document. A handler that already used the key
  // (the ⋯ menu closing itself, a modal sheet) calls preventDefault and wins.
  useEffect(() => {
    if (!open || modal) return;
    const doc = globalThis.document;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      close.current();
    };
    doc?.addEventListener('keydown', onKey);
    return () => doc?.removeEventListener('keydown', onKey);
  }, [open, modal]);

  if (!open && !keepMounted) return null;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close.current();
      return;
    }
    if (!modal || e.key !== 'Tab' || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === globalThis.document?.activeElement);
    const next = trapTarget(items, (globalThis.document?.activeElement as HTMLElement | null) ?? null, e.shiftKey);
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = e.clientY;
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const y0 = drag.current;
    drag.current = null;
    if (y0 !== null && e.clientY - y0 > SWIPE_CLOSE_PX) close.current();
  };

  return (
    <div
      className={modal ? styles.backdrop : `${styles.backdrop} ${styles.modeless}`}
      hidden={!open}
      data-testid={testId ? `${testId}-backdrop` : undefined}
      data-modal={modal ? undefined : 'false'}
      onPointerDown={(e) => {
        if (modal && e.target === e.currentTarget) close.current();
      }}
    >
      <div
        ref={ref}
        className={styles.sheet}
        role="dialog"
        aria-modal={modal ? 'true' : undefined}
        aria-labelledby={labelledBy}
        data-testid={testId}
        onKeyDown={onKeyDown}
      >
        {handle ? (
          <div className={styles.handleZone} onPointerDown={onHandleDown} onPointerUp={onHandleUp} onPointerCancel={() => (drag.current = null)}>
            <div className={styles.handle} aria-hidden="true" />
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export default Sheet;
