'use client';

/**
 * Player — the SEAM. This is the file that makes the play-along product
 * reachable by a user.
 *
 * Six PRs landed ~3,193 lines of engine, loader, mixer, transport, section
 * looper and chord playhead, and nothing imported any of it: `createPlayEngine`,
 * `loadStems`, `Mixer`, `Transport` and `SectionLoop` each appeared only in
 * their own defining file, and `/jobs/[id]` mounted `<ChordOverlay jobId>`
 * WITHOUT `positionSec`, so the chord playhead was inert. This component owns
 * the one engine instance for a job and joins those parts together.
 *
 * Product source of truth: `claude/user-stories-play-along-2026-11-10.md` v2.0.
 * Story numbers below refer to it; where it and the TSD disagree on product
 * behaviour, the user stories win.
 *
 * ── Why the engine is observed with subscribe + setState, not
 *    useSyncExternalStore ─────────────────────────────────────────────────────
 *
 * ⚠️ CORRECTED 2026-11-11 after review MEASURED the thing this comment used to
 * predict. The earlier version of this note claimed `useSyncExternalStore`
 * would produce "a render loop clocked by React rather than by the frame
 * scheduler". That is FALSE and was measured false: side by side against the
 * same engine and the same stems, `subscribe` + `setState` rendered 54 times a
 * second and `useSyncExternalStore` 55, a ratio of 1.02, with rAF at 60/s in
 * both. React 18 coalesces the post-commit re-render into the next frame, so
 * there is no runaway. A false prediction left in a comment invites the next
 * maintainer to test it, find it false, and throw out a decision that is
 * nonetheless correct — so here is the real reasoning.
 *
 * TWO REAL REASONS, neither of them throughput:
 *
 * 1. `getSnapshot()` is not a pure cached read: it calls `rebuild()`, which
 *    reads the clock AND ASSIGNS `this.snapshot` (engine.ts ~699-731).
 *    `useSyncExternalStore` calls the accessor several times per pass — once in
 *    render, again in the post-commit consistency check, again from
 *    `handleStoreChange` — so React's own consistency machinery would be
 *    driving engine state mutation. The identity property the hook needs then
 *    holds only by arithmetic (`snapshotsEqual`'s 10 ms
 *    `POSITION_EPSILON_SEC`) rather than by construction, which is a thin
 *    thing to rest a framework contract on.
 *
 *    ⚠️ What this reason is NOT: an earlier version of this note claimed React
 *    logs `Warning: The result of getSnapshot should be cached to avoid an
 *    infinite loop` "on every pass" and that "a console warning on every frame
 *    of playback is not shippable". Both are false, and review measured them
 *    false. React guards that warning with a MODULE-SCOPED
 *    `didWarnUncachedGetSnapshot` flag (react-dom.development.js 15971-15991,
 *    16044-16051), so it can fire at most ONCE PER PAGE LOAD, and the whole
 *    block is dev-only — it is absent from a production build. Nor does this
 *    engine reliably trip it: the check calls `getSnapshot()` twice
 *    back-to-back and compares with `Object.is`, and `rebuild()` returns the
 *    PREVIOUS object whenever `snapshotsEqual` holds, so two reads microseconds
 *    apart are identity-equal unless they happen to straddle a 10 ms epsilon
 *    boundary. Measured over real playback: 0-1 warnings per page load, never
 *    per frame. Reason 2 is the one that actually decides this.
 *
 * 2. `useSyncExternalStore`'s actual guarantee is TEAR-SAFETY under concurrent
 *    rendering — that two components reading the same store in one pass see one
 *    consistent value. A clock-derived snapshot cannot provide that: two reads
 *    microseconds apart are entitled to differ. So the guarantee is void here
 *    whichever hook is used, and the API buys nothing. THIS TREE ACCEPTS
 *    NON-TEAR-SAFETY: Transport, Mixer and ChordOverlay all read from the one
 *    `snapshot` value captured once per render in this component, so they can
 *    never disagree with each other even though the underlying clock moves.
 *
 * `subscribe` has no read-check at all: the engine emits only from its own
 * rAF-driven frame loop and from a state change, `emit()` is a no-op when the
 * rebuilt snapshot is identity-equal to the last one, and React then bails out
 * of the re-render by `Object.is`. The engine does hold that identity property
 * (`getSnapshot()` returns the SAME object while nothing has changed), pinned
 * by tests in test/play-player.test.mjs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ChordOverlay } from '@/components/ChordOverlay';
import { createPlayEngine } from '@/lib/play/engine';
import { StemLoadError, loadStems, type StemLoadErrorCode } from '@/lib/play/load-stems';
import { deriveSections, type SectionLoopRow } from '@/lib/play/sections';
import type {
  EngineSnapshot,
  LoopRegion,
  PlayEngine,
  StemName,
  StemState,
} from '@/lib/play/types';

import Mixer from './Mixer';
import { SectionLoop } from './SectionLoop';
import { Transport } from './Transport';
import styles from './Player.module.css';

// ─── copy (exported so node:test can assert it without a DOM) ────────────────

/**
 * Story 5.3. Chrome desktop is launch scope.
 *
 * ⚠️ This copy must NOT reuse the old tab-capture wording from TSD §12.7 /
 * src/chord/tab-capture.ts ("does not support reliable tab-audio capture",
 * "Use Chrome or Edge for the live chord overlay"). That copy is FALSE for this
 * player: nothing here captures a tab, and Edge is not launch scope. A test in
 * test/play-player.test.mjs fails if any of those words come back.
 */
