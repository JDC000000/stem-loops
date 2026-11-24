/**
 * Count-in (Phase C, C2; user story 4.8; Jon PC-1, 2026-11-23).
 *
 * An OPTIONAL one-bar click (4 beats at the song's BPM) before playback starts
 * from a user action:
 *   - a tap on a section chip (jump + play),
 *   - a long-press loop start,
 *   - ⟲ back to the section start (while playing),
 *   - Play from pause.
 *
 * It is deliberately NOT played on a loop wrap: counting in every pass would
 * break the loop. The wrap is the engine's native loop; this module never sees
 * it, and the player only calls `start()` from the four user actions above.
 *
 * Pure: no React, no engine import. The click sound and the timers are
 * injected so the math and the cancel rule are testable with a fake clock.
 * The engine exposes no AudioContext, so the default click sink owns a small
 * context of its own (created lazily, inside the user's gesture).
 */

/** One bar of 4/4. */
export const COUNT_IN_BEATS = 4;
/** The toggle is remembered per user (per browser) here: '1' = on. Off by default. */
export const COUNT_IN_KEY = 'sl.play.countIn.v1';
/** Shown under the disabled toggle when the song has no usable tempo. */
export const COUNT_IN_NEEDS_BPM = 'Needs a detected tempo for this song.';
/** Detected tempos outside this range are noise, not a pulse to count to. */
export const MIN_COUNT_IN_BPM = 30;
export const MAX_COUNT_IN_BPM = 300;
/**
 * After a count-in is cancelled by the user's own tap or key, a Play request
 * this soon after is the same gesture's click (pointerdown cancels, the click
 * follows), not a new request: it must not start the count again.
 */
export const CANCEL_SWALLOW_MS = 600;
/** The click context schedules its first click this far ahead (`CLICK_LEAD_SEC`). */
export const CLICK_LEAD_SEC = 0.03;
/** The engine starts its voices this far after `play()` (engine.ts START_LEAD_SEC). */
export const ENGINE_LEAD_SEC = 0.05;
/** Latencies above this are not believed (the project's route estimate is capped the same way). */
export const MAX_LATENCY_SEC = 0.5;
/** After this the output latencies are read again (the contexts have resumed by then). */
export const SETTLE_MS = 150;

export interface CountTiming {
  /** Click context: outputLatency (else baseLatency), seconds. */
  readonly clickLatencySec: number;
  /** Engine route latency (the playhead compensation), seconds. */
  readonly engineLatencySec: number;
}
const lat = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LATENCY_SEC) : 0);

/**
 * The engine side's latency for the count. On the phone route (audio goes through
 * the `<audio>` element) it is the route's estimate. On every other route
 * (desktop, iPad) the engine's context reaches the speakers directly, with the
 * SAME device latency the click context has, so it is that context's
 * outputLatency (else baseLatency); reading 0 there would make the music late by
 * the device latency (150-250 ms on Bluetooth).
 */
export function engineCountLatencySec(
  src: { outputLatency?: number; baseLatency?: number } | null | undefined,
  routed: boolean,
  routeSec: number,
): number {
  if (routed) return lat(routeSec);
  return lat(src?.outputLatency) || lat(src?.baseLatency);
}

/**
 * Two contexts, two clocks. Click i is HEARD at t0 + CLICK_LEAD + i*beat + clickLat.
 * The music is heard at (the play() call) + ENGINE_LEAD + engineLat. So:
 *  - `ui`: when to show a number so it lands with its click;
 *  - `downbeat`: how far from t0 + 4 beats to call play() so the first note
 *    lands on the 5th beat (a negative value calls it early).
 */
export function timingOffsets(t: CountTiming | null | undefined): { ui: number; downbeat: number } {
  if (!t) return { ui: 0, downbeat: 0 }; // no timing source: plain 4 x 60/BPM
  const c = lat(t.clickLatencySec);
  const e = lat(t.engineLatencySec);
  return { ui: CLICK_LEAD_SEC + c, downbeat: CLICK_LEAD_SEC + c - ENGINE_LEAD_SEC - e };
}

