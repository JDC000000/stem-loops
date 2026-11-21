// REAL-BROWSER GATE: QA-68 + QA-73, the "See all chords" sheet's chips are tap
// targets on EVERY viewport class: phones (the wrapped rows, QA-68, #324) and
// tablets in both orientations and desktop (the strip, QA-73).
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
// QA-73 adds, per layout:
//
//   * WRAPPED: each row's gutter time is the true start of its first chip
//     (from the payload), so a split row cannot keep its parent's time; and
//     the hint says "up to Ns per row" exactly when a row was split (more rows
//     than the song's length over the row length).
//   * STRIP: every ruler tick sits inside the chip of the chord sounding at the
//     tick's time (or in the gap where no chord is), so widening short chips
//     cannot leave the ruler lying about time; the playhead line sits on the
//     ring's left edge.
//
// Viewports: 320x568, 360x800, 390x844 (phones, wrapped) and 768x1024,
// 1024x768, 1280x800, 1440x900 (tablet portrait and landscape, desktop:
// strip), at the default zoom and at both ends of the zoom slider. The
// zoomed-out end is the worst case, with the most chips per row or per screen.
// It FAILS (never skips) when Chromium or the page is missing. Expected values
// come from the payloads built HERE, never from the component's helpers. The
// floor is the literal 24 below, and the gate checks that the app's single
// shared constant (src/components/tapTarget.ts) is that same 24, so the app
// cannot lower its floor without this gate failing.

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
// [width, height, the layout the sheet must use there]
const VIEWPORTS = [
  [320, 568, 'wrapped'], [360, 800, 'wrapped'], [390, 844, 'wrapped'],
  [768, 1024, 'strip'], [1024, 768, 'strip'], [1280, 800, 'strip'], [1440, 900, 'strip'],
];
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
  // Short enough to fit a tablet screen with every chip at 24px (QA-73 M-1:
  // then the zoomed-out strip must fit the screen, as before the fix).
  { name: 'short', ...songOf(Array.from({ length: 8 }, (_, i) => QA01[i % QA01.length]), 100) },
];
const BOX = MIN_TAP + 1; // a chip and its 1px gap: the strip's box per chord (plus 0.02px slack)

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
  // Phones and tablets are mobile; desktops are not, but get a touchscreen so a
  // real tap can be made (touch laptops exist, and the floor is the same).
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 1200, hasTouch: true });
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
  // Wrapped rows: the gutter label and the chips of each row, in DOM order.
  const rowsEl = sheet.querySelector('[data-testid="chord-rows"]');
  const rows = rowsEl
    ? [...rowsEl.children]
        .filter((row) => row.querySelector(':scope > span'))
        .map((row) => {
          const box = row.querySelector(':scope > div');
          const ids = [...box.querySelectorAll('[data-testid^="chord-chip-"]')]
            .map((c) => ({ id: c.dataset.testid, x: c.getBoundingClientRect().left }))
            .sort((a, b) => a.x - b.x)
            .map((c) => c.id);
          return { label: row.querySelector(':scope > span').textContent, ids, widthPx: box.getBoundingClientRect().width };
        })
    : [];
  const labels = rows.map((r) => r.label);
  const rings = [...sheet.querySelectorAll('[data-testid="chord-playhead-ring"]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { run: Number(el.dataset.runIndex), x: r.left, y: r.top, w: r.width, h: r.height, border: getComputedStyle(el).borderTopColor };
  });
  const lines = [...sheet.querySelectorAll('[data-testid="chord-playhead"]')].map((el) => ({ x: el.getBoundingClientRect().left }));
  // Strip ruler ticks: the tick's time is in its testid, its place is its left edge.
  const ticks = [...sheet.querySelectorAll('[data-testid="time-ruler"] [data-testid^="tick-"]')].map((el) => ({
    sec: Number(el.dataset.testid.slice('tick-'.length)),
    label: el.textContent,
    x: el.getBoundingClientRect().left,
  }));
  const hint = sheet.querySelector('[data-testid="timeline-hint"]')?.textContent ?? '';
  const sc = sheet.querySelector('[data-testid="chord-scroll"]');
  const scroll = sc ? { scrollWidth: sc.scrollWidth, clientWidth: sc.clientWidth, scrollLeft: sc.scrollLeft } : null;
  // Anything wider than the sheet makes it scroll sideways.
  let sheetOverflowX = 0;
  for (let e = tl; e && e !== sheet.parentElement; e = e.parentElement) sheetOverflowX = Math.max(sheetOverflowX, e.scrollWidth - e.clientWidth);
  sheetOverflowX = Math.max(sheetOverflowX, document.documentElement.scrollWidth - document.documentElement.clientWidth);
  return { sheetOverflowX, layout: tl?.dataset.layout ?? null, pps: Number(tl?.dataset.pxPerSec), chips, labels, rows, rings, lines, ticks, hint, scroll };
}

