// The play-along SCREEN (design v1.4, P1.1–P1.4, P2.1; Slice 1a):
// components/play/PlayerScreen.tsx, reached through PlayerView, rendered from
// the REAL module graph (test/helpers/module-graph.mjs). Only ChordOverlay is
// stubbed (it pulls onnxruntime-web): the stub reports which view it was asked
// for and, when told the song has no chords, renders the `emptyStage` it was
// handed — which is exactly what the real overlay does (ChordOverlay.tsx,
// view="stage").
//
// What this cannot cover: layout and paint (no layout engine). The 100svh
// screen, the sheet and the desktop columns are measured in real Chromium by
// packages/web-browser-gate (player-text-size, chord-phone-view).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildModuleGraph } from './helpers/module-graph.mjs';
import { withDom } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

const graph = buildModuleGraph({
  name: 'play-player-screen',
  entries: ['components/play/Player.tsx', 'components/play/Sheet.tsx', 'app/jobs/[id]/JobView.tsx'],
  overrides: {
    'components/ChordOverlay.tsx': `import { createElement, useEffect } from 'react';
      export const ChordOverlay = (props) => {
        useEffect(() => {
          if (props.onNowNext && globalThis.__nowNext) props.onNowNext(globalThis.__nowNext);
        }, [props.onNowNext]);
        useEffect(() => {
          if (props.onHasChords) props.onHasChords(!globalThis.__noChords);
        }, [props.onHasChords]);
        if (props.view === 'stage' && globalThis.__noChords)
          return typeof props.emptyStage === 'function' ? props.emptyStage(globalThis.__noChordsReason ?? null) : props.emptyStage;
        return createElement('div', { 'data-testid': 'chord-overlay', 'data-view': String(props.view), 'data-position': String(props.positionSec), 'data-simplify': String(props.simplify), 'data-transpose': String(props.transpose), 'data-key': String(props.musicalKey), 'data-playing': String(props.playing) });
      };
      export default ChordOverlay;`,
    'lib/play/report-failure.ts': 'export function reportStemFetchFailure() {}',
    'components/JobProgress.tsx': "export function JobProgress() { return null; }",
  },
  packages: {
    'next/link': "import { createElement } from 'react'; export default function Link(p) { return createElement('a', p); }",
  },
});

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const Player = await import(graph.url('components/play/Player.tsx'));
const Sheet = await import(graph.url('components/play/Sheet.tsx'));
const JobViewMod = await import(graph.url('app/jobs/[id]/JobView.tsx'));

const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const SECTIONS = [
  { startSec: 0, endSec: 9, label: 'intro' },
  { startSec: 9, endSec: 47, label: 'verse' },
  { startSec: 47, endSec: 66, label: 'chorus' },
  { startSec: 66, endSec: 104, label: 'verse' },
];
const snap = (over = {}) => ({
  status: 'ready',
  positionSec: 20,
  durationSec: 120,
  stems: STEMS.map((name) => ({ name, availability: 'ready', gain: 0.8, muted: false, soloed: false, effectivelySilent: false })),
  loop: null,
  degraded: null,
  error: null,
  ...over,
});
const noop = () => {};
const viewProps = (over = {}) => ({
  jobId: 'job-1', phase: { kind: 'ready' }, snapshot: snap(), sections: SECTIONS,
  onPlay: noop, onPause: noop, onSeek: noop, onGain: noop, onMute: noop, onSolo: noop, onLoop: noop,
  title: 'Lucky Ticket', bpm: 101.6, musicalKey: 'A# major',
  ...over,
});
const ssr = (over) => renderToStaticMarkup(React.createElement(Player.PlayerView, viewProps(over)));
const decode = (h) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/**
 * A stand-in for Player's engine wiring: `onLoop` is applied to the snapshot
 * the view renders (as the real engine does through setLoop -> subscribe),
 * unless `reject` is set (an engine that refuses the loop). Also records calls.
 */
function EngineEcho({ calls, reject = false, phase = { kind: 'ready' }, loopOverride, positionSec, status, ...over }) {
  const [loop, setLoop] = React.useState(null);
  const shownLoop = loopOverride !== undefined ? loopOverride : loop;
  return React.createElement(Player.PlayerView, viewProps({
    ...over,
    phase,
    snapshot: snap({ loop: shownLoop, ...(positionSec !== undefined ? { positionSec } : {}), ...(status ? { status } : {}) }),
    onLoop: (r) => {
      calls.push(r);
      if (!reject) setLoop(r);
    },
  }));
}

/** Make the desktop query answer `desktop` for the life of one withDom(). */
function setMedia(desktop) {
  globalThis.matchMedia = () => ({ matches: desktop, addEventListener() {}, removeEventListener() {} });
}

// ═══ P1.1 — the layout ═══════════════════════════════════════════════════════

test('P1.1: header → chord stage → section strip → seek line → transport, in that order', () => {
  const h = ssr();
  const at = (re) => h.search(re);
  const order = [/<header/, /data-view="stage"/, /data-testid="section-strip"/, /data-testid="transport-seek"/, /data-testid="transport-play"/];
  const idx = order.map(at);
  assert.ok(idx.every((i) => i >= 0), JSON.stringify(idx));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'out of order');
  assert.match(h, /data-player-fullscreen=""/);
});

test('P1.1 header: back · the song title as THE h1 · "<BPM> BPM · <key>" with sr-only "Detected: " · ⋯', () => {
  const h = decode(ssr());
  assert.equal((h.match(/<h1/g) || []).length, 1);
  assert.match(h, /<h1[^>]*data-testid="player-title"[^>]*>Lucky Ticket<\/h1>/);
  assert.match(h, /<span class="facts" data-testid="player-facts"><span class="sr">Detected: <\/span>102 BPM · B♭ major<\/span>/);
  assert.match(h, /<a class="back" href="\/history" aria-label="Back to song library">/);
  // QA S8: the server render has not heard from the overlay yet (no chords), and no onSpeed here; the 4-part fixture shows Rename parts.
  assert.match(h, /<button[^>]*aria-label="More: song info, count-in, rename parts, set lists"[^>]*aria-expanded="false"/);
  assert.match(decode(ssr({ artist: 'The Royal Sundowners' })), /102 BPM · B♭ major<\/span><span class="artist">The Royal Sundowners<\/span>/);
  // Phase A (J3): the BPM · key chip is 20px, white, readable at 70 cm.
  const css = read('src/components/play/Player.module.css');
  const chip = css.match(/\n\.facts\s*\{([^}]*)\}/)[1];
  assert.match(chip, /font-size:\s*20px;/);
  assert.match(chip, /color:\s*var\(--text-primary\);/);
  assert.doesNotMatch(chip, /accent|chord-now/);
});

test('P1.1 header: BPM and key are hidden when null (no "null BPM", no empty separator)', () => {
  assert.doesNotMatch(ssr({ bpm: null, musicalKey: null }), /player-facts|Detected|BPM/);
  assert.match(decode(ssr({ bpm: null })), /Detected: <\/span>B♭ major</);
  assert.match(decode(ssr({ musicalKey: 'nonsense' })), /Detected: <\/span>102 BPM</);
});

