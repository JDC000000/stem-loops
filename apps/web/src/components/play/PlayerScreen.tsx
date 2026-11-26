'use client';

/**
 * The play-along SCREEN (design v1.4, P1.1–P1.4 and P2.1; Jon-approved mockups
 * Main.dc.html, NoChords.dc.html, Main360/Main664.dc.html, DesktopPlayer.dc.html).
 *
 * One fixed, non-scrolling screen of exactly 100svh, top to bottom:
 *   compact header (back · song title h1 · "<BPM> BPM · <key> · <artist>" · ⋯)
 *   → CHORD STAGE (the remainder; the one notice bar sits at its top)
 *   → section strip → seek line → transport (⟲ · Play · Loop · Mix).
 * Desktop (≥ 1024 wide): two columns, the mixer always visible on the right.
 *
 * PlayerView (Player.tsx) decides everything that depends on the engine
 * (playability, the chord position, the notice); this component owns only the
 * screen's UI state: the section RUN (P2.1), which sheet is open, the
 * remembered part (DB-13), the chord names for the Mix sheet header.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChordOverlay, type NowNext } from '@/components/ChordOverlay';
import { type ChordMode, DEFAULT_CHORD_MODE, readChordMode, writeChordMode } from '@/lib/play/chord-mode';
import {
  COUNT_IN_NEEDS_BPM,
  type ClickSink,
  type CountIn,
  cancelOnOtherInput,
  countInBpm,
  createClickSink,
  createCountIn,
  readCountIn,
  writeCountIn,
} from '@/lib/play/count-in';
import { readTranspose, transposeBadge, writeTranspose } from '@/lib/play/transpose';
import { TransposeMenuItem } from './TransposeMenuItem';
import { LIGHT_AUDIO_NOTE } from '@/lib/play/device-support';
import { songFacts } from '@/lib/play/notation';
import { type Part, type PresetId, presetOps, readPart, writePart, mixStateLabel } from '@/lib/play/presets';
import {
  NO_RUN,
  RUN_HINT,
  type RunState,
  STRIP_HINT,
  holdChip,
  loopHere,
  nameRegions,
  placeInSong,
  restartTarget,
  runFromRegion,
  runReadout,
  runRegion,
  sameRegion,
  sanitizeRegions,
  sectionAt,
  tapChip,
} from '@/lib/play/sections';
import type { LoopRegion } from '@/lib/play/types';
import type { Notice, PlayerViewProps } from './Player';
import Mixer from './Mixer';
import { MixSheet } from './MixSheet';
import { PartPills } from './PartPills';
import { Presets } from './Presets';
import { SectionLoop } from './SectionLoop';
import { RenameParts } from './RenameParts';
import { applyPartNames, canRenameParts, collectPartNames, readPartNames, writePartNames, type PartNameMap } from '@/lib/play/part-names';
import { Sheet } from './Sheet';
import { Transport } from './Transport';
import styles from './Player.module.css';
import { SetListMenuItems, SetListPicker } from '@/components/setlists/AddToSetList';
import { PLAYBACK_RATES } from '@/lib/play/engine';
import { speedLabel } from '@/lib/play/stretch';
import { SetListNext } from '@/components/setlists/SetListNext';
import setStyles from '@/components/setlists/SetLists.module.css';
import { isSetId, setHref } from '@/lib/set-lists';

export const DEFAULT_BACK = Object.freeze({ href: '/history', label: 'Back to song library' });
/** Song info (P1.5): the one honest caveat about the detected facts. */
export const DETECTED_NOTE = 'Tempo and key are detected automatically and can be off.';
export const NO_CHORDS_LINE = 'No chords for this song.';
/**
 * The one-time hint on a phone (P1.1 notice bar; copy rules: two short
 * sentences, no implementation names). The full note, with the detail, lives
 * in Song info (P1.5 / P7).
 */
export const LIGHT_AUDIO_HINT = 'Phones get lighter audio so all six stems fit. Details in Song info.';
/** The one-time light-audio hint is remembered here once dismissed. */
export const LIGHT_NOTE_SEEN_KEY = 'sl.play.lightNoteSeen.v1';
/** The one-time "Tap to jump · hold to loop" hint (D4) is remembered here once the strip is used. */
export const STRIP_HINT_SEEN_KEY = 'sl.play.sectionHintSeen.v1';
/** P1.4 rule 4 (desktop): two columns, the mixer always visible. Rule 1 (short) wins first. */
export const DESKTOP_QUERY = '(min-width: 1024px) and (min-height: 500px)';
/** How long the one-line set-list result ("Added to JAMS.") stays up. */
export const SET_TOAST_MS = 3000;
/** Shown when the browser refuses to keep the part names (private mode, full storage). */
export const PART_NAMES_NOT_SAVED = 'Names not saved: this browser blocked storage.';

