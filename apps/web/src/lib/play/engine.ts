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
 * buffer coexisting with all the monos decoded before it. The settled figure is
 * therefore not the peak, and the peak is what kills a tab:
 *
 *   6 stems, 48 kHz mono, 300 s — measured renderer RSS, real Chromium,
 *   median of 3 reps per side, same harness both sides:
 *                                      BEFORE      AFTER
 *     settled                           480 MB     484 MB
 *     PEAK, during load                 592 MB     548 MB
 *     transient over settled           +112 MB      +64 MB
 *
 *   Settled is ~4 MB HIGHER after, reproducibly, and that is the honest
 *   trade: eager release frees stores one at a time where the old path let GC
 *   reclaim a whole buffer at once, so the allocator settles slightly less
 *   compactly. 4 MB bought 44 MB of peak, and peak is the number that kills a
 *   tab.
 *
 * The peak happens during LOAD, before a note plays: a device that survives
 * steady-state playback can still die loading. `downmixToMono` below is what
 * moved it. It sums into the decoded buffer's own channel 0 instead of
 * allocating a second full-length buffer alongside the live stereo one, and
 * hands each finished channel's backing store back to the allocator the moment
 * it is spent. What is left — one stereo buffer alive beside five monos at the
 * last decode — is the floor for this architecture: `decodeAudioData` gives us
 * a stereo buffer and there is no API that asks it not to.
 *
 * Releasing eagerly rather than waiting for GC also matters on iOS, where
 * WebKit bug 189337 (open since 2018) can keep decoded audio resident for ~a
 * minute after the last reference is dropped. `load()` is re-runnable by design
 * via `loadId`, so a failed load plus a user retry could otherwise stack two
 * generations of PCM on exactly the path taken when memory is already tight.
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
}

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
 * The order of the four steps is the whole point, and is what moved the
 * measured peak from 592 MB to 547 MB (see MEMORY at the top of this file):
 *
 *   1. sum into channel 0 IN PLACE   — no second full-length allocation while
 *                                      every source channel is still resident
 *   2. release channels 1..n         — frees them BEFORE step 3 asks for more
 *   3. allocate the mono buffer, copy
 *   4. release channel 0             — the last of the decode, freed on this
 *                                      line rather than whenever GC gets to it
 *
 * Allocating the mono buffer first (as this used to) means one stereo buffer
 * and one mono buffer are both live for the length of the loop. That is the
 * +110 MB transient, and it is an allocation-ORDER bug, not a volume one:
 * exactly the same bytes are read and written either way.
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

  private ctx: AudioContext | null = null;
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
      ctx = this.ctx ?? this.createCtx({ sampleRate: PLAYBACK_SAMPLE_RATE });
    } catch (e) {
      if (myLoad !== this.loadId || this.disposed) return;
      this.fail(ENGINE_ERROR.NO_AUDIO, messageOf(e, 'Web Audio is unavailable'));
      return;
    }
    this.ctx = ctx;

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
      g.connect(ctx.destination);
      this.gains.set(name, g);
    }

    this.setStatus('ready');
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

    if (this.ctx.state === 'suspended') void Promise.resolve(this.ctx.resume()).catch(() => {});
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
    this.buffers.clear();
    this.stems.clear();
    this.status = 'idle';
    this.durationSec = 0;
    this.pausedAt = 0;
    this.loop = null;
    this.missing = [];
    this.error = null;
    const ctx = this.ctx;
    this.ctx = null;
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
    const when = ctx.currentTime + START_LEAD_SEC;
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
        src.connect(g);
        const p = g.gain;
        p.cancelScheduledValues(ctx.currentTime);
        p.setValueAtTime(0, when);
        p.linearRampToValueAtTime(this.targetGain(name), when + FADE_SEC);
        src.start(when, offset);
      } catch {
        continue; // a single stem failing to start must not take the run down
      }
      src.onended = () => {
        if (this.disposed || run !== this.runId) return; // our own stop, ignore
        this.voices.delete(name);
        if (this.voices.size > 0) return;
        this.stopFrameLoop();
        this.pausedAt = this.durationSec;
        this.status = 'ended';
        this.emit();
      };
      this.voices.set(name, src);
    }

    this.startCtxTime = when;
    this.startOffset = offset;
    this.pausedAt = offset;
  }

  private stopVoices(): void {
    const ctx = this.ctx;
    this.runId++; // invalidate this run's `onended`
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
    for (const g of Array.from(this.gains.values())) {
      try {
        g.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.gains.clear();
  }

  /** Position derived from the clock, wrapped by the loop region. */
  private livePosition(): number {
    const ctx = this.ctx;
    if (!ctx || this.status !== 'playing') return this.pausedAt;
    const elapsed = ctx.currentTime - this.startCtxTime;
    const raw = this.startOffset + (elapsed > 0 ? elapsed : 0); // pre-roll reads as the start
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
