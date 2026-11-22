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
//   * the position line "Part 5 · bar 3/16" and the lit beat dot;
//   * Next: the next different chord and "in N beats";
//   * exactly ONE current bar (aria-current) and ONE current chord
//     (aria-current), in the current line, the chord heard;
//   * the current line holds the expected bars of its section (lines start at
//     bar 1, 5, 9 ... of a section) and the next line starts where expected;
//   * EVERY visible chord slot: a name (never blank), the guitarist spelling of
//     its own data with ♭/♯ glyphs, >= 14px, not clipped, an accessible name
//     that starts with the chord IN WORDS ("C sharp minor 7 flat 5 over G
//     sharp"; never a glyph — design v1.4 P1.5), text contrast >= 4.5:1;
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
//  #212: the "All chords" chart (the ⋯ menu's sheet since Slice 1a) keeps one
//   primary chip per segment.
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
// The planted sections are intro, verse, chorus, verse, chorus, bridge, chorus,
// outro. D2 (Jon 2026-11-21): the player names them neutrally by position and
// never shows the worker's labels, so these are the names the gate expects.
const NAMES = ['Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5', 'Part 6', 'Part 7', 'Part 8'];
const CHORUS_2 = 4; // the planted second chorus
const BRIDGE = 5;
// Section i's true first bar: its worker start is one beat before the downbeat (intro: the first downbeat).
const SEC_FIRST_BAR = F.sections.map((s, i) => (i === 0 ? 0 : Math.round((s.startSec + BEAT - DOWN) / BAR)));
const SEC_BARS = SEC_FIRST_BAR.map((b, i) => (i + 1 < SEC_FIRST_BAR.length ? SEC_FIRST_BAR[i + 1] : F.bars) - b);

// Independent lead-sheet spelling for the labels this fixture uses: what is
// PAINTED (guitarist notation with the ♭/♯ glyphs, design v1.4 P1.5) and what
// is SPOKEN (the accessible name says "flat"/"sharp" in words).
const SPELL = {
  'C:maj': 'C', 'G:maj': 'G', 'A:min': 'Am', 'F:maj': 'F', 'A:min7': 'Am7', 'D:min7': 'Dm7', 'G:7': 'G7', 'E:min7': 'Em7',
  'C:maj/3': 'C/E', 'E:min': 'Em', 'Bb:maj': 'B\u266d', 'G:maj/3': 'G/B', 'C#:hdim7/5': 'C\u266fm7\u266d5/G\u266f', N: 'N.C.',
};
const SPOKEN = {
  'C:maj': 'C', 'G:maj': 'G', 'A:min': 'A minor', 'F:maj': 'F', 'A:min7': 'A minor 7', 'D:min7': 'D minor 7', 'G:7': 'G 7',
  'E:min7': 'E minor 7', 'C:maj/3': 'C over E', 'E:min': 'E minor', 'Bb:maj': 'B flat', 'G:maj/3': 'G over B',
  'C#:hdim7/5': 'C sharp minor 7 flat 5 over G sharp', N: 'No chord',
};
const speak = (l) => {
  assert.ok(l in SPOKEN, `test has no spoken name for ${l}`);
  return SPOKEN[l];
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
    .map((s) => speak(s.label));
  return `Bar ${k - SEC_FIRST_BAR[sec] + 1} of ${SEC_BARS[sec]}, ${NAMES[sec]}: ${chords.join(', ')}`;
}

