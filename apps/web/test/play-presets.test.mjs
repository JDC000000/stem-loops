// Practice presets and "Mute my part" (design v1.4, P1.3; DB-13 option (a)):
// src/lib/play/presets.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PART, PARTS, PART_QUESTION, PART_STORAGE_KEY, PRESET_NAMES, PRESET_ORDER,
  activePreset, mixStateLabel, parsePart, presetBlocked, presetOps, readPart, writePart,
} from '../src/lib/play/presets.ts';

const NAMES = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const stems = (over = {}) =>
  NAMES.map((name) => ({ name, availability: 'ready', gain: 0.8, muted: false, soloed: false, effectivelySilent: false, ...(over[name] ?? {}) }));
/** Apply ops the way PlayerScreen does, to a copy. */
const apply = (st, ops) => st.map((s) => ops.filter((o) => o.stem === s.name).reduce((acc, o) => ({ ...acc, ...('muted' in o ? { muted: o.muted } : {}), ...('soloed' in o ? { soloed: o.soloed } : {}) }), s));

test('the four presets, in the 2x2 order and with the spec copy', () => {
  assert.deepEqual(PRESET_ORDER.map((id) => PRESET_NAMES[id]), ['Mute my part', 'Full song', 'No vocals', 'Drums + bass']);
  assert.equal(PART_QUESTION, 'Which part do you play?');
  assert.deepEqual([...PARTS], ['guitar', 'bass', 'keys', 'drums', 'vocals'], 'Guitar first (pre-selected) · Bass · Keys · Drums · Vocals');
  assert.equal(DEFAULT_PART, 'guitar');
});

test('each preset sets MUTES only (levels untouched), clears solos, and then reads as itself', () => {
  const base = stems({ keys: { soloed: true, gain: 0.3 }, drums: { muted: true } });
  const want = { mine: ['bass'], full: [], novox: ['vocals'], db: ['guitar', 'keys', 'vocals', 'other'] };
  for (const id of PRESET_ORDER) {
    const ops = presetOps(id, 'bass', base);
    assert.ok(ops.every((o) => !('gain' in o)), `${id} touches a level`);
    const after = apply(base, ops);
    assert.deepEqual(after.filter((s) => s.muted).map((s) => s.name), want[id], id);
    assert.ok(after.every((s) => !s.soloed), `${id} leaves a solo on`);
    assert.equal(after.find((s) => s.name === 'keys').gain, 0.3);
    assert.equal(activePreset(after, 'bass'), id);
  }
});

test('a preset that already holds is a no-op (no engine calls)', () => {
  assert.deepEqual(presetOps('full', 'guitar', stems()), []);
  assert.deepEqual(presetOps('novox', 'guitar', stems({ vocals: { muted: true } })), []);
});

test('touching any mute or solo after a preset relabels the selection "Custom"', () => {
  const mine = apply(stems(), presetOps('mine', 'guitar', stems()));
  assert.equal(activePreset(mine, 'guitar'), 'mine');
  assert.equal(activePreset(apply(mine, [{ stem: 'drums', muted: true }]), 'guitar'), 'custom');
  assert.equal(activePreset(apply(mine, [{ stem: 'bass', soloed: true }]), 'guitar'), 'custom', 'any solo is custom');
  // Levels are not part of a preset, so a fader move alone keeps the label.
  assert.equal(activePreset(mine.map((s) => ({ ...s, gain: 0.2 })), 'guitar'), 'mine');
});

test('a vocalist\'s "Mute my part" reads as that, not as "No vocals"', () => {
  const after = apply(stems(), presetOps('mine', 'vocals', stems()));
  assert.equal(activePreset(after, 'vocals'), 'mine');
  assert.equal(activePreset(after, null), 'novox', 'with no part chosen it is just "No vocals"');
});

test('missing stems: presets act on the stems that exist; "Mute my part" is disabled with a reason when the part is missing', () => {
  const st = stems({ other: { availability: 'unavailable' }, guitar: { availability: 'encode_failed' } });
  assert.ok(presetOps('db', 'bass', st).every((o) => o.stem !== 'other' && o.stem !== 'guitar'));
  assert.equal(activePreset(apply(st, presetOps('db', 'bass', st)), 'bass'), 'db');
  assert.equal(presetBlocked('mine', 'guitar', st), 'Guitar is not available for this song.');
  assert.equal(presetBlocked('mine', 'bass', st), null);
  assert.equal(presetBlocked('full', 'guitar', st), null, 'only Mute my part can be blocked');
  assert.equal(presetBlocked('mine', null, st), null, 'not asked yet: the question comes first');
});

test('the Mix button state line says what the mix is doing', () => {
  assert.equal(mixStateLabel(stems(), null), 'full song');
  assert.equal(mixStateLabel(stems({ guitar: { muted: true } }), 'guitar'), 'guitar off');
  assert.equal(mixStateLabel(stems({ bass: { muted: true } }), 'bass'), 'bass off');
  assert.equal(mixStateLabel(stems({ vocals: { muted: true } }), 'guitar'), 'no vocals');
  assert.equal(mixStateLabel(apply(stems(), presetOps('db', 'guitar', stems())), 'guitar'), 'drums + bass');
  assert.equal(mixStateLabel(stems({ drums: { soloed: true } }), 'guitar'), 'custom');
  assert.equal(mixStateLabel([], null), 'full song');
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
