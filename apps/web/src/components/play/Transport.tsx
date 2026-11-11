'use client';

/**
 * Play-along TRANSPORT (Track 3B, Story 4): play/pause, seek, time readout,
 * space = play/pause.
 *
 * Takes a snapshot slice plus callbacks (`TransportProps`) and never touches
 * the engine. This is NOT the Timeline zoom slider in ChordOverlay.tsx
 * (`aria-label="Timeline zoom"`): that is a native <input type="range"> that
 * scales the chord timeline. The seek bar here is a separate custom
 * role="slider" labelled "Playback position".
 *
 * SEEK STRATEGY: local scrub position, one `onSeek` on release. While the user
 * holds the thumb (pointer) or is mid key-burst, the thumb renders from the
 * local value and incoming `positionSec` is ignored. The engine rebuilds its
 * source nodes on every seek, so firing per pointermove would thrash it.
 *
 * The pure helpers are exported (and unit tested) because this repo has no DOM
 * harness: effects and real pointer events cannot run under node:test.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { TransportProps, TransportStatus } from '@/lib/play/types';
import s from './Transport.module.css';

// ─── pure logic ──────────────────────────────────────────────────────────────

/** Finite, >= 0 seconds; anything else (NaN, Infinity, negative, non-number) is 0. */
export function sanitizeSec(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** `m:ss` under an hour, `h:mm:ss` from an hour up. Floors; never NaN. */
export function formatTime(sec: unknown): string {
  const t = Math.floor(sanitizeSec(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** What the thumb shows: the local scrub value wins over the engine's, clamped to [0, duration]. */
export function resolveDisplayPosition(
  scrubSec: number | null,
  positionSec: number,
  durationSec: number,
): number {
  const dur = sanitizeSec(durationSec);
  return clamp(sanitizeSec(scrubSec !== null ? scrubSec : positionSec), 0, dur);
}

/** 0..1 fill for the bar. 0 when there is no usable duration. */
export function fraction(positionSec: number, durationSec: number): number {
  const dur = sanitizeSec(durationSec);
  return dur > 0 ? clamp(sanitizeSec(positionSec) / dur, 0, 1) : 0;
}

/** Pointer x -> seconds. Dragging past either end of the bar clamps; a zero-width bar yields 0. */
export function positionFromPointer(
  clientX: number,
  left: number,
  width: number,
  durationSec: number,
): number {
  const dur = sanitizeSec(durationSec);
  if (!(width > 0) || dur <= 0 || !Number.isFinite(clientX)) return 0;
  return clamp((clientX - left) / width, 0, 1) * dur;
}

export type TransportAction = 'play' | 'pause' | 'replay';

export interface Affordance {
  /** What the primary button/space does now, or null when it can do nothing. */
  readonly action: TransportAction | null;
  readonly buttonLabel: string;
  readonly seekable: boolean;
  /** Visible hint explaining a disabled state, so it never looks dead. */
  readonly hint: string | null;
  readonly tone: 'normal' | 'busy' | 'error';
}

export function affordanceFor(status: TransportStatus, durationSec: number): Affordance {
  const hasDuration = sanitizeSec(durationSec) > 0;
  switch (status) {
    case 'loading':
      return { action: null, buttonLabel: 'Play (loading)', seekable: false, hint: 'Loading stems…', tone: 'busy' };
    case 'error':
      return { action: null, buttonLabel: 'Play (unavailable)', seekable: false, hint: 'Playback unavailable', tone: 'error' };
    case 'playing':
      return { action: 'pause', buttonLabel: 'Pause', seekable: hasDuration, hint: null, tone: 'normal' };
    case 'ended':
      return { action: 'replay', buttonLabel: 'Replay', seekable: hasDuration, hint: null, tone: 'normal' };
    case 'ready':
      return { action: hasDuration ? 'play' : null, buttonLabel: 'Play', seekable: hasDuration, hint: null, tone: 'normal' };
    case 'idle':
    default:
      return { action: null, buttonLabel: 'Play (nothing loaded)', seekable: false, hint: 'No track loaded', tone: 'normal' };
  }
}

/** Plain-object description of a focus target, so the decision is testable without a DOM. */
export interface TargetInfo {
  readonly tagName?: string;
  readonly type?: string;
  readonly isContentEditable?: boolean;
  /** Raw `contenteditable` attribute value, if present ('' means true). */
  readonly contentEditable?: string;
  readonly role?: string | null;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'range', 'color', 'file',
]);

/** True when a space keystroke is text the user is typing. */
export function isTypingTarget(t: TargetInfo | null | undefined): boolean {
  if (!t) return false;
  const tag = (t.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has((t.type ?? 'text').toLowerCase());
  if (t.isContentEditable) return true;
  const ce = t.contentEditable?.toLowerCase();
  if (ce === '' || ce === 'true' || ce === 'plaintext-only') return true;
  const role = (t.role ?? '').toLowerCase();
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

/** True when space already does something natively on this target (click, toggle, open). */
export function hasNativeSpace(t: TargetInfo | null | undefined): boolean {
  if (!t) return false;
  const tag = (t.tagName ?? '').toUpperCase();
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || tag === 'SELECT' || tag === 'OPTION') return true;
  if (tag === 'INPUT') {
    const ty = (t.type ?? 'text').toLowerCase();
    return ['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file', 'color'].includes(ty);
  }
  const role = (t.role ?? '').toLowerCase();
  return ['button', 'checkbox', 'switch', 'radio', 'menuitem', 'tab'].includes(role);
}

export interface SpaceKeyInfo {
  readonly key?: string;
  readonly code?: string;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
  readonly defaultPrevented?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly target?: TargetInfo | null;
}

/**
 * The space-bar decision. Returns the action to perform, or null to leave the
 * event completely alone (no preventDefault) so typing and page scroll work.
 */
export function spaceKeyAction(
  e: SpaceKeyInfo,
  status: TransportStatus,
  durationSec: number,
): TransportAction | null {
  const isSpace = e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space';
  if (!isSpace) return null;
  if (e.defaultPrevented || e.isComposing || e.repeat) return null;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (isTypingTarget(e.target) || hasNativeSpace(e.target)) return null;
  return affordanceFor(status, durationSec).action;
}

export const KEY_STEP_SEC = 5;
export const KEY_PAGE_SEC = 15;

/** Slider keys -> target seconds (clamped), or null if the key is not a seek key. */
export function keySeekTarget(
  key: string,
  baseSec: number,
  durationSec: number,
  mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
): number | null {
  if (mods.ctrlKey || mods.metaKey || mods.altKey) return null;
  const dur = sanitizeSec(durationSec);
  const base = clamp(sanitizeSec(baseSec), 0, dur);
  switch (key) {
    case 'ArrowRight': case 'ArrowUp': return clamp(base + KEY_STEP_SEC, 0, dur);
    case 'ArrowLeft': case 'ArrowDown': return clamp(base - KEY_STEP_SEC, 0, dur);
    case 'PageUp': return clamp(base + KEY_PAGE_SEC, 0, dur);
    case 'PageDown': return clamp(base - KEY_PAGE_SEC, 0, dur);
    case 'Home': return 0;
    case 'End': return dur;
    default: return null;
  }
}

export function describeTarget(el: EventTarget | null): TargetInfo | null {
  if (!el || typeof (el as Element).tagName !== 'string') return null;
  const e = el as HTMLElement;
  return {
    tagName: e.tagName,
    type: (e as HTMLInputElement).type,
    isContentEditable: e.isContentEditable,
    contentEditable: e.getAttribute('contenteditable') ?? undefined,
    role: e.getAttribute('role'),
  };
}

// ─── component ───────────────────────────────────────────────────────────────

const KEY_COMMIT_MS = 150;
const SETTLE_MS = 500;

export function Transport({ status, positionSec, durationSec, onPlay, onPause, onSeek }: TransportProps) {
  const dur = sanitizeSec(durationSec);
  const aff = affordanceFor(status, dur);

  // Local override: a live scrub, a pending key burst, or the just-committed value
  // held until the engine reports a new position (so the thumb does not snap back).
  const [override, setOverride] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyPending = useRef<number | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const latest = useRef({ status, dur, onPlay, onPause, onSeek, aff });
  latest.current = { status, dur, onPlay, onPause, onSeek, aff };

  const clearTimers = () => {
    if (keyTimer.current) clearTimeout(keyTimer.current);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    keyTimer.current = null;
    settleTimer.current = null;
  };

  const commit = useCallback((sec: number) => {
    const { aff: a, dur: d, onSeek: seek } = latest.current;
    if (!a.seekable) return;
    const target = clamp(sanitizeSec(sec), 0, d);
    seek(target);
    setOverride(target);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      if (!dragRef.current && keyPending.current === null) setOverride(null);
    }, SETTLE_MS);
  }, []);

  const cancelInteraction = useCallback(() => {
    dragRef.current = false;
    keyPending.current = null;
    clearTimers();
    setScrubbing(false);
    setOverride(null);
  }, []);

  // Engine moved: release a settled override (never one the user is still holding).
  useEffect(() => {
    if (!dragRef.current && keyPending.current === null) setOverride(null);
  }, [positionSec]);

  // Seeking became impossible mid-gesture (status flipped, duration vanished): drop it.
  useEffect(() => {
    if (!aff.seekable) cancelInteraction();
  }, [aff.seekable, cancelInteraction]);

  useEffect(() => clearTimers, []);

  // Global space = play/pause.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { status: st, dur: d, onPlay: play, onPause: pause, onSeek: seek } = latest.current;
      const action = spaceKeyAction(
        {
          key: e.key, code: e.code, repeat: e.repeat, isComposing: e.isComposing,
          defaultPrevented: e.defaultPrevented, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
          altKey: e.altKey, shiftKey: e.shiftKey, target: describeTarget(e.target),
        },
        st,
        d,
      );
      if (!action) return;
      e.preventDefault(); // only when handled: stops the page scrolling
      if (action === 'pause') pause();
      else if (action === 'replay') { seek(0); play(); }
      else play();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onButton = () => {
    if (aff.action === 'pause') onPause();
    else if (aff.action === 'replay') { onSeek(0); onPlay(); }
    else if (aff.action === 'play') onPlay();
  };

  // Pointer scrubbing. Pointer capture keeps move/up flowing to the track even
  // when the pointer leaves the bar, so a release outside still commits (clamped).
  const posAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    return positionFromPointer(clientX, r?.left ?? 0, r?.width ?? 0, dur);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!aff.seekable || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (keyTimer.current) { clearTimeout(keyTimer.current); keyTimer.current = null; }
    keyPending.current = null;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported: release inside still works */ }
    dragRef.current = true;
    setScrubbing(true);
    setOverride(posAt(e.clientX));
    e.currentTarget.focus({ preventScroll: true });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current) setOverride(posAt(e.clientX)); // visual only: no onSeek here
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = false;
    setScrubbing(false);
    commit(posAt(e.clientX)); // the single onSeek for this gesture
  };
  const onPointerCancel = () => { if (dragRef.current) cancelInteraction(); };

  const flushKeys = () => {
    if (keyTimer.current) { clearTimeout(keyTimer.current); keyTimer.current = null; }
    if (keyPending.current !== null) {
      const v = keyPending.current;
      keyPending.current = null;
      commit(v);
    }
  };
  const onSliderKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && dragRef.current) { e.preventDefault(); cancelInteraction(); return; }
    if (!aff.seekable || dragRef.current) return;
    const base = resolveDisplayPosition(keyPending.current ?? override, positionSec, dur);
    const target = keySeekTarget(e.key, base, dur, e);
    if (target === null) return;
    e.preventDefault();
    keyPending.current = target;
    setOverride(target);
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(flushKeys, KEY_COMMIT_MS); // one onSeek per key burst
  };

  const shown = resolveDisplayPosition(override, positionSec, dur);
  const pct = fraction(shown, dur) * 100;
  const valueText = `${formatTime(shown)} of ${formatTime(dur)}`;
  const cls = [s.root, aff.tone === 'busy' ? s.busy : '', aff.tone === 'error' ? s.error : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      role="group"
      aria-label="Playback transport"
      data-testid="transport"
      data-status={status}
      aria-busy={status === 'loading' ? true : undefined}
    >
      <button
        type="button"
        className={s.play}
        onClick={onButton}
        disabled={aff.action === null}
        aria-label={aff.buttonLabel}
        data-testid="transport-play"
      >
        {aff.action === 'pause' ? <PauseIcon /> : aff.action === 'replay' ? <ReplayIcon /> : <PlayIcon />}
      </button>

      <div
        ref={trackRef}
        className={s.track}
        data-scrubbing={scrubbing ? 'true' : undefined}
        role="slider"
        aria-label="Playback position"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={dur}
        aria-valuenow={Math.round(shown * 100) / 100}
        aria-valuetext={valueText}
        aria-disabled={aff.seekable ? undefined : true}
        tabIndex={aff.seekable ? 0 : -1}
        data-testid="transport-seek"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onSliderKey}
        onBlur={flushKeys}
      >
        <div className={s.rail}>
          <div className={s.fill} style={{ width: `${pct}%` }} />
          <div className={s.thumb} style={{ left: `${pct}%` }} />
        </div>
      </div>

      <div className={s.readout} data-testid="transport-time" aria-hidden="true">
        <span>{formatTime(shown)}</span>
        <span className={s.sep}> / </span>
        <span>{formatTime(dur)}</span>
      </div>

      {aff.hint && (
        <div className={s.hint} role={aff.tone === 'error' ? 'alert' : 'status'} data-testid="transport-hint">
          {aff.hint}
        </div>
      )}
    </div>
  );
}

export default Transport;

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}
function ReplayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" fill="currentColor" />
    </svg>
  );
}