/** A usable BPM (number or numeric string, e.g. jobs.bpm), or null. */
export function countInBpm(bpm: unknown): number | null {
  const n = typeof bpm === 'string' ? Number(bpm.trim() === '' ? NaN : bpm) : bpm;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return n >= MIN_COUNT_IN_BPM && n <= MAX_COUNT_IN_BPM ? n : null;
}

/** One beat, in seconds: 60 / BPM. */
export function beatSec(bpm: number): number {
  return 60 / bpm;
}

/** The whole count-in, in seconds: 4 beats. */
export function countInSec(bpm: number): number {
  return COUNT_IN_BEATS * beatSec(bpm);
}

/** Click times (seconds from the start), one per beat: 0, 60/BPM, 2*60/BPM, 3*60/BPM. */
export function clickOffsets(bpm: number): number[] {
  return Array.from({ length: COUNT_IN_BEATS }, (_, i) => i * beatSec(bpm));
}

export function readCountIn(): boolean {
  try {
    return globalThis.localStorage?.getItem(COUNT_IN_KEY) === '1';
  } catch {
    return false;
  }
}
export function writeCountIn(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(COUNT_IN_KEY, '1');
    else globalThis.localStorage?.removeItem(COUNT_IN_KEY);
  } catch {
    /* private mode: the choice simply is not remembered */
  }
}

/** Makes the clicks. `schedule` is called once per beat, up front, with its offset in seconds. */
export interface ClickSink {
  schedule(offsetSec: number, accent: boolean): void;
  stop(): void;
  /** Close the one context (unmount). A later `schedule` may open a new one. */
  close?(): void;
  /** The click context's output latency in seconds (0 when unknown or not open). */
  latencySec?(): number;
}

export interface Timers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  now(): number;
}

const realTimers: Timers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface CountInOptions {
  /** Song tempo; null / unusable = no count-in (`start` runs `then` at once). */
  readonly bpm: number | null;
  /** The numbers on screen: 4, 3, 2, 1, then null when the count ends or is cancelled. */
  readonly onBeat: (beat: number | null) => void;
  readonly clicks?: ClickSink;
  readonly timers?: Timers;
  /** Read at each start: the two output latencies (see `timingOffsets`). Absent = none. */
  readonly timing?: () => CountTiming | null | undefined;
  /** An ACTIVE count was cancelled (by the user, a toggle, a replace or an unmount); never when it completes. */
  readonly onCancel?: () => void;
}

export interface CountIn {
  /** Begin the count; `then` runs after the 4th beat. Returns false (and runs `then` now) with no BPM. */
  start(then: () => void): boolean;
  /** Stop the count: no more clicks, `then` never runs. `byUser` arms the Play swallow window. */
  cancel(byUser?: boolean): void;
  readonly active: boolean;
  /** True just after the user cancelled the count: a Play request now is that gesture's click. */
  swallowPlay(): boolean;
}

