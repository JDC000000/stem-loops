// PlayEngine — the play-along engine core (apps/web/src/lib/play/engine.ts).
//
// Node has no Web Audio, so these tests run the REAL engine against a fake
// AudioContext that RECORDS everything the engine does to the audio graph:
// which nodes were created, the exact (when, offset) every source was started
// with, every AudioParam automation call, and the order of decode vs downmix.
// That makes the four contract invariants assertable STRUCTURALLY rather than
// by listening:
//
//   1. sample-lock      -> one identical (when, offset) across all six sources
//   2. no restart/click -> node counts unchanged + automation-only gain moves
//   3. monotonic clock  -> position read repeatedly as the fake clock advances
//   4. safe in any state -> every method called in `idle`, and after dispose
//
// Precedent for the injected-AudioContext style: src/chord/tab-capture.ts and
// src/chord/__tests__/tab-capture.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENGINE_ERROR,
  WebAudioPlayEngine,
  createPlayEngine,
} from '../src/lib/play/engine.ts';
import {
  MAX_TRACK_SEC,
  PLAYABLE_STEMS,
  PLAYBACK_CHANNELS,
  PLAYBACK_SAMPLE_RATE,
} from '../src/lib/play/types.ts';

// ─── the fake, encoded-bytes side ────────────────────────────────────────────
// Each "encoded stem" is a 24-byte header the fake decoder reads back, so a
// test states the shape of the audio it wants in the same place it hands the
// bytes to `load()`.

const MAGIC = 0x53544d31; // 'STM1'

// `rate` is the fake decoder's sample rate. It defaults LOW so the fake PCM
// stays small — `duration = length / sampleRate` is still honest arithmetic,
// and the tests that care about the real rate pass PLAYBACK_SAMPLE_RATE.
function makeStemBytes(name, { durationSec = 2, channels = 2, fail = false, rate = 8_000 } = {}) {
  const buf = new ArrayBuffer(24);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC);
  dv.setFloat64(4, durationSec);
  dv.setFloat64(12, rate);
  dv.setUint8(20, channels);
  dv.setUint8(21, fail ? 1 : 0);
  dv.setUint8(22, PLAYABLE_STEMS.indexOf(name));
  return buf;
}

function readStemBytes(bytes) {
  if (!bytes || bytes.byteLength < 24) return null;
  const dv = new DataView(bytes);
  if (dv.getUint32(0) !== MAGIC) return null;
  return {
    durationSec: dv.getFloat64(4),
    rate: dv.getFloat64(12),
    channels: dv.getUint8(20),
    fail: dv.getUint8(21) === 1,
    name: PLAYABLE_STEMS[dv.getUint8(22)],
  };
}

function fakeBuffer({ tag, channels, length, sampleRate, fill = null, sharedStore = false }) {
  const data = [];
  // `sharedStore` makes every channel a VIEW onto one ArrayBuffer. Detaching
  // such a view would take bytes belonging to the sibling channels, so
  // `releaseChannelData` must refuse it. Web Audio does not lay buffers out
  // this way today, but the guard is only meaningful if something exercises it.
  const store = sharedStore ? new ArrayBuffer(length * 4 * channels) : null;
  for (let c = 0; c < channels; c++) {
    const a = store ? new Float32Array(store, c * length * 4, length) : new Float32Array(length);
    if (fill) for (let i = 0; i < length; i++) a[i] = fill(c, i);
    data.push(a);
  }
  return {
    tag,
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (c) => data[c],
  };
}

// ─── the fake graph ──────────────────────────────────────────────────────────

class FakeAudioParam {
  constructor(ctx, label, value, withHold) {
    this.ctx = ctx;
    this.label = label;
    this.value = value;
    this.events = [];
    if (withHold) {
      this.cancelAndHoldAtTime = (t) => {
        this.#rec('cancelAndHoldAtTime', { t });
        return this;
      };
    }
  }
  #rec(type, args) {
    const e = { param: this.label, type, ...args };
    this.events.push(e);
    this.ctx.automation.push(e);
    return e;
  }
  setValueAtTime(v, t) {
    this.#rec('setValueAtTime', { v, t });
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this.#rec('linearRampToValueAtTime', { v, t });
    this.value = v;
    return this;
  }
  setTargetAtTime(v, t, tc) {
    this.#rec('setTargetAtTime', { v, t, tc });
    this.value = v;
    return this;
  }
  cancelScheduledValues(t) {
    this.#rec('cancelScheduledValues', { t });
    return this;
  }
}

class FakeGainNode {
  constructor(ctx, id) {
    this.ctx = ctx;
    this.id = id;
    this.gain = new FakeAudioParam(ctx, `gain#${id}`, 1, ctx.withCancelAndHold);
    this.outputs = [];
    this.disconnects = 0;
  }
  connect(dest) {
    this.outputs.push(dest);
    return dest;
  }
  disconnect() {
    this.disconnects++;
  }
}

class FakeSourceNode {
  constructor(ctx, id) {
    this.ctx = ctx;
    this.id = id;
    this.buffer = null;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.onended = null;
    this.started = null;
    this.stops = [];
    this.output = null;
    this.disconnects = 0;
  }
  connect(dest) {
    this.output = dest;
    return dest;
  }
  disconnect() {
    this.disconnects++;
  }
  set onended(fn) {
    this.onendedRaw = fn;
    // A browser can have QUEUED the ended event before the engine nulls the
    // handler, so remember the last real one for `fireEndedQueued()`.
    if (typeof fn === 'function') this.queuedHandler = fn;
  }
  get onended() {
    return this.onendedRaw ?? null;
  }
  start(when, offset) {
    if (this.started) throw new Error('InvalidStateError: already started');
    this.started = { when, offset };
    this.ctx.starts.push({ id: this.id, stem: this.buffer?.tag, when, offset });
  }
  stop(when) {
    if (!this.started) throw new Error('InvalidStateError: not started');
    this.stops.push(when);
  }
  /** Test-only: fire what the browser fires when the buffer runs out. */
  fireEnded() {
    if (typeof this.onended === 'function') this.onended(new Event('ended'));
  }
  /**
   * Test-only: fire an ended event the browser had ALREADY queued before the
   * engine detached its handler. Clearing `onended` is not a guarantee the
   * event never arrives, so the engine must also recognise the run as stale.
   */
  fireEndedQueued() {
    if (typeof this.queuedHandler === 'function') this.queuedHandler(new Event('ended'));
  }
}

