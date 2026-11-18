// Story 8 — the device rule (src/lib/play/device-support.ts).
//
// Until 2026-11-15 this rule BLOCKED phones (PR #276). Jon: the product must
// work on phones. The same rule now selects the LIGHT decode (24 kHz mono) and
// the background-capable output route; nothing is blocked except a browser
// with no Web Audio at all. These tests pin: the rule (unchanged matching),
// the sample-rate choice it drives, that the block card is gone, and that
// Player wires the profile into the engine.
//
// The rule is pure, so it is driven directly with signal objects, and through
// `readDeviceSignals` with fake browser globals shaped like what the Playwright
// device emulations report (Pixel 7, iPhone 14, desktop Chrome, a touch laptop).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { buildModuleGraph } from './helpers/module-graph.mjs';

import {
  LIGHT_AUDIO_NOTE,
  LIGHT_DECODE_SAMPLE_RATE,
  MIN_DEVICE_MEMORY_GB,
  constrainedReason as deviceBlockReason,
  playbackProfile,
  readDeviceSignals,
} from '../src/lib/play/device-support.ts';
import { PLAYBACK_SAMPLE_RATE } from '../src/lib/play/types.ts';

// ═══ the rule ════════════════════════════════════════════════════════════════

const DESKTOP = { coarsePointer: false, anyFinePointer: true, deviceMemoryGb: 8, maxTouchPoints: 0, screenShortSide: 900 };

test('desktop Chrome keeps the desktop path', () => {
  assert.equal(deviceBlockReason(DESKTOP), null);
});

