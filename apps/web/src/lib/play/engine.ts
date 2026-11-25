/**
 * The play-along engine — plain Web Audio implementation of the `PlayEngine`
 * contract in `./types.ts`.
 *
 * Architecture (from the measured spike, `claude/spike-simple-playback-engine`):
 * `decodeAudioData` plus ONE persistent GainNode per stem and ONE
 * AudioBufferSourceNode per stem per playback run. NOT the TSD §3 Variant D
 * design — no SharedArrayBuffer, no WebCodecs, no AudioDecoder, and therefore
 * no COOP/COEP work.
 *
 * ── How each contract invariant is held, structurally ────────────────────────
 *
 * 1. SAMPLE-LOCK. Every stem's source is started with the SAME `when` and the
 *    SAME `offset`, computed once per run in `startVoices()`. `when` is
 *    deliberately in the FUTURE (`currentTime + START_LEAD_SEC`) so that the
 *    few milliseconds spent creating six source nodes cannot smear their start
 *    times — scheduling six `start(0)` calls in a loop would drift by exactly
 *    the node-creation cost. Pause/seek/loop never re-time an individual stem:
 *    they stop ALL voices and start ALL voices from one new (when, offset)
 *    pair, so drift has nowhere to accumulate.
 *
 * 2. NO RESTART ON A MIX CHANGE. `setGain`/`setMute`/`setSolo` touch only the
 *    persistent GainNode's AudioParam. The gain nodes are created once in
 *    `load()` and outlive every start/stop, so a mix change cannot create a
 *    node, cannot stop a source and cannot reseek. While sounding the change
 *    is always an automation curve (`setTargetAtTime`), never a step, so it
 *    cannot click. (A step via `setValueAtTime` is used ONLY when nothing is
 *    sounding, where a step is inaudible by definition.)
 *
 * 3. MONOTONIC POSITION. `positionSec` is derived from the AudioContext clock,
 *    never accumulated, so it cannot run away from the audio. It moves
 *    backwards only across a seek or a loop wrap.
 *
 * 4. SAFE IN ANY STATUS. Every public method begins by establishing what it
 *    needs and returning if it cannot act. There is no state in which a call
 *    throws, including after `dispose()`. A UI never needs a status guard.
 *
 * LOOPING uses the native `AudioBufferSourceNode.loop` with `loopStart`/
 * `loopEnd` rather than a JS-timed re-trigger. That is seamless by
 * construction (sample-exact, gapless, no scheduler jitter) and so is strictly
 * better than the 5 ms crossfade the brief allows as a fallback: all six stems
 * wrap on the same sample because they share one loopStart/loopEnd and one
 * start time.
 *
 * MEMORY. A real job gives six Opus stems of ~151 s, encoded stereo on the
 * wire. 6 × 300 s at 48 kHz STEREO is 659 MiB of Float32 PCM and fails; mono
 * is 329 MiB and ships. So the AudioContext is created AT
 * `PLAYBACK_SAMPLE_RATE` (which makes `decodeAudioData` resample for us) and
 * each decoded buffer is downmixed to mono immediately, one stem at a time,
 * dropping the stereo buffer before the next stem is decoded. Never decode the
 * six in parallel: that would hold six stereo buffers at once, which is the
 * configuration that was measured to fail. (The parallel case is also WebKit
 * bug 227636 — concurrent `decodeAudioData` is what jetsams iOS. The sequential
 * `await`-per-stem loop below is that bug's documented mitigation.)
 *
 * ⚠️ THAT PARAGRAPH USED TO STOP THERE, AND IT WAS INCOMPLETE. Decoding
 * sequentially stops six stereo buffers coexisting; it does NOT stop ONE stereo
 * buffer coexisting with all the monos decoded before it. So `downmixToMono`
 * below sums into the decoded buffer's own channel 0 rather than allocating a
 * second full-length buffer beside the live stereo one, and releases each
 * channel's backing store the moment it is spent.
 *
 * ⚠️ READ THE UNITS AND READ WHICH NUMBER IS WHICH. Everything below is
 * MiB (2²⁰ B) — VmRSS and VmHWM are reported by the kernel in KiB. And there
 * are TWO different measurements here, which earlier versions of this comment
 * ran together:
 *
 *   SAMPLED RSS — /proc read 350 ms after each step of the load. It shows the
 *   structure of the change but it CANNOT see a spike between samples.
 *   HIGH-WATER MARK — VmHWM, reset via /proc/<renderer>/clear_refs=5 just
 *   before the stem loop. This is the real process peak. Use this one.
 *
 * 6 stems, 300 s, 48 kHz mono, renderer process only, real Chromium:
 *
 *   HIGH-WATER MARK (VmHWM)                     BEFORE     AFTER    reps
 *     8 kHz WAV, gc() forced per stem           766-767   656-658    12+12
 *     8 kHz WAV, NO forced gc()                 764-775   658-776     9+13
 *     real Ogg/Opus 48 kHz (production format)  870-871   762-763      3+3
 *
 *   ⚠️ THE MIDDLE ROW IS BIMODAL AND BUYS NOTHING RELIABLY. With no forced
 *   gc() the AFTER arm lands at base level about as often as it lands low —
 *   775, 712, 712, 711, 776, 774 in one six-run block. There is no benefit to
 *   claim on that row; read it as "no reliable benefit without forced GC".
 *   Likely cause is GC scheduling on a shared box, which nobody controls.
 *
 *   SETTLED RSS, once reclaimed                 BEFORE     AFTER
 *     8 kHz WAV source                          480-484   482-484
 *     real Ogg/Opus 48 kHz                      577-578   579-580
 *
 *   SAMPLED RSS, highest sample                 BEFORE     AFTER
 *     8 kHz WAV source                              592       548
 *
 * ⚠️ WHICH PART OF THE CHANGE BOUGHT THAT, measured rather than assumed, by
 * putting three deliberately mis-ordered variants through the same driver
 * (8 kHz WAV, same-turn gc() per stem, interleaved with the real arms in one
 * session):
 *
 *     no release at all (pre-2026-11-11)        766-767 MiB HWM
 *     release, but AFTER the allocation         657-658 MiB HWM
 *     release BEFORE the allocation (shipped)   656-658 MiB HWM
 *
 * So the ~110 MiB is bought by RELEASING EAGERLY AT ALL — not by the order.
 * Once the stores are handed back on the spot, the high-water moment moves
 * inside `decodeAudioData`, which is above every downmix variant, so the
 * ordering stops being visible in VmHWM.
 *
 * ⚠️ AND THE ~110 MiB IS CONDITIONAL. IT IS NOT A FIXED SAVING. What the
 * base arm pays for is the PREVIOUS stem's stereo buffer still being resident
 * when the next decode runs — so the figure is entirely a question of whether
 * the collector has got to it yet. One extra `gc()` is the whole difference:
 *
 *                               gc() in the SAME turn   gc() after a YIELD
 *     no release (base)                 766 MiB               656 MiB
 *     release (shipped)                 657 MiB               657 MiB
 *
 * A same-turn `gc()` cannot collect the buffer: the async frame and the
 * pending promise result still pin it. Give the collector a turn of its own
 * and base reaches the shipped figure on its own. The per-stem RSS trace says
 * the same thing — 316/371/427/482/538/593 when each stereo is still resident,
 * 207/262/317/372/427/482 once it is not.
 *
 * SO STATE THE BENEFIT PRECISELY, because the honest version is the useful
 * one: against a lazy collector the release is worth ~110 MiB; against an
 * eager one it is worth nothing; under real GC timing it is somewhere in
 * 0..110 MiB and nobody gets to choose. What the change reliably buys is that
 * the answer STOPS DEPENDING ON GC TIMING AT ALL — 657 in both columns. That
 * is the durable property, and it is the same property WebKit bug 189337
 * makes valuable on iOS, where the collector is the one that lags.
 *
 * The order still earns its place, and it is worth being exact about what it
 * earns: it holds SEVEN whole-track buffers live at the busiest instant
 * instead of eight — one whole-track buffer, 57,600,000 B, less live PCM —
 * which is what the sampled figures 592 -> 548 are showing. On this box that
 * does not convert into a lower process peak, under either GC schedule. On an
 * engine or device whose decode transient is smaller —
 * where the downmix instant IS the peak — it would. That last sentence is a
 * hypothesis; nobody has measured it.
 *
 * ⚠️ THE ~600 BAR IS NOT MET, BEFORE OR AFTER. The high-water mark is 656+
 * MiB on the synthetic source and 762+ MiB on the production Opus one. This
 * change lowers it by up to ~110 MiB (see the GC-timing table above — the
 * figure is 0..110 depending on the collector) and does not bring it under the
 * bar in any configuration measured. Anyone
 * quoting 548, or quoting the settled figure, is quoting a number that is not
 * the process peak — which is the mistake this comment exists to stop.
 *
 * WHAT STILL SETS THE MARK IS `decodeAudioData` ITSELF, not the downmix:
 * after this change the high-water mark still sits ~174 MiB above settled on
 * the WAV path (657-483) and ~183 MiB on the Opus one (762-579), and no part
 * of either is the mono buffer. Reducing it means changing how the
 * decode happens, which is a separate piece of work nobody has scoped.
 *
 * The peak happens during LOAD, before a note plays: a device that survives
 * steady-state playback can still die loading.
 *
 * PHONES (2026-11-15). Everything above is the DESKTOP path, 48 kHz. Phones,
 * touch-only tablets and low-memory devices pass `decodeSampleRate` =
 * `LIGHT_DECODE_SAMPLE_RATE` (24 kHz, device-support.ts), which creates the
 * context at that rate so `decodeAudioData` resamples every stem to it. That
 * halves the PCM and lowers the load peak; the measured figures are in
 * docs/perf/mobile-player-2026-11-14.md (2026-11-15 section). The downmix and
 * the eager release below are unchanged and apply on both paths.
 *
 * MEASUREMENT CAVEATS, because they bound what the table above licenses: one
 * headless Chromium on one Linux box; the Opus run holds all six encoded
 * buffers resident at once, which is what `load()` really does but which also
 * raises its settled figure; the no-forced-gc() row is bimodal rather than
 * merely noisy, which is why no benefit is claimed on it; and nothing here was
 * measured on WebKit or on a real device.
 *
 * What is left in the downmix — one stereo buffer alive beside five monos at
 * the last decode — is the LIVE-PCM floor for this architecture:
 * `decodeAudioData` gives us a stereo buffer and there is no API that asks it
 * not to. It is a floor on PCM, not a prediction of VmHWM, which the table
 * above shows is far higher.
 *
 * WHY EAGER RELEASE AND NOT JUST DROPPING THE REFERENCE. Handing the store
 * back is not the same as making it collectable, and the gap between the two
 * is exactly as wide as the collector's lag. A forced `gc()` in the SAME turn
 * did not get that memory back (766); a `gc()` after a yield did (656); an
 * explicit transfer-detach gets it back either way (657). Production forces
 * neither, so the lag is whatever the engine decides that day — and on iOS,
 * WebKit bug 189337 (open since 2018) can make it ~a minute. `load()` is
 * re-runnable by
 * design via `loadId`, so a failed load plus a user retry could otherwise
 * stack two generations of PCM on exactly the path taken when memory is
 * already tight.
 */

