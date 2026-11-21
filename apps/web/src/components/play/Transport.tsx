'use client';

/**
 * Play-along TRANSPORT (Track 3B, Story 4): play/pause, seek, time readout,
 * space = play/pause.
 *
 * Takes a snapshot slice plus callbacks (`TransportProps`) and never touches
 * the engine. This is NOT the Timeline zoom slider in ChordOverlay.tsx
 * (`aria-label="Timeline zoom"`), which scales the chord chart. The seek bar
 * here is its own REAL <input type="range"> labelled "Song position" (design
 * v1.4, P1.1), laid over a drawn bar so the section ticks and the loop band
 * can sit on it; the drawn thumb carries the focus ring.
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

/** "⟲": back to the start of the section (or loop) being played (D4, Jon 2026-11-21). */
export const RESTART_LABEL = 'Back to the start of this section';

/** The seek line's readout under the bar: "0:53" and "-2:41". */
export function remainingText(positionSec: number, durationSec: number): string {
  const dur = sanitizeSec(durationSec);
  const left = Math.max(0, dur - clamp(sanitizeSec(positionSec), 0, dur));
  return `-${formatTime(left)}`;
}

/** Percent along the bar, for drawn marks (ticks, the loop band, the thumb). */
export function pctOf(sec: number, durationSec: number): number {
  return fraction(sec, durationSec) * 100;
}

export type LoopButtonState = 'on' | 'off' | 'disabled';

export interface PlayerTransportProps extends TransportProps {
  /** Section starts (seconds), drawn as ticks on the seek line. */
  readonly ticks?: readonly number[];
  /** Each tick's section colour slot (same index as `ticks`; SectionLoop's data-tone). */
  readonly tickTones?: readonly number[];
  /** "⟲": seek to the start of the current section or loop, keeping play state. Absent = no button. */
  readonly onRestart?: (() => void) | null;
  /** The span being looped, drawn as a band; null when the loop is off. */
  readonly loopBand?: { readonly startSec: number; readonly endSec: number } | null;
  /** "Looping Verse 1 → Chorus 1 · 0:32–1:18", "Loop off" or "". */
  readonly loopText?: string;
  /** The loop button (P2.1): on, off (a run remembered) or disabled (nothing to loop). */
  readonly loopState?: LoopButtonState;
  readonly onToggleLoop?: () => void;
  /** The Mix button (phones and tablets); absent where the mixer is always shown. */
  readonly mix?: {
    readonly label: string;
    readonly open: boolean;
    readonly onOpen: () => void;
    readonly buttonRef?: (el: HTMLButtonElement | null) => void;
  } | null;
}

/** Seek-commit delay for a key burst on the range input, ms. */
const KEY_COMMIT_MS = 150;
const SETTLE_MS = 500;

/**
 * THE TRANSPORT (design v1.4, P1.1): the seek line — a REAL range input over a
 * drawn bar with section ticks, the loop band and a thumb that shows the focus
 * ring — then ⟲ (back to this section's start) · Play/Pause · Loop · Mix.
 * The −5 s / +5 s skips are gone (D4, 2026-11-21): the section chips and ⟲
 * are the song's navigation, and the arrow keys on the seek line still step 5 s.
 *
 * SEEK STRATEGY (unchanged): while the user holds the thumb or is mid
 * key-burst, the bar renders the local value and ignores incoming positions;
 * ONE `onSeek` on release. The engine rebuilds its source nodes on every seek,
 * so seeking per pointermove would thrash it.
 *
 * Space anywhere that does not type or activate something = play/pause.
 */
