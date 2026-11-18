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

import {
  createBackgroundOutput,
  routeLatencySec,
  setPlaybackAudioSession,
  wireAudioResume,
  wireMediaSession,
  type BackgroundOutput,
  type MediaSessionWiring,
} from '@/lib/play/background-audio';
import { playbackProfile, readDeviceSignals } from '@/lib/play/device-support';
import { createWakeLock } from '@/lib/play/wake-lock';
import { createPlayEngine } from '@/lib/play/engine';
import {
  StemLoadError,
  loadStems,
  zeroSourceReason,
  type StemLoadErrorCode,
  type ZeroSourceReason,
} from '@/lib/play/load-stems';
import { reportStemFetchFailure } from '@/lib/play/report-failure';
import { type BeatGrid, beatGridFromLoops, deriveSections, type SectionLoopRow } from '@/lib/play/sections';
import type {
  EngineSnapshot,
  LoopRegion,
  PlayEngine,
  StemName,
  StemState,
} from '@/lib/play/types';

import { PlayerScreen } from './PlayerScreen';

// ─── copy (exported so node:test can assert it without a DOM) ────────────────

/**
 * Story 5.3 — the ONE device-level fallback left (Jon, 2026-11-15: the product
 * must work on phones). Only a browser with no Web Audio at all lands here; a
 * phone with Web Audio gets the player, with lighter audio (device-support.ts).
 *
 * ⚠️ This copy must NOT reuse the old tab-capture wording from TSD §12.7 /
 * src/chord/tab-capture.ts ("does not support reliable tab-audio capture",
 * "Use Chrome or Edge for the live chord overlay"). That copy is FALSE for this
 * player: nothing here captures a tab, and Edge is not launch scope. A test in
 * test/play-player.test.mjs fails if any of those words come back.
 */
export const UNSUPPORTED_BROWSER_MESSAGE =
  'Play along needs the Web Audio API, which this browser does not provide. ' +
  'Open this page in an up-to-date browser such as Chrome, on a phone or a computer. ' +
  'Your loops are still on the Download loops page.';

/**
 * Story 5.3, reached when every stem decoded to nothing (ENGINE_ERROR.DECODE_FAILED).
 * Stems are Ogg/Opus. Older Safari versions cannot decode that container, which
 * is the most likely way to land here on an iPhone, so "update" is the honest
 * first step and Chrome is the one we have tested.
 */
export const UNDECODABLE_MESSAGE =
  'This browser could not decode this track’s audio. ' +
  'Update it to the latest version, or open this page in Chrome. Your loops are still on the Download loops page.';

/**
 * Story 6.4 — nothing was stored for this job (`state: 'unavailable'`). Not an
 * error. Deliberately says nothing about WHY: the old wording ("it was processed
 * before play-along audio was kept") asserted a cause that is true of a legacy job
 * and false of a fresh one, and the route cannot tell the two apart.
 */
export const NO_STEMS_MESSAGE =
  'Play along is not available for this track — no play-along audio was kept for it. ' +
  'Your loops are on the Download loops page.';

/**
 * `state: 'encode_failed'` — the stems were separated and uploaded for download,
 * and converting them for playback failed. A fault, not a fallback, and NOT a
 * reload-fixes-it one: it will answer the same until the track is submitted again.
 */
export const ENCODE_FAILED_MESSAGE =
  'We separated this track but could not prepare its audio for play along. ' +
  'Your loops are on the Download loops page. To retry, add the track again on the home page. It counts as a new track.';

/** Stems were offered and the browser never got a response (CORS / CSP / offline). */
export const FETCH_NETWORK_MESSAGE =
  'Your browser could not reach the storage that holds this track’s audio, so play along ' +
  'cannot start. Check your connection and try again. If it keeps happening on a working ' +
  'connection, the fault is on our end. Your loops are on the Download loops page.';

/** Stems were offered and storage answered with an error status. */
export const FETCH_HTTP_MESSAGE =
  'Our storage would not hand over this track’s audio files, so play along cannot start. ' +
  'Try again in a moment. Your loops are on the Download loops page.';

/** Stems were offered, storage answered 200, and the bytes were unusable. */
export const FETCH_BODY_MESSAGE =
  'This track’s audio files arrived empty or incomplete, so play along cannot start. ' +
  'Try again. Your loops are on the Download loops page.';

export const GENERIC_LOAD_MESSAGE =
  'We could not load the audio for this track. Reload the page to try again.';

