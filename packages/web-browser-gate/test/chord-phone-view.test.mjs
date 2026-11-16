// REAL-BROWSER GATE: the phone chord view (Stories 3 and 4.8 on phones).
//
// Renders the real PlayerView (real ChordOverlay, real CSS) at 390x844 and
// 360x800, mobile + touch, through the real chord loader, and checks what
// RENDERS against expectations computed HERE from the fixture's own truth
// (planted 96 bpm bars, planted sections), never from the component's helpers:
//
//  SWEEP (every bar of the 4:12 fixture is the current bar once, so every bar
//  is drawn in a current or next line at least once), at each position:
//   * Now: the chord heard, lead-sheet spelling, >= 24px / 600, on screen, unclipped.
//   * the position line "Chorus 2 · bar 3/16" and the lit beat dot;
//   * Next: the next different chord and "in N beats";
//   * exactly ONE current bar (aria-current) and ONE current chord
//     (aria-current), in the current line, the chord heard;
//   * the current line holds the expected bars of its section (lines start at
//     bar 1, 5, 9 ... of a section) and the next line starts where expected;
//   * EVERY visible chord slot: a name (never blank), the chart spelling of its
//     own data, >= 14px, not clipped, accessible name starting with the visible
//     text, white-on-colour contrast >= 4.5:1;
//   * bar numbers >= 4.5:1 against what is under them; inactive beat dots >= 3:1;
//   * no aria-live inside the view.
//  LOOP: near the end of a looped section, Next is the chord at the loop start
//   ("Loop back to") and the next line is the loop's first line.
//  GAP: in a gap in the chord data, Next is the next chord after the playhead.
//  NO GRID: a plain chord sequence; no beat dots, no beat counts, no bar
//   numbers, no split cells; names still >= 14px and never blank.
//  METER: 3/4 and 6/8-in-eighths get 3-beat bars (3 dots, "Bar n" with NO
//   total, the song's own chords per bar, split bars); an uncertain meter gets
//   the plain list; 4/4 with two chords per bar keeps 4-beat bars and "n/N".
//  BAR TOTAL (S5 on #281; Jon: "No total when unsure"): walking every bar,
//   4/4 shows "Bar n/N" with N = the distinct bars rendered; triple time (3/4
//   or 6/8, unknowable from the data) at 120, 150 and 180 shows "Bar n" and
//   "Bar n, ..." names with no total, on 3-beat cells on the downbeats.
//  #212: the "All chords" list below keeps one primary chip per segment.
// It FAILS (never skips) when Chromium or the page is missing.

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
const NOW_MIN_PX = 24;
const NAME_MIN_PX = 14;
const TEXT_CONTRAST = 4.5;
const NONTEXT_CONTRAST = 3;

const FONT_DIR = join(dirname(require.resolve('@fontsource/inter/package.json')), 'files');
const FONT_CSS =
  [400, 500, 600, 700].map((w) => `@font-face{font-family:GateInter;font-weight:${w};src:url(/font-${w}.woff2) format('woff2')}`).join('') +
  '[data-testid="chord-overlay"]{font-family:GateInter,sans-serif !important}';

// ---------------------------------------------------------------------------
// Fixture truth (independent of the component)
// ---------------------------------------------------------------------------
const FIX = JSON.parse(readFileSync(join(WEB, 'test/fixtures/play-chords-4m-two-chord-bars.json'), 'utf8'));
const F = FIX._fixture;
const BEAT = 60 / F.bpm;
const BAR = 4 * BEAT;
const DOWN = F.first_downbeat_sec;
const GRID = { beatSec: BEAT, anchorSec: F.anchor_sec, measured: true };
const NAMES = ['Intro', 'Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Chorus 3', 'Outro'];
// Section i's true first bar: its worker start is one beat before the downbeat (intro: the first downbeat).
const SEC_FIRST_BAR = F.sections.map((s, i) => (i === 0 ? 0 : Math.round((s.startSec + BEAT - DOWN) / BAR)));
const SEC_BARS = SEC_FIRST_BAR.map((b, i) => (i + 1 < SEC_FIRST_BAR.length ? SEC_FIRST_BAR[i + 1] : F.bars) - b);

// Independent lead-sheet spelling for the labels this fixture uses.
const SPELL = {
  'C:maj': 'C', 'G:maj': 'G', 'A:min': 'Am', 'F:maj': 'F', 'A:min7': 'Am7', 'D:min7': 'Dm7', 'G:7': 'G7', 'E:min7': 'Em7',
  'C:maj/3': 'C/E', 'E:min': 'Em', 'Bb:maj': 'Bb', 'G:maj/3': 'G/B', 'C#:hdim7/5': 'C#m7b5/G#', N: 'N.C.',
};
const spell = (l) => {
  assert.ok(l in SPELL, `test has no spelling for ${l}`);
  return SPELL[l];
};

