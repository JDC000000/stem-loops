/**
 * Story 8 — how should THIS device run the six-stem player?
 *
 * History: PR #276 used the rule below to BLOCK phones, touch-only tablets and
 * low-memory devices with a "Play along needs a desktop or laptop" card. That
 * was wrong (Jon, 2026-11-15): it locked him out on his phone for two songs
 * under five minutes. Nothing is blocked now except a browser with no Web Audio
 * at all (`hasWebAudio` in Player.tsx). The same rule instead picks a LIGHTER
 * decode so the load fits in a phone's memory, and the media-element output
 * route that lets audio keep playing when the screen sleeps.
 *
 * ── WHY A LIGHTER DECODE ─────────────────────────────────────────────────────
 *
 * The player decodes six whole stems before a note plays. At 48 kHz mono and
 * the 300 s ceiling that is 329.6 MiB of PCM and a measured renderer peak of
 * ~720 MiB in desktop Chromium (docs/perf/mobile-player-2026-11-14.md). Phone
 * browsers discard tabs far more readily. Decoding at LIGHT_DECODE_SAMPLE_RATE
 * instead halves the PCM and, measured in the same harness, brings the peak
 * well under 700 MiB — see that doc's 2026-11-15 section for the numbers.
 * Every stem is decoded at the same rate, so sample-lock is unchanged: all six
 * buffers share one rate, one `when` and one `offset`.
 *
 * ── THE RULE (first match wins) — unchanged from #276 ────────────────────────
 *
 *   1. `navigator.userAgentData.mobile === true`               → 'mobile'
 *      Chromium's own client hint. Present on Chrome for Android; absent on
 *      Safari and Firefox, which is why it cannot be the only test.
 *   2. Touch-only input: `(pointer: coarse)` matches AND
 *      `(any-pointer: fine)` does not                           → 'touch-only'
 *      Every phone (including iPhone Safari), and a tablet with no trackpad or
 *      mouse. A touch LAPTOP is not caught: its trackpad is a fine pointer. An
 *      iPad with a keyboard-trackpad is not caught either; it gets the desktop
 *      decode, as before.
 *   3. `navigator.deviceMemory` reported and below 4 (GB)        → 'low-memory'
 *      Chromium buckets and caps this value (0.25 … 8), so only the low end is
 *      trustworthy; a missing value means "unknown", never "low".
 *
 *   Fallback when `matchMedia` does not exist (very old engines): touch points
 *   present AND the screen's short side under 600 CSS px → 'touch-only'.
 *
 * Any match → light decode + background-capable output. No match → the desktop
 * path, byte-for-byte what shipped before (48 kHz, `ctx.destination`).
 *
 * ── WHAT IS DELIBERATELY NOT A SIGNAL ────────────────────────────────────────
 *
 *   - VIEWPORT WIDTH ALONE. A narrow desktop window is still a desktop with
 *     desktop memory; it keeps full-quality audio.
 *   - THE USER-AGENT STRING. iPadOS reports a desktop Safari UA, Android UA
 *     reduction freezes the model, and UA sniffing is what the platform has
 *     spent a decade telling everyone to stop doing.
 *
 * ── `?player=force` ──────────────────────────────────────────────────────────
 *
 * Removed. It existed only to skip the block, and there is no block.
 */

import { PLAYBACK_SAMPLE_RATE } from './types.ts';

export type ConstrainedReason = 'mobile' | 'touch-only' | 'low-memory';

export interface DeviceSignals {
  /** `navigator.userAgentData?.mobile`; undefined where the API is absent. */
  readonly uaDataMobile?: boolean;
  /** `matchMedia('(pointer: coarse)').matches`; undefined without matchMedia. */
  readonly coarsePointer?: boolean;
  /** `matchMedia('(any-pointer: fine)').matches`; undefined without matchMedia. */
  readonly anyFinePointer?: boolean;
  /** `navigator.deviceMemory` in GB; undefined where the API is absent. */
  readonly deviceMemoryGb?: number;
  /** `navigator.maxTouchPoints`. */
  readonly maxTouchPoints?: number;
  /** min(screen.width, screen.height) in CSS px. */
  readonly screenShortSide?: number;
}

/** Below this many GB of reported device memory, the light decode is used. */
export const MIN_DEVICE_MEMORY_GB = 4;

/** Only used when matchMedia is missing: a touch screen this narrow is a phone. */
export const FALLBACK_PHONE_SHORT_SIDE_PX = 600;