test('a narrow desktop window is NOT light: viewport width is not a signal', () => {
  // readDeviceSignals never even reads innerWidth; a 360px desktop window has
  // the same signals as a full one.
  assert.equal(deviceBlockReason({ ...DESKTOP }), null);
  const src = readFileSync(new URL('../src/lib/play/device-support.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /innerWidth|userAgent\b(?!Data)/);
});

test('Chromium UA-CH mobile=true selects the light path with reason "mobile", whatever else is reported', () => {
  assert.equal(deviceBlockReason({ ...DESKTOP, uaDataMobile: true }), 'mobile');
});

test('a touch-only device (coarse primary pointer, no fine pointer anywhere) takes the light path', () => {
  assert.equal(
    deviceBlockReason({ coarsePointer: true, anyFinePointer: false, deviceMemoryGb: 8 }),
    'touch-only',
  );
});

test('a touch laptop (coarse primary, but a trackpad is a fine pointer) keeps the desktop path', () => {
  assert.equal(deviceBlockReason({ coarsePointer: true, anyFinePointer: true, deviceMemoryGb: 8 }), null);
});

test(`reported device memory below ${MIN_DEVICE_MEMORY_GB} GB selects the light path with reason "low-memory"`, () => {
  for (const gb of [0.25, 0.5, 1, 2]) {
    assert.equal(deviceBlockReason({ ...DESKTOP, deviceMemoryGb: gb }), 'low-memory', `${gb} GB`);
  }
  for (const gb of [4, 8]) assert.equal(deviceBlockReason({ ...DESKTOP, deviceMemoryGb: gb }), null, `${gb} GB`);
});

test('unknown signals never select the light path (no deviceMemory, no matchMedia, no touch)', () => {
  assert.equal(deviceBlockReason({}), null);
  assert.equal(deviceBlockReason(null), null);
  assert.equal(deviceBlockReason(undefined), null);
  assert.equal(deviceBlockReason({ ...DESKTOP, deviceMemoryGb: undefined }), null);
  assert.equal(deviceBlockReason({ ...DESKTOP, deviceMemoryGb: NaN }), null);
  assert.equal(deviceBlockReason({ ...DESKTOP, deviceMemoryGb: 0 }), null);
});

test('without matchMedia, the fallback needs BOTH touch and a phone-sized screen', () => {
  assert.equal(deviceBlockReason({ maxTouchPoints: 5, screenShortSide: 390 }), 'touch-only');
  assert.equal(deviceBlockReason({ maxTouchPoints: 5, screenShortSide: 800 }), null, 'touch tablet/laptop');
  assert.equal(deviceBlockReason({ maxTouchPoints: 0, screenShortSide: 390 }), null, 'small non-touch');
});

test('the fallback is not consulted when matchMedia answered', () => {
  assert.equal(
    deviceBlockReason({ coarsePointer: false, anyFinePointer: true, maxTouchPoints: 5, screenShortSide: 390 }),
    null,
  );
});

// ═══ reading the signals from a browser-shaped global ═══════════════════════

const fakeScope = ({ coarse, fine, mobile, memory, touch, screen }) => ({
  navigator: {
    ...(mobile === undefined ? {} : { userAgentData: { mobile } }),
    ...(memory === undefined ? {} : { deviceMemory: memory }),
    maxTouchPoints: touch,
  },
  matchMedia: (q) => ({
    matches: q === '(pointer: coarse)' ? coarse : q === '(any-pointer: fine)' ? fine : false,
  }),
  screen,
});

// What the Playwright emulations report (measured in this PR's harness; see
// docs/perf/mobile-player-2026-11-14.md). Emulation reports the HOST's
// deviceMemory, so the touch rule is what catches them, not memory.
test('Pixel 7 emulation takes the light path', () => {
  const s = readDeviceSignals(
    fakeScope({ coarse: true, fine: false, mobile: true, memory: 8, touch: 5, screen: { width: 412, height: 915 } }),
  );
  assert.equal(deviceBlockReason(s), 'mobile');
});

test('iPhone 14 (Safari: no UA-CH, no deviceMemory) takes the light path by the touch rule', () => {
  const s = readDeviceSignals(
    fakeScope({ coarse: true, fine: false, touch: 5, screen: { width: 390, height: 844 } }),
  );
  assert.equal(s.uaDataMobile, undefined);
  assert.equal(s.deviceMemoryGb, undefined);
  assert.equal(deviceBlockReason(s), 'touch-only');
});

test('desktop Chrome global keeps the desktop path', () => {
  const s = readDeviceSignals(
    fakeScope({ coarse: false, fine: true, mobile: false, memory: 8, touch: 0, screen: { width: 1920, height: 1080 } }),
  );
  assert.equal(deviceBlockReason(s), null);
});

test('readDeviceSignals survives a hostile or empty global', () => {
  assert.deepEqual(deviceBlockReason(readDeviceSignals(undefined)), null);
  assert.deepEqual(deviceBlockReason(readDeviceSignals({})), null);
  const throwing = { matchMedia: () => { throw new Error('nope'); }, navigator: { deviceMemory: 'lots' } };
  assert.equal(deviceBlockReason(readDeviceSignals(throwing)), null);
});



// ═══ the sample-rate choice the rule drives ═════════════════════════════════

test('the light decode is 22.05-24 kHz, and desktop keeps the 48 kHz path', () => {
  assert.ok(LIGHT_DECODE_SAMPLE_RATE >= 22050 && LIGHT_DECODE_SAMPLE_RATE <= 24000, String(LIGHT_DECODE_SAMPLE_RATE));
  assert.equal(PLAYBACK_SAMPLE_RATE, 48000);
});

test('playbackProfile: every constrained reason gets the light rate AND the background route', () => {
  for (const s of [
    { ...DESKTOP, uaDataMobile: true },
    { coarsePointer: true, anyFinePointer: false },
    { ...DESKTOP, deviceMemoryGb: 2 },
    { maxTouchPoints: 5, screenShortSide: 390 },
  ]) {
    const p = playbackProfile(s);
    assert.notEqual(p.reason, null, JSON.stringify(s));
    assert.equal(p.decodeSampleRate, LIGHT_DECODE_SAMPLE_RATE);
    assert.equal(p.backgroundOutput, true);
  }
});

test('playbackProfile: desktop, a touch laptop and unknown signals keep 48 kHz and ctx.destination', () => {
  for (const s of [DESKTOP, { coarsePointer: true, anyFinePointer: true, deviceMemoryGb: 8 }, {}, null, undefined]) {
    assert.deepEqual(playbackProfile(s), { reason: null, decodeSampleRate: PLAYBACK_SAMPLE_RATE, backgroundOutput: false });
  }
});

test('the light rate is what the engine actually decodes at (context created at that rate)', async () => {
  const { createPlayEngine } = await import('../src/lib/play/engine.ts');
  const rates = [];
  const engine = createPlayEngine({
    decodeSampleRate: playbackProfile({ coarsePointer: true, anyFinePointer: false }).decodeSampleRate,
    createAudioContext: ({ sampleRate }) => {
      rates.push(sampleRate);
      throw new Error('stop here');
    },
  });
  await engine.load([{ name: 'drums', bytes: new ArrayBuffer(8) }]);
  // first the light rate; refused, so ONE retry at the desktop rate — never "no audio" for a rate refusal
  assert.deepEqual(rates, [LIGHT_DECODE_SAMPLE_RATE, PLAYBACK_SAMPLE_RATE]);
  assert.equal(engine.getSnapshot().error?.code, 'PLAY_NO_AUDIO');
});

// ═══ copy ═══════════════════════════════════════════════════════════════════

test('the light-audio note says what changed, and makes no memory or device-size claim', () => {
  assert.match(LIGHT_AUDIO_NOTE, /mono, 24 kHz/);
  assert.ok(LIGHT_AUDIO_NOTE.includes(String(LIGHT_DECODE_SAMPLE_RATE / 1000)), 'rate in the copy matches the constant');
  assert.doesNotMatch(LIGHT_AUDIO_NOTE, /\bMB\b|\bGB\b|700|desktop|laptop|not supported|for now/i);
  assert.doesNotMatch(LIGHT_AUDIO_NOTE, /!|\b(click|hover|on our side)\b/i);
});

test('the old block copy is gone from the module, and so is ?player=force', () => {
  const src = read('src/lib/play/device-support.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(src, /DEVICE_UNSUPPORTED|needs a desktop or laptop|700 MB|playerForced|FORCE_PLAYER/);
  const player = read('src/components/play/Player.tsx').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(player, /device-unsupported|DeviceUnsupported|playerForced|location\?\.search/);
});

// ═══ rendering ══════════════════════════════════════════════════════════════

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src, jsx = false) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}) },
  }).outputText;
