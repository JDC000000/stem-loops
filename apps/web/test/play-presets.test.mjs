// Practice presets, "Mute my part" and "Solo my part" (design v1.4, P1.3;
// DB-13 option (a); Phase A D5): src/lib/play/presets.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PART, PARTS, PART_QUESTION, PART_STORAGE_KEY, PRESET_NAMES, PRESET_ORDER,
  activePreset, mixStateLabel, parsePart, presetBlocked, presetOps, readPart, writePart,
} from '../src/lib/play/presets.ts';

const NAMES = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const stems = (over = {}) =>
  NAMES.map((name) => ({ name, availability: 'ready', gain: 1, muted: false, soloed: false, effectivelySilent: false, ...(over[name] ?? {}) }));
/** Apply ops the way PlayerScreen does, to a copy. */
const apply = (st, ops) =>
  st.map((s) => ops.filter((o) => o.stem === s.name).reduce((acc, o) => ({
    ...acc,
    ...('gain' in o ? { gain: o.gain } : {}),
    ...('muted' in o ? { muted: o.muted } : {}),
    ...('soloed' in o ? { soloed: o.soloed } : {}),
  }), s));

test('Phase A D5: three presets — Mute my part, Solo my part, Full song — with the spec copy', () => {
  assert.deepEqual(PRESET_ORDER.map((id) => PRESET_NAMES[id]), ['Mute my part', 'Solo my part', 'Full song']);
  assert.ok(!Object.values(PRESET_NAMES).some((n) => /No vocals|Drums \+ bass/.test(n)), '"No vocals" and "Drums + bass" are gone');
  assert.equal(PART_QUESTION, 'Which part do you play?');
  assert.deepEqual([...PARTS], ['guitar', 'bass', 'keys', 'drums', 'vocals'], 'Guitar first (pre-selected) · Bass · Keys · Drums · Vocals');
  assert.equal(DEFAULT_PART, 'guitar');
});

test('"Full song" and "Mute my part" own levels too: every other stem back to 100%, unmuted, unsoloed; the muted part keeps its level', () => {
  const base = stems({ keys: { soloed: true, gain: 0.3 }, drums: { muted: true }, bass: { gain: 0.55 } });
  const full = apply(base, presetOps('full', 'bass', base));
  assert.ok(full.every((s) => !s.muted && !s.soloed && s.gain === 1), JSON.stringify(full));
  assert.equal(activePreset(full, 'bass'), 'full');
  const mine = apply(base, presetOps('mine', 'bass', base));
  assert.deepEqual(mine.filter((s) => s.muted).map((s) => s.name), ['bass']);
  assert.equal(mine.find((s) => s.name === 'bass').gain, 0.55, 'the muted part keeps its level for when it comes back');
  assert.ok(mine.filter((s) => s.name !== 'bass').every((s) => s.gain === 1 && !s.soloed));
  assert.equal(activePreset(mine, 'bass'), 'mine');
});

test('"Solo my part" solos the part (unmuting it), clears other solos, and leaves the silent stems as they were', () => {
  const base = stems({ keys: { soloed: true }, guitar: { muted: true, gain: 0.3 }, drums: { gain: 0.4, muted: true } });
  const ops = presetOps('solo', 'guitar', base);
  assert.ok(ops.every((o) => !('gain' in o)), 'no level changes');
  const after = apply(base, ops);
  assert.deepEqual(after.filter((s) => s.soloed).map((s) => s.name), ['guitar']);
  assert.equal(after.find((s) => s.name === 'guitar').muted, false, 'a muted part is unmuted, or the solo is silence');
  assert.deepEqual(after.find((s) => s.name === 'drums'), base.find((s) => s.name === 'drums'), 'drums untouched');
  assert.equal(activePreset(after, 'guitar'), 'solo');
  assert.equal(activePreset(after, 'bass'), 'custom', 'a solo that is not your part is custom');
  assert.equal(activePreset(after, null), 'custom');
});

test('a preset that already holds is a no-op (no engine calls)', () => {
  assert.deepEqual(presetOps('full', 'guitar', stems()), []);
  assert.deepEqual(presetOps('mine', 'guitar', stems({ guitar: { muted: true } })), []);
  assert.deepEqual(presetOps('solo', 'guitar', stems({ guitar: { soloed: true } })), []);
});

