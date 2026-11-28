// Phase C C1 (Beta): slow down to 90% / 75% with pitch kept.
//
// The REAL engine against a fake AudioContext that records the graph, plus a
// fake stretch provider. Gates evidenced here:
//   G1  six stretch nodes, created once, reused across seek / pause / rate /
//       reload, released on dispose; at 100% the graph and every scheduled
//       call is identical to an engine with no slow-down at all.
//   G2  positionSec is SONG time at rate r and is anchored where the audio is
//       HEARD (latency subtracted), so chords, sections and loops stay in sync;
//       the measured SoundTouch latencies are pinned.
// Plus: 50% is refused, the speed is remembered per song in localStorage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLAYBACK_RATES, WebAudioPlayEngine, isPlaybackRate } from '../src/lib/play/engine.ts';
import {
  SOUNDTOUCH_LATENCY_SEC,
  SOUNDTOUCH_PROCESSOR_URL,
  SPEED_KEY_PREFIX,
  readSpeed,
  soundTouchLatencySec,
  speedLabel,
  writeSpeed,
} from '../src/lib/play/stretch.ts';
import { PLAYABLE_STEMS } from '../src/lib/play/types.ts';
import { wireMediaSession } from '../src/lib/play/background-audio.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ─── fakes ───────────────────────────────────────────────────────────────────

