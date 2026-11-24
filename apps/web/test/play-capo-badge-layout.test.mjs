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
  assert.match(rule('.subWrap'), /flex-wrap:\s*wrap/);
  assert.doesNotMatch(sub, /max-height/, 'wrapped line must not be clipped');
  assert.doesNotMatch(sub, /(^|[\s;])height:/, '.sub must not have a fixed height');
});

test('header grows for the wrapped line (min-height, not a fixed height)', () => {
  const head = rule('.head');
  assert.match(head, /min-height:\s*56px/);
  assert.doesNotMatch(head, /(^|[\s;])height:\s*\d/);
  assert.doesNotMatch(head, /max-height/);
});

test('artist keeps a minimum width (never "D...")', () => {
  const a = rule('.subWrap .artist');
  const mw = a.match(/min-width:\s*([\d.]+)(ch|px|em|rem)/);
  assert.ok(mw && Number(mw[1]) >= (mw[2] === 'px' ? 40 : 6), `artist min-width must be >= 6ch: ${a}`);
  const base = rule('.artist');
  assert.doesNotMatch(base, /max-width/, 'a max-width on the artist makes the row wrap with no capo');
  assert.match(base, /flex:\s*1\s+1\s+0/, 'basis 0 so the artist alone never forces a wrap');
});

test('badge never shrinks; outline pill, >= 24px, no accent fill', () => {
  const b = rule('.capoBadge');
  assert.match(b, /flex:\s*0\s+0\s+auto/);
  assert.doesNotMatch(b, /flex-shrink:\s*[1-9]/);
  assert.match(b, /min-height:\s*(2[4-9]|[3-9]\d)px/);
  assert.doesNotMatch(b, /lime|amber|accent|background/i);
});

test('stepper label stays on one line', () => {
  assert.match(rule('.stepperValue'), /white-space:\s*nowrap/);
});

test('B1: with NO badge the row cannot wrap and the artist is ellipsised (pre-PR 56px header)', () => {
  const sub = rule('.sub');
  assert.doesNotMatch(sub, /flex-wrap:\s*wrap(?!-)/, '.sub itself must not wrap');
  assert.match(sub, /flex-wrap:\s*nowrap/);
  const art = rule('.artist');
  assert.match(art, /min-width:\s*0\b/, 'no-badge artist shrinks (ellipsis), never forces a wrap');
  assert.match(art, /text-overflow:\s*ellipsis/);
  // no other unconditional rule re-enables wrapping or the 6ch floor
  assert.doesNotMatch(css.replace(/\.subWrap[^{]*\{[^}]*\}/g, ''), /min-width:\s*6ch|flex-wrap:\s*wrap(?!-)/);
});

test('B1: PlayerScreen applies .subWrap only when the badge is set', () => {
  assert.match(tsx, /badge \? `\$\{styles\.sub\} \$\{styles\.subWrap\}` : styles\.sub/);
  assert.equal((tsx.match(/styles\.subWrap/g) ?? []).length, 1, 'subWrap used in exactly one (badge-gated) place');
});