import {
  MAX_TRACK_SEC,
  PLAYABLE_STEMS,
  PLAYBACK_CHANNELS,
  PLAYBACK_SAMPLE_RATE,
  type EngineSnapshot,
  type LoopRegion,
  type PlayEngine,
  type StemAvailability,
  type StemName,
  type StemSource,
  type StemState,
  type TransportStatus,
} from './types.ts';

/** Seconds of lead time given to a scheduled start, so all six land together. */
const START_LEAD_SEC = 0.05;
/** Click-free fade in/out at a start or stop, in seconds. */
const FADE_SEC = 0.005;
/** Time constant for `setTargetAtTime` on a live mix change. */
const FADE_TC = 0.012;
/** How long after the fade-out a stopped source is actually stopped. */
const STOP_LAG_SEC = FADE_SEC + 0.01;
/**
 * Position changes smaller than this do not produce a new snapshot object.
 * Snapshot identity therefore stays stable within a frame, which is what
 * `useSyncExternalStore` requires of a clock-derived snapshot.
 */
const POSITION_EPSILON_SEC = 0.01;
/** Shortest loop region we will honour. Shorter is a click, not a loop. */
const MIN_LOOP_SEC = 0.05;

export const ENGINE_ERROR = {
  /** No AudioContext constructor (SSR, or a browser without Web Audio). */
  NO_AUDIO: 'PLAY_NO_AUDIO',
  /** `load()` was given nothing we could use. */
  NO_STEMS: 'PLAY_NO_STEMS',
  /** Every stem failed to decode. */
  DECODE_FAILED: 'PLAY_DECODE_FAILED',
  /** Longer than `MAX_TRACK_SEC`. Story 1.4 — refuse clearly. */
  TOO_LONG: 'PLAY_TRACK_TOO_LONG',
} as const;

type AudioContextFactory = (options: { sampleRate: number }) => AudioContext;

/**
 * Where the mix goes. Called ONCE per AudioContext, the first time `load()`
 * creates one; every stem's GainNode connects to the node it returns. Default
 * is `ctx.destination`, which is what the desktop path has always used.
 *
 * The phone path (background-audio.ts) returns a bus that feeds a
 * MediaStreamAudioDestinationNode played by an `<audio>` element, so the
 * operating system treats the player as media and keeps it running when the
 * screen sleeps. Mute, solo, faders, sample-lock and looping are all upstream
 * of this node and do not know which route is in use.
 */
export type OutputFactory = (ctx: AudioContext) => AudioNode;

/** Cancels the frame it was given. */
type FrameCanceller = () => void;

export interface PlayEngineOptions {
  /**
   * Injected for tests — Node has no Web Audio. Must honour `sampleRate`:
   * creating the context at 48 kHz is what makes `decodeAudioData` resample,
   * and the mono downmix below assumes it did.
   */
  readonly createAudioContext?: AudioContextFactory;
  /**
   * Drives the clock that notifies subscribers while playing. Returns a
   * canceller. Defaults to `requestAnimationFrame`, falling back to a 50 ms
   * timer where there is no rAF.
   */
  readonly scheduleFrame?: (cb: () => void) => FrameCanceller;
  /**
   * The AudioContext rate, which is also the rate `decodeAudioData` resamples
   * every stem to. Default `PLAYBACK_SAMPLE_RATE` (48 kHz, the desktop path).
   * Constrained devices pass `LIGHT_DECODE_SAMPLE_RATE` (device-support.ts).
   * One rate for all six stems, so sample-lock is unaffected.
   *
   * If the browser refuses a context at this rate, `load()` retries ONCE at
   * `PLAYBACK_SAMPLE_RATE` rather than failing: full-rate audio that might not
   * fit beats a guaranteed "no audio". Non-finite or non-positive values are
   * ignored (default used).
   */
  readonly decodeSampleRate?: number;
  /** See `OutputFactory`. Default: `ctx.destination`. */
  readonly createOutput?: OutputFactory;
  /**
   * Phase C C1 (Beta): pitch-kept slow-down. Absent: `setPlaybackRate` only
   * ever accepts 1. See `StretchProvider` and stretch.ts.
   */
  readonly stretch?: StretchProvider;
}