class Param {
  constructor(ctx, label, value) {
    Object.assign(this, { ctx, label, value, events: [] });
  }
  #rec(type, a) {
    const e = { param: this.label, type, ...a };
    this.events.push(e);
    this.ctx.log.push(e);
  }
  setValueAtTime(v, t) { this.#rec('set', { v, t }); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.#rec('ramp', { v, t }); this.value = v; return this; }
  setTargetAtTime(v, t, tc) { this.#rec('target', { v, t, tc }); this.value = v; return this; }
  cancelScheduledValues(t) { this.#rec('cancel', { t }); return this; }
}

class Node {
  constructor(ctx, kind, id) {
    Object.assign(this, { ctx, kind, id, outs: [], disconnects: 0 });
  }
  connect(dest) {
    this.outs.push(dest);
    this.ctx.log.push({ type: 'connect', from: `${this.kind}#${this.id}`, to: dest.kind ? `${dest.kind}#${dest.id}` : 'out' });
    return dest;
  }
  disconnect() {
    this.disconnects++;
    this.outs = [];
    this.ctx.log.push({ type: 'disconnect', from: `${this.kind}#${this.id}` });
  }
}

class Ctx {
  constructor({ sampleRate }) {
    this.sampleRate = sampleRate;
    this.currentTime = 1;
    this.state = 'running';
    this.destination = { kind: 'destination', id: 0 };
    this.log = [];
    this.gains = [];
    this.sources = [];
    this.constants = [];
  }
  createGain() {
    const g = new Node(this, 'gain', this.gains.length);
    g.gain = new Param(this, `gain#${g.id}`, 1);
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new Node(this, 'src', this.sources.length);
    s.playbackRate = { value: 1 };
    s.started = null;
    s.stops = [];
    s.start = (when, offset) => {
      s.started = { when, offset };
      this.log.push({ type: 'start', id: s.id, when, offset, rate: s.playbackRate.value });
    };
    s.stop = (when) => s.stops.push(when);
    this.sources.push(s);
    return s;
  }
  createConstantSource() {
    const c = new Node(this, 'const', this.constants.length);
    c.offset = { value: 1 };
    c.started = false;
    c.start = () => (c.started = true);
    c.stop = () => (c.stopped = true);
    this.constants.push(c);
    return c;
  }
  createBuffer(ch, length, sampleRate) {
    const d = new Float32Array(length);
    return { numberOfChannels: ch, length, sampleRate, duration: length / sampleRate, getChannelData: () => d };
  }
  async decodeAudioData() {
    const length = 8000 * 60; // 60 s mono at 8 kHz
    const d = new Float32Array(length);
    return { numberOfChannels: 1, length, sampleRate: 8000, duration: 60, getChannelData: () => d };
  }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  live() { return this.sources.filter((s) => s.started && s.stops.length === 0); }
}

/** A fake SoundTouch: counts creations, readiness gated by the test. */
function fakeStretch({ latency = { 0.9: 0.131, 0.75: 0.121 }, failRegister = false } = {}) {
  const p = {
    created: [],
    released: [],
    registered: 0,
    async register() {
      p.registered++;
      if (failRegister) throw new Error('no worklet');
    },
    create(ctx) {
      const n = new Node(ctx, 'stretch', p.created.length);
      n.playbackRate = new Param(ctx, `stretch#${n.id}.rate`, 1);
      p.created.push(n);
      return n;
    },
    ready: () => Promise.resolve(),
    latencySec: (r) => (r === 1 ? 0 : latency[r] ?? 0),
    release(n) { p.released.push(n); },
  };
  return p;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function rig({ stretch = fakeStretch(), withStretch = true } = {}) {
  let ctx = null;
  const engine = new WebAudioPlayEngine({
    createAudioContext: (o) => (ctx = new Ctx(o)),
    scheduleFrame: () => () => {},
    ...(withStretch ? { stretch } : {}),
  });
  await engine.load(PLAYABLE_STEMS.map((name) => ({ name, bytes: new ArrayBuffer(8) })));
  return { engine, ctx, stretch };
}

async function slowTo(engine, rate) {
  engine.setPlaybackRate(rate);
  for (let i = 0; i < 10 && engine.getSnapshot().playbackRate !== rate; i++) await settle();
  assert.equal(engine.getSnapshot().playbackRate, rate, `rate ${rate} applied`);
}

// ─── speeds offered ──────────────────────────────────────────────────────────

test('only 100 / 90 / 75 are offered; 50% is refused', async () => {
  assert.deepEqual([...PLAYBACK_RATES], [1, 0.9, 0.75]);
  assert.equal(isPlaybackRate(0.5), false);
  const { engine, stretch } = await rig();
  engine.setPlaybackRate(0.5);
  await settle();
  assert.equal(engine.getSnapshot().playbackRate, 1);
  assert.equal(engine.getSnapshot().speedPending, false);
  assert.equal(stretch.created.length, 0, '50% does not even build the nodes');
  for (const bad of [0, -1, 2, NaN, 0.8, '0.75']) engine.setPlaybackRate(bad);
  assert.equal(engine.getSnapshot().playbackRate, 1);
});

test('without a stretch provider only 100% exists', async () => {
  const { engine } = await rig({ withStretch: false });
  assert.equal(engine.canChangeSpeed, false);
  engine.setPlaybackRate(0.75);
  await settle();
  assert.equal(engine.getSnapshot().playbackRate, 1);
});

// ─── G1: bypass at 100% is bit-identical ────────────────────────────────────

function script(engine, ctx) {
  engine.play();
  ctx.currentTime += 2;
  engine.seek(10);
  ctx.currentTime += 1;
  engine.setLoop({ startSec: 10, endSec: 14 });
  ctx.currentTime += 5;
  const p1 = engine.getSnapshot().positionSec;
  engine.pause();
  engine.play();
  return { p1, p2: engine.getSnapshot().positionSec };
}

test('G1: an engine never slowed builds exactly the graph and schedule of one with no slow-down', async () => {
  const a = await rig({ withStretch: false });
  const b = await rig();
  const ra = script(a.engine, a.ctx);
  const rb = script(b.engine, b.ctx);
  assert.deepEqual(rb, ra);
  assert.deepEqual(b.ctx.log, a.ctx.log, 'every connect / start / automation call identical');
  assert.equal(b.stretch.created.length, 0);
  assert.equal(b.ctx.constants.length, 0);
});

test('G1: back at 100% after slowing, sources go straight to the gains and the pipeline is unlinked once drained', async () => {
  const { engine, ctx, stretch } = await rig();
  engine.play();
  await slowTo(engine, 0.75);
  ctx.currentTime += 3;
  await slowTo(engine, 1);
  for (const s of ctx.live()) {
    assert.equal(s.outs[0].kind, 'gain', 'direct to gain at 100%');
    assert.equal(s.playbackRate.value, 1);
  }
  // The direct sources start only after the stretched tail has drained.
  const start = ctx.log.filter((e) => e.type === 'start').at(-1);
  assert.ok(start.when >= ctx.currentTime + 0.121, `direct start waits for the drain (when=${start.when})`);
  ctx.currentTime += 1;
  await new Promise((r) => setTimeout(r, 400));
  for (const st of stretch.created) assert.deepEqual(st.outs, [], 'stretch node detached from the gain');
  assert.deepEqual(ctx.constants[0].outs, [], 'silence feeder detached');
  assert.equal(stretch.released.length, 0, 'unlinked, not released: kept for next time');
  // From here a 100% run is exactly today's: a fresh play schedules at now + 50 ms, gain opens there.
  engine.pause();
  const before = ctx.log.length;
  engine.play();
  const starts = ctx.log.slice(before).filter((e) => e.type === 'start');
  assert.equal(new Set(starts.map((s) => s.when)).size, 1);
  assert.ok(Math.abs(starts[0].when - (ctx.currentTime + 0.05)) < 1e-9);
});

// ─── G1: lifecycle ──────────────────────────────────────────────────────────

test('G1: six nodes created once, lazily; reused across seek, pause, loop, rate change and reload; released on dispose', async () => {
  const { engine, ctx, stretch } = await rig();
  assert.equal(stretch.created.length, 0, 'none before the first slow rate');
  engine.play();
  await slowTo(engine, 0.9);
  assert.equal(stretch.created.length, 6);
  assert.equal(stretch.registered, 1);
  const ids = new Set(stretch.created);
  for (let i = 0; i < 5; i++) {
    ctx.currentTime += 1;
    engine.seek(5 + i * 3);
  }
  engine.pause();
  engine.play();
  engine.setLoop({ startSec: 20, endSec: 30 });
  engine.setLoop(null);
  await slowTo(engine, 0.75);
  await slowTo(engine, 1);
  await slowTo(engine, 0.9);
  await engine.load(PLAYABLE_STEMS.map((name) => ({ name, bytes: new ArrayBuffer(8) })));
  engine.play();
  ctx.currentTime += 1;
  engine.seek(3);
  assert.equal(stretch.created.length, 6, 'no node churn');
  assert.equal(stretch.registered, 1);
  // Every live source feeds one of the SAME six nodes, one per stem.
  const targets = ctx.live().map((s) => s.outs[0]);
  assert.equal(targets.length, 6);
  assert.ok(targets.every((t) => ids.has(t)));
  assert.equal(new Set(targets).size, 6);
  // ...and each node feeds the reloaded song's gain.
  const gainsNow = new Set(ctx.gains.slice(-6));
  for (const st of stretch.created) assert.ok(st.outs.length === 1 && gainsNow.has(st.outs[0]));
  engine.dispose();
  assert.equal(stretch.released.length, 6, 'released on teardown');
  assert.ok(ctx.constants[0].stopped, 'feeder stopped');
});

test('G1: a failing worklet leaves normal speed working and stops offering slow-down', async () => {
  const { engine, ctx } = await rig({ stretch: fakeStretch({ failRegister: true }) });
  engine.play();
  engine.setPlaybackRate(0.75);
  await settle();
  await settle();
  assert.equal(engine.getSnapshot().playbackRate, 1);
  assert.equal(engine.getSnapshot().speedPending, false);
  assert.equal(engine.canChangeSpeed, false);
  assert.ok(ctx.live().every((s) => s.outs[0].kind === 'gain'));
});

test('a speed asked for while paused applies on play; one remembered before load applies after it', async () => {
  const { engine, ctx } = await rig();
  await slowTo(engine, 0.75);
  engine.play();
  assert.ok(ctx.live().every((s) => s.playbackRate.value === 0.75 && s.outs[0].kind === 'stretch'));
  // Before load: no context yet.
  let c2 = null;
  const st = fakeStretch();
  const e2 = new WebAudioPlayEngine({ createAudioContext: (o) => (c2 = new Ctx(o)), scheduleFrame: () => () => {}, stretch: st });
  e2.setPlaybackRate(0.9);
  assert.equal(e2.getSnapshot().speedPending, true);
  await e2.load(PLAYABLE_STEMS.map((name) => ({ name, bytes: new ArrayBuffer(8) })));
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(e2.getSnapshot().playbackRate, 0.9);
  assert.equal(st.created.length, 6);
  assert.ok(c2);
});

// ─── G2: song time and latency compensation ─────────────────────────────────

for (const rate of [0.9, 0.75]) {
  test(`G2 @${rate}: positionSec is song time, anchored where the audio is heard (latency subtracted)`, async () => {
    const L = SOUNDTOUCH_LATENCY_SEC[rate];
    const { engine, ctx } = await rig();
    engine.play();
    ctx.currentTime += 2;
    await slowTo(engine, rate);
    const at = engine.getSnapshot().positionSec;
    const t = ctx.currentTime;
    const starts = ctx.log.filter((e) => e.type === 'start').slice(-6);
    // Sample-lock: one (when, offset) for all six, at rate r.
    assert.equal(new Set(starts.map((s) => `${s.when}|${s.offset}|${s.rate}`)).size, 1);
    const { when, offset } = starts[0];
    assert.equal(offset, at, 'restarts where the playhead was');
    assert.ok(Math.abs(when - (t + 0.05)) < 1e-9);
    // Each gain opens when the first stretched sample comes out, not at `when`.
    // (Before it, each gain is held and faded to 0 at `t`, muting the old run's tail.)
    const opens = ctx.log.filter((e) => e.type === 'set' && e.v === 0 && /^gain#/.test(e.param) && e.t > t).slice(-6);
    assert.equal(opens.length, 6);
    for (const o of opens) assert.ok(Math.abs(o.t - (when + L)) < 1e-9, `gain opens at when + ${L}`);
    const fades = ctx.log.filter((e) => e.type === 'target' && e.v === 0 && e.t === t && /^gain#/.test(e.param));
    assert.ok(fades.length >= 6, 'old tail faded out, not left open while it drains');
    for (let g = 0; g < 6; g++) {
      const evs = ctx.log.filter((e) => e.param === `gain#${g}` && e.t >= t - 1e-9);
      const lastCancel = evs.findLastIndex((e) => e.type === 'cancel');
      const lastFade = evs.findLastIndex((e) => e.type === 'target' && e.v === 0);
      assert.ok(lastFade > lastCancel, `gain#${g}: the fade-out is not cancelled before the new run is heard`);
    }
    // During the start lead AND the pipeline latency the playhead holds still.
    ctx.currentTime = when + L / 2;
    assert.equal(engine.getSnapshot().positionSec, offset);
    // Afterwards it advances `rate` song-seconds per second, from when + L.
    ctx.currentTime = when + L + 10;
    assert.ok(Math.abs(engine.getSnapshot().positionSec - (offset + 10 * rate)) < 1e-9);
    // Seek: the song second you asked for is what is heard, latency later.
    engine.seek(30);
    const w2 = ctx.log.filter((e) => e.type === 'start').at(-1).when;
    ctx.currentTime = w2 + L + 4;
    assert.ok(Math.abs(engine.getSnapshot().positionSec - (30 + 4 * rate)) < 1e-9);
  });
}

test('G2: loops wrap in song time at reduced speed (section loop, ⟲ and jump read the same clock)', async () => {
  const L = SOUNDTOUCH_LATENCY_SEC[0.75];
  const { engine, ctx } = await rig();
  engine.play();
  await slowTo(engine, 0.75);
  engine.setLoop({ startSec: 20, endSec: 24 }); // outside -> jumps to its head
  const w = ctx.log.filter((e) => e.type === 'start').at(-1).when;
  assert.ok(ctx.live().every((s) => s.loop && s.loopStart === 20 && s.loopEnd === 24));
  // 4 song-seconds take 4 / 0.75 s; 1.5 loops later (8 / 0.75 s... ) we are at 22.
  ctx.currentTime = w + L + 6 / 0.75;
  assert.ok(Math.abs(engine.getSnapshot().positionSec - 22) < 1e-9);
  // Pausing keeps the HEARD position; play resumes from it.
  engine.pause();
  assert.ok(Math.abs(engine.getSnapshot().positionSec - 22) < 1e-9);
});

test('G2: switching speed keeps the song position (no jump forward by the latency)', async () => {
  const { engine, ctx } = await rig();
  engine.play();
  ctx.currentTime += 5;
  await slowTo(engine, 0.9);
  ctx.currentTime += 3;
  const p = engine.getSnapshot().positionSec;
  engine.setPlaybackRate(0.75);
  assert.ok(Math.abs(engine.getSnapshot().positionSec - p) < 1e-9);
  engine.setPlaybackRate(1);
  assert.ok(Math.abs(engine.getSnapshot().positionSec - p) < 1e-9);
});

test('G2: the measured SoundTouch latencies are pinned (re-measure before changing)', () => {
  assert.equal(soundTouchLatencySec(1), 0);
  assert.equal(soundTouchLatencySec(0.9), 0.131);
  assert.equal(soundTouchLatencySec(0.75), 0.121);
  assert.equal(soundTouchLatencySec(0.5), 0, 'no figure for an unoffered speed');
});

// ─── licence: the processor ships unmodified ────────────────────────────────

test('the SoundTouch processor is served byte-identical to the MPL-2.0 package, with its licence', () => {
  const pub = path.join(HERE, '..', 'public', SOUNDTOUCH_PROCESSOR_URL);
  const pkg = path.join(HERE, '..', 'node_modules', '@soundtouchjs', 'audio-worklet', '.dist', 'soundtouch-processor.js');
  assert.ok(fs.readFileSync(pub).equals(fs.readFileSync(pkg)), 'unmodified');
  const lic = fs.readFileSync(path.join(path.dirname(pub), 'LICENSE'), 'utf8');
  assert.match(lic, /Mozilla Public License/);
  const pj = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'node_modules', '@soundtouchjs', 'audio-worklet', 'package.json'), 'utf8'));
  assert.equal(pj.version, '2.1.1');
  assert.equal(pj.license, 'MPL-2.0');
});

// ─── remembered per song ────────────────────────────────────────────────────

function withStorage(store, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true });
  try {
    return fn();
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  }
}
function mapStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('speed is remembered per job; 100% clears it; bad data and 50% read as 100%', () => {
  const s = mapStorage();
  withStorage(s, () => {
    writeSpeed('job-a', 0.75);
    writeSpeed('job-b', 0.9);
    assert.equal(readSpeed('job-a'), 0.75);
    assert.equal(readSpeed('job-b'), 0.9);
    assert.equal(readSpeed('job-c'), 1);
    assert.equal(s.m.get(SPEED_KEY_PREFIX + 'job-a'), '0.75');
    writeSpeed('job-a', 1);
    assert.equal(s.m.has(SPEED_KEY_PREFIX + 'job-a'), false);
    writeSpeed('job-a', 0.5);
    assert.equal(readSpeed('job-a'), 1);
    s.m.set(SPEED_KEY_PREFIX + 'job-x', '0.5');
    assert.equal(readSpeed('job-x'), 1);
    s.m.set(SPEED_KEY_PREFIX + 'job-y', 'garbage');
    assert.equal(readSpeed('job-y'), 1);
    assert.equal(readSpeed(null), 1);
  });
});