/**
 * Decode rate for constrained devices, in Hz. Mono, like the desktop path.
 *
 * 24 kHz and not 22.05 kHz: both were measured (docs/perf, 2026-11-15) and at
 * 300 s 22.05 kHz bought ~15 MiB of peak at the median, inside run-to-run
 * noise (24 kHz: 562-589 MiB on Pixel 7 emulation; 22.05: 548-575), while 24 kHz
 * keeps audio up to 12 kHz instead of 11 kHz and divides 48 kHz exactly, so the
 * resampler does the simplest possible job. Above it, the cymbals and the air
 * on a vocal are gone, which is audible on good headphones and not on a phone
 * speaker. That is the trade, and it is said in the player's own note.
 */
export const LIGHT_DECODE_SAMPLE_RATE = 24_000;

/**
 * The rule. Pure: give it signals, get a reason or `null` (= desktop path).
 * Unknown signals never select the light path — a wrong pass costs a phone
 * the memory headroom, a wrong match costs a desktop its audio quality, and
 * both are recoverable, unlike the block this replaced.
 */
export function constrainedReason(s: DeviceSignals | null | undefined): ConstrainedReason | null {
  if (!s) return null;
  if (s.uaDataMobile === true) return 'mobile';

  const haveMedia = typeof s.coarsePointer === 'boolean' && typeof s.anyFinePointer === 'boolean';
  if (haveMedia) {
    if (s.coarsePointer && !s.anyFinePointer) return 'touch-only';
  } else if (
    typeof s.maxTouchPoints === 'number' &&
    s.maxTouchPoints > 0 &&
    typeof s.screenShortSide === 'number' &&
    s.screenShortSide > 0 &&
    s.screenShortSide < FALLBACK_PHONE_SHORT_SIDE_PX
  ) {
    return 'touch-only';
  }

  if (
    typeof s.deviceMemoryGb === 'number' &&
    Number.isFinite(s.deviceMemoryGb) &&
    s.deviceMemoryGb > 0 &&
    s.deviceMemoryGb < MIN_DEVICE_MEMORY_GB
  ) {
    return 'low-memory';
  }
  return null;
}

/** How the player should run on this device. */
export interface PlaybackProfile {
  /** Why the device is treated as constrained, or `null` for the desktop path. */
  readonly reason: ConstrainedReason | null;
  /** The AudioContext / decode rate. */
  readonly decodeSampleRate: number;
  /**
   * Route the mix through a MediaStream into an `<audio>` element so playback
   * survives a sleeping screen and an app switch (see background-audio.ts).
   * Desktop keeps `ctx.destination`, unchanged.
   */
  readonly backgroundOutput: boolean;
}

export function playbackProfile(s: DeviceSignals | null | undefined): PlaybackProfile {
  const reason = constrainedReason(s);
  return reason
    ? { reason, decodeSampleRate: LIGHT_DECODE_SAMPLE_RATE, backgroundOutput: true }
    : { reason: null, decodeSampleRate: PLAYBACK_SAMPLE_RATE, backgroundOutput: false };
}

interface BrowserScope {
  readonly navigator?: {
    readonly userAgentData?: { readonly mobile?: unknown };
    readonly deviceMemory?: unknown;
    readonly maxTouchPoints?: unknown;
  };
  readonly matchMedia?: (q: string) => { readonly matches: boolean };
  readonly screen?: { readonly width?: unknown; readonly height?: unknown };
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Read the signals from a browser global. Never throws. */
export function readDeviceSignals(scope: unknown): DeviceSignals {
  const g = (scope ?? {}) as BrowserScope;
  const nav = g.navigator;
  const media = (q: string): boolean | undefined => {
    if (typeof g.matchMedia !== 'function') return undefined;
    try {
      return Boolean(g.matchMedia(q).matches);
    } catch {
      return undefined;
    }
  };
  const w = num(g.screen?.width);
  const h = num(g.screen?.height);
  const mobile = nav?.userAgentData?.mobile;
  return {
    uaDataMobile: typeof mobile === 'boolean' ? mobile : undefined,
    coarsePointer: media('(pointer: coarse)'),
    anyFinePointer: media('(any-pointer: fine)'),
    deviceMemoryGb: num(nav?.deviceMemory),
    maxTouchPoints: num(nav?.maxTouchPoints),
    screenShortSide: w !== undefined && h !== undefined ? Math.min(w, h) : undefined,
  };
}

// ─── copy (brand book v2.2 §3: sentence case, "play along" as the noun) ─────

/**
 * Shown once, as a calm note above the transport, on the light path only. It
 * says what is different and why, and nothing it cannot back up.
 */
export const LIGHT_AUDIO_NOTE =
  'On this device the player loads lighter audio (mono, 24 kHz) so all six stems fit in memory. ' +
  'It can sound a little less bright than on a computer.';