const toSec = (t) => {
  const [m, s] = t.split(':').map(Number);
  return m * 60 + s;
};

function check(m, song, pos, f, ctx, wantLayout) {
  if (m.layout !== wantLayout) f.push(`layout ${m.layout}, want ${wantLayout} @ ${ctx}`);
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
  if (m.layout === 'wrapped') checkWrappedTimes(m, song, f, ctx);
  if (m.layout === 'strip') checkStripTimes(m, song, f, ctx);
  if (m.layout === 'strip') checkStripDurations(m, song, f, ctx);
  // The current chord: the ring is on a chip of the chord being heard, exactly.
  const heard = song.segments.findIndex((s) => s.start_sec <= pos && pos < s.end_sec);
  if (m.rings.length === 0) f.push(`no current-chord ring @ ${ctx}`);
  for (const r of m.rings) {
    if (r.run !== heard) f.push(`ring on chord ${r.run}, heard ${heard} @ ${ctx}`);
    const on = m.chips.find((c) => c.run === r.run && Math.abs(c.x - r.x) < 0.5 && Math.abs(c.y - r.y) < 0.5 && Math.abs(c.w - r.w) < 0.5);
    if (!on) f.push(`ring for chord ${r.run} at ${r.x.toFixed(1)},${r.y.toFixed(1)} w=${r.w.toFixed(1)} sits on no chip of it @ ${ctx}`);
  }
}

const runOf = (id) => Number(/^chord-chip-(\d+)/.exec(id)[1]);
const floorSec = (t) => Math.floor(t + 1e-6);

/**
 * QA-73 (#324 review m-4): the gutter time of every wrapped row is TRUE, and
 * the hint's "up to" is there exactly when a row was split.
 *
 * A row's label L (whole seconds, as shown) must lie between the end of the
 * chord before the row's first chip and that chip's own start, when the first
 * chip is the START of a chord; and inside that chord's span when the first
 * chip is a continuation (the chord began on the row above). The gate songs
 * have no gaps between chords, so for a chord start this is exact: a split row
 * that kept its parent row's time fails here.
 */
function checkWrappedTimes(m, song, f, ctx) {
  const segs = song.segments;
  if (m.rows.length === 0) f.push(`no wrapped rows measured @ ${ctx}`);
  for (const [ri, row] of m.rows.entries()) {
    if (row.ids.length === 0) {
      f.push(`row ${ri} (${row.label}) has no chips @ ${ctx}`);
      continue;
    }
    const first = row.ids[0];
    const i = runOf(first);
    const L = toSec(row.label);
    const primary = /^chord-chip-\d+$/.test(first);
    const lo = primary ? (i > 0 ? segs[i - 1].end_sec : 0) : segs[i].start_sec;
    const hi = primary ? segs[i].start_sec : segs[i].end_sec;
    if (L < floorSec(lo - 2e-6) || L > floorSec(hi))
      f.push(`row ${ri} is labelled ${row.label}, but its first chip ${first} (${segs[i].label}) ${primary ? 'starts' : 'continues a chord'} at ${segs[i].start_sec.toFixed(3)}s (allowed ${floorSec(lo - 2e-6)}-${floorSec(hi)}s) @ ${ctx}`);
  }
  // "up to": the rows are rowSec long unless one was split. rowSec is the row's
  // width over the zoom. More rows than ceil(song / rowSec) means a split.
  const rowWidth = m.rows[0]?.widthPx ?? 0;
  if (rowWidth > 0 && m.pps > 0) {
    const nominal = song.segments.at(-1).end_sec / (rowWidth / m.pps);
    const frac = nominal - Math.floor(nominal);
    const ambiguous = frac < 1e-3 || frac > 1 - 1e-3; // pps is printed to 3 dp
    const split = m.rows.length > Math.ceil(nominal - 1e-9);
    const saysUpTo = /\bup to \d+s per row\b/.test(m.hint);
    if (!/\d+s per row/.test(m.hint)) f.push(`hint "${m.hint}" names no row length @ ${ctx}`);
    if (!ambiguous && split !== saysUpTo)
      f.push(`${m.rows.length} rows for ${Math.ceil(nominal - 1e-9)} row lengths (split=${split}), but the hint ${saysUpTo ? 'says' : 'does not say'} "up to": "${m.hint}" @ ${ctx}`);
    m.split = split;
    m.saysUpTo = saysUpTo;
  }
}