/**
 * The speeds the player offers (Phase C C1). 50% is deliberately NOT here: in
 * the C0 spike the per-stem SoundTouch path overran the CPU budget and glitched
 * at 50% (decision record 2026-11-23). Anything not in this list is refused.
 */
export const PLAYBACK_RATES = [1, 0.9, 0.75] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];
export const isPlaybackRate = (r: unknown): r is PlaybackRate =>
  typeof r === 'number' && (PLAYBACK_RATES as readonly number[]).includes(r);

/** A pitch-preserving stretch node (the SoundTouch worklet contract). */
export interface StretchNode extends AudioNode {
  /**
   * Set to the same rate as the source's own `playbackRate`; the node uses it
   * to undo the pitch drop that the slower source causes.
   */
  readonly playbackRate: AudioParam;
}

/**
 * Builds the per-stem stretch nodes. Injected so Node tests can run the real
 * engine with fakes; the browser one is `soundTouchStretch()` (stretch.ts).
 */
export interface StretchProvider {
  /** Load the worklet module into `ctx`. Called once per context. */
  register(ctx: AudioContext): Promise<void>;
  /** One node. Called exactly once per stem per engine (gate G1). */
  create(ctx: AudioContext): StretchNode;
  /**
   * Resolves once the node's processor is running on the render thread. A node
   * that is still being instantiated discards input, and six of them doing so
   * by different amounts was the C0 review's 100–123 ms start-up skew.
   */
  ready?(node: StretchNode): Promise<void>;
  /**
   * Seconds from a sample entering the node to it being heard out of it, at
   * `rate`. Measured and pinned per rate (gate G2); 0 at rate 1.
   */
  latencySec(rate: number): number;
  /** Release a node for good (close its port). Called from `dispose()`. */
  release?(node: StretchNode): void;
}

/**
 * Extra time after the stretch pipeline's latency before its previous content
 * is treated as drained. The pipeline is fed silence while no stem plays
 * through it, so the old run leaves it within its latency; this is margin.
 */
const STRETCH_DRAIN_MARGIN_SEC = 0.03;

interface MutableStem {
  availability: StemAvailability;
  gain: number;
  muted: boolean;
  soloed: boolean;
}

const IDLE_SNAPSHOT: EngineSnapshot = Object.freeze({
  status: 'idle' as TransportStatus,
  positionSec: 0,
  durationSec: 0,
  stems: Object.freeze([]) as readonly StemState[],
  loop: null,
  degraded: null,
  error: null,
});

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const defaultCreateAudioContext: AudioContextFactory = (options) => {
  const w = globalThis as unknown as {
    AudioContext?: new (o?: AudioContextOptions) => AudioContext;
    webkitAudioContext?: new (o?: AudioContextOptions) => AudioContext;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio is unavailable');
  return new Ctor({ sampleRate: options.sampleRate });
};

const defaultScheduleFrame: (cb: () => void) => FrameCanceller = (cb) => {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (c: () => void) => number;
    cancelAnimationFrame?: (h: number) => void;
  };
  if (typeof g.requestAnimationFrame === 'function') {
    const h = g.requestAnimationFrame(cb);
    return () => g.cancelAnimationFrame?.(h);
  }
  const t = setTimeout(cb, 50);
  return () => clearTimeout(t);
};

/**
 * Hand a spent channel's PCM back to the allocator NOW, instead of waiting for
 * the decoded buffer to be collected.
 *
 * A Web Audio channel is a plain `Float32Array` over its own whole
 * `ArrayBuffer`, so transferring that store detaches it and frees the bytes
 * synchronously. The clone is dropped unread; `structuredClone` with
 * `transfer` moves the store rather than copying it, so this allocates nothing.
 *
 * Every guard here is a correctness guard, not decoration: a view that is a
 * window onto a larger or shared store must not be detached, because detaching
 * would take bytes that are not ours. Where any guard fails, or the host has no
 * `structuredClone`, this is a NO-OP and the old GC-timed behaviour applies —
 * the downmix is still correct, just not as cheap.
 *
 * ONLY ever called on a channel of a buffer we are about to drop. Never on a
 * buffer that will be played: a detached channel reads back as zero samples.
 */
function releaseChannelData(data: Float32Array): void {
  if (typeof structuredClone !== 'function') return;
  const store: ArrayBufferLike = data.buffer;
  if (!(store instanceof ArrayBuffer)) return;
  if (data.byteOffset !== 0 || data.byteLength !== store.byteLength) return;
  try {
    structuredClone(store, { transfer: [store] });
  } catch {
    /* host refused the transfer; the GC path still applies */
  }
}

/**
 * Average all channels of a decoded buffer into a mono buffer at the context
 * rate. `decoded` is CONSUMED: its channels are summed in place and then
 * released, so the caller must drop its reference and must not read it again.
 *
 * Of the four steps, step 2 and step 4 — releasing at all — are what lowered
 * the renderer high-water mark by ~110 MiB. Their POSITION relative to step 3
 * does not move that mark on the box this was measured on; what it moves is
 * the live PCM at the busiest instant, seven whole-track buffers instead of
 * eight. Both claims are measured; see MEMORY at the top of this file, which
 * also records that the mark is still above the ~600 bar afterwards.
 *
 * The order is gated by `the spent channels are released BEFORE the mono
 * buffer is allocated` in play-engine.test.mjs — without that test, moving
 * step 2 below step 3 frees the same bytes, leaves the same end state, and
 * passes every other test:
 *
 *   1. sum into channel 0 IN PLACE   — no second full-length allocation while
 *                                      every source channel is still resident
 *   2. release channels 1..n         — frees them BEFORE step 3 asks for more
 *   3. allocate the mono buffer, copy
 *   4. release channel 0             — the last of the decode, freed on this
 *                                      line rather than whenever GC gets to it
 *
 * Allocating the mono buffer first (as this used to) means one stereo buffer
 * and one mono buffer are both live for the length of the loop. It is an
 * allocation-ORDER bug, not a volume one: exactly the same bytes are read and
 * written either way, and the end state is identical, which is precisely why
 * no after-the-fact assertion can catch a regression here.
 *
 * A single-channel decode is returned as-is, UNRELEASED: it is the buffer we
 * are going to play, and copying it would double peak memory for no gain.
 */
function downmixToMono(ctx: AudioContext, decoded: AudioBuffer): AudioBuffer {
  const channels = decoded.numberOfChannels;
  if (channels <= PLAYBACK_CHANNELS) return decoded;

  const acc = decoded.getChannelData(0);
  const rest: Float32Array[] = [];
  for (let c = 1; c < channels; c++) rest.push(decoded.getChannelData(c));
  for (const src of rest) for (let i = 0; i < acc.length; i++) acc[i] += src[i];
  for (let i = 0; i < acc.length; i++) acc[i] /= channels;
  for (const src of rest) releaseChannelData(src);

  const mono = ctx.createBuffer(PLAYBACK_CHANNELS, decoded.length, decoded.sampleRate);
  mono.getChannelData(0).set(acc);
  releaseChannelData(acc);
  return mono;
}

export class WebAudioPlayEngine implements PlayEngine {
  private readonly createCtx: AudioContextFactory;
  private readonly scheduleFrame: (cb: () => void) => FrameCanceller;
  private readonly decodeRate: number;
  private readonly createOutput: OutputFactory | null;
  private readonly stretchProvider: StretchProvider | null;

