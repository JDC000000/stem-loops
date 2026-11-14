// REAL-BROWSER GATE: text sizes in the play-along player (Stories 3.7 and 4.8).
//
// WHAT IT CHECKS (brand book v2.2 Appendix A, decided by Jon 2026-11-14)
//   A11  The CURRENT chord name (the "Now" readout under the chord timeline) is
//        at least CURRENT_MIN_PX, measured as rendered: computed font-size, the
//        rendered text box, and the height of the INK actually painted (two
//        screenshots, text paint on and off). At the default zoom and at the
//        zoom ceiling, at 1280 / 1024 / 390 px viewports, and for the longest
//        chord name in the song (it must not be clipped either).
//        Upcoming chords (the chips after the current one) may be smaller but
//        not below the A15 floor.
//   A15  No visible text in the player is below the floor: 11px for readable
//        text, 12px for monospace labels and tags. The ONE exemption the brand
//        book grants inside the player is the mixer's level readout ("80%"),
//        which may be 10px. Every visible text node inside [data-testid=player]
//        is checked, and the count checked is printed and must be non-trivial.
//   A16  Song-section chips: 4px corners on every corner, at least 44px tall,
//        and the name is not clipped inside the chip.
//   Kept  Chord-root hues on the chord chips (Jon: "I like the colour
//        separations"): every chord root maps to ONE background, and different
//        roots to different backgrounds.
//   Kept  Mixer channel order drums, bass, guitar, keys, vocals, other (Story 2.1).
//   1024  The page does not scroll sideways at 1024px or 1280px.
//
// WHAT IT RENDERS. The real PlayerView (src/components/play/Player.tsx: the
// hook-free render of the player) with the real ChordOverlay, Transport, Mixer
// and SectionLoop and the real CSS (globals.css plus each CSS module), bundled
// with esbuild exactly as chord-chip-fit.test.mjs does, fed the 3:33 production
// chord artifact through the real loader. The engine is not run: the snapshot is
// a fixed "ready, paused at T" state, which is what a user sees before pressing
// play, and the chord playhead reads the same `positionSec` either way.
//
// HOW IT IS KEPT HONEST. It FAILS (does not skip) when Chromium or the page is
// missing; it asserts it measured a non-trivial number of text nodes and every
// section chip; it asserts the "Now" readout is visible and names the chord the
// playhead ring is on. It is not a contrast check and not a layout review.
//
// ENVIRONMENT (optional)
//   CHORD_GATE_SRC      path of an apps/web checkout to bundle (default: this one).
//   PLAYER_GATE_SHOTS   a directory: also save a full-page PNG of the player at
//                       each viewport (used for the PR's before/after screenshots).
//   CHORD_GATE_LOG      set to 1 to print the measurements on success as well.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const esbuild = require('esbuild');

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(process.env.CHORD_GATE_SRC ?? join(HERE, '../../../apps/web'));
const LOG = process.env.CHORD_GATE_LOG === '1';
const SHOTS = process.env.PLAYER_GATE_SHOTS ? resolve(process.env.PLAYER_GATE_SHOTS) : null;

// ---------------------------------------------------------------------------
// The numbers. These are the GATE's statement of the brand book, not values
// read from the component, so a component change cannot lower them.
// ---------------------------------------------------------------------------
/** A11: the current chord name, in CSS px. */
export const CURRENT_MIN_PX = 20;
/** A11 "weight 600". */
export const CURRENT_MIN_WEIGHT = 600;
/**
 * The painted ink of the current chord name must be at least this fraction of
 * CURRENT_MIN_PX tall. A chord name always has a capital root letter, and the
 * cap height of a text sans face is ~0.7em (Inter 0.727, DejaVu Sans 0.729), so
 * 0.6 is a floor with room for any ordinary face. It is here to catch a name
 * that DECLARES 20px and renders smaller (a transform, a zoom, an SVG text
 * scale): computed font-size would not see any of those.
 */
