// #360 part 2: iOS viewport-fit=cover is on for the whole app, and every surface that touches a
// screen edge pads itself with env(safe-area-inset-*). Static (grep-style) checks: layout needs a
// real device, see the REAL-DEVICE checklist item 9; screens in docs/design/screens-2026-11-23/t4-viewport-fit/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const inset = (side) => `env(safe-area-inset-${side}, 0px)`;

test('root layout viewport export sets viewportFit cover and keeps themeColor', () => {
  const src = read('src/app/layout.tsx');
  const m = src.match(/export const viewport: Viewport = \{([\s\S]*?)\};/);
  assert.ok(m, 'viewport export');
  assert.match(m[1], /viewportFit:\s*'cover'/);
  assert.match(m[1], /themeColor:\s*'#0d0d0d'/);
});

test('body pads by all four insets (0px fallback, so no-cutout devices do not move)', () => {
  const css = read('src/app/globals.css');
  const rule = [...css.matchAll(/(?:^|\n)body \{([^}]*)\}/g)].map((m) => m[1]).find((b) => b.includes('safe-area'));
  assert.ok(rule, 'body rule with insets');
  for (const s of ['top', 'right', 'bottom', 'left']) assert.ok(rule.includes(inset(s)), s);
});

test('fixed / sticky edge elements use safe-area insets', () => {
  const css = read('src/app/globals.css');
  assert.match(css, /\.submit-cta \{[^}]*padding-bottom: env\(safe-area-inset-bottom, 0px\)/);
  assert.ok(read('src/components/FlashBanner.tsx').includes('calc(12px + env(safe-area-inset-top, 0px))'));
  const land = read('src/styles/landing.css');
  assert.match(land, /\.demo-layer \{[^}]*env\(safe-area-inset-top, 0px\)[^}]*env\(safe-area-inset-bottom, 0px\)/);
  const player = read('src/components/play/Player.module.css');
  assert.match(player, /\.root \{[^}]*padding: env\(safe-area-inset-top, 0px\) env\(safe-area-inset-right, 0px\) env\(safe-area-inset-bottom, 0px\) env\(safe-area-inset-left, 0px\)/);
  const sheet = read('src/components/play/Sheet.module.css');
  assert.match(sheet, /\.backdrop \{[^}]*env\(safe-area-inset-right, 0px\)[^}]*env\(safe-area-inset-left, 0px\)/);
  assert.match(sheet, /\.sheet \{[^}]*calc\(16px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(read('src/components/setlists/SetLists.module.css'), /\.toast \{[^}]*calc\(140px \+ env\(safe-area-inset-bottom, 0px\)\)/);
});