class FakeAudioContext {
  constructor({ sampleRate }, opts = {}) {
    this.sampleRate = sampleRate;
    this.currentTime = 1; // non-zero, so a bug that assumes t0 === 0 shows up
    this.state = opts.state ?? 'running';
    this.destination = { kind: 'destination' };
    this.withCancelAndHold = !!opts.cancelAndHold;
    this.gains = [];
    this.sources = [];
    this.starts = [];
    this.automation = [];
    this.events = []; // ordered log: decode:<stem> / downmix:<stem>
    this.decodeCalls = [];
    /** Every buffer `decodeAudioData` handed back, so a test can inspect what
     *  the downmix did to it after the engine dropped its reference. */
    this.decodedBuffers = [];
    /** One entry per `createBuffer`, snapshotting the decode it is downmixing. */
    this.allocs = [];
    this.inFlightDecodes = 0;
    this.maxInFlightDecodes = 0;
    this.resumes = 0;
    this.closes = 0;
    this.lastDecodedTag = null;
    this.sharedStore = !!opts.sharedStore;
  }
  get nodesCreated() {
    return this.gains.length + this.sources.length;
  }
  createGain() {
    const g = new FakeGainNode(this, this.gains.length);
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new FakeSourceNode(this, this.sources.length);
    this.sources.push(s);
    return s;
  }
  createBuffer(channels, length, sampleRate) {
    // ── the ORDER probe ──────────────────────────────────────────────────
    // Checking detachment AFTER `load()` returns cannot tell "released before
    // the allocation" from "released after it", and the whole point of the
    // fix is WHICH SIDE OF THIS CALL the releases happen on. So the state is
    // snapshotted HERE, at the one instant that distinguishes them.
    const d = this.decodedBuffers[this.decodedBuffers.length - 1];
    const resident = d
      ? Array.from({ length: d.numberOfChannels }, (_, c) => d.getChannelData(c).length > 0)
      : null;
    this.allocs.push({
      tag: this.lastDecodedTag,
      resident,
      // Whole-track buffers alive at this instant: one per stem already
      // decoded, plus each channel of the decode in flight that is still
      // resident, plus the one being allocated right now. This is the number
      // the PLAYBACK_SAMPLE_RATE comment calls the peak.
      liveWholeTrackUnits: d
        ? this.decodedBuffers.length - 1 + resident.filter(Boolean).length + 1
        : null,
    });
    this.events.push(`downmix:${this.lastDecodedTag}`);
    return fakeBuffer({ tag: this.lastDecodedTag, channels, length, sampleRate });
  }
  async decodeAudioData(bytes) {
    this.decodeCalls.push(bytes ? bytes.byteLength : -1);
    this.inFlightDecodes++;
    this.maxInFlightDecodes = Math.max(this.maxInFlightDecodes, this.inFlightDecodes);
    await Promise.resolve(); // yield, so parallel decodes would overlap here
    const h = readStemBytes(bytes);
    try {
      if (!h || h.fail) throw new Error('EncodingError: could not decode');
      this.events.push(`decode:${h.name}`);
      this.lastDecodedTag = h.name;
      // The real `decodeAudioData` DETACHES the ArrayBuffer it is handed. The
      // fake does too, so a caller that forgets to copy is caught here.
      try {
        structuredClone(bytes, { transfer: [bytes] });
      } catch {
        /* already detached */
      }
      const decoded = fakeBuffer({
        tag: h.name,
        channels: h.channels,
        length: Math.round(h.durationSec * h.rate),
        sampleRate: h.rate,
        // channel 0 = 0.5, channel 1 = 1.0 -> a correct mono downmix is 0.75
        fill: (c) => (c + 1) * 0.5,
        sharedStore: this.sharedStore,
      });
      this.decodedBuffers.push(decoded);
      return decoded;
    } finally {
      this.inFlightDecodes--;
    }
  }
  resume() {
    this.resumes++;
    this.state = 'running';
    return Promise.resolve();
  }
  close() {
    this.closes++;
    this.state = 'closed';
    return Promise.resolve();
  }
  /** Test-only clock. */
  advance(sec) {
    this.currentTime += sec;
  }
  sourcesFor(stem) {
    return this.sources.filter((s) => s.buffer?.tag === stem);
  }
  live() {
    return this.sources.filter((s) => s.started && s.stops.length === 0);
  }
}

// ─── harness ─────────────────────────────────────────────────────────────────