test('storage that throws (private mode) never breaks the player', () => {
  const boom = () => {
    throw new Error('SecurityError');
  };
  withStorage({ getItem: boom, setItem: boom, removeItem: boom }, () => {
    assert.equal(readSpeed('job'), 1);
    assert.doesNotThrow(() => writeSpeed('job', 0.75));
    assert.doesNotThrow(() => writeSpeed('job', 1));
  });
});

test('speedLabel: a pill only below 100%', () => {
  assert.equal(speedLabel(1), null);
  assert.equal(speedLabel(undefined), null);
  assert.equal(speedLabel(0.9), '90%');
  assert.equal(speedLabel(0.75), '75%');
  assert.equal(speedLabel(0.5), null);
});

// ─── round 2 (review R1 of #383) ────────────────────────────────────────────

test('R2-3: a stretched run says "ended" only after its last latency has been heard; 100% stays synchronous', async () => {
  const { engine, ctx } = await rig();
  engine.play();
  await slowTo(engine, 0.75);
  for (const s of ctx.live()) s.onended?.();
  assert.equal(engine.getSnapshot().status, 'playing', 'the tail is still coming out of the pipeline');
  await new Promise((r) => setTimeout(r, 200)); // > 121 ms
  assert.equal(engine.getSnapshot().status, 'ended');
  assert.equal(engine.getSnapshot().positionSec, 60);
  // A pause inside that window wins; the late 'ended' is dropped.
  engine.seek(10);
  engine.play();
  for (const s of ctx.live()) s.onended?.();
  engine.pause();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(engine.getSnapshot().status, 'ready');
  // At 100% (direct path) it is immediate, as before.
  const b = await rig();
  b.engine.play();
  for (const s of b.ctx.live()) s.onended?.();
  assert.equal(b.engine.getSnapshot().status, 'ended');
});

