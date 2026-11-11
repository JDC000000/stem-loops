'use client';

/**
 * The mixer: six vertical faders with mute and solo. Story 2 of
 * `claude/user-stories-play-along-2026-11-10.md` v2.0.
 *
 * This component is deliberately DUMB about audio. It takes `MixerProps`
 * (a snapshot plus three callbacks) and calls back; it never touches the
 * engine, an AudioContext or a transport. That is what keeps Stories 2.5 and
 * 2.6 — "no glitch, no restart, no reseek" — an engine property rather than a
 * UI property, and what lets this file be built in parallel with the engine.
 *
 * Three things here exist specifically so the component cannot DEFEAT 2.5/2.6:
 *
 *  1. Continuous drag input is rAF-coalesced (`makeGainCoalescer`). A pointer
 *     drag fires `input` at pointer rate; the engine gets at most one `onGain`
 *     per stem per frame, last value wins, and a `flush()` on pointerup/keyup/
 *     blur guarantees the value the user let go of is the value that lands.
 *  2. Children are keyed by STEM NAME, never by index, and each channel is
 *     memoised on primitives, so a fader move re-renders one channel and
 *     remounts nothing.
 *  3. The thumb follows the pointer from local `draft` state while a drag is in
 *     flight, and the draft is dropped once the engine's snapshot catches up.
 *     Without that, a throttled callback plus a controlled `value` makes the
 *     thumb stutter backwards under the finger.
 *
 * Solo semantics are NOT reimplemented here. The contract computes
 * `StemState.effectivelySilent` upstream in one place, and this component
 * renders from it. What the component does decide is how to NAME the silence,
 * because "I muted this" and "this went quiet because I soloed something else"
 * are different states to a user and must not look alike.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  PLAYABLE_STEMS,
  type MixerProps,
  type StemAvailability,
  type StemName,
  type StemState,
} from '@/lib/play/types';

import styles from './Mixer.module.css';

// ─── pure helpers (exported so node:test can reach them without a DOM) ───────

/** Story 2.2: continuous 0..1. The slider itself works in whole percent. */
export const PERCENT_MIN = 0;
export const PERCENT_MAX = 100;

/**
 * [0,1]. NaN collapses to 0 (there is no sensible level for "not a number");
 * the infinities clamp to the bound they are past, like any other out-of-range
 * value, so a bad caller can never widen the range the engine sees.
 */
export function clampGain(gain: number): number {
  if (typeof gain !== 'number' || Number.isNaN(gain)) return 0;
  if (gain <= 0) return 0;
  if (gain >= 1) return 1;
  return gain;
}

/** 0 -> 0, 1 -> 100. Exactly, at both ends. */
export function gainToPercent(gain: number): number {
  return Math.round(clampGain(gain) * 100);
}

export function percentToGain(percent: number): number {
  return clampGain(percent / 100);
}