test('the back link: "Back to song library" signed in, "Back to home" signed out, never a compound label', () => {
  assert.deepEqual(JobViewMod.backLink(true), { href: '/history', label: 'Back to song library' });
  assert.deepEqual(JobViewMod.backLink(false), { href: '/', label: 'Back to home' });
  for (const s of [true, false]) assert.doesNotMatch(JobViewMod.backLink(s).label, /\(|\/| or /);
  assert.match(decode(ssr({ back: JobViewMod.backLink(false) })), /href="\/" aria-label="Back to home"/);
  const page = read('src/app/jobs/[id]/page.tsx');
  assert.match(page, /<JobView id=\{params\.id\} signedIn \/>/);
});

test('P1.1: the notice bar sits at the top of the stage; error > degraded > loading; errors are alerts', () => {
  const err = ssr({ phase: { kind: 'load-error', message: 'Boom.', retryable: true }, onRetry: noop });
  assert.match(err, /data-testid="player-notice"><p class="noticeText" role="alert" data-testid="player-banner" id="player-notice-text">Boom\.<\/p><button[^>]*data-testid="player-retry"/);
  assert.ok(err.indexOf('player-notice') < err.indexOf('data-view="stage"'));
  const deg = ssr({ snapshot: snap({ degraded: { missing: ['other'] } }) });
  assert.match(deg, /role="status" data-testid="player-degraded" id="player-notice-text">Other is not available/);
  assert.match(ssr({ phase: { kind: 'loading' }, snapshot: snap({ status: 'loading' }) }), /role="status" data-testid="player-loading" id="player-notice-text">Loading the stems/);
  assert.doesNotMatch(ssr(), /player-notice/, 'nothing to say, no bar');
});

test('P1.1: the one-time light-audio note is a dismissible hint, and always lives in Song info with the detected-facts caveat', async () => {
  const h = decode(ssr({ lightAudio: true }));
  assert.match(h, /data-testid="player-light-audio"/);
  assert.match(h, /aria-label="Dismiss"/);
  const css = read('src/components/play/Player.module.css');
  assert.match(css, /\.dismiss\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
  await withDom(async (dom) => {
    setMedia(false);
    await dom.mount(React.createElement(Player.PlayerView, viewProps({ lightAudio: true })));
    assert.ok(dom.find('[data-testid="player-light-audio"]'));
    await dom.act(() => dom.find('[aria-label="Dismiss"]').click());
    assert.equal(dom.find('[data-testid="player-light-audio"]'), null);
    assert.equal(dom.window.localStorage.getItem('sl.play.lightNoteSeen.v1'), '1');
    // Song info, from the ⋯ menu.
    await dom.act(() => dom.find('[data-testid="player-more"]').click());
    await dom.act(() => [...dom.findAll('#player-menu button')].find((b) => b.textContent === 'Song info').click());
    const info = dom.find('[data-testid="info-sheet"]').textContent;
    assert.match(info, /Tempo and key are detected automatically and can be off\./);
    assert.match(info, /lighter audio/);
    await dom.unmountAll();
  });
});

test('P1.1: viewportFit "cover" is set on /jobs/[id] and, since #360, the root layout (every page pads by the insets)', () => {
  assert.match(read('src/app/jobs/[id]/page.tsx'), /export const viewport: Viewport = \{ viewportFit: 'cover' \};/);
  assert.match(read('src/app/layout.tsx'), /viewportFit: 'cover'/);
  assert.doesNotMatch(read('src/app/jobs/layout.tsx'), /viewportFit/);
});

test('P1.1: one 100svh screen (scrolling only when it cannot fit, see S1) padded by the safe-area insets; it replaces the site nav', () => {
  const css = read('src/components/play/Player.module.css');
  const root = css.match(/\.root\s*\{([^}]*)\}/)[1];
  assert.match(root, /position:\s*fixed;/);
  assert.match(root, /height:\s*100svh;/);
  assert.match(root, /env\(safe-area-inset-top, 0px\) env\(safe-area-inset-right, 0px\) env\(safe-area-inset-bottom, 0px\) env\(safe-area-inset-left, 0px\)/);
  assert.match(read('src/styles/signed-in-nav.css'), /body:has\(\[data-player-fullscreen\]\) \.sin-bar\s*\{\s*display:\s*none;/);
});

test('P1.2: no aria-live anywhere on the screen (DECISION.md:44 — a chord a second would drown a screen reader)', () => {
  for (const h of [ssr(), ssr({ phase: { kind: 'loading' } })]) assert.doesNotMatch(h, /aria-live/);
});

// ═══ P1.2 — no chords ═══════════════════════════════════════════════════════

test('P1.2 no chords: the section name large, bar/beat, "No chords for this song.", the presets in the stage', () => {
  globalThis.__noChords = true;
  try {
    const h = decode(ssr({ beatGrid: { beatSec: 0.5, anchorSec: 0, measured: true }, snapshot: snap({ positionSec: 13.1 }) }));
    assert.match(h, /data-testid="no-chords-section">Part 2<\/span>/, 'D2: neutral section names');
    assert.match(h, /data-testid="no-chords-bar">bar 3 \/ 19 · beat 1<\/span>/);
    assert.match(h, /No chords for this song\./);
    assert.match(h, /data-testid="stage-presets"/);
    assert.ok(h.indexOf('stage-presets') < h.indexOf('section-strip'), 'the presets are IN the stage');
    assert.match(h, /Mute my part[\s\S]*Solo my part[\s\S]*Full song/);
    assert.doesNotMatch(h, /No vocals|Drums \+ bass/, 'Phase A D5: those two presets are gone');
    assert.doesNotMatch(h, /completed-job-message/, 'a song with no chords needs no reason line');
    // Chords UNAVAILABLE: the provider's reason is kept (never "failed for this track").
    globalThis.__noChordsReason = 'Chord detection didn\u2019t return a result for this track. This is usually on our end rather than your song.';
    const u = decode(ssr());
    assert.match(u, /No chords for this song\.<\/p><p class="noChordsReason" role="status" data-testid="completed-job-message">Chord detection didn’t return a result/);
  } finally {
    globalThis.__noChords = false;
    globalThis.__noChordsReason = null;
  }
});

// ═══ P2.1 — runs, through the screen, into the engine ════════════════════════

// D4 (Jon 2026-11-21) through the screen, into the engine. Replaces the P2.1
// "tap = loop" walk-through and the QA C-10 (option b) screen test: a tap now
// JUMPS (seek + play) and never loops, so the C-10 bug (a tap with the loop off
// extending the remembered run) has no path left. The P2 run model moved to
// the hold and is walked here.
const keyHold = (dom, el) => dom.keydown('Enter', { target: el, shiftKey: true });
const pointerTap = (dom, el) => dom.act(() => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));

test('D4 through the screen: tap jumps and plays, hold loops, hold another extends, tap the loop stops it, Loop button resumes, ⟲ restarts', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    try { globalThis.localStorage?.removeItem('sl.play.sectionHintSeen.v1'); } catch { /* none */ }
    const loops = [];
    const seeks = [];
    let plays = 0;
    await dom.mount(React.createElement(EngineEcho, { calls: loops, onSeek: (t) => seeks.push(t), onPlay: () => { plays += 1; } }));
    const chip = (i) => dom.findAll('[data-testid="section-strip"] button')[i];
    const loopBtn = () => dom.find('[data-testid="transport-loop"]');
    const restart = () => dom.find('[data-testid="transport-restart"]');
    const hint = () => dom.find('[data-testid="section-hint"]')?.textContent ?? null;

    const readout = () => dom.find('[data-testid="transport-loop-text"]').textContent;
    const first = () => dom.find('[data-testid="section-first-hint"]')?.textContent ?? null;
    // PR #331 r2 M-1: the one-time hint is drawn on the strip's top edge, inside the
    // strip and BEFORE its chips and the pills; never in the seek readout under the pills.
    assert.equal(first(), 'Tap to jump \u00b7 hold to loop', 'the one-time hint, on the strip, before the strip is used');
    assert.equal(readout(), '', 'not in the seek readout (under the pills, where "hold" solos)');
    assert.equal(hint(), null, 'not an in-flow line under the strip: it costs the chord stage no height');
    {
      const html = dom.find('[data-testid="player"]').innerHTML;
      const at = (t) => html.indexOf(`data-testid="${t}"`);
      assert.ok(at('section-strip') < at('section-first-hint') && at('section-first-hint') < at('part-pills'), 'inside the strip, before the pills row');
      assert.equal(dom.find('[data-testid="section-first-hint"]').closest('[data-testid="part-pills"]'), null);
    }
    assert.equal(loopBtn().getAttribute('aria-disabled'), null, 'with sections, Loop is live: it loops where the playhead is');
    assert.equal(chip(2).textContent, 'Part 3 \u00b7 0:47');

    // TAP: jump + play, nothing looped.
    await pointerTap(dom, chip(2));
    assert.deepEqual(seeks, [47]);
    assert.equal(plays, 1);
    assert.deepEqual(loops, [], 'a tap never loops');
    assert.equal(first(), null, 'the hint goes once the strip is used');
    assert.equal(globalThis.localStorage?.getItem('sl.play.sectionHintSeen.v1'), '1', 'and is remembered');

    // HOLD (long-press): loop that section; the release click is swallowed.
    await dom.pointer('pointerdown', chip(2), { pointerType: 'touch', clientX: 5, clientY: 5 });
    await dom.advance(550);
    await dom.pointer('pointerup', chip(2), { pointerType: 'touch', clientX: 5, clientY: 5 });
    await pointerTap(dom, chip(2));
    assert.deepEqual(loops.at(-1), { startSec: 47, endSec: 66 }, 'hold: loop Part 3');
    assert.equal(chip(2).getAttribute('aria-pressed'), 'true');
    assert.equal(plays, 2, 'a hold while paused starts playback (review L3/M23 on #330)');
    assert.deepEqual(seeks, [47], 'the swallowed release click did not jump');

    // HOLD another while looping: extend (P2) + the one-time run hint.
    await keyHold(dom, chip(1));
    assert.deepEqual(loops.at(-1), { startSec: 9, endSec: 66 }, 'Shift+Enter on Part 2 extends the run');
    assert.match(hint(), /Looping these · hold one to loop it alone/);
    assert.match(dom.find('[data-testid="transport-loop-text"]').textContent, /Looping Part 2 → Part 3 · 0:09–1:06/);
    assert.equal(dom.findAll('[data-testid="section-strip"] button[aria-pressed="true"]').length, 2);
    assert.match(dom.find('[data-testid="section-strip"] legend').textContent, /Tap to jump, hold or Shift\+Enter to loop\. Looping Part 2 to Part 3\./);

    // ⟲ in a loop: back to the loop's start, play state kept.
    await dom.act(() => restart().click());
    assert.deepEqual(seeks.at(-1), 9);

    // TAP a chip of the running loop: the loop stops, no jump, the run is remembered.
    const nSeeks = seeks.length;
    await pointerTap(dom, chip(2));
    assert.equal(loops.at(-1), null, 'tap the looping chip: stop');
    assert.equal(seeks.length, nSeeks, 'no jump');
    assert.equal(dom.find('[data-testid="transport-loop-text"]').textContent, 'Loop off');

    // The Loop button: the playhead (0:20) is inside the remembered run -> it comes back.
    await dom.act(() => loopBtn().click());
    assert.deepEqual(loops.at(-1), { startSec: 9, endSec: 66 });
    await dom.act(() => loopBtn().click());
    assert.equal(loops.at(-1), null);

    // TAP outside a loop that is on: jump there, the loop goes off.
    await keyHold(dom, chip(0));
    assert.deepEqual(loops.at(-1), { startSec: 0, endSec: 9 });
    await pointerTap(dom, chip(3));
    assert.equal(loops.at(-1), null);
    assert.deepEqual(seeks.at(-1), 66);

    // ⟲ with no loop: the start of the section under the playhead (0:20 -> Part 2 at 0:09).
    await dom.act(() => restart().click());
    assert.deepEqual(seeks.at(-1), 9);
    assert.equal(restart().getAttribute('aria-label'), 'Back to the start of this section');
    await dom.unmountAll();
  });
});

test('⟲ through the screen (review L2/M17): inside a multi-section loop it goes to the LOOP start, not the section start', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const loops = [];
    const seeks = [];
    // The playhead at 0:50 is in Part 3 (0:47-1:06), 3 s past its start.
    await dom.mount(React.createElement(EngineEcho, { calls: loops, positionSec: 50, onSeek: (t) => seeks.push(t) }));
    const chip = (i) => dom.findAll('[data-testid="section-strip"] button')[i];
    const restart = () => dom.find('[data-testid="transport-restart"]');
    await dom.act(() => restart().click());
    assert.deepEqual(seeks, [47], 'no loop: the start of Part 3');
    await keyHold(dom, chip(1));
    await keyHold(dom, chip(2));
    assert.deepEqual(loops.at(-1), { startSec: 9, endSec: 66 }, 'looping Part 2 -> Part 3');
    await dom.act(() => restart().click());
    assert.deepEqual(seeks.at(-1), 9, 'looping: the start of the loop (Part 2), not of Part 3');
    await dom.unmountAll();
  });
});