export const UNSUPPORTED_BROWSER_MESSAGE =
  'Play along needs the Web Audio API, which this browser does not provide. ' +
  'Use Chrome on a desktop or laptop. Your loops are still available below.';

/** Story 5.3, reached when every stem decoded to nothing (ENGINE_ERROR.DECODE_FAILED). */
export const UNDECODABLE_MESSAGE =
  'This browser could not decode this track’s audio. ' +
  'Use Chrome on a desktop or laptop. Your loops are still available below.';

/** Story 6.4 — a pre-V3-J2 job legitimately has no retained stems. Not an error. */
export const NO_STEMS_MESSAGE =
  'Play along is not available for this track — it was processed before ' +
  'play-along audio was kept. Your loops are below, as usual.';

export const GENERIC_LOAD_MESSAGE =
  'We could not load the audio for this track. Reload the page to try again.';

const LOAD_MESSAGES: Record<StemLoadErrorCode, string> = {
  RATE_LIMITED:
    "You're going a bit fast, or we're at capacity right now. Give it a minute and reload.",
  NOT_FOUND: 'This track is no longer available — files are deleted after 24 hours.',
  MANIFEST_FAILED: GENERIC_LOAD_MESSAGE,
  MANIFEST_INVALID: GENERIC_LOAD_MESSAGE,
  ABORTED: GENERIC_LOAD_MESSAGE,
};

export function stemLoadMessage(code: StemLoadErrorCode): string {
  return LOAD_MESSAGES[code] ?? GENERIC_LOAD_MESSAGE;
}

/** Title case for prose. Matches Mixer's `stemLabel`, duplicated rather than imported
 *  so this file does not depend on a component another agent is editing. */
