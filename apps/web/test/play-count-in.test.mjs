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
  createCountIn, cancelOnOtherInput, readCountIn, writeCountIn, createClickSink, timingOffsets, engineCountLatencySec, SETTLE_MS, CLICK_LEAD_SEC, ENGINE_LEAD_SEC,
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

// ═══ clocks (F4) ═════════════════════════════════════════════════════════════

test('timing: numbers land with their clicks, and play() is called early by (engine lead + route latency) minus (click lead + click latency)', () => {
  assert.deepEqual(timingOffsets(null), { ui: 0, downbeat: 0 });
  const t = timingOffsets({ clickLatencySec: 0.02, engineLatencySec: 0.2 });
  assert.ok(Math.abs(t.ui - (CLICK_LEAD_SEC + 0.02)) < 1e-9);
  assert.ok(Math.abs(t.downbeat - (CLICK_LEAD_SEC + 0.02 - ENGINE_LEAD_SEC - 0.2)) < 1e-9);
  assert.ok(t.downbeat < 0, 'a slow route (phone) is called early');
  assert.deepEqual(timingOffsets({ clickLatencySec: NaN, engineLatencySec: -3 }), { ui: CLICK_LEAD_SEC, downbeat: CLICK_LEAD_SEC - ENGINE_LEAD_SEC }, 'garbage latency = 0');
  assert.equal(timingOffsets({ clickLatencySec: 0, engineLatencySec: 99 }).downbeat, CLICK_LEAD_SEC - ENGINE_LEAD_SEC - 0.5, 'capped at 0.5 s');
});

test('timing in the controller: at 120 BPM with 0.2 s route latency play() is called 2000 - 220 ms after the start', () => {
  const clock = fakeClock();
  const beats = [];
  let thens = 0;
  const c = createCountIn({ bpm: 120, timers: clock, onBeat: (b) => beats.push(b), timing: () => ({ clickLatencySec: 0, engineLatencySec: 0.2 }) });
  c.start(() => { thens += 1; });
  const want = 2000 + (CLICK_LEAD_SEC - ENGINE_LEAD_SEC - 0.2) * 1000;
  clock.tick(want - 1); assert.equal(thens, 0);
  clock.tick(1); assert.equal(thens, 1);
  const n = timingOffsets({ clickLatencySec: 0, engineLatencySec: 0.2 }).ui * 1000;
  assert.deepEqual(beats.slice(0, 2), [4, 3], 'the "3" is shifted by the click lead');
  assert.ok(n > 0);
});

// ═══ one click context (F2) ══════════════════════════════════════════════════

