/**
 * Story 8.3 — should this device be offered the six-stem player at all?
 *
 * The player decodes six whole stems into memory before a note plays. In
 * desktop Chromium that is 329 MiB of PCM and a renderer high-water mark of
 * ~720-760 MiB at the 300 s ceiling, which the copy rounds to "more than
 * 700 MB" (see MEMORY in ./engine.ts and
 * docs/perf/mobile-player-2026-11-14.md). Nobody has measured a real phone,
 * and phone browsers discard tabs far more readily than desktop ones, so until
 * someone does, phones get a designed "not yet" state instead of a load that
 * may crash the tab. User stories v3.1, Story 8.3; launch scope for the player
 * is Chrome on a desktop or laptop.
 *
 * ── THE RULE (first match wins) ──────────────────────────────────────────────
 *
 *   1. `navigator.userAgentData.mobile === true`               → 'mobile'
 *      Chromium's own client hint. Present on Chrome for Android; absent on
 *      Safari and Firefox, which is why it cannot be the only test.
 *   2. Touch-only input: `(pointer: coarse)` matches AND
 *      `(any-pointer: fine)` does not                           → 'touch-only'
 *      Every phone, and a tablet with no trackpad or mouse attached. A touch
 *      LAPTOP is not caught: its trackpad is a fine pointer. An iPad with a
 *      keyboard-trackpad is not caught either, which is deliberate — that is
 *      as close to a laptop as a tablet gets, and a block it cannot argue with
 *      would be worse than a load that might fail.
 *   3. `navigator.deviceMemory` reported and below 4 (GB)        → 'low-memory'
 *      The measured peak is ~0.75 GiB in one renderer. Chromium buckets and
 *      caps this value (0.25 … 8), so only the low end is trustworthy; a
 *      missing value means "unknown", never "low".
 *
 *   Fallback when `matchMedia` does not exist (very old engines): touch points
 *   present AND the screen's short side under 600 CSS px → 'touch-only'.
 *
 * ── WHAT IS DELIBERATELY NOT A SIGNAL ────────────────────────────────────────
 *
 *   - VIEWPORT WIDTH ALONE. A narrow desktop window is still a desktop with
 *     desktop memory. Width is a layout fact, handled in CSS; it says nothing
 *     about whether six stems fit in memory. It is used only in the
 *     no-matchMedia fallback above, and only together with touch.
 *   - THE USER-AGENT STRING. iPadOS reports a desktop Safari UA, Android UA
 *     reduction freezes the model, and UA sniffing is the thing the web
 *     platform has spent a decade telling everyone to stop doing.
 *
 * ── THE OVERRIDE ─────────────────────────────────────────────────────────────
 *
 * `?player=force` on the job URL skips this check (never the Web Audio check).
 * It exists so the 8.3 question can be ANSWERED: someone with a real phone and
 * chrome://inspect can load the player and record what happens. It is not
 * linked from any UI.
 */

export type DeviceBlockReason = 'mobile' | 'touch-only' | 'low-memory';

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

/** Below this many GB of reported device memory, the player is not offered. */
export const MIN_DEVICE_MEMORY_GB = 4;

/** Only used when matchMedia is missing: a touch screen this narrow is a phone. */
export const FALLBACK_PHONE_SHORT_SIDE_PX = 600;

/** The query-string switch that skips the device check. */
export const FORCE_PLAYER_PARAM = 'player';
export const FORCE_PLAYER_VALUE = 'force';

/**
 * The rule. Pure: give it signals, get a reason or `null` (= offer the player).
 * Unknown signals never block — the cost of a wrong block (a desktop user
 * locked out of the product) is higher than the cost of a wrong pass (a load
 * that may fail and then shows the engine's own error).
 */
export function deviceBlockReason(s: DeviceSignals | null | undefined): DeviceBlockReason | null {
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

/** True when the URL carries `?player=force`. */
export function playerForced(search: string | null | undefined): boolean {
  if (!search) return false;
  try {
    return new URLSearchParams(search).get(FORCE_PLAYER_PARAM) === FORCE_PLAYER_VALUE;
  } catch {
    return false;
  }
}

// ─── copy (brand book v2.2 §3: sentence case, "play along" as the noun) ─────

export const DEVICE_UNSUPPORTED_TITLE = 'Play along needs a desktop or laptop for now';

/**
 * One body per reason, because the honest cause differs. Every one names the
 * next step (Chrome on a desktop or laptop) and says "not yet", never "never".
 */
export const DEVICE_UNSUPPORTED_BODY: Record<DeviceBlockReason, string> = {
  mobile:
    'The player loads all six stems into memory at once, which takes more than 700 MB for a 5-minute song, ' +
    'and phone browsers can close a tab that uses that much. We have not tested it on phones yet. ' +
    'Open this page in Chrome on a desktop or laptop to play along.',
  'touch-only':
    'The player loads all six stems into memory at once, which takes more than 700 MB for a 5-minute song, ' +
    'and phone and tablet browsers can close a tab that uses that much. We have not tested it on ' +
    'them yet. Open this page in Chrome on a desktop or laptop to play along.',
  'low-memory':
    'The player loads all six stems into memory at once, which takes more than 700 MB for a 5-minute song, ' +
    'and this device reports too little memory to load that safely. ' +
    'Open this page in Chrome on a desktop or laptop with more memory to play along.',
};

export const DEVICE_UNSUPPORTED_STILL_WORKS =
  'The chord track below still works here, and so do your job history and account.';

export const COPY_LINK_LABEL = 'Copy the link';
export const COPY_LINK_DONE = 'Link copied';
export const COPY_LINK_FAILED = 'Copy the address from your browser’s address bar instead.';