function truthAt(t, segs = FIX.segments) {
  const k = Math.floor((t - DOWN) / BAR + 1e-9);
  const sec = SEC_FIRST_BAR.findLastIndex((b) => b <= k);
  const inSec = k - SEC_FIRST_BAR[sec];
  const heard = segs.find((s) => s.start_sec <= t && t < s.end_sec) ?? null;
  const nxt = segs.find((s) => s.start_sec > t && s.label !== 'N' && (!heard || s.label !== heard.label)) ?? null;
  const lineFirst = SEC_FIRST_BAR[sec] + 4 * Math.floor(inSec / 4);
  const lineLast = Math.min(lineFirst + 3, SEC_FIRST_BAR[sec] + SEC_BARS[sec] - 1);
  const nextLineFirst = lineLast + 1 < F.bars ? lineLast + 1 : null;
  return {
    k,
    label: `${NAMES[sec]} · bar ${inSec + 1}/${SEC_BARS[sec]}`,
    beat: Math.floor((t - (DOWN + k * BAR)) / BEAT + 1e-9) + 1,
    heard,
    next: nxt,
    count: nxt ? Math.max(1, Math.ceil((nxt.start_sec - t) / BEAT - 0.05)) : null,
    lineBars: Array.from({ length: lineLast - lineFirst + 1 }, (_, i) => barTag(lineFirst + i)),
    nextLineFirst: nextLineFirst === null ? null : barTag(nextLineFirst),
  };
}
function barTag(k) {
  const sec = SEC_FIRST_BAR.findLastIndex((b) => b <= k);
  // The bar's chords in order: every segment holding at least half a beat of it.
  const bs = DOWN + k * BAR;
  const chords = FIX.segments
    .filter((s) => Math.min(s.end_sec, bs + BAR) - Math.max(s.start_sec, bs) >= 0.5 * BEAT)
    .map((s) => spell(s.label));
  return `Bar ${k - SEC_FIRST_BAR[sec] + 1} of ${SEC_BARS[sec]}, ${NAMES[sec]}: ${chords.join(', ')}`;
}

const snapAt = (positionSec, loop = null) => ({
  status: 'playing',
  positionSec,
  durationSec: FIX.duration_sec,
  stems: ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'].map((name) => ({ name, availability: 'ready', gain: 0.8, muted: false, soloed: false, effectivelySilent: false })),
  loop,
  degraded: null,
  error: null,
});

// ---------------------------------------------------------------------------
// Harness
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

async function open(browser, built, [w, h], { pos, grid = GRID, sections = F.sections, payload = FIX, loop = null }) {
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
        `<script>window.__snap=${JSON.stringify(snapAt(pos, loop))};window.__sections=${JSON.stringify(sections)};window.__grid=${JSON.stringify(grid)};</script>` +
        '<script>Promise.all([400,500,600,700].map(function(w){return document.fonts.load(w+" 16px GateInter")})).then(function(){var s=document.createElement("script");s.src="/out.js";document.body.appendChild(s)})</script>' +
        '</body></html>' });
    const fm = /^\/font-(\d+)\.woff2$/.exec(u.pathname);
    if (fm) return route.fulfill({ contentType: 'font/woff2', body: readFileSync(join(FONT_DIR, `inter-latin-${fm[1]}-normal.woff2`)) });
    if (u.pathname === '/out.js') return route.fulfill({ contentType: 'text/javascript', body: built.js });
    if (u.pathname === '/out.css') return route.fulfill({ contentType: 'text/css', body: built.css });
    if (u.pathname.endsWith('/play-chords')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ signed_url: '/signed.json', expires_in_sec: 60 }) });
    if (u.pathname === '/signed.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://gate.test/');
  await page.waitForSelector('[data-testid="phone-chords"]', { timeout: 30000 });
  await settle(page);
  return { ctx, page, errors };
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function moveTo(page, pos, loop = null) {
  await page.evaluate((s) => window.__render(s), snapAt(pos, loop));
  await settle(page);
}