/** The ⋯ button's accessible name lists what its menu holds (QA S8): the
 *  chord items only when the song has chords (#496), speed only when the
 *  engine offers it, Rename parts only when it shows. Menu order. */
export function moreMenuLabel(o: { hasChords: boolean; speed: boolean; renameParts: boolean }): string {
  const items = [
    o.hasChords ? 'all chords' : null,
    o.speed ? 'speed' : null,
    'song info',
    'count-in',
    o.renameParts ? 'rename parts' : null,
    'set lists',
  ].filter(Boolean);
  return `More: ${items.join(', ')}`;
}

/** The `?set=` this page was opened with (a list id or `demo`), or null. Client only. */
export function readSetParam(search: string | null | undefined): string | null {
  if (!search) return null;
  try {
    const v = new URLSearchParams(search).get('set');
    return isSetId(v) ? v : null;
  } catch {
    return null;
  }
}

interface ScreenProps extends PlayerViewProps {
  readonly playable: boolean;
  readonly chordPosition: number | null;
  readonly banner: Notice | null;
}

/**
 * React 18 renders `inert` only as a string attribute (a boolean `true` is
 * dropped with a warning), while @types/react types it as a boolean.
 */
const INERT = { inert: '' } as unknown as { inert: boolean };

/** After the person scrolls the chord area themselves, auto-follow waits this long (F-8). */
export const AUTO_SCROLL_PAUSE_MS = 4000;

/**
 * Scroll `area` (only it: never an ancestor, never the page) so `el` is fully
 * inside its visible box. A no-op when it already is, or when `area` does not
 * scroll. Exported for the unit test.
 */
export function scrollIntoArea(area: HTMLElement, el: Element): void {
  if (!(area.scrollHeight > area.clientHeight)) return;
  const a = area.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < a.top) area.scrollTop += r.top - a.top;
  else if (r.bottom > a.bottom) area.scrollTop += Math.min(r.bottom - a.bottom, r.top - a.top);
}

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const mq = globalThis.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return match;
}

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writeFlag(key: string): void {
  try {
    globalThis.localStorage?.setItem(key, '1');
  } catch {
    /* private mode: the hint simply comes back next time */
  }
}

