// Story 8.3 — the device rule (src/lib/play/device-support.ts) and the
// rendering of the designed "not on this device yet" state in Player.
//
// The rule is pure, so it is driven directly with signal objects, and through
// `readDeviceSignals` with fake browser globals shaped like what the Playwright
// device emulations report (Pixel 7, iPhone 14, desktop Chrome, a touch laptop).
// The rendering half reuses the transpile-and-server-render harness that
// test/play-player.test.mjs uses (no jsdom; React effects do not run), driving
// `PlayerView` and `DeviceUnsupported` directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  DEVICE_UNSUPPORTED_BODY,
  DEVICE_UNSUPPORTED_STILL_WORKS,
  DEVICE_UNSUPPORTED_TITLE,
  COPY_LINK_LABEL,
  MIN_DEVICE_MEMORY_GB,
  deviceBlockReason,
  playerForced,
  readDeviceSignals,
} from '../src/lib/play/device-support.ts';

// ═══ the rule ════════════════════════════════════════════════════════════════

const DESKTOP = { coarsePointer: false, anyFinePointer: true, deviceMemoryGb: 8, maxTouchPoints: 0, screenShortSide: 900 };

test('desktop Chrome is offered the player', () => {
  assert.equal(deviceBlockReason(DESKTOP), null);
});

test('a narrow desktop window is NOT blocked: viewport width is not a signal', () => {
  // readDeviceSignals never even reads innerWidth; a 360px desktop window has
  // the same signals as a full one.
  assert.equal(deviceBlockReason({ ...DESKTOP }), null);
  const src = readFileSync(new URL('../src/lib/play/device-support.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /innerWidth|userAgent\b(?!Data)/);
});

test('Chromium UA-CH mobile=true blocks with reason "mobile", whatever else is reported', () => {
  assert.equal(deviceBlockReason({ ...DESKTOP, uaDataMobile: true }), 'mobile');
});

test('a touch-only device (coarse primary pointer, no fine pointer anywhere) is blocked', () => {
  assert.equal(
    deviceBlockReason({ coarsePointer: true, anyFinePointer: false, deviceMemoryGb: 8 }),
    'touch-only',
  );
});

test('a touch laptop (coarse primary, but a trackpad is a fine pointer) is offered the player', () => {
  assert.equal(deviceBlockReason({ coarsePointer: true, anyFinePointer: true, deviceMemoryGb: 8 }), null);
});

test(`reported device memory below ${MIN_DEVICE_MEMORY_GB} GB blocks with reason "low-memory"`, () => {
  for (const gb of [0.25, 0.5, 1, 2]) {
    assert.equal(deviceBlockReason({ ...DESKTOP, deviceMemoryGb: gb }), 'low-memory', `${gb} GB`);
  }
  for (const gb of [4, 8]) assert.equal(deviceBlockReason({ ...DESKTOP, deviceMemoryGb: gb }), null, `${gb} GB`);
});

test('unknown signals never block (no deviceMemory, no matchMedia, no touch)', () => {
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
test('Pixel 7 emulation is blocked', () => {
  const s = readDeviceSignals(
    fakeScope({ coarse: true, fine: false, mobile: true, memory: 8, touch: 5, screen: { width: 412, height: 915 } }),
  );
  assert.equal(deviceBlockReason(s), 'mobile');
});

test('iPhone 14 (Safari: no UA-CH, no deviceMemory) is blocked by the touch rule', () => {
  const s = readDeviceSignals(
    fakeScope({ coarse: true, fine: false, touch: 5, screen: { width: 390, height: 844 } }),
  );
  assert.equal(s.uaDataMobile, undefined);
  assert.equal(s.deviceMemoryGb, undefined);
  assert.equal(deviceBlockReason(s), 'touch-only');
});

test('desktop Chrome global is offered the player', () => {
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

test('?player=force is the only override, and only with that exact value', () => {
  assert.equal(playerForced('?player=force'), true);
  assert.equal(playerForced('?a=1&player=force'), true);
  assert.equal(playerForced('?player=1'), false);
  assert.equal(playerForced('?player=FORCE'), false);
  assert.equal(playerForced(''), false);
  assert.equal(playerForced(undefined), false);
});

// ═══ copy (brand book v2.2 §3) ══════════════════════════════════════════════

const ALL_COPY = [DEVICE_UNSUPPORTED_TITLE, DEVICE_UNSUPPORTED_STILL_WORKS, COPY_LINK_LABEL, ...Object.values(DEVICE_UNSUPPORTED_BODY)];

test('the device copy names Chrome on a desktop or laptop as the next step, for every reason', () => {
  for (const [reason, body] of Object.entries(DEVICE_UNSUPPORTED_BODY)) {
    assert.match(body, /Chrome on a desktop or laptop/, reason);
  }
  assert.match(DEVICE_UNSUPPORTED_TITLE, /desktop or laptop for now/);
});

test('the device copy follows the brand rules: no hype, no "click"/"hover", no "coming soon", no all caps', () => {
  for (const s of ALL_COPY) {
    assert.doesNotMatch(s, /!/, s);
    assert.doesNotMatch(s, /\b(click|hover|coming soon|on our side|unsupported|log in)\b/i, s);
    assert.doesNotMatch(s, /\b[A-Z]{4,}\b/, s);
    // "play-along" is the adjective only; the title uses the noun.
    assert.doesNotMatch(s, /Play-along needs/, s);
  }
});

test('the device copy does not reuse the tab-capture wording', () => {
  for (const s of ALL_COPY) {
    for (const w of ['tab capture', 'tab-audio', 'tab audio', 'screen capture', 'chord overlay', 'Edge']) {
      assert.ok(!s.toLowerCase().includes(w.toLowerCase()), `${w} in ${s}`);
    }
  }
});

test('the heading is at most 10 words (errors context, brand book §3.4)', () => {
  assert.ok(DEVICE_UNSUPPORTED_TITLE.split(/\s+/).length <= 10);
});

// ═══ rendering ══════════════════════════════════════════════════════════════

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src, jsx = false) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}) },
  }).outputText;
