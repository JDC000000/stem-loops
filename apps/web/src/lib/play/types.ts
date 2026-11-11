/**
 * Play-along engine: the interface contract.
 *
 * This file is TYPES ONLY and deliberately has no implementation. It exists so
 * that the engine, the stem loader, the mixer, the transport, the section
 * looper and the chord playhead can be built CONCURRENTLY without colliding —
 * the seam between them is declared here once, up front.
 *
 * Product source of truth: `claude/user-stories-play-along-2026-11-10.md` v2.0,
 * approved by Jon 2026-11-10. Where that document and the TSD disagree on
 * product behaviour, the user stories win. Every symbol below cites the story
 * whose acceptance criteria it serves.
 *
 * Architecture, from the measured spike (`claude/spike-simple-playback-engine`):
 * plain Web Audio — `decodeAudioData` plus one AudioBufferSourceNode and one
 * GainNode per stem. NOT the TSD §3 Variant D design. No `SharedArrayBuffer`,
 * no WebCodecs, and therefore no COOP/COEP work. Six-stem simultaneous playback
 * with independent gain was measured working in every configuration tested.
 */

/**
 * Fixed display and channel order. Story 2.1.
 * This is the order faders appear in, left to right.
 */
export const PLAYABLE_STEMS = [
  'drums',
  'bass',
  'guitar',
  'keys',
  'vocals',
  'other',
] as const;

export type StemName = (typeof PLAYABLE_STEMS)[number];

/**
 * 48 kHz, mono.
 *
 * ⚠️ UNITS. Every figure in this comment is MiB (2²⁰ bytes), and every one of
 * them used to be labelled "MB". They were never MB: the formula below yields
 * BYTES, and these came from dividing bytes by 2²⁰. The RSS figures are MiB
 * too — they are read from VmRSS, which the kernel reports in KiB — so MiB is
 * the unit that keeps PCM and RSS comparable, and it is the unit Jon's ~600 bar
 * was set against. The labels are fixed; no number below has changed meaning.
 * 1 MiB = 1.048576 MB, so every figure here is ~4.8% LARGER stated in MB.
 *
 * A Web Audio AudioBuffer is always Float32, so PCM bytes are exactly
 *   stems x duration x sampleRate x channels x 4
 * with no slack. The mono downmix is the load-bearing saving, not the rate.
 * These are asserted, not asserted-by-comment: `apps/web/test/play-engine.test.mjs`
 * recomputes each one from the constants in this file and fails if they drift.
 *
 * MEASURED, not assumed — 6 stems x 300 s, SETTLED (all six monos resident):
 *   48 kHz stereo  691,200,000 B = 659.2 MiB PCM / 805 MiB RSS  fails
 *   48 kHz mono    345,600,000 B = 329.6 MiB PCM / 576 MiB RSS  SHIPPING
 *   24 kHz mono    172,800,000 B = 164.8 MiB PCM / 356 MiB RSS  documented fallback
 *
 * ⚠️ SETTLED IS NOT PEAK, AND PEAK IS WHAT KILLS A TAB. `load()` decodes one
 * stem at a time, and `decodeAudioData` hands back a STEREO buffer. At the last
 * decode, five mono buffers are already resident beside it — so live PCM peaks
 * at SEVEN whole-track mono buffers, not six, and the peak lands during LOAD,
 * before a note plays. 6 stems, 48 kHz mono, 300 s:
 *
 *   settled        6 x 57,600,000 B = 345,600,000 B = 329.6 MiB   484 MiB renderer RSS
 *   peak           7 x 57,600,000 B = 403,200,000 B = 384.5 MiB   548 MiB renderer RSS
 *
 * so the settled figure understates peak PCM by exactly 7/6, i.e. +16.7%.
 * Budget against 384.5, not 329.6.
 *
 * Before the decode-transient fix of 2026-11-11 the peak was EIGHT buffers
 * (439.5 MiB PCM / 592 MiB renderer RSS, against 480 MiB settled) because the
 * mono buffer was allocated while the stereo one was still live. Seven is the
 * floor for this architecture: `decodeAudioData` materialises a stereo buffer and there is no
 * API that asks it not to. See MEMORY in `./engine.ts`.
 *
 * Jon relaxed the bar from 400 to ~600 MiB on 2026-11-10 specifically so the
 * reference track keeps full bandwidth. The measured peak of 548 MiB is ~9%
 * under that bar — and 592 MiB was only ~1% under it — so MAX_TRACK_SEC below
 * is a hard ceiling, not a suggestion.
 */
export const PLAYBACK_SAMPLE_RATE = 48_000;
export const PLAYBACK_CHANNELS = 1;

/**
 * 300 s hard ceiling. Story 1.4, approved by Jon 2026-11-10: refuse clearly
 * above this rather than silently degrading quality.
 *
 * Deliberately equal to the worker's KLANGIO_MAX_AUDIO_SEC so that chords and
 * playback share ONE product ceiling. If either moves, move both.
 */
export const MAX_TRACK_SEC = 300;

/** Per-stem availability. Story 5 — a missing stem must be visible, not silent. */
export type StemAvailability =
  | 'ready'
  | 'unavailable'   // never produced
  | 'encode_failed'; // produced then failed to encode or upload