/**
 * The manifest request never produced a response at all — `fetch` rejected.
 * Offline, DNS, a CSP block. The only case where the user's own connection is a
 * reasonable thing to ask them about.
 */
export const MANIFEST_UNREACHABLE_MESSAGE =
  'We could not reach our servers to start play along. Check your connection and try again.';

/**
 * The manifest request DID get a response, and it was an error status.
 *
 * `MANIFEST_FAILED` used to be one sentence for both, which made the 5xx case a
 * lie: `/api/jobs/:id/stems` answering 500 (INTERNAL_ERROR) or 502
 * (STEM_LIST_FAILED, its own deliberately-loud R2-list fault) told the user to
 * check their wifi for a fault that is entirely ours. The status is carried on
 * `StemLoadError.status`, so the split costs nothing but saying it.
 */
export const MANIFEST_SERVER_ERROR_MESSAGE =
  'Our server could not start play along for this track. This is on our end, not your connection. ' +
  'Try again in a moment. Your loops are on the Download loops page.';

const LOAD_MESSAGES: Record<StemLoadErrorCode, string> = {
  RATE_LIMITED:
    // F72: the stems manifest is throttled per client only (checkStemListRate); capacity is a separate code.
    "You're sending requests too fast. Wait a minute and reload.",
  NOT_FOUND: 'This track is no longer available. On Free, files are deleted after 24 hours.',
  MANIFEST_FAILED: MANIFEST_UNREACHABLE_MESSAGE,
  MANIFEST_INVALID: GENERIC_LOAD_MESSAGE,
  ABORTED: GENERIC_LOAD_MESSAGE,
};

/** Codes where trying again can help. NOT_FOUND cannot; RATE_LIMITED needs time first. */
const RETRYABLE_CODES: ReadonlySet<StemLoadErrorCode> = new Set<StemLoadErrorCode>(['MANIFEST_FAILED', 'MANIFEST_INVALID']);

/**
 * `status` is `StemLoadError.status`: the status of the response the loader got,
 * or `undefined` when there was no response (the loader only sets it where one
 * existed — see `fetchManifest`). THAT is the split, not a status range: "did a
 * server answer us?" is the only question whose answer we actually know, and a
 * 403 from a misconfigured edge is no more the user's connection than a 500 is.
 */
export function stemLoadMessage(code: StemLoadErrorCode, status?: number): string {
  if (code === 'MANIFEST_FAILED') {
    return typeof status === 'number' ? MANIFEST_SERVER_ERROR_MESSAGE : MANIFEST_UNREACHABLE_MESSAGE;
  }
  return LOAD_MESSAGES[code] ?? GENERIC_LOAD_MESSAGE;
}

/**
 * What to tell the user when a load RETURNED no playable stem. One reason, one
 * sentence; `null` means "the calm Story 6.4 fallback, not an error".
 */
