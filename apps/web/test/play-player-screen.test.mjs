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
        if (props.view === 'stage' && globalThis.__noChords)
          return typeof props.emptyStage === 'function' ? props.emptyStage(globalThis.__noChordsReason ?? null) : props.emptyStage;
        return createElement('div', { 'data-testid': 'chord-overlay', 'data-view': String(props.view), 'data-position': String(props.positionSec) });
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
function EngineEcho({ calls, reject = false, phase = { kind: 'ready' }, loopOverride, ...over }) {
  const [loop, setLoop] = React.useState(null);
  const shownLoop = loopOverride !== undefined ? loopOverride : loop;
  return React.createElement(Player.PlayerView, viewProps({
    ...over,
    phase,
    snapshot: snap({ loop: shownLoop }),
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
  assert.match(h, /<span class="sr">Detected: <\/span>102 BPM · B♭ major/);
  assert.match(h, /<a class="back" href="\/history" aria-label="Back to song library">/);
  assert.match(h, /<button[^>]*aria-label="More: all chords, song info"[^>]*aria-expanded="false"/);
  assert.match(decode(ssr({ artist: 'The Royal Sundowners' })), /102 BPM · B♭ major<\/span> · <span>The Royal Sundowners<\/span>/);
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
  assert.match(err, /data-testid="player-notice"><p class="noticeText" role="alert" data-testid="player-banner">Boom\.<\/p><button[^>]*data-testid="player-retry"/);
  assert.ok(err.indexOf('player-notice') < err.indexOf('data-view="stage"'));
  const deg = ssr({ snapshot: snap({ degraded: { missing: ['other'] } }) });
  assert.match(deg, /role="status" data-testid="player-degraded">Other is not available/);
  assert.match(ssr({ phase: { kind: 'loading' }, snapshot: snap({ status: 'loading' }) }), /role="status" data-testid="player-loading">Loading the stems/);
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

test('P1.1: viewportFit "cover" is set on /jobs/[id] ONLY', () => {
  assert.match(read('src/app/jobs/[id]/page.tsx'), /export const viewport: Viewport = \{ viewportFit: 'cover' \};/);
  assert.doesNotMatch(read('src/app/layout.tsx'), /viewportFit/);
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
    assert.match(h, /data-testid="no-chords-section">Verse 1<\/span>/);
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

test('P2.1 through the screen: tap, extend (+ the one-time hint), shrink, loop off/on, long-press, clear', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const loops = [];
    await dom.mount(React.createElement(EngineEcho, { calls: loops }));
    const chip = (i) => dom.findAll('[data-testid="section-strip"] button')[i];
    const loopBtn = () => dom.find('[data-testid="transport-loop"]');
    assert.equal(loopBtn().getAttribute('aria-disabled'), 'true', 'nothing to loop yet');
    await dom.act(() => loopBtn().click());
    assert.deepEqual(loops, [], 'a disabled loop button does nothing');

    await dom.act(() => chip(1).click());
    assert.deepEqual(loops.at(-1), { startSec: 9, endSec: 47 });
    await dom.act(() => chip(2).click());
    assert.deepEqual(loops.at(-1), { startSec: 9, endSec: 66 }, 'extend');
    assert.match(dom.find('[data-testid="section-hint"]').textContent, /Looping these — tap one to loop it alone\./);
    assert.match(dom.find('[data-testid="transport-loop-text"]').textContent, /Looping Verse 1 → Chorus · 0:09–1:06/);
    assert.equal(dom.findAll('[data-testid="section-strip"] button[aria-pressed="true"]').length, 2);

    await dom.act(() => chip(2).click());
    assert.deepEqual(loops.at(-1), { startSec: 47, endSec: 66 }, 'shrink');
    assert.equal(dom.find('[data-testid="section-hint"]'), null);

    await dom.act(() => loopBtn().click());
    assert.equal(loops.at(-1), null, 'loop off');
    assert.equal(loopBtn().getAttribute('aria-pressed'), 'false');
    assert.equal(dom.find('[data-testid="transport-loop-text"]').textContent, 'Loop off');
    await dom.act(() => loopBtn().click());
    assert.deepEqual(loops.at(-1), { startSec: 47, endSec: 66 }, 'back on: the remembered run');

    await dom.act(() => chip(0).click());
    assert.deepEqual(loops.at(-1), { startSec: 0, endSec: 66 }, 'extend backwards');
    assert.equal(dom.find('[data-testid="section-hint"]'), null, 'the hint is one-time');

    await dom.pointer('pointerdown', chip(3), { pointerType: 'touch', clientX: 5, clientY: 5 });
    await dom.advance(550);
    await dom.pointer('pointerup', chip(3), { pointerType: 'touch', clientX: 5, clientY: 5 });
    await dom.act(() => chip(3).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
    assert.deepEqual(loops.at(-1), { startSec: 66, endSec: 104 }, 'long-press: loop only this (the release click swallowed)');

    await dom.act(() => chip(3).click());
    assert.equal(loops.at(-1), null, 'the only chip: clear');
    assert.equal(loopBtn().getAttribute('aria-disabled'), 'true');
    await dom.unmountAll();
  });
});

// QA C-10, Jon 2026-11-18 (option b): with the loop OFF, tapping a section loops
// just that section. It must not extend the remembered run, and must not spend
// the one-time hint (that belongs to the first real extend, with the loop on).
test('P2.1 (C-10 b) through the screen: loop off, tap outside the remembered run -> loops that section alone', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    const loops = [];
    await dom.mount(React.createElement(EngineEcho, { calls: loops }));
    const chip = (i) => dom.findAll('[data-testid="section-strip"] button')[i];
    const loopBtn = () => dom.find('[data-testid="transport-loop"]');

    await dom.act(() => chip(1).click());
    assert.deepEqual(loops.at(-1), { startSec: 9, endSec: 47 });
    await dom.act(() => loopBtn().click());
    assert.equal(loops.at(-1), null, 'loop off, Verse 1 remembered');

    await dom.act(() => chip(3).click());
    assert.deepEqual(loops.at(-1), { startSec: 66, endSec: 104 }, 'loop off + tap outside: just that section, NOT Verse 1 -> it');
    assert.equal(loopBtn().getAttribute('aria-pressed'), 'true', 'and the loop is on');
    assert.equal(dom.findAll('[data-testid="section-strip"] button[aria-pressed="true"]').length, 1);
    assert.equal(dom.find('[data-testid="section-hint"]'), null, 'no extend, so no hint');

    // With the loop ON, outside still extends, and the one-time hint is still unspent.
    await dom.act(() => chip(1).click());
    assert.deepEqual(loops.at(-1), { startSec: 9, endSec: 104 }, 'loop on + tap outside: extend');
    assert.match(dom.find('[data-testid="section-hint"]').textContent, /Looping these — tap one to loop it alone\./);

    // Loop off on a 2+ run, tap inside: that chip alone.
    await dom.act(() => loopBtn().click());
    await dom.act(() => chip(2).click());
    assert.deepEqual(loops.at(-1), { startSec: 47, endSec: 66 }, 'loop off + tap inside: just that section');
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
    assert.equal(loops.at(-1), null, 'a click after the window is a tap (the only chip: clear)');
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
    await dom.act(() => dom.findAll('[data-testid="section-strip"] button')[1].click());
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
    await dom.act(() => dom.findAll('[data-testid="section-strip"] button')[2].click());
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
  assert.match(decode(h), /Looping Verse 1 → Chorus · 0:09–1:06/);
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
    snapshot: snap({ stems }),
    onGain: (stem, g) => { calls.push(['gain', stem, g]); upd(stem, { gain: g }); },
    onMute: (stem, m) => { calls.push(['mute', stem, m]); upd(stem, { muted: m }); },
    onSolo: (stem, v) => { calls.push(['solo', stem, v]); upd(stem, { soloed: v }); },
    onSeek: () => calls.push(['seek']),
    onPlay: () => calls.push(['play']),
    onPause: () => calls.push(['pause']),
  }));
}

test('D5: the pills sit between the chord stage and the section strip, Guitar first, one per stem', () => {
  const h = ssr();
  const at = (re) => h.search(re);
  assert.ok(at(/data-view="stage"/) < at(/data-testid="part-pills"/), 'below the stage');
  assert.ok(at(/data-testid="part-pills"/) < at(/data-testid="section-strip"/), 'above the section strip');
  const pills = h.slice(at(/data-testid="part-pills"/), at(/data-testid="section-strip"/));
  assert.deepEqual([...pills.matchAll(/data-stem="(\w+)"/g)].map((m) => m[1]), ['guitar', 'bass', 'keys', 'drums', 'vocals', 'other']);
  assert.match(pills, /<legend class="sr">Parts\. Tap a part to step it 100%, 30%, muted\. Hold it, or press S, to solo it\.<\/legend>/);
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
    assert.equal(pill('guitar').getAttribute('aria-label'), 'Guitar, solo');
    assert.equal(pill('bass').textContent, 'Bass silent');
    assert.equal(pill('bass').getAttribute('aria-label'), 'Bass, 100%, silent while another part is soloed');
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
    await dom.keydown('s', { target: gtr() });
    assert.deepEqual(calls, [['solo', 'guitar', true], ['mute', 'guitar', false]]);
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
    assert.equal(keys.getAttribute('aria-describedby'), 'part-pills-note');
    assert.equal(dom.find('#part-pills-note').textContent, 'Keys is not available for this song.');
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
    // Full song: the solo is cleared and a lowered level comes back to 100%.
    await dom.act(() => dom.find('[data-testid="part-pills"] button[data-stem="bass"]').click());
    calls.length = 0;
    await dom.act(() => preset('full').click());
    assert.deepEqual(calls.map(String).sort(), [['gain', 'bass', 1], ['solo', 'guitar', false]].map(String).sort());
    assert.equal(preset('full').getAttribute('aria-pressed'), 'true');
    assert.equal(dom.find('[data-testid="transport-mix"] .mixState').textContent, 'Full song');
    await dom.unmountAll();
  });
});