function label(stem: StemName): string {
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/**
 * Story 5.1: when a stem is unavailable the player must say WHICH one, and the
 * rest must still play. The per-fader explanation is the Mixer's (it renders
 * `unavailableText` on the disabled channel); this is the summary above the
 * mix, so a user who has not looked at the faders still knows.
 *
 * `null` when nothing is missing — the banner is then not rendered at all.
 */
export function degradedMessage(missing: readonly StemName[] | null | undefined): string | null {
  const names = (missing ?? []).filter((m): m is StemName => typeof m === 'string' && m.length > 0);
  if (names.length === 0) return null;
  const pretty = names.map(label);
  const list =
    pretty.length === 1
      ? pretty[0]
      : `${pretty.slice(0, -1).join(', ')} and ${pretty[pretty.length - 1]}`;
  const verb = pretty.length === 1 ? 'is' : 'are';
  return `${list} ${verb} not available for this track. Every other stem still plays.`;
}

/**
 * Story 5.3 feature detect. Separated from the component and given its scope
 * explicitly so node:test can drive it without a DOM.
 *
 * Deliberately narrow: ONLY the absence of a Web Audio constructor blocks the
 * player up front. A codec probe (`canPlayType('audio/ogg; codecs=opus')`)
 * was considered and rejected — it reports `<audio>` element support, which is
 * not the same promise as `decodeAudioData`, so a false negative there would
 * lock a working browser out of the product. The real codec answer comes from
 * the engine instead, as ENGINE_ERROR.DECODE_FAILED, and is shown as
 * UNDECODABLE_MESSAGE.
 */
export function hasWebAudio(
  scope: { AudioContext?: unknown; webkitAudioContext?: unknown } | null | undefined,
): boolean {
  if (!scope) return false;
  return typeof scope.AudioContext === 'function' || typeof scope.webkitAudioContext === 'function';
}

// ─── phases ──────────────────────────────────────────────────────────────────

export type Phase =
  /** Job not finished yet, or we have not started. */
  | { readonly kind: 'idle' }
  /** Story 5.3. */
  | { readonly kind: 'unsupported'; readonly message: string }
  | { readonly kind: 'loading' }
  /** Story 6.4 — fall back to loops; NOT an error. */
  | { readonly kind: 'no-stems' }
  | { readonly kind: 'load-error'; readonly message: string }
  | { readonly kind: 'ready' };

/**
 * Story 3.3 — the one place the chord playhead's position is decided.
 *
 * Exported and kept free of hooks so `node:test` can drive it with a REAL
 * engine snapshot. This matters: a review mutation set `chordPosition` to a
 * constant `null` and every one of the 939 tests still passed, because the old
 * tests proved only that the prop was WRITTEN, never that a number ever
 * ARRIVED. The prop being present is not the feature; a moving number is.
 *
 * `null` means NOT PLAYABLE — no engine, an engine that failed, an unsupported
 * browser, or a job with no stems. It does NOT mean "paused": a loaded engine
 * sitting at 0 returns 0, so the marker sits on the first chord rather than
 * vanishing.
 */
/**
 * The ONE predicate for "the transport, mixer and section looper may be shown".
 *
 * `playable` in the view and `chordPositionFor` below used to encode this
 * separately, and review found the divergence: dropping `snapshot.error` from
 * `playable` alone survived the whole suite, and the state it breaks is
 * REACHABLE IN PRODUCTION, not hypothetical. `engine.load()` reports
 * TOO_LONG / DECODE_FAILED / NO_STEMS / NO_AUDIO by calling `fail()` and
 * RETURNING rather than throwing (engine.ts 251, 286, 290, 300), so `Player`
 * sets `phase = 'ready'` while `snapshot.error` is set. A >300 s track decodes,
 * `fail(TOO_LONG)` runs, and without this guard the user gets the error banner
 * PLUS a full Transport + Mixer + SectionLoop over an engine with zero buffers
 * and `durationSec 0`, whose `play()` returns early — exactly the "dead control
 * over audio that does not exist" the no-stems test already forbids.
 *
 * Both call sites now derive from here, so they cannot drift again.
 */
export function isPlayable(phase: Phase, snapshot: EngineSnapshot): boolean {
  return phase.kind === 'ready' && snapshot.error === null;
}

export function chordPositionFor(phase: Phase, snapshot: EngineSnapshot): number | null {
  if (!isPlayable(phase, snapshot)) return null;
  return Number.isFinite(snapshot.positionSec) ? snapshot.positionSec : null;
}

const IDLE_SNAPSHOT: EngineSnapshot = Object.freeze({
  status: 'idle',
  positionSec: 0,
  durationSec: 0,
  stems: Object.freeze([]) as readonly StemState[],
  loop: null,
  degraded: null,
  error: null,
});

export interface PlayerProps {
  readonly jobId: string;
  /**
   * The job's `loops` rows, used only to derive loopable sections (Story 4.5).
   * Absent or empty simply means no section chips.
   */
  readonly loops?: readonly SectionLoopRow[] | null;
  /**
   * False until the job reaches `done`. The stems route 404s for a job that is
   * not complete, so nothing is fetched before then.
   */
  readonly enabled?: boolean;
}

export default function Player({ jobId, loops, enabled = true }: PlayerProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(IDLE_SNAPSHOT);
  const engineRef = useRef<PlayEngine | null>(null);

  useEffect(() => {
    if (!enabled) {
      setPhase({ kind: 'idle' });
      return;
    }
    if (!hasWebAudio(globalThis as Parameters<typeof hasWebAudio>[0])) {
      setPhase({ kind: 'unsupported', message: UNSUPPORTED_BROWSER_MESSAGE });
      return;
    }

    const engine = createPlayEngine();
    engineRef.current = engine;
    const unsubscribe = engine.subscribe(setSnapshot);
    setSnapshot(engine.getSnapshot());

    const controller = new AbortController();
    let cancelled = false;
    setPhase({ kind: 'loading' });

    void (async () => {
      try {
        const loaded = await loadStems(jobId, { signal: controller.signal });
        if (cancelled) return;
        if (loaded.sources.length === 0) {
          // Story 6.4. `loadStems` reports "no stems" the same way for a
          // pre-V3-J2 job (the route answers 200 with `state: 'unavailable'`)
          // and for a job whose encoder failed. Both are "no playable audio",
          // and the brief is explicit that this is the FALLBACK trigger, not
          // an error: show the loops, say one calm sentence, and stop.
          setPhase({ kind: 'no-stems' });
          return;
        }
        // `LoadedStems.sources` is `readonly StemSource[]`; `PlayEngine.load`
        // takes a mutable `StemSource[]`. A readonly array is NOT assignable
        // to a mutable one, so this copy is load-bearing, not cosmetic — the
        // seam failed to compile once before on exactly this mismatch.
        await engine.load([...loaded.sources]);
        if (cancelled) return;
        setPhase({ kind: 'ready' });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof StemLoadError) {
          if (e.code === 'ABORTED') return;
          setPhase({ kind: 'load-error', message: stemLoadMessage(e.code) });
          return;
        }
        setPhase({ kind: 'load-error', message: GENERIC_LOAD_MESSAGE });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      unsubscribe();
      engine.dispose();
      engineRef.current = null;
      setSnapshot(IDLE_SNAPSHOT);
    };
  }, [enabled, jobId]);

  // Callbacks go through the ref, so they are referentially stable for the
  // lifetime of the component. Mixer's `Channel` memo and Transport's latest-ref
  // both rely on that; a fresh closure per snapshot would re-render six
  // channels on every frame of playback.
  const onPlay = useCallback(() => engineRef.current?.play(), []);
  const onPause = useCallback(() => engineRef.current?.pause(), []);
  const onSeek = useCallback((positionSec: number) => engineRef.current?.seek(positionSec), []);
  const onGain = useCallback((stem: StemName, gain: number) => engineRef.current?.setGain(stem, gain), []);
  const onMute = useCallback((stem: StemName, muted: boolean) => engineRef.current?.setMute(stem, muted), []);
  const onSolo = useCallback((stem: StemName, soloed: boolean) => engineRef.current?.setSolo(stem, soloed), []);
  const onLoop = useCallback((region: LoopRegion | null) => engineRef.current?.setLoop(region), []);

  const sections = useMemo(
    () => deriveSections(loops ?? null, { durationSec: snapshot.durationSec }),
    [loops, snapshot.durationSec],
  );

  return (
    <PlayerView
      jobId={jobId}
      phase={phase}
      snapshot={snapshot}
      sections={sections}
      onPlay={onPlay}
      onPause={onPause}
      onSeek={onSeek}
      onGain={onGain}
      onMute={onMute}
      onSolo={onSolo}
      onLoop={onLoop}
    />
  );
}

export interface PlayerViewProps {
  readonly jobId: string;
  readonly phase: Phase;
  readonly snapshot: EngineSnapshot;
  readonly sections: readonly LoopRegion[];
  readonly onPlay: () => void;
  readonly onPause: () => void;
  readonly onSeek: (positionSec: number) => void;
  readonly onGain: (stem: StemName, gain: number) => void;
  readonly onMute: (stem: StemName, muted: boolean) => void;
  readonly onSolo: (stem: StemName, soloed: boolean) => void;
  readonly onLoop: (region: LoopRegion | null) => void;
}

/**
 * The whole render, with no hooks and no engine — every phase is therefore
 * reachable from `node:test`, which has no DOM and cannot run React effects.
 *
 * This split exists because of a review finding: four acceptance criteria
 * (Story 1.2's ordering aside) could only be checked by reading source, and
 * four mutations to them — including one that silenced the chord playhead —
 * survived the entire suite. Phases other than `idle` are unreachable through
 * `Player` in a server render, because `Player` only leaves `idle` from an
 * effect. Driving `PlayerView` directly is what makes them assertable.
 */
export function PlayerView({
  jobId,
  phase,
  snapshot,
  sections,
  onPlay,
  onPause,
  onSeek,
  onGain,
  onMute,
  onSolo,
  onLoop,
}: PlayerViewProps) {
  const engineError = snapshot.error;
  // Derived, never re-stated: see `isPlayable`. Re-inlining this predicate is
  // what let `playable` and `chordPositionFor` disagree.
  const playable = isPlayable(phase, snapshot);

  // Story 3.3 / 3.4 — THE WIRING THAT WAS MISSING. The chord playhead reads the
  // engine position and nothing else. See `chordPositionFor`: `null` means NOT
  // PLAYABLE, not "not playing" — a loaded engine paused at 0 passes 0, so the
  // marker sits on the first chord instead of disappearing.
  const chordPosition = chordPositionFor(phase, snapshot);

  const banner = (() => {
    if (phase.kind === 'unsupported') return { tone: 'notice' as const, text: phase.message };
    if (phase.kind === 'no-stems') return { tone: 'notice' as const, text: NO_STEMS_MESSAGE };
    if (phase.kind === 'load-error') return { tone: 'error' as const, text: phase.message };
    if (engineError) {
      // NOT Story 1.4. Story 1.4 is "a track over 300 s is refused AT SUBMIT
      // TIME with a message naming the limit", and submit is not built here —
      // that is open work, not something this file satisfies. What this does is
      // the weaker, honest thing the brief did ask for: a track that somehow
      // reaches the engine over the ceiling surfaces `PLAY_TRACK_TOO_LONG`'s own
      // sentence instead of taking the page down. DECODE_FAILED is the real
      // "this browser cannot play Opus" answer (Story 5.3).
      const text =
        engineError.code === 'PLAY_DECODE_FAILED' ? UNDECODABLE_MESSAGE : engineError.message;
      return { tone: 'error' as const, text };
    }
    return null;
  })();

  const degraded = playable ? degradedMessage(snapshot.degraded?.missing) : null;

  return (
    <section className={styles.root} aria-label="Play along" data-testid="player" data-phase={phase.kind}>
      <header className={styles.head}>
        <h1 className={styles.title}>Play along</h1>
        {phase.kind === 'loading' ? (
          <p className={styles.sub} role="status" aria-live="polite">
            Loading the stems&hellip;
          </p>
        ) : null}
      </header>

      {banner ? (
        <p
          className={banner.tone === 'error' ? styles.error : styles.notice}
          role={banner.tone === 'error' ? 'alert' : 'status'}
          data-testid="player-banner"
        >
          {banner.text}
        </p>
      ) : null}

      {playable ? (
        <>
          {degraded ? (
            <p className={styles.notice} role="status" data-testid="player-degraded">
              {degraded}
            </p>
          ) : null}

          <Transport
            status={snapshot.status}
            positionSec={snapshot.positionSec}
            durationSec={snapshot.durationSec}
            onPlay={onPlay}
            onPause={onPause}
            onSeek={onSeek}
          />

          {/* Story 2.7: `jobId` is what makes the Mixer remember this job's
              fader positions, mutes and solos for the session. */}
          <Mixer stems={snapshot.stems} onGain={onGain} onMute={onMute} onSolo={onSolo} jobId={jobId} />

          <SectionLoop
            sections={sections}
            active={snapshot.loop}
            onLoop={onLoop}
            durationSec={snapshot.durationSec}
          />
        </>
      ) : null}

      {/* Story 3. The chord track stays mounted in EVERY phase, so a job with
          no retained stems (6.4) or an unsupported browser (5.3) still gets the
          chord timeline it got before this component existed. ChordOverlay
          renders its own loading / unavailable / "no chords were detected"
          states, which is Story 3.6. */}
      <div className={styles.chords}>
        <h2 className={styles.subtitle}>Chords</h2>
        <ChordOverlay jobId={jobId} positionSec={chordPosition} />
      </div>
    </section>
  );
}
