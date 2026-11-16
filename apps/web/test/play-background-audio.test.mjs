// Story 8 (phones) — src/lib/play/background-audio.ts, driven with fakes.
//
// What these tests CAN show: the module wires each browser API exactly as its
// spec describes, falls back to ctx.destination whenever the media-element
// route cannot run, routes lock-screen actions to the same callbacks the
// on-screen transport uses, and cleans up after itself.
//
// What they CANNOT show, and nothing in Node can: that iOS Safari or Android
// Chrome actually keep a MediaStream-backed <audio> element playing with the
// screen off. That needs a real phone; see the PR body.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SEEK_STEP_SEC,
  MEDIA_SESSION_ACTIONS,
  POSITION_DRIFT_SEC,
  RESUME_DOC_EVENTS,
  RESUME_WIN_EVENTS,
  MAX_ROUTE_LATENCY_SEC,
  ROUTE_TRANSPORT_LATENCY_SEC,
  createBackgroundOutput,
  routeLatencySec,
  playbackStateFor,
  setPlaybackAudioSession,
  wireAudioResume,
  wireMediaSession,
} from '../src/lib/play/background-audio.ts';

// ─── fakes ───────────────────────────────────────────────────────────────────

class FakeNode {
  constructor(kind) {
    this.kind = kind;
    this.outputs = [];
    this.disconnects = 0;
  }
  connect(n) {
    this.outputs.push(n);
    return n;
  }
  disconnect() {
    this.disconnects++;
    this.outputs = [];
  }
}

function fakeCtx({ stream = true } = {}) {
  const ctx = {
    destination: new FakeNode('destination'),
    created: [],
    createGain() {
      const g = new FakeNode('gain');
      this.created.push(g);
      return g;
    },
  };
  if (stream) {
    ctx.createMediaStreamDestination = () => {
      const d = new FakeNode('stream-dest');
      d.stream = { id: 'stream-1' };
      ctx.created.push(d);
      return d;
    };
  }
  return ctx;
}

function fakeAudioElement({ play = () => Promise.resolve() } = {}) {
  const listeners = {};
  const el = {
    srcObject: null,
    playsInline: false,
    autoplay: true,
    paused: true,
    attrs: {},
    plays: 0,
    pauses: 0,
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener(t, cb) {
      (listeners[t] ??= []).push(cb);
    },
    removeEventListener(t, cb) {
      listeners[t] = (listeners[t] ?? []).filter((x) => x !== cb);
    },
    play() {
      this.plays++;
      this.paused = false;
      return play();
    },
    pause() {
      this.pauses++;
      this.paused = true;
      for (const cb of listeners.pause ?? []) cb();
    },
    /** Test-only: the OS pauses the element. */
    systemPause() {
      this.paused = true;
      for (const cb of listeners.pause ?? []) cb();
    },
    listenerCount: (t) => (listeners[t] ?? []).length,
  };
  return el;
}
const docWith = (el) => ({ createElement: (tag) => (assert.equal(tag, 'audio'), el) });
const tick = () => new Promise((r) => setTimeout(r, 0));

// ═══ 1. output route ═════════════════════════════════════════════════════════

test('route: bus → MediaStreamDestination → <audio playsinline>, and NOT to the speakers directly', () => {
  const el = fakeAudioElement();
  const out = createBackgroundOutput(docWith(el));
  const ctx = fakeCtx();
  const bus = out.createOutput(ctx);
  const dest = ctx.created.find((n) => n.kind === 'stream-dest');
  assert.equal(bus.kind, 'gain');
  assert.deepEqual(bus.outputs, [dest], 'the bus feeds the stream only (no double audio)');
  assert.equal(el.srcObject, dest.stream);
  assert.equal(el.playsInline, true);
  assert.equal(el.attrs.playsinline, '');
  assert.equal(el.autoplay, false);
  assert.equal(out.routed, true);
});

test('route: no createMediaStreamDestination → the bus goes straight to ctx.destination', () => {
  const el = fakeAudioElement();
  const out = createBackgroundOutput(docWith(el));
  const ctx = fakeCtx({ stream: false });
  const bus = out.createOutput(ctx);
  assert.deepEqual(bus.outputs, [ctx.destination]);
  assert.equal(out.routed, false);
  out.play(); // nothing to start, nothing thrown
  assert.equal(el.plays, 0);
});

