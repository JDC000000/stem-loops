// Transport (Story 4): pure logic + server-rendered markup.
// No jsdom in this repo, so effects, pointer events and real keydown dispatch
// CANNOT run here. What is covered: every decision the component delegates to a
// pure function (time format, scrub-vs-prop precedence, typing-vs-space,
// status->affordance, key seeking, pointer->seconds) and the first-paint markup
// in all six statuses. Pointer-capture drag/release and the single-onSeek-per-
// gesture wiring are verified by review only (see PR notes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withDom } from './helpers/dom.mjs';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'transport-'));
writeFileSync(join(dir, 'css.mjs'), 'export default new Proxy({}, { get: (_, k) => String(k) });');
const js = ts
  .transpileModule(readFileSync(join(WEB, 'src/components/play/Transport.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  })
  .outputText.replace(/from ['"]\.\/Transport\.module\.css['"]/, "from './css.mjs'");
writeFileSync(join(dir, 'Transport.mjs'), js);
const T = await import(pathToFileURL(join(dir, 'Transport.mjs')).href);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');

const noop = () => {};
const render = (p) =>
  renderToStaticMarkup(
    React.createElement(T.Transport, {
      status: 'ready', positionSec: 0, durationSec: 151.29, onPlay: noop, onPause: noop, onSeek: noop, ...p,
    }),
  );
const attr = (html, name) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1];

// ── time formatting ──
test('formatTime: spec examples and edges', () => {
  assert.equal(T.formatTime(151.29), '2:31');
  assert.equal(T.formatTime(0), '0:00');
  assert.equal(T.formatTime(0.9), '0:00');
  assert.equal(T.formatTime(59.99), '0:59');
  assert.equal(T.formatTime(60), '1:00');
  assert.equal(T.formatTime(120), '2:00');
  assert.equal(T.formatTime(300), '5:00');
  assert.equal(T.formatTime(3599), '59:59');
  assert.equal(T.formatTime(3600), '1:00:00');
  assert.equal(T.formatTime(3725), '1:02:05');
});
test('formatTime: NaN / negative / Infinity / non-number never yield NaN', () => {
  for (const v of [NaN, -5, Infinity, -Infinity, undefined, null, '12', {}]) {
    assert.equal(T.formatTime(v), '0:00', String(v));
  }
});

// ── scrub vs prop precedence ──
test('scrub value wins over incoming positionSec', () => {
  assert.equal(T.resolveDisplayPosition(42, 10, 100), 42);
  assert.equal(T.resolveDisplayPosition(0, 10, 100), 0, 'scrub of 0 is a real value, not "unset"');
});
test('no scrub: follows positionSec', () => {
  assert.equal(T.resolveDisplayPosition(null, 10, 100), 10);
});
test('position > duration, negative, NaN, duration 0 are all clamped', () => {
  assert.equal(T.resolveDisplayPosition(null, 500, 100), 100);
  assert.equal(T.resolveDisplayPosition(null, -3, 100), 0);
  assert.equal(T.resolveDisplayPosition(null, NaN, 100), 0);
  assert.equal(T.resolveDisplayPosition(null, 50, 0), 0);
  assert.equal(T.resolveDisplayPosition(null, 50, NaN), 0);
  assert.equal(T.resolveDisplayPosition(999, 0, 100), 100);
});
test('fraction: 0 with no duration, within [0,1] otherwise', () => {
  assert.equal(T.fraction(10, 0), 0);
  assert.equal(T.fraction(NaN, 100), 0);
  assert.equal(T.fraction(50, 100), 0.5);
  assert.equal(T.fraction(500, 100), 1);
  assert.equal(T.fraction(-1, 100), 0);
});

// ── pointer -> seconds (drag released outside the bar) ──
test('positionFromPointer clamps outside the bar and guards zero width', () => {
  assert.equal(T.positionFromPointer(150, 100, 200, 60), 15);
  assert.equal(T.positionFromPointer(-500, 100, 200, 60), 0, 'released far left');
  assert.equal(T.positionFromPointer(9999, 100, 200, 60), 60, 'released far right');
  assert.equal(T.positionFromPointer(150, 100, 0, 60), 0, 'zero-width bar');
  assert.equal(T.positionFromPointer(150, 100, 200, 0), 0, 'zero duration');
  assert.equal(T.positionFromPointer(NaN, 100, 200, 60), 0);
});

// ── status -> affordance ──
test('affordanceFor covers all six statuses', () => {
  const a = (s, d = 100) => T.affordanceFor(s, d);
  assert.equal(a('idle').action, null);
  assert.equal(a('idle').seekable, false, 'no seek while idle');
  assert.equal(a('loading').action, null);
  assert.equal(a('loading').seekable, false);
  assert.equal(a('loading').tone, 'busy');
  assert.equal(a('ready').action, 'play');
  assert.equal(a('ready').seekable, true);
  assert.equal(a('playing').action, 'pause');
  assert.equal(a('ended').action, 'replay');
  assert.equal(a('ended').seekable, true);
  assert.equal(a('error').action, null);
  assert.equal(a('error').seekable, false);
  assert.equal(a('error').tone, 'error');
  assert.ok(a('error').hint, 'error is explained, not dead');
  assert.ok(a('loading').hint);
});
test('duration 0 disables play and seek even when ready', () => {
  assert.equal(T.affordanceFor('ready', 0).action, null);
  assert.equal(T.affordanceFor('ready', NaN).seekable, false);
  assert.equal(T.affordanceFor('playing', 0).seekable, false);
});

// ── space: typing vs transport ──
const sp = (target, extra = {}) => ({ key: ' ', code: 'Space', target, ...extra });
test('space toggles from a neutral target', () => {
  assert.equal(T.spaceKeyAction(sp({ tagName: 'BODY' }), 'ready', 100), 'play');
  assert.equal(T.spaceKeyAction(sp({ tagName: 'DIV' }), 'playing', 100), 'pause');
  assert.equal(T.spaceKeyAction(sp({ tagName: 'DIV' }), 'ended', 100), 'replay');
  assert.equal(T.spaceKeyAction(sp(null), 'ready', 100), 'play');
});
test('space while TYPING is left alone', () => {
  for (const t of [
    { tagName: 'INPUT', type: 'text' },
    { tagName: 'INPUT', type: 'search' },
    { tagName: 'INPUT', type: 'email' },
    { tagName: 'INPUT' },
    { tagName: 'TEXTAREA' },
    { tagName: 'DIV', isContentEditable: true },
    { tagName: 'DIV', contentEditable: '' },
    { tagName: 'DIV', contentEditable: 'true' },
    { tagName: 'DIV', role: 'textbox' },
  ]) {
    assert.equal(T.spaceKeyAction(sp(t), 'ready', 100), null, JSON.stringify(t));
  }
});
test('space on natively-activating controls is left alone (no double fire)', () => {
  for (const t of [{ tagName: 'BUTTON' }, { tagName: 'A' }, { tagName: 'SELECT' }, { tagName: 'INPUT', type: 'checkbox' }, { tagName: 'DIV', role: 'button' }]) {
    assert.equal(T.spaceKeyAction(sp(t), 'ready', 100), null, JSON.stringify(t));
  }
});
test('range input (the zoom slider) and the seek slider do not swallow space', () => {
  assert.equal(T.spaceKeyAction(sp({ tagName: 'INPUT', type: 'range' }), 'ready', 100), 'play');
  assert.equal(T.spaceKeyAction(sp({ tagName: 'DIV', role: 'slider' }), 'ready', 100), 'play');
});
test('space ignored when: not space, held, composing, modified, already handled', () => {
  const div = { tagName: 'DIV' };
  assert.equal(T.spaceKeyAction({ key: 'a', target: div }, 'ready', 100), null);
  assert.equal(T.spaceKeyAction(sp(div, { repeat: true }), 'ready', 100), null);
  assert.equal(T.spaceKeyAction(sp(div, { isComposing: true }), 'ready', 100), null);
  assert.equal(T.spaceKeyAction(sp(div, { defaultPrevented: true }), 'ready', 100), null);
  for (const m of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    assert.equal(T.spaceKeyAction(sp(div, { [m]: true }), 'ready', 100), null, m);
  }
});
test('space does nothing (and so is not preventDefault-ed) in non-actionable statuses', () => {
  for (const s of ['idle', 'loading', 'error']) {
    assert.equal(T.spaceKeyAction(sp({ tagName: 'BODY' }), s, 100), null, s);
  }
  assert.equal(T.spaceKeyAction(sp({ tagName: 'BODY' }), 'ready', 0), null);
});

// ── keyboard seeking ──
test('keySeekTarget: arrows, pages, home/end, clamping, modifiers', () => {
  assert.equal(T.keySeekTarget('ArrowRight', 10, 100), 15);
  assert.equal(T.keySeekTarget('ArrowLeft', 10, 100), 5);
  assert.equal(T.keySeekTarget('ArrowLeft', 2, 100), 0);
  assert.equal(T.keySeekTarget('ArrowRight', 98, 100), 100);
  assert.equal(T.keySeekTarget('PageUp', 10, 100), 25);
  assert.equal(T.keySeekTarget('Home', 50, 100), 0);
  assert.equal(T.keySeekTarget('End', 50, 100), 100);
  assert.equal(T.keySeekTarget('a', 50, 100), null);
  assert.equal(T.keySeekTarget('ArrowRight', 10, 100, { ctrlKey: true }), null);
  assert.equal(T.keySeekTarget('ArrowRight', NaN, 100), 5);
  assert.equal(T.keySeekTarget('End', 0, 0), 0);
});

// ── rendered markup, all six statuses ──
test('renders in every status without NaN and with a named play button', () => {
  for (const status of ['idle', 'loading', 'ready', 'playing', 'ended', 'error']) {
    const html = render({ status });
    assert.doesNotMatch(html, /NaN|undefined/, status);
    assert.match(html, /data-testid="transport-play"/, status);
    assert.ok(attr(html, 'aria-label'), status);
  }
});
test('play button name reflects state; disabled only when it cannot act', () => {
  const btn = (p) => render(p).match(/<button[^>]*data-testid="transport-play"[^>]*>/)[0];
  assert.match(btn({ status: 'ready' }), /aria-label="Play"/);
  assert.doesNotMatch(btn({ status: 'ready' }), /disabled/);
  assert.match(btn({ status: 'playing' }), /aria-label="Pause"/);
  assert.match(btn({ status: 'ended' }), /aria-label="Replay"/);
  assert.doesNotMatch(btn({ status: 'ended' }), /disabled/);
  for (const status of ['idle', 'loading', 'error']) assert.match(btn({ status }), /disabled/, status);
});
const seekOf = (html) => html.match(/<input[^>]*data-testid="transport-seek"[^>]*>/)[0];
test('seek is a REAL range input (design v1.4 P1.1) with a human valuetext, not the zoom slider', () => {
  const slider = seekOf(render({ status: 'playing', positionSec: 83.4, durationSec: 151.29 }));
  assert.match(slider, /type="range"/);
  assert.match(slider, /aria-label="Song position"/);
  assert.doesNotMatch(slider, /Timeline zoom|zoom-slider/);
  assert.match(slider, /min="0"/);
  assert.match(slider, /max="151.29"/);
  assert.match(slider, /value="83.4"/);
  assert.match(slider, /aria-valuetext="1:23 of 2:31"/);
  assert.doesNotMatch(slider, /disabled/);
  assert.doesNotMatch(slider, /role="slider"/, 'a native range needs no role');
});
test('the drawn thumb follows the range input, so its focus ring can show (input:focus-visible + .thumb)', () => {
  const html = render({ status: 'playing', positionSec: 50, durationSec: 100 });
  assert.match(html, /data-testid="transport-seek"[^>]*\/><div class="thumb" aria-hidden="true" style="left:50%"/);
  const css = readFileSync(join(WEB, 'src/components/play/Transport.module.css'), 'utf8');
  assert.match(css, /\.range:focus-visible \+ \.thumb\s*\{\s*outline:\s*2px solid var\(--accent\)/);
  assert.match(css, /\.range\s*\{[^}]*height:\s*var\(--touch-min, 44px\)/, 'the seek target is 44px tall');
});
test('hostile props: duration 0, position > duration, negative, NaN', () => {
  let h = render({ durationSec: 0, positionSec: 30 });
  assert.match(h, /aria-valuetext="0:00 of 0:00"/);
  assert.match(h, /width:0%/);
  h = render({ status: 'playing', positionSec: 999, durationSec: 100 });
  assert.match(h, /aria-valuetext="1:40 of 1:40"/);
  assert.match(h, /width:100%/);
  h = render({ status: 'playing', positionSec: -10, durationSec: 100 });
  assert.match(h, /aria-valuetext="0:00 of 1:40"/);
  h = render({ status: 'playing', positionSec: NaN, durationSec: NaN });
  assert.doesNotMatch(h, /NaN/);
  assert.match(h, /aria-valuetext="0:00 of 0:00"/);
});
test('seek, -5 and +5 are disabled when idle/loading/error', () => {
  for (const status of ['idle', 'loading', 'error']) {
    const h = render({ status });
    assert.match(seekOf(h), /disabled/, status);
    assert.match(h, /<button[^>]*aria-label="Back 5 seconds"[^>]*disabled/, status);
    assert.match(h, /<button[^>]*aria-label="Forward 5 seconds"[^>]*disabled/, status);
  }
  assert.doesNotMatch(seekOf(render({ status: 'ready' })), /disabled/);
});
test('error and loading explain themselves; error is an alert', () => {
  assert.match(render({ status: 'error' }), /role="alert"[^>]*>Playback unavailable/);
  assert.match(render({ status: 'loading' }), /aria-busy="true"/);
  assert.match(render({ status: 'loading' }), /Loading stems/);
  assert.doesNotMatch(render({ status: 'ready' }), /transport-hint/);
});
test('time readout: elapsed and remaining under the bar', () => {
  const h = render({ status: 'playing', positionSec: 83.4, durationSec: 151.29 });
  assert.match(h, /data-testid="transport-time"[^>]*><span>1:23<\/span><span>-1:07<\/span>/);
  assert.equal(T.remainingText(83.4, 151.29), '-1:07');
  assert.equal(T.remainingText(NaN, 0), '-0:00');
});
test('section ticks and the loop band are drawn on the seek line; the readout states the run', () => {
  const h = render({
    status: 'playing', positionSec: 10, durationSec: 100, ticks: [0, 25, 50, 150],
    loopBand: { startSec: 25, endSec: 75 }, loopText: 'Looping Verse 1 → Chorus 1 · 0:25–1:15', loopState: 'on',
  });
  assert.equal((h.match(/class="tick"/g) || []).length, 2, 'ticks inside (0, duration) only');
  assert.match(h, /data-testid="transport-loop-band" style="left:25%;width:50%"/);
  assert.match(h, /data-testid="transport-loop-text">Looping Verse 1 → Chorus 1 · 0:25–1:15</);
  assert.doesNotMatch(render({ status: 'playing', durationSec: 100, loopBand: null }), /transport-loop-band/);
});
test('the loop button: on (pressed) / off / disabled-with-aria-disabled and the P2.1 label', () => {
  const btn = (loopState) => render({ loopState }).match(/<button[^>]*data-testid="transport-loop"[^>]*>/)[0];
  assert.match(btn('on'), /aria-pressed="true"/);
  assert.match(btn('on'), /aria-label="Loop"/);
  assert.match(btn('off'), /aria-pressed="false"/);
  assert.doesNotMatch(btn('off'), /aria-disabled/);
  const d = btn('disabled');
  assert.match(d, /aria-disabled="true"/);
  assert.match(d, /aria-label="Tap a section to loop it"/);
  assert.doesNotMatch(d, / disabled=""/, 'shown and focusable, not removed from the tab order');
});
test('the Mix button shows the mix state and opens a dialog; absent where the mixer is always shown', () => {
  const h = render({ mix: { label: 'guitar off', open: false, onOpen: noop } });
  assert.match(h, /<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*data-testid="transport-mix"[^>]*><span class="mixName">Mix<\/span><span class="mixState">guitar off<\/span>/);
  assert.doesNotMatch(render({}), /transport-mix/);
});
test('transport order (P1.1): -5 s, Play/Pause, +5 s, Loop, Mix', () => {
  const h = render({ mix: { label: 'full song', open: false, onOpen: noop } });
  const order = [...h.matchAll(/<button[^>]*(?:aria-label="([^"]+)"|data-testid="transport-mix")/g)].map((m) => m[1] ?? 'Mix');
  assert.deepEqual(order, ['Back 5 seconds', 'Play', 'Forward 5 seconds', 'Tap a section to loop it', 'Mix']);
});

test('(DOM) -5 s / +5 s seek from the engine position, clamped; the loop button toggles unless disabled', async () => {
  await withDom(async (dom) => {
    const seeks = [];
    let toggles = 0;
    const props = { status: 'playing', positionSec: 3, durationSec: 100, onPlay: noop, onPause: noop, onSeek: (s) => seeks.push(s), onToggleLoop: () => toggles++ };
    const host = await dom.mount(React.createElement(T.Transport, { ...props, loopState: 'on' }));
    await dom.act(() => dom.find('[aria-label="Back 5 seconds"]').click());
    await dom.act(() => dom.find('[aria-label="Forward 5 seconds"]').click());
    assert.deepEqual(seeks, [0, 8]);
    await dom.act(() => dom.find('[data-testid="transport-loop"]').click());
    assert.equal(toggles, 1);
    await dom.rerender(host, React.createElement(T.Transport, { ...props, loopState: 'disabled' }));
    await dom.act(() => dom.find('[data-testid="transport-loop"]').click());
    assert.equal(toggles, 1, 'a disabled loop button does nothing');
    await dom.unmountAll();
  });
});