function fakeMs() {
  return { playbackState: 'none', positions: [], setActionHandler() {}, setPositionState(st) { this.positions.push(st); } };
}

test('R2-2: the lock screen gets the real speed, and the drift check uses it', () => {
  const ms = fakeMs();
  let clock = 0;
  const w = wireMediaSession(
    { navigator: { mediaSession: ms }, MediaMetadata: class { constructor(i) { Object.assign(this, i); } } },
    { title: 't', onPlay() {}, onPause() {}, onSeek() {}, getPosition: () => 0, getDuration: () => 100, now: () => clock },
  );
  w.update({ status: 'playing', positionSec: 10, durationSec: 100, playbackRate: 0.75 });
  assert.equal(ms.positions.at(-1).playbackRate, 0.75);
  // 4 s later at 75% the song moved 3 s: on schedule, nothing re-pushed.
  clock = 4000;
  w.update({ status: 'playing', positionSec: 13, durationSec: 100, playbackRate: 0.75 });
  assert.equal(ms.positions.length, 1);
  // A speed change is pushed at once.
  w.update({ status: 'playing', positionSec: 13, durationSec: 100, playbackRate: 1 });
  assert.equal(ms.positions.at(-1).playbackRate, 1);
  // No rate in the snapshot reads as 1 (engines without slow-down).
  const ms2 = fakeMs();
  const w2 = wireMediaSession({ navigator: { mediaSession: ms2 } }, { title: 't', onPlay() {}, onPause() {}, onSeek() {}, getPosition: () => 0, getDuration: () => 1, now: () => 0 });
  w2.update({ status: 'playing', positionSec: 1, durationSec: 100 });
  assert.equal(ms2.positions.at(-1).playbackRate, 1);
});

