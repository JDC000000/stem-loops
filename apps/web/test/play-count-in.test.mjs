// Count-in (Phase C C2; story 4.8). Two layers:
//   1. lib/play/count-in.ts, pure: the timing math, cancellation, the BPM gate
//      and the storage, with a FAKE clock (no real waiting).
//   2. the real PlayerScreen through the module graph + happy-dom: the menu
//      toggle, the four triggers, no count on a loop wrap, DR-D4 gestures
//      unchanged. Web Audio does not exist here, so the clicks are silent; the
//      sound itself is not covered (see the PR body).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COUNT_IN_BEATS, COUNT_IN_KEY, COUNT_IN_NEEDS_BPM, CANCEL_SWALLOW_MS, beatSec, clickOffsets, countInBpm, countInSec,
  createCountIn, cancelOnOtherInput, readCountIn, writeCountIn,
} from '../src/lib/play/count-in.ts';
import { buildModuleGraph } from './helpers/module-graph.mjs';
import { withDom } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

/** A fake clock: timers fire only when `tick` moves time past them. */
function fakeClock() {
  let t = 0;
  let n = 0;
  const q = new Map();
  return {
    now: () => t,
    setTimeout: (cb, ms) => { const id = ++n; q.set(id, { at: t + ms, cb }); return id; },
    clearTimeout: (id) => { q.delete(id); },
    tick(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]);
        t = next[1].at;
        next[1].cb();
      }
      t = end;
    },
    pending: () => q.size,
  };
}
function harness(bpm) {
  const clock = fakeClock();
  const beats = [];
  const clicks = [];
  let stops = 0;
  let thens = 0;
  const c = createCountIn({
    bpm, timers: clock, onBeat: (b) => beats.push(b),
    clicks: { schedule: (off, accent) => clicks.push([off, accent]), stop: () => { stops += 1; } },
  });
  return { clock, beats, clicks, c, then: () => { thens += 1; }, get thens() { return thens; }, get stops() { return stops; } };
}

// ═══ timing math ═════════════════════════════════════════════════════════════

test('a beat is 60/BPM seconds; a count-in is 4 beats; clicks sit on the beats', () => {
  assert.equal(COUNT_IN_BEATS, 4);
  assert.equal(beatSec(120), 0.5);
  assert.equal(beatSec(90), 60 / 90);
  assert.equal(countInSec(120), 2);
  assert.equal(countInSec(80), 3);
  assert.deepEqual(clickOffsets(120), [0, 0.5, 1, 1.5]);
  assert.deepEqual(clickOffsets(60), [0, 1, 2, 3]);
});

test('fake clock: 4-3-2-1 on the beats, then playback starts exactly at 4 beats (120 BPM = 2000 ms)', () => {
  const h = harness(120);
  assert.equal(h.c.start(h.then), true);
  assert.deepEqual(h.beats, [4]);
  assert.deepEqual(h.clicks, [[0, true], [0.5, false], [1, false], [1.5, false]], 'four clicks, the first accented');
  h.clock.tick(499); assert.deepEqual(h.beats, [4]);
  h.clock.tick(1); assert.deepEqual(h.beats, [4, 3]);
  h.clock.tick(500); assert.deepEqual(h.beats, [4, 3, 2]);
  h.clock.tick(500); assert.deepEqual(h.beats, [4, 3, 2, 1]);
  h.clock.tick(499); assert.equal(h.thens, 0, 'not before the 4th beat has elapsed');
  assert.equal(h.c.active, true);
  h.clock.tick(1);
  assert.equal(h.thens, 1, 'then() runs once, at 4 x 60/BPM');
  assert.deepEqual(h.beats, [4, 3, 2, 1, null], 'the numbers clear');
  assert.equal(h.c.active, false);
  assert.equal(h.clock.pending(), 0);
});

test('a different tempo changes the length: 90 BPM = 2667 ms (not a fixed 2 s, not 4 x BPM/60)', () => {
  const h = harness(90);
  h.c.start(h.then);
  h.clock.tick(2666); assert.equal(h.thens, 0);
  h.clock.tick(1); assert.equal(h.thens, 1);
});

// ═══ cancellation ════════════════════════════════════════════════════════════

test('cancel: no further numbers, the clicks are stopped, and then() never runs', () => {
  const h = harness(120);
  h.c.start(h.then);
  h.clock.tick(600);
  h.c.cancel(true);
  assert.equal(h.c.active, false);
  assert.equal(h.stops, 1);
  assert.equal(h.beats.at(-1), null);
  const seen = h.beats.length;
  h.clock.tick(10_000);
  assert.equal(h.thens, 0, 'cancelled: playback never starts');
  assert.equal(h.beats.length, seen);
  assert.equal(h.clock.pending(), 0);
});