// The real module graph from Player.tsx (test/helpers/module-graph.mjs); the
// chord overlay, the mixer, the transport and the strip are stubbed BY PATH so
// the markup says which mounted, and nothing else is.
const comp = (name) => `import { createElement } from 'react'; const C = () => createElement('div', { 'data-testid': '${name.toLowerCase()}' }); export default C; export const ${name} = C;`;
const graph = buildModuleGraph({
  name: 'play-device',
  entries: ['components/play/Player.tsx'],
  overrides: {
    'components/ChordOverlay.tsx': `import { createElement } from 'react'; export const ChordOverlay = () => createElement('div', { 'data-testid': 'chord-overlay' });`,
    'lib/play/report-failure.ts': 'export function reportStemFetchFailure() {}',
    'components/play/Mixer.tsx': comp('Mixer'),
    'components/play/Transport.tsx': comp('Transport'),
    'components/play/SectionLoop.tsx': comp('SectionLoop'),
  },
});

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const Player = await import(graph.url('components/play/Player.tsx'));
const noop = () => {};
const IDLE = { status: 'idle', positionSec: 0, durationSec: 0, stems: [], loop: null, degraded: null, error: null };
const READY = { ...IDLE, status: 'ready', durationSec: 120 };
const view = (phase, extra = {}) =>
  renderToStaticMarkup(
    React.createElement(Player.PlayerView, {
      jobId: 'job-1', phase, snapshot: phase.kind === 'ready' ? READY : IDLE, sections: [], ...extra,
      onPlay: noop, onPause: noop, onSeek: noop, onGain: noop, onMute: noop, onSolo: noop, onLoop: noop,
    }),
  );
const decode = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');


test('the light path renders the one-time hint above a working player; desktop does not', () => {
  // Slice 1a (design v1.4 P1.1/P1.5, copy rules): the notice bar carries a short
  // hint with no implementation names; LIGHT_AUDIO_NOTE itself moved to Song info
  // (test/play-player-screen.test.mjs opens it there).
  const light = decode(view({ kind: 'ready' }, { lightAudio: true }));
  assert.equal(Player.LIGHT_AUDIO_HINT, 'Phones get lighter audio so all six stems fit. Details in Song info.');
  assert.ok(light.includes(Player.LIGHT_AUDIO_HINT));
  assert.doesNotMatch(light, /mono|24 kHz|kHz/, 'no implementation names in the hint');
  assert.match(light, /data-testid="player-light-audio"/);
  assert.match(light, /data-testid="transport"/, 'the player itself is there');
  assert.match(light, /data-testid="mixer"/);
  assert.doesNotMatch(light, /role="alert"/, 'a note, not an error');
  const desktop = decode(view({ kind: 'ready' }));
  assert.doesNotMatch(desktop, /player-light-audio/);
  assert.match(desktop, /data-testid="transport"/);
});

test('the note is not shown before the player is playable (loading, errors)', () => {
  for (const phase of [{ kind: 'idle' }, { kind: 'loading' }, { kind: 'no-stems' }, { kind: 'load-error', message: 'x' }]) {
    assert.doesNotMatch(view(phase, { lightAudio: true }), /player-light-audio/, phase.kind);
  }
});

test('no phase renders a device block any more', () => {
  for (const phase of [{ kind: 'idle' }, { kind: 'loading' }, { kind: 'ready' }, { kind: 'no-stems' }]) {
    assert.doesNotMatch(view(phase, { lightAudio: true }), /device-unsupported|desktop or laptop/, phase.kind);
  }
});

test('Player: Web Audio check first, then the profile feeds the engine its rate and output', () => {
  const src = read('src/components/play/Player.tsx').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const effect = src.slice(src.indexOf('useEffect(() => {'));
  const iWebAudio = effect.indexOf('hasWebAudio(');
  const iProfile = effect.indexOf('playbackProfile(readDeviceSignals(globalThis))');
  const iEngine = effect.indexOf('createPlayEngine(');
  assert.ok(iWebAudio > 0 && iProfile > iWebAudio && iEngine > iProfile, `order ${iWebAudio} ${iProfile} ${iEngine}`);
  const engineCall = effect.slice(iEngine, effect.indexOf('});', iEngine));
  assert.match(engineCall, /decodeSampleRate: profile\.decodeSampleRate/);
  assert.match(engineCall, /createOutput: output\.createOutput/);
  assert.match(effect.slice(iProfile, iEngine), /profile\.backgroundOutput\s*\?\s*createBackgroundOutput\(/);
});

test('the removed device-state CSS left no dead selectors behind', () => {
  const css = read('src/components/play/Player.module.css');
  assert.doesNotMatch(css, /\.device(Title|Body|Actions|Button|CopyState)?\s*\{/);
});