function fakeAudio() {
  const made = [];
  class Ctx {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.closed = false; this.resumed = 0; made.push(this); }
    resume() { this.resumed += 1; this.state = 'running'; return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
    createOscillator() { return { frequency: {}, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  return { made, Ctx };
}

test('click sink: ONE AudioContext, opened and resumed synchronously by the first click, reused, closed on close()', () => {
  const real = globalThis.AudioContext;
  const { made, Ctx } = fakeAudio();
  globalThis.AudioContext = Ctx;
  try {
    const sink = createClickSink();
    assert.equal(made.length, 0, 'lazy: nothing until a count');
    sink.schedule(0, true);
    assert.equal(made.length, 1);
    assert.equal(made[0].resumed, 1, 'resume() is called in the same synchronous turn as the first click');
    for (let i = 0; i < 3; i += 1) for (const o of [0, 0.5, 1, 1.5]) sink.schedule(o, o === 0);
    assert.equal(made.length, 1, 'many counts, one context');
    sink.close();
    assert.equal(made[0].closed, true, 'closed on unmount');
    assert.equal(sink.latencySec(), 0);
    sink.schedule(0, true);
    assert.equal(made.filter((c) => !c.closed).length, 1, 'never more than one alive');
  } finally {
    if (real) globalThis.AudioContext = real; else delete globalThis.AudioContext;
  }
});

test('cancel() reports onCancel for an active count only (not on completion)', () => {
  const clock = fakeClock();
  let cancels = 0;
  const c = createCountIn({ bpm: 120, timers: clock, onBeat() {}, onCancel: () => { cancels += 1; } });
  c.cancel(); assert.equal(cancels, 0, 'nothing running');
  c.start(() => {}); c.cancel(true); assert.equal(cancels, 1);
  c.start(() => {}); clock.tick(2100); assert.equal(cancels, 1, 'a finished count is not a cancel');
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

const meta = (log) => {
  if (!log.meta) Object.defineProperty(log, 'meta', { value: { extra: [], order: [] }, enumerable: false });
  return log.meta;
};
/** Records every engine call, in order. Playing/paused follows pause()/play(). */
function Rig({ log, bpm = BPM, status0 = 'ready', loop0 = null }) {
  const [loop, setLoop] = React.useState(loop0);
  const [status, setStatus] = React.useState(status0);
  return React.createElement(Player.PlayerView, {
    jobId: 'job-1', phase: { kind: 'ready' }, snapshot: snap({ loop, status }), sections: SECTIONS,
    onPlay: () => { log.push('play'); meta(log).order.push('play'); setStatus('playing'); },
    onPause: () => { log.push('pause'); setStatus('ready'); },
    onPrime: () => { meta(log).extra.push('prime'); meta(log).order.push('prime'); },
    onUnprime: () => { meta(log).extra.push('unprime'); meta(log).order.push('unprime'); },
    onSeek: (t) => { log.push(`seek ${t}`); meta(log).order.push(`seek ${t}`); },
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
  // Comments may mention the count-in (#383's engine comment does); code may not.
  const engineCode = read('src/lib/play/engine.ts').replace(/\/\*[^]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(engineCode, /count-in|countIn/i, 'the engine knows nothing of it');
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

// ═══ review R1 round 2 ═══════════════════════════════════════════════════════

test('F1: everything that needs the tap happens SYNCHRONOUSLY in the handler; only the transport start waits', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    await dom.mount(React.createElement(Rig, { log }));
    await turnOn(dom);
    // chip tap
    meta(log).order = [];
    chip(dom, 2).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    assert.deepEqual(meta(log).order, ['prime', 'seek 47'], 'prime ran in the very same turn as the tap; play did not');
    await dom.advance(WAIT);
    assert.deepEqual(meta(log).order, ['prime', 'seek 47', 'play'], 'only play() waited for the count');
    // Play from pause
    await dom.act(() => dom.find('[data-testid="transport-play"]').click()); // playing -> pause
    meta(log).order = [];
    dom.find('[data-testid="transport-play"]').click();
    assert.deepEqual(meta(log).order, ['prime'], 'Play: primed synchronously, not played');
    await dom.advance(WAIT);
    assert.deepEqual(meta(log).order, ['prime', 'play']);
  });
});

test('F1: a cancelled count un-primes (the silent element is stopped); a finished one does not', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    await dom.mount(React.createElement(Rig, { log }));
    await turnOn(dom);
    await tap(dom, chip(dom, 1));
    await dom.pointer('pointerdown', dom.find('[data-testid="player-title"]'), { pointerType: 'touch', clientX: 1, clientY: 1 });
    assert.deepEqual(meta(log).extra, ['prime', 'unprime']);
    meta(log).extra.length = 0;
    await tap(dom, chip(dom, 1));
    await dom.advance(WAIT);
    assert.deepEqual(meta(log).extra, ['prime'], 'completed: nothing to undo');
    // replacing a running count must not un-prime AFTER the new prime
    meta(log).extra.length = 0;
    await dom.pointer('pointerdown', chip(dom, 3), { pointerType: 'touch', clientX: 1, clientY: 1 });
    await dom.pointer('pointerup', chip(dom, 3), { pointerType: 'touch', clientX: 1, clientY: 1 });
    await tap(dom, chip(dom, 3));
    assert.equal(meta(log).extra.at(-1), 'prime', 'the last word is the new prime');
  });
});

test('F1 (source): Player.onPrime does the gesture work in order — audio session, element, engine resume — before any await, and play() waits', () => {
  const src = read('src/components/play/Player.tsx');
  const body = src.slice(src.indexOf('const onPrime = useCallback'), src.indexOf('const onUnprime'));
  const at = (t) => body.indexOf(t);
  assert.ok(at('setPlaybackAudioSession') >= 0 && at('setPlaybackAudioSession') < at('outputRef.current?.play()'));
  assert.ok(at('outputRef.current?.play()') < at('engine.play()') && at('engine.play()') < at('engine.pause()'));
  assert.ok(at('engine.pause()') < body.lastIndexOf('outputRef.current?.play()'), 'the element is started again after the engine pause stops it');
  assert.doesNotMatch(body, /await|setTimeout|then\(/, 'nothing deferred');
});

test('F3: a hold that EXTENDS a loop that is already playing does exactly what it did before: no pause, no seek, no count', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    await dom.mount(React.createElement(Rig, { log, status0: 'playing', loop0: { startSec: 47, endSec: 66 } }));
    await turnOn(dom);
    await dom.keydown('Enter', { target: chip(dom, 3), shiftKey: true }); // hold Part 4: extend the run
    assert.ok(log.includes('loop 47-104'), `extended: ${log}`);
    assert.ok(!log.includes('pause') && !log.some((l) => l.startsWith('seek')) && !log.includes('play'), `untouched music: ${log}`);
    assert.equal(countNum(dom), null);
    assert.deepEqual(meta(log).extra, [], 'not primed either');
  });
});

test('F3: a hold that STARTS a loop while playing still counts in (pause, loop, seek to its start, then play)', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    await dom.mount(React.createElement(Rig, { log, status0: 'playing' }));
    await turnOn(dom);
    await dom.keydown('Enter', { target: chip(dom, 2), shiftKey: true });
    assert.equal(log[0], 'pause', 'paused BEFORE the loop is installed');
    assert.ok(log.includes('loop 47-66') && log.includes('seek 47'));
    assert.equal(countNum(dom), '4');
    await dom.advance(WAIT);
    assert.equal(log.at(-1), 'play');
  });
});