export function Transport({
  status,
  positionSec,
  durationSec,
  onPlay,
  onPause,
  onSeek,
  ticks = [],
  tickTones,
  onRestart = null,
  loopBand = null,
  loopText = '',
  loopState = 'disabled',
  onToggleLoop,
  mix = null,
}: PlayerTransportProps) {
  const dur = sanitizeSec(durationSec);
  const aff = affordanceFor(status, dur);

  const [override, setOverride] = useState<number | null>(null);
  const holding = useRef(false);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const latest = useRef({ status, dur, onPlay, onPause, onSeek, aff, override });
  latest.current = { status, dur, onPlay, onPause, onSeek, aff, override };

  const clearTimers = () => {
    if (keyTimer.current) clearTimeout(keyTimer.current);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    keyTimer.current = null;
    settleTimer.current = null;
  };

  const commit = useCallback(() => {
    const { aff: a, dur: d, onSeek: seek, override: o } = latest.current;
    holding.current = false;
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = null;
    if (o === null || !a.seekable) return;
    seek(clamp(sanitizeSec(o), 0, d));
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      if (!holding.current) setOverride(null);
    }, SETTLE_MS);
  }, []);

  // A fresh engine position drops a stale override once nothing is held.
  useEffect(() => {
    if (!holding.current && keyTimer.current === null && settleTimer.current === null) setOverride(null);
  }, [positionSec]);

  useEffect(() => {
    if (!aff.seekable) {
      holding.current = false;
      clearTimers();
      setOverride(null);
    }
  }, [aff.seekable]);

  useEffect(() => clearTimers, []);

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

  const shown = resolveDisplayPosition(override, positionSec, dur);
  const pct = pctOf(shown, dur);
  const valueText = `${formatTime(shown)} of ${formatTime(dur)}`;
  const loopLabel = loopState === 'disabled' ? 'Loop (no sections)' : loopState === 'on' ? 'Loop' : 'Loop this section';

  return (
    <div
      className={`${s.root} ${aff.tone === 'busy' ? s.busy : ''} ${aff.tone === 'error' ? s.error : ''}`}
      data-testid="transport"
      aria-busy={aff.tone === 'busy' ? true : undefined}
    >
      <div className={s.seek}>
        <div className={s.loopText} data-testid="transport-loop-text">{loopText}</div>
        <div className={s.track}>
          <div className={s.rail} aria-hidden="true" />
          {loopBand && dur > 0 ? (
            <div
              className={s.band}
              aria-hidden="true"
              data-testid="transport-loop-band"
              style={{ left: `${pctOf(loopBand.startSec, dur)}%`, width: `${Math.max(0, pctOf(loopBand.endSec, dur) - pctOf(loopBand.startSec, dur))}%` }}
            />
          ) : null}
          <div className={s.fill} aria-hidden="true" style={{ width: `${pct}%` }} />
          {dur > 0
            ? ticks.map((t, i) =>
                t > 0 && t < dur ? (
                  <div
                    key={t}
                    className={s.tick}
                    data-tone={tickTones?.[i]}
                    aria-hidden="true"
                    style={{ left: `${pctOf(t, dur)}%` }}
                  />
                ) : null,
              )
            : null}
          <input
            className={s.range}
            type="range"
            min={0}
            max={dur > 0 ? dur : 1}
            step="any"
            value={shown}
            disabled={!aff.seekable}
            aria-label="Song position"
            aria-valuetext={valueText}
            data-testid="transport-seek"
            onPointerDown={() => {
              holding.current = true;
            }}
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              setOverride(Number.isFinite(v) ? v : 0);
              if (!holding.current) {
                // Keyboard (or assistive tech): commit after the burst settles.
                if (keyTimer.current) clearTimeout(keyTimer.current);
                keyTimer.current = setTimeout(commit, KEY_COMMIT_MS);
              }
            }}
            onPointerUp={commit}
            onPointerCancel={commit}
            onBlur={() => {
              if (holding.current || keyTimer.current) commit();
            }}
          />
          <div className={s.thumb} aria-hidden="true" style={{ left: `${pct}%` }} />
        </div>
        <div className={s.times} data-testid="transport-time" aria-hidden="true">
          <span>{formatTime(shown)}</span>
          <span>{remainingText(shown, dur)}</span>
        </div>
      </div>

      <div className={s.buttons}>
        {onRestart ? (
          <button
            type="button"
            className={s.restart}
            aria-label={RESTART_LABEL}
            title={RESTART_LABEL}
            disabled={!aff.seekable}
            onClick={onRestart}
            data-testid="transport-restart"
          >
            <RestartIcon />
          </button>
        ) : null}
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
        <button
          type="button"
          className={s.loop}
          data-state={loopState}
          aria-label={loopLabel}
          aria-pressed={loopState === 'on'}
          aria-disabled={loopState === 'disabled' ? true : undefined}
          data-testid="transport-loop"
          onClick={() => {
            if (loopState !== 'disabled') onToggleLoop?.();
          }}
        >
          <LoopIcon />
        </button>
        {mix ? (
          <button
            type="button"
            className={s.mix}
            aria-haspopup="dialog"
            aria-expanded={mix.open}
            ref={mix.buttonRef}
            onClick={mix.onOpen}
            data-testid="transport-mix"
          >
            <span className={s.mixName}>Mix</span>
            <span className={s.mixState}>{mix.label}</span>
          </button>
        ) : null}
      </div>

      {aff.hint && aff.tone !== 'normal' ? (
        <div className={s.hint} role={aff.tone === 'error' ? 'alert' : 'status'} data-testid="transport-hint">
          {aff.hint}
        </div>
      ) : null}
    </div>
  );
}

export default Transport;

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}
/** ⟲, drawn (U+27F2 is missing from common phone fonts). */
function RestartIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}
function LoopIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
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