export interface StemState {
  readonly name: StemName;
  readonly availability: StemAvailability;
  /** 0..1. Story 2.2 — continuous, not binary. */
  readonly gain: number;
  /** Story 2.3. Independent of gain: unmuting restores the previous gain. */
  readonly muted: boolean;
  /** Story 2.4 — Jon: "we want what Moises has", both mute AND solo. */
  readonly soloed: boolean;
  /**
   * True when this stem is currently silent for any reason. The engine is the
   * ONLY place this is computed; the mixer renders from it rather than
   * re-deriving solo logic, so there is exactly one implementation to be right.
   *
   *   effectivelySilent = muted || (anySoloed && !soloed)
   *
   * where `anySoloed` is true when ANY stem in the mix has `soloed === true`.
   *
   *   - nothing soloed        → only muted stems are silent
   *   - one or more soloed    → every NON-soloed stem is silent; all the
   *                             soloed ones play, however many there are
   *   - soloed AND muted      → still silent; mute wins
   *
   * ⚠️ The first version of this comment said "muted, or some OTHER stem is
   * soloed", which is wrong and was caught by an agent building against it.
   * Read literally, two soloed stems each see "some other stem is soloed" and
   * silence each other — the opposite of additive solo. The predicate above is
   * normative; the prose is not. Any implementation needs a test for the
   * TWO-STEMS-SOLOED case specifically, because that is the case the wrong
   * reading breaks and the only one that distinguishes them.
   */
  readonly effectivelySilent: boolean;
}

export type TransportStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'ended' | 'error';

/** Story 4.5 — section looping, from `loops.section_label` we already compute. */
export interface LoopRegion {
  readonly startSec: number;
  readonly endSec: number;
  /** e.g. "chorus". Absent for a hand-dragged region. */
  readonly label?: string;
}

export interface EngineSnapshot {
  readonly status: TransportStatus;
  /** Seconds. Story 3.3 — the chord playhead reads THIS, nothing else. */
  readonly positionSec: number;
  readonly durationSec: number;
  readonly stems: readonly StemState[];
  readonly loop: LoopRegion | null;
  /** Story 5.1 — present when some stem could not be made ready. */
  readonly degraded: { readonly missing: readonly StemName[] } | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

/**
 * The engine.
 *
 * Implementations MUST hold these invariants — they are the Gate 2 and Gate 3
 * pass conditions, and each is an acceptance criterion a user can feel:
 *
 *  - All stems stay SAMPLE-LOCKED through play, pause, seek and loop. No drift.
 *    (Story 4.3.)
 *  - `setGain` / `setMute` / `setSolo` must NOT restart or reseek playback, and
 *    must not produce an audible click. (Stories 2.5 and 2.6.)
 *  - `positionSec` advances monotonically while playing, except across a seek
 *    or a loop wrap.
 *  - Every method is safe to call in any status; calls that cannot apply are
 *    no-ops rather than throws. A UI must never need a status guard to be safe.
 */
export interface PlayEngine {
  load(input: StemSource[]): Promise<void>;
  play(): void;
  pause(): void;
  /** Clamped to [0, durationSec]. Safe while paused. */
  seek(positionSec: number): void;

  /** `gain` is clamped to [0, 1]. */
  setGain(stem: StemName, gain: number): void;
  setMute(stem: StemName, muted: boolean): void;
  /** Solo is additive: several stems may be soloed at once. */
  setSolo(stem: StemName, soloed: boolean): void;

  /** `null` clears the loop. Story 4.5. */
  setLoop(region: LoopRegion | null): void;

  getSnapshot(): EngineSnapshot;
  /** Returns an unsubscribe fn. Fires at least on every status change. */
  subscribe(listener: (s: EngineSnapshot) => void): () => void;

  /** Releases AudioContext and buffers. Safe to call twice. */
  dispose(): void;
}

/** One stem's bytes plus where they came from. Produced by the stem loader. */
export interface StemSource {
  readonly name: StemName;
  readonly bytes: ArrayBuffer;
}

/**
 * What the loader returns. `missing` feeds `EngineSnapshot.degraded`, which is
 * what Story 5.1 renders — PR #176 added `expected`/`complete` to the stems
 * route for exactly this.
 */
export interface LoadedStems {
  readonly sources: readonly StemSource[];
  readonly missing: readonly StemName[];
}

// ─── UI props ────────────────────────────────────────────────────────────────
// Components take a snapshot plus callbacks. They never reach into the engine
// directly, so each can be built and tested against a plain object.

export interface MixerProps {
  readonly stems: readonly StemState[];
  readonly onGain: (stem: StemName, gain: number) => void;
  readonly onMute: (stem: StemName, muted: boolean) => void;
  readonly onSolo: (stem: StemName, soloed: boolean) => void;
}

export interface TransportProps {
  readonly status: TransportStatus;
  readonly positionSec: number;
  readonly durationSec: number;
  readonly onPlay: () => void;
  readonly onPause: () => void;
  readonly onSeek: (positionSec: number) => void;
}

export interface SectionLoopProps {
  readonly sections: readonly LoopRegion[];
  readonly active: LoopRegion | null;
  readonly onLoop: (region: LoopRegion | null) => void;
}

/**
 * The ONLY addition to ChordOverlay's existing props. Story 3.
 *
 * `positionSec` drives a marker that STEPS to each chord change, Chordify-style
 * — not a continuously scrolling score (Jon, 2026-11-10).
 *
 * Trap for implementers: the existing `<input type="range">` in
 * ChordOverlay.tsx is the ZOOM slider, not a seek bar. Do not wire transport
 * to it.
 */
export interface ChordPlayheadProps {
  readonly positionSec: number | null;
}