/**
 * QA-73 review M-1: the strip still shows how long chords last. Widening is
 * ADDITIVE: a chord whose proportional width (duration x zoom) is at least
 * the box keeps exactly that width; a shorter one gets exactly the box. At the
 * zoom-out end (m.zoomedOut) a song that fits the screen at 24px per chip
 * does fit it, and one that does not still draws long chords >= 1.5x the box.
 */
function checkStripDurations(m, song, f, ctx) {
  const segs = song.segments;
  for (const c of m.chips.filter((x) => x.primary)) {
    const prop = (segs[c.run].end_sec - segs[c.run].start_sec) * m.pps;
    // Drawn = box width less the 1px gap. pps is printed to 3 dp.
    const want = prop >= BOX + 0.02 ? prop - 1 : BOX - 1 + 0.02;
    if (Math.abs(c.w - want) > 0.6)
      f.push(`${c.id} (${segs[c.run].label}, ${(segs[c.run].end_sec - segs[c.run].start_sec).toFixed(2)}s) is ${c.w.toFixed(2)}px wide, want ${want.toFixed(2)} (${prop >= BOX ? 'its proportional width' : 'the tap box'}) @ ${ctx}`);
  }
  if (m.zoomedOut && m.scroll) {
    const canFit = segs.length * (BOX + 0.02) <= m.scroll.clientWidth;
    const scrolls = m.scroll.scrollWidth > m.scroll.clientWidth + 1;
    if (canFit && scrolls) f.push(`${segs.length} chords fit ${m.scroll.clientWidth}px at 24px each, but the zoomed-out strip is ${m.scroll.scrollWidth}px @ ${ctx}`);
    if (!canFit) {
      const ws = m.chips.filter((x) => x.primary).map((x) => x.w);
      if (Math.max(...ws) < 1.5 * Math.min(...ws) - 1) f.push(`zoomed out, the widest chip is ${Math.max(...ws).toFixed(1)}px and the narrowest ${Math.min(...ws).toFixed(1)}px: durations are gone @ ${ctx}`);
    }
  }
}

/** The time drawn at screen x, from the payload's times and the chips' DOM boxes only. */
function timeAtX(m, song, x) {
  const segs = song.segments;
  const prim = m.chips.filter((c) => c.primary).sort((a, b) => a.x - b.x);
  const k = [[0, m.stripL]];
  for (const c of prim) {
    k.push([segs[c.run].start_sec, c.x]);
    k.push([segs[c.run].end_sec, c.x + c.w + 1]); // the box: chip + its 1px gap
  }
  k.push([segs.at(-1).end_sec, m.stripR]);
  if (x <= k[0][1]) return 0;
  for (let i = 1; i < k.length; i++)
    if (x <= k[i][1]) return k[i][1] > k[i - 1][1] ? k[i - 1][0] + ((x - k[i - 1][1]) / (k[i][1] - k[i - 1][1])) * (k[i][0] - k[i - 1][0]) : k[i][0];
  return segs.at(-1).end_sec;
}
const fmt = (t) => `${Math.floor(Math.floor(t) / 60)}:${String(Math.floor(t) % 60).padStart(2, '0')}`;
const fmtOk = (shown, t) => shown === fmt(t) || shown === fmt(t + 0.05) || shown === fmt(Math.max(0, t - 0.05));

/**
 * QA-73 review m-2: the "Showing a–b of N" hint and zoom centring use the same
 * time map as the chips. Scrolled to mid-song, "a" and "b" must be the times
 * drawn at the viewport's edges, and a zoom must keep the chord at the centre
 * of the viewport there (+-1 chord).
 */