test('a user cancel arms the swallow window: the same gesture\'s Play click is not a new count', () => {
  const h = harness(120);
  h.c.start(h.then);
  assert.equal(h.c.swallowPlay(), false);
  h.c.cancel(true);
  assert.equal(h.c.swallowPlay(), true);
  h.clock.tick(CANCEL_SWALLOW_MS);
  assert.equal(h.c.swallowPlay(), false, 'only for a moment');
  // a silent cancel (unmount, toggle off) does not
  const g = harness(120);
  g.c.start(g.then); g.c.cancel();
  assert.equal(g.c.swallowPlay(), false);
});

test('starting again replaces a running count; the first then() is dropped', () => {
  const h = harness(120);
  let a = 0; let b = 0;
  h.c.start(() => { a += 1; });
  h.clock.tick(700);
  h.c.start(() => { b += 1; });
  h.clock.tick(2000);
  assert.deepEqual([a, b], [0, 1]);
});

test('cancelOnOtherInput: a pointerdown or key press anywhere cancels; key repeat does not; detach removes it', () => {
  const listeners = [];
  const doc = {
    addEventListener: (t, f, cap) => listeners.push([t, f, cap]),
    removeEventListener: (t, f) => { const i = listeners.findIndex((l) => l[0] === t && l[1] === f); if (i >= 0) listeners.splice(i, 1); },
  };
  const h = harness(120);
  h.c.start(h.then);
  const off = cancelOnOtherInput(h.c, doc);
  assert.deepEqual(listeners.map((l) => l[0]).sort(), ['keydown', 'pointerdown']);
  assert.ok(listeners.every((l) => l[2] === true), 'capture phase: before the control handles it');
  const fire = (t, e = {}) => listeners.find((l) => l[0] === t)[1](e);
  fire('keydown', { repeat: true });
  assert.equal(h.c.active, true, 'a held key is not a new press');
  fire('pointerdown');
  assert.equal(h.c.active, false);
  assert.equal(h.thens, 0);
  off();
  assert.equal(listeners.length, 0);
  const h2 = harness(120);
  h2.c.start(h2.then);
  const off2 = cancelOnOtherInput(h2.c, doc);
  fire('keydown', {});
  assert.equal(h2.c.active, false, 'a key press cancels');
  off2();
});

// ═══ no BPM ══════════════════════════════════════════════════════════════════

test('no usable BPM: no count at all (then() runs immediately) and the BPM gate says so', () => {
  for (const bad of [null, undefined, 0, -90, NaN, Infinity, '', 'fast', 29, 301]) {
    assert.equal(countInBpm(bad), null, String(bad));
    const h = harness(bad);
    assert.equal(h.c.start(h.then), false);
    assert.equal(h.thens, 1, `no bpm ${String(bad)}: runs at once`);
    assert.deepEqual(h.beats, []);
    assert.equal(h.clock.pending(), 0);
  }
  assert.equal(countInBpm(101.6), 101.6);
  assert.equal(countInBpm('82.5'), 82.5, 'jobs.bpm arrives as a numeric string');
  assert.match(COUNT_IN_NEEDS_BPM, /tempo/);
});

// ═══ storage ═════════════════════════════════════════════════════════════════

test('storage: off by default, remembered, and a throwing localStorage never throws', async () => {
  await withDom(async () => {
    try { globalThis.localStorage.removeItem(COUNT_IN_KEY); } catch { /* none */ }
    assert.equal(readCountIn(), false, 'off by default');
    writeCountIn(true);
    assert.equal(globalThis.localStorage.getItem(COUNT_IN_KEY), '1');
    assert.equal(readCountIn(), true);
    writeCountIn(false);
    assert.equal(readCountIn(), false);
  });
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  try {
    assert.equal(readCountIn(), false);
    assert.doesNotThrow(() => writeCountIn(true));
  } finally {
    if (real) Object.defineProperty(globalThis, 'localStorage', real); else delete globalThis.localStorage;
  }
});

// ═══ the screen ══════════════════════════════════════════════════════════════

const graph = buildModuleGraph({
  name: 'play-count-in',
  entries: ['components/play/Player.tsx'],
  overrides: {
    'components/ChordOverlay.tsx': `import { createElement } from 'react';
      export const ChordOverlay = (props) => createElement('div', { 'data-testid': 'chord-overlay' });
      export default ChordOverlay;`,
    'lib/play/report-failure.ts': 'export function reportStemFetchFailure() {}',
  },
});
const React = (await import('react')).default;
const Player = await import(graph.url('components/play/Player.tsx'));

