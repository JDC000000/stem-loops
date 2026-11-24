// #360 part 2: iOS viewport-fit=cover is on for the whole app, and every surface that touches a
// screen edge pads itself with env(safe-area-inset-*). Static checks on code with comments
// stripped (a value that lives only in a comment must not pass). Layout needs a real device:
// REAL-DEVICE checklist item 9; screens in docs/design/screens-2026-11-23/t4-viewport-fit/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const read = (p) => strip(readFileSync(join(WEB, p), 'utf8'));
const inset = (side) => `env(safe-area-inset-${side}, 0px)`;
/** Declarations of the LAST rule matching `sel` (so a later override wins), as a prop->value map. */
function lastRule(css, sel) {
  const re = new RegExp(`(?:^|[}\\s,])${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  const all = [...css.matchAll(re)];
  assert.ok(all.length, `rule ${sel}`);
  const decl = {};
  for (const m of all) for (const d of m[1].split(';')) {
    const i = d.indexOf(':');
    if (i > 0) decl[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return decl;
}

test('root layout viewport export sets viewportFit cover and keeps themeColor (in code, not comments)', () => {
  const m = read('src/app/layout.tsx').match(/export const viewport: Viewport = \{([\s\S]*?)\};/);
  assert.ok(m, 'viewport export');
  assert.match(m[1], /^\s*viewportFit:\s*'cover',?\s*$/m);
  assert.doesNotMatch(m[1], /viewportFit:\s*'(?!cover)/);
  assert.match(m[1], /themeColor:\s*'#0d0d0d'/);
});

test('effective body padding is the four insets (0px fallback: no-cutout devices do not move)', () => {
  const body = lastRule(read('src/app/globals.css'), 'body');
  const pad = body.padding.replace(/\s+/g, ' ');
  assert.equal(pad, ['top', 'right', 'bottom', 'left'].map(inset).join(' '));
  for (const k of ['padding-top', 'padding-bottom', 'padding-left', 'padding-right']) assert.equal(body[k], undefined, k);
});

test('a page min-height never uses bare 100dvh/100vh (body pads by the insets, so it would always scroll)', () => {
  const tok = read('src/styles/design-tokens.css');
  assert.equal(lastRule(tok, ':root')['--page-min-h'].replace(/\s+/g, ' '), `calc(100dvh - ${inset('top')} - ${inset('bottom')})`);
  const bad = [];
  const walk = (d) => {
    for (const n of readdirSync(join(WEB, d))) {
      const p = `${d}/${n}`;
      if (statSync(join(WEB, p)).isDirectory()) walk(p);
      else if (/\.(tsx|css)$/.test(n) && !/play\/|ChordOverlay|landing\.css|design-tokens/.test(p) && /min-?[hH]eight['"]?:\s*['"]?100[ds]?vh/.test(read(p))) bad.push(p);
    }
  };
  walk('src');
  assert.deepEqual(bad, [], 'use var(--page-min-h)');
  for (const p of ['src/app/login/page.tsx', 'src/app/history/page.tsx', 'src/app/account/page.tsx', 'src/app/success/page.tsx', 'src/styles/pricing-page.css']) {
    assert.match(read(p), /var\(--page-min-h\)/, p);
  }
});

test('fixed edge elements use safe-area insets', () => {
  const fb = read('src/components/FlashBanner.tsx');
  assert.ok(fb.includes("top: 'calc(12px + env(safe-area-inset-top, 0px))'"));
  assert.ok(fb.includes('env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)'));
  assert.match(read('src/styles/landing.css'), /\.demo-layer \{[^}]*env\(safe-area-inset-top, 0px\)[^}]*env\(safe-area-inset-bottom, 0px\)/);
  assert.match(read('src/components/play/Player.module.css'), /\.root \{[^}]*padding: env\(safe-area-inset-top, 0px\) env\(safe-area-inset-right, 0px\) env\(safe-area-inset-bottom, 0px\) env\(safe-area-inset-left, 0px\)/);
  const sheet = read('src/components/play/Sheet.module.css');
  assert.match(sheet, /\.backdrop \{[^}]*env\(safe-area-inset-right, 0px\)[^}]*env\(safe-area-inset-left, 0px\)/);
  assert.match(sheet, /\.sheet \{[^}]*calc\(16px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  const sl = read('src/components/setlists/SetLists.module.css');
  assert.match(sl, /\.toast \{[^}]*calc\(140px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(sl, /\.toast \{[^}]*env\(safe-area-inset-left, 0px\) - env\(safe-area-inset-right, 0px\)/);
});
