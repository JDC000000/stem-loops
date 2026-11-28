// Count-in through the REAL Player (#387): the load effect, the transport
// callbacks and the count wiring all run; only the engine, the phone output
// route, the stem loader and the device probe are fakes (Node has no Web
// Audio, no <audio> and no network). What this pins that PlayerView tests
// cannot: the callbacks Player builds (onPrime / onUnprime / getEngineLatencySec)
// against an engine whose state the test controls.
//
//   - I-3: the un-prime guard, behaviourally (it used to be a source pattern):
//     a count cancelled while the engine is PLAYING (lock-screen Play mid-count)
//     must not pause the phone's <audio> element; cancelled while paused it must.
//   - F5 + stretch: at 75% the count runs at the slowed tempo AND play() is
//     called early by the engine's stretch latency on top of the route latency.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildModuleGraph } from './helpers/module-graph.mjs';
import { withDom } from './helpers/dom.mjs';
import { COUNT_IN_KEY, COUNT_PENDING_RATE_KEY, CLICK_LEAD_SEC, ENGINE_LEAD_SEC } from '../src/lib/play/count-in.ts';

const graph = buildModuleGraph({
  name: 'play-count-in-player',
  entries: ['components/play/Player.tsx'],
  overrides: {
    'components/ChordOverlay.tsx': `import { createElement } from 'react';
      export const ChordOverlay = () => createElement('div', { 'data-testid': 'chord-overlay' });
      export default ChordOverlay;`,
    'lib/play/report-failure.ts': 'export function reportStemFetchFailure() {}',
    // The engine: state and calls live on globalThis.__countRig (set per test).
    'lib/play/engine.ts': `
      export const PLAYBACK_RATES = [1, 0.9, 0.75];
      export const isPlaybackRate = (r) => PLAYBACK_RATES.includes(r);
      export function createPlayEngine() { return globalThis.__countRig.makeEngine(); }`,
    'lib/play/load-stems.ts': `
      export class StemLoadError extends Error {}
      export async function loadStems() { return { sources: [{ name: 'drums', bytes: new ArrayBuffer(8) }], stemFailures: [] }; }
      export function zeroSourceReason() { return null; }`,
    // The phone: the <audio> output route is taken.
    'lib/play/device-support.ts': `
      export const LIGHT_AUDIO_NOTE = 'Lighter audio on this device.';
      export function readDeviceSignals() { return {}; }
      export function playbackProfile() { return { backgroundOutput: true, decodeSampleRate: 24000, reason: 'mobile' }; }`,
    'lib/play/background-audio.ts': `
      export function createBackgroundOutput() {
        const rig = globalThis.__countRig;
        return {
          routed: true,
          createOutput: () => ({}),
          play() { rig.calls.push('element.play'); },
          pause() { rig.calls.push('element.pause'); },
          ensurePlaying() {},
          dispose() {},
        };
      }
      export function routeLatencySec(src, routed) { return routed ? globalThis.__countRig.routeSec : 0; }
      export function setPlaybackAudioSession() { return true; }
      export function wireAudioResume() { return () => {}; }
      export function wireMediaSession() { return null; }`,
  },
});
const React = (await import('react')).default;
const Player = (await import(graph.url('components/play/Player.tsx'))).default;

const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const LOOPS = [
  { stem: 'drums', section: 'intro', start_sec: 0, end_sec: 9, bpm: 120 },
  { stem: 'drums', section: 'verse', start_sec: 9, end_sec: 47, bpm: 120 },
];