export const CURRENT_MIN_INK_RATIO = 0.6;
/** A15: readable text. */
export const MIN_TEXT_PX = 11;
/** A15: monospace labels and tags. */
export const MIN_MONO_PX = 12;
/** A15: the mixer level readout, the one exemption inside the player. */
export const MIXER_READOUT_MIN_PX = 10;
/** A16. */
export const SECTION_MIN_HEIGHT_PX = 44;
export const SECTION_RADIUS_PX = 4;
/** Story 2.1. */
export const STEM_ORDER = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
/** Layout-unit slack (1/64 px) for "inside" comparisons. */
const EPS = 0.02;

const VIEWPORTS = [1280, 1024, 390];
// null = default zoom (what a user first sees); 1000 = the zoom ceiling.
const SLIDER_STOPS = [null, 1000];

// Same pinned face as chord-chip-fit.test.mjs, scoped to the chord overlay
// only (that is where the chip measurer reads its font). The rest of the player
// renders in whatever the app's own stack resolves to on this machine.
const FONT_DIR = join(dirname(require.resolve('@fontsource/inter/package.json')), 'files');
const WEIGHTS = [400, 500, 600, 700];
const FONT_CSS =
  WEIGHTS.map((w) => `@font-face{font-family:GateInter;font-weight:${w};font-style:normal;src:url(/font-${w}.woff2) format('woff2')}`).join('') +
  '[data-testid="chord-overlay"]{font-family:GateInter,sans-serif !important}';

// ---------------------------------------------------------------------------
// DATA
// ---------------------------------------------------------------------------
const REAL = JSON.parse(readFileSync(join(WEB, 'test/fixtures/play-chords-3m33s.json'), 'utf8'));
const DURATION = Math.ceil(Math.max(...REAL.segments.map((s) => s.end_sec)));
const SECTIONS = [
  { startSec: 0, endSec: 15.089, label: 'intro' },
  { startSec: 15.089, endSec: 47.5, label: 'verse' },
  { startSec: 47.5, endSec: 79.2, label: 'chorus' },
  { startSec: 79.2, endSec: 111.6, label: 'verse' },
  { startSec: 111.6, endSec: 143.9, label: 'chorus' },
  { startSec: 143.9, endSec: 176.3, label: 'bridge' },
  { startSec: 176.3, endSec: DURATION, label: 'outro' },
];
// Two playhead positions: an ordinary chord, and the chord with the longest
// Harte label in the song (the longest "Now" text, so the clip check bites).
const mid = (s) => (s.start_sec + s.end_sec) / 2;
const chordSegs = REAL.segments.filter((s) => s.label !== 'N' && s.label !== 'X');
const longest = chordSegs.reduce((a, b) => (b.label.length > a.label.length ? b : a));
const POSITIONS = [
  { name: 'ordinary', sec: mid(REAL.segments[10]) },
  { name: `longest(${longest.label})`, sec: mid(longest) },
];

