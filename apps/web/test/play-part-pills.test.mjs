// "My part" pills (Phase A D5): src/lib/play/part-pills.ts. The DOM behaviour
// (tap, long-press, S, disabled, the Mix label) is in play-player-screen.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOW_GAIN, PILL_SHORT, PILL_STEMS, longPressOps, pillStems, pillView, tapOps, unavailableNote,
} from '../src/lib/play/part-pills.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const stem = (name, over = {}) => ({ name, availability: 'ready', gain: 1, muted: false, soloed: false, effectivelySilent: false, ...over });
/** Apply ops in order, as PartPills does. */
const apply = (s, ops) => ops.reduce((acc, o) => ({ ...acc, ...o, name: acc.name }), s);
const strip = ({ stem: _s, ...rest }) => rest;

test('Jon\'s order: Guitar · Bass · Keys · Drums · Vocals, then Other; short visible names', () => {
  assert.deepEqual([...PILL_STEMS], ['guitar', 'bass', 'keys', 'drums', 'vocals', 'other']);
  assert.deepEqual(PILL_STEMS.map((s) => PILL_SHORT[s]), ['Gtr', 'Bass', 'Keys', 'Drums', 'Vox', 'Other']);
  assert.equal(LOW_GAIN, 0.3);
});

test('a tap cycles 100% -> 30% -> muted -> 100%, and comes home in three taps from anywhere', () => {
  let s = stem('guitar');
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    s = apply(s, tapOps(s).map(strip));
    seen.push(pillView(s, false).state);
  }
  assert.deepEqual(seen, ['30%', 'muted', '100%', '30%', 'muted', '100%']);
  // A fader level in between counts as lowered: the next tap mutes.
  assert.deepEqual(tapOps(stem('bass', { gain: 0.55 })), [{ stem: 'bass', muted: true }]);
  // Unmuting from a low level goes straight to 100%: the level first, then the unmute.
  assert.deepEqual(tapOps(stem('bass', { gain: 0.3, muted: true })), [{ stem: 'bass', gain: 1 }, { stem: 'bass', muted: false }]);
  assert.deepEqual(tapOps(stem('bass', { gain: 1, muted: true })), [{ stem: 'bass', muted: false }]);
  // 99.6% rounds to 100%, as the fader shows it: it is full.
  assert.deepEqual(tapOps(stem('bass', { gain: 0.996 })), [{ stem: 'bass', gain: 0.3 }]);
});

test('no op is ever a seek, a play or a restart: only gain, mute and solo', () => {
  for (const s of [stem('guitar'), stem('guitar', { gain: 0.3 }), stem('guitar', { muted: true }), stem('guitar', { soloed: true })]) {
    for (const op of [...tapOps(s), ...longPressOps(s)]) {
      assert.deepEqual(Object.keys(op).filter((k) => k !== 'stem').every((k) => ['gain', 'muted', 'soloed'].includes(k)), true, JSON.stringify(op));
    }
  }
});

test('a long-press solos; again un-solos; soloing a muted part unmutes it', () => {
  assert.deepEqual(longPressOps(stem('guitar')), [{ stem: 'guitar', soloed: true }]);
  assert.deepEqual(longPressOps(stem('guitar', { soloed: true })), [{ stem: 'guitar', soloed: false }]);
  assert.deepEqual(longPressOps(stem('guitar', { muted: true })), [{ stem: 'guitar', soloed: true }, { stem: 'guitar', muted: false }]);
});

test('the view: label and aria state the level; pressed means changed from the full song', () => {
  const v = (s, any = false) => { const x = pillView(s, any); return [x.state, x.ariaLabel, x.pressed, x.level]; };
  assert.deepEqual(v(stem('guitar')), ['100%', 'Guitar, 100%', false, 'full']);
  assert.deepEqual(v(stem('guitar', { gain: 0.3 })), ['30%', 'Guitar, 30%', true, 'partial']);
  assert.deepEqual(v(stem('guitar', { muted: true, gain: 0.3 })), ['muted', 'Guitar, muted', true, 'muted']);
  assert.deepEqual(v(stem('guitar', { soloed: true }), true), ['solo', 'Guitar, solo', true, 'full']);
  assert.deepEqual(v(stem('guitar', { soloed: true, gain: 0.3 }), true), ['solo', 'Guitar, solo, 30%', true, 'partial']);
  assert.deepEqual(v(stem('bass'), true), ['silent', 'Bass, 100%, silent while another part is soloed', false, 'full']);
  assert.deepEqual(v(stem('bass', { muted: true }), true), ['muted', 'Bass, muted', true, 'muted'], 'muted says muted, not silent');
  assert.deepEqual(v(stem('guitar', { soloed: true, muted: true }), true), ['muted', 'Guitar, muted', true, 'muted'], 'a muted solo is silent: never "solo"');
  assert.deepEqual(v(stem('keys', { availability: 'encode_failed' })), ['n/a', 'Keys, not available', false, 'full']);
});

test('missing stems: the five named parts always show (disabled when missing); Other only when the song has it', () => {
  assert.deepEqual(pillStems([stem('drums'), stem('guitar')]).map((s) => [s.name, s.availability]), [
    ['guitar', 'ready'], ['bass', 'unavailable'], ['keys', 'unavailable'], ['drums', 'ready'], ['vocals', 'unavailable'],
  ]);
  assert.deepEqual(pillStems([stem('other', { availability: 'encode_failed' })]).map((s) => s.name).at(-1), 'other');
  assert.deepEqual(tapOps(stem('keys', { availability: 'unavailable' })), []);
  assert.deepEqual(longPressOps(stem('keys', { availability: 'encode_failed' })), []);
  assert.equal(unavailableNote([stem('guitar')]), null);
  assert.equal(unavailableNote([stem('keys', { availability: 'unavailable' })]), 'Keys is not available for this song.');
  assert.equal(
    unavailableNote([stem('keys', { availability: 'unavailable' }), stem('bass', { availability: 'unavailable' }), stem('other', { availability: 'encode_failed' })]),
    'Keys, Bass and Other are not available for this song.',
  );
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
});
