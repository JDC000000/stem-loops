// PR #375 round 4 (visual): the header capo badge must never squeeze the artist.
// Static guard over PlayerScreen.tsx + Player.module.css (no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tsx = readFileSync(new URL('../src/components/play/PlayerScreen.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/components/play/Player.module.css', import.meta.url), 'utf8');
const rule = (sel) => {
  const m = css.match(new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
  assert.ok(m, `rule ${sel} missing`);
  return m[1];
};

test('badge and artist share the .sub row, which WRAPS (the badge goes to its own line)', () => {
  assert.ok(tsx.indexOf('styles.capoBadge') > 0 && tsx.indexOf('styles.artist') > 0);
  const sub = rule('.sub');
  assert.match(sub, /display:\s*flex/);
  assert.match(sub, /flex-wrap:\s*wrap/);
  assert.doesNotMatch(sub, /max-height/, 'wrapped line must not be clipped');
});

test('header grows for the wrapped line (min-height, not a fixed height)', () => {
  const head = rule('.head');
  assert.match(head, /min-height:\s*56px/);
  assert.doesNotMatch(head, /(^|[\s;])height:\s*56px/);
});

test('artist keeps a minimum width (never "D...")', () => {
  const a = rule('.artist');
  const mw = a.match(/min-width:\s*([\d.]+)(ch|px|em|rem)/);
  assert.ok(mw && Number(mw[1]) >= (mw[2] === 'px' ? 40 : 4), `artist min-width too small: ${a}`);
  assert.doesNotMatch(a, /flex:\s*1\s+1\s+0/);
});

test('badge never shrinks; outline pill, >= 24px, no accent fill', () => {
  const b = rule('.capoBadge');
  assert.match(b, /flex:\s*0\s+0\s+auto/);
  assert.match(b, /min-height:\s*(2[4-9]|[3-9]\d)px/);
  assert.doesNotMatch(b, /lime|amber|accent|background/i);
});

test('stepper label stays on one line', () => {
  assert.match(rule('.stepperValue'), /white-space:\s*nowrap/);
});