// ---------------------------------------------------------------------------
// In-page measurement
// ---------------------------------------------------------------------------
function measure() {
  const px = (v) => parseFloat(v) || 0;
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return [0, 0, 0, 0];
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
  const effBg = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let base = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  const lum = (rgb) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const textContrast = (el) => {
    const bg = effBg(el);
    return ratio(over(parse(getComputedStyle(el).color), bg), bg);
  };
  const root = document.querySelector('[data-testid="phone-chords"]');
  const out = { mode: root?.dataset.mode, beatsPerBar: root?.dataset.beatsPerBar, reason: root?.dataset.reason, now: null, position: null, beat: null, dots: [], next: null, curCells: [], curSlots: [], lineCur: [], lineNextFirst: null, slots: [], barNumbers: [], live: 0, primaries: 0, cellsMulti: 0 };
  if (!root) return out;
  const name = root.querySelector('[data-testid="playhead-now-name"]');
  if (name) {
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
    const nx = root.querySelector('[data-testid="phone-next"]');
    let overlap = null;
    if (nx) {
      // Every box Next paints (label and chord) against the Now name's text box.
      for (const el of [nx, ...nx.querySelectorAll('*')]) {
        const r = el.getBoundingClientRect();
        const ix = Math.min(t.right, r.right) - Math.max(t.left, r.left);
        const iy = Math.min(t.bottom, r.bottom) - Math.max(t.top, r.top);
        if (ix > 0.5 && iy > 0.5) overlap = `${el.dataset.testid ?? el.tagName} ${ix.toFixed(1)}x${iy.toFixed(1)}px`;
      }
    }
    out.now = { text: name.textContent, fontPx: px(cs.fontSize), weight: Number(cs.fontWeight), h: t.height, inX: t.left >= -0.02 && t.right <= innerWidth + 0.02, clippedBy, overlap, fit: name.dataset.fit };
  }
  out.position = root.querySelector('[data-testid="phone-position"]')?.textContent ?? null;
  out.beat = root.querySelector('[data-testid="phone-beats"]')?.dataset.beat ?? null;
  out.dots = [...root.querySelectorAll('[data-testid="phone-beat-dot"]')].map((d) => ({ on: d.dataset.on === 'true', c: ratio(over(parse(getComputedStyle(d).backgroundColor), effBg(d.parentElement)), effBg(d.parentElement)) }));
  const nx = root.querySelector('[data-testid="phone-next"]');
  if (nx) out.next = { name: nx.querySelector('[data-testid="phone-next-name"]').textContent, when: nx.querySelector('[data-testid="phone-next-when"]').textContent, wraps: nx.dataset.wraps === 'true' };
  out.curCells = [...root.querySelectorAll('[role="group"][aria-current="true"]')].map((c) => ({ label: c.getAttribute('aria-label'), inCurLine: !!c.closest('[data-testid="phone-line-current"]'), cell: c.dataset.testid }));
  out.curSlots = [...root.querySelectorAll('button[aria-current="true"]')].map((b) => ({ title: b.title, cell: `phone-cell-${b.dataset.cell}` }));
  out.lineCur = [...root.querySelectorAll('[data-testid="phone-line-current"] [role="group"]')].map((c) => c.getAttribute('aria-label'));
  out.lineNextFirst = root.querySelector('[data-testid="phone-line-next"] [role="group"]')?.getAttribute('aria-label') ?? null;
  out.groups = [];
  for (const g of root.querySelectorAll('[role="group"]')) {
    out.groups.push({ cell: g.dataset.cell, label: g.getAttribute('aria-label') ?? '', texts: [...g.querySelectorAll('button')].map((b) => b.textContent) });
  }
  for (const b of root.querySelectorAll('[data-testid="phone-line-current"] button, [data-testid="phone-line-next"] button')) {
    const r = b.getBoundingClientRect();
    out.slots.push({
      groupCell: b.closest('[role="group"]')?.dataset.cell ?? null,
      runStart: Number(b.dataset.startSec),
      runEnd: Number(b.dataset.endSec),
      barStart: Number(b.closest('[data-start-sec][data-cell]:not(button)')?.dataset.startSec),
      barEnd: Number(b.closest('[data-start-sec][data-cell]:not(button)')?.dataset.endSec),
      cell: b.dataset.cell,
      title: b.title,
      text: b.textContent,
      aria: b.getAttribute('aria-label') ?? '',
      fontPx: px(getComputedStyle(b).fontSize),
      overX: b.scrollWidth - b.clientWidth,
      overY: b.scrollHeight - b.clientHeight,
      contrast: textContrast(b),
      kind: b.title === 'N' ? 'none' : 'chord',
      w: r.width,
      h: r.height,
    });
  }
  out.barNumbers = [...root.querySelectorAll('[data-testid="phone-bar-number"]')].map((n) => ({ text: n.textContent, c: textContrast(n) }));
  out.cellsMulti = [...root.querySelectorAll('[role="group"], [data-testid^="phone-cell-"]')].filter((c) => Number(c.dataset.slots) > 1).length;
  out.live = root.querySelectorAll('[aria-live]').length;
  out.primaries = [...document.querySelectorAll('[data-testid^="chord-chip-"]')].filter((c) => /^chord-chip-\d+$/.test(c.dataset.testid)).length;
  return out;
}

function checkSlots(m, f, ctx) {
  if (m.slots.length === 0) f.push(`no chord slots in the lines @ ${ctx}`);
  if (m.mode === 'bars') {
    // No bar ever shows a chord that is not sounding during that bar.
    for (const s of m.slots) {
      const ov = Math.min(s.runEnd, s.barEnd) - Math.max(s.runStart, s.barStart);
      if (!(ov > 0.05)) f.push(`chord ${s.title} (${s.runStart}-${s.runEnd}s) is drawn in a bar it does not sound in (${s.barStart}-${s.barEnd}s) @ ${ctx}`);
    }
    for (const s of m.slots) if (s.groupCell !== s.cell) f.push(`chord ${s.title} is not inside its bar's group (in ${s.groupCell}, belongs to ${s.cell}) @ ${ctx}`);
    for (const g of m.groups) {
      if (g.texts.length === 0) f.push(`bar group "${g.label}" holds no chord buttons @ ${ctx}`);
      if (!g.label.endsWith(`: ${g.texts.join(', ')}`)) f.push(`bar group "${g.label}" does not name its chords [${g.texts.join(', ')}] in order @ ${ctx}`);
    }
  }
  for (const s of m.slots) {
    const want = s.title in SPELL ? SPELL[s.title] : null;
    if (!s.text) f.push(`slot ${s.title} renders NO NAME @ ${ctx}`);
    else if (want !== null && s.text !== want) f.push(`slot ${s.title} reads "${s.text}", want "${want}" @ ${ctx}`);
    if (s.fontPx < NAME_MIN_PX) f.push(`slot ${s.title} "${s.text}" is ${s.fontPx}px < ${NAME_MIN_PX}px @ ${ctx}`);
    if (s.overX > 0 || s.overY > 0) f.push(`slot ${s.title} "${s.text}" is clipped (${s.overX}/${s.overY}px) @ ${ctx}`);
    if (!s.aria.startsWith(s.text)) f.push(`slot ${s.title}: accessible name "${s.aria}" does not start with its visible text "${s.text}" @ ${ctx}`);
    if (s.contrast < TEXT_CONTRAST) f.push(`slot ${s.title} "${s.text}" contrast ${s.contrast.toFixed(2)} < ${TEXT_CONTRAST} @ ${ctx}`);
    if (s.h < 24 || s.w < 24) f.push(`slot ${s.title} target ${s.w.toFixed(1)}x${s.h.toFixed(1)} < 24px @ ${ctx}`);
  }
  for (const n of m.barNumbers) {
    if (!(Number(n.text) >= 1)) f.push(`bar number "${n.text}" is not >= 1 @ ${ctx}`);
    if (n.c < TEXT_CONTRAST) f.push(`bar number ${n.text} contrast ${n.c.toFixed(2)} @ ${ctx}`);
  }
  if (m.live) f.push(`aria-live inside the phone view @ ${ctx}`);
}