function harness(opts = {}) {
  const made = [];
  const frames = [];
  const engine = new WebAudioPlayEngine({
    createAudioContext: (o) => {
      const ctx = new FakeAudioContext(o, opts);
      made.push(ctx);
      return ctx;
    },
    // Frames are collected, never auto-run: no timer leaks, and a test that
    // cares about the clock loop drives it by hand.
    scheduleFrame: (cb) => {
      const entry = { cb, cancelled: false };
      frames.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  return {
    engine,
    frames,
    ctx: () => made[made.length - 1],
    contexts: made,
    runFrames(n = 1) {
      for (let i = 0; i < n; i++) {
        const next = frames.find((f) => !f.cancelled && !f.ran);
        if (!next) return i;
        next.ran = true;
        next.cb();
      }
      return n;
    },
  };
}

const SIX = (over = {}) => PLAYABLE_STEMS.map((name) => ({ name, bytes: makeStemBytes(name, over) }));

async function loadedSix(opts = {}, over = {}) {
  const h = harness(opts);
  await h.engine.load(SIX(over));
  return h;
}

// ─── 1. sample-lock ──────────────────────────────────────────────────────────

test('six stems are started with ONE identical (when, offset) — sample-lock', async () => {
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  assert.equal(engine.getSnapshot().status, 'ready');
  assert.equal(c.sampleRate, PLAYBACK_SAMPLE_RATE, 'context must be created at the playback rate');

  const t0 = c.currentTime;
  engine.play();

  assert.equal(c.starts.length, 6, 'one source per stem');
  const whens = new Set(c.starts.map((s) => s.when));
  const offsets = new Set(c.starts.map((s) => s.offset));
  assert.equal(whens.size, 1, `all six must share one start time, got ${[...whens]}`);
  assert.equal(offsets.size, 1, `all six must share one offset, got ${[...offsets]}`);
  assert.equal([...offsets][0], 0);
  assert.ok(
    [...whens][0] > t0,
    'start must be scheduled in the FUTURE, or node-creation cost smears the six starts',
  );
  assert.deepEqual(
    c.starts.map((s) => s.stem).sort(),
    [...PLAYABLE_STEMS].sort(),
    'every stem must be started exactly once',
  );
  engine.dispose();
});

test('pause then play re-locks all six on one new (when, offset)', async () => {
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  engine.play();
  c.advance(0.05 + 1.0); // past the lead, one second of audio
  engine.pause();
  assert.equal(engine.getSnapshot().status, 'ready');
  const paused = engine.getSnapshot().positionSec;
  assert.ok(Math.abs(paused - 1.0) < 1e-6, `expected ~1.0 s, got ${paused}`);

  c.starts.length = 0;
  c.advance(0.5);
  engine.play();
  assert.equal(c.starts.length, 6);
  assert.equal(new Set(c.starts.map((s) => s.when)).size, 1);
  assert.equal(new Set(c.starts.map((s) => s.offset)).size, 1);
  assert.ok(Math.abs(c.starts[0].offset - paused) < 1e-6, 'resume must start from the paused position');
  engine.dispose();
});

test('seek while playing re-locks all six, and every stem is stopped exactly once', async () => {
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  engine.play();
  const first = c.live();
  c.advance(0.2);
  engine.seek(0.75);

  for (const s of first) assert.equal(s.stops.length, 1, `stem ${s.buffer.tag} must be stopped once`);
  const second = c.starts.slice(6);
  assert.equal(second.length, 6);
  assert.equal(new Set(second.map((s) => s.when)).size, 1);
  assert.deepEqual([...new Set(second.map((s) => s.offset))], [0.75]);
  engine.dispose();
});

// ─── 2. a mix change must not restart, reseek or click ───────────────────────

test('setGain / setMute / setSolo create NO node, stop nothing and reseek nothing', async () => {
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  engine.play();
  const nodesBefore = c.nodesCreated;
  const startsBefore = c.starts.length;
  const stopsBefore = c.sources.reduce((n, s) => n + s.stops.length, 0);
  c.advance(0.05 + 0.4);
  const posBefore = engine.getSnapshot().positionSec;

  engine.setGain('drums', 0.3);
  engine.setMute('bass', true);
  engine.setSolo('vocals', true);

  assert.equal(c.nodesCreated, nodesBefore, 'a mix change must not create an audio node');
  assert.equal(c.starts.length, startsBefore, 'a mix change must not start a source');
  assert.equal(
    c.sources.reduce((n, s) => n + s.stops.length, 0),
    stopsBefore,
    'a mix change must not stop a source',
  );
  assert.equal(engine.getSnapshot().status, 'playing');
  assert.ok(
    Math.abs(engine.getSnapshot().positionSec - posBefore) < 1e-9,
    'a mix change must not move the playhead',
  );
  engine.dispose();
});

test('a gain change while sounding is an automation ramp, never a step to a new value', async () => {
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  engine.play();
  c.advance(0.05 + 0.1);

  const g = c.gains[PLAYABLE_STEMS.indexOf('drums')];
  const held = g.gain.value;
  const mark = g.gain.events.length;
  engine.setGain('drums', 0.25);
  const added = g.gain.events.slice(mark);

  assert.ok(added.length > 0, 'the change must reach the AudioParam');
  const last = added[added.length - 1];
  assert.equal(last.type, 'setTargetAtTime', `expected a ramp, got ${last.type}`);
  assert.equal(last.v, 0.25);
  assert.ok(last.tc > 0, 'the ramp needs a non-zero time constant');
  for (const e of added) {
    if (e.type === 'setValueAtTime') {
      assert.equal(e.v, held, 'the only permitted step while sounding is a hold at the current value');
    }
    assert.notEqual(e.type, 'value=', 'never assign gain.value while sounding');
  }
  engine.dispose();
});

test('the cancelAndHoldAtTime path is used when the browser has it', async () => {
  const { engine, ctx } = await loadedSix({ cancelAndHold: true });
  const c = ctx();
  engine.play();
  c.advance(0.05 + 0.1);
  const g = c.gains[PLAYABLE_STEMS.indexOf('keys')];
  const mark = g.gain.events.length;
  engine.setGain('keys', 0.4);
  const added = g.gain.events.slice(mark).map((e) => e.type);
  assert.deepEqual(added, ['cancelAndHoldAtTime', 'setTargetAtTime']);
  engine.dispose();
});

test('a start fades in from zero, so the first sample cannot click', async () => {
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  engine.play();
  const g = c.gains[0];
  const types = g.gain.events.map((e) => e.type);
  const i = types.lastIndexOf('setValueAtTime');
  assert.ok(i >= 0 && types[i + 1] === 'linearRampToValueAtTime', 'expected setValueAtTime(0) then a ramp');
  assert.equal(g.gain.events[i].v, 0);
  assert.equal(g.gain.events[i + 1].v, 1);
  assert.ok(g.gain.events[i + 1].t > g.gain.events[i].t, 'the fade must have length');
  engine.dispose();
});

test('a stop fades out and only then stops the source — no cut', async () => {
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  engine.play();
  c.advance(0.05 + 0.3);
  const now = c.currentTime;
  engine.pause();
  const src = c.sources[0];
  assert.equal(src.stops.length, 1);
  assert.ok(src.stops[0] > now, 'the source must be stopped AFTER the fade, not at it');
  const fade = c.gains[0].gain.events.filter((e) => e.type === 'setTargetAtTime' && e.v === 0);
  assert.ok(fade.length >= 1, 'expected a fade-out ramp to zero');
  engine.dispose();
});

// ─── 3. monotonic position ───────────────────────────────────────────────────

test('positionSec advances monotonically while playing and holds while paused', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 10 });
  const c = ctx();
  engine.play();
  let last = engine.getSnapshot().positionSec;
  assert.equal(last, 0, 'during the scheduling lead the position reads as the start, never negative');
  for (let i = 0; i < 20; i++) {
    c.advance(0.1);
    const p = engine.getSnapshot().positionSec;
    assert.ok(p >= last, `position went backwards: ${last} -> ${p}`);
    last = p;
  }
  assert.ok(last > 1.8 && last < 2.0, `expected ~1.95 s, got ${last}`);
  engine.pause();
  const held = engine.getSnapshot().positionSec;
  c.advance(5);
  assert.equal(engine.getSnapshot().positionSec, held, 'a paused playhead must not drift');
  engine.dispose();
});

test('position is clamped to the duration and never exceeds it', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 2 });
  const c = ctx();
  engine.play();
  c.advance(0.05 + 99);
  assert.equal(engine.getSnapshot().positionSec, 2);
  engine.dispose();
});

test('the frame loop pushes position updates to subscribers while playing', async () => {
  const h = await loadedSix({}, { durationSec: 10 });
  const c = h.ctx();
  const seen = [];
  h.engine.subscribe((s) => seen.push(s.positionSec));
  h.engine.play();
  seen.length = 0;
  c.advance(0.05 + 0.5);
  h.runFrames(1);
  assert.ok(seen.length >= 1, 'a frame must publish the new position');
  assert.ok(Math.abs(seen[seen.length - 1] - 0.5) < 1e-6);
  h.engine.pause();
  assert.equal(
    h.frames.filter((f) => !f.cancelled && !f.ran).length,
    0,
    'pausing must CANCEL the pending frame, not just ignore it — a leaked rAF loop is a battery bug',
  );
  const before = seen.length;
  c.advance(1);
  h.runFrames(2);
  assert.equal(seen.length, before, 'the loop must stop when playback stops');
  h.engine.play();
  assert.equal(h.frames.filter((f) => !f.cancelled && !f.ran).length, 1, 'play re-arms exactly one frame');
  h.engine.dispose();
});

// ─── seek ────────────────────────────────────────────────────────────────────

test('seek while paused moves the playhead without touching the graph', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 10 });
  const c = ctx();
  const nodes = c.nodesCreated;
  engine.seek(4.25);
  assert.equal(engine.getSnapshot().positionSec, 4.25);
  assert.equal(engine.getSnapshot().status, 'ready');
  assert.equal(c.nodesCreated, nodes, 'seeking while paused must not create a source');
  assert.equal(c.starts.length, 0);
  engine.play();
  assert.deepEqual([...new Set(c.starts.map((s) => s.offset))], [4.25]);
  engine.dispose();
});

test('seek past the end clamps to the duration; seek before zero clamps to zero', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 3 });
  const c = ctx();
  engine.seek(9999);
  assert.equal(engine.getSnapshot().positionSec, 3);
  engine.seek(-50);
  assert.equal(engine.getSnapshot().positionSec, 0);

  engine.play();
  c.advance(0.05 + 0.5);
  engine.seek(9999);
  const snap = engine.getSnapshot();
  assert.equal(snap.positionSec, 3);
  assert.equal(snap.status, 'ended', 'seeking to the end while playing lands on the end');
  assert.equal(c.live().length, 0, 'nothing may still be sounding past the end');

  engine.play(); // play at the end restarts from the top
  assert.equal(engine.getSnapshot().status, 'playing');
  assert.equal(c.starts[c.starts.length - 1].offset, 0);
  engine.dispose();
});