test('hold while PLAYING does not call play again (only a paused hold starts playback)', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const loops = [];
    let plays = 0;
    await dom.mount(React.createElement(EngineEcho, { calls: loops, status: 'playing', onPlay: () => { plays += 1; } }));
    await keyHold(dom, dom.findAll('[data-testid="section-strip"] button')[2]);
    assert.deepEqual(loops.at(-1), { startSec: 47, endSec: 66 });
    assert.equal(plays, 0);
    await dom.unmountAll();
  });
});

test('D4 through the screen: the Loop button with nothing remembered loops the section under the playhead', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const loops = [];
    await dom.mount(React.createElement(EngineEcho, { calls: loops }));
    const loopBtn = () => dom.find('[data-testid="transport-loop"]');
    assert.equal(loopBtn().getAttribute('aria-label'), 'Loop this section');
    await dom.act(() => loopBtn().click());
    assert.deepEqual(loops.at(-1), { startSec: 9, endSec: 47 }, 'the playhead is at 0:20, in Part 2');
    assert.equal(loopBtn().getAttribute('aria-pressed'), 'true');
    await dom.unmountAll();
  });
});

test('D4: with no sections, Loop is disabled and ⟲ goes to the top of the song', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const loops = [];
    const seeks = [];
    await dom.mount(React.createElement(EngineEcho, { calls: loops, sections: [], onSeek: (t) => seeks.push(t) }));
    assert.equal(dom.find('[data-testid="section-strip"]'), null);
    assert.equal(dom.find('[data-testid="transport-loop"]').getAttribute('aria-disabled'), 'true');
    await dom.act(() => dom.find('[data-testid="transport-loop"]').click());
    assert.deepEqual(loops, []);
    await dom.act(() => dom.find('[data-testid="transport-restart"]').click());
    assert.deepEqual(seeks, [0]);
    await dom.unmountAll();
  });
});

// Slice 1b follow-up (review nit on #288): the swallow window used to start on pointerleave
// too. A MOUSE that holds a chip past the long-press, slides off it and back, and lets go
// more than SWALLOW_WINDOW_MS later then had its release click read as a TAP — which on the
// only chip of a run clears the loop it had just set. The window now starts only on
// pointerup / pointercancel. React synthesises onPointerLeave from `pointerout`, so that is
// the event dispatched here.
test('long-press (mouse): sliding off the chip and back does not lose the loop', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const loops = [];
    await dom.mount(React.createElement(EngineEcho, { calls: loops }));
    const chip = (i) => dom.findAll('[data-testid="section-strip"] button')[i];
    const outside = dom.find('[data-testid="section-strip"]');

    await dom.pointer('pointerdown', chip(3), { pointerType: 'mouse', clientX: 5, clientY: 5 });
    await dom.advance(550);
    assert.deepEqual(loops.at(-1), { startSec: 66, endSec: 104 }, 'the long-press fired: loop only this');

    await dom.pointer('pointerout', chip(3), { pointerType: 'mouse', relatedTarget: outside });
    await dom.advance(1500); // well past the 700 ms window
    await dom.pointer('pointerover', chip(3), { pointerType: 'mouse', relatedTarget: outside });
    await dom.pointer('pointerup', chip(3), { pointerType: 'mouse', clientX: 5, clientY: 5 });
    await dom.act(() => chip(3).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
    assert.deepEqual(loops.at(-1), { startSec: 66, endSec: 104 }, 'the release click was swallowed; the loop is kept');
    assert.equal(chip(3).getAttribute('aria-pressed'), 'true');

    // ...and the window still closes after the RELEASE: a later real click is a tap again.
    await dom.advance(800);
    await dom.act(() => chip(3).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
    assert.equal(loops.at(-1), null, 'a click after the window is a tap (on the looping chip: stop the loop)');
    await dom.unmountAll();
  });
});

test('long-press: leaving the chip BEFORE the threshold still cancels it', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const loops = [];
    await dom.mount(React.createElement(EngineEcho, { calls: loops }));
    const chip = (i) => dom.findAll('[data-testid="section-strip"] button')[i];
    const outside = dom.find('[data-testid="section-strip"]');
    await dom.pointer('pointerdown', chip(2), { pointerType: 'mouse', clientX: 5, clientY: 5 });
    await dom.advance(200);
    await dom.pointer('pointerout', chip(2), { pointerType: 'mouse', relatedTarget: outside });
    await dom.advance(600);
    assert.deepEqual(loops, [], 'no long-press after the pointer left');
    await dom.unmountAll();
  });
});

test('review S3 (DOM): an engine that REFUSES the loop never leaves the UI saying "Looping"', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const calls = [];
    await dom.mount(React.createElement(EngineEcho, { calls, reject: true }));
    await keyHold(dom, dom.findAll('[data-testid="section-strip"] button')[1]);
    assert.deepEqual(calls, [{ startSec: 9, endSec: 47 }], 'the run was asked for');
    assert.equal(dom.findAll('[data-testid="section-strip"] button[aria-pressed="true"]').length, 0, 'no chip pressed');
    assert.doesNotMatch(dom.find('[data-testid="transport-loop-text"]').textContent, /Looping/);
    assert.equal(dom.find('[data-testid="transport-loop"]').getAttribute('aria-pressed'), 'false');
    assert.equal(dom.find('[data-testid="transport-loop-band"]'), null, 'no band for a loop that is not there');
    await dom.unmountAll();
  });
});

test('review S3 (DOM): after "Try again" builds a NEW engine, the run is handed to it again', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const calls = [];
    const host = await dom.mount(React.createElement(EngineEcho, { calls }));
    await keyHold(dom, dom.findAll('[data-testid="section-strip"] button')[2]);
    assert.deepEqual(calls.at(-1), { startSec: 47, endSec: 66 });
    // Retry: the view goes back to loading with a fresh engine (no loop) ...
    await dom.rerender(host, React.createElement(EngineEcho, { calls, phase: { kind: 'loading' }, loopOverride: null }));
    const before = calls.length;
    // ... and when the new engine is ready, the screen re-applies the run.
    await dom.rerender(host, React.createElement(EngineEcho, { calls, phase: { kind: 'ready' }, loopOverride: null }));
    assert.equal(calls.length, before + 1, 'the run was not re-applied to the new engine');
    assert.deepEqual(calls.at(-1), { startSec: 47, endSec: 66 });
    // Until the engine reports it, nothing claims to loop.
    assert.equal(dom.findAll('[data-testid="section-strip"] button[aria-pressed="true"]').length, 0);
    await dom.unmountAll();
  });
});

test('P2.1: a loop handed in by the engine shows as the matching run', () => {
  const h = ssr({ snapshot: snap({ loop: { startSec: 9, endSec: 66 } }) });
  assert.equal((h.match(/aria-pressed="true"/g) || []).length >= 2, true);
  assert.match(decode(h), /Looping Part 2 → Part 3 · 0:09–1:06/);
});

// ═══ P1.3 — the Mix sheet ═══════════════════════════════════════════════════

test('P1.3 + D5: the Mix sheet is a NON-MODAL dialog (no aria-modal, no scrim, half height), kept mounted (hidden) so the mix memory restores on load', () => {
  const h = ssr();
  assert.match(h, /<div class="backdrop modeless" hidden="" data-testid="mix-sheet-backdrop" data-modal="false"><div class="sheet" role="dialog" aria-labelledby="mix-title" data-testid="mix-sheet">/);
  assert.doesNotMatch(h.slice(h.indexOf('mix-sheet-backdrop') - 200), /aria-modal/, 'a non-modal dialog must not claim aria-modal');
  const sheetCss = read('src/components/play/Sheet.module.css');
  assert.match(sheetCss, /\.modeless\s*\{[^}]*background:\s*transparent;[^}]*pointer-events:\s*none;/, 'no scrim, and the stage above stays live');
  assert.match(sheetCss, /\.modeless \.sheet\s*\{[^}]*pointer-events:\s*auto;[^}]*max-height:\s*50svh;/, 'half height');
  assert.match(h, /<h2 id="mix-title" class="title">Mix<\/h2>/);
  // The stem rows are real range inputs in the sheet, six of them, in the mixer order.
  const sheet = h.slice(h.indexOf('data-testid="mix-sheet"'));
  assert.deepEqual([...sheet.matchAll(/data-stem="(\w+)" role="group"/g)].map((m) => m[1]), STEMS);
  assert.equal((sheet.match(/<input id="mixer-fader-\w+" class="hfader" type="range"/g) || []).length, 6);
  const css = read('src/components/play/MixSheet.module.css');
  assert.match(css, /\.list\s*\{[^}]*overflow-y:\s*auto/, 'the stem list scrolls');
  assert.match(css, /\.head\s*\{[^}]*flex-shrink:\s*0/, 'the header is pinned');
  assert.match(read('src/components/play/Presets.module.css'), /\.root\s*\{[^}]*flex-shrink:\s*0/, 'the presets are pinned');
  assert.match(read('src/components/play/Presets.module.css'), /\.grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/, 'three presets in one row');
});

test('P1.3 (DOM): Mix opens the sheet, focus moves in, Escape closes it and focus returns to Mix; the header shows Now/Next and play/pause', async () => {
  globalThis.__nowNext = { now: 'F♯m', nowSpoken: 'F sharp minor', next: 'D', nextSpoken: 'D' };
  try {
    await withDom(async (dom) => {
      setMedia(false);
      let plays = 0;
      await dom.mount(React.createElement(Player.PlayerView, viewProps({ onPlay: () => plays++ })));
      const mix = dom.find('[data-testid="transport-mix"]');
      mix.focus();
      await dom.act(() => mix.click());
      const backdrop = dom.find('[data-testid="mix-sheet-backdrop"]');
      assert.equal(backdrop.hidden, false);
      assert.equal(mix.getAttribute('aria-expanded'), 'true');
      assert.equal(dom.document.activeElement.textContent, 'Close', 'focus moved into the sheet');
      assert.equal(dom.find('[data-testid="mix-now"]').textContent, 'F♯m');
      assert.match(dom.find('[data-testid="mix-sheet"]').textContent, /Now F sharp minor, next D/);
      await dom.act(() => dom.find('[data-testid="mix-sheet"] button[aria-label="Play"]').click());
      assert.equal(plays, 1);
      await dom.keydown('Escape', { target: dom.document.activeElement });
      assert.equal(dom.find('[data-testid="mix-sheet-backdrop"]').hidden, true);
      assert.equal(dom.document.activeElement, mix, 'focus returned to Mix');
      await dom.unmountAll();
    });
  } finally {
    globalThis.__nowNext = null;
  }
});