// ─── #448: a pending first slow-down (flag sl.play.countPendingRate.v1, default OFF) ──

function gatedStretch() {
  const st = fakeStretch();
  let open;
  const gate = new Promise((r) => (open = r));
  st.ready = () => gate;
  return { st, open: () => open() };
}
function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('#448: while the first slow-down is pending the snapshot carries pendingRate (absent otherwise)', async () => {
  const { st, open } = gatedStretch();
  const { engine } = await rig({ stretch: st });
  assert.equal('pendingRate' in engine.getSnapshot(), false, 'nothing pending');
  engine.setPlaybackRate(0.75);
  await settle();
  let s = engine.getSnapshot();
  assert.equal(s.playbackRate, 1);
  assert.equal(s.speedPending, true);
  assert.equal(s.pendingRate, 0.75);
  engine.setPlaybackRate(0.9);
  await settle();
  assert.equal(engine.getSnapshot().pendingRate, 0.9, 'a second pending choice is seen (new snapshot)');
  open();
  for (let i = 0; i < 10 && engine.getSnapshot().speedPending; i++) await settle();
  s = engine.getSnapshot();
  assert.equal(s.playbackRate, 0.9);
  assert.equal(s.speedPending, false);
  assert.equal('pendingRate' in s, false, 'applied: gone');
});