test('seek ignores NaN and Infinity instead of corrupting the clock', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 5 });
  const c = ctx();
  engine.seek(2);
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '3']) {
    engine.seek(bad);
    assert.equal(engine.getSnapshot().positionSec, 2, `seek(${String(bad)}) must be a no-op`);
  }
  engine.play();
  c.advance(0.05 + 0.1);
  const pos = engine.getSnapshot().positionSec;
  engine.seek(NaN);
  assert.equal(engine.getSnapshot().status, 'playing');
  assert.ok(Math.abs(engine.getSnapshot().positionSec - pos) < 1e-9);
  engine.dispose();
});

// ─── loop ────────────────────────────────────────────────────────────────────

test('setLoop while playing inside the region loops natively — no restart, and it wraps', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 20 });
  const c = ctx();
  engine.play();
  c.advance(0.05 + 1.5);
  const nodes = c.nodesCreated;
  const startsBefore = c.starts.length;

  engine.setLoop({ startSec: 1, endSec: 3, label: 'chorus' });
  assert.equal(c.nodesCreated, nodes, 'setting a loop must not rebuild the graph');
  assert.equal(c.starts.length, startsBefore, 'setting a loop must not restart playback');
  for (const s of c.live()) {
    assert.equal(s.loop, true);
    assert.equal(s.loopStart, 1);
    assert.equal(s.loopEnd, 3);
  }
  assert.deepEqual(engine.getSnapshot().loop, { startSec: 1, endSec: 3, label: 'chorus' });

  // 1.5 -> 2.5 stays inside; 2.5 -> 3.5 wraps to 1.5; all six wrap together
  // because they share one loopStart/loopEnd and one start time.
  c.advance(1.0);
  assert.ok(Math.abs(engine.getSnapshot().positionSec - 2.5) < 1e-6);
  c.advance(1.0);
  assert.ok(
    Math.abs(engine.getSnapshot().positionSec - 1.5) < 1e-6,
    `expected a wrap to 1.5, got ${engine.getSnapshot().positionSec}`,
  );
  c.advance(2.0); // a whole span later: same point in the loop
  assert.ok(Math.abs(engine.getSnapshot().positionSec - 1.5) < 1e-6);
  engine.dispose();
});

test('a loop dropped exactly on the playhead does not restart playback', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 20 });
  const c = ctx();
  engine.play();
  c.advance(0.05 + 2); // float arithmetic lands a hair either side of 2.0
  const starts = c.starts.length;
  engine.setLoop({ startSec: 2, endSec: 6 });
  assert.equal(c.starts.length, starts, 'a boundary-exact loop must not re-trigger the stems');
  assert.ok(Math.abs(engine.getSnapshot().positionSec - 2) < 1e-6);
  engine.dispose();
});

test('setLoop while paused parks the playhead inside the region', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 20 });
  const c = ctx();
  engine.seek(12);
  engine.setLoop({ startSec: 2, endSec: 6 });
  assert.equal(engine.getSnapshot().positionSec, 2, 'a paused playhead outside the region moves to its head');
  assert.equal(c.starts.length, 0, 'and nothing starts sounding');
  engine.seek(4);
  engine.setLoop({ startSec: 2, endSec: 6 });
  assert.equal(engine.getSnapshot().positionSec, 4, 'a playhead already inside the region stays put');
  engine.play();
  assert.deepEqual([...new Set(c.starts.map((s) => s.offset))], [4]);
  for (const s of c.live()) {
    assert.equal(s.loop, true);
    assert.equal(s.loopStart, 2);
    assert.equal(s.loopEnd, 6);
  }
  engine.dispose();
});

test('setLoop(null) clears the loop on the live sources', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 20 });
  const c = ctx();
  engine.play();
  engine.setLoop({ startSec: 2, endSec: 5 });
  engine.setLoop(null);
  assert.equal(engine.getSnapshot().loop, null);
  for (const s of c.live()) assert.equal(s.loop, false);
  engine.dispose();
});

test('setLoop outside the region seeks to its head; a bad region is a no-op', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 20 });
  const c = ctx();
  engine.play();
  c.advance(0.05 + 8);
  engine.setLoop({ startSec: 1, endSec: 3 });
  assert.ok(Math.abs(engine.getSnapshot().positionSec - 1) < 1e-6, 'must jump to the loop head');
  assert.equal(c.starts[c.starts.length - 1].offset, 1);
  for (const s of c.live()) assert.equal(s.loop, true);

  for (const bad of [
    { startSec: 5, endSec: 2 },
    { startSec: 5, endSec: 5 },
    { startSec: NaN, endSec: 3 },
    { startSec: 1, endSec: NaN },
  ]) {
    engine.setLoop(bad);
    assert.deepEqual(engine.getSnapshot().loop, { startSec: 1, endSec: 3 }, 'a bad region must be ignored');
  }
  engine.dispose();
});

// ─── solo + mute ─────────────────────────────────────────────────────────────

const silentSet = (engine) =>
  new Set(engine.getSnapshot().stems.filter((s) => s.effectivelySilent).map((s) => s.name));

test('solo is additive, mute wins over solo, and effectivelySilent matches the graph', async () => {
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  engine.play();
  c.advance(0.05 + 0.2);

  engine.setSolo('drums', true);
  assert.deepEqual(
    [...silentSet(engine)].sort(),
    PLAYABLE_STEMS.filter((n) => n !== 'drums').sort(),
    'one solo silences every other stem',
  );

  engine.setSolo('bass', true); // additive — two soloed
  assert.deepEqual(
    [...silentSet(engine)].sort(),
    PLAYABLE_STEMS.filter((n) => n !== 'drums' && n !== 'bass').sort(),
  );

  engine.setMute('drums', true); // muted AND soloed -> silent
  assert.ok(silentSet(engine).has('drums'), 'mute must win over the stem’s own solo');
  const drums = engine.getSnapshot().stems.find((s) => s.name === 'drums');
  assert.equal(drums.muted, true);
  assert.equal(drums.soloed, true, 'mute must not clear solo — they are independent');

  // the graph agrees with the field
  for (const name of PLAYABLE_STEMS) {
    const g = c.gains[PLAYABLE_STEMS.indexOf(name)];
    const expected = silentSet(engine).has(name) ? 0 : 1;
    assert.equal(g.gain.value, expected, `${name} gain should be ${expected}`);
  }

  engine.setSolo('drums', false);
  engine.setSolo('bass', false);
  engine.setMute('drums', false);
  assert.equal(silentSet(engine).size, 0, 'clearing solo and mute un-silences everything');
  engine.dispose();
});

