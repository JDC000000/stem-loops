// REAL-BROWSER GATE: the phone chord view (Stories 3 and 4.8 on phones).
//
// Renders the real PlayerView (real ChordOverlay + ChordPhone, real CSS) at
// 390x844 and 360x800, mobile + touch, fed the synthetic 4-minute two-chord-bar
// fixture through the real loader, with its beat grid passed the way Player
// passes it from the job's loops rows. Then checks, as rendered:
//   1. CURRENT CHORD: the "Now" name is visible, inside the viewport and not
//      clipped, at >= 24px computed and >= 24px text box, weight >= 600, and
//      names the chord the playhead is in (lead-sheet spelling).
//   2. SPLIT BARS: the bar being played holds two chords; BOTH render their
//      names (text node present, >= 11px, not clipped by the slot), and the
//      current one of the two is the one marked current.
//   3. AUTO-FOLLOW: moving the position across bars and lines moves the
//      current-bar marker with it and pages the two lines, without any input.
//   4. EVERY CHORD REACHABLE (#212): the "All chords" list below still has one
//      primary chip per segment.
// It FAILS (never skips) when Chromium or the page is missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const esbuild = require('esbuild');

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(process.env.CHORD_GATE_SRC ?? join(HERE, '../../../apps/web'));
const NOW_MIN_PX = 24;
const MIN_TEXT_PX = 11;
const EPS = 0.02;

const FONT_DIR = join(dirname(require.resolve('@fontsource/inter/package.json')), 'files');
const FONT_CSS =
  [400, 500, 600, 700].map((w) => `@font-face{font-family:GateInter;font-weight:${w};src:url(/font-${w}.woff2) format('woff2')}`).join('') +
  '[data-testid="chord-overlay"]{font-family:GateInter,sans-serif !important}';

const FIX = JSON.parse(readFileSync(join(WEB, 'test/fixtures/play-chords-4m-two-chord-bars.json'), 'utf8'));
const GRID = { beatSec: 60 / FIX._fixture.bpm, anchorSec: FIX._fixture.anchor_sec, measured: true };
const BAR_SEC = 4 * GRID.beatSec;
const { leadSheetSymbol } = await import(pathToFileURL(join(WEB, 'src/components/ChordOverlay.helpers.ts')).href);

// Positions inside two-chord bars: the second half of a split bar (Em7 | Am)
// and the first half of another (F | G).
const segs = FIX.segments;
const amAfterEm = segs.find((s, i) => i > 0 && s.label === 'A:min' && segs[i - 1].label === 'E:min7' && s.start_sec > 100);
const fBeforeG = segs.find((s, i) => s.label === 'F:maj' && segs[i + 1]?.label === 'G:maj' && s.end_sec - s.start_sec < BAR_SEC * 0.75 && s.start_sec > 30);
const SPLIT_CASES = [
  { name: 'second chord of a split bar', sec: amAfterEm.start_sec + 0.25, label: amAfterEm.label, other: 'E:min7' },
  { name: 'first chord of a split bar', sec: fBeforeG.start_sec + 0.25, label: fBeforeG.label, other: 'G:maj' },
];

const snapAt = (positionSec) => ({
  status: 'playing',
  positionSec,
  durationSec: FIX.duration_sec,
  stems: ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'].map((name) => ({ name, availability: 'ready', gain: 0.8, muted: false, soloed: false, effectivelySilent: false })),
  loop: null,
  degraded: null,
  error: null,
});

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
          jobId: 'phone-gate', phase: { kind: 'ready' }, snapshot,
          sections: window.__sections, beatGrid: window.__grid,
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