function checkNow(m, f, ctx, wantText) {
  if (!m.now) return f.push(`no Now name @ ${ctx}`);
  if (m.now.text !== wantText) f.push(`Now reads "${m.now.text}", want "${wantText}" @ ${ctx}`);
  if (m.now.fontPx < NOW_MIN_PX || m.now.h < NOW_MIN_PX) f.push(`Now ${m.now.fontPx}px / box ${m.now.h.toFixed(1)}px < ${NOW_MIN_PX} @ ${ctx}`);
  if (m.now.weight < 600) f.push(`Now weight ${m.now.weight} @ ${ctx}`);
  if (!m.now.inX || m.now.clippedBy.length) f.push(`Now off screen or clipped (${JSON.stringify(m.now)}) @ ${ctx}`);
  if (m.now.fontPx < 28) f.push(`Now "${m.now.text}" shrank to ${m.now.fontPx}px < 28px @ ${ctx}`);
  if (m.now.overlap) f.push(`Now "${m.now.text}" (${m.now.fit}) overlaps Next: ${m.now.overlap} @ ${ctx}`);
}

const fail = (f, n = 25) => f.length && assert.fail(`GATE-FAIL ${f.length} finding(s):\n  ${f.slice(0, n).join('\n  ')}`);

// ---------------------------------------------------------------------------
let browser;
let built;
test('Chromium launches and the real PlayerView bundles', async () => {
  built = await bundle();
  browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
  assert.ok(browser.isConnected());
});

