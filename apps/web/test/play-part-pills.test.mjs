// "My part" pills (Phase A D5): src/lib/play/part-pills.ts. The DOM behaviour
// (tap, long-press, S, disabled, the Mix label) is in play-player-screen.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOW_GAIN, PILL_LONG_PRESS_MS, PILL_SLOP_PX, PILL_SHORT, PILL_STEMS, applyOps, audible, longPressOps, pillStems, pillView, tapOps,
} from '../src/lib/play/part-pills.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const stem = (name, over = {}) => ({ name, availability: 'ready', gain: 1, muted: false, soloed: false, effectivelySilent: false, ...over });
const NAMES = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const mix = (over = {}) => NAMES.map((n) => stem(n, over[n]));

test('Jon\'s order: Guitar · Bass · Keys · Drums · Vocals, then Other; short visible names', () => {
  assert.deepEqual([...PILL_STEMS], ['guitar', 'bass', 'keys', 'drums', 'vocals', 'other']);
  assert.deepEqual(PILL_STEMS.map((s) => PILL_SHORT[s]), ['Gtr', 'Bass', 'Keys', 'Drums', 'Vox', 'Other']);
  assert.equal(LOW_GAIN, 0.3);
});

test('the long-press is 500 ms and a 10 px move cancels it (pinned)', () => {
  assert.equal(PILL_LONG_PRESS_MS, 500);
  assert.equal(PILL_SLOP_PX, 10);
});

test('a tap cycles 100% -> 30% -> muted -> 100%, and comes home in three taps from anywhere', () => {
  let m = mix();
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    const g = m.find((x) => x.name === 'guitar');
    m = applyOps(m, tapOps(g, m));
    seen.push(pillView(m.find((x) => x.name === 'guitar'), false).state);
  }
  assert.deepEqual(seen, ['30%', 'muted', '100%', '30%', 'muted', '100%']);
  // A fader level in between counts as lowered: the next tap mutes.
  assert.deepEqual(tapOps(stem('bass', { gain: 0.55 }), mix()), [{ stem: 'bass', muted: true }]);
  // Unmuting from a low level goes straight to 100%: ONE op, applied gain then unmute.
  assert.deepEqual(tapOps(stem('bass', { gain: 0.3, muted: true }), mix()), [{ stem: 'bass', gain: 1, muted: false }]);
  assert.deepEqual(tapOps(stem('bass', { gain: 1, muted: true }), mix()), [{ stem: 'bass', muted: false }]);
  // 99.6% rounds to 100%, as the fader shows it: it is full.
  assert.deepEqual(tapOps(stem('bass', { gain: 0.996 }), mix()), [{ stem: 'bass', gain: 0.3 }]);
});

test('no op is ever a seek, a play or a restart: only gain, mute and solo', () => {
  for (const s of [stem('guitar'), stem('guitar', { gain: 0.3 }), stem('guitar', { muted: true }), stem('guitar', { soloed: true })]) {
    for (const op of [...tapOps(s), ...longPressOps(s)]) {
      assert.deepEqual(Object.keys(op).filter((k) => k !== 'stem').every((k) => ['gain', 'muted', 'soloed'].includes(k)), true, JSON.stringify(op));
    }
  }
});

test('a long-press solos; again un-solos; a solo is unmuted and at 100%', () => {
  assert.deepEqual(longPressOps(stem('guitar')), [{ stem: 'guitar', soloed: true }]);
  assert.deepEqual(longPressOps(stem('guitar', { soloed: true })), [{ stem: 'guitar', soloed: false }]);
  assert.deepEqual(longPressOps(stem('guitar', { muted: true, gain: 0.3 })), [{ stem: 'guitar', soloed: true, gain: 1, muted: false }]);
});

test('H1/M2: while a solo is on, a tap ends it and changes no level or mute', () => {
  const m = mix({ guitar: { soloed: true }, drums: { gain: 0.3 } });
  assert.deepEqual(tapOps(m[2], m), [{ stem: 'guitar', soloed: false }], 'soloed pill: un-solo, never mute');
  assert.deepEqual(tapOps(m[2], mix({ guitar: { soloed: true, gain: 0.3 } })), [{ stem: 'guitar', soloed: false }], 'even below 100%');
  assert.deepEqual(tapOps(m[0], m), [{ stem: 'guitar', soloed: false }], 'silent pill: ends the solo, drums stay at 30%');
  const two = mix({ guitar: { soloed: true }, bass: { soloed: true } });
  assert.deepEqual(tapOps(two[0], two), [{ stem: 'bass', soloed: false }, { stem: 'guitar', soloed: false }]);
});

