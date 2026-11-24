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