test('TWO stems soloed at once both play — additive solo, not mutual exclusion', async () => {
  // The exact case a literal reading of the contract's "some OTHER stem is
  // soloed" wording breaks: with drums and bass both soloed, each has another
  // soloed stem, so the literal rule would silence both. The rule is
  // `muted || (anySoloed && !soloed)`.
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  engine.play();
  c.advance(0.05 + 0.2);
  engine.setSolo('drums', true);
  engine.setSolo('bass', true);

  const byName = new Map(engine.getSnapshot().stems.map((s) => [s.name, s]));
  assert.equal(byName.get('drums').effectivelySilent, false, 'drums is soloed, so it plays');
  assert.equal(byName.get('bass').effectivelySilent, false, 'bass is soloed too, so it also plays');
  for (const n of ['guitar', 'keys', 'vocals', 'other']) {
    assert.equal(byName.get(n).effectivelySilent, true, `${n} is not soloed, so it is silent`);
  }
  // and the graph agrees: both soloed channels are still at their fader value
  assert.equal(c.gains[PLAYABLE_STEMS.indexOf('drums')].gain.value, 1);
  assert.equal(c.gains[PLAYABLE_STEMS.indexOf('bass')].gain.value, 1);
  assert.equal(c.gains[PLAYABLE_STEMS.indexOf('vocals')].gain.value, 0);
  engine.dispose();
});

test('soloing every stem at once silences nothing', async () => {
  const { engine } = await loadedSix();
  for (const name of PLAYABLE_STEMS) engine.setSolo(name, true);
  assert.equal(silentSet(engine).size, 0);
  assert.ok(engine.getSnapshot().stems.every((s) => s.soloed));
});

test('unmuting restores the previous gain — mute is independent of gain', async () => {
  const { engine } = await loadedSix();
  engine.setGain('vocals', 0.42);
  engine.setMute('vocals', true);
  let v = engine.getSnapshot().stems.find((s) => s.name === 'vocals');
  assert.equal(v.gain, 0.42, 'muting must not destroy the fader value');
  assert.equal(v.effectivelySilent, true);
  engine.setMute('vocals', false);
  v = engine.getSnapshot().stems.find((s) => s.name === 'vocals');
  assert.equal(v.gain, 0.42);
  assert.equal(v.effectivelySilent, false);
});

test('gain is clamped to [0,1] and non-finite values are refused', async () => {
  const { engine } = await loadedSix();
  const gainOf = (n) => engine.getSnapshot().stems.find((s) => s.name === n).gain;
  engine.setGain('drums', -1);
  assert.equal(gainOf('drums'), 0);
  engine.setGain('drums', 2);
  assert.equal(gainOf('drums'), 1);
  engine.setGain('drums', 0.5);
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '0.9']) {
    engine.setGain('drums', bad);
    assert.equal(gainOf('drums'), 0.5, `setGain(${String(bad)}) must be ignored`);
  }
  engine.setGain('nope', 0.1); // unknown stem
  engine.setMute('nope', true);
  engine.setSolo('nope', true);
  assert.equal(engine.getSnapshot().stems.length, 6);
});

test('a stem with no audio cannot be mixed, so it cannot silence the mix', async () => {
  const h = harness();
  const sources = PLAYABLE_STEMS.filter((n) => n !== 'guitar').map((name) => ({
    name,
    bytes: makeStemBytes(name),
  }));
  await h.engine.load(sources);
  h.engine.setSolo('guitar', true); // the missing one
  const guitar = h.engine.getSnapshot().stems.find((s) => s.name === 'guitar');
  assert.equal(guitar.availability, 'unavailable');
  assert.equal(guitar.soloed, false, 'a stem that was never produced cannot be soloed');
  assert.equal(silentSet(h.engine).size, 0, 'soloing a missing stem must not silence the whole mix');
  h.engine.dispose();
});

// ─── 4. every method is safe in any status ───────────────────────────────────

test('every method is a no-op in idle — a UI never needs a status guard', () => {
  const h = harness();
  const { engine } = h;
  const before = engine.getSnapshot();
  assert.equal(before.status, 'idle');

  engine.play();
  engine.pause();
  engine.seek(5);
  engine.seek(NaN);
  engine.setGain('drums', 0.5);
  engine.setMute('drums', true);
  engine.setSolo('drums', true);
  engine.setLoop({ startSec: 1, endSec: 2 });
  engine.setLoop(null);
  const un = engine.subscribe(() => {});
  un();
  un();

  const after = engine.getSnapshot();
  assert.equal(after.status, 'idle');
  assert.equal(after.positionSec, 0);
  assert.equal(after.durationSec, 0);
  assert.deepEqual(after.stems, []);
  assert.equal(after.loop, null);
  assert.equal(after.degraded, null);
  assert.equal(after.error, null);
  assert.equal(h.contexts.length, 0, 'idle must not even build an AudioContext');
  engine.dispose();
});

test('every method is a no-op after dispose, and dispose is safe twice (and mid-playback)', async () => {
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  engine.play();
  c.advance(0.05 + 0.3);
  const seen = [];
  engine.subscribe((s) => seen.push(s.status));

  engine.dispose();
  assert.equal(seen[seen.length - 1], 'idle', 'dispose publishes a final idle snapshot');
  assert.equal(c.live().length, 0, 'dispose mid-playback must stop every source');
  assert.equal(c.closes, 1, 'dispose must release the AudioContext');

  engine.dispose(); // twice
  engine.dispose(); // and again
  assert.equal(c.closes, 1, 'a second dispose must not close twice');

  engine.play();
  engine.pause();
  engine.seek(1);
  engine.setGain('drums', 0.2);
  engine.setMute('drums', true);
  engine.setSolo('drums', true);
  engine.setLoop({ startSec: 0, endSec: 1 });
  const un = engine.subscribe(() => {
    throw new Error('a disposed engine must not notify');
  });
  un();
  assert.equal(engine.getSnapshot().status, 'idle');
  assert.equal(engine.getSnapshot().stems.length, 0);

  await engine.load(SIX()); // load after dispose stays dead
  assert.equal(engine.getSnapshot().status, 'idle');
});

test('out-of-order calls are harmless: pause before play, double play, play while loading', async () => {
  const h = harness();
  const { engine } = h;
  const pending = engine.load(SIX());
  engine.play(); // mid-load, before anything has decoded
  engine.pause();
  engine.seek(1);
  assert.equal(engine.getSnapshot().status, 'loading');
  // ...and again once some stems ARE decoded but the load is still running:
  // half-built channels must not be playable.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.ok(h.ctx().gains.length === 0, 'channels are only wired once the load finishes');
  engine.play();
  assert.equal(engine.getSnapshot().status, 'loading', 'play must not escape a running load');
  assert.equal(h.ctx().starts.length, 0);
  await pending;

  engine.pause(); // never played
  assert.equal(engine.getSnapshot().status, 'ready');
  assert.equal(h.ctx().starts.length, 0, 'nothing may have started during the load');
  engine.play();
  const starts = h.ctx().starts.length;
  engine.play(); // double play must not double-start
  engine.play();
  assert.equal(h.ctx().starts.length, starts, 'play while playing must be a no-op');
  engine.pause();
  engine.pause();
  assert.equal(engine.getSnapshot().status, 'ready');
  engine.dispose();
});

// ─── degraded / error paths ──────────────────────────────────────────────────

