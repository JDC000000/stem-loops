// Waveform colour gate (results-page LoopCard).
// 1. A canvas cannot resolve CSS variables: no var() may be handed to WaveSurfer or a 2D context.
// 2. Every stem's unplayed (--wf-idle-*) and played (--stem-*) colour is >= 3:1 on the panel
//    (--wf-bg), WCAG 1.4.11, and the two states are not the same colour.
// 3. Every stem has a per-card mapping, and forced colours fall back to system colours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCanvasColor } from '../src/lib/wave-colors.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const STEMS = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'];

const tokens = (css) => Object.fromEntries([...css.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2].toLowerCase()]));
const T = { ...tokens(read('src/styles/design-tokens.css')), ...tokens(read('src/styles/stem-color.css')) };
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('no var() reaches a canvas (WaveSurfer options, fillStyle, strokeStyle)', () => {
  const files = walk(join(WEB, 'src')).filter((p) => /\.(tsx?|mjs|js)$/.test(p) && !/\.test\./.test(p));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/WaveSurfer\.create\(\{([\s\S]*?)\}\)/g)) assert.doesNotMatch(m[1], /var\(/, `${f}: var() in WaveSurfer.create`);
    for (const m of src.matchAll(/(?:waveColor|progressColor|cursorColor|fillStyle|strokeStyle)\s*[:=]\s*[`'"][^`'"]*var\(/g)) assert.fail(`${f}: ${m[0]}`);
  }
});

test('each stem: unplayed and played waveform colours are >= 3:1 on the panel', () => {
  const bg = T['--wf-bg'];
  assert.equal(bg, '#0e0e0e');
  for (const s of STEMS) {
    const idle = T[`--wf-idle-${s}`], played = T[`--stem-${s}`];
    assert.ok(idle && played, `tokens for ${s}`);
    assert.ok(ratio(idle, bg) >= 3, `${s} unplayed ${idle} ${ratio(idle, bg).toFixed(2)}:1`);
    assert.ok(ratio(played, bg) >= 3, `${s} played ${played} ${ratio(played, bg).toFixed(2)}:1`);
    assert.notEqual(idle, played, `${s} unplayed and played differ`);
  }
  assert.ok(ratio(T['--wf-bar-idle'], bg) >= 3, 'no-stem fallback >= 3:1');
});

test('every stem maps its card waveform, with a forced-colours fallback', () => {
  const css = read('src/styles/loop-card.css');
  for (const s of STEMS) assert.match(css, new RegExp(`\\.loop-card\\[data-stem="${s}"\\]\\s*\\{\\s*--wf-idle:\\s*var\\(--wf-idle-${s}\\)`));
  assert.match(css, /--wf-played:\s*var\(--stem/);
  // the fallback must out-rank .loop-card[data-stem="x"], so it names [data-stem] too
  assert.match(css, /@media \(forced-colors: active\)\s*\{[^}]*\.loop-card\[data-stem\]\s*\{\s*--wf-idle:\s*CanvasText;\s*--wf-played:\s*Highlight;/);
});

test('toCanvasColor passes real colours and refuses var()', () => {
  assert.equal(toCanvasColor('rgb(173, 75, 45)'), 'rgb(173, 75, 45)');
  assert.equal(toCanvasColor('#ad4b2d'), '#ad4b2d');
  assert.equal(toCanvasColor('color(srgb 1 0.5 0)'), 'rgb(255, 128, 0)');
  assert.equal(toCanvasColor('color(srgb 0 0 0 / 0.5)'), 'rgba(0, 0, 0, 0.5)');
  assert.equal(toCanvasColor('var(--wf-idle, #2a2a2a)'), null);
  assert.equal(toCanvasColor(''), null);
  assert.equal(toCanvasColor('CanvasText'), null);
});