test('#448 flag OFF (default): stretchLatencySec() is 0 while the first slow-down is pending (old behaviour)', async () => {
  const { st, open } = gatedStretch();
  const { engine } = await rig({ stretch: st });
  engine.setPlaybackRate(0.75);
  await settle();
  assert.equal(withStorage(memStore(), () => engine.stretchLatencySec()), 0, 'no flag');
  assert.equal(withStorage(memStore({ 'sl.play.countPendingRate.v1': '0' }), () => engine.stretchLatencySec()), 0, '"0"');
  open();
  for (let i = 0; i < 10 && engine.getSnapshot().speedPending; i++) await settle();
  assert.equal(withStorage(memStore(), () => engine.stretchLatencySec()), 0.121, 'applied');
});

test('#448 flag ON: stretchLatencySec() is the PENDING rate\'s latency while it waits; unchanged otherwise', async () => {
  const on = memStore({ 'sl.play.countPendingRate.v1': '1' });
  const { st, open } = gatedStretch();
  const { engine } = await rig({ stretch: st });
  assert.equal(withStorage(on, () => engine.stretchLatencySec()), 0, '100%, nothing pending');
  engine.setPlaybackRate(0.75);
  await settle();
  assert.equal(withStorage(on, () => engine.stretchLatencySec()), 0.121, 'pending 75%');
  engine.setPlaybackRate(0.9);
  assert.equal(withStorage(on, () => engine.stretchLatencySec()), 0.131, 'pending 90%');
  open();
  for (let i = 0; i < 10 && engine.getSnapshot().speedPending; i++) await settle();
  assert.equal(withStorage(on, () => engine.stretchLatencySec()), 0.131, 'applied 90%');
  engine.setPlaybackRate(1);
  assert.equal(withStorage(on, () => engine.stretchLatencySec()), 0, 'back to 100%');
  engine.dispose();
  assert.equal(withStorage(on, () => engine.stretchLatencySec()), 0, 'disposed');
  const plain = await rig({ withStretch: false });
  plain.engine.setPlaybackRate(0.75);
  assert.equal(withStorage(on, () => plain.engine.stretchLatencySec()), 0, 'no stretch provider');
});