test('D5 (DOM): the non-modal Mix sheet leaves the screen live — pills still work under it, and Escape from outside the sheet closes it', async () => {
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
    // Escape with focus on the page (outside the sheet) closes it; focus goes back to Mix.
    dom.find('[data-testid="part-pills"] button[data-stem="bass"]').focus();
    await dom.keydown('Escape', { target: dom.document.activeElement });
    assert.equal(backdrop.hidden, true);
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

test('Phase A: the ⋯ menu and Song info do not link to the loops product, even when a loops URL is passed', async () => {
  await withDom(async (dom) => {
    setMedia(false);
    await dom.mount(React.createElement(Player.PlayerView, viewProps({ loopsHref: '/loops?job=job-1' })));
    await dom.act(() => dom.find('[data-testid="player-more"]').click());
    assert.deepEqual(dom.findAll('#player-menu > *').map((b) => b.textContent), ['See all chords', 'Song info']);
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
  for (const sel of ['.skip', '.loop', '.mix']) assert.ok(px(rule(t, sel), 'height') >= 44, sel);
  assert.ok(px(rule(t, '.play'), 'height') >= 44);
  const p = css('Player.module.css');
  for (const sel of ['.back', '.more', '.dismiss']) assert.ok(px(rule(p, sel), 'height') >= 44, sel);
  for (const [f, sel] of [['Player.module.css', '.menuItem'], ['Player.module.css', '.retry'], ['Presets.module.css', '.change'], ['SectionLoop.module.css', '.chip'], ['PartPills.module.css', '.pill']])
    assert.match(rule(css(f), sel), /(min-)?height:\s*var\(--touch-min, 44px\)/, `${f} ${sel}`);
  const m = css('MixSheet.module.css');
  assert.ok(px(rule(m, '.round,\n.close'), 'height') >= 44);
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