const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const SECTIONS = [
  { startSec: 0, endSec: 9, label: 'intro' },
  { startSec: 9, endSec: 47, label: 'verse' },
  { startSec: 47, endSec: 66, label: 'chorus' },
  { startSec: 66, endSec: 104, label: 'verse' },
];
const snap = (over = {}) => ({
  status: 'ready', positionSec: 20, durationSec: 120,
  stems: STEMS.map((name) => ({ name, availability: 'ready', gain: 0.8, muted: false, soloed: false, effectivelySilent: false })),
  loop: null, degraded: null, error: null, ...over,
});
const BPM = 300; // the fastest accepted tempo: a whole count is 800 ms of real time
const WAIT = 900;

/** Records every engine call, in order. Playing/paused follows pause()/play(). */
function Rig({ log, bpm = BPM, status0 = 'ready' }) {
  const [loop, setLoop] = React.useState(null);
  const [status, setStatus] = React.useState(status0);
  return React.createElement(Player.PlayerView, {
    jobId: 'job-1', phase: { kind: 'ready' }, snapshot: snap({ loop, status }), sections: SECTIONS,
    onPlay: () => { log.push('play'); setStatus('playing'); },
    onPause: () => { log.push('pause'); setStatus('ready'); },
    onSeek: (t) => log.push(`seek ${t}`),
    onGain() {}, onMute() {}, onSolo() {},
    onLoop: (r) => { log.push(`loop ${r ? `${r.startSec}-${r.endSec}` : 'off'}`); setLoop(r); },
    title: 'Lucky Ticket', bpm, musicalKey: 'A major',
  });
}
const setMedia = () => { globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }); };
const chip = (dom, i) => dom.findAll('[data-testid="section-strip"] button')[i];
const tap = (dom, el) => dom.act(() => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
const countNum = (dom) => dom.find('[data-testid="count-in"]')?.getAttribute('data-beat') ?? null;
async function turnOn(dom) {
  await dom.act(() => dom.find('button[aria-controls="player-menu"]').click());
  await dom.act(() => dom.find('[data-testid="count-in-toggle"]').click());
  await dom.act(() => dom.find('button[aria-controls="player-menu"]').click());
}
const fresh = () => { try { globalThis.localStorage?.removeItem(COUNT_IN_KEY); } catch { /* none */ } };

test('menu: "Count-in" is one contiguous item, off by default, a 44px pressed-state button; the toggle is remembered', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    await dom.mount(React.createElement(Rig, { log: [] }));
    await dom.act(() => dom.find('button[aria-controls="player-menu"]').click());
    const item = dom.find('[data-testid="count-in-item"]');
    assert.ok(item, 'in the ⋯ menu');
    const t = dom.find('[data-testid="count-in-toggle"]');
    assert.equal(t.getAttribute('aria-pressed'), 'false', 'off by default');
    assert.equal(t.disabled, false);
    assert.match(t.textContent, /Count-in\s*Off/);
    await dom.act(() => t.click());
    assert.equal(dom.find('[data-testid="count-in-toggle"]').getAttribute('aria-pressed'), 'true');
    assert.equal(globalThis.localStorage.getItem(COUNT_IN_KEY), '1', 'remembered');
  });
  await withDom(async (dom) => {
    setMedia();
    globalThis.localStorage.setItem(COUNT_IN_KEY, '1');
    await dom.mount(React.createElement(Rig, { log: [] }));
    await dom.act(() => dom.find('button[aria-controls="player-menu"]').click());
    assert.equal(dom.find('[data-testid="count-in-toggle"]').getAttribute('aria-pressed'), 'true', 'a later visit reads it back');
    fresh();
  });
  const css = read('src/components/play/Player.module.css');
  assert.match(css, /\.countInItem \.menuItem\[aria-pressed='true'\]\s*\{[^}]*--bg-selected[^}]*2px solid\b|\.countInItem \.menuItem\[aria-pressed='true'\]\s*\{[^}]*inset 0 0 0 2px var\(--text-primary\)/s, 'selected = #222 + 2px white');
});