test('route: no document (or no createElement) → ctx.destination', () => {
  for (const doc of [null, undefined, {}]) {
    const out = createBackgroundOutput(doc);
    const ctx = fakeCtx();
    assert.deepEqual(out.createOutput(ctx).outputs, [ctx.destination]);
    assert.equal(out.routed, false);
  }
});

test('route: the element REFUSING to play re-points the bus at ctx.destination (sound beats background)', async () => {
  const el = fakeAudioElement({ play: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) });
  const out = createBackgroundOutput(docWith(el));
  const ctx = fakeCtx();
  const bus = out.createOutput(ctx);
  out.play();
  await tick();
  assert.deepEqual(bus.outputs, [ctx.destination]);
  assert.equal(out.routed, false);
});

test('route: a play() that throws synchronously also falls back', () => {
  const el = fakeAudioElement({ play: () => { throw new Error('boom'); } });
  const out = createBackgroundOutput(docWith(el));
  const ctx = fakeCtx();
  const bus = out.createOutput(ctx);
  out.play();
  assert.deepEqual(bus.outputs, [ctx.destination]);
});

test('route: an AbortError (our own pause overtook play) is NOT a refusal; the route stays', async () => {
  const el = fakeAudioElement({ play: () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })) });
  const out = createBackgroundOutput(docWith(el));
  const ctx = fakeCtx();
  out.createOutput(ctx);
  out.play();
  await tick();
  assert.equal(out.routed, true);
});

test('pause by US does not report an external pause; pause by the OS does, once', () => {
  const el = fakeAudioElement();
  let external = 0;
  const out = createBackgroundOutput(docWith(el), { onExternalPause: () => external++ });
  out.createOutput(fakeCtx());
  out.play();
  out.pause();
  assert.equal(external, 0, 'our own pause was reported as the OS');
  out.play();
  el.systemPause();
  assert.equal(external, 1);
  el.systemPause(); // already not wanted
  assert.equal(external, 1);
});

test('ensurePlaying restarts the element only if we want to be playing and it is paused', () => {
  const el = fakeAudioElement();
  const out = createBackgroundOutput(docWith(el));
  out.createOutput(fakeCtx());
  out.ensurePlaying();
  assert.equal(el.plays, 0, 'not wanted yet');
  out.play();
  assert.equal(el.plays, 1);
  out.ensurePlaying();
  assert.equal(el.plays, 1, 'already playing');
  el.paused = true; // e.g. the OS stopped it while backgrounded without an event
  out.ensurePlaying();
  assert.equal(el.plays, 2);
  out.pause();
  out.ensurePlaying();
  assert.equal(el.plays, 2, 'paused on purpose stays paused');
});

test('dispose: pauses, clears srcObject, disconnects, removes its listener, and is idempotent', () => {
  const el = fakeAudioElement();
  let external = 0;
  const out = createBackgroundOutput(docWith(el), { onExternalPause: () => external++ });
  const ctx = fakeCtx();
  const bus = out.createOutput(ctx);
  out.play();
  out.dispose();
  out.dispose();
  assert.equal(el.srcObject, null);
  assert.ok(el.paused);
  assert.ok(bus.disconnects >= 1);
  assert.equal(el.listenerCount('pause'), 0);
  assert.equal(external, 0, 'dispose is not an external pause');
  out.play();
  assert.equal(el.plays, 1, 'no play after dispose');
});

// ═══ 2. audio session ════════════════════════════════════════════════════════

test("audioSession.type is set to 'playback' where it exists (Safari 16.4+)", () => {
  const nav = { audioSession: { type: 'auto' } };
  assert.equal(setPlaybackAudioSession(nav), true);
  assert.equal(nav.audioSession.type, 'playback');
});

test('audioSession absent / hostile: no throw, reports false', () => {
  assert.equal(setPlaybackAudioSession({}), false);
  assert.equal(setPlaybackAudioSession(null), false);
  const hostile = { audioSession: Object.defineProperty({}, 'type', { set() { throw new Error('no'); }, get: () => 'auto' }) };
  assert.equal(setPlaybackAudioSession(hostile), false);
});

// ═══ 3. media session ════════════════════════════════════════════════════════