test('a missing stem is degraded, not silent', async () => {
  const h = harness();
  await h.engine.load(
    PLAYABLE_STEMS.filter((n) => n !== 'guitar' && n !== 'keys').map((name) => ({
      name,
      bytes: makeStemBytes(name),
    })),
  );
  const snap = h.engine.getSnapshot();
  assert.equal(snap.status, 'ready');
  assert.deepEqual([...snap.degraded.missing].sort(), ['guitar', 'keys']);
  assert.equal(snap.stems.length, 6, 'all six are still reported, so the mixer can show the gap');
  assert.equal(snap.stems.find((s) => s.name === 'guitar').availability, 'unavailable');
  assert.equal(h.ctx().gains.length, 4, 'only the four real stems get a channel');
  h.engine.play();
  assert.equal(h.ctx().starts.length, 4);
  assert.equal(new Set(h.ctx().starts.map((s) => s.when)).size, 1, 'four stems stay sample-locked too');
  h.engine.dispose();
});

test('a stem that fails to decode is encode_failed and degraded', async () => {
  const h = harness();
  await h.engine.load([
    ...PLAYABLE_STEMS.filter((n) => n !== 'bass').map((name) => ({ name, bytes: makeStemBytes(name) })),
    { name: 'bass', bytes: makeStemBytes('bass', { fail: true }) },
  ]);
  const snap = h.engine.getSnapshot();
  assert.equal(snap.status, 'ready');
  assert.equal(snap.stems.find((s) => s.name === 'bass').availability, 'encode_failed');
  assert.deepEqual([...snap.degraded.missing], ['bass']);
  h.engine.dispose();
});

test('a zero-length buffer is treated as a failed stem, not as silence', async () => {
  const h = harness();
  await h.engine.load([
    ...PLAYABLE_STEMS.filter((n) => n !== 'other').map((name) => ({ name, bytes: makeStemBytes(name) })),
    { name: 'other', bytes: makeStemBytes('other', { durationSec: 0 }) },
  ]);
  const snap = h.engine.getSnapshot();
  assert.equal(snap.stems.find((s) => s.name === 'other').availability, 'encode_failed');
  assert.deepEqual([...snap.degraded.missing], ['other']);
  assert.equal(snap.status, 'ready');
  h.engine.dispose();
});

test('garbage bytes, an empty list and an all-failing load each give a clean error', async () => {
  const a = harness();
  await a.engine.load([]);
  assert.equal(a.engine.getSnapshot().status, 'error');
  assert.equal(a.engine.getSnapshot().error.code, ENGINE_ERROR.NO_STEMS);
  a.engine.play();
  assert.equal(a.engine.getSnapshot().status, 'error', 'play must not escape an error state');
  a.engine.dispose();

  const b = harness();
  await b.engine.load(SIX({ fail: true }));
  assert.equal(b.engine.getSnapshot().error.code, ENGINE_ERROR.DECODE_FAILED);
  assert.deepEqual([...b.engine.getSnapshot().degraded.missing].sort(), [...PLAYABLE_STEMS].sort());
  b.engine.dispose();

  const c = harness();
  await c.engine.load([{ name: 'drums', bytes: new ArrayBuffer(3) }]);
  assert.equal(c.engine.getSnapshot().error.code, ENGINE_ERROR.DECODE_FAILED);
  c.engine.dispose();

  const d = harness();
  await d.engine.load(null); // not even a list
  assert.equal(d.engine.getSnapshot().error.code, ENGINE_ERROR.NO_STEMS);
  d.engine.dispose();
});

test(`a track longer than MAX_TRACK_SEC (${MAX_TRACK_SEC}s) is refused, not silently degraded`, async () => {
  const h = harness();
  // A low decode rate keeps the fake PCM small while the duration arithmetic
  // (length / sampleRate) stays honest.
  await h.engine.load(SIX({ durationSec: MAX_TRACK_SEC + 1, rate: 1000 }));
  const snap = h.engine.getSnapshot();
  assert.equal(snap.status, 'error');
  assert.equal(snap.error.code, ENGINE_ERROR.TOO_LONG);
  assert.match(snap.error.message, new RegExp(String(MAX_TRACK_SEC)));
  h.engine.play();
  assert.equal(h.ctx().starts.length, 0, 'an over-long track must never start');
  h.engine.dispose();
});

test('no Web Audio at all is an error, not a crash', async () => {
  const engine = new WebAudioPlayEngine({
    createAudioContext: () => {
      throw new Error('Web Audio is unavailable');
    },
    scheduleFrame: () => () => {},
  });
  await engine.load(SIX());
  assert.equal(engine.getSnapshot().status, 'error');
  assert.equal(engine.getSnapshot().error.code, ENGINE_ERROR.NO_AUDIO);
  engine.play();
  engine.seek(1);
  engine.dispose();
});

// ─── decode / memory discipline ──────────────────────────────────────────────

test('stems decode ONE at a time and are downmixed to mono before the next decode', async () => {
  const { engine, ctx } = await loadedSix({}, { rate: PLAYBACK_SAMPLE_RATE });
  const c = ctx();
  assert.equal(c.maxInFlightDecodes, 1, 'two stereo buffers must never be in flight at once');
  assert.deepEqual(
    c.events,
    PLAYABLE_STEMS.flatMap((n) => [`decode:${n}`, `downmix:${n}`]),
    'each decode must be followed by its downmix before the next decode starts',
  );
  engine.play();
  for (const s of c.live()) {
    assert.equal(s.buffer.numberOfChannels, 1, `${s.buffer.tag} must play back mono`);
    assert.equal(s.buffer.sampleRate, PLAYBACK_SAMPLE_RATE);
  }
  engine.dispose();
});

test('the downmix averages the channels rather than dropping one', async () => {
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  engine.play();
  const mono = c.live()[0].buffer.getChannelData(0);
  // channel 0 = 0.5, channel 1 = 1.0 -> 0.75
  assert.ok(Math.abs(mono[0] - 0.75) < 1e-6, `expected 0.75, got ${mono[0]}`);
  assert.ok(Math.abs(mono[mono.length - 1] - 0.75) < 1e-6);
  engine.dispose();
});

// ─── the decode transient (engine.ts MEMORY / types.ts PLAYBACK_SAMPLE_RATE) ──
//
// The settled figure is six whole-track mono buffers. The PEAK is seven,
// because `decodeAudioData` hands back a STEREO buffer and the last one is
// alive beside the five monos already decoded. It used to be EIGHT: the mono
// destination was allocated while the stereo source was still live, which is a
// +110 MB renderer-RSS transient DURING LOAD, measured in real Chromium.
//
// Node has no Web Audio and no RSS to measure, so these tests gate the
// STRUCTURE that moved the number — the release happens, it happens on the
// right buffers, and it never touches a buffer we are going to play — and the
// ARITHMETIC the doc comment quotes. The MB figures themselves are a Chromium
// measurement and are cited in the PR, not asserted here.

test('the spent channels are released BEFORE the mono buffer is allocated', async () => {
  // THE ORDER IS THE FIX. Releasing after the allocation frees the same bytes
  // and leaves the same end state, so no after-the-fact assertion can tell the
  // two apart — and three order-only regressions (allocate above the release;
  // release everything last; the whole pre-fix alloc-first body with a
  // trailing release) passed the entire suite before this test existed.
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  assert.equal(c.allocs.length, PLAYABLE_STEMS.length, 'one allocation per stereo stem');
  for (const a of c.allocs) {
    assert.deepEqual(
      a.resident,
      [true, false],
      `${a.tag}: at the instant the mono buffer is allocated, channel 0 must still` +
        ' hold the summed data and every other channel must ALREADY be released',
    );
  }
  engine.dispose();
});