  // ── slow-down (Phase C C1) ─────────────────────────────────────────────────
  /** Rate the sources run at now. Position advances `rate` song-seconds per context second. */
  private rate: PlaybackRate = 1;
  /** Rate the user asked for; differs from `rate` only while nodes are being prepared. */
  private wantRate: PlaybackRate = 1;
  /**
   * The six stretch nodes. Created ONCE per engine, on the first rate below 1,
   * then kept across seek, pause, rate change and song reload; released only by
   * `dispose()` (gate G1). Empty until then, so an engine that is never slowed
   * builds exactly today's graph.
   */
  private readonly stretchers = new Map<StemName, StretchNode>();
  private stretchState: 'none' | 'preparing' | 'ready' | 'failed' = 'none';
  /**
   * Silence fed to every stretch node while it is linked, so a node keeps
   * running between runs and its previous content drains out (muted) instead
   * of sitting in the pipeline and playing at the start of the next run.
   */
  private feeder: AudioScheduledSourceNode | null = null;
  /** True while feeder → stretchers → gains are connected. */
  private stretchLinked = false;
  /** Context time until which the previous stretched run may still be draining. */
  private drainUntil = 0;
  private unlinkTimer: ReturnType<typeof setTimeout> | null = null;
  /** A stretched run's 'ended', held back by the pipeline latency. */
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  private ctx: AudioContext | null = null;
  /** Where every GainNode connects. Created once with the context. */
  private output: AudioNode | null = null;
  /** `onAudioStateChange` subscribers; fired on the context's 'statechange'. */
  private readonly audioStateListeners = new Set<(state: string) => void>();
  private readonly onCtxStateChange = () => {
    const state = String(this.ctx?.state ?? 'closed');
    for (const l of Array.from(this.audioStateListeners)) {
      try {
        l(state);
      } catch {
        /* a listener's failure is not the engine's */
      }
    }
  };
  private readonly buffers = new Map<StemName, AudioBuffer>();
  /** Created once per ready stem in `load()`. Never recreated — invariant 2. */
  private readonly gains = new Map<StemName, GainNode>();
  /** Live sources. Empty whenever we are not sounding. */
  private readonly voices = new Map<StemName, AudioBufferSourceNode>();
  private readonly stems = new Map<StemName, MutableStem>();

  private status: TransportStatus = 'idle';
  private durationSec = 0;
  private loop: LoopRegion | null = null;
  private missing: StemName[] = [];
  private error: { code: string; message: string } | null = null;

  /** AudioContext time at which `startOffset` is heard. */
  private startCtxTime = 0;
  /** Buffer offset the current run was started from. */
  private startOffset = 0;
  /** Position while not sounding. */
  private pausedAt = 0;
  /** Bumped on every stop, so a stale `onended` from a stopped run is ignored. */
  private runId = 0;
  /** Bumped on every `load`, so a superseded load cannot publish its result. */
  private loadId = 0;

  private readonly listeners = new Set<(s: EngineSnapshot) => void>();
  private snapshot: EngineSnapshot = IDLE_SNAPSHOT;
  private cancelFrame: FrameCanceller | null = null;
  private disposed = false;

  constructor(options: PlayEngineOptions = {}) {
    this.createCtx = options.createAudioContext ?? defaultCreateAudioContext;
    this.scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
    const r = options.decodeSampleRate;
    this.decodeRate = isFiniteNumber(r) && r > 0 ? r : PLAYBACK_SAMPLE_RATE;
    this.createOutput = typeof options.createOutput === 'function' ? options.createOutput : null;
    const st = options.stretch;
    this.stretchProvider =
      st && typeof st.create === 'function' && typeof st.register === 'function' && typeof st.latencySec === 'function'
        ? st
        : null;
  }

  // ── speed (Phase C C1, Beta) ───────────────────────────────────────────────

  /** True when this engine can slow down at all (a stretch provider was given and has not failed). */
  get canChangeSpeed(): boolean {
    return !!this.stretchProvider && this.stretchState !== 'failed';
  }

  /**
   * Change speed with pitch kept. Only `PLAYBACK_RATES` are accepted (50% is
   * not); anything else is a no-op. Sample-lock is kept the way a seek keeps
   * it: every voice stops and every voice restarts from ONE (when, offset).
   *
   * The first rate below 1 builds and warms the stretch nodes (async); the
   * rate is applied as soon as they run. `snapshot.playbackRate` is the rate
   * actually playing; `snapshot.speedPending` is true while waiting.
   */
  setPlaybackRate(rate: number): void {
    if (this.disposed || !isPlaybackRate(rate)) return;
    if (rate !== 1 && !this.canChangeSpeed) return;
    this.wantRate = rate;
    if (rate === this.rate) {
      this.emit();
      return;
    }
    if (rate !== 1 && this.stretchState !== 'ready') {
      void this.prepareStretch();
      this.emit();
      return;
    }
    this.applyRate(rate);
  }

  /** When the stretch pipeline will be silent, read at context time `now`. */
  private drainEnd(now: number): number {
    // Still sounding (or a run that ended by itself): its input stopped no
    // later than now, so it is out within one latency.
    if (this.drainUntil === Number.POSITIVE_INFINITY) {
      return now + this.latencyAt(this.rate) + STRETCH_DRAIN_MARGIN_SEC;
    }
    return this.drainUntil;
  }

  /** Context seconds of stretch latency at `rate`; 0 at 100% (bypassed). */
  private latencyAt(rate: number): number {
    if (rate === 1 || !this.stretchProvider) return 0;
    const l = this.stretchProvider.latencySec(rate);
    return isFiniteNumber(l) && l > 0 ? l : 0;
  }

  private applyRate(rate: PlaybackRate): void {
    const ctx = this.ctx;
    if (rate !== 1) this.linkStretch();
    this.cancelUnlink();
    if (ctx && this.status === 'playing') {
      const at = this.livePosition();
      this.stopVoices();
      this.rate = rate;
      this.startVoices(at);
      this.startFrameLoop();
    } else {
      this.rate = rate;
    }
    if (rate === 1) this.scheduleUnlink();
    this.emit();
  }

  /** Build, connect and warm the six stretch nodes. Once per engine. */
  private prepareStretch(): Promise<void> {
    const ctx = this.ctx;
    const p = this.stretchProvider;
    if (!ctx || !p || this.stretchState !== 'none') return Promise.resolve();
    this.stretchState = 'preparing';
    return (async () => {
      try {
        await p.register(ctx);
        if (this.disposed || this.ctx !== ctx) return;
        for (const name of PLAYABLE_STEMS) {
          if (!this.stretchers.has(name)) this.stretchers.set(name, p.create(ctx));
        }
        this.linkStretch();
        if (p.ready) await Promise.all(Array.from(this.stretchers.values()).map((n) => p.ready!(n)));
        if (this.disposed || this.ctx !== ctx) return;
        this.stretchState = 'ready';
        if (this.wantRate !== this.rate) this.applyRate(this.wantRate);
        else if (this.rate === 1) this.scheduleUnlink();
        this.emit();
      } catch {
        if (this.disposed) return;
        // No slow-down on this device; normal speed is untouched.
        this.stretchState = 'failed';
        this.wantRate = this.rate;
        this.releaseStretch();
        this.emit();
      }
    })();
  }

