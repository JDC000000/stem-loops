/**
 * Story 8 — keep the player sounding when a phone's screen sleeps or the user
 * switches apps, and give it lock-screen controls.
 *
 * Four independent pieces, each a no-op where its API is missing, so a browser
 * that has none of them gets exactly the player it had before:
 *
 *  1. OUTPUT ROUTE (`createBackgroundOutput`). Web Audio played straight to
 *     `ctx.destination` is not "media" to iOS or Android: when the screen locks
 *     or the tab is hidden the OS is free to suspend it, and there is no
 *     lock-screen entry. Routing the mix into a MediaStreamAudioDestinationNode
 *     and playing that stream through an `<audio playsinline>` element makes
 *     it a playing media element, which is what both platforms keep alive and
 *     attach media controls to. The engine's six GainNodes connect to ONE bus
 *     GainNode here; the bus feeds the stream. If the element refuses to play
 *     (autoplay policy, an engine with no MediaStream support), the bus is
 *     re-pointed at `ctx.destination` on the spot, so a failure of this route
 *     can only ever cost background playback, never sound.
 *
 *  2. AUDIO SESSION (`setPlaybackAudioSession`). Safari 16.4+ exposes
 *     `navigator.audioSession`; type 'playback' tells iOS this is music (plays
 *     with the ring/silent switch on, and is allowed to continue in the
 *     background) rather than ambient UI sound.
 *
 *  3. MEDIA SESSION (`wireMediaSession`). Title/artwork for the lock screen and
 *     notification shade, play/pause/stop/seek handlers routed to the SAME
 *     callbacks the on-screen transport uses, and `setPositionState` so the
 *     lock-screen scrubber is right. Position pushes are throttled: only on a
 *     status or duration change, or when the position has moved more than
 *     POSITION_DRIFT_SEC away from where steady playback would put it (a seek
 *     or a loop wrap). The OS extrapolates in between.
 *
 *  4. RESUME HOOKS (`wireAudioResume`). iOS moves an AudioContext to
 *     'interrupted' (a call, Siri, another app's audio) and Chrome can suspend
 *     one. On visibilitychange → visible, pageshow, focus, and on any tap, we
 *     ask the engine to resume. The engine clock is frozen while the context is
 *     not running, and every stem is scheduled on that clock, so the six stems
 *     come back sample-locked where they stopped.
 *
 * WHAT THIS CANNOT PROMISE, stated so nobody quotes more than is known: none of
 * the above has been run on a real iPhone or Android phone. The approach is the
 * best-known one for Web Audio in the background, and each API is used as its
 * spec describes, but whether a given OS version keeps a MediaStream-backed
 * element alive with the screen off is decided by that OS. See the PR body.
 *
 * Pure of React and of globals at import time; every browser object is passed
 * in, so the whole module is testable with fakes under node:test.
 */

// ─── 1. output route ─────────────────────────────────────────────────────────

/** The parts of HTMLAudioElement this module touches. */
export interface AudioElementLike {
  srcObject: unknown;
  playsInline?: boolean;
  autoplay?: boolean;
  readonly paused?: boolean;
  play(): Promise<void> | void;
  pause(): void;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  load?(): void;
  addEventListener?(type: string, cb: () => void): void;
  removeEventListener?(type: string, cb: () => void): void;
}

export interface DocumentLike {
  createElement?(tag: 'audio'): AudioElementLike;
}

export interface BackgroundOutput {
  /** Pass to the engine as `createOutput`. Builds the bus and the stream route. */
  readonly createOutput: (ctx: AudioContext) => AudioNode;
  /**
   * Start the element. Call SYNCHRONOUSLY inside the user's tap, BEFORE
   * `engine.play()`: iOS only lets media start from a gesture.
   */
  play(): void;
  /** Pause the element (the engine is paused separately). */
  pause(): void;
  /** If we want to be playing and the element is not, start it again. */
  ensurePlaying(): void;
  /** True while the mix is going through the `<audio>` element. */
  readonly routed: boolean;
  dispose(): void;
}

export interface BackgroundOutputOptions {
  /**
   * The OS (not us) paused the element: another app took audio focus, a
   * headset was unplugged. The caller should pause the engine so the screen
   * tells the truth.
   */
  readonly onExternalPause?: () => void;
}