test('menu: with NO BPM the toggle is disabled and gives a one-line reason; a stored "on" does nothing', async () => {
  await withDom(async (dom) => {
    setMedia();
    globalThis.localStorage.setItem(COUNT_IN_KEY, '1');
    const log = [];
    await dom.mount(React.createElement(Rig, { log, bpm: null }));
    await dom.act(() => dom.find('button[aria-controls="player-menu"]').click());
    const t = dom.find('[data-testid="count-in-toggle"]');
    assert.equal(t.disabled, true);
    assert.equal(t.getAttribute('aria-pressed'), 'false');
    assert.equal(t.getAttribute('aria-describedby'), 'player-count-in-note');
    assert.equal(dom.find('#player-count-in-note').textContent, COUNT_IN_NEEDS_BPM);
    await dom.act(() => t.click());
    assert.equal(globalThis.localStorage.getItem(COUNT_IN_KEY), '1', 'a disabled toggle writes nothing');
    await dom.act(() => dom.find('button[aria-controls="player-menu"]').click());
    await tap(dom, chip(dom, 2));
    assert.deepEqual(log, ['seek 47', 'play'], 'no BPM: immediate, no count');
    assert.equal(countNum(dom), null);
    fresh();
  });
});

test('OFF (default): tap = jump + play at once, exactly as before (DR-D4)', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    await dom.mount(React.createElement(Rig, { log }));
    await tap(dom, chip(dom, 2));
    assert.deepEqual(log, ['seek 47', 'play']);
    assert.equal(countNum(dom), null);
  });
});

test('ON: a chip tap seeks, shows 4-3-2-1 (neutral, no animation), and plays only after the bar', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    await dom.mount(React.createElement(Rig, { log }));
    await turnOn(dom);
    await tap(dom, chip(dom, 2));
    assert.deepEqual(log, ['seek 47'], 'the playhead moves now, playback waits');
    assert.equal(countNum(dom), '4');
    assert.equal(dom.find('[data-testid="count-in"]').getAttribute('role'), 'status');
    await dom.advance(250); assert.equal(countNum(dom), '3');
    await dom.advance(200); assert.equal(countNum(dom), '2');
    await dom.advance(200); assert.equal(countNum(dom), '1');
    assert.deepEqual(log, ['seek 47']);
    await dom.advance(250);
    assert.deepEqual(log, ['seek 47', 'play'], 'play after 4 beats');
    assert.equal(countNum(dom), null);
  });
});

test('ON: Play from pause counts in; Play during the count cancels it (and its click does not restart it)', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    await dom.mount(React.createElement(Rig, { log }));
    await turnOn(dom);
    await dom.act(() => dom.find('[data-testid="transport-play"]').click());
    assert.equal(countNum(dom), '4');
    assert.deepEqual(log, []);
    await dom.advance(WAIT);
    assert.deepEqual(log, ['play']);
    // again, cancelled by pressing Play mid-count
    log.length = 0;
    await dom.act(() => dom.find('[data-testid="transport-play"]').click()); // playing -> pause
    assert.deepEqual(log, ['pause']);
    log.length = 0;
    await dom.act(() => dom.find('[data-testid="transport-play"]').click());
    assert.equal(countNum(dom), '4');
    await dom.pointer('pointerdown', dom.find('[data-testid="transport-play"]'), { pointerType: 'touch', clientX: 1, clientY: 1 });
    assert.equal(countNum(dom), null, 'a tap on anything cancels');
    await dom.act(() => dom.find('[data-testid="transport-play"]').click()); // that tap's own click
    assert.equal(countNum(dom), null, 'its click is swallowed: no new count');
    await dom.advance(WAIT);
    assert.deepEqual(log, [], 'never played');
  });
});

test('ON: any other tap cancels the count; nothing plays; a new chip tap counts in afresh', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    await dom.mount(React.createElement(Rig, { log }));
    await turnOn(dom);
    await tap(dom, chip(dom, 1));
    assert.equal(countNum(dom), '4');
    await dom.pointer('pointerdown', dom.find('[data-testid="player-title"]'), { pointerType: 'touch', clientX: 1, clientY: 1 });
    assert.equal(countNum(dom), null);
    await dom.advance(WAIT);
    assert.deepEqual(log, ['seek 9'], 'cancelled: no play');
    // switching chips mid-count: the first count is replaced
    await tap(dom, chip(dom, 1));
    await dom.pointer('pointerdown', chip(dom, 3), { pointerType: 'touch', clientX: 1, clientY: 1 });
    await dom.pointer('pointerup', chip(dom, 3), { pointerType: 'touch', clientX: 1, clientY: 1 });
    await tap(dom, chip(dom, 3));
    assert.equal(countNum(dom), '4');
    await dom.advance(WAIT);
    assert.deepEqual(log, ['seek 9', 'seek 9', 'seek 66', 'play'], 'exactly one play, for the last chip');
  });
});