async function open(browser, built, [w, h], positionSec) {
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
        `<script>window.__snap=${JSON.stringify(snapAt(positionSec))};window.__sections=${JSON.stringify(FIX._fixture.sections)};window.__grid=${JSON.stringify(GRID)};</script>` +
        '<script>Promise.all([400,500,600,700].map(function(w){return document.fonts.load(w+" 16px GateInter")})).then(function(){var s=document.createElement("script");s.src="/out.js";document.body.appendChild(s)})</script>' +
        '</body></html>' });
    const fm = /^\/font-(\d+)\.woff2$/.exec(u.pathname);
    if (fm) return route.fulfill({ contentType: 'font/woff2', body: readFileSync(join(FONT_DIR, `inter-latin-${fm[1]}-normal.woff2`)) });
    if (u.pathname === '/out.js') return route.fulfill({ contentType: 'text/javascript', body: built.js });
    if (u.pathname === '/out.css') return route.fulfill({ contentType: 'text/css', body: built.css });
    if (u.pathname.endsWith('/play-chords')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ signed_url: '/signed.json', expires_in_sec: 60 }) });
    if (u.pathname === '/signed.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(FIX) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://gate.test/');
  await page.waitForSelector('[data-testid="phone-chords"]', { timeout: 30000 });
  await settle(page);
  return { ctx, page, errors };
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function moveTo(page, sec, snap) {
  await page.evaluate(({ s }) => window.__render(s), { s: snap });
  await page.waitForFunction((t) => {
    const el = document.querySelector('[data-testid="phone-beats"]');
    return !!el || t < 0;
  }, sec);
  await settle(page);
}

function measure() {
  const px = (v) => parseFloat(v) || 0;
  const name = document.querySelector('[data-testid="phone-chords"] [data-testid="playhead-now-name"]');
  const now = document.querySelector('[data-testid="phone-chords"] [data-testid="playhead-now"]');
  const out = { now: null, bar: null, lineBars: [], primaries: 0 };
  if (name) {
    name.scrollIntoView({ block: 'center', behavior: 'instant' });
    const cs = getComputedStyle(name);
    const rg = document.createRange();
    rg.selectNodeContents(name);
    const t = rg.getBoundingClientRect();
    const clippedBy = [];
    for (let e = name.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const ecs = getComputedStyle(e);
      if (ecs.overflowX !== 'visible' || ecs.overflowY !== 'visible') {
        const er = e.getBoundingClientRect();
        if (t.left < er.left - 0.02 || t.right > er.right + 0.02 || t.top < er.top - 0.02 || t.bottom > er.bottom + 0.02) clippedBy.push(e.tagName);
      }
    }
    out.now = {
      text: name.textContent,
      fontPx: px(cs.fontSize),
      weight: Number(cs.fontWeight),
      h: t.height,
      inViewport: t.left >= -0.02 && t.right <= innerWidth + 0.02 && t.top >= 0 && t.bottom <= innerHeight,
      visible: cs.visibility === 'visible' && cs.display !== 'none',
      clippedBy,
      runIndex: now?.dataset.runIndex,
    };
  }
  const bar = document.querySelector('[data-testid^="phone-bar-"][data-current="true"]');
  if (bar) {
    out.bar = {
      id: bar.dataset.testid,
      inCurrentLine: !!bar.closest('[data-testid="phone-line-current"]'),
      slots: [...bar.querySelectorAll('[data-testid^="phone-slot-"]')].map((s) => ({
        title: s.title,
        text: s.textContent,
        fontPx: px(getComputedStyle(s).fontSize),
        over: s.scrollWidth - s.clientWidth,
        current: s.dataset.current === 'true',
        runIndex: s.dataset.runIndex,
      })),
    };
  }
  out.lineBars = [...document.querySelectorAll('[data-testid="phone-line-current"] [data-testid^="phone-bar-"]')].map((b) => b.dataset.testid);
  out.primaries = [...document.querySelectorAll('[data-testid^="chord-chip-"]')].filter((c) => /^chord-chip-\d+$/.test(c.dataset.testid)).length;
  return out;
}

let browser;
let built;
test('Chromium launches and the real PlayerView bundles', async () => {
  built = await bundle();
  browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
  assert.ok(browser.isConnected());
});