for (const vp of [[390, 844], [360, 800]]) {
  test(`phone chords @ ${vp[0]}x${vp[1]}: sweep every bar of the song`, async () => {
    const posOf = (k) => DOWN + k * BAR + ((k % 4) + 0.3) * BEAT;
    const { ctx, page, errors } = await open(browser, built, vp, { pos: posOf(0) });
    const f = [];
    try {
      let checkedSlots = 0;
      let multi = 0;
      for (let k = 0; k < F.bars; k++) {
        const t = posOf(k);
        await moveTo(page, t);
        const m = await page.evaluate(measure);
        const want = truthAt(t);
        const ctxs = `${vp.join('x')} bar#${k} t=${t.toFixed(2)}`;
        if (m.mode !== 'bars') { f.push(`mode ${m.mode} (${m.reason}), want bars @ ${ctxs}`); break; }
        checkNow(m, f, ctxs, want.heard ? spell(want.heard.label) : '—');
        if (m.position !== want.label) f.push(`position "${m.position}", want "${want.label}" @ ${ctxs}`);
        if (m.beat !== String(want.beat)) f.push(`beat dot ${m.beat}, want ${want.beat} @ ${ctxs}`);
        if (m.dots.filter((d) => d.on).length !== 1) f.push(`${m.dots.filter((d) => d.on).length} lit beat dots @ ${ctxs}`);
        for (const d of m.dots) if (!d.on && d.c < NONTEXT_CONTRAST) f.push(`inactive beat dot contrast ${d.c.toFixed(2)} @ ${ctxs}`);
        if (want.next) {
          const wantWhen = `Next in ${want.count} beat${want.count === 1 ? '' : 's'}`;
          if (!m.next) f.push(`no Next, want ${want.next.label} @ ${ctxs}`);
          else {
            if (m.next.name !== spell(want.next.label)) f.push(`Next "${m.next.name}", want "${spell(want.next.label)}" @ ${ctxs}`);
            if (m.next.when !== wantWhen) f.push(`Next count "${m.next.when}", want "${wantWhen}" @ ${ctxs}`);
          }
        }
        if (m.curCells.length !== 1) f.push(`${m.curCells.length} bars carry aria-current @ ${ctxs}`);
        else {
          if (!m.curCells[0].inCurLine) f.push(`current bar is not in the current line @ ${ctxs}`);
          if (m.curCells[0].label !== barTag(want.k)) f.push(`current bar "${m.curCells[0].label}", want "${barTag(want.k)}" @ ${ctxs}`);
        }
        if (want.heard && want.heard.label !== 'N') {
          if (m.curSlots.length !== 1) f.push(`${m.curSlots.length} chords carry aria-current @ ${ctxs}`);
          else {
            if (m.curSlots[0].title !== want.heard.label) f.push(`current chord ${m.curSlots[0].title}, heard ${want.heard.label} @ ${ctxs}`);
            if (m.curCells[0] && m.curSlots[0].cell !== m.curCells[0].cell) f.push(`current chord is outside the current bar @ ${ctxs}`);
          }
        }
        if (m.lineCur.join(' | ') !== want.lineBars.join(' | ')) f.push(`current line [${m.lineCur.join(' | ')}], want [${want.lineBars.join(' | ')}] @ ${ctxs}`);
        if (m.lineNextFirst !== want.nextLineFirst) f.push(`next line starts "${m.lineNextFirst}", want "${want.nextLineFirst}" @ ${ctxs}`);
        checkSlots(m, f, ctxs);
        checkedSlots += m.slots.length;
        multi = Math.max(multi, m.cellsMulti);
        if (k === 0 && m.primaries !== FIX.segments.length) f.push(`${m.primaries} primary chips in All chords for ${FIX.segments.length} segments`);
      }
      if (checkedSlots < F.bars * 6) f.push(`only ${checkedSlots} slots checked across the sweep`);
      if (multi === 0) f.push('no split bar was ever on screen');
      assert.deepEqual(errors, [], 'the page threw');
      fail(f);
    } finally {
      await ctx.close();
    }
  });

  test(`phone chords @ ${vp[0]}x${vp[1]}: a section loop wraps Next and the next line`, async () => {
    const si = NAMES.indexOf('Chorus 2');
    const loop = { startSec: F.sections[si].startSec, endSec: F.sections[si].endSec, label: 'chorus' };
    const t = loop.endSec - 0.3;
    const { ctx, page, errors } = await open(browser, built, vp, { pos: t, loop });
    try {
      const f = [];
      const m = await page.evaluate(measure);
      const atStart = FIX.segments.find((s) => s.start_sec <= loop.startSec + 1e-3 && loop.startSec + 1e-3 < s.end_sec);
      if (!m.next?.wraps) f.push(`Next does not follow the loop (${JSON.stringify(m.next)})`);
      if (m.next?.name !== spell(atStart.label)) f.push(`Next "${m.next?.name}", want the loop-start chord "${spell(atStart.label)}"`);
      if (!m.next?.when.startsWith('Loops back in')) f.push(`Next says "${m.next?.when}"`);
      if (m.lineNextFirst !== barTag(SEC_FIRST_BAR[si])) f.push(`next line starts "${m.lineNextFirst}", want the loop's first bar`);
      // Without the loop, the same position looks ahead into the bridge.
      await moveTo(page, t, null);
      const m2 = await page.evaluate(measure);
      if (m2.next?.wraps) f.push('Next wraps with no loop');
      if (m2.lineNextFirst !== barTag(SEC_FIRST_BAR[NAMES.indexOf('Bridge')])) f.push(`unlooped next line "${m2.lineNextFirst}"`);
      assert.deepEqual(errors, []);
      fail(f);
    } finally {
      await ctx.close();
    }
  });

  test(`phone chords @ ${vp[0]}x${vp[1]}: a gap in the chord data does not jump Next to the first chord`, async () => {
    const segs = FIX.segments.filter((_, i) => i < 50 || i > 52);
    const t = (FIX.segments[49].end_sec + FIX.segments[53].start_sec) / 2;
    const { ctx, page, errors } = await open(browser, built, vp, { pos: t, payload: { ...FIX, segments: segs } });
    try {
      const m = await page.evaluate(measure);
      const want = FIX.segments[53];
      const f = [];
      if (m.now?.text !== '—') f.push(`Now "${m.now?.text}" in a gap`);
      if (m.next?.name !== spell(want.label)) f.push(`Next "${m.next?.name}", want "${spell(want.label)}"`);
      const c = Math.max(1, Math.ceil((want.start_sec - t) / BEAT - 0.05));
      if (m.next?.when !== `Next in ${c} beat${c === 1 ? '' : 's'}`) f.push(`Next count "${m.next?.when}", want ${c}`);
      assert.deepEqual(errors, []);
      fail(f);
    } finally {
      await ctx.close();
    }
  });

  test(`phone chords @ ${vp[0]}x${vp[1]}: no tempo -> plain chord sequence, nothing invented`, async () => {
    const turnaround = FIX.segments.find((s) => s.label === 'C#:hdim7/5');
    const positions = [FIX.segments[20].start_sec + 0.1, turnaround.start_sec + 0.05, 137.4];
    const { ctx, page, errors } = await open(browser, built, vp, { pos: positions[0], grid: null });
    try {
      const f = [];
      for (const t of positions) {
        await moveTo(page, t);
        const m = await page.evaluate(measure);
        const ctxs = `${vp.join('x')} t=${t.toFixed(2)}`;
        const heard = FIX.segments.find((s) => s.start_sec <= t && t < s.end_sec);
        if (m.mode !== 'sequence' || m.reason !== 'no-grid') f.push(`mode ${m.mode}/${m.reason} @ ${ctxs}`);
        if (m.beat !== null || m.dots.length) f.push(`beat dots shown without a tempo @ ${ctxs}`);
        if (m.next && m.next.when !== 'Next') f.push(`"${m.next.when}": a beat count without a tempo @ ${ctxs}`);
        if (m.barNumbers.length) f.push(`bar numbers shown without a tempo @ ${ctxs}`);
        if (m.cellsMulti) f.push(`${m.cellsMulti} split cells without a tempo @ ${ctxs}`);
        if (/bar/i.test(m.position ?? '')) f.push(`position "${m.position}" claims a bar @ ${ctxs}`);
        checkNow(m, f, ctxs, spell(heard.label));
        checkSlots(m, f, ctxs);
      }
      assert.deepEqual(errors, []);
      fail(f);
    } finally {
      await ctx.close();
    }
  });
}

