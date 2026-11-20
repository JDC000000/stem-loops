// REAL-BROWSER GATE: QA-68, the "See all chords" sheet's chips are tap targets.
//
// Every chip in the chart sheet is a <button> that opens the chord editor,
// including the label-less "tick" colour blocks. The #312 review (M-1)
// measured 19-21 of 63 chips under 24px wide on the QA-01 song, and 107-137 of
// 154 on a dense song, some only 2-4px. This gate renders the real PlayerView
// (real ChordOverlay, real CSS, real chord loader) on phones, opens the sheet
// through the ⋯ menu, and measures EVERY chip with the layout engine:
//
//   * width and height >= 24px (getBoundingClientRect: what a finger gets);
//   * no two chips' boxes intersect (no shared hit area), every chip is inside
//     its row, and nothing makes the sheet scroll sideways;
//   * read in rows top to bottom and left to right, the chips are in time
//     order, and each row's time label is no earlier than the row above;
//   * one primary chip per segment (#212), so no chord was merged away;
//   * the current-chord ring sits exactly on a chip of the chord being heard;
//   * a real touchscreen tap on the chips of the SHORTEST chords lands on them
//     (elementFromPoint) and opens the editor for that chord.
//
// It does this at 320x568, 360x800 and 390x844, at the default zoom and at
// both ends of the zoom slider. The zoomed-out end is the worst case, with the
// most chips per row. It FAILS (never skips) when Chromium or the page is
// missing. Expected values come from the payloads built HERE, never from the
// component's helpers. With the fix reverted (layoutRows instead of
// layoutTapRows in ChordOverlay.tsx) it fails on every viewport.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const esbuild = require('esbuild');

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(process.env.CHORD_GATE_SRC ?? join(HERE, '../../../apps/web'));
const MIN_TAP = 24; // brand floor and WCAG 2.5.8. A literal, not the component's constant.
const VIEWPORTS = [[320, 568], [360, 800], [390, 844]];
const SLIDER_STOPS = [null, 0, 1000]; // default zoom, zoomed right out, the ceiling

const FONT_DIR = join(dirname(require.resolve('@fontsource/inter/package.json')), 'files');
const FONT_CSS =
  [400, 500, 600, 700].map((w) => `@font-face{font-family:GateInter;font-weight:${w};src:url(/font-${w}.woff2) format('woff2')}`).join('') +
  '[data-testid="chord-overlay"]{font-family:GateInter,sans-serif !important}';

// ---------------------------------------------------------------------------
// Songs (truth built here)
// ---------------------------------------------------------------------------
function songOf(bars, bpm) {
  const beat = 60 / bpm;
  const off = 0.5;
  const segs = [];
  let b = 0;
  for (const bar of bars)
    for (const [label, beats] of bar) {
      const s = off + b * beat;
      b += beats;
      const last = segs.at(-1);
      if (last && last.label === label) last.end_sec = off + b * beat;
      else segs.push({ start_sec: s, end_sec: off + b * beat, label, confidence: 1 });
    }
  return { segments: segs, grid: { beatSec: beat, anchorSec: off, measured: true }, durationSec: off + b * beat + 0.25 };
}
// The QA-01 progression (as in the #312 review): half-beat F and G between long chords.
const QA01 = [
  [['C:maj', 4]], [['A:min', 3.5], ['F:maj', 0.5]], [['G:maj', 4]], [['E:min', 2], ['C:maj', 1.5], ['G:maj', 0.5]],
  [['A:min', 0.5], ['F:maj', 3.5]], [['G:maj', 4]], [['C:maj', 2], ['F:maj', 2]], [['G:7', 4]],
];
// Dense, long names: bars of eight half-beat chords between plain bars.
const LONG = ['C#:hdim7/5', 'Bb:maj7/3', 'F#:min7/b7', 'Eb:sus4/b7', 'Ab:maj9', 'C#:min7', 'G:7/5', 'D:min'];
const DENSE = [
  LONG.map((l) => [l, 0.5]),
  [['C:maj', 1], ['F:maj', 1], ['G:maj', 1], ['A:min', 1]],
  [['E:min', 3.5], ['B:dim', 0.5]],
];
const SONGS = [
  { name: 'qa01', ...songOf(Array.from({ length: 32 }, (_, i) => QA01[i % QA01.length]), 100) },
  { name: 'dense', ...songOf(Array.from({ length: 33 }, (_, i) => DENSE[i % DENSE.length]), 120) },
];