interface StreamCapableContext {
  readonly destination: AudioNode;
  createGain(): GainNode;
  createMediaStreamDestination?(): { readonly stream: unknown } & AudioNode;
}

export function createBackgroundOutput(
  doc: DocumentLike | null | undefined,
  opts: BackgroundOutputOptions = {},
): BackgroundOutput {
  let element: AudioElementLike | null = null;
  let bus: GainNode | null = null;
  let destination: AudioNode | null = null;
  let streamDest: AudioNode | null = null;
  let routed = false;
  let want = false;
  /** Set while WE are pausing the element, so its 'pause' event is not "external". */
  let selfPausing = false;
  let disposed = false;

  const onElementPause = () => {
    if (selfPausing || disposed || !want) return;
    want = false;
    opts.onExternalPause?.();
  };

  /** Point the bus at the speakers directly. Sound over background playback, always. */
  const fallBack = () => {
    if (!bus || !destination || !routed) return;
    try {
      bus.disconnect();
    } catch {
      /* not connected */
    }
    try {
      bus.connect(destination);
    } catch {
      /* nothing more to try */
    }
    routed = false;
  };

  const startElement = () => {
    if (!element || !routed) return;
    let p: Promise<void> | void;
    try {
      p = element.play();
    } catch {
      fallBack();
      return;
    }
    if (p && typeof (p as Promise<void>).then === 'function') {
      (p as Promise<void>).then(undefined, (e: unknown) => {
        // AbortError means a pause() overtook this play(): not a refusal.
        if ((e as { name?: string } | null)?.name === 'AbortError') return;
        fallBack();
      });
    }
  };

  return {
    createOutput(ctx: AudioContext): AudioNode {
      const c = ctx as unknown as StreamCapableContext;
      destination = c.destination;
      bus = c.createGain();
      const el = typeof doc?.createElement === 'function' ? doc.createElement('audio') : null;
      if (!el || typeof c.createMediaStreamDestination !== 'function') {
        bus.connect(destination);
        return bus;
      }
      try {
        const dest = c.createMediaStreamDestination();
        bus.connect(dest);
        el.playsInline = true;
        el.setAttribute?.('playsinline', '');
        el.autoplay = false;
        el.srcObject = dest.stream;
        el.addEventListener?.('pause', onElementPause);
        element = el;
        streamDest = dest;
        routed = true;
      } catch {
        try {
          bus.disconnect();
        } catch {
          /* ignore */
        }
        bus.connect(destination);
        routed = false;
      }
      return bus;
    },
    play() {
      if (disposed) return;
      want = true;
      startElement();
    },
    pause() {
      want = false;
      if (!element || !routed) return;
      selfPausing = true;
      try {
        element.pause();
      } catch {
        /* ignore */
      } finally {
        selfPausing = false;
      }
    },
    ensurePlaying() {
      if (disposed || !want || !element || !routed) return;
      if (element.paused === false) return;
      startElement();
    },
    get routed() {
      return routed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      want = false;
      if (element) {
        element.removeEventListener?.('pause', onElementPause);
        selfPausing = true;
        try {
          element.pause();
        } catch {
          /* ignore */
        }
        selfPausing = false;
        try {
          element.srcObject = null;
        } catch {
          /* ignore */
        }
      }
      for (const n of [bus, streamDest]) {
        try {
          n?.disconnect();
        } catch {
          /* ignore */
        }
      }
      element = null;
      bus = null;
      streamDest = null;
      routed = false;
    },
  };
}

// ─── 1b. chord-clock compensation for the route ─────────────────────────────

/**
 * Extra delay the MediaStream → `<audio>` hop adds before the element's own
 * sink, in seconds. MEASURED in Chromium (scripts/perf/mobile-player/latency.mjs,
 * docs/perf/mobile-player-2026-11-14.md "Chord sync on the phone route"):
 * a click rendered by the 24 kHz player context reached a second context
 * through the same MediaStream 10-31 ms later, median ~17-20 ms over 40 reps.
 * Used as the default because no API reports it. iOS/WebKit: NOT measured.
 */
export const ROUTE_TRANSPORT_LATENCY_SEC = 0.018;

/** Any estimate above this is treated as nonsense and capped. */
export const MAX_ROUTE_LATENCY_SEC = 0.5;

export interface LatencySource {
  readonly outputLatency?: number;
  readonly baseLatency?: number;
}

