'use client';

/**
 * The play-along SCREEN (design v1.4, P1.1–P1.4 and P2.1; Jon-approved mockups
 * Main.dc.html, NoChords.dc.html, Main360/Main664.dc.html, DesktopPlayer.dc.html).
 *
 * One fixed, non-scrolling screen of exactly 100svh, top to bottom:
 *   compact header (back · song title h1 · "<BPM> BPM · <key> · <artist>" · ⋯)
 *   → CHORD STAGE (the remainder; the one notice bar sits at its top)
 *   → section strip → seek line → transport (−5 · Play · +5 · Loop · Mix).
 * Desktop (≥ 1024 wide): two columns, the mixer always visible on the right.
 *
 * PlayerView (Player.tsx) decides everything that depends on the engine
 * (playability, the chord position, the notice); this component owns only the
 * screen's UI state: the section RUN (P2.1), which sheet is open, the
 * remembered part (DB-13), the chord names for the Mix sheet header.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChordOverlay, type NowNext } from '@/components/ChordOverlay';
import { LIGHT_AUDIO_NOTE } from '@/lib/play/device-support';
import { songFacts } from '@/lib/play/notation';
import { type Part, type PresetId, presetOps, readPart, writePart, mixStateLabel } from '@/lib/play/presets';
import {
  NO_RUN,
  type RunState,
  longPressSection,
  nameRegions,
  placeInSong,
  runFromRegion,
  runReadout,
  runRegion,
  sameRegion,
  sanitizeRegions,
  tapSection,
  toggleRunLoop,
} from '@/lib/play/sections';
import type { LoopRegion } from '@/lib/play/types';
import type { Notice, PlayerViewProps } from './Player';
import Mixer from './Mixer';
import { MixSheet } from './MixSheet';
import { Presets } from './Presets';
import { SectionLoop } from './SectionLoop';
import { Sheet } from './Sheet';
import { Transport } from './Transport';
import styles from './Player.module.css';

export const DEFAULT_BACK = Object.freeze({ href: '/history', label: 'Back to library' });
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
/** P1.4 rule 4 (desktop): two columns, the mixer always visible. Rule 1 (short) wins first. */
export const DESKTOP_QUERY = '(min-width: 1024px) and (min-height: 500px)';

interface ScreenProps extends PlayerViewProps {
  readonly playable: boolean;
  readonly chordPosition: number | null;
  readonly banner: Notice | null;
}

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
    onSeek,
    onGain,
    onMute,
    onSolo,
    onLoop,
    onRetry,
    title,
    bpm,
    musicalKey,
    artist,
    back = DEFAULT_BACK,
    songInfo = [],
    loopsHref = null,
    onBack,
    playable,
    chordPosition,
    banner,
  } = props;

  // ── sections and the run (P2.1) ────────────────────────────────────────────
  const sections = useMemo(() => sanitizeRegions(rawSections, snapshot.durationSec || undefined), [rawSections, snapshot.durationSec]);
  const names = useMemo(() => nameRegions(sections).map((n) => n.name), [sections]);
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
  const onTap = (i: number) => {
    const { state, extended } = tapSection(shown, i);
    applyRun(state);
    if (extended && !hintSeen) {
      setHint(true);
      setHintSeen(true);
    } else {
      setHint(false);
    }
  };
  const onLongPress = (i: number) => {
    setHint(false);
    applyRun(longPressSection(shown, i));
  };
  const onToggleLoop = () => {
    setHint(false);
    applyRun(toggleRunLoop(shown));
  };
  const runOn = shown.on && !!shown.run;
  const band = runOn ? snapshot.loop : null;

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
  const togglePlay = () => (playing ? onPause() : onPlay());

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
          href={back.href}
          aria-label={back.label}
          // The home page's demo layer (Slice 2a) closes in place instead of reloading
          // the page it is already on. The href stays, so the link still works without JS.
          onClick={
            onBack
              ? (e) => {
                  e.preventDefault();
                  onBack();
                }
              : undefined
          }
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span className={styles.backText}>{back.label}</span>
        </a>
        <div className={styles.titles}>
          <h1 className={styles.title} data-testid="player-title">
            {songTitle}
          </h1>
          {facts || artist ? (
            <span className={styles.sub} data-testid="player-facts">
              {facts ? (
                <span className={styles.facts}>
                  <span className={styles.sr}>Detected: </span>
                  {facts.text}
                </span>
              ) : null}
              {facts && artist ? ' · ' : null}
              {artist ? <span>{artist}</span> : null}
            </span>
          ) : null}
        </div>
        <div className={styles.menuWrap}>
          <button
            ref={menuButton}
            type="button"
            className={styles.more}
            aria-label="More: all chords, song info, download loops"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-controls="player-menu"
            onClick={() => setMenuOpen((o) => !o)}
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
                  setMenuOpen(false);
                  menuButton.current?.focus();
                }
              }}
            >
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
              {loopsHref ? (
                <a className={styles.menuItem} href={loopsHref} data-testid="loops-link">
                  Download loops
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.main}>
          <div className={styles.stage}>
            {notice ? (
              <div className={notice.tone === 'error' ? styles.error : styles.notice} data-testid="player-notice">
                <p
                  className={styles.noticeText}
                  role={notice.tone === 'error' ? 'alert' : 'status'}
                  data-testid={notice.testId ?? 'player-banner'}
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
              />
            </div>
          </div>

          {playable ? (
            <>
              <SectionLoop names={names} state={shown} onTap={onTap} onLongPress={onLongPress} hint={hint && runOn} />
              <Transport
                status={snapshot.status}
                positionSec={snapshot.positionSec}
                durationSec={snapshot.durationSec}
                onPlay={onPlay}
                onPause={onPause}
                onSeek={onSeek}
                ticks={sections.slice(1).map((r: LoopRegion) => r.startSec)}
                loopBand={band}
                loopText={runReadout(names, sections, shown)}
                loopState={!shown.run ? 'disabled' : shown.on ? 'on' : 'off'}
                onToggleLoop={onToggleLoop}
                mix={
                  desktop
                    ? null
                    : {
                        label: mixStateLabel(snapshot.stems, part),
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
          <ChordOverlay jobId={jobId} view="chart" positionSec={chordPosition} beatGrid={beatGrid} sections={sections} loop={snapshot.loop} />
        </div>
      </Sheet>

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
          {loopsHref ? (
            <p className={styles.info}>
              <a href={loopsHref} className={styles.link}>
                Download loops
              </a>
            </p>
          ) : null}
        </div>
      </Sheet>
    </section>
  );
}

export default PlayerScreen;
