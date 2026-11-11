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
 * MEASURED, not assumed — 6 stems x 300 s:
 *   48 kHz stereo  659 MB PCM / 805 MB RSS   fails
 *   48 kHz mono    329 MB PCM / 576 MB RSS   SHIPPING
 *   24 kHz mono    165 MB PCM / 356 MB RSS   documented fallback
 *
 * Jon relaxed the bar from 400 MB to ~600 MB on 2026-11-10 specifically so the
 * reference track keeps full bandwidth. 576 MB is only ~4% under that bar, so
 * MAX_TRACK_SEC below is a hard ceiling, not a suggestion.
 *
 * A Web Audio AudioBuffer is always Float32, so PCM bytes are exactly
 *   duration x sampleRate x channels x 4
 * with no slack. The mono downmix is the load-bearing saving, not the rate.
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