function makeRig({ rate = 1, stretchSec = 0, routeSec = 0, pending = null } = {}) {
  const rig = {
    calls: [],
    playedAt: [],
    routeSec,
    engine: null,
    makeEngine() {
      const subs = new Set();
      let snap = {
        status: 'idle', positionSec: 0, durationSec: 120, loop: null, degraded: null, error: null, playbackRate: rate,
        ...(pending ? { speedPending: true, pendingRate: pending } : {}),
        stems: STEMS.map((name) => ({ name, availability: 'ready', gain: 0.8, muted: false, soloed: false, effectivelySilent: false })),
      };
      const set = (over) => { snap = { ...snap, ...over }; for (const f of subs) f(snap); };
      const e = {
        canChangeSpeed: true,
        getSnapshot: () => snap,
        subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
        async load() { set({ status: 'ready' }); },
        play() { rig.calls.push('engine.play'); rig.playedAt.push(Date.now()); set({ status: 'playing' }); },
        pause() { rig.calls.push('engine.pause'); set({ status: 'ready' }); },
        seek(t) { rig.calls.push(`seek ${t}`); set({ positionSec: t }); },
        setGain() {}, setMute() {}, setSolo() {}, setLoop() {}, setPlaybackRate() {}, resumeAudio() {},
        audioLatency: () => ({ outputLatency: 0, baseLatency: 0 }),
        stretchLatencySec: () => stretchSec,
        onAudioStateChange: () => () => {},
        dispose() {},
        /** Test hook: something outside the count (the lock screen) starts playback. */
        externalPlay() { set({ status: 'playing' }); },
      };
      rig.engine = e;
      return e;
    },
  };
  return rig;
}