test('ON: a long-press (500 ms) loop start counts in, and still LOOPS (DR-D4 unchanged)', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    await dom.mount(React.createElement(Rig, { log }));
    await turnOn(dom);
    await dom.pointer('pointerdown', chip(dom, 2), { pointerType: 'touch', clientX: 5, clientY: 5 });
    await dom.advance(450);
    assert.deepEqual(log, [], 'under 500 ms: nothing');
    await dom.advance(100);
    assert.ok(log.includes('loop 47-66'), `the hold loops: ${log}`);
    assert.ok(log.includes('seek 47'));
    assert.ok(!log.includes('play'), 'play waits for the count');
    assert.equal(countNum(dom), '4');
    await dom.pointer('pointerup', chip(dom, 2), { pointerType: 'touch', clientX: 5, clientY: 5 });
    assert.equal(countNum(dom), '4', 'releasing the hold is not "another tap": the count goes on');
    await tap(dom, chip(dom, 2)); // the release click is swallowed (never a jump)
    assert.ok(!log.includes('seek 47') || log.filter((l) => l === 'seek 47').length === 1);
    await dom.advance(WAIT);
    assert.equal(log.at(-1), 'play');
    assert.equal(log.filter((l) => l === 'play').length, 1);
  });
});

test('ON: ⟲ counts in only while playing; paused it just moves the playhead', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    await dom.mount(React.createElement(Rig, { log, status0: 'playing' }));
    await turnOn(dom);
    await dom.act(() => dom.find('[data-testid="transport-restart"]').click());
    assert.equal(log[0], 'pause');
    assert.match(log[1], /^seek /);
    assert.equal(countNum(dom), '4');
    await dom.advance(WAIT);
    assert.equal(log.at(-1), 'play');
  });
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    await dom.mount(React.createElement(Rig, { log }));
    await turnOn(dom);
    await dom.act(() => dom.find('[data-testid="transport-restart"]').click());
    assert.deepEqual(log.map((l) => l.split(' ')[0]), ['seek']);
    assert.equal(countNum(dom), null);
  });
});

test('NOT on a loop wrap: the count only ever starts from a user action (source guard)', () => {
  // The wrap is the engine's native loop. The screen has no code path from a
  // snapshot/position change to `counted`/`start`: assert that structurally.
  const src = read('src/components/play/PlayerScreen.tsx');
  const callers = [...src.matchAll(/\bcounted\(/g)].length;
  assert.equal(callers, 4, 'tap + hold + ⟲ + Play: nothing else starts a count');
  const effects = [...src.matchAll(/useEffect\(\(\) => \{[^]*?\}, \[[^\]]*\]\);/g)].map((m) => m[0]);
  for (const e of effects) assert.doesNotMatch(e, /counted\(|\.start\(/, 'no effect starts a count');
  assert.doesNotMatch(read('src/lib/play/engine.ts'), /count-in|countIn/i, 'the engine knows nothing of it');
});

test('ON: while looping, position wrapping back to the loop start never counts in', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    const setPosRef = { fn: null };
    function Wrap() {
      const [pos, setPos] = React.useState(60);
      setPosRef.fn = setPos;
      const [loop, setLoop] = React.useState({ startSec: 47, endSec: 66 });
      return React.createElement(Player.PlayerView, {
        jobId: 'j', phase: { kind: 'ready' }, snapshot: snap({ status: 'playing', positionSec: pos, loop }), sections: SECTIONS,
        onPlay: () => log.push('play'), onPause: () => log.push('pause'), onSeek: (t) => log.push(`seek ${t}`),
        onGain() {}, onMute() {}, onSolo() {}, onLoop: (r) => { log.push('loop'); setLoop(r); },
        title: 'x', bpm: BPM, musicalKey: null,
      });
    }
    await dom.mount(React.createElement(Wrap));
    await turnOn(dom);
    await dom.act(() => { setPosRef.fn(65.9); });
    await dom.act(() => { setPosRef.fn(47.1); }); // the wrap
    await dom.act(() => { setPosRef.fn(48); });
    assert.equal(countNum(dom), null);
    await dom.advance(WAIT);
    assert.deepEqual(log, [], 'no pause, seek or play from a wrap');
  });
});

test('brand: the count-in numbers are neutral (never amber or lime); no animation; targets stay 44 px', () => {
  const css = read('src/components/play/Player.module.css');
  const block = css.slice(css.indexOf('/* ── count-in')).replace(/\/\*[^]*?\*\//g, '');
  assert.doesNotMatch(block, /accent|chord-now|#f59e0b|#a3e635/i);
  assert.doesNotMatch(block, /animation|transition|@keyframes/, 'reduced motion: numbers only, nothing moves');
  assert.match(css, /\.menuItem\s*\{[^}]*min-height:\s*var\(--touch-min, 44px\)/);
});