test('peak live whole-track buffers during load is stems + 1, not stems + 2', async () => {
  // The number the PLAYBACK_SAMPLE_RATE comment budgets against, read off the
  // engine rather than asserted as arithmetic on the test's own locals.
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  const peak = Math.max(...c.allocs.map((a) => a.liveWholeTrackUnits));
  assert.equal(
    peak,
    PLAYABLE_STEMS.length + 1,
    'five resident monos + one surviving decode channel + the buffer being allocated',
  );
  // and it is reached on the LAST stem, which is what makes it the peak
  assert.equal(c.allocs[c.allocs.length - 1].liveWholeTrackUnits, peak);
  engine.dispose();
});

test('the downmix releases every decoded channel rather than leaving it to GC', async () => {
  const { engine, ctx } = await loadedSix();
  const c = ctx();
  assert.equal(c.decodedBuffers.length, PLAYABLE_STEMS.length);
  for (const d of c.decodedBuffers) {
    assert.equal(d.numberOfChannels, 2, `${d.tag} was decoded stereo`);
    for (let ch = 0; ch < d.numberOfChannels; ch++) {
      assert.equal(
        d.getChannelData(ch).length,
        0,
        `${d.tag} channel ${ch} must be released inside the downmix, not left for GC`,
      );
    }
  }
  // ...and the buffer we actually play is untouched by that release.
  engine.play();
  for (const live of c.live()) {
    assert.equal(live.buffer.numberOfChannels, PLAYBACK_CHANNELS);
    assert.ok(live.buffer.getChannelData(0).length > 0, `${live.buffer.tag} must still hold PCM`);
    assert.ok(Math.abs(live.buffer.getChannelData(0)[0] - 0.75) < 1e-6);
  }
  engine.dispose();
});

test('an already-mono decode is NEVER released — it is the buffer we play', async () => {
  const { engine, ctx } = await loadedSix({}, { channels: 1 });
  const c = ctx();
  assert.equal(c.decodedBuffers.length, PLAYABLE_STEMS.length);
  for (const d of c.decodedBuffers) {
    assert.ok(d.getChannelData(0).length > 0, `${d.tag} is played as-is and must keep its PCM`);
  }
  engine.play();
  const played = c.live().map((s) => s.buffer);
  for (const b of played) assert.ok(c.decodedBuffers.includes(b), 'the decoded buffer IS the played buffer');
  engine.dispose();
});

test('the downmix is still correct where the host cannot release a channel', async () => {
  // `releaseChannelData` is an optimisation with a no-op fallback. Remove the
  // only API it can use and the audio must be byte-for-byte what it was.
  const saved = globalThis.structuredClone;
  delete globalThis.structuredClone;
  try {
    const { engine, ctx } = await loadedSix();
    const c = ctx();
    engine.play();
    for (const live of c.live()) {
      const mono = live.buffer.getChannelData(0);
      assert.equal(live.buffer.numberOfChannels, PLAYBACK_CHANNELS);
      assert.ok(Math.abs(mono[0] - 0.75) < 1e-6, `expected 0.75, got ${mono[0]}`);
      assert.ok(Math.abs(mono[mono.length - 1] - 0.75) < 1e-6);
    }
    // nothing was released, so the decoded buffers are merely unreferenced
    for (const d of c.decodedBuffers) assert.ok(d.getChannelData(1).length > 0);
    engine.dispose();
  } finally {
    globalThis.structuredClone = saved;
  }
});

test('a channel that is a view onto a shared store is never detached', async () => {
  // The byteOffset/byteLength guard. Detaching a sub-view would take bytes
  // belonging to the sibling channels, so the release must decline and the
  // downmix must still be right.
  const { engine, ctx } = await loadedSix({ sharedStore: true });
  const c = ctx();
  for (const d of c.decodedBuffers) {
    for (let ch = 0; ch < d.numberOfChannels; ch++) {
      assert.ok(d.getChannelData(ch).length > 0, `${d.tag} ch${ch}: a shared store must survive`);
    }
  }
  engine.play();
  for (const live of c.live()) {
    const mono = live.buffer.getChannelData(0);
    assert.ok(Math.abs(mono[0] - 0.75) < 1e-6, `expected 0.75, got ${mono[0]}`);
  }
  engine.dispose();
});

test('a host whose structuredClone throws degrades to the old behaviour', async () => {
  // The catch. A transfer the host refuses must be a no-op, not a load failure.
  const saved = globalThis.structuredClone;
  let calls = 0;
  globalThis.structuredClone = () => {
    calls++;
    throw new DOMException('cannot transfer', 'DataCloneError');
  };
  try {
    const { engine, ctx } = await loadedSix();
    const c = ctx();
    assert.ok(calls > 0, 'the engine must have attempted a transfer');
    assert.equal(engine.getSnapshot().status, 'ready', 'a refused transfer is not a load failure');
    engine.play();
    for (const live of c.live()) {
      const mono = live.buffer.getChannelData(0);
      assert.equal(live.buffer.numberOfChannels, PLAYBACK_CHANNELS);
      assert.ok(Math.abs(mono[0] - 0.75) < 1e-6, `expected 0.75, got ${mono[0]}`);
    }
    engine.dispose();
  } finally {
    globalThis.structuredClone = saved;
  }
});

test('the PCM budget in the PLAYBACK_SAMPLE_RATE comment matches its own constants', () => {
  // Imported, never grepped: change a constant and this fails, which is the
  // only thing that keeps the doc comment honest.
  const BYTES_PER_SAMPLE = 4; // AudioBuffer is always Float32
  const MIB = 2 ** 20;
  const stems = PLAYABLE_STEMS.length;
  const pcm = (channels, rate = PLAYBACK_SAMPLE_RATE, dur = MAX_TRACK_SEC, n = stems) =>
    n * dur * rate * channels * BYTES_PER_SAMPLE;

  const settled = pcm(PLAYBACK_CHANNELS);
  assert.equal(settled, 345_600_000, 'settled PCM, 6 x 300 s x 48 kHz mono');
  assert.equal(Number((settled / MIB).toFixed(1)), 329.6, 'quoted as 329.6 MiB');
  assert.equal(pcm(2), 691_200_000);
  assert.equal(Number((pcm(2) / MIB).toFixed(1)), 659.2, 'quoted as 659.2 MiB');
  assert.equal(pcm(PLAYBACK_CHANNELS, PLAYBACK_SAMPLE_RATE / 2), 172_800_000);
  assert.equal(Number((pcm(PLAYBACK_CHANNELS, PLAYBACK_SAMPLE_RATE / 2) / MIB).toFixed(1)), 164.8);

  // The unit error this comment used to carry: these are MiB, and MB is a
  // DIFFERENT, larger-sounding number. Asserting both stops the two being
  // confused again.
  assert.equal(Number((settled / 1e6).toFixed(1)), 345.6, 'the SAME bytes are 345.6 MB');
  assert.notEqual(Number((settled / MIB).toFixed(1)), Number((settled / 1e6).toFixed(1)));

  // PEAK PCM during load. The buffer COUNT (stems + 1) is not asserted here —
  // arithmetic on this test's own locals would prove nothing about the engine.
  // It is measured off the engine in 'peak live whole-track buffers during
  // load is stems + 1'; this only converts that count into bytes.
  const oneStem = pcm(PLAYBACK_CHANNELS, PLAYBACK_SAMPLE_RATE, MAX_TRACK_SEC, 1);
  assert.equal((stems + 1) * oneStem, 403_200_000, 'peak PCM during load');
  assert.equal(Number((((stems + 1) * oneStem) / MIB).toFixed(1)), 384.5, 'quoted as 384.5 MiB');
});