test('#387: stretchLatencySec() is the stretch latency a start at the playing rate adds (0 at 100%, without stretch, after dispose)', async () => {
  const { engine } = await rig();
  assert.equal(engine.stretchLatencySec(), 0, '100%: bypassed');
  await slowTo(engine, 0.9);
  assert.equal(engine.stretchLatencySec(), 0.131);
  await slowTo(engine, 0.75);
  assert.equal(engine.stretchLatencySec(), 0.121);
  engine.setPlaybackRate(1);
  assert.equal(engine.stretchLatencySec(), 0);
  await slowTo(engine, 0.75);
  engine.dispose();
  assert.equal(engine.stretchLatencySec(), 0, 'disposed');
  const plain = await rig({ withStretch: false });
  assert.equal(plain.engine.stretchLatencySec(), 0, 'no stretch provider');
});

// ─── #423 (a): the stretch pipeline's drain vs the count-in's latency ───────
//
// The count-in (#387) predicts that music started by play() is heard
// ENGINE_LEAD_SEC + stretchLatencySec() later (plus the route latency). But
// startVoices may push `when` later while the previous stretched run is still
// draining: when = max(now + START_LEAD, drainEnd - latency). stretchLatencySec()
// knows nothing of the drain. And every count is preceded by a drain: the tap
// "primes" the engine with play(); pause() (Player.tsx onPrime), which at 90% /
// 75% opens a drain window of STOP_LAG + latency + margin. These tests pin
// when that window can and cannot move the first heard note.

import {
  ENGINE_LEAD_SEC,
  MAX_COUNT_IN_BPM,
  MAX_LATENCY_SEC,
  countInSec,
  engineCountLatencySec,
  timingOffsets,
} from '../src/lib/play/count-in.ts';

const EPS = 1e-9;