/**
 * How far the chord clock (the AudioContext's render time) runs AHEAD of what
 * the listener hears on the phone route: the measured MediaStream hop plus the
 * output sink's latency. The element's sink latency is not exposed to JS, so the
 * context's own `outputLatency` (same device, same output) stands in for it,
 * falling back to `baseLatency`, then to nothing. `routed: false` (desktop, or a
 * route that fell back to ctx.destination) is 0: desktop is unchanged.
 */
export function routeLatencySec(src: LatencySource | null | undefined, routed: boolean): number {
  if (!routed) return 0;
  const pos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const sink = pos(src?.outputLatency) ? src!.outputLatency! : pos(src?.baseLatency) ? src!.baseLatency! : 0;
  return Math.min(ROUTE_TRANSPORT_LATENCY_SEC + sink, MAX_ROUTE_LATENCY_SEC);
}

// ─── 2. audio session ────────────────────────────────────────────────────────

/** Safari 16.4+: mark this page's audio as music playback. Returns whether it was set. */
export function setPlaybackAudioSession(nav: unknown): boolean {
  const session = (nav as { audioSession?: { type?: string } } | null | undefined)?.audioSession;
  if (!session || typeof session !== 'object') return false;
  try {
    session.type = 'playback';
    return session.type === 'playback';
  } catch {
    return false;
  }
}

// ─── 3. media session ────────────────────────────────────────────────────────

/** Seek step for the lock-screen ±seek buttons when the OS does not say. */
export const DEFAULT_SEEK_STEP_SEC = 10;
/** A position this far from where steady playback would put it is pushed to the OS. */
export const POSITION_DRIFT_SEC = 0.75;

export const MEDIA_SESSION_ACTIONS = [
  'play',
  'pause',
  'stop',
  'seekto',
  'seekbackward',
  'seekforward',
] as const;
type Action = (typeof MEDIA_SESSION_ACTIONS)[number];

interface ActionDetails {
  readonly seekTime?: number;
  readonly seekOffset?: number;
}

export interface MediaSessionLike {
  metadata: unknown;
  playbackState?: string;
  setActionHandler(action: string, handler: ((d: ActionDetails) => void) | null): void;
  setPositionState?(state?: { duration: number; position: number; playbackRate: number }): void;
}

export interface MediaSessionScope {
  readonly navigator?: { readonly mediaSession?: MediaSessionLike };
  readonly MediaMetadata?: new (init: Record<string, unknown>) => unknown;
}

/** The slice of an engine snapshot the media session reads. */
export interface MediaSnapshot {
  readonly status: string;
  readonly positionSec: number;
  readonly durationSec: number;
  /** Phase C C1: song-seconds per second (1, 0.9, 0.75). Absent = 1. */
  readonly playbackRate?: number;
}

export interface MediaSessionOptions {
  readonly title: string;
  readonly artist?: string;
  readonly artworkUrl?: string;
  readonly onPlay: () => void;
  readonly onPause: () => void;
  readonly onSeek: (positionSec: number) => void;
  /** Current position, for relative seeks. */
  readonly getPosition: () => number;
  readonly getDuration: () => number;
  /** Milliseconds clock; injected for tests. */
  readonly now?: () => number;
}