test('focus trap: Tab past the last control wraps to the first, Shift+Tab before the first wraps to the last', () => {
  const { trapTarget } = Sheet;
  const items = ['a', 'b', 'c'];
  assert.equal(trapTarget(items, 'c', false), 'a');
  assert.equal(trapTarget(items, 'a', true), 'c');
  assert.equal(trapTarget(items, 'b', false), null, 'inside: the browser moves focus');
  assert.equal(trapTarget(items, 'b', true), null);
  assert.equal(trapTarget(items, 'zzz', false), 'a', 'focus outside the sheet comes back in');
  assert.equal(trapTarget([], 'a', false), null);
});

test('DB-13 (a) (DOM): the first "Mute my part" asks "Which part do you play?" (Guitar pre-selected), remembers it, then is one tap', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const mutes = [];
    const onMute = (stem, m) => mutes.push([stem, m]);
    await dom.mount(React.createElement(Player.PlayerView, viewProps({ onMute })));
    await dom.act(() => dom.find('[data-testid="transport-mix"]').click());
    const mine = () => dom.find('[data-testid="mix-presets"] button[data-preset="mine"]');
    await dom.act(() => mine().click());
    assert.deepEqual(mutes, [], 'nothing muted before the answer');
    const sheet = dom.find('[data-testid="mix-sheet"]');
    assert.match(sheet.textContent, /Which part do you play\?/);
    const parts = [...sheet.querySelectorAll('[aria-labelledby="mix-presets-ask"] button[aria-pressed]')];
    assert.deepEqual(parts.map((b) => b.textContent), ['Guitar', 'Bass', 'Keys', 'Drums', 'Vocals']);
    assert.equal(parts[0].getAttribute('aria-pressed'), 'true', 'Guitar pre-selected');
    await dom.act(() => parts[1].click());
    await dom.act(() => [...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Mute bass').click());
    assert.deepEqual(mutes, [['bass', true]]);
    assert.equal(dom.window.localStorage.getItem('sl.play.part.v1'), 'bass');
    await dom.unmountAll();
    // A later visit: the part is read back; one tap mutes it.
    mutes.length = 0;
    await dom.mount(React.createElement(Player.PlayerView, viewProps({ onMute })));
    await dom.act(() => dom.find('[data-testid="transport-mix"]').click());
    await dom.act(() => mine().click());
    assert.deepEqual(mutes, [['bass', true]]);
    assert.match(dom.find('[data-testid="mix-sheet"]').textContent, /Your part: Bass\./);
    await dom.unmountAll();
  });
});

test('P1.3 + D5: the Mix button names the mix state ("Guitar 30%", "Guitar solo", "Custom")', () => {
  const at = (over) => {
    const s = snap();
    s.stems = s.stems.map((x) => ({ ...x, gain: 1, ...(over[x.name] ?? {}) }));
    return ssr({ snapshot: s });
  };
  assert.match(at({}), /<span class="mixState">Full song<\/span>/);
  assert.match(at({ guitar: { gain: 0.3 } }), /<span class="mixState">Guitar 30%<\/span>/);
  assert.match(at({ vocals: { muted: true } }), /<span class="mixState">Vocals muted<\/span>/);
  assert.match(at({ guitar: { soloed: true } }), /<span class="mixState">Guitar solo<\/span>/);
  assert.match(at({ guitar: { gain: 0.3 }, bass: { muted: true } }), /<span class="mixState">Custom<\/span>/);
});

// ═══ Phase A D5 — "my part" pills on the play screen ════════════════════════

/**
 * An engine stand-in for the mix: onGain/onMute/onSolo are applied to the
 * snapshot (effectivelySilent resolved as engine.ts does) and recorded.
 * Nothing here can seek or restart: the test asserts no onSeek/onPlay/onPause.
 */
function MixEcho({ calls, unavailable = [], ...over }) {
  const [st, setSt] = React.useState(() =>
    STEMS.map((name) => ({ name, availability: unavailable.includes(name) ? 'unavailable' : 'ready', gain: 1, muted: false, soloed: false })),
  );
  const upd = (stem, patch) => setSt((a) => a.map((x) => (x.name === stem && x.availability === 'ready' ? { ...x, ...patch } : x)));
  const any = st.some((x) => x.soloed);
  const stems = st.map((x) => ({ ...x, effectivelySilent: x.muted || (any && !x.soloed) }));
  return React.createElement(Player.PlayerView, viewProps({
    ...over,
    snapshot: snap({ stems, degraded: unavailable.length ? { missing: unavailable } : null }),
    onGain: (stem, g) => { calls.push(['gain', stem, g]); upd(stem, { gain: g }); },
    onMute: (stem, m) => { calls.push(['mute', stem, m]); upd(stem, { muted: m }); },
    onSolo: (stem, v) => { calls.push(['solo', stem, v]); upd(stem, { soloed: v }); },
    onSeek: () => calls.push(['seek']),
    onPlay: () => calls.push(['play']),
    onPause: () => calls.push(['pause']),
  }));
}

test('D5: the pills sit below the section strip, just above the transport (the strip cue owns the stage edge), Guitar first, one per stem', () => {
  const h = ssr();
  const at = (re) => h.search(re);
  assert.ok(at(/data-view="stage"/) < at(/data-testid="section-strip"/), 'stage, then strip');
  assert.ok(at(/data-testid="section-strip"/) < at(/data-testid="part-pills"/), 'below the section strip');
  assert.ok(at(/data-testid="part-pills"/) < at(/data-testid="transport"/), 'above the transport');
  const pills = h.slice(at(/data-testid="part-pills"/), at(/data-testid="transport"/));
  assert.deepEqual([...pills.matchAll(/data-stem="(\w+)"/g)].map((m) => m[1]), ['guitar', 'bass', 'keys', 'drums', 'vocals', 'other']);
  assert.match(pills, /<legend class="sr">Parts\. Tap a part to step it 100%, 30%, muted\. Hold it, or press S, to solo it\. While a part is soloed, a tap ends the solo\.<\/legend>/);
});

test('D5: no pills on desktop (the mixer column is always there)', async () => {
  await withDom(async (dom) => {
    setMedia(true);
    await dom.mount(React.createElement(Player.PlayerView, viewProps()));
    assert.equal(dom.find('[data-testid="part-pills"]'), null);
    await dom.unmountAll();
  });
});

test('D5 (DOM): a tap cycles Guitar 100% -> 30% -> muted -> 100%; the pill, its aria and the Mix label follow; nothing seeks or restarts', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const calls = [];
    await dom.mount(React.createElement(MixEcho, { calls }));
    const gtr = () => dom.find('[data-testid="part-pills"] button[data-stem="guitar"]');
    const label = () => dom.find('[data-testid="transport-mix"] .mixState').textContent;
    assert.equal(gtr().getAttribute('aria-label'), 'Guitar, 100%');
    assert.equal(gtr().getAttribute('aria-pressed'), 'false');
    assert.equal(label(), 'Full song');

    await dom.act(() => gtr().click());
    assert.deepEqual(calls, [['gain', 'guitar', 0.3]]);
    assert.equal(gtr().textContent, 'Gtr 30%');
    assert.equal(gtr().getAttribute('aria-label'), 'Guitar, 30%');
    assert.equal(gtr().getAttribute('aria-pressed'), 'true');
    assert.equal(label(), 'Guitar 30%');

    calls.length = 0;
    await dom.act(() => gtr().click());
    assert.deepEqual(calls, [['mute', 'guitar', true]]);
    assert.equal(gtr().textContent, 'Gtr muted');
    assert.equal(gtr().getAttribute('aria-label'), 'Guitar, muted');
    assert.equal(label(), 'Guitar muted');

    calls.length = 0;
    await dom.act(() => gtr().click());
    assert.deepEqual(calls, [['gain', 'guitar', 1], ['mute', 'guitar', false]], 'level first, then unmute: never back through 30%');
    assert.equal(gtr().textContent, 'Gtr 100%');
    assert.equal(gtr().getAttribute('aria-pressed'), 'false');
    assert.equal(label(), 'Full song');

    // A second stem changed: the label says Custom.
    await dom.act(() => gtr().click());
    await dom.act(() => dom.find('[data-testid="part-pills"] button[data-stem="vocals"]').click());
    assert.equal(label(), 'Custom');
    await dom.unmountAll();
  });
});

test('D5 (DOM): long-press (500 ms) solos Guitar, its release click is swallowed, and a second long-press un-solos it', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const calls = [];
    await dom.mount(React.createElement(MixEcho, { calls }));
    const pill = (stem) => dom.find(`[data-testid="part-pills"] button[data-stem="${stem}"]`);
    const label = () => dom.find('[data-testid="transport-mix"] .mixState').textContent;
    const hold = async () => {
      await dom.pointer('pointerdown', pill('guitar'), { pointerType: 'touch', clientX: 5, clientY: 5 });
      await dom.advance(550);
      await dom.pointer('pointerup', pill('guitar'), { pointerType: 'touch', clientX: 5, clientY: 5 });
      await dom.act(() => pill('guitar').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
    };
    await hold();
    assert.deepEqual(calls, [['solo', 'guitar', true]], 'the release click did not also step the level');
    assert.equal(pill('guitar').textContent, 'Gtr solo');
    assert.equal(pill('guitar').getAttribute('aria-label'), 'Guitar, solo. Tap to end the solo');
    assert.equal(pill('bass').textContent, 'Bass silent');
    assert.equal(pill('bass').getAttribute('aria-label'), 'Bass, silent while another part is soloed, back at 100% when the solo ends. Tap to end the solo');
    assert.equal(label(), 'Guitar solo');
    calls.length = 0;
    await dom.advance(800);
    await hold();
    assert.deepEqual(calls, [['solo', 'guitar', false]]);
    assert.equal(label(), 'Full song');
    await dom.unmountAll();
  });
});

test('D5 (DOM): a long-press is cancelled when the finger moves (a scroll is not a hold)', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const calls = [];
    await dom.mount(React.createElement(MixEcho, { calls }));
    const gtr = dom.find('[data-testid="part-pills"] button[data-stem="guitar"]');
    await dom.pointer('pointerdown', gtr, { pointerType: 'touch', clientX: 5, clientY: 5 });
    await dom.pointer('pointermove', gtr, { pointerType: 'touch', clientX: 5, clientY: 30 });
    await dom.advance(600);
    assert.deepEqual(calls, []);
    await dom.unmountAll();
  });
});