test('H1: never total silence — 20 000 random tap/long-press sequences from the full song always leave something audible', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let run = 0; run < 2000; run += 1) {
    let m = mix(rnd() < 0.3 ? { other: { availability: 'unavailable' } } : {});
    for (let step = 0; step < 10; step += 1) {
      const s = m[Math.floor(rnd() * m.length)];
      m = applyOps(m, rnd() < 0.7 ? tapOps(s, m) : longPressOps(s, m));
      assert.ok(audible(m), `silent after step ${step} of run ${run}: ${JSON.stringify(m.map((x) => [x.name, x.gain, x.muted, x.soloed]))}`);
    }
  }
  // And the guard itself: muting the last audible part brings it back to 100%.
  const last = mix({ drums: { muted: true }, bass: { muted: true }, keys: { muted: true }, vocals: { muted: true }, other: { muted: true }, guitar: { gain: 0.3 } });
  assert.deepEqual(tapOps(last[2], last), [{ stem: 'guitar', gain: 1 }]);
});

test('the view: label and aria state the level; pressed means changed from the full song', () => {
  const v = (s, any = false) => { const x = pillView(s, any); return [x.state, x.ariaLabel, x.pressed, x.level]; };
  assert.deepEqual(v(stem('guitar')), ['100%', 'Guitar, 100%', false, 'full']);
  assert.deepEqual(v(stem('guitar', { gain: 0.3 })), ['30%', 'Guitar, 30%', true, 'partial']);
  assert.deepEqual(v(stem('guitar', { muted: true, gain: 0.3 })), ['muted', 'Guitar, muted', true, 'muted']);
  assert.deepEqual(v(stem('guitar', { soloed: true }), true), ['solo', 'Guitar, solo. Tap to end the solo', true, 'full']);
  assert.deepEqual(v(stem('guitar', { soloed: true, gain: 0.3 }), true), ['solo', 'Guitar, solo, 30%. Tap to end the solo', true, 'partial']);
  assert.deepEqual(v(stem('bass'), true), ['silent', 'Bass, silent while another part is soloed, back at 100% when the solo ends. Tap to end the solo', false, 'full']);
  assert.deepEqual(v(stem('bass', { gain: 0.3 }), true)[1], 'Bass, silent while another part is soloed, back at 30% when the solo ends. Tap to end the solo');
  assert.deepEqual(v(stem('bass', { muted: true }), true), ['muted', 'Bass, muted', true, 'muted'], 'muted says muted, not silent');
  assert.deepEqual(v(stem('guitar', { soloed: true, muted: true }), true), ['muted', 'Guitar, muted', true, 'muted'], 'a muted solo is silent: never "solo"');
  assert.deepEqual(v(stem('keys', { availability: 'encode_failed' })), ['n/a', 'Keys, not available', false, 'full']);
});

test('missing stems: the five named parts always show (disabled when missing); Other only when the song has it', () => {
  assert.deepEqual(pillStems([stem('drums'), stem('guitar')]).map((s) => [s.name, s.availability]), [
    ['guitar', 'ready'], ['bass', 'unavailable'], ['keys', 'unavailable'], ['drums', 'ready'], ['vocals', 'unavailable'],
  ]);
  // L1: the engine reports all six slots; 'unavailable' = the manifest never offered it.
  assert.equal(pillStems(mix({ other: { availability: 'unavailable' } })).some((s) => s.name === 'other'), false);
  assert.equal(pillStems([stem('other', { availability: 'encode_failed' })]).map((s) => s.name).at(-1), 'other', 'produced but undecodable: shown disabled');
  assert.equal(pillStems(mix()).at(-1).name, 'other');
  assert.deepEqual(tapOps(stem('keys', { availability: 'unavailable' })), []);
  assert.deepEqual(longPressOps(stem('keys', { availability: 'encode_failed' })), []);
});

test('brand: pills are 44px tall, 22px round, selected #222 + 2px white edge, never lime or amber; no animation', () => {
  const css = readFileSync(join(WEB, 'src/components/play/PartPills.module.css'), 'utf8');
  const rule = (sel) => css.match(new RegExp(`${sel.replace(/[.[\]'=]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`))[1];
  assert.match(rule('.pill'), /height:\s*var\(--touch-min, 44px\)/);
  assert.match(rule('.pill'), /border-radius:\s*22px/);
  assert.match(rule('.pill'), /min-width:\s*44px/);
  assert.match(rule(".pill[aria-pressed='true']"), /background:\s*var\(--bg-selected\);[^}]*border:\s*2px solid var\(--text-primary\)/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /--accent(?!\))|#a3e635|--chord-now|#f59e0b|--status-expiry/, 'lime only for the focus ring; never amber');
  assert.match(rule('.pill:focus-visible'), /outline:\s*2px solid var\(--accent\)/, 'the focus ring is the one lime use');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /transition|animation/, 'no motion, so reduced motion has nothing to stop');
  // The row is exactly the 44px target (compact fit), and it steps aside on short
  // windows (500-559px), and below 600px when a notice bar shows (review M1).
  assert.match(rule('.row'), /height:\s*var\(--touch-min, 44px\)/);
  assert.match(css, /@media \(min-height: 500px\) and \(max-height: 559px\) \{\s*\.root \{ display: none; \}/);
  assert.match(css, /@media \(min-height: 500px\) and \(max-height: 599px\) \{\s*:global\(\[data-testid='player'\]:has\(\[data-testid='player-notice'\]\)\) \.root \{ display: none; \}/);
});