function fakeMediaSession() {
  return {
    metadata: undefined,
    playbackState: 'none',
    handlers: {},
    positions: [],
    setActionHandler(a, h) {
      if (a === 'unknown-to-this-browser') throw new TypeError('bad action');
      this.handlers[a] = h;
    },
    setPositionState(s) {
      this.positions.push(s);
    },
  };
}
class FakeMeta {
  constructor(init) {
    Object.assign(this, init);
  }
}

function wire(overrides = {}) {
  const ms = fakeMediaSession();
  const calls = [];
  let clock = 0;
  let pos = 30;
  const w = wireMediaSession(
    { navigator: { mediaSession: ms }, MediaMetadata: FakeMeta },
    {
      title: 'My song.mp3',
      artist: 'stem-loops',
      artworkUrl: '/apple-touch-icon.png',
      onPlay: () => calls.push(['play']),
      onPause: () => calls.push(['pause']),
      onSeek: (t) => calls.push(['seek', t]),
      getPosition: () => pos,
      getDuration: () => 120,
      now: () => clock,
      ...overrides,
    },
  );
  return { ms, w, calls, setClock: (c) => (clock = c), setPos: (p) => (pos = p) };
}

test('media session: metadata (title, artist, artwork) is set for the lock screen', () => {
  const { ms } = wire();
  assert.ok(ms.metadata instanceof FakeMeta);
  assert.equal(ms.metadata.title, 'My song.mp3');
  assert.equal(ms.metadata.artist, 'stem-loops');
  assert.equal(ms.metadata.artwork[0].src, '/apple-touch-icon.png');
});

test('media session: every action is installed and routed to the transport callbacks', () => {
  const { ms, calls } = wire();
  for (const a of MEDIA_SESSION_ACTIONS) assert.equal(typeof ms.handlers[a], 'function', a);
  ms.handlers.play({});
  ms.handlers.pause({});
  ms.handlers.stop({});
  ms.handlers.seekto({ seekTime: 42.5 });
  ms.handlers.seekto({ seekTime: 999 }); // clamped to duration
  ms.handlers.seekto({}); // no time → ignored
  ms.handlers.seekbackward({});
  ms.handlers.seekforward({ seekOffset: 5 });
  ms.handlers.seekbackward({ seekOffset: 100 }); // clamped to 0
  assert.deepEqual(calls, [
    ['play'],
    ['pause'],
    ['pause'],
    ['seek', 42.5],
    ['seek', 120],
    ['seek', 30 - DEFAULT_SEEK_STEP_SEC],
    ['seek', 35],
    ['seek', 0],
  ]);
});

test('media session: playbackState and position state follow the engine snapshot', () => {
  const { ms, w } = wire();
  w.update({ status: 'ready', positionSec: 0, durationSec: 120 });
  assert.equal(ms.playbackState, 'paused');
  assert.deepEqual(ms.positions.at(-1), { duration: 120, position: 0, playbackRate: 1 });
  w.update({ status: 'playing', positionSec: 0, durationSec: 120 });
  assert.equal(ms.playbackState, 'playing');
  w.update({ status: 'loading', positionSec: 0, durationSec: 0 });
  assert.equal(ms.playbackState, 'none');
  assert.equal(ms.positions.at(-1), undefined, 'no duration → position state cleared');
});

test('media session: position pushes are throttled to status changes and real jumps (seek / loop wrap)', () => {
  const { ms, w, setClock } = wire();
  w.update({ status: 'playing', positionSec: 10, durationSec: 120 });
  const n = ms.positions.length;
  // steady playback: 60 frames over one second, position advancing with the clock
  for (let f = 1; f <= 60; f++) {
    setClock(f * (1000 / 60));
    w.update({ status: 'playing', positionSec: 10 + f / 60, durationSec: 120 });
  }
  assert.equal(ms.positions.length, n, 'steady playback must not push every frame');
  // a seek / loop wrap: the position jumps back
  setClock(1100);
  w.update({ status: 'playing', positionSec: 5, durationSec: 120 });
  assert.equal(ms.positions.length, n + 1);
  assert.equal(ms.positions.at(-1).position, 5);
  // a jump smaller than the drift threshold is not pushed
  setClock(1100);
  w.update({ status: 'playing', positionSec: 5 + POSITION_DRIFT_SEC / 2, durationSec: 120 });
  assert.equal(ms.positions.length, n + 1);
});

test('media session: position is clamped into [0, duration] (setPositionState throws otherwise)', () => {
  const { ms, w } = wire();
  w.update({ status: 'ended', positionSec: 120.0004, durationSec: 120 });
  assert.equal(ms.positions.at(-1).position, 120);
  assert.equal(ms.playbackState, 'paused');
});