test('D5 (DOM): keyboard — Enter/Space are a tap (button), S toggles solo; a soloed muted part is unmuted', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const calls = [];
    await dom.mount(React.createElement(MixEcho, { calls }));
    const gtr = () => dom.find('[data-testid="part-pills"] button[data-stem="guitar"]');
    assert.equal(gtr().getAttribute('aria-keyshortcuts'), 'S');
    assert.equal(gtr().tagName, 'BUTTON', 'native button: Enter and Space activate it');
    // keyboard activation dispatches click with detail 0: never swallowed
    await dom.act(() => gtr().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })));
    await dom.act(() => gtr().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })));
    assert.equal(gtr().textContent, 'Gtr muted');
    calls.length = 0;
    // Ctrl/Cmd/Alt+S belong to the browser (save page): never a solo.
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) await dom.keydown('s', { target: gtr(), ...mod });
    assert.deepEqual(calls, [], 'a modified S is not a solo');
    await dom.keydown('s', { target: gtr() });
    // Solo = "listen just to this part": unmuted and at 100%, in one op (solo, gain, mute).
    assert.deepEqual(calls, [['solo', 'guitar', true], ['gain', 'guitar', 1], ['mute', 'guitar', false]]);
    assert.equal(gtr().textContent, 'Gtr solo');
    calls.length = 0;
    await dom.keydown('S', { target: gtr() });
    assert.deepEqual(calls, [['solo', 'guitar', false]]);
    await dom.unmountAll();
  });
});

test('D5 (DOM): a missing stem is a disabled pill with a reason; tapping it does nothing', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const calls = [];
    await dom.mount(React.createElement(MixEcho, { calls, unavailable: ['keys'] }));
    const keys = dom.find('[data-testid="part-pills"] button[data-stem="keys"]');
    assert.equal(keys.getAttribute('aria-disabled'), 'true');
    assert.equal(keys.getAttribute('aria-label'), 'Keys, not available');
    assert.equal(keys.textContent, 'Keys n/a');
    // The reason is the player's notice bar (review M1): no second note under the row.
    assert.equal(keys.getAttribute('aria-describedby'), 'player-notice-text');
    assert.match(dom.find('#player-notice-text').textContent, /^Keys is not available for this track\./);
    assert.equal(dom.find('[data-testid="part-pills-note"]'), null);
    await dom.act(() => keys.click());
    await dom.pointer('pointerdown', keys, { pointerType: 'touch', clientX: 5, clientY: 5 });
    await dom.advance(600);
    await dom.keydown('s', { target: keys });
    assert.deepEqual(calls, []);
    await dom.unmountAll();
  });
});

test('D5 (DOM): presets — "Solo my part" asks once (Guitar pre-selected) then solos; "Full song" undoes a pill level', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const calls = [];
    await dom.mount(React.createElement(MixEcho, { calls }));
    const gtr = () => dom.find('[data-testid="part-pills"] button[data-stem="guitar"]');
    await dom.act(() => dom.find('[data-testid="transport-mix"]').click());
    const preset = (id) => dom.find(`[data-testid="mix-presets"] button[data-preset="${id}"]`);
    assert.deepEqual(dom.findAll('[data-testid="mix-presets"] button[data-preset]').map((b) => b.textContent), ['Mute my part', 'Solo my part', 'Full song']);
    await dom.act(() => preset('solo').click());
    const sheet = dom.find('[data-testid="mix-sheet"]');
    assert.match(sheet.textContent, /Which part do you play\?/);
    await dom.act(() => [...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Solo guitar').click());
    assert.deepEqual(calls, [['solo', 'guitar', true]]);
    assert.equal(preset('solo').getAttribute('aria-pressed'), 'true');
    assert.equal(gtr().textContent, 'Gtr solo');
    await dom.act(() => dom.find('[data-testid="mix-sheet"] button.close').click());
    // Full song: the solo is cleared and a lowered level comes back to 100%.
    await dom.act(() => dom.find('[data-testid="part-pills"] button[data-stem="guitar"]').click()); // ends the solo
    await dom.act(() => dom.find('[data-testid="part-pills"] button[data-stem="bass"]').click()); // bass 30%
    await dom.act(() => dom.find('[data-testid="part-pills"] button[data-stem="guitar"]').click()); // guitar 30%
    await dom.act(() => dom.find('[data-testid="transport-mix"]').click());
    calls.length = 0;
    // "Mute my part" sets mutes and leaves levels (P1.3): guitar muted, bass stays 30%.
    await dom.act(() => preset('mine').click());
    assert.deepEqual(calls, [['mute', 'guitar', true]]);
    assert.equal(preset('mine').getAttribute('aria-pressed'), 'true');
    // "Solo my part" brings the part to 100% as well as soloing it (M5).
    calls.length = 0;
    await dom.act(() => preset('solo').click());
    assert.deepEqual(calls, [['solo', 'guitar', true], ['gain', 'guitar', 1], ['mute', 'guitar', false]]);
    calls.length = 0;
    await dom.act(() => preset('full').click());
    assert.deepEqual(calls.map(String).sort(), [['gain', 'bass', 1], ['solo', 'guitar', false]].map(String).sort());
    assert.equal(preset('full').getAttribute('aria-pressed'), 'true');
    assert.equal(dom.find('[data-testid="transport-mix"] .mixState').textContent, 'Full song');
    await dom.unmountAll();
  });
});

test('D5 + M3 (DOM): the non-modal Mix sheet makes what it covers inert (no Tab under it), and Escape from outside the sheet closes it', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const calls = [];
    await dom.mount(React.createElement(MixEcho, { calls }));
    const mix = dom.find('[data-testid="transport-mix"]');
    mix.focus();
    await dom.act(() => mix.click());
    const backdrop = dom.find('[data-testid="mix-sheet-backdrop"]');
    assert.equal(backdrop.hidden, false);
    assert.equal(dom.find('[data-testid="mix-sheet"]').getAttribute('aria-modal'), null);
    // Tab is not trapped: Tab from the last control is left to the browser.
    const items = [...dom.findAll('[data-testid="mix-sheet"] button, [data-testid="mix-sheet"] input')];
    items.at(-1).focus();
    const ev = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await dom.act(() => items.at(-1).dispatchEvent(ev));
    assert.equal(ev.defaultPrevented, false, 'no focus trap in a non-modal sheet');
    // A tap on the backdrop layer does not close it (it passes through in CSS).
    await dom.pointer('pointerdown', backdrop, {});
    assert.equal(backdrop.hidden, false);
    // M3: the player body (stage, pills, chips, transport) is inert while the sheet is open;
    // the header (back, ⋯) and the sheet are not.
    const body = dom.find('[data-testid="player-body"]');
    assert.equal(body.getAttribute('inert'), '', 'covered regions are inert');
    for (const sel of ['[data-testid="part-pills"]', '[data-testid="section-strip"]', '[data-testid="transport"]', '[data-testid="player-harmony-track"]'])
      assert.ok(dom.find(sel).closest('[inert]'), `${sel} is inside the inert region`);
    assert.equal(dom.find('[data-testid="mix-sheet"]').closest('[inert]'), null, 'the sheet itself is live');
    assert.equal(dom.find('[data-testid="player-more"]').closest('[inert]'), null, 'the header is live');
    // Escape with focus outside the sheet (on the page) closes it; focus goes back to Mix.
    dom.document.activeElement.blur();
    await dom.keydown('Escape', { target: dom.document.body });
    assert.equal(backdrop.hidden, true);
    assert.equal(body.getAttribute('inert'), null, 'live again once the sheet closes');
    assert.equal(dom.document.activeElement, mix);
    assert.deepEqual(calls.filter((c) => ['seek', 'play', 'pause'].includes(c[0])), []);
    await dom.unmountAll();
  });
});

test('D5 (DOM): with the ⋯ menu open over the Mix sheet, Escape closes only the menu', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    await dom.mount(React.createElement(MixEcho, { calls: [] }));
    await dom.act(() => dom.find('[data-testid="transport-mix"]').click());
    await dom.act(() => dom.find('[data-testid="player-more"]').click());
    const first = dom.find('#player-menu button');
    await dom.keydown('Escape', { target: first });
    assert.equal(dom.find('#player-menu'), null, 'the menu closed');
    assert.equal(dom.find('[data-testid="mix-sheet-backdrop"]').hidden, false, 'the Mix sheet stayed open');
    await dom.unmountAll();
  });
});

test('L2 (DOM): with the ⋯ menu open over the Mix sheet and focus on the ⋯ button itself, Escape closes only the menu', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    await dom.mount(React.createElement(MixEcho, { calls: [] }));
    await dom.act(() => dom.find('[data-testid="transport-mix"]').click());
    const more = dom.find('[data-testid="player-more"]');
    await dom.act(() => more.click());
    more.focus();
    await dom.keydown('Escape', { target: more });
    assert.equal(dom.find('#player-menu'), null, 'the menu closed');
    assert.equal(dom.find('[data-testid="mix-sheet-backdrop"]').hidden, false, 'the Mix sheet stayed open');
    await dom.keydown('Escape', { target: more });
    assert.equal(dom.find('[data-testid="mix-sheet-backdrop"]').hidden, true, 'a second Escape closes the sheet');
    await dom.unmountAll();
  });
});