export function zeroSourceNotice(
  reason: ZeroSourceReason,
): { readonly message: string; readonly retryable: boolean } | null {
  switch (reason) {
    case 'ENCODE_FAILED':
      return { message: ENCODE_FAILED_MESSAGE, retryable: false };
    case 'FETCH_NETWORK':
      return { message: FETCH_NETWORK_MESSAGE, retryable: true };
    case 'FETCH_HTTP':
      return { message: FETCH_HTTP_MESSAGE, retryable: true };
    case 'FETCH_BODY':
      return { message: FETCH_BODY_MESSAGE, retryable: true };
    default:
      return null;
  }
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
  | { readonly kind: 'load-error'; readonly message: string; readonly retryable?: boolean }
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
 * Both call sites derive from here, and THE GUARANTEE THAT BUYS IS
 * ONE-DIRECTIONAL. Stated precisely, because an earlier draft of this comment
 * claimed they "cannot drift again" and review showed that is too strong:
 * re-inlining a STRICTER predicate — `isPlayable(phase, snapshot) &&
 * snapshot.stems.length > 0` — survives the whole suite with typecheck clean,
 * and makes `playable` and `chordPositionFor` genuinely disagree.
 *
 * What this extraction does close is the LOOSENING direction, which is the
 * dangerous one: dropping a condition here can no longer drop it from one call
 * site only, and dropping it from both is caught by the `ready` + engine-error
 * render case and the phase/error agreement test. A stricter re-inline is
 * currently behaviour-equivalent — the state it would diverge on (ready, no
 * error, zero stems) is UNREACHABLE, because `loadStems` returning
 * `sources.length === 0` sets `phase = 'no-stems'` before `ready` (see ~286-293
 * below) and a failing `engine.load` sets `snapshot.error`. So it is a latent
 * inconsistency, not a live defect. Do not restate the guarantee as absolute.
 */
export function isPlayable(phase: Phase, snapshot: EngineSnapshot): boolean {
  return phase.kind === 'ready' && snapshot.error === null;
}

export function chordPositionFor(phase: Phase, snapshot: EngineSnapshot, latencySec = 0): number | null {
  if (!isPlayable(phase, snapshot)) return null;
  if (!Number.isFinite(snapshot.positionSec)) return null;
  // Story 8 — on the phone route the engine clock runs ahead of what is heard
  // by `latencySec` (routeLatencySec in background-audio.ts). Only WHILE
  // PLAYING: a paused or ended position is where the audio stopped, not ahead
  // of it. Desktop passes 0, so its behaviour is exactly the old one.
  if (snapshot.status === 'playing' && Number.isFinite(latencySec) && latencySec > 0) {
    const heard = snapshot.positionSec - latencySec;
    // QA C-11 — the engine position is already folded into the loop, so just
    // after a wrap `heard` lands BEFORE the loop head, on the previous
    // section's chord. What is heard then is the END of the loop: fold the
    // latency back into the region. Only when the span exceeds the latency,
    // so the fold is a single step.
    const loop = snapshot.loop;
    if (loop && heard < loop.startSec && snapshot.positionSec >= loop.startSec && snapshot.positionSec < loop.endSec) {
      const span = loop.endSec - loop.startSec;
      if (span > latencySec) return loop.endSec - (loop.startSec - heard);
    }
    return Math.max(0, heard);
  }
  return snapshot.positionSec;
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
  /** Shown on the lock screen / notification (Media Session), and as the player's h1. */
  readonly title?: string | null;
  /** The rest of the header and Song info; see PlayerViewProps. */
  readonly bpm?: number | string | null;
  readonly musicalKey?: string | null;
  readonly artist?: string | null;
  readonly back?: { readonly href: string; readonly label: string };
  readonly songInfo?: readonly string[];
  readonly loopsHref?: string | null;
  /** See PlayerViewProps.onBack. */
  readonly onBack?: () => void;
}

/** Lock-screen artwork. The app icon; it exists in /public. */
export const MEDIA_ARTWORK_URL = '/apple-touch-icon.png';
export const MEDIA_ARTIST = 'stem-loops';
export const MEDIA_FALLBACK_TITLE = 'Your track';
/**
 * When to re-read the route latency after a start, in ms. Chromium was probed
 * reporting outputLatency 0 in the tap and 0.032 by +200 ms after a resume.
 */
export const LATENCY_RESAMPLE_MS = [250, 1000] as const;

export default function Player({
  jobId,
  loops,
  enabled = true,
  title,
  bpm,
  musicalKey,
  artist,
  back,
  songInfo,
  loopsHref,
  onBack,
}: PlayerProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(IDLE_SNAPSHOT);
  const [lightAudio, setLightAudio] = useState(false);
  /** Seconds the chord clock is held back on the phone route; 0 on desktop. */
  const [chordLatencySec, setChordLatencySec] = useState(0);
  const engineRef = useRef<PlayEngine | null>(null);
  /** The phone output route; null on the desktop path. */
  const outputRef = useRef<BackgroundOutput | null>(null);
  const titleRef = useRef(title);
  titleRef.current = title;
  // Bumped by "Try again"; re-runs the load effect below.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setPhase({ kind: 'idle' });
      return;
    }
    if (!hasWebAudio(globalThis as Parameters<typeof hasWebAudio>[0])) {
      setPhase({ kind: 'unsupported', message: UNSUPPORTED_BROWSER_MESSAGE });
      return;
    }
    // Story 8. Nothing is blocked: phones, touch-only tablets and low-memory
    // devices get a lighter decode and the background-capable output route.
    // Desktop gets exactly the engine it had (48 kHz, ctx.destination).
    const profile = playbackProfile(readDeviceSignals(globalThis));
    setLightAudio(profile.reason !== null);

    // The engine is referenced by the output's external-pause callback before
    // it exists; the ref is read at call time, never at wiring time.
    const output = profile.backgroundOutput
      ? createBackgroundOutput(globalThis.document, { onExternalPause: () => engineRef.current?.pause() })
      : null;
    if (output) setPlaybackAudioSession(globalThis.navigator);
    outputRef.current = output;

    const engine = createPlayEngine({
      decodeSampleRate: profile.decodeSampleRate,
      ...(output ? { createOutput: output.createOutput } : {}),
    });
    engineRef.current = engine;

    // Lock-screen / notification controls go through the SAME callbacks as the
    // on-screen transport, so the two cannot disagree.
    const media: MediaSessionWiring | null = wireMediaSession(
      globalThis as Parameters<typeof wireMediaSession>[0],
      {
        title: titleRef.current || MEDIA_FALLBACK_TITLE,
        artist: MEDIA_ARTIST,
        artworkUrl: MEDIA_ARTWORK_URL,
        onPlay: () => {
          outputRef.current?.play();
          engineRef.current?.play();
        },
        onPause: () => {
          engineRef.current?.pause();
          outputRef.current?.pause();
        },
        onSeek: (sec) => engineRef.current?.seek(sec),
        getPosition: () => engine.getSnapshot().positionSec,
        getDuration: () => engine.getSnapshot().durationSec,
      },
    );

    // Chord-clock compensation for the phone route. Read on the playing edge,
    // and READ AGAIN once the context is actually running: on a fresh page the
    // first tap finds it 'suspended', and Chromium reports outputLatency = 0
    // until it runs (review #278 round 2). So: on 'statechange' to running, and
    // re-sampled shortly after each start (also catches a route that fell back
    // to ctx.destination after an async play() refusal).
    const refreshLatency = () => {
      if (engine.getSnapshot().status !== 'playing') return;
      setChordLatencySec(routeLatencySec(engine.audioLatency?.(), !!output?.routed));
    };
    const unsubscribeState = engine.onAudioStateChange?.((state) => {
      if (state === 'running') refreshLatency();
    });
    let resample: ReturnType<typeof setTimeout>[] = [];
    const clearResample = () => {
      for (const t of resample) clearTimeout(t);
      resample = [];
    };

    // Engine → element and lock screen. In the subscription rather than a React
    // effect so a `playing → ended` edge is seen exactly as the engine emits it.
    let wasPlaying = false;
    const unsubscribe = engine.subscribe((s) => {
      setSnapshot(s);
      media?.update(s);
      const playing = s.status === 'playing';
      if (wasPlaying && !playing) output?.pause(); // ended, failed or paused
      // Re-read on every start (and again later, see refreshLatency): the route
      // can fall back to ctx.destination (then 0), and outputLatency is only
      // meaningful once the context runs.
      if (playing && !wasPlaying) {
        refreshLatency();
        if (output) {
          clearResample();
          resample = LATENCY_RESAMPLE_MS.map((ms) => setTimeout(refreshLatency, ms));
        }
      }
      wasPlaying = playing;
    });
    setSnapshot(engine.getSnapshot());

    const stopResume = wireAudioResume(
      { document: globalThis.document, window: globalThis.window },
      () => {
        engine.resumeAudio?.();
        if (engine.getSnapshot().status === 'playing') output?.ensurePlaying();
      },
    );

    const controller = new AbortController();
    let cancelled = false;
    setPhase({ kind: 'loading' });

    void (async () => {
      try {
        const loaded = await loadStems(jobId, { signal: controller.signal });
        if (cancelled) return;
        if (loaded.sources.length === 0) {
          // No playable stem, and no thrown error. The reasons are NOT the same
          // and used to be collapsed into one sentence ("processed before
          // play-along audio was kept"), false for a fresh job: see
          // `zeroSourceReason` for the five of them.
          const reason = zeroSourceReason(loaded);
          const notice = zeroSourceNotice(reason);
          if (notice === null) {
            // Story 6.4: nothing stored. The brief is explicit that this is the
            // FALLBACK trigger, not an error: show the loops and stop.
            setPhase({ kind: 'no-stems' });
            return;
          }
          if (reason === 'FETCH_NETWORK' || reason === 'FETCH_HTTP' || reason === 'FETCH_BODY') {
            reportStemFetchFailure(reason, loaded.stemFailures);
          }
          setPhase({ kind: 'load-error', message: notice.message, retryable: notice.retryable });
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
          setPhase({
            kind: 'load-error',
            message: stemLoadMessage(e.code, e.status),
            retryable: RETRYABLE_CODES.has(e.code),
          });
          return;
        }
        setPhase({ kind: 'load-error', message: GENERIC_LOAD_MESSAGE, retryable: true });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      stopResume();
      clearResample();
      unsubscribeState?.();
      unsubscribe();
      media?.dispose();
      engine.dispose();
      output?.dispose();
      engineRef.current = null;
      outputRef.current = null;
      setSnapshot(IDLE_SNAPSHOT);
    };
  }, [enabled, jobId, attempt]);

  // Callbacks go through the ref, so they are referentially stable for the
  // lifetime of the component. Mixer's `Channel` memo and Transport's latest-ref
  // both rely on that; a fresh closure per snapshot would re-render six
  // channels on every frame of playback.
  // On phones the `<audio>` element must be started inside the tap, BEFORE the
  // engine, or iOS refuses it. On desktop `outputRef` is null and this is the
  // old one-liner.
  const onPlay = useCallback(() => {
    outputRef.current?.play();
    engineRef.current?.play();
  }, []);
  const onPause = useCallback(() => {
    engineRef.current?.pause();
    outputRef.current?.pause();
  }, []);
  const onSeek = useCallback((positionSec: number) => engineRef.current?.seek(positionSec), []);
  const onGain = useCallback((stem: StemName, gain: number) => engineRef.current?.setGain(stem, gain), []);
  const onMute = useCallback((stem: StemName, muted: boolean) => engineRef.current?.setMute(stem, muted), []);
  const onSolo = useCallback((stem: StemName, soloed: boolean) => engineRef.current?.setSolo(stem, soloed), []);
  const onLoop = useCallback((region: LoopRegion | null) => engineRef.current?.setLoop(region), []);
  const onRetry = useCallback(() => setAttempt((n) => n + 1), []);

  // P1.2 — Screen Wake Lock while playing, released on pause or end, so the
  // phone does not dim mid-song. Feature-detected: where it is missing or
  // refused nothing changes (lib/play/wake-lock.ts).
  const wakeRef = useRef<ReturnType<typeof createWakeLock> | null>(null);
  useEffect(() => {
    const lock = createWakeLock(globalThis.navigator, globalThis.document);
    wakeRef.current = lock;
    return () => {
      lock.dispose();
      wakeRef.current = null;
    };
  }, []);
  const playing = snapshot.status === 'playing';
  useEffect(() => {
    wakeRef.current?.set(playing);
  }, [playing]);

  const sections = useMemo(
    () => deriveSections(loops ?? null, { durationSec: snapshot.durationSec }),
    [loops, snapshot.durationSec],
  );
  // Phone chord view: bars from the job's tempo (the loops rows carry it).
  const beatGrid = useMemo(() => beatGridFromLoops(loops ?? null), [loops]);

  return (
    <PlayerView
      jobId={jobId}
      phase={phase}
      snapshot={snapshot}
      sections={sections}
      beatGrid={beatGrid}
      lightAudio={lightAudio}
      chordLatencySec={chordLatencySec}
      onPlay={onPlay}
      onPause={onPause}
      onSeek={onSeek}
      onGain={onGain}
      onMute={onMute}
      onSolo={onSolo}
      onLoop={onLoop}
      onRetry={onRetry}
      title={title}
      bpm={bpm}
      musicalKey={musicalKey}
      artist={artist}
      back={back}
      songInfo={songInfo}
      loopsHref={loopsHref}
      onBack={onBack}
    />
  );
}