// Synthetic songs: bars of [label, beats], on a grid that starts on the first chord.
function synth(bars, bpm) {
  const beat = 60 / bpm;
  const segments = [];
  let b = 0;
  for (const bar of bars)
    for (const [label, beats] of bar) {
      const prev = segments.at(-1);
      const s = 0.5 + b * beat;
      b += beats;
      if (prev && prev.label === label) prev.end_sec = 0.5 + b * beat;
      else segments.push({ start_sec: s, end_sec: 0.5 + b * beat, label, confidence: 1 });
    }
  return { payload: { segments, duration_sec: segments.at(-1).end_sec + 0.5 }, grid: { beatSec: beat, anchorSec: 0.5, measured: true }, beat };
}

for (const vp of [[390, 844], [360, 800]]) {
  test(`phone chords @ ${vp[0]}x${vp[1]}: two chords in EVERY bar -> the bar grid, every split bar names both`, async () => {
    const prog = [[['C:maj', 2], ['A:min', 2]], [['F:maj', 2], ['G:maj', 2]], [['E:min7', 2], ['A:min7', 2]], [['D:min7', 2], ['G:7', 2]]];
    const bars = Array.from({ length: 48 }, (_, k) => prog[k % 4]);
    const { payload, grid, beat } = synth(bars, 92);
    const { ctx, page, errors } = await open(browser, built, vp, { pos: 1, grid, sections: [], payload });
    try {
      const f = [];
      let splitSeen = 0;
      for (let k = 0; k < 48; k += 2) {
        const t = 0.5 + (k * 4 + 2.4) * beat;
        await moveTo(page, t);
        const m = await page.evaluate(measure);
        const ctxs = `${vp.join('x')} 2+2 bar#${k}`;
        if (m.mode !== 'bars') { f.push(`mode ${m.mode} (${m.reason}): a song with two chords in every bar fell back to a list @ ${ctxs}`); break; }
        for (const g of m.groups) {
          if (g.texts.length !== 2) f.push(`bar "${g.label}" holds ${g.texts.length} chords, want 2 @ ${ctxs}`);
          else splitSeen++;
        }
        const want = prog[k % 4].map(([l]) => SPELL[l]);
        const cur = m.groups.find((g) => g.label.startsWith(`Bar ${k + 1} of 48:`));
        if (!cur || cur.texts.join() !== want.join()) f.push(`bar ${k + 1} shows [${cur?.texts}], want [${want}] @ ${ctxs}`);
        if (m.beat !== '3') f.push(`beat dot ${m.beat}, want 3 @ ${ctxs}`);
        checkNow(m, f, ctxs, SPELL[prog[k % 4][1][0]]);
        checkSlots(m, f, ctxs);
      }
      if (splitSeen < 100) f.push(`only ${splitSeen} split bars checked`);
      assert.deepEqual(errors, []);
      fail(f);
    } finally {
      await ctx.close();
    }
  });

  test(`phone chords @ ${vp[0]}x${vp[1]}: long current and next names never overlap on the Now card`, async () => {
    const LONG = { 'C#:hdim7/5': 'C#m7b5/G#', 'F#:7/3': 'F#7/A#', 'B:hdim7/b5': 'Bm7b5/F', 'E:7/3': 'E7/G#', 'A:min(9)': 'A:min(9)', 'D:minmaj7/5': 'Dm(maj7)/A' };
    Object.assign(SPELL, LONG);
    const labels = Object.keys(LONG);
    const bars = Array.from({ length: 24 }, (_, k) => [[labels[k % labels.length], 2], [labels[(k + 1) % labels.length], 2]]);
    const { payload, grid, beat } = synth(bars, 80);
    const { ctx, page, errors } = await open(browser, built, vp, { pos: 1, grid, sections: [], payload });
    try {
      const f = [];
      const fits = new Set();
      for (let i = 0; i < 48; i++) {
        const t = 0.5 + (i * 2 + 0.5) * beat;
        await moveTo(page, t);
        const m = await page.evaluate(measure);
        const heard = payload.segments.find((s) => s.start_sec <= t && t < s.end_sec);
        checkNow(m, f, `${vp.join('x')} long t=${t.toFixed(2)}`, LONG[heard.label]);
        if (m.now?.fit) fits.add(m.now.fit.replace(/-\d+$/, ''));
        checkSlots(m, f, `${vp.join('x')} long t=${t.toFixed(2)}`);
      }
      if (!fits.has('two-line') && !fits.has('next-below')) f.push(`no position needed the long-name fallback (fits: ${[...fits]})`);
      assert.deepEqual(errors, []);
      fail(f);
    } finally {
      await ctx.close();
    }
  });
}