const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'play-device-'));
const put = (name, code) => (writeFileSync(join(dir, name), code), './' + name);

const typesMod = put('types.mjs', toJs(read('src/lib/play/types.ts')));
const cssMod = put('styles.mjs', 'export default new Proxy({}, { get: (_t, k) => (typeof k === "string" ? k : undefined) });');
const deviceMod = put('device-support.mjs', toJs(read('src/lib/play/device-support.ts')));
const sectionsMod = put('sections.mjs', toJs(read('src/lib/play/sections.ts')).replace(/from ['"]\.\/types['"]/g, `from '${typesMod}'`));
const shared = (js) =>
  js
    .replace(/from ['"]@\/lib\/play\/types['"]/g, `from '${typesMod}'`)
    .replace(/from ['"]@\/lib\/play\/sections['"]/g, `from '${sectionsMod}'`)
    .replace(/from ['"]@\/lib\/play\/device-support['"]/g, `from '${deviceMod}'`)
    .replace(/from ['"][^'"]*\.module\.css['"]/g, `from '${cssMod}'`);
const stub = (name, body) => put(name, body);
const chordMod = stub('chord.mjs', `import { createElement } from 'react'; export const ChordOverlay = () => createElement('div', { 'data-testid': 'chord-overlay' });`);
const compMod = (name) => stub(`${name}.mjs`, `import { createElement } from 'react'; const C = () => createElement('div', { 'data-testid': '${name.toLowerCase()}' }); export default C; export const ${name} = C;`);
const engineMod = put('engine.mjs', toJs(read('src/lib/play/engine.ts')).replace(/from ['"]\.\/types\.ts['"]/g, `from '${typesMod}'`));
const loadMod = put('load-stems.mjs', toJs(read('src/lib/play/load-stems.ts')).replace(/from ['"]\.\/types\.ts['"]/g, `from '${typesMod}'`));
const reportMod = stub('report.mjs', 'export function reportStemFetchFailure() {}');
writeFileSync(
  join(dir, 'Player.mjs'),
  shared(toJs(read('src/components/play/Player.tsx'), true))
    .replace(/from ['"]@\/components\/ChordOverlay['"]/g, `from '${chordMod}'`)
    .replace(/from ['"]@\/lib\/play\/engine['"]/g, `from '${engineMod}'`)
    .replace(/from ['"]@\/lib\/play\/load-stems['"]/g, `from '${loadMod}'`)
    .replace(/from ['"]@\/lib\/play\/report-failure['"]/g, `from '${reportMod}'`)
    .replace(/from ['"]\.\/Mixer['"]/g, `from '${compMod('Mixer')}'`)
    .replace(/from ['"]\.\/Transport['"]/g, `from '${compMod('Transport')}'`)
    .replace(/from ['"]\.\/SectionLoop['"]/g, `from '${compMod('SectionLoop')}'`),
);

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const Player = await import(pathToFileURL(join(dir, 'Player.mjs')).href);
const noop = () => {};
const IDLE = { status: 'idle', positionSec: 0, durationSec: 0, stems: [], loop: null, degraded: null, error: null };
const view = (phase) =>
  renderToStaticMarkup(
    React.createElement(Player.PlayerView, {
      jobId: 'job-1', phase, snapshot: IDLE, sections: [],
      onPlay: noop, onPause: noop, onSeek: noop, onGain: noop, onMute: noop, onSolo: noop, onLoop: noop,
    }),
  );
const decode = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

for (const reason of ['mobile', 'touch-only', 'low-memory']) {
  test(`phase device-unsupported (${reason}) renders the designed state, the chord track, and no player controls`, () => {
    const html = decode(view({ kind: 'device-unsupported', reason }));
    assert.match(html, /data-phase="device-unsupported"/);
    assert.match(html, new RegExp(`data-testid="player-device-unsupported" data-reason="${reason}"`));
    assert.ok(html.includes(DEVICE_UNSUPPORTED_TITLE), 'title');
    assert.ok(html.includes(DEVICE_UNSUPPORTED_BODY[reason]), 'reason-specific body');
    assert.ok(html.includes(DEVICE_UNSUPPORTED_STILL_WORKS), 'what still works');
    assert.match(html, /data-testid="player-copy-link"[^>]*>Copy the link</);
    assert.match(html, /<h2[^>]*>Play along needs a desktop or laptop for now<\/h2>/, 'a real heading');
    assert.match(html, /data-testid="chord-overlay"/, 'chord track stays mounted');
    for (const id of ['transport', 'mixer', 'sectionloop', 'player-banner', 'player-retry']) {
      assert.doesNotMatch(html, new RegExp(`data-testid="${id}"`), `${id} must not render`);
    }
    // Not an alarm: status, not alert.
    assert.doesNotMatch(html, /role="alert"/);
  });
}

test('other phases never render the device state', () => {
  for (const phase of [{ kind: 'idle' }, { kind: 'loading' }, { kind: 'no-stems' }, { kind: 'unsupported', message: 'x' }]) {
    assert.doesNotMatch(view(phase), /player-device-unsupported/, phase.kind);
  }
});

test('a device-unsupported phase is not playable and gives the chord track no position', () => {
  const phase = { kind: 'device-unsupported', reason: 'mobile' };
  assert.equal(Player.isPlayable(phase, IDLE), false);
  assert.equal(Player.chordPositionFor(phase, IDLE), null);
});

test('Player checks the device BEFORE creating an engine, after the Web Audio check, and honours ?player=force', () => {
  const src = read('src/components/play/Player.tsx').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const effect = src.slice(src.indexOf('useEffect(() => {'));
  const iWebAudio = effect.indexOf('hasWebAudio(');
  const iDevice = effect.indexOf('deviceBlockReason(readDeviceSignals(');
  const iEngine = effect.indexOf('createPlayEngine(');
  assert.ok(iWebAudio > 0 && iDevice > iWebAudio && iEngine > iDevice, `order ${iWebAudio} ${iDevice} ${iEngine}`);
  assert.match(effect.slice(iWebAudio, iEngine), /playerForced\(globalThis\.location\?\.search\)/);
  assert.match(effect.slice(iDevice, iEngine), /setPhase\(\{ kind: 'device-unsupported', reason: blocked \}\);\s*return;/);
});

test('the CSS gives the copy button a 44px touch target and text at or above the 11px floor', () => {
  const css = read('src/components/play/Player.module.css');
  const block = (sel) => css.slice(css.indexOf(`.${sel} {`), css.indexOf('}', css.indexOf(`.${sel} {`)));
  assert.match(block('deviceButton'), /min-height: var\(--touch-min, 44px\)/);
  for (const sel of ['deviceTitle', 'deviceBody', 'deviceButton', 'deviceCopyState']) {
    assert.doesNotMatch(block(sel), /--text-(xs|sm)\b/, `${sel} uses a size below the body floor`);
  }
});