export interface PlayerViewProps {
  readonly jobId: string;
  readonly phase: Phase;
  readonly snapshot: EngineSnapshot;
  readonly sections: readonly LoopRegion[];
  /** The job's beat grid, for the phone chord view's bars. */
  readonly beatGrid?: BeatGrid | null;
  /** True on the phone / low-memory path: LIGHT_AUDIO_NOTE once as a hint, and always in Song info. */
  readonly lightAudio?: boolean;
  /** Phone route only: how far to hold the chord playhead behind the engine clock while playing. */
  readonly chordLatencySec?: number;
  readonly onPlay: () => void;
  readonly onPause: () => void;
  readonly onSeek: (positionSec: number) => void;
  readonly onGain: (stem: StemName, gain: number) => void;
  readonly onMute: (stem: StemName, muted: boolean) => void;
  readonly onSolo: (stem: StemName, soloed: boolean) => void;
  readonly onLoop: (region: LoopRegion | null) => void;
  /** Offered only on a `load-error` the loader marked retryable. */
  readonly onRetry?: () => void;
  /** The song's name for the header's h1 (P1.1). */
  readonly title?: string | null;
  /** jobs.bpm and jobs.musical_key (GET /api/jobs/[id]); hidden when null. */
  readonly bpm?: number | string | null;
  readonly musicalKey?: string | null;
  /** Artist or uploader, when known (P5 captures titles; until then usually absent). */
  readonly artist?: string | null;
  /** The back arrow: the library when signed in, home when signed out. */
  readonly back?: { readonly href: string; readonly label: string };
  /** Extra Song info lines (the trim note, when the song is deleted). */
  readonly songInfo?: readonly string[];
  /** "Download loops" in the ⋯ menu; omitted when null. */
  readonly loopsHref?: string | null;
  /**
   * When set, the back arrow calls this instead of following `back.href` (the href is
   * still rendered). Used by the home page's demo layer, which closes in place.
   */
  readonly onBack?: () => void;
}