// Meter (reviews 5 and 6): 4/4 bars are never drawn over another meter; a
// confident 3-beat cycle gets 3-beat bars (6/8 counted in eighths: two bars of
// three); an uncertain meter gets the plain list.
const WALTZ = ['C:maj', 'A:min', 'F:maj', 'G:7', 'E:min7', 'A:min', 'D:min7', 'G:7'];
const METER_CASES = [
  { name: '3/4, a change every bar', bpm: 96, n: 48, bar: (k) => [[WALTZ[k % 8], 3]], want: 3 },
  { name: '3/4, a change every 2 bars', bpm: 96, n: 32, bar: (k) => [[WALTZ[k % 8], 6]], want: 3 },
  { name: '3/4, 2+1 in every bar (downbeat not confirmed)', bpm: 96, n: 40, bar: (k) => [[WALTZ[k % 8], 2], [WALTZ[(k + 3) % 8], 1]], want: 'sequence' },
  { name: '3/4, 1+2 in every bar (downbeat not confirmed)', bpm: 96, n: 41, bar: (k) => [[WALTZ[k % 8], 1], [WALTZ[(k + 3) % 8], 2]], want: 'sequence' },
  { name: '6/8 counted in eighths, a change every bar', bpm: 180, n: 40, bar: (k) => [[WALTZ[k % 8], 6]], want: 3 },
  { name: '3/4 alternating 2+1 and 1+2 (uncertain)', bpm: 96, n: 40, bar: (k) => (k % 2 ? [[WALTZ[k % 8], 1], [WALTZ[(k + 3) % 8], 2]] : [[WALTZ[k % 8], 2], [WALTZ[(k + 3) % 8], 1]]), want: 'sequence' },
  { name: '3/4, a change every 4 bars (fits 4/4 too)', bpm: 96, n: 20, bar: (k) => [[WALTZ[k % 8], 12]], want: 'sequence' },
  { name: '4/4, two changes every bar', bpm: 96, n: 48, bar: (k) => [[WALTZ[(2 * k) % 8], 2], [WALTZ[(2 * k + 1) % 8], 2]], want: 4 },
];
for (const vp of [[390, 844], [360, 800]]) {
  for (const mc of METER_CASES) {
    test(`phone chords @ ${vp[0]}x${vp[1]}: ${mc.name} -> ${mc.want === 'sequence' ? 'plain list' : `${mc.want}-beat bars`}`, async () => {
      const bars = Array.from({ length: mc.n }, (_, k) => mc.bar(k));
      const { payload, grid, beat } = synth(bars, mc.bpm);
      const totalBeats = bars.flat().reduce((a, [, b]) => a + b, 0);
      const { ctx, page, errors } = await open(browser, built, vp, { pos: 1, grid, sections: [], payload });
      try {
        const f = [];
        let checked = 0;
        for (let i = 0; i < 24; i++) {
          const t = 0.5 + ((i * 7.3) % (totalBeats - 2) + 0.4) * beat;
          await moveTo(page, t);
          const m = await page.evaluate(measure);
          const ctxs = `${vp.join('x')} ${mc.name} t=${t.toFixed(2)}`;
          const heard = payload.segments.find((x) => x.start_sec <= t && t < x.end_sec);
          checkNow(m, f, ctxs, SPELL[heard.label]);
          checkSlots(m, f, ctxs);
          if (mc.want === 'sequence') {
            if (m.mode !== 'sequence') f.push(`drawn as ${m.mode}/${m.beatsPerBar}, want the plain list @ ${ctxs}`);
            if (m.beat !== null || m.dots.length) f.push(`beat dots with an uncertain meter @ ${ctxs}`);
            if (m.cellsMulti) f.push(`${m.cellsMulti} invented split bars @ ${ctxs}`);
            if (/bar/i.test(m.position ?? '')) f.push(`position "${m.position}" claims a bar @ ${ctxs}`);
            continue;
          }
          const m3 = mc.want;
          if (m.mode !== 'bars' || m.beatsPerBar !== String(m3)) { f.push(`drawn as ${m.mode}/${m.beatsPerBar} (${m.reason}), want ${m3}-beat bars @ ${ctxs}`); continue; }
          const k = Math.floor((t - 0.5) / (m3 * beat) + 1e-9);
          const nBars = totalBeats / m3;
          // Triple time shows no total (3/4 vs 6/8 is unknowable); 4/4 does.
          const wantPos = m3 === 3 ? `Bar ${k + 1}` : `Bar ${k + 1}/${nBars}`;
          if (m.position !== wantPos) f.push(`position "${m.position}", want "${wantPos}" @ ${ctxs}`);
          if (m.dots.length !== m3) f.push(`${m.dots.length} beat dots, want ${m3} @ ${ctxs}`);
          const wantBeat = Math.floor((t - 0.5 - k * m3 * beat) / beat + 1e-9) + 1;
          if (m.beat !== String(wantBeat)) f.push(`beat ${m.beat}, want ${wantBeat} @ ${ctxs}`);
          // Every bar on screen holds exactly the chords of that bar of the song.
          for (const g of m.groups) {
            const n = Number(/^Bar (\d+)/.exec(g.label)?.[1]);
            const bs = 0.5 + (n - 1) * m3 * beat;
            const want = payload.segments.filter((x) => Math.min(x.end_sec, bs + m3 * beat) - Math.max(x.start_sec, bs) >= 0.5 * beat).map((x) => SPELL[x.label]);
            if (g.texts.join() !== want.join()) f.push(`bar ${n} shows [${g.texts}], want [${want}] @ ${ctxs}`);
          }
          checked++;
        }
        if (mc.want !== 'sequence' && checked < 20) f.push(`only ${checked} positions checked`);
        assert.deepEqual(errors, []);
        fail(f);
      } finally {
        await ctx.close();
      }
    });
  }
}