async function checkStripHintAndCentre(page, song, f, ctx) {
  // Paused, with no chord sounding: while a chord plays off screen, a zoom
  // re-engages auto-follow and scrolls back to it (pre-existing, by design:
  // resolveAutoScroll), which would hide what zoom centring does.
  await page.evaluate(() => window.__render({ ...window.__snap, status: 'paused', positionSec: null }));
  await settle(page);
  const probe = () =>
    page.evaluate(() => {
      const sheet = document.querySelector('[data-testid="chart-sheet"]');
      const sc = sheet.querySelector('[data-testid="chord-scroll"]');
      const r = sc.getBoundingClientRect();
      const inner = sc.firstElementChild.getBoundingClientRect();
      const chipBox = sheet.querySelector('[data-testid^="chord-chip-"]').getBoundingClientRect();
      const x0 = r.left + sc.clientLeft;
      const cx = x0 + sc.clientWidth / 2;
      const atC = document.elementFromPoint(cx, chipBox.top + chipBox.height / 2)?.closest('[data-testid^="chord-chip-"]')?.dataset.testid ?? null;
      const chips = [...sheet.querySelectorAll('[data-testid^="chord-chip-"]')].map((c) => {
        const b = c.getBoundingClientRect();
        const mm = /^chord-chip-(\d+)$/.exec(c.dataset.testid);
        return { run: mm ? Number(mm[1]) : -1, primary: !!mm, x: b.left, w: b.width };
      });
      return {
        x0, x1: x0 + sc.clientWidth, cx, atC, chips, stripL: inner.left, stripR: inner.left + sc.scrollWidth,
        scrollable: sc.scrollWidth - sc.clientWidth, sl: sc.scrollLeft,
        hint: sheet.querySelector('[data-testid="timeline-hint"]')?.textContent ?? '',
        pps: sheet.querySelector('[data-testid="chord-timeline"]').dataset.pxPerSec,
      };
    });
  let p = await probe();
  if (p.scrollable < 50) {
    f.push(`the strip does not scroll (${p.scrollable}px), so the hint/centring check measured nothing @ ${ctx}`);
    return;
  }
  await page.evaluate(() => {
    const sc = document.querySelector('[data-testid="chart-sheet"] [data-testid="chord-scroll"]');
    sc.scrollLeft = Math.round((sc.scrollWidth - sc.clientWidth) * 0.6);
    sc.dispatchEvent(new Event('scroll'));
  });
  await settle(page);
  await settle(page);
  p = await probe();
  const mm = /Showing (\d+:\d\d)–(\d+:\d\d) of/.exec(p.hint);
  if (!mm) f.push(`strip hint "${p.hint}" has no "Showing a–b" @ ${ctx}`);
  else {
    const ta = timeAtX(p, song, p.x0);
    const tb = timeAtX(p, song, p.x1);
    if (!fmtOk(mm[1], ta) || !fmtOk(mm[2], tb))
      f.push(`hint says ${mm[1]}–${mm[2]}, the viewport edges are drawn at ${ta.toFixed(2)}s–${tb.toFixed(2)}s @ ${ctx}`);
  }
  const before = p.atC ? Number(/^chord-chip-(\d+)/.exec(p.atC)[1]) : null;
  const btn = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="chart-sheet"]');
    return s.querySelector('[data-testid="zoom-in"]').disabled ? 'zoom-out' : 'zoom-in';
  });
  await page.click(`[data-testid="chart-sheet"] [data-testid="${btn}"]`);
  await page.waitForFunction((b) => document.querySelector('[data-testid="chart-sheet"] [data-testid="chord-timeline"]').dataset.pxPerSec !== b, p.pps, { timeout: 10000 });
  await settle(page);
  await settle(page);
  const q = await probe();
  const after = q.atC ? Number(/^chord-chip-(\d+)/.exec(q.atC)[1]) : null;
  if (before === null || after === null || Math.abs(after - before) > 1)
    f.push(`${btn}: chord ${before} was at the centre, chord ${after} is now (pps ${p.pps} -> ${q.pps}) @ ${ctx}`);
  if (Math.abs(q.sl - p.sl) < 20) f.push(`the zoom did not move the scroller (${p.sl} -> ${q.sl}), so centring was not exercised @ ${ctx}`);
  await page.evaluate(() => window.__render(window.__snap));
  await settle(page);
}

/**
 * QA-73: the strip's ruler and playhead line stay true once short chips are
 * widened. A tick at time t must sit inside the chip of the chord sounding at
 * t (between its left edge and the next chip's left edge, which takes in the
 * 1px gap), or, in a stretch with no chord, between the chips around it.
 */