test('media session: absent API → null, and an unknown action does not stop the others', () => {
  assert.equal(wireMediaSession({ navigator: {} }, {}), null);
  assert.equal(wireMediaSession(null, {}), null);
  const { ms } = wire();
  assert.doesNotThrow(() => ms.setActionHandler('play', null));
});

test('media session: dispose removes every handler, clears metadata and state; update after is a no-op', () => {
  const { ms, w } = wire();
  w.update({ status: 'playing', positionSec: 1, durationSec: 120 });
  w.dispose();
  for (const a of MEDIA_SESSION_ACTIONS) assert.equal(ms.handlers[a], null, a);
  assert.equal(ms.metadata, null);
  assert.equal(ms.playbackState, 'none');
  const n = ms.positions.length;
  w.update({ status: 'ready', positionSec: 1, durationSec: 120 });
  assert.equal(ms.positions.length, n);
});

test('playbackStateFor maps every engine status', () => {
  assert.equal(playbackStateFor('playing'), 'playing');
  assert.equal(playbackStateFor('ready'), 'paused');
  assert.equal(playbackStateFor('ended'), 'paused');
  for (const s of ['idle', 'loading', 'error']) assert.equal(playbackStateFor(s), 'none');
});

// ═══ 4. resume hooks ═════════════════════════════════════════════════════════

function target() {
  const l = {};
  return {
    visibilityState: 'visible',
    addEventListener(t, cb) {
      (l[t] ??= []).push(cb);
    },
    removeEventListener(t, cb) {
      l[t] = (l[t] ?? []).filter((x) => x !== cb);
    },
    fire(t) {
      for (const cb of l[t] ?? []) cb();
    },
    count: () => Object.values(l).reduce((n, a) => n + a.length, 0),
  };
}

test('resume hooks: visible again, pageshow, focus and any tap all resume; hidden does not', () => {
  const document = target();
  const window = target();
  let n = 0;
  const off = wireAudioResume({ document, window }, () => n++);
  for (const e of RESUME_DOC_EVENTS) document.fire(e);
  for (const e of RESUME_WIN_EVENTS) window.fire(e);
  assert.equal(n, RESUME_DOC_EVENTS.length + RESUME_WIN_EVENTS.length);
  document.visibilityState = 'hidden';
  document.fire('visibilitychange');
  assert.equal(n, RESUME_DOC_EVENTS.length + RESUME_WIN_EVENTS.length, 'going hidden is not a resume');
  off();
  off();
  assert.equal(document.count() + window.count(), 0, 'every listener removed');
});

test('resume hooks: no document / window is fine', () => {
  assert.doesNotThrow(() => wireAudioResume(null, () => {})());
  assert.doesNotThrow(() => wireAudioResume({}, () => {})());
});

// ═══ 1b. chord-clock compensation ════════════════════════════════════════════

test('routeLatencySec: 0 when not routed (desktop, or a route that fell back)', () => {
  assert.equal(routeLatencySec({ outputLatency: 0.04, baseLatency: 0.01 }, false), 0);
});

test('routeLatencySec: measured MediaStream hop + outputLatency, else baseLatency, else the hop alone', () => {
  assert.ok(ROUTE_TRANSPORT_LATENCY_SEC >= 0.01 && ROUTE_TRANSPORT_LATENCY_SEC <= 0.031, 'default within the measured 10-31 ms');
  assert.equal(routeLatencySec({ outputLatency: 0.032, baseLatency: 0.01 }, true), ROUTE_TRANSPORT_LATENCY_SEC + 0.032);
  assert.equal(routeLatencySec({ outputLatency: 0, baseLatency: 0.01 }, true), ROUTE_TRANSPORT_LATENCY_SEC + 0.01);
  assert.equal(routeLatencySec({ baseLatency: 0.01 }, true), ROUTE_TRANSPORT_LATENCY_SEC + 0.01);
  for (const src of [{}, null, undefined, { outputLatency: NaN, baseLatency: -1 }]) {
    assert.equal(routeLatencySec(src, true), ROUTE_TRANSPORT_LATENCY_SEC);
  }
  assert.equal(routeLatencySec({ outputLatency: 9 }, true), MAX_ROUTE_LATENCY_SEC, 'nonsense is capped');
});