function snapshotAt(positionSec) {
  return {
    status: 'ready',
    positionSec,
    durationSec: DURATION,
    stems: STEM_ORDER.map((name) => ({
      name,
      // One stem unavailable so the per-channel note (a sentence) renders and
      // is measured too.
      availability: name === 'other' ? 'unavailable' : 'ready',
      gain: 0.8,
      muted: false,
      soloed: false,
      effectivelySilent: false,
    })),
    // A loop is active so the "Looping" badge renders and is measured.
    loop: SECTIONS[2],
    degraded: { missing: ['other'] },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// BUNDLE the real PlayerView.
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
        createRoot(document.getElementById('root')).render(
          React.createElement(PlayerView, {
            jobId: 'gate-job',
            phase: { kind: 'ready' },
            snapshot: window.__gateSnapshot,
            sections: window.__gateSections,
            onPlay: noop, onPause: noop, onSeek: noop, onGain: noop,
            onMute: noop, onSolo: noop, onLoop: noop,
          }),
        );
      `,
      resolveDir: WEB,
      loader: 'js',
      sourcefile: 'player-gate-entry.js',
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
    // The player reports stem-fetch failures to Sentry (src/lib/play/report-failure.ts).
    // @sentry/nextjs drags Node built-ins into a browser bundle, and nothing is
    // reported in this gate, so it is replaced by a no-op of the one call used.
    plugins: [
      {
        name: 'stub-sentry',
        setup(b) {
          b.onResolve({ filter: /^@sentry\/nextjs$/ }, () => ({ path: 'sentry-stub', namespace: 'gate-stub' }));
          b.onLoad({ filter: /.*/, namespace: 'gate-stub' }, () => ({ contents: 'export function captureMessage() {}', loader: 'js' }));
        },
      },
    ],
  });
  const js = res.outputFiles.find((f) => f.path.endsWith('.js'));
  const css = res.outputFiles.find((f) => f.path.endsWith('.css'));
  assert.ok(js, 'esbuild produced no JS for PlayerView');
  return { js: js.text, css: css?.text ?? '' };
}

async function openPlayer(browser, built, width, positionSec) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.route('http://gate.test/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<link rel="stylesheet" href="/out.css">' +
          `<style>${FONT_CSS}</style>` +
          '</head><body>' +
          // The job page's own frame: max 960px, centred, the app gutter.
          '<main style="max-width:960px;margin:0 auto;padding:48px var(--sl-gutter,16px) 96px"><div id="root"></div></main>' +
          `<script>window.__gateSnapshot=${JSON.stringify(snapshotAt(positionSec))};window.__gateSections=${JSON.stringify(SECTIONS)};</script>` +
          '<script>Promise.all([400,500,600,700].map(function(w){return document.fonts.load(w+" 16px GateInter")}))' +
          ".then(function(){var s=document.createElement('script');s.src='/out.js';document.body.appendChild(s)})</script>" +
          '</body></html>',
      });
    const fm = /^\/font-(\d+)\.woff2$/.exec(u.pathname);
    if (fm) return route.fulfill({ contentType: 'font/woff2', body: readFileSync(join(FONT_DIR, `inter-latin-${fm[1]}-normal.woff2`)) });
    if (u.pathname === '/out.js') return route.fulfill({ contentType: 'text/javascript', body: built.js });
    if (u.pathname === '/out.css') return route.fulfill({ contentType: 'text/css', body: built.css });
    if (u.pathname.endsWith('/play-chords'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ signed_url: '/signed.json', expires_in_sec: 60 }) });
    if (u.pathname === '/signed.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(REAL) });
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await page.goto('http://gate.test/');
  await page.waitForSelector('[data-testid="player"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid^="chord-chip-"]', { timeout: 30000 });
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-testid="zoom-slider"]');
    return s && !s.disabled;
  }, null, { timeout: 30000 });
  await settle(page);
  return { page, pageErrors };
}

const settle = (page) =>
  page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));

async function setSlider(page, thousandths) {
  const before = await page.evaluate(() => document.querySelector('[data-testid="chord-timeline"]').dataset.pxPerSec);
  const sliderBefore = await page.evaluate(() => document.querySelector('[data-testid="zoom-slider"]').value);
  await page.evaluate((v) => {
    const el = document.querySelector('[data-testid="zoom-slider"]');
    // React 18 installs its own `value` setter; the prototype's fires onChange.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, thousandths);
  if (String(thousandths) !== sliderBefore)
    await page.waitForFunction(
      (b) => document.querySelector('[data-testid="chord-timeline"]').dataset.pxPerSec !== b,
      before,
      { timeout: 10000 },
    );
  await settle(page);
}

// ---------------------------------------------------------------------------
// MEASURE, in the page.
// ---------------------------------------------------------------------------
function measurePlayer() {
  const px = (v) => parseFloat(v) || 0;
  const root = document.querySelector('[data-testid="player"]');
  const out = { texts: [], sections: [], current: null, upcoming: [], hues: [], stems: [], overflow: null };

  // Is this element's text actually on screen? Not display:none, not
  // visibility:hidden, not a 1px visually-hidden span, not clipped to nothing.
  const shown = (el, rect) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      if (cs.clip && cs.clip !== 'auto') return false;
      if (cs.clipPath && cs.clipPath !== 'none') return false;
    }
    return rect.width > 1.5 && rect.height > 1.5;
  };

  // A15: every visible text node in the player.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode()); ) {
    if (!n.data.trim()) continue;
    const el = n.parentElement;
    const rg = document.createRange();
    rg.selectNodeContents(n);
    const r = rg.getBoundingClientRect();
    if (!shown(el, r)) continue;
    const cs = getComputedStyle(el);
    const mono = /mono|monospace|consolas|courier|menlo/i.test(cs.fontFamily);
    const channel = el.closest('[role="group"][data-stem]');
    const isReadout =
      !!channel && el.getAttribute('aria-hidden') === 'true' && /^(\d+%|—)$/.test(n.data.trim()) && el.parentElement?.parentElement === channel;
    out.texts.push({
      text: n.data.trim().slice(0, 40),
      tag: el.tagName.toLowerCase(),
      testid: el.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
      cls: el.className && typeof el.className === 'string' ? el.className : '',
      fontPx: px(cs.fontSize),
      mono,
      isReadout,
      family: cs.fontFamily.slice(0, 40),
    });
  }

  // A16: section chips (and the Clear loop button, which shares the style).
  const sec = root.querySelector('section[aria-label="Loop a section"]');
  for (const b of sec ? sec.querySelectorAll('button') : []) {
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    const name = b.querySelector('span') ?? b;
    const nr = (() => {
      const rg = document.createRange();
      rg.selectNodeContents(name);
      return rg.getBoundingClientRect();
    })();
    const contentL = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const contentR = r.right - px(cs.borderRightWidth) - px(cs.paddingRight);
    out.sections.push({
      text: b.textContent,
      h: r.height,
      w: r.width,
      radii: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
      nameFontPx: px(getComputedStyle(name).fontSize),
      nameOverL: contentL - nr.left,
      nameOverR: nr.right - contentR,
      scrollOver: b.scrollWidth - b.clientWidth,
      right: r.right,
    });
  }

  // A11: the current chord.
  const now = root.querySelector('[data-testid="playhead-now"]');
  const name = root.querySelector('[data-testid="playhead-now-name"]');
  const ring = root.querySelector('[data-testid="chord-playhead-ring"]');
  if (now) {
    const target = name ?? now;
    const cs = getComputedStyle(target);
    const rg = document.createRange();
    rg.selectNodeContents(target);
    const t = rg.getBoundingClientRect();
    // Every ancestor that clips (overflow other than visible) must contain the
    // whole text box: a name that is cut off is not read.
    const clippedBy = [];
    for (let e = target.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const ecs = getComputedStyle(e);
      if (ecs.overflowX !== 'visible' || ecs.overflowY !== 'visible') {
        const er = e.getBoundingClientRect();
        if (t.left < er.left - 0.02 || t.right > er.right + 0.02 || t.top < er.top - 0.02 || t.bottom > er.bottom + 0.02)
          clippedBy.push(e.getAttribute('data-testid') || e.tagName.toLowerCase());
      }
    }
    let alpha = 1;
    for (let e = target; e; e = e.parentElement) alpha *= Number(getComputedStyle(e).opacity);
    out.current = {
      hasNameEl: !!name,
      text: target.textContent,
      fontPx: px(cs.fontSize),
      weight: Number(cs.fontWeight),
      visibility: getComputedStyle(now).visibility,
      alpha,
      box: { x: t.left, y: t.top, w: t.width, h: t.height },
      inViewport: t.left >= -0.02 && t.right <= innerWidth + 0.02,
      clippedBy,
      runIndex: now.dataset.runIndex,
      ringRunIndex: ring ? ring.dataset.runIndex : null,
    };
    // Upcoming chords: the next few chips after the current run.
    const idx = Number(now.dataset.runIndex);
    for (let i = idx + 1; i <= idx + 4; i++) {
      const c = root.querySelector(`[data-testid="chord-chip-${i}"]`);
      if (!c) continue;
      out.upcoming.push({ id: c.dataset.testid, density: c.dataset.density, text: c.textContent, fontPx: px(getComputedStyle(c).fontSize) });
    }
  }

  // Chord-root hues.
  for (const c of root.querySelectorAll('[data-testid^="chord-chip-"][data-kind="chord"]')) {
    const label = c.getAttribute('title') || '';
    const rootName = label.split(/[:/]/)[0];
    out.hues.push({ root: rootName, bg: getComputedStyle(c).backgroundColor });
  }

  // Mixer order.
  out.stems = [...root.querySelectorAll('[role="group"][data-stem]')].map((g) => g.dataset.stem);

  const se = document.scrollingElement;
  out.overflow = { scrollW: se.scrollWidth, clientW: se.clientWidth, playerRight: root.getBoundingClientRect().right, innerW: innerWidth };
  return out;
}

// Ink of the current chord name: rows of pixels that change when its text
// paint is switched off. Layout does not move between the two shots.
async function inkHeight(page, helper) {
  // Bring the name into the viewport first: the player is taller than the
  // window, and a capture of an off-screen rectangle is blank.
  const box = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="playhead-now-name"]') || document.querySelector('[data-testid="playhead-now"]');
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rg = document.createRange();
    rg.selectNodeContents(el);
    const t = rg.getBoundingClientRect();
    return { x: t.left, y: t.top, w: t.width, h: t.height };
  });
  const clip = { x: Math.max(0, Math.floor(box.x) - 2), y: Math.max(0, Math.floor(box.y) - 2), width: Math.ceil(box.w) + 4, height: Math.ceil(box.h) + 4 };
  const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  const docClip = { ...clip, x: clip.x + scroll.x, y: clip.y + scroll.y, scale: 1 };
  const cdp = await page.context().newCDPSession(page);
  const a = (await cdp.send('Page.captureScreenshot', { format: 'png', clip: docClip })).data;
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = '__gate_hide_now';
    s.textContent =
      '[data-testid="playhead-now-name"],[data-testid="playhead-now-name"] *{color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important}';
    document.head.appendChild(s);
    return document.body.offsetHeight;
  });
  const b = (await cdp.send('Page.captureScreenshot', { format: 'png', clip: docClip })).data;
  await page.evaluate(() => document.getElementById('__gate_hide_now')?.remove());
  await cdp.detach();
  return helper.evaluate(
    async ({ a, b }) => {
      const load = async (b64) => {
        const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
        const cv = new OffscreenCanvas(bm.width, bm.height);
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(bm, 0, 0);
        return cx.getImageData(0, 0, bm.width, bm.height);
      };
      const A = await load(a);
      const B = await load(b);
      let top = Infinity;
      let bottom = -Infinity;
      let n = 0;
      for (let y = 0; y < A.height; y++)
        for (let x = 0; x < A.width; x++) {
          const i = (y * A.width + x) * 4;
          const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
          if (d >= 24) {
            n++;
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      return { pixels: n, height: n ? bottom - top + 1 : 0 };
    },
    { a, b },
  );
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------
let browser;
let built;
const summary = [];

test('Chromium launches and the real PlayerView bundles', async () => {
  built = await bundle();
  browser = await chromium.launch({ args: ['--font-render-hinting=none', '--enable-font-subpixel-positioning'] });
  assert.ok(browser.isConnected(), 'chromium did not launch');
});

for (const width of VIEWPORTS) {
  for (const pos of POSITIONS) {
    test(`player text sizes @ ${width}px, playhead on the ${pos.name} chord`, async () => {
      assert.ok(browser && built, 'setup test did not run or failed');
      const { page, pageErrors } = await openPlayer(browser, built, width, pos.sec);
      const helper = await browser.newPage();
      try {
        const findings = [];
        for (const stop of SLIDER_STOPS) {
          if (stop !== null) await setSlider(page, stop);
          const zoom = stop === null ? 'default zoom' : `slider ${stop}/1000`;
          const ctx = `${width}px, ${pos.name}, ${zoom}`;
          const m = await page.evaluate(measurePlayer);

          // ---- A11: the current chord --------------------------------------
          const c = m.current;
          if (!c) findings.push(`A11 no "Now" readout is rendered @ ${ctx}`);
          else {
            if (!c.hasNameEl) findings.push(`A11 the "Now" readout has no separate name element (data-testid=playhead-now-name) @ ${ctx}`);
            if (c.visibility !== 'visible' || c.alpha < 0.4) findings.push(`A11 the current chord is not shown (visibility ${c.visibility}, alpha ${c.alpha}) @ ${ctx}`);
            if (!c.text || c.text === '—') findings.push(`A11 the current chord readout names no chord ("${c.text}") @ ${ctx}`);
            if (c.runIndex !== c.ringRunIndex) findings.push(`A11 the readout is on run ${c.runIndex} but the playhead ring is on ${c.ringRunIndex} @ ${ctx}`);
            if (c.fontPx < CURRENT_MIN_PX) findings.push(`A11 current chord "${c.text}" font-size ${c.fontPx}px < ${CURRENT_MIN_PX}px @ ${ctx}`);
            if (c.weight < CURRENT_MIN_WEIGHT) findings.push(`A11 current chord "${c.text}" weight ${c.weight} < ${CURRENT_MIN_WEIGHT} @ ${ctx}`);
            if (c.box.h < CURRENT_MIN_PX) findings.push(`A11 current chord "${c.text}" rendered text box ${c.box.h.toFixed(2)}px tall < ${CURRENT_MIN_PX}px @ ${ctx}`);
            if (!c.inViewport) findings.push(`A11 current chord "${c.text}" runs off the viewport (${JSON.stringify(c.box)}) @ ${ctx}`);
            if (c.clippedBy.length) findings.push(`A11 current chord "${c.text}" is clipped by ${c.clippedBy.join(', ')} @ ${ctx}`);
            const ink = await inkHeight(page, helper);
            c.ink = ink;
            if (ink.pixels === 0) findings.push(`A11 current chord "${c.text}" paints no pixels @ ${ctx}`);
            else if (ink.height < CURRENT_MIN_INK_RATIO * CURRENT_MIN_PX)
              findings.push(`A11 current chord "${c.text}" ink is ${ink.height}px tall < ${CURRENT_MIN_INK_RATIO} x ${CURRENT_MIN_PX}px (renders smaller than it declares) @ ${ctx}`);
          }
          // Upcoming chords: smaller is fine, below the A15 floor is not.
          for (const u of m.upcoming)
            if (u.text && u.fontPx < MIN_TEXT_PX) findings.push(`A11/A15 upcoming chord ${u.id} "${u.text}" [${u.density}] is ${u.fontPx}px < ${MIN_TEXT_PX}px @ ${ctx}`);

          // ---- A15: every visible text node --------------------------------
          if (m.texts.length < 40) findings.push(`A15 only ${m.texts.length} text nodes measured (the player renders far more): the gate looked at nothing @ ${ctx}`);
          let readouts = 0;
          for (const t of m.texts) {
            const floor = t.isReadout ? MIXER_READOUT_MIN_PX : t.mono ? MIN_MONO_PX : MIN_TEXT_PX;
            if (t.isReadout) readouts++;
            if (t.fontPx + EPS < floor)
              findings.push(
                `A15 "${t.text}" <${t.tag}${t.testid ? ` in ${t.testid}` : ''}> is ${t.fontPx}px < ${floor}px (${t.isReadout ? 'mixer readout' : t.mono ? 'mono label' : 'text'}; ${t.family}) @ ${ctx}`,
              );
          }
          // The exemption must not swallow more than the six readouts.
          if (readouts > STEM_ORDER.length) findings.push(`A15 ${readouts} text nodes took the mixer-readout exemption; there are ${STEM_ORDER.length} readouts @ ${ctx}`);

          // ---- A16: section chips ------------------------------------------
          if (m.sections.length < SECTIONS.length) findings.push(`A16 ${m.sections.length} section buttons rendered for ${SECTIONS.length} sections @ ${ctx}`);
          for (const s of m.sections) {
            if (s.h + EPS < SECTION_MIN_HEIGHT_PX) findings.push(`A16 section chip "${s.text}" is ${s.h.toFixed(2)}px tall < ${SECTION_MIN_HEIGHT_PX}px @ ${ctx}`);
            if (!s.radii.every((r) => r === `${SECTION_RADIUS_PX}px`)) findings.push(`A16 section chip "${s.text}" corners are ${s.radii.join(' ')}, want ${SECTION_RADIUS_PX}px @ ${ctx}`);
            if (s.nameOverL > EPS || s.nameOverR > EPS || s.scrollOver > 0) findings.push(`A16 section chip "${s.text}" label is clipped (${s.nameOverL.toFixed(2)} / ${s.nameOverR.toFixed(2)} px, scroll ${s.scrollOver}) @ ${ctx}`);
            if (s.nameFontPx < MIN_TEXT_PX) findings.push(`A16 section chip "${s.text}" label is ${s.nameFontPx}px @ ${ctx}`);
          }

          // ---- kept: chord-root hues ---------------------------------------
          const byRoot = new Map();
          const byBg = new Map();
          for (const h of m.hues) {
            if (!byRoot.has(h.root)) byRoot.set(h.root, new Set());
            byRoot.get(h.root).add(h.bg);
            if (!byBg.has(h.bg)) byBg.set(h.bg, new Set());
            byBg.get(h.bg).add(h.root);
          }
          if (byRoot.size < 2) findings.push(`hues: only ${byRoot.size} chord root(s) on the page @ ${ctx}`);
          for (const [r, bgs] of byRoot) if (bgs.size !== 1) findings.push(`hues: root ${r} has ${bgs.size} backgrounds (${[...bgs].join(' | ')}) @ ${ctx}`);
          for (const [bg, roots] of byBg) if (roots.size !== 1) findings.push(`hues: roots ${[...roots].join(', ')} share one background ${bg} (colour separation lost) @ ${ctx}`);

          // ---- kept: mixer order -------------------------------------------
          if (m.stems.join(',') !== STEM_ORDER.join(',')) findings.push(`mixer order is ${m.stems.join(',')}, want ${STEM_ORDER.join(',')} @ ${ctx}`);

          // ---- desktop widths: no sideways scroll --------------------------
          if (width >= 1024 && (m.overflow.scrollW > m.overflow.clientW || m.overflow.playerRight > m.overflow.innerW + EPS))
            findings.push(`layout: page scrolls sideways (scrollWidth ${m.overflow.scrollW} > ${m.overflow.clientW}, player right ${m.overflow.playerRight}) @ ${ctx}`);

          summary.push(
            `${ctx}: current "${c?.text}" ${c?.fontPx}px/${c?.weight} box ${c?.box.h.toFixed(1)}px ink ${c?.ink?.height}px; ` +
              `texts ${m.texts.length} (min ${Math.min(...m.texts.filter((t) => !t.isReadout).map((t) => t.fontPx))}px excl. readout); ` +
              `sections ${m.sections.length} min-h ${Math.min(...m.sections.map((s) => s.h)).toFixed(1)}px; roots ${byRoot.size}`,
          );
        }
        if (SHOTS && pos.name === 'ordinary') {
          mkdirSync(SHOTS, { recursive: true });
          await setSlider(page, 0).catch(() => {});
          // Back to the default zoom for the picture: reload is the honest reset.
          const fresh = await openPlayer(browser, built, width, pos.sec);
          const png = await fresh.page.locator('[data-testid="player"]').screenshot();
          writeFileSync(join(SHOTS, `player-${width}.png`), png);
          await fresh.page.close();
        }
        if (LOG) for (const l of summary.splice(0)) console.log(`# ${l}`);
        assert.deepEqual(pageErrors, [], 'the page threw');
        if (findings.length) assert.fail(`GATE-FAIL ${findings.length} finding(s):\n${findings.slice(0, 20).map((f) => '  ' + f).join('\n')}`);
      } finally {
        await page.close();
        await helper.close();
      }
    });
  }
}

test('teardown', async () => {
  if (browser) await browser.close();
});