test('M7: unmounting mid-count cancels it: play never runs, the numbers are gone, the silent element is stopped', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    const host = await dom.mount(React.createElement(Rig, { log }));
    await turnOn(dom);
    await tap(dom, chip(dom, 2));
    assert.equal(countNum(dom), '4');
    await dom.unmountAll();
    await dom.advance(WAIT);
    assert.ok(!log.includes('play'), `no play after unmount: ${log}`);
    assert.ok(meta(log).extra.includes('unprime'));
    void host;
  });
});

test('M13: switching Count-in OFF in the menu cancels a running count', async () => {
  await withDom(async (dom) => {
    setMedia(); fresh();
    const log = [];
    await dom.mount(React.createElement(Rig, { log }));
    await turnOn(dom);
    await tap(dom, chip(dom, 2));
    assert.equal(countNum(dom), '4');
    // .click() dispatches no pointerdown: only the toggle itself can cancel
    await dom.act(() => dom.find('button[aria-controls="player-menu"]').click());
    await dom.act(() => dom.find('[data-testid="count-in-toggle"]').click());
    assert.equal(countNum(dom), null);
    await dom.advance(WAIT);
    assert.ok(!log.includes('play'));
    assert.equal(globalThis.localStorage.getItem(COUNT_IN_KEY), null);
  });
});

test('F2 (screen): two counts reuse ONE click AudioContext, and unmounting the player closes it', async () => {
  const real = globalThis.AudioContext;
  const { made, Ctx } = fakeAudio();
  try {
    await withDom(async (dom) => {
      setMedia(); fresh();
      globalThis.AudioContext = Ctx;
      const log = [];
      await dom.mount(React.createElement(Rig, { log }));
      await turnOn(dom);
      await tap(dom, chip(dom, 1));
      assert.equal(made.length, 1);
      assert.equal(made[0].resumed >= 1, true, 'resumed inside the tap');
      await dom.advance(WAIT);
      await tap(dom, chip(dom, 2));
      await dom.advance(WAIT);
      assert.equal(made.length, 1, 'the second count reused it');
      assert.equal(made[0].closed, false);
      await dom.unmountAll();
      assert.equal(made[0].closed, true, 'closed on unmount');
      delete globalThis.AudioContext; // before withDom's pollution check
    });
  } finally {
    if (real) globalThis.AudioContext = real; else delete globalThis.AudioContext;
  }
});