// BAR TOTAL: walk EVERY bar (mid-bar). 4/4: the N in "Bar n/N" and "Bar n of
// N" equals the distinct bars rendered and the song's bar count. Triple time:
// no total anywhere, 3 dots, 3-beat cells on the downbeats (v3/main layout).
const BAR_TOTAL_CASES = [
  { name: '4/4, one change every bar', bpm: 96, n: 32, m: 4, total: 32, bar: (k) => [[WALTZ[k % 8], 4]] },
  { name: '4/4, two changes every bar @180', bpm: 180, n: 32, m: 4, total: 32, bar: (k) => [[WALTZ[(2 * k) % 8], 2], [WALTZ[(2 * k + 1) % 8], 2]] },
  ...[120, 150, 180].flatMap((bpm) => [
    { name: `3/4, a change every bar @${bpm}`, bpm, n: 48, m: 3, total: null, bar: (k) => [[WALTZ[k % 8], 3]] },
    { name: `6/8 in eighths, a change every bar @${bpm}`, bpm, n: 40, m: 3, total: null, bar: (k) => [[WALTZ[k % 8], 6]] },
  ]),
];
for (const vp of [[390, 844], [360, 800]]) {
  for (const bc of BAR_TOTAL_CASES) {
    test(`phone chords @ ${vp[0]}x${vp[1]}: ${bc.name} -> ${bc.total ? `"Bar n/${bc.total}" = bars rendered` : 'no bar total, 3-beat cells'}`, async () => {
      const bars = Array.from({ length: bc.n }, (_, k) => bc.bar(k));
      const { payload, grid, beat } = synth(bars, bc.bpm);
      const cells = (bars.flat().reduce((a, [, b]) => a + b, 0)) / bc.m;
      const { ctx, page, errors } = await open(browser, built, vp, { pos: 1, grid, sections: [], payload });
      try {
        const f = [];
        const rendered = new Set();
        const totals = new Set();
        for (let k = 0; k < cells; k++) {
          const t = 0.5 + (k * bc.m + bc.m / 2 + 0.1) * beat;
          await moveTo(page, t);
          const m = await page.evaluate(measure);
          const ctxs = `${vp.join('x')} ${bc.name} cell ${k + 1}`;
          if (m.mode !== 'bars' || m.beatsPerBar !== String(bc.m)) { f.push(`drawn as ${m.mode}/${m.beatsPerBar}, want ${bc.m}-beat bars @ ${ctxs}`); continue; }
          if (m.dots.length !== bc.m) f.push(`${m.dots.length} beat dots, want ${bc.m} @ ${ctxs}`);
          const want = bc.total ? `Bar ${k + 1}/${bc.total}` : `Bar ${k + 1}`;
          if (m.position !== want) f.push(`position "${m.position}", want "${want}" @ ${ctxs}`);
          const pm = /^Bar \d+\/(\d+)$/.exec(m.position ?? '');
          if (pm) totals.add(Number(pm[1]));
          for (const g of m.groups) {
            const gm = /^Bar (\d+)( of (\d+))?[,:]/.exec(g.label);
            if (!gm) { f.push(`bar group "${g.label}" is not "Bar n..." @ ${ctxs}`); continue; }
            rendered.add(Number(gm[1]));
            if (gm[3]) totals.add(Number(gm[3]));
            if (!bc.total && gm[2]) f.push(`triple-time bar group "${g.label}" shows a total @ ${ctxs}`);
          }
          for (const s of m.slots) {
            const len = s.barEnd - s.barStart;
            if (Math.abs(len - bc.m * beat) > 0.01) f.push(`bar ${s.barStart}-${s.barEnd}s is ${(len / beat).toFixed(2)} beats, want ${bc.m} @ ${ctxs}`);
            const q = (s.barStart - 0.5) / (bc.m * beat);
            if (Math.abs(q - Math.round(q)) > 0.01) f.push(`bar at ${s.barStart}s is off the downbeat @ ${ctxs}`);
          }
          for (const b of m.barNumbers) rendered.add(Number(b.text));
        }
        assert.deepEqual(errors, []);
        fail(f);
        assert.equal(rendered.size, cells, `rendered ${rendered.size} distinct bars, want ${cells}`);
        if (bc.total) {
          assert.deepEqual([...totals], [bc.total], `label totals ${[...totals]} must all be ${bc.total}`);
          assert.equal(rendered.size, bc.total, 'the label total equals the bars rendered');
        } else {
          assert.deepEqual([...totals], [], `triple time showed totals ${[...totals]}`);
        }
      } finally {
        await ctx.close();
      }
    });
  }
}

test('teardown', async () => {
  if (browser) await browser.close();
});