test('an already-mono decode is used as-is, not copied', async () => {
  const { engine, ctx } = await loadedSix({}, { channels: 1 });
  const c = ctx();
  assert.deepEqual(c.events, PLAYABLE_STEMS.map((n) => `decode:${n}`), 'no createBuffer for a mono decode');
  engine.play();
  for (const s of c.live()) assert.equal(s.buffer.numberOfChannels, 1);
  engine.dispose();
});

test('load does not detach the caller’s bytes, so it can be run twice', async () => {
  const h = harness();
  const sources = SIX();
  await h.engine.load(sources);
  assert.equal(h.engine.getSnapshot().status, 'ready');
  assert.ok(
    sources.every((s) => s.bytes.byteLength === 24),
    'the loader’s ArrayBuffers must survive — decode gets a copy',
  );
  await h.engine.load(sources);
  const c = h.ctx();
  assert.equal(h.engine.getSnapshot().status, 'ready');
  assert.deepEqual(c.decodeCalls, new Array(12).fill(24));
  assert.equal(c.gains.length, 12, 'a reload rebuilds the channels');
  assert.equal(h.contexts.length, 1, 'but reuses the one AudioContext');
  h.engine.dispose();
});

test('a superseded load cannot publish its result', async () => {
  const h = harness();
  const first = h.engine.load(SIX({ durationSec: 4 }));
  const second = h.engine.load(SIX({ durationSec: 7 }));
  await Promise.all([first, second]);
  assert.equal(h.engine.getSnapshot().durationSec, 7, 'the latest load wins');
  h.engine.dispose();
});

// ─── status, clock, subscribers ──────────────────────────────────────────────

test('a suspended context is resumed on play', async () => {
  const { engine, ctx } = await loadedSix({ state: 'suspended' });
  engine.play();
  assert.equal(ctx().resumes, 1);
  assert.equal(engine.getSnapshot().status, 'playing');
  engine.dispose();
});

test('the natural end of the buffer ends the transport exactly once', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 2 });
  const c = ctx();
  const statuses = [];
  engine.subscribe((s) => statuses.push(s.status));
  engine.play();
  c.advance(0.05 + 2);
  const live = c.live();
  for (const s of live) s.fireEnded();
  const snap = engine.getSnapshot();
  assert.equal(snap.status, 'ended');
  assert.equal(snap.positionSec, 2);
  assert.equal(statuses.filter((s) => s === 'ended').length, 1, 'ended must be published once, not six times');
  engine.dispose();
});

test('one stem ending early does not end the transport', async () => {
  const h = harness();
  await h.engine.load([
    { name: 'drums', bytes: makeStemBytes('drums', { durationSec: 1 }) },
    ...PLAYABLE_STEMS.filter((n) => n !== 'drums').map((name) => ({
      name,
      bytes: makeStemBytes(name, { durationSec: 3 }),
    })),
  ]);
  const c = h.ctx();
  assert.equal(h.engine.getSnapshot().durationSec, 3, 'duration is the longest stem, not the shortest');
  h.engine.play();
  c.advance(0.05 + 1);
  c.sourcesFor('drums')[0].fireEnded(); // the short one runs out first
  assert.equal(h.engine.getSnapshot().status, 'playing', 'the transport ends when the LAST stem ends');
  c.advance(2);
  for (const s of c.live()) s.fireEnded();
  assert.equal(h.engine.getSnapshot().status, 'ended');
  h.engine.dispose();
});

test('an onended from a run we already stopped is ignored', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 10 });
  const c = ctx();
  engine.play();
  const first = c.sources.slice();
  c.advance(0.05 + 1);
  engine.pause();
  for (const s of first) s.fireEndedQueued(); // the browser can still deliver these
  assert.equal(engine.getSnapshot().status, 'ready', 'a stale ended must not end the transport');
  engine.dispose();
});

test('subscribe fires on every status change, returns a working unsubscribe, and is safe twice', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 10 });
  const c = ctx();
  const seen = [];
  const un = engine.subscribe((s) => seen.push(s.status));
  assert.equal(typeof un, 'function');

  engine.play();
  engine.pause();
  engine.seek(1);
  assert.deepEqual(
    seen.filter((s, i) => s !== seen[i - 1]),
    ['playing', 'ready'],
    'every status change must be published',
  );

  un();
  un(); // twice is safe
  const count = seen.length;
  engine.play();
  engine.pause();
  assert.equal(seen.length, count, 'an unsubscribed listener must hear nothing');

  // one listener throwing must not break the others or the engine
  const other = [];
  engine.subscribe(() => {
    throw new Error('boom');
  });
  engine.subscribe((s) => other.push(s.status));
  engine.play();
  assert.deepEqual(other, ['playing']);
  engine.subscribe(null); // not a function
  c.advance(1);
  engine.dispose();
});

test('getSnapshot keeps object identity while nothing changes — safe for useSyncExternalStore', async () => {
  const { engine, ctx } = await loadedSix({}, { durationSec: 10 });
  const c = ctx();
  const a = engine.getSnapshot();
  assert.equal(engine.getSnapshot(), a, 'a second read with no change must be the same object');
  engine.play();
  const b = engine.getSnapshot();
  assert.notEqual(b, a);
  assert.equal(engine.getSnapshot(), b, 'identity must hold within a frame');
  c.advance(0.0005); // sub-quantum: still the same frame
  assert.equal(engine.getSnapshot(), b);
  c.advance(0.5);
  assert.notEqual(engine.getSnapshot(), b, 'a real move must produce a new snapshot');
  engine.dispose();
});

test('the snapshot is frozen, so no consumer can corrupt engine state', async () => {
  const { engine } = await loadedSix();
  const snap = engine.getSnapshot();
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.stems));
  assert.ok(Object.isFrozen(snap.stems[0]));
  assert.throws(() => {
    'use strict';
    snap.stems[0].gain = 0.1;
  });
  engine.dispose();
});

test('createPlayEngine returns a working engine with the whole contract surface', async () => {
  const engine = createPlayEngine({
    createAudioContext: (o) => new FakeAudioContext(o),
    scheduleFrame: () => () => {},
  });
  for (const m of [
    'load',
    'play',
    'pause',
    'seek',
    'setGain',
    'setMute',
    'setSolo',
    'setLoop',
    'getSnapshot',
    'subscribe',
    'dispose',
  ]) {
    assert.equal(typeof engine[m], 'function', `missing ${m}`);
  }
  await engine.load(SIX());
  assert.equal(engine.getSnapshot().status, 'ready');
  assert.equal(engine.getSnapshot().stems.length, 6);
  assert.deepEqual(
    engine.getSnapshot().stems.map((s) => s.name),
    [...PLAYABLE_STEMS],
    'stems are reported in the contract’s display order',
  );
  engine.dispose();
});