// ═══ review R2, round 3 ══════════════════════════════════════════════════════

test('R2-1: engine latency by route — the element route uses the route estimate, every other route the engine context\'s own device latency (never 0)', () => {
  const L = 0.2;
  // desktop / iPad: not routed, route estimate is 0 -> the context's outputLatency, else baseLatency
  assert.equal(engineCountLatencySec({ outputLatency: L, baseLatency: 0.01 }, false, 0), L);
  assert.equal(engineCountLatencySec({ outputLatency: 0, baseLatency: 0.01 }, false, 0), 0.01);
  assert.equal(engineCountLatencySec(null, false, 0), 0);
  // phone route: the route's estimate wins
  assert.equal(engineCountLatencySec({ outputLatency: L }, true, 0.25), 0.25);
  // click and engine on the same device (both L): the downbeat is exactly the lead difference
  const t = timingOffsets({ clickLatencySec: L, engineLatencySec: engineCountLatencySec({ outputLatency: L }, false, 0) });
  assert.ok(Math.abs(t.downbeat - (CLICK_LEAD_SEC - ENGINE_LEAD_SEC)) < 1e-9, 'L cancels: not +L late');
  // the broken version (engine 0 on this route) would be L late
  assert.ok(Math.abs(timingOffsets({ clickLatencySec: L, engineLatencySec: 0 }).downbeat - t.downbeat - L) < 1e-9);
});

test('R2-1 (source): Player feeds the count the engine context latency on the non-element route', () => {
  const src = read('src/components/play/Player.tsx');
  const body = src.slice(src.indexOf('const getEngineLatencySec'), src.indexOf('const getEngineLatencySec') + 400);
  assert.match(body, /engineCountLatencySec\(src, routed, routeLatencySec\(src, routed\)\)/);
});

test('R2-2: the first count reads latencies AFTER the in-gesture resume: both read 0 at start, real at SETTLE_MS, and the downbeat follows the later reading', () => {
  const clock = fakeClock();
  let ready = false;
  let thens = 0;
  const c = createCountIn({
    bpm: 120, timers: clock, onBeat() {},
    timing: () => (ready ? { clickLatencySec: 0.2, engineLatencySec: 0.05 } : { clickLatencySec: 0, engineLatencySec: 0 }),
  });
  c.start(() => { thens += 1; });
  ready = true; // the contexts resumed and now report their latency
  clock.tick(SETTLE_MS);
  const want = 2000 + timingOffsets({ clickLatencySec: 0.2, engineLatencySec: 0.05 }).downbeat * 1000; // the LATER reading
  clock.tick(want - SETTLE_MS - 1); assert.equal(thens, 0);
  clock.tick(1); assert.equal(thens, 1, 'called at the re-read downbeat');
  // never re-armed into the past, never twice
  clock.tick(5000); assert.equal(thens, 1);
});

test('R2-2: with a count too short to settle, it is armed once; a cancel during the settle wait leaves nothing pending', () => {
  const clock = fakeClock();
  const c = createCountIn({ bpm: 300, timers: clock, onBeat() {} });
  c.start(() => {});
  c.cancel(true);
  assert.equal(clock.pending(), 0);
});

test('R2-3: the un-prime guard — a cancelled count never pauses the element while the engine is playing (source)', () => {
  const src = read('src/components/play/Player.tsx');
  const a = src.indexOf('const onUnprime');
  const body = src.slice(a, src.indexOf('const getEngineLatencySec'));
  assert.match(body, /getSnapshot\(\)\.status !== 'playing'\) outputRef\.current\?\.pause\(\)/, 'guarded by "engine not playing"');
  assert.equal([...body.matchAll(/outputRef\.current\?\.pause\(\)/g)].length, 1);
});