test('H1/M2 (DOM): while a part is soloed a tap ENDS the solo and never mutes; a "silent" pill keeps its level and shows it once the solo ends', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const calls = [];
    await dom.mount(React.createElement(MixEcho, { calls }));
    const pill = (stem) => dom.find(`[data-testid="part-pills"] button[data-stem="${stem}"]`);
    const label = () => dom.find('[data-testid="transport-mix"] .mixState').textContent;
    await dom.act(() => pill('guitar').click()); // 30%
    await dom.act(() => pill('drums').click()); // 30%
    await dom.keydown('s', { target: pill('guitar') }); // solo (to 100%)
    calls.length = 0;
    // H1: a tap on the soloed pill un-solos it; it never mutes it.
    await dom.act(() => pill('guitar').click());
    assert.deepEqual(calls, [['solo', 'guitar', false]]);
    assert.equal(pill('guitar').textContent, 'Gtr 100%');
    // M2: a tap on a pill silenced by another's solo ends that solo and changes nothing else.
    await dom.keydown('s', { target: pill('bass') });
    assert.equal(pill('drums').textContent, 'Drums silent');
    assert.match(pill('drums').getAttribute('aria-label'), /back at 30% when the solo ends\. Tap to end the solo$/);
    calls.length = 0;
    await dom.act(() => pill('drums').click());
    assert.deepEqual(calls, [['solo', 'bass', false]], 'no level or mute change on a part you cannot hear');
    assert.equal(pill('drums').textContent, 'Drums 30%', 'its own level is back on the pill');
    assert.equal(label(), 'Drums 30%', 'the solo brought guitar to 100%, so drums is the one change');
    await dom.unmountAll();
  });
});

test('H1 (DOM): a tap never leaves the song silent — muting the last audible part brings it back to 100%', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const calls = [];
    await dom.mount(React.createElement(MixEcho, { calls }));
    const pill = (stem) => dom.find(`[data-testid="part-pills"] button[data-stem="${stem}"]`);
    for (const stem of ['bass', 'keys', 'drums', 'vocals', 'other']) {
      await dom.act(() => pill(stem).click());
      await dom.act(() => pill(stem).click());
    }
    await dom.act(() => pill('guitar').click());
    assert.equal(pill('guitar').textContent, 'Gtr 30%');
    calls.length = 0;
    await dom.act(() => pill('guitar').click());
    assert.deepEqual(calls, [['gain', 'guitar', 1]], 'the last audible part is not muted: it comes back to 100%');
    assert.equal(pill('guitar').textContent, 'Gtr 100%');
    await dom.unmountAll();
  });
});

test('D5 (DOM): a hold shorter than 500 ms is a tap, not a solo (the threshold is 500 ms)', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const calls = [];
    await dom.mount(React.createElement(MixEcho, { calls }));
    const gtr = () => dom.find('[data-testid="part-pills"] button[data-stem="guitar"]');
    await dom.pointer('pointerdown', gtr(), { pointerType: 'touch', clientX: 5, clientY: 5 });
    await dom.advance(450);
    assert.deepEqual(calls, [], 'no solo before 500 ms');
    await dom.pointer('pointerup', gtr(), { pointerType: 'touch', clientX: 5, clientY: 5 });
    await dom.act(() => gtr().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
    assert.deepEqual(calls, [['gain', 'guitar', 0.3]], 'released before the threshold: a tap');
    await dom.unmountAll();
  });
});

test('L1 (DOM): the Other pill shows only when the song has an Other stem', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    await dom.mount(React.createElement(MixEcho, { calls: [], unavailable: ['other'] }));
    assert.equal(dom.find('[data-testid="part-pills"] button[data-stem="other"]'), null, 'never produced: no pill');
    assert.equal(dom.findAll('[data-testid="part-pills"] button').length, 5);
    await dom.unmountAll();
  });
});

test('Phase A: the ⋯ menu and Song info do not link to the loops product, even when a loops URL is passed', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    await dom.mount(React.createElement(Player.PlayerView, viewProps({ loopsHref: '/loops?job=job-1' })));
    await dom.act(() => dom.find('[data-testid="player-more"]').click());
    const items = dom.findAll('#player-menu button, #player-menu a').map((b) => b.textContent);
    assert.ok(items.includes('See all chords') && items.includes('Song info'), `the menu opened: ${items.join(' | ')}`);
    assert.equal(dom.findAll('#player-menu a[href*="/loops"]').length, 0);
    assert.doesNotMatch(dom.find('#player-menu').textContent, /Download loops/);
    await dom.act(() => [...dom.findAll('#player-menu button')].find((b) => b.textContent === 'Song info').click());
    assert.doesNotMatch(dom.find('[data-testid="player"]').innerHTML, /href="\/loops|Download loops/);
    await dom.unmountAll();
  });
});

// ═══ P1.4 — desktop ═════════════════════════════════════════════════════════

test('P1.4 desktop (DOM): two columns, the mixer always visible with vertical faders; no Mix button, no sheet', async () => {
  await withDom(async (dom) => {
    setMedia(true);
    await dom.mount(React.createElement(Player.PlayerView, viewProps()));
    assert.equal(dom.find('[data-testid="player"]').dataset.layout, 'desktop');
    const aside = dom.find('aside[aria-labelledby="mix-h"]');
    assert.ok(aside, 'no mixer column');
    assert.equal(aside.querySelectorAll('input.fader[orient="vertical"]').length, 6, 'vertical faders');
    assert.ok(aside.querySelector('[data-testid="desk-presets"]'));
    assert.equal(dom.find('[data-testid="transport-mix"]'), null);
    assert.equal(dom.find('[data-testid="mix-sheet"]'), null);
    assert.ok([...aside.querySelectorAll('button')].some((b) => b.textContent === 'Show all chords'));
    await dom.unmountAll();
  });
});

// ═══ accessibility details from the mockups ═════════════════════════════════

test('44px targets on every new control (CSS)', () => {
  const css = (f) => read(`src/components/play/${f}`);
  const px = (body, prop) => Number((body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`)) || [])[1] ?? NaN);
  const rule = (src, sel) => src.match(new RegExp(`${sel.replace(/[.[\]'=]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`))[1];
  const t = css('Transport.module.css');
  for (const sel of ['.restart', '.loop', '.mix']) assert.ok(px(rule(t, sel), 'height') >= 44, sel);
  assert.ok(px(rule(t, '.play'), 'height') >= 44);
  const p = css('Player.module.css');
  for (const sel of ['.back', '.more', '.dismiss']) assert.ok(px(rule(p, sel), 'height') >= 44, sel);
  for (const [f, sel] of [['Player.module.css', '.menuItem'], ['Player.module.css', '.retry'], ['Presets.module.css', '.change'], ['SectionLoop.module.css', '.chip'], ['PartPills.module.css', '.pill']])
    assert.match(rule(css(f), sel), /(min-)?height:\s*var\(--touch-min, 44px\)/, `${f} ${sel}`);
  const m = css('MixSheet.module.css');
  assert.ok(px(rule(m, '.round,\n.close'), 'height') >= 44);
  // Story 2.3 (v4.0): the Mix button's state line is text >= 13px.
  assert.ok(px(rule(t, '.mixState'), 'font-size') >= 13, '.mixState font-size >= 13px');
});

test('module-graph refuses a stub that replaces nothing (a typo would silently load the real module)', () => {
  assert.throws(
    () => buildModuleGraph({ name: 'graph-typo', entries: ['lib/play/notation.ts'], overrides: { 'lib/play/notaton.ts': 'export {}' } }),
    /override\(s\) never reached/,
  );
  assert.throws(
    () => buildModuleGraph({ name: 'graph-typo-pkg', entries: ['lib/play/notation.ts'], packages: { 'next/link': 'export {}' } }),
    /package stub\(s\) never imported/,
  );
});

// ═══ review S1 — WCAG 1.4.10: no scroll when it fits, scroll when it does not ═══

test('S1: the screen scrolls only when its content cannot fit (CSS contract; measured in Chromium by player-text-size)', () => {
  const css = read('src/components/play/Player.module.css');
  const root = css.match(/\.root\s*\{([^}]*)\}/)[1];
  assert.match(root, /overflow-y:\s*auto;/, 'the root must be able to scroll');
  assert.doesNotMatch(root, /overflow:\s*hidden/, 'a hidden overflow strands Play/±5/Loop/Mix off-screen at 400% zoom');
  assert.match(css, /\.body\s*\{[^}]*flex:\s*1 0 auto;/, 'the body never shrinks below its content');
  const stage = css.match(/\.stage\s*\{([^}]*)\}/)[1];
  assert.match(stage, /flex:\s*1 1 0;/, 'the stage takes the remainder');
  assert.doesNotMatch(stage, /overflow:\s*hidden/, 'the stage must keep its content minimum (notice + chord floor), R2');
  const chords = css.match(/\.chords\s*\{([^}]*)\}/)[1];
  assert.match(chords, /min-height:\s*200px;/, 'the chord area floor (stageChromePx(28) + one 62px line), then the screen scrolls');
  assert.match(chords, /overflow:\s*hidden;/);
  assert.match(css, /@media \(max-height: 499px\) and \(min-width: 560px\)/, 'a 320px-wide zoomed window is a phone column, not two 160px columns');
  assert.match(read('src/components/play/Sheet.module.css'), /\.backdrop\s*\{[^}]*position:\s*fixed;/, 'the sheet covers the viewport even when the screen is scrolled');
});

test('stage growth: the ladder and the bars grow only into spare height, never past their caps', async () => {
  const H = await import('../src/components/ChordPhone.helpers.ts');
  assert.equal(H.TALL_NOW_PX, 96);
  assert.equal(H.GROWN_BAR_PX, 104);
  const line = { h: 62, rows: 1 };
  assert.equal(H.growScale(0, line, line), 1);
  assert.equal(H.growScale(-50, line, line), 1, 'never shrinks');
  assert.equal(H.growScale(1000, line, line), 104 / 62, 'capped');
  assert.ok(Math.abs(H.growScale(31, line, line) - (124 + 31) / 124) < 1e-9);
  assert.equal(H.growScale(100, line, null), 104 / 62 > (62 + 100) / 62 ? (62 + 100) / 62 : 104 / 62);
  assert.equal(H.growScale(100, null, null), 1);
  assert.ok(H.stageChromePx(96) > H.stageChromePx(28));
  // A name grows with its bar only as far as its slot is wide.
  assert.equal(H.grownFontPx('G', 20, 80, false, 1), 20);
  assert.ok(H.grownFontPx('G', 20, 80, false, 1.6) <= Math.floor(20 * H.GROWN_NAME_MAX));
  assert.ok(H.grownFontPx('G', 20, 80, false, 1.6) > 20);
  assert.equal(H.grownFontPx('C♯m7♭5/G♯', 14, 60, false, 1.6), 14, 'no room: unchanged');
  assert.equal(H.grownFontPx('Am', 20, 80, true, 1.6), 20, 'a wrapped name keeps its size');
  assert.ok(H.nameWidth('G', H.grownFontPx('G', 20, 40, false, 1.6)) <= 40);
});


// ═══ Phase A (2026-11-21) ═════════════════════════════════════════════════════

test('C4: ⋯ → Capo / transpose steps -6..+6, shows a badge, reaches both chord views, is remembered per job', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const open = async () => {
      await dom.act(() => dom.find('[data-testid="player-more"]').click());
    };
    await dom.mount(React.createElement(Player.PlayerView, viewProps()));
    assert.equal(dom.find('[data-view="stage"]').dataset.transpose, '0');
    assert.equal(dom.find('[data-testid="capo-indicator"]'), null, 'no badge at 0');
    await open();
    const group = dom.find('[data-testid="transpose-group"]');
    assert.equal(group.getAttribute('aria-labelledby'), 'player-transpose');
    assert.equal(dom.find('[data-testid="transpose-value"]').textContent, 'Off');
    assert.equal(dom.find('[data-testid="transpose-reset"]'), null);
    // Capo 2 = two steps down
    await dom.act(() => dom.find('[data-testid="transpose-down"]').click());
    await dom.act(() => dom.find('[data-testid="transpose-down"]').click());
    assert.equal(dom.find('[data-view="stage"]').dataset.transpose, '-2');
    assert.equal(dom.find('[data-view="stage"]').dataset.key, 'A# major', 'the song key is passed for spelling');
    assert.equal(dom.find('[data-testid="transpose-value"]').textContent, 'Capo 2');
    assert.equal(dom.find('[data-testid="capo-indicator"]').textContent, 'Capo 2');
    assert.equal(dom.window.localStorage.getItem('sl.play.transpose.v1.job-1'), '-2');
    // the "See all chords" sheet gets the same shift
    await dom.act(() => dom.findAll('button').find((b) => b.textContent === 'See all chords').click());
    assert.equal(dom.find('[data-view="chart"]').dataset.transpose, '-2');
    await dom.act(() => dom.find('[data-testid="player-more"]').click());
    // clamp at both ends
    for (let i = 0; i < 12; i++) await dom.act(() => dom.find('[data-testid="transpose-down"]').click());
    assert.equal(dom.find('[data-view="stage"]').dataset.transpose, '-6');
    assert.equal(dom.find('[data-testid="transpose-down"]').disabled, true);
    for (let i = 0; i < 12; i++) await dom.act(() => dom.find('[data-testid="transpose-up"]').click());
    assert.equal(dom.find('[data-view="stage"]').dataset.transpose, '6');
    assert.equal(dom.find('[data-testid="transpose-up"]').disabled, true);
    assert.equal(dom.find('[data-testid="capo-indicator"]').textContent, '+6');
    await dom.act(() => dom.find('[data-testid="transpose-down"]').click());
    assert.equal(dom.find('[data-testid="transpose-value"]').textContent, '+5 semitones');
    await dom.unmountAll();
    // a new visit to this job reads it back; another job is untouched
    await dom.mount(React.createElement(Player.PlayerView, viewProps()));
    assert.equal(dom.find('[data-view="stage"]').dataset.transpose, '5');
    assert.equal(dom.find('[data-testid="capo-indicator"]').textContent, '+5');
    await dom.unmountAll();
    await dom.mount(React.createElement(Player.PlayerView, viewProps({ jobId: 'job-2' })));
    assert.equal(dom.find('[data-view="stage"]').dataset.transpose, '0');
    await dom.unmountAll();
    // reset
    await dom.mount(React.createElement(Player.PlayerView, viewProps()));
    await open();
    await dom.act(() => dom.find('[data-testid="transpose-reset"]').click());
    assert.equal(dom.find('[data-view="stage"]').dataset.transpose, '0');
    assert.equal(dom.window.localStorage.getItem('sl.play.transpose.v1.job-1'), null);
    await dom.unmountAll();
    // a garbage stored value is 0
    dom.window.localStorage.setItem('sl.play.transpose.v1.job-1', 'junk');
    await dom.mount(React.createElement(Player.PlayerView, viewProps()));
    assert.equal(dom.find('[data-view="stage"]').dataset.transpose, '0');
    await dom.unmountAll();
  });
  const css = read('src/components/play/Player.module.css');
  assert.match(css.match(/\.capoBadge\s*\{([^}]*)\}/)[1], /border-radius:\s*22px;/);
  assert.doesNotMatch(css.match(/\.capoBadge\s*\{([^}]*)\}/)[1], /accent|chord-now/);
});