class SilentCtx {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createOscillator() { return { frequency: {}, connect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
}

async function mountPlayer(dom, rig, bpm) {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.__countRig = rig;
  globalThis.AudioContext = SilentCtx; // hasWebAudio() + a silent click context
  globalThis.localStorage.setItem(COUNT_IN_KEY, '1');
  await dom.mount(React.createElement(Player, { jobId: 'job-387', loops: LOOPS, title: 'Lucky Ticket', bpm, musicalKey: null }));
  for (let i = 0; i < 20 && rig.engine?.getSnapshot().status !== 'ready'; i += 1) await dom.advance(1);
  assert.equal(rig.engine.getSnapshot().status, 'ready', 'loaded');
}
async function cleanup(dom) {
  await dom.unmountAll();
  globalThis.localStorage.removeItem(COUNT_IN_KEY);
  delete globalThis.__countRig;
  delete globalThis.AudioContext;
}
const countNum = (dom) => dom.find('[data-testid="count-in"]')?.getAttribute('data-beat') ?? null;

test('I-3: a count cancelled while the engine is PLAYING leaves the <audio> element playing (behavioural, real Player)', async () => {
  await withDom(async (dom) => {
    const rig = makeRig();
    await mountPlayer(dom, rig, 120);
    rig.calls.length = 0;
    await dom.act(() => dom.find('[data-testid="transport-play"]').click());
    assert.equal(countNum(dom), '4');
    assert.ok(rig.calls.includes('element.play'), `primed: ${rig.calls}`);
    // The lock screen starts the music mid-count; then the user taps elsewhere.
    rig.engine.externalPlay();
    rig.calls.length = 0;
    await dom.pointer('pointerdown', dom.find('[data-testid="player-title"]'), { pointerType: 'touch', clientX: 1, clientY: 1 });
    assert.equal(countNum(dom), null, 'cancelled');
    assert.ok(!rig.calls.includes('element.pause'), `the playing music's element is never paused by the un-prime: ${rig.calls}`);
    await cleanup(dom);
  });
});

test('I-3: a count cancelled while the engine is paused DOES stop the silent element it primed', async () => {
  await withDom(async (dom) => {
    const rig = makeRig();
    await mountPlayer(dom, rig, 120);
    await dom.act(() => dom.find('[data-testid="transport-play"]').click());
    assert.equal(countNum(dom), '4');
    rig.calls.length = 0;
    await dom.pointer('pointerdown', dom.find('[data-testid="player-title"]'), { pointerType: 'touch', clientX: 1, clientY: 1 });
    assert.equal(countNum(dom), null);
    assert.deepEqual(rig.calls.filter((c) => c === 'element.pause'), ['element.pause']);
    assert.ok(!rig.calls.includes('engine.play'), 'and the music never started');
    await cleanup(dom);
  });
});

test('#387: at 75% the real Player counts at the slowed tempo and calls play() early by route + stretch latency', async () => {
  await withDom(async (dom) => {
    const ROUTE = 0.2;
    const STRETCH = 0.121;
    const rig = makeRig({ rate: 0.75, stretchSec: STRETCH, routeSec: ROUTE });
    await mountPlayer(dom, rig, 240);
    const t0 = Date.now();
    await dom.act(() => dom.find('[data-testid="transport-play"]').click());
    assert.equal(countNum(dom), '4');
    rig.playedAt.length = 0; // drop the prime's play/pause
    // 240 BPM at 75% = 180 BPM: 4 beats = 1333.3 ms. The click context reads 0
    // latency (no outputLatency on the fake), so play() is due at
    // 1333.3 + (CLICK_LEAD - ENGINE_LEAD - ROUTE - STRETCH) * 1000 = 992.3 ms.
    const due = 4 * (60 / 180) * 1000 + (CLICK_LEAD_SEC - ENGINE_LEAD_SEC - ROUTE - STRETCH) * 1000;
    assert.ok(Math.abs(due - 992.33) < 0.01);
    // dom.advance() waits REAL time (the screen's count uses real timers), so the
    // call time is measured with a tolerance. The wrong answers are far outside it:
    // without the stretch term play() comes at 1113 ms (+121), at the full tempo
    // at 671 ms (-321), with neither latency at 1313 ms.
    await dom.advance(1500);
    assert.equal(rig.playedAt.length, 1, 'played once');
    const at = rig.playedAt[0] - t0;
    assert.ok(at >= due - 5 && at <= due + 60, `play() at ${at} ms, due ${due.toFixed(1)} ms`);
    await cleanup(dom);
  });
});

// #448: 75% tapped, then Play before the stretch nodes run (snapshot: playbackRate 1,
// speedPending, pendingRate 0.75). The fake engine's stretchLatencySec() stands for
// the real one under each flag state (engine side pinned in play-slowdown.test.mjs).
for (const flag of [false, true]) {
  test(`#448 flag ${flag ? 'ON' : 'OFF (default)'}: pending 75% at 240 BPM: ${flag ? 'the count runs at 75% and play() is early by the pending latency' : 'old behaviour, the count runs at 100%'}`, async () => {
    await withDom(async (dom) => {
      const STRETCH = 0.121;
      const rig = makeRig({ rate: 1, pending: 0.75, stretchSec: flag ? STRETCH : 0, routeSec: 0 });
      if (flag) globalThis.localStorage.setItem(COUNT_PENDING_RATE_KEY, '1');
      else globalThis.localStorage.removeItem(COUNT_PENDING_RATE_KEY);
      try {
        await mountPlayer(dom, rig, 240);
        const t0 = Date.now();
        await dom.act(() => dom.find('[data-testid="transport-play"]').click());
        assert.equal(countNum(dom), '4');
        rig.playedAt.length = 0;
        // OFF: 4 beats at 240 BPM = 1000 ms; ON: at 180 BPM = 1333.3 ms, minus the stretch latency.
        const bar = flag ? 4 * (60 / 180) * 1000 : 1000;
        const due = bar + (CLICK_LEAD_SEC - ENGINE_LEAD_SEC - (flag ? STRETCH : 0)) * 1000;
        await dom.advance(1500);
        assert.equal(rig.playedAt.length, 1, 'played once');
        const at = rig.playedAt[0] - t0;
        assert.ok(at >= due - 5 && at <= due + 60, `play() at ${at} ms, due ${due.toFixed(1)} ms`);
      } finally {
        globalThis.localStorage.removeItem(COUNT_PENDING_RATE_KEY);
        await cleanup(dom);
      }
    });
  });
}