const snapAt = (song, positionSec) => ({
  status: 'playing',
  positionSec,
  durationSec: song.durationSec,
  stems: ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'].map((name) => ({ name, availability: 'ready', gain: 0.8, muted: false, soloed: false, effectivelySilent: false })),
  loop: null,
  degraded: null,
  error: null,
});

// ---------------------------------------------------------------------------
// Harness (the same shape as chord-phone-view.test.mjs)
// ---------------------------------------------------------------------------
async function bundle() {
  const res = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { PlayerView } from './src/components/play/Player.tsx';
        import './src/app/globals.css';
        const noop = () => {};
        const root = createRoot(document.getElementById('root'));
        window.__render = (snapshot) => root.render(React.createElement(PlayerView, {
          jobId: 'sheet-tap-gate', phase: { kind: 'ready' }, snapshot,
          sections: [], beatGrid: window.__grid,
          onPlay: noop, onPause: noop, onSeek: noop, onGain: noop, onMute: noop, onSolo: noop, onLoop: noop,
        }));
        window.__render(window.__snap);`,
      resolveDir: WEB,
      loader: 'js',
    },
    bundle: true,
    write: false,
    outdir: 'out',
    format: 'iife',
    jsx: 'automatic',
    tsconfig: join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.onnx': 'empty', '.wasm': 'empty' },
    logLevel: 'silent',
    plugins: [{
      name: 'stub-sentry',
      setup(b) {
        b.onResolve({ filter: /^@sentry\/nextjs$/ }, () => ({ path: 's', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export function captureMessage() {}', loader: 'js' }));
      },
    }],
  });
  const js = res.outputFiles.find((f) => f.path.endsWith('.js'));
  assert.ok(js, 'esbuild produced no JS');
  return { js: js.text, css: res.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '' };
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function open(browser, built, [w, h], song, pos) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('http://gate.test/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/')
      return route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        `<link rel="stylesheet" href="/out.css"><style>${FONT_CSS}</style></head><body>` +
        '<main style="max-width:960px;margin:0 auto;padding:24px var(--sl-gutter,16px) 96px"><div id="root"></div></main>' +
        `<script>window.__snap=${JSON.stringify(snapAt(song, pos))};window.__grid=${JSON.stringify(song.grid)};</script>` +
        '<script>Promise.all([400,500,600,700].map(function(w){return document.fonts.load(w+" 16px GateInter")})).then(function(){var s=document.createElement("script");s.src="/out.js";document.body.appendChild(s)})</script>' +
        '</body></html>' });
    const fm = /^\/font-(\d+)\.woff2$/.exec(u.pathname);
    if (fm) return route.fulfill({ contentType: 'font/woff2', body: readFileSync(join(FONT_DIR, `inter-latin-${fm[1]}-normal.woff2`)) });
    if (u.pathname === '/out.js') return route.fulfill({ contentType: 'text/javascript', body: built.js });
    if (u.pathname === '/out.css') return route.fulfill({ contentType: 'text/css', body: built.css });
    if (u.pathname.endsWith('/play-chords')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ signed_url: '/signed.json', expires_in_sec: 60 }) });
    if (u.pathname === '/signed.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ segments: song.segments }) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://gate.test/');
  await page.waitForSelector('[data-testid="phone-chords"]', { timeout: 30000 });
  await page.click('[data-testid="player-more"]');
  await page.click('#player-menu button:has-text("See all chords")');
  await page.waitForSelector('[data-testid="chart-sheet"] [data-testid^="chord-chip-"]', { timeout: 30000 });
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-testid="chart-sheet"] [data-testid="zoom-slider"]');
    return s && !s.disabled;
  }, null, { timeout: 30000 });
  await settle(page);
  return { ctx, page, errors };
}

async function setSlider(page, thousandths) {
  const sel = '[data-testid="chart-sheet"] [data-testid="zoom-slider"]';
  const before = await page.evaluate(() => document.querySelector('[data-testid="chart-sheet"] [data-testid="chord-timeline"]').dataset.pxPerSec);
  const sliderBefore = await page.evaluate((s) => document.querySelector(s).value, sel);
  await page.evaluate(([s, v]) => {
    const el = document.querySelector(s);
    // React 18 installs its own `value` setter; the prototype's fires onChange.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [sel, thousandths]);
  if (String(thousandths) !== sliderBefore)
    await page.waitForFunction(
      (b) => document.querySelector('[data-testid="chart-sheet"] [data-testid="chord-timeline"]').dataset.pxPerSec !== b,
      before,
      { timeout: 10000 },
    );
  await settle(page);
}

// ---------------------------------------------------------------------------
// In-page measurement: only the DOM and the layout engine.
// ---------------------------------------------------------------------------
function measureSheet() {
  const sheet = document.querySelector('[data-testid="chart-sheet"]');
  const tl = sheet.querySelector('[data-testid="chord-timeline"]');
  const chips = [...sheet.querySelectorAll('[data-testid^="chord-chip-"]')].map((c) => {
    const r = c.getBoundingClientRect();
    const row = c.parentElement.getBoundingClientRect(); // the row's chip box
    const m = /^chord-chip-(\d+)(?:-r\d+)?$/.exec(c.dataset.testid);
    return {
      id: c.dataset.testid,
      run: m ? Number(m[1]) : -1,
      primary: /^chord-chip-\d+$/.test(c.dataset.testid),
      tag: c.tagName,
      density: c.dataset.density,
      x: r.left, y: r.top, w: r.width, h: r.height,
      rowL: row.left, rowR: row.right,
    };
  });
  // Row time labels: the gutter span that precedes each row (no testid).
  const rowsEl = sheet.querySelector('[data-testid="chord-rows"]');
  const labels = rowsEl
    ? [...rowsEl.children].map((row) => row.querySelector(':scope > span')?.textContent ?? null).filter((t) => t !== null)
    : [];
  const rings = [...sheet.querySelectorAll('[data-testid="chord-playhead-ring"]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { run: Number(el.dataset.runIndex), x: r.left, y: r.top, w: r.width, h: r.height, border: getComputedStyle(el).borderTopColor };
  });
  // Anything wider than the sheet makes it scroll sideways.
  let sheetOverflowX = 0;
  for (let e = tl; e && e !== sheet.parentElement; e = e.parentElement) sheetOverflowX = Math.max(sheetOverflowX, e.scrollWidth - e.clientWidth);
  sheetOverflowX = Math.max(sheetOverflowX, document.documentElement.scrollWidth - document.documentElement.clientWidth);
  return { sheetOverflowX, layout: tl?.dataset.layout ?? null, pps: Number(tl?.dataset.pxPerSec), chips, labels, rings };
}

const toSec = (t) => {
  const [m, s] = t.split(':').map(Number);
  return m * 60 + s;
};

function check(m, song, pos, f, ctx) {
  if (m.layout !== 'wrapped') f.push(`layout ${m.layout}, want wrapped @ ${ctx}`);
  const primaries = m.chips.filter((c) => c.primary).length;
  if (primaries !== song.segments.length) f.push(`${primaries} primary chips for ${song.segments.length} chords @ ${ctx}`);
  if (m.chips.length < song.segments.length) f.push(`only ${m.chips.length} chips measured @ ${ctx}`);
  for (const c of m.chips) {
    if (c.tag !== 'BUTTON') f.push(`${c.id} is a ${c.tag}, the gate expects buttons @ ${ctx}`);
    if (c.w < MIN_TAP || c.h < MIN_TAP)
      f.push(`${c.id} (${song.segments[c.run]?.label}, ${c.density}) is ${c.w.toFixed(2)}x${c.h.toFixed(2)}px < ${MIN_TAP} @ ${ctx}`);
  }
  // In its row: a chip pushed past the row's right edge is off the sheet.
  for (const c of m.chips)
    if (c.x < c.rowL - 0.5 || c.x + c.w > c.rowR + 0.5)
      f.push(`${c.id} spans ${c.x.toFixed(1)}-${(c.x + c.w).toFixed(1)}, outside its row ${c.rowL.toFixed(1)}-${c.rowR.toFixed(1)} @ ${ctx}`);
  if (m.sheetOverflowX > 0.5) f.push(`the sheet scrolls sideways by ${m.sheetOverflowX.toFixed(1)}px @ ${ctx}`);
  for (let i = 0; i < m.chips.length; i++)
    for (let j = i + 1; j < m.chips.length; j++) {
      const a = m.chips[i];
      const b = m.chips[j];
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ix > 0.01 && iy > 0.01) f.push(`${a.id} and ${b.id} overlap by ${ix.toFixed(2)}x${iy.toFixed(2)}px @ ${ctx}`);
    }
  // Time order: reading order (row, then x) never goes back in time.
  const reading = [...m.chips].sort((a, b) => (Math.abs(a.y - b.y) > 1 ? a.y - b.y : a.x - b.x));
  for (let i = 1; i < reading.length; i++)
    if (reading[i].run < reading[i - 1].run) f.push(`${reading[i].id} is read after ${reading[i - 1].id} @ ${ctx}`);
  for (let i = 1; i < m.labels.length; i++)
    if (toSec(m.labels[i]) < toSec(m.labels[i - 1])) f.push(`row label ${m.labels[i]} after ${m.labels[i - 1]} @ ${ctx}`);
  // The current chord: the ring is on a chip of the chord being heard, exactly.
  const heard = song.segments.findIndex((s) => s.start_sec <= pos && pos < s.end_sec);
  if (m.rings.length === 0) f.push(`no current-chord ring @ ${ctx}`);
  for (const r of m.rings) {
    if (r.run !== heard) f.push(`ring on chord ${r.run}, heard ${heard} @ ${ctx}`);
    const on = m.chips.find((c) => c.run === r.run && Math.abs(c.x - r.x) < 0.5 && Math.abs(c.y - r.y) < 0.5 && Math.abs(c.w - r.w) < 0.5);
    if (!on) f.push(`ring for chord ${r.run} at ${r.x.toFixed(1)},${r.y.toFixed(1)} w=${r.w.toFixed(1)} sits on no chip of it @ ${ctx}`);
  }
}

/** Tap the chips of the shortest chords for real and see which editor opens. */
async function tapShortest(page, song, f, ctx, n = 4) {
  const order = song.segments.map((s, i) => [s.end_sec - s.start_sec, i]).sort((a, b) => a[0] - b[0]).slice(0, n);
  for (const [, i] of order) {
    const sel = `[data-testid="chart-sheet"] [data-testid="chord-chip-${i}"]`;
    await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center', inline: 'center' }), sel);
    await settle(page);
    const p = await page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      // Where the left and right edges' inner points land, as well as the centre.
      const at = (px) => document.elementFromPoint(px, y)?.closest('[data-testid^="chord-chip-"]')?.dataset.testid ?? null;
      return { x, y, hits: [at(r.left + 1), at(x), at(r.right - 1)] };
    }, sel);
    for (const h of p.hits) if (h !== `chord-chip-${i}`) f.push(`a point inside chord-chip-${i} lands on ${h} @ ${ctx}`);
    await page.touchscreen.tap(p.x, p.y);
    const header = await page
      .waitForSelector('[data-testid="chord-popover-header"]', { timeout: 5000 })
      .then((h) => h.getAttribute('aria-label'))
      .catch(() => null);
    if (!header) f.push(`tapping chord-chip-${i} opened no editor @ ${ctx}`);
    else {
      const want = await page.evaluate((s) => document.querySelector(s).getAttribute('aria-label'), sel);
      if (!header.startsWith('Change ') || !want || !want.startsWith(header.slice('Change '.length)))
        f.push(`tapping chord-chip-${i} ("${want}") opened "${header}" @ ${ctx}`);
      await page.click('[data-testid="chord-popover"] button:has-text("Cancel")');
      await settle(page);
    }
  }
}

function fail(f) {
  if (f.length) assert.fail(`${f.length} finding(s):\n  ${f.slice(0, 40).join('\n  ')}${f.length > 40 ? `\n  ... and ${f.length - 40} more` : ''}`);
}

let browser;
let built;
test('Chromium launches and the real PlayerView bundles', async () => {
  built = await bundle();
  browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
  assert.ok(browser.isConnected());
});

for (const song of SONGS) {
  for (const vp of VIEWPORTS) {
    test(`QA-68 sheet chips >= ${MIN_TAP}px @ ${vp.join('x')}, ${song.name} (${song.segments.length} chords)`, async () => {
      // Play from inside the shortest chord, so the ring is on a widened chip.
      const shortest = song.segments.reduce((a, s) => (s.end_sec - s.start_sec < a.end_sec - a.start_sec ? s : a));
      const pos = (shortest.start_sec + shortest.end_sec) / 2;
      const { ctx, page, errors } = await open(browser, built, vp, song, pos);
      const f = [];
      let measured = 0;
      try {
        for (const stop of SLIDER_STOPS) {
          if (stop !== null) await setSlider(page, stop);
          const m = await page.evaluate(measureSheet);
          const ctxs = `${vp.join('x')} ${song.name} slider=${stop ?? 'default'} pps=${m.pps}`;
          check(m, song, pos, f, ctxs);
          measured += m.chips.length;
          await tapShortest(page, song, f, ctxs);
        }
        if (measured < song.segments.length * SLIDER_STOPS.length) f.push(`only ${measured} chips measured`);
        assert.deepEqual(errors, [], 'the page threw');
        fail(f);
      } finally {
        await ctx.close();
      }
    });
  }
}

test('teardown', async () => {
  await browser?.close();
});