/** What play() at ctx.currentTime scheduled: the shared `when` and where each gain opens (heard). */
function lastRun(ctx, sinceLog) {
  const ev = ctx.log.slice(sinceLog);
  const starts = ev.filter((e) => e.type === 'start');
  assert.equal(starts.length, 6, 'six voices started');
  assert.equal(new Set(starts.map((s) => s.when)).size, 1, 'one `when` for all six');
  // The gain re-opens (set 0, then ramp) at heard-at; a set at `now` is the hold of the fade-out.
  const now = ctx.currentTime;
  const opens = ev.filter((e) => e.type === 'set' && e.v === 0 && /^gain#/.test(e.param) && e.t > now);
  assert.equal(opens.length, 6, 'six gains opened');
  assert.equal(new Set(opens.map((o) => o.t)).size, 1, 'one heard-at for all six');
  return { when: starts[0].when, heardAt: opens[0].t };
}

/** The count-in tap: engine.play(); engine.pause() at the same instant (Player.tsx onPrime). */
function prime(engine, ctx) {
  const before = ctx.sources.length;
  engine.play();
  engine.pause();
  for (const s of ctx.sources.slice(before)) {
    assert.ok(s.stops.length === 1 && s.stops[0] < s.started.when, 'primed voices stop before their start: nothing heard');
  }
}

for (const rate of [0.9, 0.75]) {
  test(`#423 (a) @${rate}: a play() right after the prime is NOT delayed by its drain: heard ENGINE_LEAD_SEC + stretchLatencySec() later`, async () => {
    const { engine, ctx } = await rig();
    await slowTo(engine, rate);
    const L = engine.stretchLatencySec();
    assert.equal(L, SOUNDTOUCH_LATENCY_SEC[rate]);
    assert.ok(L > 0);
    prime(engine, ctx);
    // Same instant, the pipeline still holds the primed (silent) run: the
    // worst case. Its drain (STOP_LAG + L + margin) ends before
    // now + START_LEAD + L, so the start lead already covers it.
    const t = ctx.currentTime;
    const mark = ctx.log.length;
    engine.play();
    const { when, heardAt } = lastRun(ctx, mark);
    assert.ok(Math.abs(when - (t + ENGINE_LEAD_SEC)) < EPS, `when = play + ENGINE_LEAD_SEC (got ${when - t})`);
    assert.ok(Math.abs(heardAt - t - (ENGINE_LEAD_SEC + L)) < EPS, `heard = play + ENGINE_LEAD_SEC + stretchLatencySec() (got ${heardAt - t})`);
    // The playhead is anchored at what is heard, so chords stay in sync.
    ctx.currentTime = heardAt + 1;
    assert.ok(Math.abs(engine.getSnapshot().positionSec - rate) < EPS);
  });

  test(`#423 (a) @${rate}: the drain is real: a rate change while it lasts can move the first note past what stretchLatencySec() predicts, never past the drain end`, async () => {
    const other = rate === 0.9 ? 0.75 : 0.9;
    for (const next of [other, 1]) {
      const { engine, ctx } = await rig();
      await slowTo(engine, rate);
      const L0 = engine.stretchLatencySec();
      engine.play();
      ctx.currentTime += 2;
      const p = ctx.currentTime;
      engine.pause(); // the stretched run drains until p + STOP_LAG + L0 + margin
      const drainEnd = p + 0.015 + L0 + 0.03;
      await slowTo(engine, next);
      const L1 = engine.stretchLatencySec();
      const predicted = p + ENGINE_LEAD_SEC + L1; // what the count-in assumes
      const mark = ctx.log.length;
      engine.play(); // same instant, still draining
      const { when, heardAt } = lastRun(ctx, mark);
      assert.ok(Math.abs(heardAt - Math.max(predicted, drainEnd)) < EPS, `${rate} -> ${next}: heard at max(predicted, drain end) (got ${heardAt - p})`);
      assert.ok(Math.abs(heardAt - when - L1) < EPS, `${rate} -> ${next}: heard = when + the NEW rate's latency`);
      // Late only when the old latency exceeds the new by more than the start lead's slack (5 ms).
      const late = L0 - L1 > ENGINE_LEAD_SEC - 0.045 + EPS;
      assert.equal(heardAt > predicted + EPS, late, `${rate} -> ${next}: late=${late}`);
      // Once the drain is over, the same rate change is heard exactly as predicted.
      engine.pause();
      ctx.currentTime += 1;
      const t = ctx.currentTime;
      const m2 = ctx.log.length;
      engine.play();
      const r2 = lastRun(ctx, m2);
      assert.ok(Math.abs(r2.heardAt - (t + ENGINE_LEAD_SEC + L1)) < EPS, `${rate} -> ${next}: drained, heard as predicted`);
    }
  });

  test(`#423 (a) @${rate}: the shortest believable count outlasts the prime's drain, so its downbeat play() is heard exactly when the count predicts`, async () => {
    const { engine, ctx } = await rig();
    await slowTo(engine, rate);
    const L = engine.stretchLatencySec();
    // Worst case for the count: fastest BPM and the largest engine latency it
    // believes from the device (MAX_LATENCY_SEC) plus the stretch pipeline's.
    const e = engineCountLatencySec({ outputLatency: MAX_LATENCY_SEC }, false, 0, L);
    const { downbeat } = timingOffsets({ clickLatencySec: 0, engineLatencySec: e });
    const gap = countInSec(MAX_COUNT_IN_BPM, rate) + downbeat; // prime -> downbeat play()
    const drainWindow = 0.015 + L + 0.03; // STOP_LAG + latency + margin
    assert.ok(gap > drainWindow, `count (${gap.toFixed(3)} s) outlasts the drain (${drainWindow.toFixed(3)} s)`);
    prime(engine, ctx);
    ctx.currentTime += gap;
    const t = ctx.currentTime;
    const mark = ctx.log.length;
    engine.play();
    const { heardAt } = lastRun(ctx, mark);
    assert.ok(Math.abs(heardAt - t - (ENGINE_LEAD_SEC + engine.stretchLatencySec())) < EPS, 'heard where the count put the downbeat');
  });
}