for (const vp of [[390, 844], [360, 800]]) {
  for (const c of SPLIT_CASES) {
    test(`phone chords @ ${vp[0]}x${vp[1]}: ${c.name}`, async () => {
      const { ctx, page, errors } = await open(browser, built, vp, c.sec);
      try {
        const m = await page.evaluate(measure);
        const want = leadSheetSymbol({ kind: 'chord', label: c.label });
        const f = [];
        // 1. current chord
        if (!m.now) f.push('no current-chord readout in the phone view');
        else {
          if (m.now.text !== want) f.push(`current chord reads "${m.now.text}", playhead is in ${c.label} ("${want}")`);
          if (m.now.fontPx < NOW_MIN_PX) f.push(`current chord ${m.now.fontPx}px < ${NOW_MIN_PX}px`);
          if (m.now.h < NOW_MIN_PX) f.push(`current chord text box ${m.now.h.toFixed(1)}px < ${NOW_MIN_PX}px`);
          if (m.now.weight < 600) f.push(`current chord weight ${m.now.weight}`);
          if (!m.now.visible || !m.now.inViewport) f.push(`current chord not on screen (${JSON.stringify(m.now)})`);
          if (m.now.clippedBy.length) f.push(`current chord clipped by ${m.now.clippedBy.join(',')}`);
        }
        // 2. split bar
        if (!m.bar) f.push('no bar is marked current');
        else {
          if (!m.bar.inCurrentLine) f.push(`current bar ${m.bar.id} is not in the current line`);
          const titles = m.bar.slots.map((s) => s.title).sort();
          if (titles.join() !== [c.label, c.other].sort().join()) f.push(`current bar holds [${titles}], want [${c.label}, ${c.other}]`);
          for (const s of m.bar.slots) {
            if (!s.text) f.push(`split-bar chord ${s.title} renders no name`);
            if (s.fontPx < MIN_TEXT_PX) f.push(`split-bar chord ${s.title} is ${s.fontPx}px`);
            if (s.over > 0) f.push(`split-bar chord ${s.title} is clipped (${s.over}px)`);
          }
          const cur = m.bar.slots.filter((s) => s.current);
          if (cur.length !== 1 || cur[0].title !== c.label) f.push(`marked-current slot is [${cur.map((s) => s.title)}], want ${c.label}`);
          if (cur[0] && m.now && cur[0].runIndex !== m.now.runIndex) f.push('the Now card and the current slot disagree on the run');
        }
        // 4. every chord still reachable below
        if (m.primaries !== FIX.segments.length) f.push(`${m.primaries} primary chips in All chords for ${FIX.segments.length} segments`);
        assert.deepEqual(errors, [], 'the page threw');
        if (f.length) assert.fail(`GATE-FAIL ${f.length} finding(s) @ ${vp.join('x')} ${c.name}:\n  ${f.join('\n  ')}`);
      } finally {
        await ctx.close();
      }
    });
  }

  test(`phone chords @ ${vp[0]}x${vp[1]}: auto-follows across bars and lines`, async () => {
    const start = SPLIT_CASES[0].sec;
    const { ctx, page, errors } = await open(browser, built, vp, start);
    try {
      const seen = [];
      // Walk 9 bars forward one bar at a time: crosses at least two line boundaries.
      for (let k = 0; k <= 9; k++) {
        const sec = start + k * BAR_SEC;
        await moveTo(page, sec, snapAt(sec));
        const m = await page.evaluate(measure);
        assert.ok(m.bar, `no current bar at ${sec.toFixed(2)}s`);
        assert.ok(m.bar.inCurrentLine, `current bar ${m.bar.id} is not in the current line at ${sec.toFixed(2)}s`);
        assert.ok(m.lineBars.includes(m.bar.id), 'current line does not contain the current bar');
        const seg = FIX.segments.find((s) => s.start_sec <= sec && sec < s.end_sec);
        assert.equal(m.now.text, leadSheetSymbol({ kind: seg.label === 'N' ? 'none' : 'chord', label: seg.label }), `Now card at ${sec.toFixed(2)}s`);
        seen.push({ bar: m.bar.id, line: m.lineBars[0] });
      }
      const bars = seen.map((s) => Number(s.bar.replace('phone-bar-', '')));
      for (let i = 1; i < bars.length; i++) assert.equal(bars[i], bars[i - 1] + 1, `current bar did not advance by one: ${bars.join(',')}`);
      const lines = new Set(seen.map((s) => s.line));
      assert.ok(lines.size >= 3, `the lines did not page (${[...lines].join(',')})`);
      assert.deepEqual(errors, [], 'the page threw');
    } finally {
      await ctx.close();
    }
  });
}

test('teardown', async () => {
  if (browser) await browser.close();
});
