// Run: pnpm --filter web test
//
// QA A-07 (track A, 2026-11-18): the brand's ONE selected/pressed state is --bg-selected
// (#222) with a 2px white edge (design-tokens.css: "Everything selected or pressed is
// neutral"). The player's "Full song" preset and the transport's loop toggle used a WHITE
// FILL instead (computed bg rgb(255,255,255)), contradicting the section chips and M/S
// beside them.
//
// LINT: every rule in every stylesheet under src/ whose selector is a selected/pressed
// state (aria-pressed/aria-checked/aria-selected = true, :checked, data-state="on") must
// not set a white background. "White" is #fff, #ffffff, white, rgb(255,255,255) or a
// var() that resolves to #ffffff in design-tokens.css (today --text-primary). Static on
// purpose, like brand-tokens.test.mjs: it reads the CSS from disk, so a new stylesheet is
// covered the day it is added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const uncomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const CSS_FILES = walk(SRC).filter((p) => p.endsWith('.css'));

const TOKENS = uncomment(readFileSync(join(SRC, 'styles/design-tokens.css'), 'utf8'));
const WHITE_TOKENS = new Set([...TOKENS.matchAll(/(--[\w-]+):\s*#(?:fff|ffffff)\b/gi)].map((m) => m[1]));
const SELECTED = /\[aria-(?:pressed|checked|selected)=['"]?true['"]?\]|:checked\b|\[data-state=['"]?on['"]?\]/;

/** Every innermost `selector { declarations }` rule of a stylesheet (media queries included). */
function rules(css) {
  return [...uncomment(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}
function whiteFill(body) {
  for (const m of body.matchAll(/(?:^|;|\s)background(?:-color)?\s*:\s*([^;]+)/g)) {
    const v = m[1].trim().toLowerCase();
    if (/^(?:#fff|#ffffff|white|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(?:,\s*1(?:\.0+)?\s*)?\))(?![\w-])/.test(v)) return v;
    const t = /^var\(\s*(--[\w-]+)/.exec(v)?.[1];
    if (t && WHITE_TOKENS.has(t)) return v;
  }
  return null;
}

test('the lint can see white: --text-primary is a white token, and the detector flags each spelling', () => {
  assert.ok(WHITE_TOKENS.has('--text-primary'), 'design-tokens.css no longer declares --text-primary as #ffffff: re-check this lint');
  for (const v of ['#fff', '#FFFFFF', 'white', 'rgb(255, 255, 255)', 'var(--text-primary)']) {
    assert.ok(whiteFill(`background: ${v};`), `${v} not detected`);
  }
  assert.equal(whiteFill('background: var(--bg-selected); border: 2px solid var(--text-primary);'), null, 'the brand state itself is not a white fill');
  assert.ok(SELECTED.test(".loop[data-state='on']") && SELECTED.test('.x[aria-pressed="true"]') && SELECTED.test('input:checked + span'));
});

test('A-07: no selected/pressed state in any stylesheet is a white fill', () => {
  const found = [];
  let checked = 0;
  for (const f of CSS_FILES) {
    for (const r of rules(readFileSync(f, 'utf8'))) {
      if (!SELECTED.test(r.selector)) continue;
      checked++;
      const w = whiteFill(r.body);
      if (w) found.push(`${relative(WEB, f)}: ${r.selector.replace(/\s+/g, ' ')} { background: ${w} }`);
    }
  }
  assert.ok(checked >= 10, `only ${checked} selected-state rules found: the scan is not reading the stylesheets`);
  assert.deepEqual(found, [], `white fills on a selected state (use --bg-selected with a 2px white edge):\n  ${found.join('\n  ')}`);
});

test('A-07: the "Full song" preset and the loop toggle use the brand selected state (#222 + 2px white edge)', () => {
  const css = (p) => uncomment(readFileSync(join(SRC, p), 'utf8'));
  const body = (sheet, sel) => {
    const r = rules(sheet).find((x) => x.selector.replace(/\s+/g, ' ') === sel);
    assert.ok(r, `rule ${sel} not found`);
    return r.body;
  };
  for (const b of [
    body(css('components/play/Presets.module.css'), ".preset[aria-pressed='true'], .part[aria-pressed='true']"),
    body(css('components/play/Transport.module.css'), ".loop[data-state='on']"),
  ]) {
    assert.match(b, /background:\s*var\(--bg-selected\)/);
    assert.match(b, /border:\s*2px solid var\(--text-primary\)/);
    assert.doesNotMatch(b, /text-inverse/, 'a dark glyph only makes sense on a white fill');
  }
});