/** Title case for the accessible name; display case is CSS's business. */
export function stemLabel(stem: StemName): string {
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/**
 * Why a stem is silent, as a user would describe it. Derived from the state we
 * were GIVEN — this does not recompute solo.
 *
 *  'muted'          the user pressed M on this stem
 *  'solo-elsewhere' quiet because another stem is soloed, not because of M
 *  'silent'         `effectivelySilent` with no reason we can honestly name
 *                   (e.g. the engine reports a soloed stem as silent too)
 */
export type SilenceReason = 'muted' | 'solo-elsewhere' | 'silent';

export function silenceReason(stem: StemState): SilenceReason | null {
  if (stem.muted) return 'muted';
  if (!stem.effectivelySilent) return null;
  return stem.soloed ? 'silent' : 'solo-elsewhere';
}

export function silenceText(reason: SilenceReason | null): string {
  switch (reason) {
    case 'muted':
      return 'Muted';
    case 'solo-elsewhere':
      return 'Silent — another stem is soloed';
    case 'silent':
      return 'Silent';
    default:
      return '';
  }
}

/**
 * Stories 5.1 / 5.2: a stem that is not there is disabled and SAYS WHY. Never a
 * dead fader dressed as a live one.
 */
export function unavailableText(availability: StemAvailability, present: boolean): string | null {
  if (availability === 'ready') return null;
  if (availability === 'encode_failed') return 'Unavailable — this stem failed to encode.';
  if (availability === 'unavailable') {
    return present
      ? 'Unavailable — this stem was not produced for this track.'
      : 'Unavailable — no audio was loaded for this stem.';
  }
  // Defensive: an availability value this build does not know about is still
  // not playable, so it is disabled rather than silently treated as ready.
  return 'Unavailable — this stem is not playable.';
}

export interface MixerRow {
  readonly stem: StemState;
  /** False when the snapshot carried no entry for this stem at all. */
  readonly present: boolean;
  readonly disabled: boolean;
  readonly unavailableReason: string | null;
  readonly silence: SilenceReason | null;
}

function absentStem(name: StemName): StemState {
  return {
    name,
    availability: 'unavailable',
    gain: 0,
    muted: false,
    soloed: false,
    effectivelySilent: true,
  };
}

/**
 * Story 2.1: always these six, always in this order, whatever order (or
 * absence, or duplication) the snapshot arrived in. A stem the snapshot does
 * not mention is rendered as an explicitly unavailable channel rather than
 * dropped — six channels is the product, and a silently missing one would be
 * the Story 5 bug.
 */
export function mixerRows(stems: readonly StemState[] | null | undefined): MixerRow[] {
  const byName = new Map<StemName, StemState>();
  for (const stem of stems ?? []) {
    if (!stem) continue;
    if (!(PLAYABLE_STEMS as readonly string[]).includes(stem.name)) continue;
    if (!byName.has(stem.name)) byName.set(stem.name, stem); // first entry wins
  }
  return PLAYABLE_STEMS.map((name) => {
    const found = byName.get(name);
    const stem = found ?? absentStem(name);
    const present = found !== undefined;
    return {
      stem,
      present,
      disabled: stem.availability !== 'ready',
      unavailableReason: unavailableText(stem.availability, present),
      silence: silenceReason(stem),
    };
  });
}

// ─── rAF coalescing for continuous drag input ────────────────────────────────

export type Scheduler = (run: () => void) => void;

export interface GainCoalescer {
  /** Record the latest gain for a stem; emits on the next frame. */
  push(stem: StemName, gain: number): void;
  /** Emit everything pending right now (pointerup / keyup / blur). */
  flush(): void;
  /** Drop everything pending (unmount). */
  cancel(): void;
  readonly pendingCount: number;
}

const defaultScheduler: Scheduler = (run) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => run());
  else setTimeout(run, 16);
};