function checkStripTimes(m, song, f, ctx) {
  const segs = song.segments;
  const prim = new Map(m.chips.filter((c) => c.primary).map((c) => [c.run, c]));
  if (m.ticks.length < 2) f.push(`only ${m.ticks.length} ruler ticks @ ${ctx}`);
  const x0 = m.chips.length ? Math.min(...m.chips.map((c) => c.rowL)) : 0;
  for (const t of m.ticks) {
    if (t.label !== `${Math.floor(t.sec / 60)}:${String(t.sec % 60).padStart(2, '0')}`) f.push(`tick-${t.sec} reads "${t.label}" @ ${ctx}`);
    const i = segs.findIndex((s) => s.start_sec <= t.sec && t.sec < s.end_sec);
    let lo;
    let hi;
    if (i >= 0) {
      const c = prim.get(i);
      if (!c) continue; // reported elsewhere (primary count)
      lo = c.x;
      hi = prim.get(i + 1)?.x ?? c.x + c.w + 1;
    } else {
      const before = segs.findLastIndex((s) => s.end_sec <= t.sec);
      const after = segs.findIndex((s) => s.start_sec > t.sec);
      lo = before >= 0 && prim.get(before) ? prim.get(before).x + prim.get(before).w : x0;
      hi = after >= 0 && prim.get(after) ? prim.get(after).x : Infinity;
    }
    if (t.x < lo - 0.5 || t.x > hi + 0.5)
      f.push(`tick ${t.label} at ${t.x.toFixed(1)} is outside ${i >= 0 ? `the chip of ${segs[i].label} (chord ${i})` : 'the gap it is in'}, ${lo.toFixed(1)}-${hi.toFixed(1)} @ ${ctx}`);
  }
  for (const l of m.lines) {
    const r = m.rings[0];
    if (r && Math.abs(l.x - r.x) > 0.5) f.push(`playhead line at ${l.x.toFixed(1)}, ring at ${r.x.toFixed(1)} @ ${ctx}`);
  }
  if (m.rings.length && m.lines.length !== 1) f.push(`${m.lines.length} playhead lines @ ${ctx}`);
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

const summary = [];
for (const song of SONGS) {
  for (const [w, h, wantLayout] of VIEWPORTS) {
    const vp = [w, h];
    test(`QA-68/QA-73 sheet chips >= ${MIN_TAP}px @ ${vp.join('x')} (${wantLayout}), ${song.name} (${song.segments.length} chords)`, async () => {
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
          m.zoomedOut = stop === 0;
          const ctxs = `${vp.join('x')} ${song.name} slider=${stop ?? 'default'} pps=${m.pps}`;
          check(m, song, pos, f, ctxs, wantLayout);
          if (stop === null && m.layout === 'strip' && song.name !== 'short') await checkStripHintAndCentre(page, song, f, ctxs);
          measured += m.chips.length;
          summary.push({ vp: vp.join('x'), layout: m.layout, song: song.name, stop: stop ?? 'default', min: Math.min(...m.chips.map((c) => Math.min(c.w, c.h))), under: m.chips.filter((c) => c.w < MIN_TAP || c.h < MIN_TAP).length, chips: m.chips.length, split: m.split, upTo: m.saysUpTo, pps: m.pps, screens: m.scroll ? m.scroll.scrollWidth / m.scroll.clientWidth : null, widths: Object.fromEntries(m.chips.filter((c) => c.primary).map((c) => [(song.segments[c.run].end_sec - song.segments[c.run].start_sec).toFixed(2), c.w])) });
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

test('QA-73: the app has ONE tap floor, and it is this gate\'s 24', async () => {
  const { MIN_TAP_PX } = await import(join(WEB, 'src/components/tapTarget.ts'));
  assert.equal(MIN_TAP_PX, MIN_TAP);
});

test('QA-73: the "up to" and split-row checks were exercised (non-vacuous)', () => {
  if (process.env.CHORD_GATE_SUMMARY) console.log(`SUMMARY ${JSON.stringify(summary)}`);
  const wrapped = summary.filter((r) => r.layout === 'wrapped');
  assert.ok(wrapped.some((r) => r.split && r.upTo), 'no measured view split a row and said "up to"');
  assert.ok(wrapped.some((r) => r.split === false && r.upTo === false), 'no measured view was unsplit without "up to"');
  assert.ok(summary.some((r) => r.layout === 'strip'), 'no strip view measured');
});

test('teardown', async () => {
  await browser?.close();
});