export interface MediaSessionWiring {
  update(s: MediaSnapshot): void;
  dispose(): void;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function playbackStateFor(status: string): 'playing' | 'paused' | 'none' {
  if (status === 'playing') return 'playing';
  if (status === 'ready' || status === 'ended') return 'paused';
  return 'none';
}

/** `null` where the Media Session API is absent. Never throws. */
export function wireMediaSession(
  scope: MediaSessionScope | null | undefined,
  opts: MediaSessionOptions,
): MediaSessionWiring | null {
  const ms = scope?.navigator?.mediaSession;
  if (!ms || typeof ms.setActionHandler !== 'function') return null;
  const now = opts.now ?? (() => Date.now());

  try {
    const Meta = scope?.MediaMetadata;
    if (typeof Meta === 'function') {
      ms.metadata = new Meta({
        title: opts.title,
        artist: opts.artist ?? '',
        album: 'Play along',
        artwork: opts.artworkUrl ? [{ src: opts.artworkUrl, sizes: '180x180', type: 'image/png' }] : [],
      });
    }
  } catch {
    /* metadata is cosmetic */
  }

  const clampToTrack = (t: number) => {
    const d = opts.getDuration();
    if (!finite(d) || d <= 0) return Math.max(0, t);
    return Math.min(Math.max(0, t), d);
  };
  const handlers: Record<Action, (d: ActionDetails) => void> = {
    play: () => opts.onPlay(),
    pause: () => opts.onPause(),
    stop: () => opts.onPause(),
    seekto: (d) => {
      if (finite(d?.seekTime)) opts.onSeek(clampToTrack(d.seekTime));
    },
    seekbackward: (d) =>
      opts.onSeek(clampToTrack(opts.getPosition() - (finite(d?.seekOffset) ? d.seekOffset : DEFAULT_SEEK_STEP_SEC))),
    seekforward: (d) =>
      opts.onSeek(clampToTrack(opts.getPosition() + (finite(d?.seekOffset) ? d.seekOffset : DEFAULT_SEEK_STEP_SEC))),
  };
  const installed: Action[] = [];
  for (const a of MEDIA_SESSION_ACTIONS) {
    try {
      ms.setActionHandler(a, handlers[a]);
      installed.push(a);
    } catch {
      /* the browser does not know this action; skip it */
    }
  }

  let last: { status: string; duration: number; position: number; at: number; rate: number } | null = null;
  let disposed = false;

  return {
    update(s) {
      if (disposed || !s) return;
      const state = playbackStateFor(s.status);
      const duration = finite(s.durationSec) ? s.durationSec : 0;
      const position = finite(s.positionSec) ? Math.min(Math.max(0, s.positionSec), duration) : 0;
      // Phase C C1: the speed, so the lock screen advances at the right pace.
      const rate = finite(s.playbackRate) && s.playbackRate > 0 ? s.playbackRate : 1;
      const t = now();
      let push = !last || last.status !== s.status || last.duration !== duration || last.rate !== rate;
      if (!push && last) {
        const expected = last.position + (last.status === 'playing' ? ((t - last.at) / 1000) * last.rate : 0);
        push = Math.abs(position - expected) > POSITION_DRIFT_SEC;
      }
      if (!push) return;
      last = { status: s.status, duration, position, at: t, rate };
      try {
        ms.playbackState = state;
      } catch {
        /* ignore */
      }
      if (typeof ms.setPositionState !== 'function') return;
      try {
        if (duration > 0) ms.setPositionState({ duration, position, playbackRate: rate });
        else ms.setPositionState();
      } catch {
        /* a browser that rejects the state keeps its own */
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const a of installed) {
        try {
          ms.setActionHandler(a, null);
        } catch {
          /* ignore */
        }
      }
      try {
        ms.metadata = null;
        ms.playbackState = 'none';
        ms.setPositionState?.();
      } catch {
        /* ignore */
      }
    },
  };
}

// ─── 4. resume hooks ─────────────────────────────────────────────────────────

interface EventTargetLike {
  addEventListener?(type: string, cb: () => void, opts?: unknown): void;
  removeEventListener?(type: string, cb: () => void, opts?: unknown): void;
}

export interface ResumeScope {
  readonly document?: EventTargetLike & { readonly visibilityState?: string };
  readonly window?: EventTargetLike;
}

/** Events on `document` that mean "the user is here again". */
export const RESUME_DOC_EVENTS = ['visibilitychange', 'pointerdown', 'touchend'] as const;
/** Events on `window` that mean the same. */
export const RESUME_WIN_EVENTS = ['pageshow', 'focus'] as const;

/** Calls `resume` whenever the page is (again) visible or touched. Returns a disposer. */
export function wireAudioResume(scope: ResumeScope | null | undefined, resume: () => void): () => void {
  const doc = scope?.document;
  const win = scope?.window;
  const onDoc = () => {
    if (doc?.visibilityState === 'hidden') return;
    resume();
  };
  const onWin = () => resume();
  const listen = { capture: true, passive: true };
  for (const e of RESUME_DOC_EVENTS) doc?.addEventListener?.(e, onDoc, listen);
  for (const e of RESUME_WIN_EVENTS) win?.addEventListener?.(e, onWin, listen);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    for (const e of RESUME_DOC_EVENTS) doc?.removeEventListener?.(e, onDoc, listen);
    for (const e of RESUME_WIN_EVENTS) win?.removeEventListener?.(e, onWin, listen);
  };
}