test('touching any control after a preset relabels the selection "Custom"', () => {
  const mine = apply(stems(), presetOps('mine', 'guitar', stems()));
  assert.equal(activePreset(mine, 'guitar'), 'mine');
  assert.equal(activePreset(apply(mine, [{ stem: 'drums', muted: true }]), 'guitar'), 'custom');
  assert.equal(activePreset(apply(mine, [{ stem: 'bass', soloed: true }]), 'guitar'), 'custom');
  assert.equal(activePreset(apply(mine, [{ stem: 'bass', gain: 0.3 }]), 'guitar'), 'custom', 'a lowered level is not "Mute my part"');
  assert.equal(activePreset(apply(stems(), [{ stem: 'bass', gain: 0.3 }]), 'guitar'), 'custom', 'nor "Full song"');
  assert.equal(activePreset(apply(stems(), [{ stem: 'guitar', soloed: true }, { stem: 'bass', soloed: true }]), 'guitar'), 'custom', 'two solos');
  assert.equal(activePreset(apply(stems(), [{ stem: 'guitar', soloed: true }, { stem: 'guitar', muted: true }]), 'guitar'), 'custom', 'a muted solo is silence, not "Solo my part"');
});

test('a vocalist\'s "Mute my part" reads as that; with no part chosen only "Full song" can match', () => {
  const after = apply(stems(), presetOps('mine', 'vocals', stems()));
  assert.equal(activePreset(after, 'vocals'), 'mine');
  assert.equal(activePreset(after, null), 'custom');
  assert.equal(activePreset(stems(), null), 'full');
});

test('missing stems: presets act on the stems that exist; both part presets are disabled with a reason when the part is missing', () => {
  const st = stems({ other: { availability: 'unavailable', gain: 0.2 }, guitar: { availability: 'encode_failed', muted: true } });
  assert.ok(presetOps('full', 'bass', st).every((o) => o.stem !== 'other' && o.stem !== 'guitar'));
  assert.equal(activePreset(apply(st, presetOps('full', 'bass', st)), 'bass'), 'full');
  assert.equal(presetBlocked('mine', 'guitar', st), 'Guitar is not available for this song.');
  assert.equal(presetBlocked('solo', 'guitar', st), 'Guitar is not available for this song.');
  assert.equal(presetBlocked('mine', 'bass', st), null);
  assert.equal(presetBlocked('full', 'guitar', st), null, 'Full song is never blocked');
  assert.equal(presetBlocked('mine', null, st), null, 'not asked yet: the question comes first');
});

test('D5: the Mix button state line names the change — "Full song", "Guitar 30%", "Guitar muted", "Guitar solo", or "Custom"', () => {
  assert.equal(mixStateLabel(stems()), 'Full song');
  assert.equal(mixStateLabel([]), 'Full song');
  assert.equal(mixStateLabel(stems({ guitar: { gain: 0.3 } })), 'Guitar 30%');
  assert.equal(mixStateLabel(stems({ guitar: { gain: 0.554 } })), 'Guitar 55%');
  assert.equal(mixStateLabel(stems({ guitar: { muted: true } })), 'Guitar muted');
  assert.equal(mixStateLabel(stems({ guitar: { muted: true, gain: 0.3 } })), 'Guitar muted', 'muted wins over the level');
  assert.equal(mixStateLabel(stems({ bass: { muted: true } })), 'Bass muted');
  assert.equal(mixStateLabel(stems({ guitar: { soloed: true } })), 'Guitar solo');
  assert.equal(mixStateLabel(stems({ guitar: { soloed: true }, drums: { gain: 0.3 }, keys: { muted: true } })), 'Guitar solo', 'the silent stems do not matter under one solo');
  assert.equal(mixStateLabel(stems({ guitar: { soloed: true }, bass: { soloed: true } })), 'Custom');
  assert.equal(mixStateLabel(stems({ guitar: { soloed: true, muted: true } })), 'Custom', 'a muted solo is not "Guitar solo"');
  assert.equal(mixStateLabel(stems({ guitar: { gain: 0.3 }, vocals: { muted: true } })), 'Custom');
  assert.equal(mixStateLabel(stems({ keys: { availability: 'unavailable', gain: 0, muted: true } })), 'Full song', 'a missing stem is not a change');
});

test('the part is remembered in localStorage, and storage failing never throws', () => {
  const mem = new Map();
  const ok = { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) } };
  assert.equal(readPart(ok), null);
  writePart('keys', ok);
  assert.equal(mem.get(PART_STORAGE_KEY), 'keys');
  assert.equal(readPart(ok), 'keys');
  const throwing = { localStorage: { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); } } };
  assert.equal(readPart(throwing), null);
  assert.doesNotThrow(() => writePart('bass', throwing));
  const getterThrows = Object.defineProperty({}, 'localStorage', { get() { throw new Error('blocked'); } });
  assert.equal(readPart(getterThrows), null);
  assert.doesNotThrow(() => writePart('bass', getterThrows));
  assert.equal(readPart(null), null);
  for (const v of ['other', 'GUITAR', '', null, 7]) assert.equal(parsePart(v), null, String(v));
});