test('C4: a song with no chords has no Capo / transpose control and no badge', async () => {
  globalThis.__noChords = true;
  try {
    await withDom(async (dom) => {
      setMedia(false);
      dom.window.localStorage.setItem('sl.play.transpose.v1.job-1', '-2');
      await dom.mount(React.createElement(Player.PlayerView, viewProps()));
      await dom.act(() => dom.find('[data-testid="player-more"]').click());
      assert.equal(dom.find('[data-testid="transpose-group"]'), null);
      assert.equal(dom.find('[data-testid="capo-indicator"]'), null);
      await dom.unmountAll();
    });
  } finally {
    delete globalThis.__noChords;
  }
});

test('#496: a song with no chords has no "See all chords" and no Chords: Simple / Detailed in the ⋯ menu', async () => {
  globalThis.__noChords = true;
  try {
    await withDom(async (dom) => {
      setMedia(false);
      await dom.mount(React.createElement(Player.PlayerView, viewProps({ onSpeed: noop })));
      await dom.act(() => dom.find('[data-testid="player-more"]').click());
      const items = dom.findAll('#player-menu button').map((b) => b.textContent);
      assert.ok(!items.includes('See all chords'), items.join(' | '));
      assert.equal(dom.find('[data-testid="chord-mode-simple"]'), null);
      assert.equal(dom.find('[data-testid="chord-mode-detailed"]'), null);
      assert.equal(dom.find('#player-chord-mode'), null);
      assert.ok(items.includes('Song info'), 'the rest of the menu is still there');
      assert.ok(dom.find('[data-testid="speed-group"]'));
      assert.ok(dom.find('[data-testid="count-in-toggle"]'));
      // QA S8: the ⋯ name does not promise chords that are not there.
      assert.equal(dom.find('[data-testid="player-more"]').getAttribute('aria-label'), 'More: speed, song info, count-in, rename parts, set lists');
      await dom.unmountAll();
    });
  } finally {
    delete globalThis.__noChords;
  }
  // …and with chords, all of it is back, and the name says so.
  await withDom(async (dom) => {
    setMedia(false);
    await dom.mount(React.createElement(Player.PlayerView, viewProps({ onSpeed: noop })));
    await dom.act(() => dom.find('[data-testid="player-more"]').click());
    const items = dom.findAll('#player-menu button').map((b) => b.textContent);
    assert.ok(items.includes('See all chords'), items.join(' | '));
    assert.ok(dom.find('[data-testid="chord-mode-simple"]'));
    assert.ok(dom.find('[data-testid="transpose-group"]'));
    assert.equal(dom.find('[data-testid="player-more"]').getAttribute('aria-label'), 'More: all chords, speed, song info, count-in, rename parts, set lists');
    await dom.unmountAll();
  });
});

test('#498: the desktop aside "Show all chords" shows only when the song has chords (same gate as the ⋯ items, #496)', async () => {
  const asideButtons = (dom) => [...dom.find('aside[aria-labelledby="mix-h"]').querySelectorAll('button')].map((b) => b.textContent);
  globalThis.__noChords = true;
  try {
    await withDom(async (dom) => {
      setMedia(true);
      await dom.mount(React.createElement(Player.PlayerView, viewProps()));
      assert.equal(dom.find('[data-testid="player"]').dataset.layout, 'desktop');
      assert.ok(!asideButtons(dom).includes('Show all chords'), asideButtons(dom).join(' | '));
      assert.ok(dom.find('aside[aria-labelledby="mix-h"] [data-testid="desk-presets"]'), 'the rest of the aside is still there');
      await dom.unmountAll();
    });
  } finally {
    delete globalThis.__noChords;
  }
  // …and with chords it is there and opens the chord sheet.
  await withDom(async (dom) => {
    setMedia(true);
    await dom.mount(React.createElement(Player.PlayerView, viewProps()));
    const btn = [...dom.find('aside[aria-labelledby="mix-h"]').querySelectorAll('button')].find((b) => b.textContent === 'Show all chords');
    assert.ok(btn, 'with chords the aside offers the chord sheet');
    await dom.act(() => btn.click());
    assert.ok(dom.find('[data-testid="chart-sheet"]'), 'the chord sheet opened');
    await dom.unmountAll();
  });
});

test('#498: with no sections there is no Rename parts, and the ⋯ name does not promise it (mounted, not only the helper)', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    await dom.mount(React.createElement(Player.PlayerView, viewProps({ sections: [], onSpeed: noop })));
    assert.equal(dom.find('[data-testid="player-more"]').getAttribute('aria-label'), 'More: all chords, speed, song info, count-in, set lists');
    await dom.act(() => dom.find('[data-testid="player-more"]').click());
    assert.equal(dom.find('[data-testid="menu-rename-parts"]'), null);
    await dom.unmountAll();
  });
  // Server render: no overlay report yet (no chords), no sections.
  assert.match(ssr({ sections: [] }), /aria-label="More: song info, count-in, set lists"/);
});

test('QA S8: moreMenuLabel lists what the ⋯ menu holds, in menu order', async () => {
  const { moreMenuLabel: L } = await import(graph.url('components/play/PlayerScreen.tsx'));
  assert.equal(L({ hasChords: false, speed: false, renameParts: false }), 'More: song info, count-in, set lists');
  assert.equal(L({ hasChords: true, speed: true, renameParts: true }), 'More: all chords, speed, song info, count-in, rename parts, set lists');
  assert.equal(L({ hasChords: true, speed: false, renameParts: false }), 'More: all chords, song info, count-in, set lists');
});