export function makeGainCoalescer(
  emit: (stem: StemName, gain: number) => void,
  schedule: Scheduler = defaultScheduler,
): GainCoalescer {
  const pending = new Map<StemName, number>();
  let armed = false;

  const flush = () => {
    armed = false;
    if (pending.size === 0) return;
    const batch = Array.from(pending.entries());
    pending.clear(); // clear BEFORE emitting, so a push from inside emit re-arms
    for (const [stem, gain] of batch) emit(stem, gain);
  };

  return {
    push(stem, gain) {
      pending.set(stem, clampGain(gain));
      if (armed) return;
      armed = true;
      schedule(flush);
    },
    flush,
    cancel() {
      pending.clear();
      armed = false;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

// ─── per-job session memory (Story 2.7) ──────────────────────────────────────

export interface RememberedChannel {
  readonly gain: number;
  readonly muted: boolean;
  readonly soloed: boolean;
}
export type MixerMemory = Partial<Record<StemName, RememberedChannel>>;

export const MIXER_MEMORY_VERSION = 'v1';
export const mixerMemoryKey = (jobId: string) => `sl.play.mixer.${MIXER_MEMORY_VERSION}.${jobId}`;

export function snapshotMemory(stems: readonly StemState[]): MixerMemory {
  const out: Record<string, RememberedChannel> = {};
  for (const stem of stems) {
    if (!(PLAYABLE_STEMS as readonly string[]).includes(stem.name)) continue;
    out[stem.name] = {
      gain: clampGain(stem.gain),
      muted: Boolean(stem.muted),
      soloed: Boolean(stem.soloed),
    };
  }
  return out as MixerMemory;
}

/** Never throws, whatever is in sessionStorage. Unknown keys and bad shapes drop. */
export function parseMixerMemory(raw: string | null | undefined): MixerMemory {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, RememberedChannel> = {};
  for (const name of PLAYABLE_STEMS) {
    const entry = (parsed as Record<string, unknown>)[name];
    if (!entry || typeof entry !== 'object') continue;
    const { gain, muted, soloed } = entry as Record<string, unknown>;
    if (typeof gain !== 'number' || !Number.isFinite(gain)) continue;
    out[name] = { gain: clampGain(gain), muted: muted === true, soloed: soloed === true };
  }
  return out as MixerMemory;
}

export interface RestoreOp {
  readonly stem: StemName;
  readonly gain?: number;
  readonly muted?: boolean;
  readonly soloed?: boolean;
}

/**
 * The minimum set of callbacks needed to put a remembered mix back. Only ready
 * stems, and only fields that actually differ — so re-mounting with a mix that
 * already matches costs the engine nothing.
 */
export function memoryRestoreOps(memory: MixerMemory, rows: readonly MixerRow[]): RestoreOp[] {
  const ops: RestoreOp[] = [];
  for (const row of rows) {
    if (row.disabled) continue;
    const remembered = memory[row.stem.name];
    if (!remembered) continue;
    const op: { stem: StemName; gain?: number; muted?: boolean; soloed?: boolean } = {
      stem: row.stem.name,
    };
    if (gainToPercent(remembered.gain) !== gainToPercent(row.stem.gain)) op.gain = remembered.gain;
    if (remembered.muted !== row.stem.muted) op.muted = remembered.muted;
    if (remembered.soloed !== row.stem.soloed) op.soloed = remembered.soloed;
    if (op.gain !== undefined || op.muted !== undefined || op.soloed !== undefined) ops.push(op);
  }
  return ops;
}

function sessionStore(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage ?? null;
  } catch {
    return null; // private mode / blocked storage
  }
}

// ─── one channel ─────────────────────────────────────────────────────────────

/**
 * `orient` is the pre-`writing-mode` way to get a vertical range input in
 * Firefox. It is not in React's typings and it is not standard CSS, so it goes
 * on through a cast rather than by widening React's global types.
 */
const VERTICAL_ATTR = { orient: 'vertical' } as unknown as { orient?: string };

interface ChannelProps {
  readonly stem: StemName;
  readonly percent: number;
  readonly muted: boolean;
  readonly soloed: boolean;
  readonly disabled: boolean;
  readonly unavailableReason: string | null;
  readonly silence: SilenceReason | null;
  readonly onInput: (stem: StemName, percent: number) => void;
  readonly onCommit: () => void;
  readonly onMuteToggle: (stem: StemName, next: boolean) => void;
  readonly onSoloToggle: (stem: StemName, next: boolean) => void;
}

const Channel = memo(function Channel({
  stem,
  percent,
  muted,
  soloed,
  disabled,
  unavailableReason,
  silence,
  onInput,
  onCommit,
  onMuteToggle,
  onSoloToggle,
}: ChannelProps) {
  const faderId = `mixer-fader-${stem}`;
  const noteId = `mixer-note-${stem}`;
  const name = stemLabel(stem);
  const note = unavailableReason ?? silenceText(silence);

  const className = [
    styles.channel,
    disabled ? styles.isDisabled : '',
    muted ? styles.isMuted : '',
    silence === 'solo-elsewhere' || silence === 'silent' ? styles.isDucked : '',
    soloed ? styles.isSoloed : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} data-stem={stem} role="group" aria-label={name}>
      <div className={styles.head}>
        <span className={styles.name}>{name}</span>
        <span className={styles.readout} aria-hidden="true">
          {disabled ? '—' : `${percent}%`}
        </span>
      </div>

      <div className={styles.slot}>
        <input
          {...VERTICAL_ATTR}
          id={faderId}
          className={styles.fader}
          type="range"
          min={PERCENT_MIN}
          max={PERCENT_MAX}
          step={1}
          value={disabled ? 0 : percent}
          disabled={disabled}
          aria-label={`${name} level`}
          aria-valuenow={disabled ? 0 : percent}
          aria-valuemin={PERCENT_MIN}
          aria-valuemax={PERCENT_MAX}
          aria-valuetext={disabled ? 'Unavailable' : `${percent} percent`}
          aria-describedby={note ? noteId : undefined}
          style={{ '--mx-fill': `${disabled ? 0 : percent}%` } as React.CSSProperties}
          onChange={(event) => onInput(stem, Number(event.currentTarget.value))}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
          onBlur={onCommit}
        />
      </div>

      <div className={styles.toggles}>
        <button
          type="button"
          className={`${styles.toggle} ${styles.mute}`}
          data-role="mute"
          disabled={disabled}
          aria-pressed={muted}
          aria-label={`Mute ${name}`}
          onClick={() => onMuteToggle(stem, !muted)}
        >
          M
        </button>
        <button
          type="button"
          className={`${styles.toggle} ${styles.solo}`}
          data-role="solo"
          disabled={disabled}
          aria-pressed={soloed}
          aria-label={`Solo ${name}`}
          onClick={() => onSoloToggle(stem, !soloed)}
        >
          S
        </button>
      </div>

      <p className={styles.note} id={noteId}>
        {note}
      </p>
    </div>
  );
});

// ─── the mixer ───────────────────────────────────────────────────────────────

export interface MixerComponentProps extends MixerProps {
  /**
   * Optional, additive to `MixerProps` (which this does not modify). When it is
   * given, fader positions, mutes and solos are remembered for this job for the
   * browser session — Story 2.7. Left out, the component is purely
   * props-driven and whoever owns the engine owns persistence.
   */
  readonly jobId?: string;
}

export default function Mixer({ stems, onGain, onMute, onSolo, jobId }: MixerComponentProps) {
  const rows = useMemo(() => mixerRows(stems), [stems]);

  // Latest callbacks behind a ref, so the handlers below stay referentially
  // stable and `Channel`'s memo actually bites.
  const callbacks = useRef({ onGain, onMute, onSolo });
  callbacks.current = { onGain, onMute, onSolo };

  const coalescer = useMemo<GainCoalescer>(
    () => makeGainCoalescer((stem, gain) => callbacks.current.onGain(stem, gain)),
    [],
  );
  useEffect(() => () => coalescer.cancel(), [coalescer]);

  /** In-flight drag positions, so the thumb tracks the pointer 1:1. */
  const [draft, setDraft] = useState<Partial<Record<StemName, number>>>({});

  // Drop a draft once the engine's snapshot has caught up with it.
  useEffect(() => {
    setDraft((current) => {
      let changed = false;
      const next = { ...current };
      for (const row of rows) {
        const held = next[row.stem.name];
        if (held !== undefined && gainToPercent(held) === gainToPercent(row.stem.gain)) {
          delete next[row.stem.name];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [rows]);

  const handleInput = useCallback(
    (stem: StemName, percent: number) => {
      const gain = percentToGain(percent);
      setDraft((current) => (current[stem] === gain ? current : { ...current, [stem]: gain }));
      coalescer.push(stem, gain);
    },
    [coalescer],
  );

  const handleCommit = useCallback(() => coalescer.flush(), [coalescer]);

  const handleMuteToggle = useCallback(
    (stem: StemName, next: boolean) => {
      coalescer.flush(); // never let a queued gain land after the mute
      callbacks.current.onMute(stem, next);
    },
    [coalescer],
  );

  const handleSoloToggle = useCallback((stem: StemName, next: boolean) => {
    callbacks.current.onSolo(stem, next);
  }, []);

  // ── Story 2.7: restore once per job, then keep writing ──
  const restoredFor = useRef<string | null>(null);

  useEffect(() => {
    if (!jobId || restoredFor.current === jobId) return;
    if (!rows.some((row) => !row.disabled)) return; // nothing loaded yet; retry next snapshot
    restoredFor.current = jobId;
    const store = sessionStore();
    if (!store) return;
    let raw: string | null = null;
    try {
      raw = store.getItem(mixerMemoryKey(jobId));
    } catch {
      return;
    }
    for (const op of memoryRestoreOps(parseMixerMemory(raw), rows)) {
      if (op.gain !== undefined) callbacks.current.onGain(op.stem, op.gain);
      if (op.muted !== undefined) callbacks.current.onMute(op.stem, op.muted);
      if (op.soloed !== undefined) callbacks.current.onSolo(op.stem, op.soloed);
    }
  }, [jobId, rows]);

  // The engine may publish a snapshot every frame while playing, and `stems` is
  // a new array each time. Serialise first and only touch storage when the mix
  // has actually changed, so a playing track is not writing sessionStorage 60
  // times a second.
  const lastWritten = useRef<string | null>(null);

  useEffect(() => {
    if (!jobId || restoredFor.current !== jobId) return; // don't clobber memory before reading it
    const store = sessionStore();
    if (!store) return;
    const present = rows.filter((row) => row.present).map((row) => row.stem);
    const payload = JSON.stringify(snapshotMemory(present));
    if (payload === lastWritten.current) return;
    lastWritten.current = payload;
    try {
      store.setItem(mixerMemoryKey(jobId), payload);
    } catch {
      /* storage full or blocked — remembering a mix is not worth an error */
    }
  }, [jobId, rows]);

  const anySoloed = rows.some((row) => row.stem.soloed);

  return (
    <section className={styles.mixer} aria-label="Stem mixer">
      <div className={styles.rail}>
        {rows.map((row) => {
          const held = draft[row.stem.name];
          return (
            <Channel
              key={row.stem.name}
              stem={row.stem.name}
              percent={gainToPercent(held !== undefined ? held : row.stem.gain)}
              muted={row.stem.muted}
              soloed={row.stem.soloed}
              disabled={row.disabled}
              unavailableReason={row.unavailableReason}
              silence={row.silence}
              onInput={handleInput}
              onCommit={handleCommit}
              onMuteToggle={handleMuteToggle}
              onSoloToggle={handleSoloToggle}
            />
          );
        })}
      </div>
      <p className={styles.legend}>
        <span className={styles.srOnly}>
          Each fader sets one stem&rsquo;s level from 0 to 100 percent. M mutes a stem; S solos it,
          and several stems can be soloed at once.
        </span>
        <span aria-hidden="true">M mute · S solo{anySoloed ? ' · solo active' : ''}</span>
      </p>
    </section>
  );
}