const snapAt = (positionSec, loop = null, degraded = null) => ({
  status: 'playing',
  positionSec,
  durationSec: FIX.duration_sec,
  stems: ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'].map((name) => ({ name, availability: 'ready', gain: 0.8, muted: false, soloed: false, effectivelySilent: false })),
  loop,
  degraded,
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

async function open(browser, built, [w, h], { pos, grid = GRID, sections = F.sections, payload = FIX, loop = null, degraded = null, chordMode = 'detailed', stageH = null }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('http://gate.test/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/')
      return route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        `<link rel="stylesheet" href="/out.css"><style>${FONT_CSS}${stageH ? `[data-testid="player"] [class*="stage"]{flex:0 0 ${stageH}px !important;height:${stageH}px !important;min-height:0 !important;box-sizing:border-box}` : ''}</style></head><body>` +
        '<main style="max-width:960px;margin:0 auto;padding:24px var(--sl-gutter,16px) 96px"><div id="root"></div></main>' +
        // The chord view (Phase A, D6). The sweeps below check the DETECTED segments, so
        // they pin Detailed; the Simple test passes 'simple' (the app's default).
        `<script>try{localStorage.setItem("sl.play.chordMode.v1",${JSON.stringify(chordMode)})}catch(e){}</script>` +
        `<script>window.__snap=${JSON.stringify(snapAt(pos, loop, degraded))};window.__sections=${JSON.stringify(sections)};window.__grid=${JSON.stringify(grid)};</script>` +
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
async function moveTo(page, pos, loop = null, degraded = null) {
  await page.evaluate((s) => window.__render(s), snapAt(pos, loop, degraded));
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
  const out = { countdown: null, mode: root?.dataset.mode, beatsPerBar: root?.dataset.beatsPerBar, reason: root?.dataset.reason, now: null, position: null, beat: null, dots: [], next: null, curCells: [], curSlots: [], lineCur: [], lineNextFirst: null, slots: [], barNumbers: [], live: 0, primaries: 0, cellsMulti: 0 };
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
      // The player is a position:fixed screen (Slice 1a): nothing above its
      // containing block (the viewport) can clip it, so the walk ends here.
      if (ecs.position === 'fixed') break;
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
  const cd = root.querySelector('[data-testid="phone-countdown"]');
  if (cd) {
    const tx = cd.querySelector('[data-testid="phone-countdown-text"]');
    out.countdown = {
      kind: cd.dataset.kind,
      beatsLeft: cd.dataset.beatsLeft === undefined ? null : Number(cd.dataset.beatsLeft),
      lit: [...cd.querySelectorAll('[data-testid="phone-countdown-seg"]')].filter((x) => x.dataset.on === 'true').length,
      segs: cd.querySelectorAll('[data-testid="phone-countdown-seg"]').length,
      text: tx?.textContent ?? '',
      textPx: px(getComputedStyle(tx).fontSize),
      textC: textContrast(tx),
    };
  }
  const nx = root.querySelector('[data-testid="phone-next"]');
  if (nx) out.next = { name: nx.querySelector('[data-testid="phone-next-name"]').textContent, when: nx.querySelector('[data-testid="phone-next-when"]').textContent, wraps: nx.dataset.wraps === 'true' };
  out.curCells = [...root.querySelectorAll('[role="group"][aria-current="true"]')].map((c) => ({ label: c.getAttribute('aria-label'), inCurLine: !!c.closest('[data-testid="phone-line-current"]'), cell: c.dataset.testid }));
  // Chord cells (Phase A): plain role="img" text while playing / with no editor, so
  // they are found by test id, not by tag.
  const SLOT = '[data-testid^="phone-slot-"]';
  out.curSlots = [...root.querySelectorAll(`${SLOT}[aria-current="true"]`)].map((b) => ({ title: b.title, cell: `phone-cell-${b.dataset.cell}` }));
  out.lineCur = [...root.querySelectorAll('[data-testid="phone-line-current"] [role="group"]')].map((c) => c.getAttribute('aria-label'));
  out.lineNextFirst = root.querySelector('[data-testid="phone-line-next"] [role="group"]')?.getAttribute('aria-label') ?? null;
  out.groups = [];
  for (const g of root.querySelectorAll('[role="group"]')) {
    out.groups.push({ cell: g.dataset.cell, label: g.getAttribute('aria-label') ?? '', texts: [...g.querySelectorAll(SLOT)].map((b) => b.textContent), titles: [...g.querySelectorAll(SLOT)].map((b) => b.title) });
  }
  for (const b of root.querySelectorAll(`[data-testid="phone-line-current"] ${SLOT}, [data-testid="phone-line-next"] ${SLOT}`)) {
    const r = b.getBoundingClientRect();
    out.slots.push({
      groupCell: b.closest('[role="group"]')?.dataset.cell ?? null,
      runStart: Number(b.dataset.startSec),
      runEnd: Number(b.dataset.endSec),
      barStart: Number(b.closest('[data-start-sec][data-cell]:not([data-run-index])')?.dataset.startSec),
      barEnd: Number(b.closest('[data-start-sec][data-cell]:not([data-run-index])')?.dataset.endSec),
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
      const words = g.titles.map((t) => (t in SPOKEN ? SPOKEN[t] : t));
      if (!g.label.endsWith(`: ${words.join(', ')}`)) f.push(`bar group "${g.label}" does not name its chords [${words.join(', ')}] in order @ ${ctx}`);
    }
  }
  for (const s of m.slots) {
    const want = s.title in SPELL ? SPELL[s.title] : null;
    if (!s.text) f.push(`slot ${s.title} renders NO NAME @ ${ctx}`);
    else if (want !== null && s.text !== want) f.push(`slot ${s.title} reads "${s.text}", want "${want}" @ ${ctx}`);
    if (s.fontPx < NAME_MIN_PX) f.push(`slot ${s.title} "${s.text}" is ${s.fontPx}px < ${NAME_MIN_PX}px @ ${ctx}`);
    if (s.overX > 0 || s.overY > 0) f.push(`slot ${s.title} "${s.text}" is clipped (${s.overX}/${s.overY}px) @ ${ctx}`);
    // The accessible name is the chord in WORDS (design v1.4 P1.5: "flat" /
    // "sharp", never a glyph) — the spoken form of exactly what is painted.
    const said = s.title in SPOKEN ? SPOKEN[s.title] : null;
    if (said !== null && !s.aria.startsWith(said)) f.push(`slot ${s.title}: accessible name "${s.aria}" does not start with its spoken name "${said}" @ ${ctx}`);
    if (/[\u266d\u266f#]/.test(s.aria)) f.push(`slot ${s.title}: accessible name "${s.aria}" carries a glyph @ ${ctx}`);
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

// Phase A (J5): the countdown under Now. `n` = beats to the change, from the fixture.
function checkCountdown(m, f, ctx, n) {
  const c = m.countdown;
  if (!c) return f.push(`no countdown @ ${ctx}`);
  if (c.kind !== 'beats' || c.beatsLeft !== n) f.push(`countdown ${c.kind} ${c.beatsLeft}, want ${n} beats @ ${ctx}`);
  if (c.text !== `${n} beat${n === 1 ? '' : 's'}`) f.push(`countdown reads "${c.text}" @ ${ctx}`);
  if (c.textPx < 20) f.push(`countdown text ${c.textPx}px < 20 @ ${ctx}`);
  if (c.textC < TEXT_CONTRAST) f.push(`countdown text contrast ${c.textC.toFixed(2)} @ ${ctx}`);
  if (c.segs !== 4 || c.lit !== (n <= 4 ? 5 - n : 0)) f.push(`countdown ${c.lit}/${c.segs} lit for ${n} beats @ ${ctx}`);
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
        // Review of #333 (H-1): the beat-in-bar dots give way to the countdown
        // whenever it shows (two 4-segment bars read as one); they stay where
        // there is no next chord.
        if (m.countdown) {
          if (m.beat !== null || m.dots.length) f.push(`beat dots beside the countdown @ ${ctxs}`);
        } else {
          if (m.beat !== String(want.beat)) f.push(`beat dot ${m.beat}, want ${want.beat} @ ${ctxs}`);
          if (m.dots.filter((d) => d.on).length !== 1) f.push(`${m.dots.filter((d) => d.on).length} lit beat dots @ ${ctxs}`);
          for (const d of m.dots) if (!d.on && d.c < NONTEXT_CONTRAST) f.push(`inactive beat dot contrast ${d.c.toFixed(2)} @ ${ctxs}`);
        }
        if (want.next) {
          if (!m.next) f.push(`no Next, want ${want.next.label} @ ${ctxs}`);
          else {
            if (m.next.name !== spell(want.next.label)) f.push(`Next "${m.next.name}", want "${spell(want.next.label)}" @ ${ctxs}`);
            if (m.next.when !== 'Next') f.push(`Next label "${m.next.when}", want "Next" @ ${ctxs}`);
          }
          checkCountdown(m, f, ctxs, want.count);
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
      }
      // #212: the full chart ("See all chords", the ⋯ menu's sheet since Slice 1a)
      // keeps one primary chip per segment.
      await page.click('[data-testid="player-more"]');
      await page.click('#player-menu button:has-text("See all chords")');
      await page.waitForSelector('[data-testid="chart-sheet"] [data-testid^="chord-chip-"]', { timeout: 30000 });
      await settle(page);
      const prim = await page.evaluate(() => [...document.querySelectorAll('[data-testid="chart-sheet"] [data-testid^="chord-chip-"]')].filter((c) => /^chord-chip-\d+$/.test(c.dataset.testid)).length);
      if (prim !== FIX.segments.length) f.push(`${prim} primary chips in All chords for ${FIX.segments.length} segments`);
      if (checkedSlots < F.bars * 6) f.push(`only ${checkedSlots} slots checked across the sweep`);
      if (multi === 0) f.push('no split bar was ever on screen');
      assert.deepEqual(errors, [], 'the page threw');
      fail(f);
    } finally {
      await ctx.close();
    }
  });

  test(`phone chords @ ${vp[0]}x${vp[1]}: a section loop wraps Next and the next line`, async () => {
    const si = CHORUS_2;
    const loop = { startSec: F.sections[si].startSec, endSec: F.sections[si].endSec, label: 'chorus' };
    const t = loop.endSec - 0.3;
    const { ctx, page, errors } = await open(browser, built, vp, { pos: t, loop });
    try {
      const f = [];
      const m = await page.evaluate(measure);
      const atStart = FIX.segments.find((s) => s.start_sec <= loop.startSec + 1e-3 && loop.startSec + 1e-3 < s.end_sec);
      if (!m.next?.wraps) f.push(`Next does not follow the loop (${JSON.stringify(m.next)})`);
      if (m.next?.name !== spell(atStart.label)) f.push(`Next "${m.next?.name}", want the loop-start chord "${spell(atStart.label)}"`);
      if (m.next?.when !== 'Loops back') f.push(`Next says "${m.next?.when}"`);
      checkCountdown(m, f, 'loop', Math.max(1, Math.ceil((loop.endSec - t) / BEAT - 0.05)));
      if (m.lineNextFirst !== barTag(SEC_FIRST_BAR[si])) f.push(`next line starts "${m.lineNextFirst}", want the loop's first bar`);
      // Without the loop, the same position looks ahead into the bridge.
      await moveTo(page, t, null);
      const m2 = await page.evaluate(measure);
      if (m2.next?.wraps) f.push('Next wraps with no loop');
      if (m2.lineNextFirst !== barTag(SEC_FIRST_BAR[BRIDGE])) f.push(`unlooped next line "${m2.lineNextFirst}"`);
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
      if (m.next?.when !== 'Next') f.push(`Next label "${m.next?.when}"`);
      checkCountdown(m, f, 'gap', c);
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
        // No tempo: the countdown is a time bar to the change, never a beat count.
        if (m.next && (m.countdown?.kind !== 'time' || m.countdown.beatsLeft !== null || !/^\d+(\.\d)? s$/.test(m.countdown.text)))
          f.push(`countdown without a tempo: ${JSON.stringify(m.countdown)} @ ${ctxs}`);
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
        if (m.countdown ? m.beat !== null : m.beat !== '3') f.push(`beat dot ${m.beat} (countdown ${!!m.countdown}) @ ${ctxs}`);
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
    const LONG = { 'C#:hdim7/5': 'C\u266fm7\u266d5/G\u266f', 'F#:7/3': 'F\u266f7/A\u266f', 'B:hdim7/b5': 'Bm7\u266d5/F', 'E:7/3': 'E7/G\u266f', 'A:min(9)': 'A:min(9)', 'D:minmaj7/5': 'Dm(maj7)/A' };
    Object.assign(SPELL, LONG);
    Object.assign(SPOKEN, {
      'C#:hdim7/5': 'C sharp minor 7 flat 5 over G sharp', 'F#:7/3': 'F sharp 7 over A sharp', 'B:hdim7/b5': 'B minor 7 flat 5 over F',
      'E:7/3': 'E 7 over G sharp', 'A:min(9)': 'A:min(9)', 'D:minmaj7/5': 'D minor major 7 over A',
    });
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

  // QA-01: a half-beat "F" used to get a slot exactly as wide as its name,
  // 15.3px in this Chromium. Every chord button in the harmony track (both
  // lines) must be >= 24x24, no two buttons' boxes may overlap (so a tap can
  // never land on the wrong chord), the point at each button's centre must hit
  // THAT button, and the current chord is still the one heard, in --chord-now.
  test(`phone chords @ ${vp[0]}x${vp[1]}: QA-01 half-beat chords are >= 24px to tap, hit areas never overlap`, async () => {
    // Single-letter names are the narrowest the layout can draw; half a beat
    // is the shortest slot the model keeps (MIN_SLOT_BEATS).
    const prog = [
      [['C:maj', 4]],
      [['A:min', 3.5], ['F:maj', 0.5]],
      [['G:maj', 4]],
      [['E:min', 2], ['C:maj', 1.5], ['G:maj', 0.5]],
      [['A:min', 0.5], ['F:maj', 3.5]],
      [['G:maj', 4]],
      [['C:maj', 2], ['F:maj', 2]],
      [['G:7', 4]],
    ];
    const bars = Array.from({ length: 32 }, (_, k) => prog[k % prog.length]);
    const { payload, grid, beat } = synth(bars, 100);
    const { ctx, page, errors } = await open(browser, built, vp, { pos: 1, grid, sections: [], payload });
    try {
      const f = [];
      let buttons = 0;
      let short = 0;
      let tapped = 0;
      let curShort = 0;
      const halfBeat = payload.segments.filter((s) => s.end_sec - s.start_sec < beat * 0.75);
      if (halfBeat.length < 8) f.push(`fixture has only ${halfBeat.length} half-beat chords`);
      // Every bar's middle, plus the middle of every half-beat chord (so a
      // half-beat chord is the CURRENT one, drawn at its larger current size).
      const positions = [...bars.map((_, k) => 0.5 + (k * 4 + 1.3) * beat), ...halfBeat.map((s) => (s.start_sec + s.end_sec) / 2)];
      for (const t of positions) {
        await moveTo(page, t);
        const ctxs = `${vp.join('x')} QA-01 t=${t.toFixed(2)}`;
        const m = await page.evaluate(measure);
        if (m.mode !== 'bars') { f.push(`mode ${m.mode} (${m.reason}), want bars @ ${ctxs}`); break; }
        checkSlots(m, f, ctxs);
        const r = await page.evaluate(() => {
          const track = document.querySelector('[data-testid="player-harmony-track"]');
          const bs = [...track.querySelectorAll('[data-testid^="phone-slot-"]')];
          return bs.map((b) => {
            const q = b.getBoundingClientRect();
            const cx = q.left + q.width / 2;
            const cy = q.top + q.height / 2;
            const hit = document.elementFromPoint(cx, cy)?.closest('[data-testid^="phone-slot-"]');
            return {
              id: b.dataset.testid, title: b.title, l: q.left, t: q.top, r: q.right, b: q.bottom, w: q.width, h: q.height,
              start: Number(b.dataset.startSec), end: Number(b.dataset.endSec),
              current: b.getAttribute('aria-current') === 'true', color: getComputedStyle(b).color,
              hitSelf: hit === b, inView: cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight,
            };
          });
        });
        buttons += r.length;
        for (const b of r) {
          if (b.end - b.start < beat * 0.75) short++;
          if (b.w < 24 || b.h < 24) f.push(`${b.id} ${b.title} (${(b.end - b.start).toFixed(2)}s) is ${b.w.toFixed(1)}x${b.h.toFixed(1)}px < 24 @ ${ctxs}`);
          if (b.inView && !b.hitSelf) f.push(`${b.id} ${b.title}: a tap at its centre does not hit it @ ${ctxs}`);
        }
        for (let i = 0; i < r.length; i++)
          for (let j = i + 1; j < r.length; j++) {
            const a = r[i];
            const c = r[j];
            const ix = Math.min(a.r, c.r) - Math.max(a.l, c.l);
            const iy = Math.min(a.b, c.b) - Math.max(a.t, c.t);
            if (ix > 0.01 && iy > 0.01) f.push(`${a.id} ${a.title} and ${c.id} ${c.title} overlap ${ix.toFixed(1)}x${iy.toFixed(1)}px @ ${ctxs}`);
          }
        // The current chord is the one heard, painted in --chord-now (#f59e0b).
        const heard = payload.segments.find((s) => s.start_sec <= t && t < s.end_sec);
        const cur = r.filter((b) => b.current);
        if (cur.length !== 1) f.push(`${cur.length} current chords @ ${ctxs}`);
        else {
          if (cur[0].title !== heard.label || Math.abs(cur[0].start - heard.start_sec) > 1e-3) f.push(`current chord ${cur[0].title}@${cur[0].start}, heard ${heard.label}@${heard.start_sec} @ ${ctxs}`);
          if (cur[0].color !== 'rgb(245, 158, 11)') f.push(`current chord colour ${cur[0].color}, want --chord-now rgb(245, 158, 11) @ ${ctxs}`);
          if (heard.end_sec - heard.start_sec < beat * 0.75) curShort++;
        }
      }
      // Phase A: the chord editor is hidden (it dropped every pick, ChordOverlay's
      // header) and cells are never interactive while playing. A real tap on the
      // centre of half-beat cells lands on THAT cell and opens NOTHING.
      for (const t of positions.slice(0, 8)) {
        await moveTo(page, t);
        const ids = await page.evaluate((bt) => [...document.querySelectorAll('[data-testid="player-harmony-track"] [data-testid^="phone-slot-"]')]
          .filter((b) => Number(b.dataset.endSec) - Number(b.dataset.startSec) < bt * 0.75)
          .map((b) => b.dataset.testid), beat);
        for (const id of ids) {
          const el = page.locator(`[data-testid="${id}"]`).first();
          const box = await el.boundingBox();
          if (!box) continue;
          const tag = await el.evaluate((e) => `${e.tagName}/${e.getAttribute('role')}`);
          if (tag !== 'SPAN/img') f.push(`${id} is ${tag}, want a non-interactive SPAN/img @ ${vp.join('x')} t=${t.toFixed(2)}`);
          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
          await settle(page);
          if (await page.locator('[data-testid="chord-popover"]').count()) {
            f.push(`tap on ${id} opened a chord editor @ ${vp.join('x')} t=${t.toFixed(2)}`);
            await page.locator('[data-testid="chord-popover"] button:has-text("Cancel")').click();
          } else tapped++;
          await settle(page);
        }
        if (await page.locator('[data-testid="player-harmony-track"] button').count()) f.push(`a button in the chord track while playing @ t=${t.toFixed(2)}`);
      }
      if (short < 20) f.push(`only ${short} half-beat buttons measured`);
      if (curShort < 4) f.push(`a half-beat chord was current only ${curShort} times`);
      if (tapped < 4) f.push(`only ${tapped} half-beat buttons tapped`);
      if (process.env.CHORD_GATE_LOG) console.log(`QA-01 ${vp.join('x')}: ${buttons} buttons, ${short} half-beat, ${tapped} tapped, ${curShort} half-beat current`);
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
          if (m.dots.length !== (m.countdown ? 0 : m3)) f.push(`${m.dots.length} beat dots, want ${m.countdown ? 0 : m3} @ ${ctxs}`);
          const wantBeat = Math.floor((t - 0.5 - k * m3 * beat) / beat + 1e-9) + 1;
          if (!m.countdown && m.beat !== String(wantBeat)) f.push(`beat ${m.beat}, want ${wantBeat} @ ${ctxs}`);
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
          if (m.dots.length !== (m.countdown ? 0 : bc.m)) f.push(`${m.dots.length} beat dots, want ${m.countdown ? 0 : bc.m} @ ${ctxs}`);
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

// QA A-03 (track A, 2026-11-18): in phone LANDSCAPE (844x390, 800x360) the
// current bar was drawn below the screen: a line of stacked three-chord bars is
// two or three rows tall, the chord area clipped it and the screen did not
// scroll. The player must fit or scroll, so at every bar of a song full of
// stacked bars, with a notice bar showing (the worst case for height):
//   * the CURRENT bar cell is fully on screen: inside the viewport and inside
//     every clipping box above it (measured from the DOM, not from a test id
//     the fix added), and the point at its centre hits the cell itself;
//   * the page behind never scrolls, and in landscape the player screen itself
//     does not grow past the viewport (only the chord area may scroll).
// Portrait sizes run the same check as a control.
const A03_VIEWPORTS = [[844, 390], [800, 360], [740, 360], [667, 375], [390, 844], [360, 800]];
const A03_BARS = [
  [['A:min', 4]],
  [['C#:hdim7/5', 2], ['G:maj/3', 1], ['C:maj/3', 1]],
  [['C#:hdim7/5', 2], ['Bb:maj', 1], ['G:maj/3', 1]],
  [['G:7', 4]],
];
// A denser song, in QA's own shapes: lines two and three rows tall. At 844x390
// they now fit the chord area (which has the whole column); at 800x360 they do
// not, and that is the case that proves the screen itself never grows past the
// viewport (the chord area scrolls instead).
const A03_DENSE = [
  // QA's fixture: plain bars, then its worst-case shapes (its bars 10-13):
  // half-beat chords, slash chords and long names, three to a bar.
  [['G:min', 4]],
  [['Eb:maj', 4]],
  [['Bb:maj', 4]],
  [['F:maj', 3], ['D:7', 1]],
  [['C:min7', 2], ['D:7/3', 0.5], ['F#:hdim7/b7', 1.5]],
  [['Bb:maj7/5', 1], ['C#:hdim7/5', 1], ['Eb:maj/b7', 2]],
  [['G:min', 3.5], ['A:7', 0.5]],
  [['Eb:maj', 0.5], ['Bb:maj', 3.5]],
];
const A03_CASES = [
  ...A03_VIEWPORTS.map((vp) => ({ vp, name: 'stacked bars', bars: A03_BARS, mustScroll: false })),
  { vp: [844, 390], name: "QA's worst-case bars", bars: A03_DENSE, mustScroll: false },
  { vp: [800, 360], name: "QA's worst-case bars", bars: A03_DENSE, mustScroll: false },
  { vp: [800, 330], name: "QA's worst-case bars", bars: A03_DENSE, mustScroll: false },
  // The scroll path (content taller than its box). Since the review of #333
  // (round 2) the current line may squeeze to x0.8 before the box scrolls, so
  // these stacked / worst-case bars fit down to 667x375 and 800x330; the
  // scroll path is exercised on the next shorter screens.
  { vp: [667, 320], name: 'stacked bars', bars: A03_BARS, mustScroll: true },
  { vp: [800, 300], name: "QA's worst-case bars", bars: A03_DENSE, mustScroll: true },
];
for (const { vp, name, bars: shape, mustScroll } of A03_CASES) {
  test(`A-03 phone chords @ ${vp[0]}x${vp[1]}: the current bar is always fully on screen (${name}, notice showing)`, async () => {
    const bars = Array.from({ length: 32 }, (_, k) => shape[k % shape.length]);
    const { payload, grid, beat } = synth(bars, 96);
    const degraded = { missing: ['other'] };
    const { ctx, page, errors } = await open(browser, built, vp, { pos: 1, grid, sections: [], payload, degraded });
    const f = [];
    let checked = 0;
    let tallLines = 0;
    try {
      for (let k = 0; k < 32; k++) {
        for (const off of [0.3, 2.5, 3.5]) {
          const t = 0.5 + (k * 4 + off) * beat;
          await moveTo(page, t, null, degraded);
          const m = await page.evaluate(() => {
            const cell = document.querySelector('[data-testid="phone-chords"] [role="group"][aria-current="true"]');
            const root = document.querySelector('[data-testid="player"]');
            if (!cell || !root) { const pc = document.querySelector('[data-testid="phone-chords"]'); return { missing: !cell ? `current bar (mode ${pc?.dataset.mode}/${pc?.dataset.reason})` : 'player' }; }
            const r = cell.getBoundingClientRect();
            // The visible box: the viewport, cut by every clipping ancestor up to the fixed screen.
            let vis = { t: 0, b: innerHeight, l: 0, r: innerWidth };
            let clipH = null;
            for (let e = cell.parentElement; e && e !== document.documentElement; e = e.parentElement) {
              const cs = getComputedStyle(e);
              if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
                const b = e.getBoundingClientRect();
                vis = { t: Math.max(vis.t, b.top), b: Math.min(vis.b, b.bottom), l: Math.max(vis.l, b.left), r: Math.min(vis.r, b.right) };
                if (e !== root && e.scrollHeight > e.clientHeight + 1) clipH = true;
              }
              if (cs.position === 'fixed') break;
            }
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
              cell: { t: r.top, b: r.bottom, l: r.left, r: r.right },
              vis,
              hits: !!hit && cell.contains(hit),
              label: cell.getAttribute('aria-label'),
              clipH,
              rootGrows: root.scrollHeight - root.clientHeight,
              docScroll: document.scrollingElement.scrollHeight - innerHeight,
              notice: !!document.querySelector('[data-testid="player-notice"]'),
            };
          });
          const tag = `${vp.join('x')} bar#${k} +${off} beats`;
          if (m.missing) { f.push(`${tag}: no ${m.missing}`); continue; }
          checked++;
          if (!m.notice) f.push(`${tag}: no notice bar, so this case does not test what it names`);
          const E = 0.5;
          if (m.cell.t < m.vis.t - E || m.cell.b > m.vis.b + E || m.cell.l < m.vis.l - E || m.cell.r > m.vis.r + E)
            f.push(`${tag}: current bar "${m.label}" (${m.cell.t.toFixed(1)}–${m.cell.b.toFixed(1)}) is not fully on screen (visible ${m.vis.t.toFixed(1)}–${m.vis.b.toFixed(1)})`);
          else if (!m.hits) f.push(`${tag}: current bar "${m.label}" is covered by something else at its centre`);
          if (m.docScroll > 0) f.push(`${tag}: the page behind scrolls by ${m.docScroll}px`);
          if (vp[1] < 500 && m.rootGrows > 0) f.push(`${tag}: the player screen grows ${m.rootGrows}px past the viewport (only the chord area may scroll)`);
          if (m.clipH) tallLines++;
        }
      }
      if (checked < 90) f.push(`only ${checked} positions measured`);
      // Non-vacuity: where marked, the chord content is (at some bars) taller
      // than the box that clips it, so the scroll path, not just the fit path,
      // is what the case exercises.
      if (mustScroll && tallLines === 0) f.push('the chord content never overflowed its clipping box: this case no longer tests the scroll path');
      assert.deepEqual(errors, [], 'the page threw');
      fail(f);
    } finally {
      await ctx.close();
    }
  });
}

// Review of #301, F-8: the landscape follow (A-03) must (1) read no layout on a
// render where neither the current bar nor the current chord changed, and (2)
// stand back for a few seconds after the person scrolls the chord area, then
// catch up. 667x375 with QA's stacked bars is a size where the area scrolls.
// 667x320: the screen where these bars still overflow their box (since round 2
// of the #333 review the current line squeezes before it scrolls; see A03_CASES).
test('F-8 phone chords @ 667x320: no layout read on unchanged renders; a manual scroll pauses the follow, then it resumes', async () => {
  const bars = Array.from({ length: 32 }, (_, k) => A03_BARS[k % 4]);
  const { payload, grid, beat } = synth(bars, 96);
  const degraded = { missing: ['other'] };
  const at = (k, off) => 0.5 + (k * 4 + off) * beat;
  const { ctx, page, errors } = await open(browser, built, [667, 320], { pos: at(2, 2.5), grid, sections: [], payload, degraded });
  const f = [];
  try {
    await moveTo(page, at(2, 2.5), null, degraded);
    // (1) Count geometry reads on the chord area across renders inside ONE chord.
    await page.evaluate(() => {
      const area = document.querySelector('[data-testid="player-harmony-track"]');
      window.__reads = 0;
      for (const prop of ['scrollHeight', 'clientHeight']) {
        const d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
        Object.defineProperty(area, prop, { configurable: true, get() { window.__reads++; return d.get.call(this); } });
      }
      const g = Element.prototype.getBoundingClientRect;
      area.getBoundingClientRect = function () { window.__reads++; return g.call(this); };
    });
    for (const d of [0.05, 0.1, 0.15, 0.2, 0.25]) await moveTo(page, at(2, 2.5 + d), null, degraded);
    const reads = await page.evaluate(() => window.__reads);
    if (reads !== 0) f.push(`${reads} layout reads on the chord area across 5 renders with the same bar and chord`);
    // Non-vacuity: a NEW bar does read (and follows).
    await moveTo(page, at(3, 0.3), null, degraded);
    if ((await page.evaluate(() => window.__reads)) === 0) f.push('a new bar caused no read: the follow is not running at all');

    // (2) The person scrolls the chord area to the top with the wheel...
    const box = await page.locator('[data-testid="player-harmony-track"]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -2000);
    await page.waitForTimeout(200);
    const top0 = await page.evaluate(() => document.querySelector('[data-testid="player-harmony-track"]').scrollTop);
    if (top0 !== 0) f.push(`the wheel did not scroll the area to the top (scrollTop ${top0})`);
    // ...and playback moves on to a bar that is out of view: the follow waits.
    await moveTo(page, at(6, 2.5), null, degraded);
    const held = await page.evaluate(() => document.querySelector('[data-testid="player-harmony-track"]').scrollTop);
    if (held !== 0) f.push(`the follow snapped back ${held}px right after the person scrolled`);
    // After the pause, the next render catches up: the current bar is fully visible again.
    await page.waitForTimeout(4300);
    await moveTo(page, at(6, 2.6), null, degraded);
    const m = await page.evaluate(() => {
      const area = document.querySelector('[data-testid="player-harmony-track"]').getBoundingClientRect();
      const c = document.querySelector('[data-testid="phone-chords"] [role="group"][aria-current="true"]').getBoundingClientRect();
      return { a: [area.top, area.bottom], c: [c.top, c.bottom], top: document.querySelector('[data-testid="player-harmony-track"]').scrollTop };
    });
    if (m.c[0] < m.a[0] - 0.5 || m.c[1] > m.a[1] + 0.5) f.push(`after the pause the current bar (${m.c.map((x) => x.toFixed(1))}) is still outside the area (${m.a.map((x) => x.toFixed(1))})`);
    if (m.top === 0) f.push('the follow never resumed (scrollTop still 0): this case did not need a scroll, so it tests nothing');
    assert.deepEqual(errors, []);
    fail(f);
  } finally {
    await ctx.close();
  }
});

// Review of #301 round 2, N5: a resize (a rotation) resets the F-8 follow, so the
// next render re-checks even when the current bar and chord are unchanged.
test('F-8 / N5 phone chords @ 667x320: a resize makes the next render re-follow the same bar', async () => {
  const bars = Array.from({ length: 32 }, (_, k) => A03_BARS[k % 4]);
  const { payload, grid, beat } = synth(bars, 96);
  const degraded = { missing: ['other'] };
  const at = (k, off) => 0.5 + (k * 4 + off) * beat;
  const { ctx, page, errors } = await open(browser, built, [667, 320], { pos: at(6, 2.5), grid, sections: [], payload, degraded });
  const f = [];
  const area = () => page.evaluate(() => {
    const a = document.querySelector('[data-testid="player-harmony-track"]');
    const r = a.getBoundingClientRect();
    const c = document.querySelector('[data-testid="phone-chords"] [role="group"][aria-current="true"]').getBoundingClientRect();
    return { top: a.scrollTop, inView: c.top >= r.top - 0.5 && c.bottom <= r.bottom + 0.5 };
  });
  try {
    await moveTo(page, at(6, 2.5), null, degraded);
    await moveTo(page, at(6, 2.55), null, degraded);
    const m0 = await area();
    if (!m0.inView || m0.top === 0) f.push(`setup: the follow did not bring bar 7 into view (scrollTop ${m0.top}): this case tests nothing`);
    // Move the area away WITHOUT a user gesture (no pause), then render the same bar and chord: no follow.
    await page.evaluate(() => { document.querySelector('[data-testid="player-harmony-track"]').scrollTop = 0; });
    await moveTo(page, at(6, 2.6), null, degraded);
    const m1 = await area();
    if (m1.top !== 0) f.push(`an unchanged render re-followed (scrollTop ${m1.top}): the keyed follow is not keyed`);
    // A resize, then the same bar and chord again: now it re-follows.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await moveTo(page, at(6, 2.65), null, degraded);
    const m2 = await area();
    if (!m2.inView) f.push(`after a resize the current bar is still out of view (scrollTop ${m2.top}): the resize did not reset the follow`);
    assert.deepEqual(errors, []);
    fail(f);
  } finally {
    await ctx.close();
  }
});

// Phase A (D6 + J5) and the review of #333 (B-1, H-4, M-3), on the three
// demo songs' REAL chord data in the app's DEFAULT "Simple" view, every 0.37 s
// of each song at 390x844 and 360x800:
//   * Now >= 72px at >= 95% of positions, never < 28px, never overlapping Next;
//   * Next >= 44px at every position at 390 (the share is logged at 360);
//     on the last beat it grows (<= 64px) and never shrinks Now;
//   * the countdown under Now at every position with a next chord ("N beats"
//     >= 20px, 4 neutral segments), and the beat dots hidden beside it;
//   * no empty band of 100px or more between the countdown and the bars
//     unless Now is already at its largest step;
//   * no button in the chord track.
const DEMO_SLUGS = ['lucky-ticket', 'im-asking-you', 'offline'];
function stageGeometry() {
  const q = (s) => document.querySelector(s);
  const cd = q('[data-testid="phone-countdown"]');
  const above = cd ?? q('[data-testid="phone-beats"]') ?? q('[data-testid="playhead-now"]');
  const line = q('[data-testid="phone-line-current"]');
  const nn = q('[data-testid="phone-next-name"]');
  const name = q('[data-testid="playhead-now-name"]');
  const nx = q('[data-testid="phone-next"]');
  const area = q('[data-testid="phone-chords"]');
  return {
    band: above && line ? line.getBoundingClientRect().top - above.getBoundingClientRect().bottom : 0,
    nowW: name ? Math.max(...[...name.children].map((c) => c.getBoundingClientRect().width)) : 0,
    nextW: nx ? nx.getBoundingClientRect().width : 0,
    areaW: area ? area.getBoundingClientRect().width : 0,
    nextPx: nn ? parseFloat(nn.style.fontSize) : null,
    growPx: nn ? Number(nn.dataset.growPx) : null,
    buttons: document.querySelectorAll('[data-testid="player-harmony-track"] button').length,
  };
}
for (const mode of ['simple', 'detailed']) for (const vp of [[390, 844], [360, 800]]) for (const slug of DEMO_SLUGS) {
  test(`phone chords @ ${vp[0]}x${vp[1]}: ${slug}, ${mode}${mode === 'simple' ? ' (default)' : ''}: Now >= 72 first, Next >= 44, countdown always, no empty band`, async () => {
    const D = JSON.parse(readFileSync(join(WEB, 'test/fixtures/demo-chords', `${slug}.json`), 'utf8'));
    const beat = 60 / D.bpm;
    const grid = { beatSec: beat, anchorSec: D.sections[0].start_sec, measured: true };
    const sections = D.sections.map((s) => ({ startSec: s.start_sec, endSec: s.end_sec, label: s.label }));
    const payload = { key: null, provider: 'klangio', provider_version: 'demo', duration_sec: D.duration_sec, model_ms: 1, segments: D.segments.map((s) => ({ ...s, confidence: 1 })) };
    const { ctx, page, errors } = await open(browser, built, vp, { pos: 1, grid, sections, payload, chordMode: mode });
    try {
      const f = [];
      const nowPx = [];
      let nexts = 0;
      let next44 = 0;
      let counted = 0;
      for (let t = 1; t < D.duration_sec - 1; t += 0.37) {
        await moveTo(page, t);
        const m = await page.evaluate(measure);
        const g = await page.evaluate(stageGeometry);
        const ctxs = `${vp.join('x')} ${mode} t=${t.toFixed(2)}`;
        if (!m.now) { f.push(`no Now @ ${ctxs}`); continue; }
        nowPx.push(m.now.fontPx);
        if (m.now.fontPx < 28) f.push(`Now ${m.now.fontPx}px < 28 @ ${ctxs}`);
        if (m.now.overlap) f.push(`Now overlaps Next: ${m.now.overlap} @ ${ctxs}`);
        if (!m.now.inX || m.now.clippedBy.length) f.push(`Now clipped @ ${ctxs}`);
        // No empty band of >= 100px when that height could hold a bigger Now:
        // the next ladder step (beside Next if it fits the width, else with
        // Next on its own ~105px row) would have fitted in the band.
        if (g.band >= 100 && m.now.fontPx < 120) {
          const step = m.now.fontPx < 72 ? 72 : m.now.fontPx < 96 ? 96 : 120;
          // x1.2: the stage sizes names for any phone font, not just this
          // gate's Inter, so a step that would fit with under 20% headroom is
          // not counted as missed.
          const wBig = ((g.nowW * step) / m.now.fontPx) * 1.2;
          const beside = wBig + g.nextW + 12 <= g.areaW;
          const cost = (step - m.now.fontPx) * 1.05 + (beside ? 0 : 105);
          if (wBig <= g.areaW && g.band >= cost + 10)
            f.push(`empty band ${g.band.toFixed(0)}px with Now at ${m.now.fontPx}px; ${step}px (${beside ? 'beside Next' : 'Next below'}) needs ${cost.toFixed(0)}px @ ${ctxs}`);
        }
        if (g.buttons) f.push(`${g.buttons} button(s) in the chord track @ ${ctxs}`);
        if (m.next) {
          nexts++;
          if (g.nextPx >= 44) next44++;
          else if (vp[0] === 390) f.push(`Next ${g.nextPx}px < 44 @ ${ctxs}`);
          const c = m.countdown;
          if (!c || c.kind !== 'beats' || !(c.beatsLeft >= 1)) { f.push(`countdown ${JSON.stringify(c)} @ ${ctxs}`); continue; }
          const n = c.beatsLeft;
          if (c.text !== `${n} beat${n === 1 ? '' : 's'}` || c.textPx < 20) f.push(`countdown text "${c.text}" ${c.textPx}px @ ${ctxs}`);
          if (c.segs !== 4 || c.lit !== (n <= 4 ? 5 - n : 0)) f.push(`countdown ${c.lit}/4 lit for ${n} beats @ ${ctxs}`);
          if (m.dots.length) f.push(`beat dots beside the countdown @ ${ctxs}`);
          // Next is 44px, or 32px where only that keeps Now >= 72 and the next
          // line (allowed at 360, reported; never at 390). On the last beat
          // it may grow, up to 64px.
          if (n > 1 && g.nextPx !== 44 && !(g.nextPx === 32 && vp[0] === 360)) f.push(`Next ${g.nextPx}px with ${n} beat(s) left @ ${ctxs}`);
          if (!(g.growPx >= 32 && g.growPx <= 64) || (vp[0] === 390 && g.growPx < 44)) f.push(`Next grow size ${g.growPx} @ ${ctxs}`);
          if (n === 1 && g.nextPx !== g.growPx) f.push(`Next ${g.nextPx}px on the last beat (grow ${g.growPx}) @ ${ctxs}`);
          counted++;
        }
      }
      const under = nowPx.filter((p) => p < 72).length / nowPx.length;
      if (under > 0.05) f.push(`Now < 72px at ${(under * 100).toFixed(1)}% of positions (min ${Math.min(...nowPx)}), want <= 5%`);
      if (counted < 150) f.push(`only ${counted} countdowns checked`);
      if (process.env.CHORD_GATE_LOG) console.log(`DEMO ${slug} ${mode} ${vp.join('x')}: Now<72 ${(under * 100).toFixed(1)}% min ${Math.min(...nowPx)} median ${nowPx.sort((a, b) => a - b)[nowPx.length >> 1]}; Next>=44 ${((next44 / nexts) * 100).toFixed(1)}% of ${nexts}`);
      assert.deepEqual(errors, []);
      fail(f);
    } finally {
      await ctx.close();
    }
  });
}

// Coordination (A1+A2+A3, 2026-11-21): with the section strip and the stem
// pills on screen the chord STAGE (padding included) is ~460-516px tall. At a
// 460px stage Now is >= 72px, the NEXT bar line shows (unless the song has no
// more bars), and nothing is clipped. Below that (420px) it degrades: the next
// line may go, Now is never clipped and never under 28px.
for (const [stageH, full] of [[460, true], [420, false]]) for (const vp of [[390, 844], [360, 800]]) for (const mode of ['simple', 'detailed']) for (const slug of DEMO_SLUGS) {
  test(`phone chords @ ${vp[0]}x${vp[1]}, stage ${stageH}px: ${slug}, ${mode}: ${full ? 'Now >= 72 AND the next line, nothing clipped' : 'next line may go, Now never clipped'}`, async () => {
    const D = JSON.parse(readFileSync(join(WEB, 'test/fixtures/demo-chords', `${slug}.json`), 'utf8'));
    const grid = { beatSec: 60 / D.bpm, anchorSec: D.sections[0].start_sec, measured: true };
    const sections = D.sections.map((s) => ({ startSec: s.start_sec, endSec: s.end_sec, label: s.label }));
    const payload = { key: null, provider: 'klangio', provider_version: 'demo', duration_sec: D.duration_sec, model_ms: 1, segments: D.segments.map((s) => ({ ...s, confidence: 1 })) };
    const { ctx, page, errors } = await open(browser, built, vp, { pos: 1, grid, sections, payload, chordMode: mode, stageH });
    try {
      const f = [];
      const got = await page.evaluate(() => Math.round(document.querySelector('[data-testid="player"] [class*="stage"]').getBoundingClientRect().height));
      if (Math.abs(got - stageH) > 1) f.push(`stage is ${got}px, the case wants ${stageH}px`);
      let noNext = 0;
      let n = 0;
      for (let t = 1; t < D.duration_sec - 1; t += full ? 0.37 : 0.74) {
        await moveTo(page, t);
        const m = await page.evaluate(measure);
        const g = await page.evaluate(() => {
          const area = document.querySelector('[data-testid="player-harmony-track"]').getBoundingClientRect();
          const lines = [...document.querySelectorAll('[data-testid="phone-line-current"], [data-testid="phone-line-next"]')].map((l) => l.getBoundingClientRect());
          const ends = [...document.querySelectorAll('[data-testid="phone-line-current"] [data-end-sec][data-cell]:not([data-run-index])')].map((c) => Number(c.dataset.endSec));
          return { areaTop: area.top, areaBottom: area.bottom, lines: lines.map((r) => [r.top, r.bottom]), curEnd: ends.length ? Math.max(...ends) : 0, next: !!document.querySelector('[data-testid="phone-line-next"]') };
        });
        const ctxs = `${vp.join('x')} stage ${stageH} ${mode} t=${t.toFixed(2)}`;
        n++;
        if (!m.now) { f.push(`no Now @ ${ctxs}`); continue; }
        if (!m.now.inX || m.now.clippedBy.length) f.push(`Now clipped (${m.now.clippedBy.join(',')}) @ ${ctxs}`);
        if (m.now.overlap) f.push(`Now overlaps Next: ${m.now.overlap} @ ${ctxs}`);
        if (m.now.fontPx < (full ? 72 : 28)) f.push(`Now ${m.now.fontPx}px @ ${ctxs}`);
        for (const [top, bottom] of g.lines) if (top < g.areaTop - 0.5 || bottom > g.areaBottom + 0.5) f.push(`a bar line (${top.toFixed(0)}-${bottom.toFixed(0)}) is outside the chord area (${g.areaTop.toFixed(0)}-${g.areaBottom.toFixed(0)}) @ ${ctxs}`);
        if (!g.next) {
          noNext++;
          // Allowed only on the song's last line: no chord starts after it.
          if (full && D.segments.some((x) => x.label !== 'N' && x.start_sec >= g.curEnd + 0.05)) f.push(`no next line, but the song goes on after ${g.curEnd.toFixed(2)}s @ ${ctxs}`);
        }
      }
      if (process.env.CHORD_GATE_LOG) console.log(`STAGE ${stageH} ${slug} ${mode} ${vp.join('x')}: ${n} positions, next line hidden at ${noNext}`);
      assert.deepEqual(errors, []);
      fail(f);
    } finally {
      await ctx.close();
    }
  });
}

// Review of #333 round 2 (B-1r) and Jon (18:35 PT: "hold until it's
// perfect"): the four target phones, 390x844, 360x800 and the small 375x667 /
// 390x664, with #331 on screen
// (the stem pills, the 1-row section strip with its "+N more" cue, the
// first-run "Tap to jump · hold to loop" line), no CSS override. Every 0.37 s
// of each demo, both views: Now >= 72px at EVERY position, nothing clipped,
// no overlap, no bar line outside the chord area. If the NEXT line cannot fit
// with Now at 72 it is hidden, never the other way round.
// Measured at the round-2 fix (1 point below): Next falls to 32px only where
// 44px (not growing) cannot keep Now at 72 with the next line.
const SMALL_NEXT44_FLOOR = Object.fromEntries(
  ['390x844', '360x800', '375x667', '390x664'].flatMap((v) => ['simple', 'detailed'].flatMap((m) => DEMO_SLUGS.map((d) => [`${d} ${m} ${v}`, 0.99]))),
);
SMALL_NEXT44_FLOOR['lucky-ticket simple 390x664'] = 0.91;
SMALL_NEXT44_FLOOR['offline simple 390x664'] = 0.93;
for (const vp of [[390, 844], [360, 800], [375, 667], [390, 664]]) for (const mode of ['simple', 'detailed']) for (const slug of DEMO_SLUGS) {
  test(`phone chords @ ${vp[0]}x${vp[1]} (pills, 1-row strip, first-run hint): ${slug}, ${mode}: Now >= 72 everywhere`, async () => {
    const D = JSON.parse(readFileSync(join(WEB, 'test/fixtures/demo-chords', `${slug}.json`), 'utf8'));
    const grid = { beatSec: 60 / D.bpm, anchorSec: D.sections[0].start_sec, measured: true };
    const sections = D.sections.map((s) => ({ startSec: s.start_sec, endSec: s.end_sec, label: s.label }));
    const payload = { key: null, provider: 'klangio', provider_version: 'demo', duration_sec: D.duration_sec, model_ms: 1, segments: D.segments.map((s) => ({ ...s, confidence: 1 })) };
    const { ctx, page, errors } = await open(browser, built, vp, { pos: 1, grid, sections, payload, chordMode: mode });
    try {
      const f = [];
      const setup = await page.evaluate(() => ({
        pills: !!document.querySelector('[data-testid="part-pills"]'),
        hint: !!document.querySelector('[data-testid="section-first-hint"]'),
        area: Math.round(document.querySelector('[data-testid="player-harmony-track"]').getBoundingClientRect().height),
        scroll: document.documentElement.scrollHeight - innerHeight,
      }));
      if (!setup.pills) f.push('the stem pills are not on screen: this case does not test the small-phone layout');
      if (!setup.hint) f.push('the first-run hint is not on screen');
      const now = [];
      const small = [];
      let nextHidden = 0;
      let nexts = 0;
      let next44 = 0;
      for (let t = 1; t < D.duration_sec - 1; t += 0.37) {
        await moveTo(page, t);
        const m = await page.evaluate(measure);
        const g = await page.evaluate(() => {
          const area = document.querySelector('[data-testid="player-harmony-track"]').getBoundingClientRect();
          const lines = [...document.querySelectorAll('[data-testid="phone-line-current"], [data-testid="phone-line-next"]')].map((l) => l.getBoundingClientRect());
          return { top: area.top, bottom: area.bottom, lines: lines.map((r) => [r.top, r.bottom]), next: !!document.querySelector('[data-testid="phone-line-next"]') };
        });
        const ctxs = `${vp.join('x')} ${mode} t=${t.toFixed(2)}`;
        if (!m.now) { f.push(`no Now @ ${ctxs}`); continue; }
        now.push(m.now.fontPx);
        if (m.now.fontPx < 72) small.push(`${t.toFixed(2)}s "${m.now.text}" ${m.now.fontPx}px${g.next ? ' WITH the next line' : ''}`);
        if (m.now.fontPx < 72 && g.next) f.push(`Now ${m.now.fontPx}px while the NEXT line is shown @ ${ctxs}`);
        if (!m.now.inX || m.now.clippedBy.length) f.push(`Now clipped @ ${ctxs}`);
        if (m.now.overlap) f.push(`Now overlaps Next: ${m.now.overlap} @ ${ctxs}`);
        for (const [top, bottom] of g.lines) if (top < g.top - 0.5 || bottom > g.bottom + 0.5) f.push(`a bar line is outside the chord area @ ${ctxs}`);
        if (!g.next) nextHidden++;
        const npx = await page.evaluate(() => parseFloat(document.querySelector('[data-testid="phone-next-name"]')?.style.fontSize || 'NaN'));
        if (Number.isFinite(npx)) { nexts++; if (npx >= 44) next44++; }
      }
      // Next keeps 44px (not growing) before it drops to 32px: the share is
      // floored at what the ladder reaches today (SMALL_NEXT44_FLOOR).
      const share = next44 / Math.max(1, nexts);
      const floor = SMALL_NEXT44_FLOOR[`${slug} ${mode} ${vp.join('x')}`];
      if (floor !== undefined && share < floor) f.push(`Next >= 44px at ${(share * 100).toFixed(1)}% of positions, floor ${(floor * 100).toFixed(0)}%`);
      if (small.length) f.push(`Now < 72px at ${small.length}/${now.length} positions (min ${Math.min(...now)}): ${small.slice(0, 6).join('; ')}`);
      if (process.env.CHORD_GATE_LOG) console.log(`SMALL ${slug} ${mode} ${vp.join('x')}: chord area ${setup.area}px, page scroll ${setup.scroll}px; Now>=72 ${(((now.length - small.length) / now.length) * 100).toFixed(1)}% min ${Math.min(...now)}; next line hidden at ${nextHidden}/${now.length}; Next>=44 ${(share * 100).toFixed(1)}%`);
      assert.deepEqual(errors, []);
      fail(f);
    } finally {
      await ctx.close();
    }
  });
}

// Review of #333 round 2 (S08): a squeezed bar line never clips a name.
// Dense bars (long slash chords, three to a bar) on short narrow phones: every
// chord name in the lines is whole and every slot is >= 24px. (Found here:
// x0.8 on a stacked slot left 24px for a 20px name and cut "Cm7" by 2px.)
for (const vp of [[320, 568], [360, 640], [375, 667]]) {
  test(`phone chords @ ${vp[0]}x${vp[1]}: squeezed bar lines never clip a chord name`, async () => {
    const bars = Array.from({ length: 32 }, (_, k) => A03_DENSE[k % A03_DENSE.length]);
    const { payload, grid, beat } = synth(bars, 96);
    const { ctx, page, errors } = await open(browser, built, vp, { pos: 1, grid, sections: [], payload });
    try {
      const f = [];
      let squeezed = 0;
      for (let k = 0; k < 32; k++) {
        const t = 0.5 + (k * 4 + 1.3) * beat;
        await moveTo(page, t);
        const r = await page.evaluate(() => ({
          squeeze: document.querySelector('[data-testid="phone-chords"]')?.dataset.squeeze ?? null,
          slots: [...document.querySelectorAll('[data-testid="player-harmony-track"] [data-testid^="phone-slot-"]')].map((b) => {
            const q = b.getBoundingClientRect();
            return { t: b.title, text: b.textContent, overX: b.scrollWidth - b.clientWidth, overY: b.scrollHeight - b.clientHeight, w: q.width, h: q.height };
          }),
        }));
        if (r.squeeze) squeezed++;
        for (const x of r.slots) {
          if (!x.text) f.push(`slot ${x.t} has no name @ ${vp.join('x')} bar#${k}`);
          if (x.overX > 0 || x.overY > 0) f.push(`slot ${x.t} "${x.text}" is clipped (${x.overX}/${x.overY}px) @ ${vp.join('x')} bar#${k} squeeze ${r.squeeze}`);
          if (x.w < 24 || x.h < 24) f.push(`slot ${x.t} is ${x.w.toFixed(1)}x${x.h.toFixed(1)}px @ ${vp.join('x')} bar#${k}`);
        }
      }
      if (process.env.CHORD_GATE_LOG) console.log(`SQUEEZE ${vp.join('x')}: squeezed at ${squeezed}/32`);
      assert.deepEqual(errors, []);
      fail(f);
    } finally {
      await ctx.close();
    }
  });
}

// Review of #333 round 2 (S06, S13): where Now cannot reach 72px (a phone on
// its side with the notice bar), the degrade order still holds: the NEXT line
// is hidden before Now shrinks, and the bars never grow into spare height
// while Now is under 72px. Not vacuous: Now must be under 72 somewhere.
for (const vp of [[844, 390], [800, 360], [740, 360]]) {
  test(`phone chords @ ${vp[0]}x${vp[1]}: Now < 72 => no next line and no grown bars`, async () => {
    const bars = Array.from({ length: 32 }, (_, k) => A03_BARS[k % 4]);
    const { payload, grid, beat } = synth(bars, 96);
    const degraded = { missing: ['other'] };
    const { ctx, page, errors } = await open(browser, built, vp, { pos: 1, grid, sections: [], payload, degraded });
    try {
      const f = [];
      let under = 0;
      for (let k = 0; k < 32; k++) {
        const t = 0.5 + (k * 4 + 1.3) * beat;
        await moveTo(page, t);
        const m = await page.evaluate(measure);
        const g = await page.evaluate(() => ({
          next: !!document.querySelector('[data-testid="phone-line-next"]'),
          scales: [...document.querySelectorAll('[data-testid="phone-line-current"], [data-testid="phone-line-next"]')].map((l) => Number(l.dataset.scale)),
        }));
        if (!m.now || m.now.fontPx >= 72) continue;
        under++;
        const ctxs = `${vp.join('x')} bar#${k} Now ${m.now.fontPx}px`;
        if (g.next) f.push(`the NEXT line is shown while Now is ${m.now.fontPx}px @ ${ctxs}`);
        for (const sc of g.scales) if (sc > 1.0001) f.push(`a bar line is grown x${sc} while Now is under 72px @ ${ctxs}`);
      }
      if (under === 0) f.push('Now was never under 72px here: this case tests nothing');
      if (process.env.CHORD_GATE_LOG) console.log(`DEGRADE ${vp.join('x')}: Now < 72 at ${under}/32`);
      assert.deepEqual(errors, []);
      fail(f);
    } finally {
      await ctx.close();
    }
  });
}

test('teardown', async () => {
  if (browser) await browser.close();
});