export { DEFAULT_BACK, DETECTED_NOTE, LIGHT_AUDIO_HINT, NO_CHORDS_LINE } from './PlayerScreen';

/**
 * The whole render, with no hooks and no engine — every phase is therefore
 * reachable from `node:test`, which has no DOM and cannot run React effects.
 * The screen's own UI state (the run, which sheet is open, the remembered
 * part) lives one level down, in PlayerScreen, which server-renders with its
 * initial state.
 *
 * This split exists because of a review finding: four acceptance criteria
 * (Story 1.2's ordering aside) could only be checked by reading source, and
 * four mutations to them — including one that silenced the chord playhead —
 * survived the entire suite. Phases other than `idle` are unreachable through
 * `Player` in a server render, because `Player` only leaves `idle` from an
 * effect. Driving `PlayerView` directly is what makes them assertable.
 */
export function PlayerView(props: PlayerViewProps) {
  const { phase, snapshot, chordLatencySec = 0 } = props;
  const engineError = snapshot.error;
  // Derived, never re-stated: see `isPlayable`. Re-inlining this predicate is
  // what let `playable` and `chordPositionFor` disagree. Note the guarantee is
  // one-directional: a stricter re-inline still survives the suite (it is
  // behaviour-equivalent today), so this is about the loosening direction.
  const playable = isPlayable(phase, snapshot);

  // Story 3.3 / 3.4 — THE WIRING THAT WAS MISSING. The chord playhead reads the
  // engine position and nothing else. See `chordPositionFor`: `null` means NOT
  // PLAYABLE, not "not playing" — a loaded engine paused at 0 passes 0, so the
  // marker sits on the first chord instead of disappearing.
  const chordPosition = chordPositionFor(phase, snapshot, chordLatencySec);

  // ONE notice bar at the top of the stage (P1.1): the most important first —
  // error > degraded > loading. Hints (the one-time light-audio note) are
  // PlayerScreen's, below these. Errors keep role="alert", notices "status".
  const banner: Notice | null = (() => {
    if (phase.kind === 'unsupported') return { tone: 'notice', text: phase.message };
    if (phase.kind === 'no-stems') return { tone: 'notice', text: NO_STEMS_MESSAGE };
    if (phase.kind === 'load-error') return { tone: 'error', text: phase.message, retry: !!phase.retryable };
    if (engineError) {
      // NOT Story 1.4. Story 1.4 (revised 2026-11-14) is "a track over 300 s is
      // trimmed by the worker to its first 300 s", so nothing over the ceiling
      // should reach the engine. This is the safety net: a track that somehow
      // reaches the engine over the ceiling surfaces `PLAY_TRACK_TOO_LONG`'s own
      // sentence instead of taking the page down. DECODE_FAILED is the real
      // "this browser cannot play Opus" answer (Story 5.3).
      const text = engineError.code === 'PLAY_DECODE_FAILED' ? UNDECODABLE_MESSAGE : engineError.message;
      return { tone: 'error', text };
    }
    const degraded = playable ? degradedMessage(snapshot.degraded?.missing) : null;
    if (degraded) return { tone: 'notice', text: degraded, testId: 'player-degraded' };
    if (phase.kind === 'loading') return { tone: 'notice', text: 'Loading the stems…', testId: 'player-loading' };
    return null;
  })();

  return <PlayerScreen {...props} playable={playable} chordPosition={chordPosition} banner={banner} />;
}

export interface Notice {
  readonly tone: 'notice' | 'error';
  readonly text: string;
  readonly retry?: boolean;
  readonly testId?: string;
}