  /** feeder → every stretch node → its stem's gain. Idempotent. */
  private linkStretch(): void {
    const ctx = this.ctx;
    if (!ctx || this.stretchers.size === 0) return;
    this.cancelUnlink();
    if (this.stretchLinked) return;
    if (!this.feeder) {
      try {
        const c = (ctx as { createConstantSource?: () => ConstantSourceNode }).createConstantSource?.();
        if (c) {
          c.offset.value = 0;
          c.start();
          this.feeder = c;
        }
      } catch {
        this.feeder = null; // the pipeline then only drains while a stem plays
      }
    }
    for (const [name, st] of Array.from(this.stretchers.entries())) {
      try {
        this.feeder?.connect(st);
      } catch {
        /* ignore */
      }
      const g = this.gains.get(name);
      if (g) st.connect(g);
    }
    this.stretchLinked = true;
  }

  /** Back at 100%: once the pipeline has drained (silent), take it out of the graph entirely. */
  private scheduleUnlink(): void {
    if (!this.stretchLinked || this.rate !== 1) return;
    this.cancelUnlink();
    const ctx = this.ctx;
    const waitSec = ctx ? Math.max(0, this.drainEnd(ctx.currentTime) - ctx.currentTime) : 0;
    this.unlinkTimer = setTimeout(() => {
      this.unlinkTimer = null;
      if (this.disposed || this.rate !== 1) return;
      const c = this.ctx;
      // A suspended context drains nothing: wait on ITS clock, not the wall's.
      if (c && c.currentTime < this.drainEnd(c.currentTime)) return this.scheduleUnlink();
      this.unlinkStretch();
    }, Math.ceil(waitSec * 1000) + 50);
    // Housekeeping only: never keep a (test) process alive for it.
    (this.unlinkTimer as { unref?: () => void }).unref?.();
  }

  private cancelUnlink(): void {
    if (this.unlinkTimer) clearTimeout(this.unlinkTimer);
    this.unlinkTimer = null;
  }