export function PlayerScreen(props: ScreenProps) {
  const {
    jobId,
    phase,
    snapshot,
    sections: rawSections,
    beatGrid = null,
    lightAudio = false,
    onPlay,
    onPause,
    onPrime,
    onUnprime,
    getEngineLatencySec,
    onSeek,
    onGain,
    onMute,
    onSolo,
    onLoop,
    onRetry,
    onSpeed,
    title,
    bpm,
    musicalKey,
    artist,
    back = DEFAULT_BACK,
    songInfo = [],
    // `loopsHref` is no longer rendered (Phase A): the play-along player does
    // not link to the loops product, which stays reachable from Account/nav.
    onBack,
    playable,
    chordPosition,
    banner,
  } = props;

  // ── sections and the run (P2.1) ────────────────────────────────────────────
  const sections = useMemo(() => sanitizeRegions(rawSections, snapshot.durationSec || undefined), [rawSections, snapshot.durationSec]);
  // D2: neutral names ("Part 3") + the start time + a cycling colour per section.
  const named = useMemo(() => nameRegions(sections), [sections]);
  const defaultNames = useMemo(() => named.map((n) => n.name), [named]);
  // Phase C C3: custom part names, this device only (lib/play/part-names).
  const [customNames, setCustomNames] = useState<PartNameMap>({});
  useEffect(() => setCustomNames(readPartNames(jobId)), [jobId]);
  const names = useMemo(() => applyPartNames(defaultNames, sections, customNames), [defaultNames, sections, customNames]);
  const times = useMemo(() => named.map((n) => n.time), [named]);
  const tones = useMemo(() => named.map((n) => n.tone), [named]);
  // The run starts from whatever the engine is looping (a gate or a remount may
  // hand in a loop). After that the screen REMEMBERS the run, but whether it is
  // LOOPING is always the engine's answer (review S3): the UI says "Looping"
  // only while `snapshot.loop` is that run's span. An engine that refuses the
  // loop (too short, clamped) or a new engine after "Try again" therefore never
  // leaves the strip claiming a loop the audio is not doing.
  const [run, setRun] = useState<RunState>(() => {
    const r = runFromRegion(sections, snapshot.loop);
    return r ? { run: r, on: true } : NO_RUN;
  });
  const wanted = run.on ? runRegion(sections, run.run) : null;
  const engineLoops = !!wanted && sameRegion(snapshot.loop, wanted);
  const shown: RunState = { run: run.run, on: engineLoops };
  const [hintSeen, setHintSeen] = useState(false);
  const [hint, setHint] = useState(false);
  // D4: "Tap to jump · hold to loop" until the strip is first used (then remembered).
  // true until the stored flag is read, so a returning visitor never sees it flash.
  const [stripHintSeen, setStripHintSeen] = useState(true);
  useEffect(() => setStripHintSeen(readFlag(STRIP_HINT_SEEN_KEY)), []);
  const stripUsed = () => {
    if (stripHintSeen) return;
    setStripHintSeen(true);
    writeFlag(STRIP_HINT_SEEN_KEY);
  };
  const applyRun = useCallback(
    (next: RunState) => {
      setRun(next);
      onLoop(next.on ? runRegion(sections, next.run) : null);
    },
    [onLoop, sections],
  );
  // A NEW engine (Retry rebuilds it) starts with no loop: hand it the run the
  // user had on, once, when it becomes ready. If it refuses, `shown` says off.
  const phaseKind = phase.kind;
  const runRef = useRef(run);
  runRef.current = run;
  const loopRef = useRef(snapshot.loop);
  loopRef.current = snapshot.loop;
  useEffect(() => {
    if (phaseKind !== 'ready') return;
    const r = runRef.current;
    const region = r.on ? runRegion(sections, r.run) : null;
    if (region && !sameRegion(loopRef.current, region)) onLoop(region);
    // Only on entering `ready` (a load or a retry), not on every loop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseKind]);
  const playingNow = snapshot.status === 'playing';

  // ── count-in (Phase C C2; story 4.8) ───────────────────────────────────────
  // Optional, off by default, remembered per browser. One bar of clicks (4 beats
  // at the song's BPM) before playback starts from a chip tap, a long-press loop
  // start, ⟲ (while playing) or Play from pause. Never on a loop wrap: the wrap
  // is the engine's native loop and does not come through here. Any other tap or
  // key during the count cancels it.
  const bpmNum = countInBpm(bpm);
  const [countInOn, setCountInOn] = useState(false);
  useEffect(() => setCountInOn(readCountIn()), []);
  const countInReady = countInOn && bpmNum !== null;
  const [countBeat, setCountBeat] = useState<number | null>(null);
  const countRef = useRef<CountIn | null>(null);
  // ONE click AudioContext per player: the sink owns it, opens it on the first
  // click (inside the tap) and closes it here on unmount.
  const sinkRef = useRef<ClickSink | null>(null);
  useEffect(() => {
    const sink = createClickSink();
    sinkRef.current = sink;
    return () => {
      sink.close?.();
      sinkRef.current = null;
    };
  }, []);
  const unprimeRef = useRef(onUnprime);
  unprimeRef.current = onUnprime;
  const engineLatRef = useRef(getEngineLatencySec);
  engineLatRef.current = getEngineLatencySec;
  // #387 F5: the count follows the slow-down rate (60 / (BPM x rate) per beat).
  // The rate actually PLAYING (a pending change has not taken effect yet).
  const rateRef = useRef(snapshot.playbackRate ?? 1);
  rateRef.current = snapshot.playbackRate ?? 1;
  useEffect(() => {
    const c = createCountIn({
      bpm: bpmNum,
      onBeat: setCountBeat,
      clicks: sinkRef.current ?? undefined,
      timing: () => ({ clickLatencySec: sinkRef.current?.latencySec?.() ?? 0, engineLatencySec: engineLatRef.current?.() ?? 0 }),
      rate: () => rateRef.current,
      onCancel: () => unprimeRef.current?.(),
    });
    countRef.current = c;
    return () => {
      c.cancel();
      countRef.current = null;
    };
  }, [bpmNum]);
  const toggleCountIn = () => {
    if (bpmNum === null) return;
    const next = !countInOn;
    setCountInOn(next);
    writeCountIn(next);
    if (!next) countRef.current?.cancel();
  };
  /**
   * Run `go` (seek + play) after the count-in, or at once when it is off or the
   * song has no tempo. While counting, the engine is paused: `before` is the
   * seek, done now so the playhead already shows where the music will start.
   */
  const counted = (before: (() => void) | null, go: () => void): void => {
    const c = countRef.current;
    if (!countInReady || !c) {
      before?.();
      go();
      return;
    }
    if (playingNow) onPause();
    // Synchronous, inside the tap: the click context (opened and resumed by the
    // first scheduled click) and the player's priming (audio session, element,
    // engine context). Only the transport start waits for the count. start()
    // first: it cancels a count already running, and that cancel must not undo
    // the priming below.
    c.start(go);
    onPrime?.();
    before?.();
  };
  // While the numbers are up, any other tap or key press cancels the count.
  const counting = countBeat !== null;
  useEffect(() => {
    const c = countRef.current;
    if (!counting || !c) return undefined;
    return cancelOnOtherInput(c);
  }, [counting]);
  // Play from pause (button, Space, Replay, the Mix sheet's Play): count in first.
  const onPlayCounted = () => {
    const c = countRef.current;
    if (countInReady && c) {
      if (c.swallowPlay()) return; // the click of the tap that just cancelled the count
      if (c.active) {
        c.cancel(true);
        return;
      }
    }
    counted(null, onPlay);
  };

  // D4: a TAP jumps to the section and plays (a loop that was on goes off);
  // a tap on a chip of the running loop stops the loop.
  const onTap = (i: number) => {
    stripUsed();
    setHint(false);
    const { state, jump } = tapChip(shown, i);
    if (state.run !== shown.run || state.on !== shown.on) applyRun(state);
    const target = sections[i];
    if (jump && target) {
      if (countInReady) {
        counted(() => onSeek(target.startSec), onPlay);
      } else {
        onSeek(target.startSec);
        if (!playingNow) onPlay();
      }
    }
  };
  // D4: a HOLD loops; held while looping, it extends or shrinks the run (P2).
  const onLongPress = (i: number) => {
    stripUsed();
    const { state, extended } = holdChip(shown, i);
    const region = state.on ? runRegion(sections, state.run) : null;
    // A loop START only: a hold that extends or shrinks a loop that is already
    // playing keeps the music going, exactly as before. The count pauses a playing
    // song BEFORE the loop is installed (no blip of the new loop).
    const countLoop = countInReady && !!region && !(playingNow && shown.on);
    if (countLoop && playingNow) onPause();
    if (state.run !== shown.run || state.on !== shown.on) applyRun(state);
    if (extended && !hintSeen) {
      setHint(true);
      setHintSeen(true);
    } else {
      setHint(false);
    }
    if (countLoop && region) counted(() => onSeek(region.startSec), onPlay);
    else if (!playingNow) onPlay();
  };
  // The Loop button: loop the section under the playhead (or resume the run).
  const currentSection = sectionAt(sections, snapshot.positionSec);
  const onToggleLoop = () => {
    setHint(false);
    applyRun(loopHere(shown, currentSection));
  };
  const runOn = shown.on && !!shown.run;
  const band = runOn ? snapshot.loop : null;
  // ⟲ back to the start of this section (the loop's start while looping); play state is kept.
  const onRestart = () => {
    const to = restartTarget(sections, runOn ? snapshot.loop : null, snapshot.positionSec);
    // Count-in only when it is playing (a paused ⟲ just moves the playhead).
    if (countInReady && playingNow) counted(() => onSeek(to), onPlay);
    else onSeek(to);
  };
  // The first-use hint is drawn on the strip's top edge (SectionLoop firstHint),
  // above the chips, so it costs the chord stage no height and never sits next
  // to the "my part" pills (where "hold" solos: PR #331 r2 M-1). The run hint
  // stays under the strip.
  const firstHint = !stripHintSeen && sections.length > 0 ? STRIP_HINT : '';

  // ── the mix (P1.3) ─────────────────────────────────────────────────────────
  const [part, setPart] = useState<Part | null>(null);
  useEffect(() => setPart(readPart()), []);
  const onPart = (p: Part) => {
    setPart(p);
    writePart(p);
  };
  const onPreset = (id: PresetId, p: Part) => {
    for (const op of presetOps(id, p, snapshot.stems)) {
      if (op.soloed !== undefined) onSolo(op.stem, op.soloed);
      if (op.gain !== undefined) onGain(op.stem, op.gain);
      if (op.muted !== undefined) onMute(op.stem, op.muted);
    }
  };
  const desktop = useMedia(DESKTOP_QUERY);
  const [mixOpen, setMixOpen] = useState(false);
  const mixButton = useRef<HTMLButtonElement | null>(null);
  const [nowNext, setNowNext] = useState<NowNext | null>(null);
  const onNowNext = useCallback((v: NowNext | null) => setNowNext(v), []);

  // ── sheets and the ⋯ menu ──────────────────────────────────────────────────
  const [menuOpen, setMenuOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const first = menuRef.current?.querySelector<HTMLElement>('button, a');
    first?.focus();
    const onDoc = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node) && e.target !== menuButton.current) setMenuOpen(false);
    };
    globalThis.document?.addEventListener('pointerdown', onDoc);
    return () => globalThis.document?.removeEventListener('pointerdown', onDoc);
  }, [menuOpen]);

  // ── the one-time light-audio hint (P1.1 notice bar; then Song info) ────────
  // false until the stored flag is read: the flag is read in this component's
  // mount effect, which runs before Player's (children first) sets lightAudio,
  // so a returning visitor never sees the note flash.
  const [lightSeen, setLightSeen] = useState(false);
  useEffect(() => setLightSeen(readFlag(LIGHT_NOTE_SEEN_KEY)), []);
  const notice: Notice | null =
    banner ?? (playable && lightAudio && !lightSeen ? { tone: 'notice', text: LIGHT_AUDIO_HINT, testId: 'player-light-audio' } : null);
  const dismissible = !banner && notice !== null;

  // ── Simple / Detailed chords (Phase A, D6) ─────────────────────────────────
  // Simple until the stored choice is read (after mount, so the server render
  // and the first client render agree).
  const [chordMode, setChordMode] = useState<ChordMode>(DEFAULT_CHORD_MODE);
  useEffect(() => setChordMode(readChordMode()), []);
  const pickChordMode = (m: ChordMode) => {
    setChordMode(m);
    writeChordMode(m);
  };
  const simplify = chordMode === 'simple';

  // ── Capo / transpose (Phase C, C4) ─────────────────────────────────────────
  // Display only, per job; 0 until the stored choice is read (after mount).
  // The control shows only when the song has chords (reported by the overlay).
  const [transpose, setTranspose] = useState(0);
  useEffect(() => setTranspose(readTranspose(jobId)), [jobId]);
  const pickTranspose = (n: number) => {
    setTranspose(n);
    writeTranspose(jobId, n);
  };
  const [hasChords, setHasChords] = useState(false);
  const onHasChords = useCallback((v: boolean) => setHasChords(v), []);
  const badge = hasChords ? transposeBadge(transpose) : '';

  // ── set lists (#322, Phase B B2) ───────────────────────────────────────────
  // ?set=<id> (read after mount, so the server render and the first client render agree)
  // shows "Next song ›" under the header and points the back link at the set.
  const [setId, setSetId] = useState<string | null>(null);
  useEffect(() => setSetId(readSetParam(globalThis.location?.search)), []);
  const [setInfo, setSetInfo] = useState<{ id: string; name: string } | null>(null);
  const onSet = useCallback((s: { id: string; name: string }) => setSetInfo(s), []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [setToast, setSetToast] = useState<string | null>(null);
  useEffect(() => {
    if (!setToast) return;
    const t = setTimeout(() => setSetToast(null), SET_TOAST_MS);
    return () => clearTimeout(t);
  }, [setToast]);
  const backLink = setInfo ? { href: setHref(setInfo.id), label: `Back to ${setInfo.name}` } : back;
  const backClick = setInfo ? undefined : onBack;

  // ── header facts ───────────────────────────────────────────────────────────
  const facts = songFacts(bpm, musicalKey);
  const songTitle = (title ?? '').trim() || 'Your song';

  // ── QA A-03: keep the current bar in view when the chord area scrolls ──────
  // In short landscape (844x390, 800x360) a line of stacked bars can be taller
  // than the chord area, which then scrolls (Player.module.css). Bring the
  // current bar fully into view when it changes, or when the chord changes (a
  // new Now name re-sizes what is above it) — only the chord area moves, never
  // the page.
  // Review of #301, F-8:
  //   * no layout read on a render where neither changed: the key below is a
  //     DOM query and a string compare, so steady playback reads no geometry;
  //   * a person scrolling the chord area themselves (wheel, touch, keys, the
  //     scrollbar) pauses the follow for AUTO_SCROLL_PAUSE_MS; the first render
  //     after the pause re-checks, so playback then catches up.
  const chordsRef = useRef<HTMLDivElement | null>(null);
  const followKey = useRef<{ bar: Element | null; now: string | null } | null>(null);
  const userScrolledAt = useRef(-Infinity);
  const onUserScroll = useCallback(() => {
    userScrolledAt.current = Date.now();
  }, []);
  useEffect(() => {
    // A rotation or resize changes what fits: re-check on the next render.
    const reset = () => {
      followKey.current = null;
    };
    globalThis.addEventListener?.('resize', reset);
    return () => globalThis.removeEventListener?.('resize', reset);
  }, []);
  useEffect(() => {
    const box = chordsRef.current;
    if (!box) return;
    if (Date.now() - userScrolledAt.current < AUTO_SCROLL_PAUSE_MS) return;
    const bar = box.querySelector('[role="group"][aria-current="true"]');
    const now = nowNext?.now ?? null;
    const last = followKey.current;
    if (last && last.bar === bar && last.now === now) return;
    followKey.current = { bar, now };
    if (bar) scrollIntoArea(box, bar);
  });

  const place = placeInSong(sections, beatGrid, chordPosition);
  const whereText =
    place.section >= 0
      ? `${names[place.section]}${place.bar !== null ? ` · bar ${place.bar}` : ''}`
      : null;

  const playing = snapshot.status === 'playing';
  const togglePlay = () => (playing ? onPause() : onPlayCounted());

  const presets = (idPrefix: string) => (
    <Presets stems={snapshot.stems} part={part} onPreset={onPreset} onPart={onPart} idPrefix={idPrefix} />
  );

  // P1.2: no chords -> the section name large, bar/beat, one line, the presets.
  const emptyStage = (reason: string | null) => (
    <div className={styles.noChords} data-testid="no-chords">
      <span className={styles.stageLabel}>Now playing</span>
      <span className={styles.noChordsSection} data-testid="no-chords-section">
        {place.section >= 0 ? names[place.section] : songTitle}
      </span>
      {place.bar !== null ? (
        <span className={styles.noChordsBar} data-testid="no-chords-bar">
          {`bar ${place.bar} / ${place.bars} · beat ${place.beat}`}
        </span>
      ) : null}
      <p className={styles.noChordsLine}>{NO_CHORDS_LINE}</p>
      {reason ? (
        // Why (the provider's own copy: never "failed for this track"; a load
        // failure says to refresh). A status, not live chatter: it appears once.
        <p className={styles.noChordsReason} role="status" data-testid="completed-job-message">
          {reason}
        </p>
      ) : null}
      {playable && !desktop ? <div className={styles.noChordsPresets}>{presets('stage-presets')}</div> : null}
    </div>
  );

  return (
    <section
      className={styles.root}
      aria-label="Play along"
      data-testid="player"
      data-phase={phase.kind}
      data-player-fullscreen=""
      data-layout={desktop ? 'desktop' : 'phone'}
    >
      <header className={styles.head}>
        <a
          className={styles.back}
          href={backLink.href}
          aria-label={backLink.label}
          // The home page's demo layer (Slice 2a) closes in place instead of reloading
          // the page it is already on. The href stays, so the link still works without JS.
          onClick={
            backClick
              ? (e) => {
                  e.preventDefault();
                  backClick();
                }
              : undefined
          }
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span className={styles.backText}>{backLink.label}</span>
        </a>
        <div className={styles.titles}>
          <h1 className={styles.title} data-testid="player-title">
            {songTitle}
          </h1>
          {facts || artist || badge ? (
            <span className={badge ? `${styles.sub} ${styles.subWrap}` : styles.sub}>
              {/* Phase A (J3): BPM and key in a 20px chip, readable from a
                  music stand at 70 cm. One source: jobs.bpm / jobs.musical_key. */}
              {facts ? (
                <span className={styles.facts} data-testid="player-facts">
                  <span className={styles.sr}>Detected: </span>
                  {facts.text}
                </span>
              ) : null}
              {artist ? <span className={styles.artist}>{artist}</span> : null}
              {/* .subWrap (badge only): when the badge does not fit it takes its own line. */}
              {badge ? (
                <span className={styles.capoBadge} data-testid="capo-indicator">
                  {badge}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        <div className={styles.menuWrap}>
          <button
            ref={menuButton}
            type="button"
            className={styles.more}
            aria-label={moreMenuLabel({
              hasChords,
              speed: Boolean(onSpeed),
              renameParts: canRenameParts(playable, sections.length),
            })}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-controls="player-menu"
            onClick={() => setMenuOpen((o) => !o)}
            onKeyDown={(e) => {
              // Escape on the ⋯ button itself closes its menu first (and not a
              // non-modal Mix sheet behind it).
              if (e.key === 'Escape' && menuOpen) {
                e.preventDefault();
                setMenuOpen(false);
              }
            }}
            data-testid="player-more"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </button>
          {menuOpen ? (
            <div
              id="player-menu"
              ref={menuRef}
              className={styles.menu}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault(); // the menu used the key: a non-modal Mix sheet stays open
                  setMenuOpen(false);
                  menuButton.current?.focus();
                }
              }}
            >
              {/* #496: the chord items, like Capo / transpose below, show only
                  when the song has chords (reported by the overlay). */}
              {hasChords ? (
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    setMenuOpen(false);
                    setChartOpen(true);
                  }}
                >
                  See all chords
                </button>
              ) : null}
              {hasChords ? (
                <div className={styles.menuGroup} role="group" aria-labelledby="player-chord-mode">
                  <span id="player-chord-mode" className={styles.menuLabel}>
                    Chords
                  </span>
                  <div className={styles.segmented}>
                    {(['simple', 'detailed'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={styles.segment}
                        aria-pressed={chordMode === m}
                        onClick={() => pickChordMode(m)}
                        data-testid={`chord-mode-${m}`}
                      >
                        {m === 'simple' ? 'Simple' : 'Detailed'}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {onSpeed ? (
                <div className={styles.menuGroup} role="group" aria-labelledby="player-speed" data-testid="speed-group">
                  {/* Phase C C1 (Beta): pitch-kept slow-down. 50% is not offered. */}
                  <span id="player-speed" className={styles.menuLabel}>
                    Speed <span className={styles.beta}>Beta</span>
                  </span>
                  <div className={`${styles.segmented} ${styles.segmented3}`}>
                    {PLAYBACK_RATES.map((r) => (
                      <button
                        key={r}
                        type="button"
                        className={styles.segment}
                        aria-pressed={(snapshot.playbackRate ?? 1) === r}
                        aria-busy={snapshot.speedPending && (snapshot.playbackRate ?? 1) !== r ? true : undefined}
                        onClick={() => onSpeed(r)}
                        data-testid={`speed-${Math.round(r * 100)}`}
                      >
                        {`${Math.round(r * 100)}%`}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {hasChords ? <TransposeMenuItem value={transpose} onChange={pickTranspose} /> : null}
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  setMenuOpen(false);
                  setInfoOpen(true);
                }}
              >
                Song info
              </button>
              <div className={styles.countInItem} data-testid="count-in-item">
                <button
                  type="button"
                  className={styles.menuItem}
                  aria-pressed={countInReady}
                  disabled={bpmNum === null}
                  aria-describedby="player-count-in-note"
                  onClick={toggleCountIn}
                  data-testid="count-in-toggle"
                >
                  <span className={styles.countInName}>Count-in</span>
                  <span className={styles.countInState}>{countInReady ? 'On' : 'Off'}</span>
                </button>
                <span id="player-count-in-note" className={styles.menuLabel}>
                  {bpmNum === null ? COUNT_IN_NEEDS_BPM : 'One bar of clicks before it plays.'}
                </span>
              </div>
              {canRenameParts(playable, sections.length) ? (
                <button
                  type="button"
                  className={styles.menuItem}
                  data-testid="menu-rename-parts"
                  onClick={() => {
                    setMenuOpen(false);
                    setRenameOpen(true);
                  }}
                >
                  Rename parts
                </button>
              ) : null}
              <SetListMenuItems
                jobId={jobId}
                itemClassName={styles.menuItem}
                onClose={() => setMenuOpen(false)}
                onOpenPicker={() => setPickerOpen(true)}
                onMessage={setSetToast}
              />
            </div>
          ) : null}
        </div>
      </header>

      {setId ? <SetListNext setId={setId} jobId={jobId} onSet={onSet} /> : null}

      {/* While the non-modal Mix sheet is open, what it covers (pills, chips,
          transport) and the stage above it are inert: visible, but not in the
          Tab order and not tappable, so focus never lands under the sheet and a
          tap on a chord cannot open the editor half behind it (review M3/M4). */}
      <div className={styles.body} {...(mixOpen && !desktop ? INERT : {})} data-testid="player-body">
        <div className={styles.main}>
          <div className={styles.stage}>
            {notice ? (
              <div className={notice.tone === 'error' ? styles.error : styles.notice} data-testid="player-notice">
                <p
                  className={styles.noticeText}
                  role={notice.tone === 'error' ? 'alert' : 'status'}
                  data-testid={notice.testId ?? 'player-banner'}
                  id="player-notice-text"
                >
                  {notice.text}
                </p>
                {notice.retry && onRetry ? (
                  <button type="button" className={styles.retry} onClick={onRetry} data-testid="player-retry">
                    Try again
                  </button>
                ) : null}
                {dismissible ? (
                  <button
                    type="button"
                    className={styles.dismiss}
                    aria-label="Dismiss"
                    onClick={() => {
                      setLightSeen(true);
                      writeFlag(LIGHT_NOTE_SEEN_KEY);
                    }}
                  >
                    {'×'}
                  </button>
                ) : null}
              </div>
            ) : null}
            {countBeat !== null ? (
              // Neutral numbers (amber is only the current chord). No animation at all, so
              // reduced motion needs no special case; a polite live region says it once.
              <div className={styles.countIn} data-testid="count-in" data-beat={countBeat} role="status" aria-label={`Count-in ${countBeat}`}>
                <span className={styles.countInNum} aria-hidden="true">
                  {countBeat}
                </span>
              </div>
            ) : null}
            {/* Story 3. The chord stage stays mounted in EVERY phase, so a job
                with no retained stems (6.4) or an unsupported browser (5.3)
                still shows its chords. */}
            <div
              className={styles.chords}
              ref={chordsRef}
              data-testid="player-harmony-track"
              onWheel={onUserScroll}
              onTouchMove={onUserScroll}
              onPointerDown={onUserScroll}
              onKeyDown={onUserScroll}
            >
              <ChordOverlay
                jobId={jobId}
                view="stage"
                positionSec={chordPosition}
                beatGrid={beatGrid}
                sections={sections}
                loop={snapshot.loop}
                emptyStage={emptyStage}
                onNowNext={onNowNext}
                simplify={simplify}
                transpose={transpose}
                musicalKey={musicalKey}
                onHasChords={onHasChords}
                playing={playing}
              />
            </div>
          </div>

          {playable ? (
            <>
              <SectionLoop
                names={names}
                times={times}
                tones={tones}
                current={sectionAt(sections, chordPosition ?? snapshot.positionSec)}
                state={shown}
                onTap={onTap}
                onLongPress={onLongPress}
                hint={hint && runOn ? RUN_HINT : null}
                firstHint={firstHint || null}
              />
              {/* Phase A D5: lower, mute and solo a part in one tap/hold, chords still on screen.
                  Below the section strip, just above the transport: the strip's "+N more"
                  cue sits on the strip's top edge, over the stage, and must not cover a pill. */}
              {desktop ? null : <PartPills stems={snapshot.stems} onGain={onGain} onMute={onMute} onSolo={onSolo} reasonId={notice?.testId === 'player-degraded' ? 'player-notice-text' : null} />}
              <Transport
                status={snapshot.status}
                positionSec={snapshot.positionSec}
                durationSec={snapshot.durationSec}
                onPlay={onPlayCounted}
                onPause={onPause}
                onSeek={onSeek}
                ticks={sections.slice(1).map((r: LoopRegion) => r.startSec)}
                tickTones={tones.slice(1)}
                onRestart={onRestart}
                loopBand={band}
                speedLabel={speedLabel(snapshot.playbackRate)}
                loopText={runReadout(names, sections, shown)}
                loopState={sections.length === 0 ? 'disabled' : shown.on ? 'on' : 'off'}
                onToggleLoop={onToggleLoop}
                mix={
                  desktop
                    ? null
                    : {
                        label: mixStateLabel(snapshot.stems),
                        open: mixOpen,
                        onOpen: () => setMixOpen(true),
                        buttonRef: (el) => {
                          mixButton.current = el;
                        },
                      }
                }
              />
            </>
          ) : null}
        </div>

        {playable && desktop ? (
          <aside className={styles.aside} aria-labelledby="mix-h">
            <h2 id="mix-h" className={styles.asideTitle}>
              Mix
            </h2>
            {presets('desk-presets')}
            <div className={styles.asideMixer}>
              {/* Story 2.7: `jobId` is what makes the Mixer remember this job's
                  fader positions, mutes and solos for the session. */}
              <Mixer stems={snapshot.stems} onGain={onGain} onMute={onMute} onSolo={onSolo} jobId={jobId} />
            </div>
            <button type="button" className={styles.asideButton} onClick={() => setChartOpen(true)}>
              Show all chords
            </button>
          </aside>
        ) : null}
      </div>

      {playable && !desktop ? (
        <MixSheet
          open={mixOpen}
          onClose={() => setMixOpen(false)}
          returnFocus={() => mixButton.current}
          jobId={jobId}
          stems={snapshot.stems}
          onGain={onGain}
          onMute={onMute}
          onSolo={onSolo}
          part={part}
          onPreset={onPreset}
          onPart={onPart}
          nowNext={nowNext}
          whereText={nowNext ? null : whereText}
          playing={playing}
          canPlay={snapshot.durationSec > 0}
          onTogglePlay={togglePlay}
        />
      ) : null}

      <Sheet
        open={chartOpen}
        onClose={() => setChartOpen(false)}
        labelledBy="chart-title"
        returnFocus={() => (desktop ? null : menuButton.current)}
        testId="chart-sheet"
      >
        <div className={styles.sheetHead}>
          <h2 id="chart-title" className={styles.sheetTitle}>
            All chords
          </h2>
          <button type="button" className={styles.sheetClose} onClick={() => setChartOpen(false)} data-autofocus>
            Close
          </button>
        </div>
        <div className={styles.sheetBody}>
          <ChordOverlay
            jobId={jobId}
            view="chart"
            positionSec={chordPosition}
            beatGrid={beatGrid}
            sections={sections}
            loop={snapshot.loop}
            simplify={simplify}
            transpose={transpose}
            musicalKey={musicalKey}
            playing={playing}
          />
        </div>
      </Sheet>

      <SetListPicker
        jobId={jobId}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        returnFocus={() => menuButton.current}
        onMessage={setSetToast}
      />
      {setToast ? (
        <p className={`${setStyles.toast} ${styles.toast}`} role="status" data-testid="set-toast">
          {setToast}
        </p>
      ) : null}

      <RenameParts
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        returnFocus={() => menuButton.current}
        defaults={defaultNames}
        current={names}
        times={times}
        onSave={(drafts) => {
          const next = collectPartNames(drafts, sections, defaultNames);
          const saved = writePartNames(jobId, next);
          setCustomNames(next);
          // Quota or private mode: the names show now but will not survive a reload. Say so.
          if (!saved) setSetToast(PART_NAMES_NOT_SAVED);
          setRenameOpen(false);
        }}
      />

      <Sheet open={infoOpen} onClose={() => setInfoOpen(false)} labelledBy="info-title" returnFocus={() => menuButton.current} testId="info-sheet">
        <div className={styles.sheetHead}>
          <h2 id="info-title" className={styles.sheetTitle}>
            Song info
          </h2>
          <button type="button" className={styles.sheetClose} onClick={() => setInfoOpen(false)} data-autofocus>
            Close
          </button>
        </div>
        <div className={styles.sheetBody}>
          <p className={styles.infoTitle}>{songTitle}</p>
          {facts ? <p className={styles.info}>{facts.text}</p> : null}
          <p className={styles.info}>{DETECTED_NOTE}</p>
          {lightAudio ? <p className={styles.info}>{LIGHT_AUDIO_NOTE}</p> : null}
          {songInfo.map((line) => (
            <p key={line} className={styles.info} data-testid="song-info-line">
              {line}
            </p>
          ))}
        </div>
      </Sheet>
    </section>
  );
}

export default PlayerScreen;