test('D6: chords are Simple by default; ⋯ → Chords: Simple / Detailed switches both chord views and is remembered', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const open = async () => {
      await dom.act(() => dom.find('[data-testid="player-more"]').click());
    };
    await dom.mount(React.createElement(Player.PlayerView, viewProps()));
    assert.equal(dom.find('[data-view="stage"]').dataset.simplify, 'true', 'Simple by default');
    await open();
    const simple = dom.find('[data-testid="chord-mode-simple"]');
    const detailed = dom.find('[data-testid="chord-mode-detailed"]');
    assert.equal(simple.getAttribute('aria-pressed'), 'true');
    assert.equal(detailed.getAttribute('aria-pressed'), 'false');
    assert.equal(simple.closest('[role="group"]').getAttribute('aria-labelledby'), 'player-chord-mode');
    await dom.act(() => detailed.click());
    assert.equal(dom.find('[data-view="stage"]').dataset.simplify, 'false');
    assert.equal(dom.find('[data-testid="chord-mode-detailed"]').getAttribute('aria-pressed'), 'true');
    assert.equal(dom.window.localStorage.getItem('sl.play.chordMode.v1'), 'detailed');
    await dom.unmountAll();
    // A new visit reads the choice back.
    await dom.mount(React.createElement(Player.PlayerView, viewProps()));
    assert.equal(dom.find('[data-view="stage"]').dataset.simplify, 'false', 'remembered');
    await dom.unmountAll();
    // A broken localStorage is the default, never an error.
    dom.window.localStorage.setItem('sl.play.chordMode.v1', 'garbage');
    await dom.mount(React.createElement(Player.PlayerView, viewProps()));
    assert.equal(dom.find('[data-view="stage"]').dataset.simplify, 'true');
    await dom.unmountAll();
  });
  const css = read('src/components/play/Player.module.css');
  const seg = css.match(/\n\.segment\s*\{([^}]*)\}/)[1];
  assert.match(seg, /min-height:\s*var\(--touch-min, 44px\);/);
  assert.match(seg, /border-radius:\s*22px;/);
  const on = css.match(/\.segment\[aria-pressed='true'\]\s*\{([^}]*)\}/)[1];
  assert.match(on, /background:\s*var\(--bg-selected\);/);
  assert.match(on, /border-color:\s*var\(--text-primary\);/);
  assert.doesNotMatch(on, /accent|chord-now/);
});

test('J4: the stage knows when audio is playing (cells are never interactive under a strumming hand)', () => {
  assert.match(ssr({ snapshot: snap({ status: 'playing' }) }), /data-view="stage"[^>]*data-playing="true"/);
  assert.match(ssr(), /data-view="stage"[^>]*data-playing="false"/);
});

test('light-audio hint: a returning visitor who dismissed it never sees it again; it stays in Song info', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    dom.window.localStorage.setItem('sl.play.lightNoteSeen.v1', '1');
    await dom.mount(React.createElement(Player.PlayerView, viewProps({ lightAudio: true })));
    assert.equal(dom.find('[data-testid="player-light-audio"]'), null);
    await dom.act(() => dom.find('[data-testid="player-more"]').click());
    await dom.act(() => [...dom.findAll('#player-menu button')].find((b) => b.textContent === 'Song info').click());
    assert.match(dom.find('[data-testid="info-sheet"]').textContent, /lighter audio/);
    await dom.unmountAll();
  });
});

// ═══ Set lists (#322; Phase B, B2) ══════════════════════════════════════════
// The ⋯ menu's "Add to <last-used list>" / "Add to set list…", and with ?set=<id> the
// "Next song ›" row and "Back to <set name>". fetch is stubbed per test and restored.

function stubFetch(handler) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'fetch');
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    const [status, body] = handler(String(url), init);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, restore: () => { if (had) globalThis.fetch = real; else delete globalThis.fetch; } };
}
const LIST_ID = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
const DEMO_LIST = (items) => ({ list: { id: 'demo', name: 'Demo set', is_demo: true, items } });
const item = (i, state, job) => ({ item_id: `i${i}`, position: i, source: 'demo', title: `Song ${i}`, state, job_id: job });

test('B2: the ⋯ menu offers "Add to <last-used list>" (one tap adds this song) and "Add to set list…"', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const f = stubFetch((url, init) =>
      url.startsWith('/api/set-lists?job=') ? [200, { lists: [{ id: LIST_ID, name: 'JAMS', song_count: 2, updated_at: '2026-11-22T00:00:00Z', has_job: false }] }]
        : init.method === 'POST' ? [201, { item_id: 'x', added: true }] : [404, {}]);
    try {
      await dom.mount(React.createElement(Player.PlayerView, viewProps()));
      await dom.act(() => dom.find('[data-testid="player-more"]').click());
      await dom.act();
      const labels = [...dom.findAll('#player-menu button')].map((b) => b.textContent);
      assert.ok(labels.includes('Add to JAMS'), labels.join(' | '));
      assert.ok(labels.includes('Add to set list…'), labels.join(' | '));
      assert.equal(f.calls[0].url, '/api/set-lists?job=job-1');
      await dom.act(() => dom.find('[data-testid="player-add-last"]').click());
      await dom.act();
      const post = f.calls.find((c) => c.method === 'POST');
      assert.deepEqual([post.url, post.body], [`/api/set-lists/${LIST_ID}/songs`, { job_id: 'job-1' }]);
      assert.equal(dom.find('#player-menu'), null, 'the menu closed');
      assert.equal(dom.find('[data-testid="set-toast"]').textContent, 'Added to JAMS.');
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('B2: "Add to set list…" opens a checklist (ticked where the song already is); signed out it says to sign in', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    let signedIn = true;
    const f = stubFetch((url) => (!signedIn ? [401, {}] : url.startsWith('/api/set-lists?job=')
      ? [200, { lists: [{ id: LIST_ID, name: 'JAMS', song_count: 1, updated_at: 'x', has_job: true }, { id: 'b', name: 'Gig', song_count: 0, updated_at: 'x', has_job: false }] }]
      : [200, {}]));
    try {
      await dom.mount(React.createElement(Player.PlayerView, viewProps()));
      await dom.act(() => dom.find('[data-testid="player-more"]').click());
      await dom.act();
      await dom.act(() => dom.find('[data-testid="player-add-to-set"]').click());
      await dom.act();
      const rows = dom.findAll('[data-testid="add-set-row"]');
      assert.deepEqual([...rows].map((r) => [r.textContent, r.querySelector('input').checked]), [['JAMS', true], ['Gig', false]]);
      assert.equal(dom.find('#add-set-new').value, 'Set list 1');
      await dom.unmountAll();
      signedIn = false;
      await dom.mount(React.createElement(Player.PlayerView, viewProps()));
      await dom.act(() => dom.find('[data-testid="player-more"]').click());
      await dom.act();
      assert.equal(dom.find('[data-testid="player-add-last"]'), null);
      await dom.act(() => dom.find('[data-testid="player-add-to-set"]').click());
      await dom.act();
      assert.match(dom.find('[data-testid="add-set-sign-in"]').textContent, /Sign in/);
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('B2: without ?set= there is no set row and the back link is the library', async () => {
  const h = decode(ssr());
  assert.doesNotMatch(h, /set-next/);
  await withDom(async (dom) => {
    setMedia(false);
    const f = stubFetch(() => [500, {}]);
    try {
      await dom.mount(React.createElement(Player.PlayerView, viewProps()));
      await dom.act();
      assert.equal(dom.find('[data-testid="set-next-row"]'), null);
      assert.equal(f.calls.length, 0, 'nothing fetched for a set');
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('B2: ?set=demo -> "Next song ›" (1 tap) to the next PLAYABLE song, skipping an unavailable one with a one-line notice; back goes to the set', async () => {
  await withDom(
    async (dom) => {
      setMedia(false);
      const f = stubFetch((url) => (url === '/api/set-lists/demo'
        ? [200, DEMO_LIST([item(0, 'ready', 'job-0'), item(1, 'ready', 'job-1'), item(2, 'unavailable', null), item(3, 'ready', 'job-3')])]
        : [404, {}]));
      try {
        await dom.mount(React.createElement(Player.PlayerView, viewProps()));
        await dom.act();
        await dom.act();
        const next = dom.find('[data-testid="set-next"]');
        assert.ok(next, 'Next song is shown');
        assert.equal(next.textContent, 'Next song ›');
        assert.equal(next.getAttribute('href'), '/jobs/job-3?set=demo');
        assert.equal(next.getAttribute('aria-label'), 'Next song: Song 3');
        assert.equal(dom.find('[data-testid="set-next-text"]').textContent, 'Skipped 1 song that can’t play now.');
        const back = dom.find('header a');
        assert.equal(back.getAttribute('href'), '/sets/demo');
        assert.equal(back.getAttribute('aria-label'), 'Back to Demo set');
        assert.equal(f.calls.filter((c) => c.url === '/api/set-lists/demo').length, 1);
      } finally {
        f.restore();
        await dom.unmountAll();
      }
    },
    { url: 'http://localhost:3000/jobs/job-1?set=demo' },
  );
});

test('B2: at the last playable song there is no Next (it never runs past the end or wraps)', async () => {
  await withDom(
    async (dom) => {
      setMedia(false);
      const f = stubFetch(() => [200, { list: { id: LIST_ID, name: 'JAMS', is_demo: false, items: [item(0, 'ready', 'job-0'), item(1, 'ready', 'job-1'), item(2, 'expired', null)] } }]);
      try {
        await dom.mount(React.createElement(Player.PlayerView, viewProps()));
        await dom.act();
        await dom.act();
        assert.equal(dom.find('[data-testid="set-next"]'), null);
        assert.equal(dom.find('[data-testid="set-next-text"]').textContent, 'Skipped 1 song that can’t play now.');
        assert.equal(f.calls[0].url, `/api/set-lists/${LIST_ID}`);
      } finally {
        f.restore();
        await dom.unmountAll();
      }
    },
    { url: `http://localhost:3000/jobs/job-1?set=${LIST_ID}` },
  );
});

test('B2: "Next song ›" is a >= 44px pill, neutral (the Play button stays the one lime fill)', () => {
  const css = read('src/components/setlists/SetLists.module.css');
  const btn = css.match(/\n\.nextBtn\s*\{([^}]*)\}/)[1];
  assert.match(btn, /min-height:\s*var\(--touch-min\);/);
  assert.match(btn, /border-radius:\s*22px;/);
  assert.doesNotMatch(css, /--accent|#a3e635|chord-now/i);
  const row = css.match(/\n\.nextRow\s*\{([^}]*)\}/)[1];
  assert.match(row, /flex-shrink:\s*0;/, 'the header row never squeezes the stage into a scroll');
});
