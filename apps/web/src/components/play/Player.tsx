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
 * `useSyncExternalStore` re-reads `getSnapshot()` during render AND again in a
 * passive effect, and schedules another render whenever the two differ. The
 * engine's `positionSec` is derived from `AudioContext.currentTime` at the
 * moment it is read (engine.ts `livePosition()`), and `snapshotsEqual` treats
 * any movement of 10 ms or more as a change (`POSITION_EPSILON_SEC`). While
 * playing, a render pass and the effect that follows it are easily 10 ms apart,
 * so the post-commit check finds a different snapshot, renders again, and finds
 * a different snapshot again — a render loop clocked by React rather than by
 * the frame scheduler.
 *
 * `subscribe` has no such read-check: the engine emits only from its own
 * rAF-driven frame loop and from a state change, and `emit()` is a no-op when
 * the rebuilt snapshot is identity-equal to the last one. React then bails out
 * of the re-render by `Object.is` for free. So the update rate is bounded by
 * the engine's clock, which is what we want.
 *
 * (The engine does hold the identity property `useSyncExternalStore` requires —
 * `getSnapshot()` returns the SAME object while nothing has changed; that is
 * pinned by a test in test/play-player.test.mjs. The loop risk above is about
 * the clock, not about identity.)
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

type Phase =
  /** Job not finished yet, or we have not started. */
  | { readonly kind: 'idle' }
  /** Story 5.3. */
  | { readonly kind: 'unsupported'; readonly message: string }
  | { readonly kind: 'loading' }
  /** Story 6.4 — fall back to loops; NOT an error. */
  | { readonly kind: 'no-stems' }
  | { readonly kind: 'load-error'; readonly message: string }
  | { readonly kind: 'ready' };

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

  const engineError = snapshot.error;
  const playable = phase.kind === 'ready' && engineError === null;

  // Story 3.3 / 3.4 — THE WIRING THAT WAS MISSING. The chord playhead reads the
  // engine position and nothing else. `null` means "not playing": no marker, no
  // auto-scroll, and the timeline renders exactly as it did before this prop
  // existed, which is what every non-playable phase wants.
  const chordPosition = playable ? snapshot.positionSec : null;

  const banner = (() => {
    if (phase.kind === 'unsupported') return { tone: 'notice' as const, text: phase.message };
    if (phase.kind === 'no-stems') return { tone: 'notice' as const, text: NO_STEMS_MESSAGE };
    if (phase.kind === 'load-error') return { tone: 'error' as const, text: phase.message };
    if (engineError) {
      // Story 1.4: a track over the ceiling is refused with the engine's own
      // sentence rather than crashing the page. DECODE_FAILED is the real
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