export function createCountIn(options: CountInOptions): CountIn {
  const bpm = countInBpm(options.bpm);
  const timers = options.timers ?? realTimers;
  const ids: unknown[] = [];
  let active = false;
  let cancelledAt = -Infinity;

  const clear = () => {
    for (const id of ids.splice(0)) timers.clearTimeout(id);
  };

  const cancel = (byUser = false) => {
    if (!active) return;
    active = false;
    clear();
    options.clicks?.stop();
    if (byUser) cancelledAt = timers.now();
    options.onBeat(null);
    options.onCancel?.();
  };

  return {
    get active() {
      return active;
    },
    swallowPlay() {
      return timers.now() - cancelledAt < CANCEL_SWALLOW_MS;
    },
    cancel,
    start(then) {
      if (bpm === null) {
        then();
        return false;
      }
      cancel(); // a count already running is replaced, not stacked
      cancelledAt = -Infinity;
      active = true;
      const offsets = clickOffsets(bpm);
      const t0 = timers.now();
      offsets.forEach((off, i) => options.clicks?.schedule(off, i === 0));
      options.onBeat(COUNT_IN_BEATS);
      // The numbers (beats 3..1) and the downbeat are (re)armed from the latencies
      // as they read NOW. On the first count of a session both contexts are still
      // suspended and read 0 when this runs, so they are read AGAIN once the
      // in-gesture resume has had a moment (SETTLE_MS) and what is left is re-armed.
      const arm = () => {
        clear();
        const { ui, downbeat } = timingOffsets(options.timing?.());
        const elapsed = timers.now() - t0;
        offsets.forEach((off, i) => {
          if (i === 0) return; // beat 4 is shown by the onBeat() above
          ids.push(
            timers.setTimeout(() => {
              if (active) options.onBeat(COUNT_IN_BEATS - i);
            }, Math.max(0, (off + ui) * 1000 - elapsed)),
          );
        });
        ids.push(
          timers.setTimeout(() => {
            if (!active) return;
            active = false;
            clear();
            options.onBeat(null);
            then();
          }, Math.max(0, (countInSec(bpm) + downbeat) * 1000 - elapsed)),
        );
      };
      arm();
      if (countInSec(bpm) * 1000 > 2 * SETTLE_MS) {
        ids.push(
          timers.setTimeout(() => {
            if (active) arm();
          }, SETTLE_MS),
        );
      }
      return true;
    },
  };
}

/**
 * While a count runs, ANY other tap or key press cancels it (the user changed
 * their mind, or is doing something else). Capture phase, so it sees the event
 * before the control that is about to handle it; a chip tap then starts a fresh
 * count of its own. Key repeat (a held Enter) is not a new press. Returns the
 * detacher.
 */
export function cancelOnOtherInput(count: CountIn, target: Pick<Document, 'addEventListener' | 'removeEventListener'> | null | undefined = globalThis.document): () => void {
  if (!target) return () => {};
  const on = (e: Event) => {
    if ((e as KeyboardEvent).repeat) return;
    count.cancel(true);
  };
  target.addEventListener('pointerdown', on, true);
  target.addEventListener('keydown', on, true);
  return () => {
    target.removeEventListener('pointerdown', on, true);
    target.removeEventListener('keydown', on, true);
  };
}

/**
 * Short click sounds on a private AudioContext (the engine exposes none). Silent
 * where Web Audio is missing. ONE context per sink, opened on the first click (so
 * inside the user's tap, where `resume()` must be called) and reused for every
 * count; `close()` releases it on unmount, so no more than one is ever alive.
 */
export function createClickSink(): ClickSink {
  let ctx: AudioContext | null = null;
  let live: OscillatorNode[] = [];
  const open = (): AudioContext | null => {
    if (ctx) return ctx;
    const w = globalThis as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      ctx = null;
    }
    return ctx;
  };
  return {
    schedule(offsetSec, accent) {
      const c = open();
      if (!c) return;
      try {
        if (c.state === 'suspended') void Promise.resolve(c.resume()).catch(() => {});
        const t = c.currentTime + CLICK_LEAD_SEC + offsetSec;
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.frequency.value = accent ? 1600 : 1100;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.4, t + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        osc.connect(gain);
        gain.connect(c.destination);
        osc.start(t);
        osc.stop(t + 0.06);
        live.push(osc);
        osc.onended = () => {
          live = live.filter((o) => o !== osc);
        };
      } catch {
        /* a click that cannot play is not worth failing the count */
      }
    },
    stop() {
      for (const o of live.splice(0)) {
        try {
          o.stop();
        } catch {
          /* already ended */
        }
      }
    },
    close() {
      this.stop();
      const c = ctx;
      ctx = null;
      if (!c) return;
      try {
        void Promise.resolve(c.close()).catch(() => {});
      } catch {
        /* already closed */
      }
    },
    latencySec() {
      const c = ctx as (AudioContext & { outputLatency?: number }) | null;
      return c ? lat(c.outputLatency ?? c.baseLatency) : 0;
    },
  };
}