  /** feeder and stretch nodes disconnected; the nodes themselves are kept. */
  private unlinkStretch(): void {
    if (!this.stretchLinked) return;
    try {
      this.feeder?.disconnect();
    } catch {
      /* ignore */
    }
    for (const st of Array.from(this.stretchers.values())) {
      try {
        st.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.stretchLinked = false;
  }

  /** Engine teardown only: the one place stretch nodes are let go. */
  private releaseStretch(): void {
    this.cancelUnlink();
    this.unlinkStretch();
    const p = this.stretchProvider;
    for (const st of Array.from(this.stretchers.values())) {
      try {
        p?.release?.(st);
      } catch {
        /* ignore */
      }
    }
    this.stretchers.clear();
    try {
      this.feeder?.stop();
    } catch {
      /* ignore */
    }
    this.feeder = null;
  }

  /** The rate stems are decoded and played at, once a context exists; else the requested one. */
  get sampleRate(): number {
    const r = this.ctx?.sampleRate;
    return isFiniteNumber(r) && r > 0 ? r : this.decodeRate;
  }

  // ── load ───────────────────────────────────────────────────────────────────

  async load(input: StemSource[]): Promise<void> {
    if (this.disposed) return;
    const myLoad = ++this.loadId;

    this.teardownAudioGraph();
    this.buffers.clear();
    this.stems.clear();
    this.loop = null;
    this.missing = [];
    this.error = null;
    this.durationSec = 0;
    this.pausedAt = 0;
    this.setStatus('loading');

    // De-duplicate by name, keep only names the contract knows, keep contract order.
    const byName = new Map<StemName, StemSource>();
    for (const src of Array.isArray(input) ? input : []) {
      if (!src || !PLAYABLE_STEMS.includes(src.name)) continue;
      if (!byName.has(src.name)) byName.set(src.name, src);
    }

    let ctx: AudioContext;
    try {
      ctx = this.ctx ?? this.openContext();
    } catch (e) {
      if (myLoad !== this.loadId || this.disposed) return;
      this.fail(ENGINE_ERROR.NO_AUDIO, messageOf(e, 'Web Audio is unavailable'));
      return;
    }
    if (this.ctx !== ctx) {
      this.ctx = ctx;
      this.output = this.openOutput(ctx);
      try {
        (ctx as { addEventListener?: (t: string, cb: () => void) => void }).addEventListener?.(
          'statechange',
          this.onCtxStateChange,
        );
      } catch {
        /* an engine without the event still works; callers also re-sample */
      }
    }

    for (const name of PLAYABLE_STEMS) {
      const source = byName.get(name);
      if (!source) {
        this.stems.set(name, blankStem('unavailable'));
        this.missing.push(name);
        continue;
      }
      let availability: StemAvailability = 'ready';
      try {
        // `decodeAudioData` detaches the ArrayBuffer it is given, so decode a
        // copy — the loader's bytes stay usable and `load()` is re-runnable.
        // The copy is ~2.5 MB per stem, nothing beside the PCM it becomes.
        const decoded = await ctx.decodeAudioData(source.bytes.slice(0));
        if (myLoad !== this.loadId || this.disposed) return;
        if (!decoded || decoded.length === 0) {
          availability = 'encode_failed';
        } else {
          // One stem at a time, and `downmixToMono` CONSUMES `decoded`: the
          // stereo channels are freed inside that call, not left for GC, so
          // the next decode starts from the mono-only floor. `decoded` must
          // not be read after this line.
          this.buffers.set(name, downmixToMono(ctx, decoded));
        }
      } catch {
        availability = 'encode_failed';
      }
      if (myLoad !== this.loadId || this.disposed) return;
      this.stems.set(name, blankStem(availability));
      if (availability !== 'ready') this.missing.push(name);
    }

    if (byName.size === 0) {
      this.fail(ENGINE_ERROR.NO_STEMS, 'No stems were supplied.');
      return;
    }
    if (this.buffers.size === 0) {
      this.fail(ENGINE_ERROR.DECODE_FAILED, 'No stem could be decoded.');
      return;
    }

    // Zero duration spread between stems is MEASURED; take the max anyway so a
    // future spread truncates nothing.
    let duration = 0;
    for (const buf of Array.from(this.buffers.values())) duration = Math.max(duration, buf.duration);
    if (duration > MAX_TRACK_SEC) {
      this.buffers.clear();
      this.fail(
        ENGINE_ERROR.TOO_LONG,
        `Track is ${duration.toFixed(1)} s; the limit is ${MAX_TRACK_SEC} s.`,
      );
      return;
    }
    this.durationSec = duration;

    for (const name of Array.from(this.buffers.keys())) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(this.targetGain(name), ctx.currentTime);
      g.connect(this.output ?? ctx.destination);
      this.gains.set(name, g);
      // Stretch nodes outlive a song: re-attach them to this song's gains.
      const st = this.stretchLinked ? this.stretchers.get(name) : undefined;
      if (st) st.connect(g);
    }

    this.setStatus('ready');
    // A speed remembered for this song can be applied before the first play.
    if (this.wantRate !== 1 && this.stretchState === 'none') void this.prepareStretch();
  }

  private openContext(): AudioContext {
    try {
      return this.createCtx({ sampleRate: this.decodeRate });
    } catch (e) {
      if (this.decodeRate === PLAYBACK_SAMPLE_RATE) throw e;
      // A browser that refuses the light rate still gets a player.
      return this.createCtx({ sampleRate: PLAYBACK_SAMPLE_RATE });
    }
  }

  private openOutput(ctx: AudioContext): AudioNode {
    if (!this.createOutput) return ctx.destination;
    try {
      return this.createOutput(ctx) ?? ctx.destination;
    } catch {
      // A route that cannot be built must never cost the user their audio.
      return ctx.destination;
    }
  }

  /**
   * Ask a suspended or interrupted context to run again, WITHOUT touching the
   * transport. For the visibilitychange / user-gesture hooks on phones: iOS
   * moves a context to 'interrupted' (a call, Siri, another app taking audio)
   * and Chrome can suspend one. While the context is not running its clock is
   * frozen, and every source is scheduled on that clock, so the six stems stay
   * sample-locked across the gap and resume where they stopped.
   *
   * No-op unless we are playing and the context is not already running.
   */
  resumeAudio(): void {
    const ctx = this.ctx;
    if (this.disposed || !ctx || this.status !== 'playing') return;
    if (ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      void Promise.resolve(ctx.resume()).catch(() => {});
    } catch {
      /* the next gesture will try again */
    }
  }

  /**
   * Called with the context's new state whenever it changes ('running' after a
   * resume, 'interrupted' on iOS, …). Returns an unsubscribe fn. Used to
   * re-read `outputLatency`, which Chromium reports as 0 until the context runs.
   */
  onAudioStateChange(cb: (state: string) => void): () => void {
    if (typeof cb !== 'function' || this.disposed) return () => {};
    this.audioStateListeners.add(cb);
    return () => {
      this.audioStateListeners.delete(cb);
    };
  }

  /**
   * The stretch pipeline's latency for a start at the rate now playing: what
   * `startVoices` adds between `when` and `heardAt`. 0 at 100% (bypassed).
   */
  stretchLatencySec(): number {
    if (this.disposed || this.rate === 1 || this.stretchers.size === 0) return 0;
    return this.latencyAt(this.rate);
  }

  /** The context's reported latencies, for chord-clock compensation; null without a context. */
  audioLatency(): { outputLatency?: number; baseLatency?: number } | null {
    const ctx = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    if (!ctx || this.disposed) return null;
    return { outputLatency: ctx.outputLatency, baseLatency: ctx.baseLatency };
  }

  // ── transport ──────────────────────────────────────────────────────────────

  play(): void {
    if (this.disposed || !this.ctx) return;
    if (this.status === 'playing') return;
    if (this.status !== 'ready' && this.status !== 'ended') return;
    if (this.buffers.size === 0) return;

    // Play at the end restarts; otherwise resume where we paused.
    let from = this.status === 'ended' ? 0 : this.pausedAt;
    if (this.loop && (from < this.loop.startSec || from >= this.loop.endSec)) {
      from = this.loop.startSec;
    }
    if (from >= this.durationSec) from = 0;

    // 'suspended' (autoplay policy, Chrome) and 'interrupted' (iOS: a call or
    // another app took the audio session) both need a resume; play() is always
    // called from a user gesture, which is what iOS requires for it to stick.
    const st = this.ctx.state as string;
    if (st === 'suspended' || st === 'interrupted') void Promise.resolve(this.ctx.resume()).catch(() => {});
    this.startVoices(from);
    this.status = 'playing';
    this.startFrameLoop();
    this.emit();
  }

  pause(): void {
    if (this.disposed) return;
    if (this.status !== 'playing') return;
    this.pausedAt = this.livePosition();
    this.stopVoices();
    this.status = 'ready';
    this.emit();
  }

  seek(positionSec: number): void {
    if (this.disposed || !this.ctx) return;
    if (!isFiniteNumber(positionSec)) return; // NaN / Infinity / "3" → no-op
    if (this.status === 'idle' || this.status === 'loading' || this.status === 'error') return;

    const target = Math.min(Math.max(positionSec, 0), this.durationSec);
    const wasPlaying = this.status === 'playing';
    this.pausedAt = target;

    if (!wasPlaying) {
      // A seek away from the end makes the transport playable again.
      if (this.status === 'ended' && target < this.durationSec) this.status = 'ready';
      this.emit();
      return;
    }

    this.stopVoices();
    if (target >= this.durationSec) {
      // Seeking to (or past) the end while playing lands on the end.
      this.status = 'ended';
      this.emit();
      return;
    }
    this.startVoices(target);
    this.status = 'playing';
    this.startFrameLoop();
    this.emit();
  }

  // ── mixer ──────────────────────────────────────────────────────────────────

  setGain(stem: StemName, gain: number): void {
    const s = this.readyStem(stem);
    if (!s) return;
    if (!isFiniteNumber(gain)) return;
    const next = clamp01(gain); // -1 → 0, 2 → 1
    if (s.gain === next) return;
    s.gain = next;
    this.applyGains();
    this.emit();
  }

  setMute(stem: StemName, muted: boolean): void {
    const s = this.readyStem(stem);
    if (!s) return;
    const next = !!muted;
    if (s.muted === next) return;
    s.muted = next;
    this.applyGains();
    this.emit();
  }

  setSolo(stem: StemName, soloed: boolean): void {
    const s = this.readyStem(stem);
    if (!s) return;
    const next = !!soloed;
    if (s.soloed === next) return;
    s.soloed = next;
    this.applyGains();
    this.emit();
  }

  setLoop(region: LoopRegion | null): void {
    if (this.disposed) return;
    if (region === null) {
      if (this.loop === null) return;
      // Fold the wraps already played into the clock base FIRST, while the old
      // region is still installed (QA C-01): otherwise the unwrapped counter is
      // read with no loop to fold it and reports wraps × span too far ahead.
      this.rebaseClock();
      this.loop = null;
      for (const src of Array.from(this.voices.values())) src.loop = false;
      this.emit();
      return;
    }
    if (!region || !isFiniteNumber(region.startSec) || !isFiniteNumber(region.endSec)) return;
    const startSec = Math.min(Math.max(region.startSec, 0), this.durationSec);
    const endSec = Math.min(Math.max(region.endSec, 0), this.durationSec);
    if (endSec - startSec < MIN_LOOP_SEC) return; // inverted or hair-thin → no-op

    // Read the playhead BEFORE the new region is installed: `livePosition()`
    // wraps against the CURRENT loop, so asking afterwards would report a
    // position already folded into the new region and we would never notice
    // that the playhead was outside it.
    const posBefore = this.livePosition();
    // And collapse the wraps already played into the clock base against that
    // same OLD region (QA C-01). Extending or shrinking around a playhead that
    // stays inside leaves the sources running, so nothing else rebases the
    // clock; without this the unwrapped counter is re-folded by the NEW span.
    this.rebaseClock();
    this.loop = region.label === undefined ? { startSec, endSec } : { startSec, endSec, label: region.label };
    // A hair of tolerance at the head: the playhead is derived from a float
    // clock, and dropping a loop exactly on the beat must not read as "outside".
    const inRegion = (p: number) => p >= startSec - 1e-6 && p < endSec;

    if (this.status === 'playing') {
      if (inRegion(posBefore)) {
        // Native looping engages without touching the running sources, so the
        // mix keeps playing sample-locked — no restart, no reseek.
        for (const src of Array.from(this.voices.values())) {
          src.loopStart = startSec;
          src.loopEnd = endSec;
          src.loop = true;
        }
        this.emit();
      } else {
        // Outside the region there is nothing to loop; jump to its head. This
        // is a deliberate seek, the documented exception to monotonicity.
        this.emit();
        this.seek(startSec);
      }
      return;
    }
    if (!inRegion(this.pausedAt)) this.pausedAt = startSec;
    this.emit();
  }

  // ── observation ────────────────────────────────────────────────────────────

  getSnapshot(): EngineSnapshot {
    if (this.disposed) return this.snapshot;
    return this.rebuild();
  }

  subscribe(listener: (s: EngineSnapshot) => void): () => void {
    if (typeof listener !== 'function') return () => {};
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    let live = true;
    return () => {
      if (!live) return; // unsubscribing twice must not remove someone else's turn
      live = false;
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopFrameLoop();
    this.teardownAudioGraph();
    this.releaseStretch();
    this.buffers.clear();
    this.stems.clear();
    this.status = 'idle';
    this.durationSec = 0;
    this.pausedAt = 0;
    this.loop = null;
    this.missing = [];
    this.error = null;
    const ctx = this.ctx;
    try {
      (ctx as { removeEventListener?: (t: string, cb: () => void) => void } | null)?.removeEventListener?.(
        'statechange',
        this.onCtxStateChange,
      );
    } catch {
      /* ignore */
    }
    this.audioStateListeners.clear();
    this.ctx = null;
    this.output = null;
    this.snapshot = IDLE_SNAPSHOT;
    for (const l of Array.from(this.listeners)) {
      try {
        l(IDLE_SNAPSHOT);
      } catch {
        /* a listener's failure is not the engine's */
      }
    }
    this.listeners.clear();
    try {
      void Promise.resolve(ctx?.close()).catch(() => {});
    } catch {
      /* already closed */
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private readyStem(stem: StemName): MutableStem | null {
    if (this.disposed) return null;
    const s = this.stems.get(stem);
    // A stem with no audio cannot be mixed; soloing one would silence the mix.
    if (!s || s.availability !== 'ready') return null;
    return s;
  }

  private anySoloed(): boolean {
    for (const s of Array.from(this.stems.values()))
      if (s.availability === 'ready' && s.soloed) return true;
    return false;
  }

  /**
   * THE one place solo/mute is resolved. `StemState.effectivelySilent` and the
   * gain actually sent to the graph both come from here, so the mixer cannot
   * disagree with what is audible.
   *
   * The rule is
   *
   *     effectivelySilent = muted || (anySoloed && !soloed)
   *
   * i.e. with nothing soloed only muted stems are silent; with ANY stem soloed
   * every NON-soloed stem is silent and the soloed ones all play, however many
   * there are; and a stem that is both soloed and muted is still silent,
   * because mute wins.
   *
   * The contract's doc comment on `effectivelySilent` says "some OTHER stem is
   * soloed", which read literally would make two soloed stems silence each
   * other and so destroy additive solo. That wording is a known defect in
   * `types.ts` (confirmed 2026-11-10, fixed separately); the rule above is the
   * intended behaviour and is what story 2.4 ("we want what Moises has") asks
   * for. Do not "fix" this to match the comment.
   */
  private silent(name: StemName): boolean {
    const s = this.stems.get(name);
    if (!s) return true;
    if (s.muted) return true;
    return this.anySoloed() && !s.soloed;
  }

  private targetGain(name: StemName): number {
    const s = this.stems.get(name);
    if (!s) return 0;
    return this.silent(name) ? 0 : clamp01(s.gain);
  }

  /** Push every stem's current target into the graph. Creates no nodes. */
  private applyGains(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const sounding = this.voices.size > 0;
    const now = ctx.currentTime;
    for (const [name, g] of Array.from(this.gains.entries())) {
      const target = this.targetGain(name);
      const p = g.gain;
      if (!sounding && this.stretchLinked && this.drainUntil > now) {
        // Paused, but the stretch pipeline is still draining the last run:
        // stay muted until it is out, then take the new value.
        p.cancelScheduledValues(now);
        p.setTargetAtTime(0, now, FADE_SEC / 2);
        p.setValueAtTime(target, this.drainEnd(now));
        continue;
      }
      if (!sounding) {
        // Nothing is audible, so a step cannot click and leaves the param in a
        // known state for the next start.
        p.cancelScheduledValues(now);
        p.setValueAtTime(target, now);
        continue;
      }
      holdCurrentValue(p, now);
      p.setTargetAtTime(target, now, FADE_TC);
    }
  }

  private startVoices(offset: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const rate = this.rate;
    const stretched = rate !== 1 && this.stretchers.size > 0;
    const drain = this.stretchLinked ? this.drainEnd(now) : 0;
    // Gate G2: through the stretch nodes, the sample at `offset` is heard
    // `latency` after `when`. The gain opens then and the clock is anchored
    // there, so positionSec — what chords, sections, count-in and loops read —
    // is what is HEARD. Whatever the previous run left in the pipeline drains
    // (muted) before that: `when` waits for it if it has to. Leaving a
    // stretched run for 100% likewise starts the direct sources only after the
    // pipeline has drained, so its tail is never heard on top.
    const latency = stretched ? this.latencyAt(rate) : 0;
    const when = Math.max(now + START_LEAD_SEC, drain - latency);
    const heardAt = when + latency;
    const loop = this.loop;
    const run = ++this.runId;

    // ONE `when`, ONE `offset`, for every stem. Invariant 1 lives on this line.
    for (const [name, buf] of Array.from(this.buffers.entries())) {
      const g = this.gains.get(name);
      if (!g) continue;
      let src: AudioBufferSourceNode;
      try {
        src = ctx.createBufferSource();
        src.buffer = buf;
        if (loop) {
          src.loopStart = loop.startSec;
          src.loopEnd = loop.endSec;
          src.loop = true;
        }
        const st = stretched ? this.stretchers.get(name) : undefined;
        if (st) {
          src.playbackRate.value = rate;
          st.playbackRate.setValueAtTime(rate, when);
          src.connect(st);
        } else {
          src.connect(g); // 100%: exactly today's graph (gate G1 bypass)
        }
        const p = g.gain;
        if (this.stretchLinked) {
          // The pipeline may still be draining the previous run: keep (or
          // start) the fade to 0 and drop anything scheduled after it, so the
          // old tail stays muted until the new run is heard.
          holdCurrentValue(p, now);
          p.setTargetAtTime(0, now, FADE_SEC / 2);
        } else {
          p.cancelScheduledValues(ctx.currentTime);
        }
        p.setValueAtTime(0, heardAt);
        p.linearRampToValueAtTime(this.targetGain(name), heardAt + FADE_SEC);
        src.start(when, offset);
      } catch {
        continue; // a single stem failing to start must not take the run down
      }
      src.onended = () => {
        if (this.disposed || run !== this.runId) return; // our own stop, ignore
        this.voices.delete(name);
        if (this.voices.size > 0) return;
        const finish = () => {
          this.endTimer = null;
          if (this.disposed || run !== this.runId) return;
          this.stopFrameLoop();
          this.pausedAt = this.durationSec;
          this.status = 'ended';
          this.emit();
        };
        // Through the stretch pipeline the last `latency` of the song is still
        // to be heard when the sources end. Say 'ended' only once it has been,
        // so nothing downstream (the phone route pauses its <audio> element on
        // leaving 'playing') cuts the tail. At 100% this stays synchronous.
        if (latency > 0) {
          this.endTimer = setTimeout(finish, Math.ceil(latency * 1000));
          return;
        }
        finish();
      };
      this.voices.set(name, src);
    }

    this.startCtxTime = heardAt;
    this.startOffset = offset;
    this.pausedAt = offset;
    if (stretched) this.drainUntil = Number.POSITIVE_INFINITY; // sounding through the pipeline
  }

  private stopVoices(): void {
    const ctx = this.ctx;
    this.runId++; // invalidate this run's `onended`
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    this.stopFrameLoop();
    for (const src of Array.from(this.voices.values())) {
      try {
        src.onended = null;
      } catch {
        /* ignore */
      }
      try {
        src.stop(ctx ? ctx.currentTime + STOP_LAG_SEC : 0);
      } catch {
        /* never started, or already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.voices.clear();
    if (ctx && this.drainUntil === Number.POSITIVE_INFINITY) {
      // The stretched run's last input is still in the pipeline for its latency.
      this.drainUntil = ctx.currentTime + STOP_LAG_SEC + this.latencyAt(this.rate) + STRETCH_DRAIN_MARGIN_SEC;
    }
    if (ctx) {
      // Fade the (now doomed) sources out rather than cutting them.
      const now = ctx.currentTime;
      for (const g of Array.from(this.gains.values())) {
        holdCurrentValue(g.gain, now);
        g.gain.setTargetAtTime(0, now, FADE_SEC / 2);
      }
    }
  }

  private teardownAudioGraph(): void {
    this.stopVoices();
    // Detach (not release) the stretch nodes from the gains about to go.
    if (this.stretchLinked) {
      for (const st of Array.from(this.stretchers.values())) {
        try {
          st.disconnect();
        } catch {
          /* ignore */
        }
      }
    }
    for (const g of Array.from(this.gains.values())) {
      try {
        g.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.gains.clear();
  }

  /**
   * Re-anchor the clock at the current playhead without touching the audio.
   *
   * `livePosition()` adds the elapsed time to `startOffset` UNWRAPPED and folds
   * the sum by whatever loop is installed at the moment it is read. That is
   * only right while the loop it is folded by is the loop the sources actually
   * wrapped on. So every change to the loop while playing must first collapse
   * the wraps already played into `startOffset`, measured against the OLD
   * region; the new region then folds only time played under it (QA C-01).
   * The position is preserved exactly: `livePosition()` reads the same value
   * immediately before and after.
   */
  private rebaseClock(): void {
    const ctx = this.ctx;
    if (!ctx || this.status !== 'playing') return;
    // Still inside the start lead: nothing has sounded yet and no wrap can have
    // happened. Keep the scheduled `when`, or the lead would count as playing.
    if (ctx.currentTime <= this.startCtxTime) return;
    this.startOffset = this.livePosition();
    this.startCtxTime = ctx.currentTime;
  }

  /** Position derived from the clock, wrapped by the loop region. */
  private livePosition(): number {
    const ctx = this.ctx;
    if (!ctx || this.status !== 'playing') return this.pausedAt;
    const elapsed = ctx.currentTime - this.startCtxTime;
    // Song time: `rate` song-seconds per context second (1 at 100%, exact).
    const raw = this.startOffset + (elapsed > 0 ? elapsed * this.rate : 0); // pre-roll reads as the start
    const loop = this.loop;
    if (loop) {
      const span = loop.endSec - loop.startSec;
      if (span > 0 && raw > loop.endSec) {
        return loop.startSec + ((raw - loop.startSec) % span);
      }
    }
    return raw > this.durationSec ? this.durationSec : raw;
  }

  private setStatus(status: TransportStatus): void {
    this.status = status;
    this.emit();
  }

  private fail(code: string, message: string): void {
    this.teardownAudioGraph();
    this.buffers.clear();
    this.error = { code, message };
    this.durationSec = 0;
    this.pausedAt = 0;
    this.setStatus('error');
  }

  /** Rebuilds the cached snapshot, reusing it when nothing has changed. */
  private rebuild(): EngineSnapshot {
    const prev = this.snapshot;
    const position = this.livePosition();
    const stems: StemState[] = [];
    for (const name of PLAYABLE_STEMS) {
      const s = this.stems.get(name);
      if (!s) continue;
      stems.push(
        Object.freeze({
          name,
          availability: s.availability,
          gain: s.gain,
          muted: s.muted,
          soloed: s.soloed,
          effectivelySilent: this.silent(name),
        }),
      );
    }
    const degraded = this.missing.length > 0 ? { missing: Object.freeze(this.missing.slice()) } : null;
    const next: EngineSnapshot = Object.freeze({
      status: this.status,
      positionSec: position,
      durationSec: this.durationSec,
      stems: Object.freeze(stems),
      loop: this.loop ? Object.freeze({ ...this.loop }) : null,
      degraded: degraded ? Object.freeze(degraded) : null,
      error: this.error ? Object.freeze({ ...this.error }) : null,
      playbackRate: this.rate,
      speedPending: this.wantRate !== this.rate,
    });
    if (snapshotsEqual(prev, next)) return prev;
    this.snapshot = next;
    return next;
  }

  private emit(): void {
    const before = this.snapshot;
    const next = this.rebuild();
    if (next === before) return;
    for (const l of Array.from(this.listeners)) {
      try {
        l(next);
      } catch {
        /* a listener's failure is not the engine's */
      }
    }
  }

  private startFrameLoop(): void {
    if (this.cancelFrame || this.disposed) return;
    const step = () => {
      this.cancelFrame = null;
      if (this.disposed || this.status !== 'playing') return;
      this.emit();
      if (this.status === 'playing') this.cancelFrame = this.scheduleFrame(step);
    };
    this.cancelFrame = this.scheduleFrame(step);
  }

  private stopFrameLoop(): void {
    const cancel = this.cancelFrame;
    this.cancelFrame = null;
    if (!cancel) return;
    try {
      cancel();
    } catch {
      /* ignore */
    }
  }
}

function blankStem(availability: StemAvailability): MutableStem {
  return { availability, gain: availability === 'ready' ? 1 : 0, muted: false, soloed: false };
}

function messageOf(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * Pin an AudioParam at whatever it is right now, so the automation that
 * follows starts from the audible value instead of jumping. `setValueAtTime`
 * to the param's OWN current value cannot click; it is not a step.
 */
function holdCurrentValue(p: AudioParam, now: number): void {
  const withHold = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof withHold.cancelAndHoldAtTime === 'function') {
    try {
      withHold.cancelAndHoldAtTime(now);
      return;
    } catch {
      /* fall through */
    }
  }
  const held = p.value;
  p.cancelScheduledValues(now);
  p.setValueAtTime(held, now);
}

function snapshotsEqual(a: EngineSnapshot, b: EngineSnapshot): boolean {
  if (a === b) return true;
  if (a.status !== b.status || a.durationSec !== b.durationSec) return false;
  if ((a.playbackRate ?? 1) !== (b.playbackRate ?? 1) || !!a.speedPending !== !!b.speedPending) return false;
  if (Math.abs(a.positionSec - b.positionSec) >= POSITION_EPSILON_SEC) return false;
  if ((a.loop === null) !== (b.loop === null)) return false;
  if (a.loop && b.loop) {
    if (a.loop.startSec !== b.loop.startSec || a.loop.endSec !== b.loop.endSec) return false;
    if (a.loop.label !== b.loop.label) return false;
  }
  if ((a.error === null) !== (b.error === null)) return false;
  if (a.error && b.error && (a.error.code !== b.error.code || a.error.message !== b.error.message)) return false;
  if ((a.degraded === null) !== (b.degraded === null)) return false;
  if (a.degraded && b.degraded && a.degraded.missing.join(',') !== b.degraded.missing.join(',')) return false;
  if (a.stems.length !== b.stems.length) return false;
  for (let i = 0; i < a.stems.length; i++) {
    const x = a.stems[i];
    const y = b.stems[i];
    if (
      x.name !== y.name ||
      x.availability !== y.availability ||
      x.gain !== y.gain ||
      x.muted !== y.muted ||
      x.soloed !== y.soloed ||
      x.effectivelySilent !== y.effectivelySilent
    )
      return false;
  }
  return true;
}

export function createPlayEngine(options: PlayEngineOptions = {}): PlayEngine {
  return new WebAudioPlayEngine(options);
}
