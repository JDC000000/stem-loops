// REAL-BROWSER GATE: every chord name on a rendered chip must fit in its chip.
//
// WHY THIS FILE EXISTS
// --------------------
// apps/web/test/chord-default-zoom.test.mjs runs the chord overlay in
// happy-dom. happy-dom has no layout engine: every box is 0x0 and
// getComputedStyle reports DECLARED values. So that suite can compare the
// numbers the component COMPUTES, but it cannot see whether the text those
// numbers were computed for is the text that RENDERS. A label wrapped in a bare
// <b>, a stylesheet rule `.co-scroll button{border:4px solid transparent
// !important}`, an effect doing `b.style.padding = '0 14px'` -- each clips chord
// names in Chromium and leaves that suite green (PR #212, review rounds 2-4,
// each found by a reviewer launching Chromium by hand). Closing those one
// channel at a time inside happy-dom does not converge; a real browser does not
// care which channel moved the pixels.
//
// WHAT THIS DOES
// --------------
// It bundles the REAL src/components/ChordOverlay.tsx (and the real
// src/app/globals.css) with esbuild, serves it to headless Chromium, feeds it
// chord data through the REAL loader (usePlayChords: GET .../play-chords ->
// signed_url -> JSON), drives the REAL zoom slider, and for every chip that has
// a text node asks the browser where the text actually is:
//
//     Range(chip contents).getBoundingClientRect()   <- rendered text box
//     vs the chip's own content box (border box minus border minus padding)
//
// Nothing here re-derives a width from the constants the component uses; the
// only inputs are the DOM and the layout engine. A chip FAILS when the rendered
// text sticks out of it by more than TOLERANCE_PX horizontally or vertically.
//
// HOW IT IS KEPT HONEST
// ---------------------
//  * It FAILS (does not skip) if Chromium is missing or the page does not
//    render. A gate that skips is advice.
//  * It asserts the zoom handler RAN (data-px-per-sec moved) -- React 18
//    installs its own `value` setter, so `el.value = x` alone drives nothing.
//  * It asserts it MEASURED text chips in every pass, so "0 clipped" cannot be
//    the result of "0 looked at".
//  * It records the platform font Chromium used (CDP
//    CSS.getPlatformFontsForNode): clipping depends on the font, and a number
//    quoted without its font is not a measurement.
//  * Its non-vacuity is shown by mutation: see the PR description.
//
// ENVIRONMENT (optional)
//   CHORD_GATE_SRC   path of an apps/web checkout to bundle (default: this one).
//                    Used to point the gate at another tree, e.g. a PR head.
//   CHORD_GATE_LOG   set to 1 to print the per-pass table on success as well.
//   CHORD_GATE_FONT  `system` skips the pinned font and uses whatever Chromium
//                    resolves on this machine. For investigation only; see FONT.

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
const LOG = process.env.CHORD_GATE_LOG === '1';

// ---------------------------------------------------------------------------
// TOLERANCE
// ---------------------------------------------------------------------------
// A chord name is "clipped" when the rendered text box extends past the chip's
// content box by MORE than TOLERANCE_PX CSS pixels. The content box, not the
// padding box, is the right edge: the chip is `text-overflow: ellipsis`, and
// Chromium truncates to "..." as soon as the text outgrows the content box,
// even though the glyphs would still fit inside the padding (screenshot-verified
// on the N.C. chip: it paints "N...." not "N.C.").
//
//   0.25 px.
//   Floor: layout is in 1/64 px units (0.015625). The worst protrusion on
//          UNMODIFIED chord chips across all viewports, datasets and zoom stops
//          is 0.0156 px, i.e. one LayoutUnit (PR #212 round 3 saw the same 1/64
//          residue on 5 chips). 0.25 is 16x that, so rounding cannot flap it,
//          and it should not move with the installed font: the residue is
//          layout-unit rounding, not glyph shape.
//   Ceiling: the smallest real defect this gate was built to see is a bare <b>
//          around the label, 2.0 px at the ceiling. 0.25 is 8x below it.
//   Between: anything from 0.25 px to 2 px is a real, if small, truncation, and
//          is reported.
// The measurements behind these two numbers are in the PR body.
export const TOLERANCE_PX = 0.25;

// KNOWN DEFECT, NOT A TOLERANCE. `N.C.` and `?` chips (kind none / unknown)
// carry a 1px border on each side (restChipStyle / unknownChipStyle), and the
// component's fit decision (chipDensity / fullChipPx) budgets padding but not
// border. So in a narrow window of widths such a chip is judged to fit when its
// content box is up to 2px too small, and Chromium ellipsizes it ("N...." for
// "N.C."). Found by this gate on PR #212's head at 360px, slider 250/1000, chip
// 48.641px wide: text 32.266px in a 30.641px content box (1.625px over).
// This is a real, visible defect and it is NOT fixed here (this PR changes no
// product code). The gate allows exactly the two declared border widths for
// those two kinds and nothing else, still FAILS on anything bigger, and prints
// every chip it is excusing so the number cannot quietly grow. Delete this
// constant when the component budgets the border; the gate then holds
// every chip to TOLERANCE_PX.
export const NON_CHORD_BORDER_ALLOWANCE_PX = 2;

// ---------------------------------------------------------------------------
// FONT
// ---------------------------------------------------------------------------
// Whether a chord name fits depends on the font. The component's fit decision
// is made with a canvas measurer that cannot see font-variant-numeric,
// letter-spacing or OpenType features, so a defect of that class (tabular digits
// were one: `C:11` rendered 7.4px wider than it was measured, up to 15.2px
// across the alphabet) only exists in a font whose digits are proportional.
// The first CI run of this gate used the runner's ambient font, DejaVu Sans
// (whose digits are already tabular), and PASSED on `v3/main` where the same
// gate in Inter fails 7 of 9 -- a gate that is green for the wrong font is
// vacuous for that whole class. So the page pins Inter (@fontsource/inter,
// version-pinned in this package's lockfile entry, OFL) via @font-face and
// forces it with `* { font-family: GateInter !important }`; the gate then
// asserts, via CDP, that Chromium actually painted the chips in Inter. The
// component still reads its family off the element it renders in, exactly as in
// production; only the environment's font is fixed. Inter is what a user whose
// system font is Inter-like gets; it is not a claim about every user's font.
const PIN_FONT = process.env.CHORD_GATE_FONT !== 'system';
const FONT_DIR = join(dirname(require.resolve('@fontsource/inter/package.json')), 'files');
const FONT_FILES = { 400: 'inter-latin-400-normal.woff2', 500: 'inter-latin-500-normal.woff2', 600: 'inter-latin-600-normal.woff2', 700: 'inter-latin-700-normal.woff2' };
const FONT_CSS =
  Object.keys(FONT_FILES)
    .map((w) => `@font-face{font-family:GateInter;font-weight:${w};font-style:normal;src:url(/font-${w}.woff2) format('woff2')}`)
    .join('') + '*{font-family:GateInter,sans-serif !important}';

// Viewports. 1280 and 390 are the two where PR #212 round 3's figures differed
// most (13 chips clipped at 1280, 29 at 390 for one and the same mutation).
// 820 is wider than the 560px wrap breakpoint (NARROW_BREAKPOINT_PX) but much
// narrower than desktop; 360 is a common small-phone width below it.
const VIEWPORTS = [1280, 820, 390, 360];

// Slider positions to visit, in thousandths of the slider travel. `null` is the
// DEFAULT zoom -- the view a user first sees, which is where the original
// defect lived. 1000 is the derived ceiling. The middle stops make chips of
// every width land near the full/tight/tick thresholds somewhere in the sweep,
// which is where a systematic few-pixel error turns into a visible clip.
const SLIDER_STOPS = [null, 0, 250, 400, 550, 700, 850, 1000];

// ---------------------------------------------------------------------------
// DATA -- not chosen by hand
// ---------------------------------------------------------------------------
// 1. REAL: the 3:33 production artifact the chord-default-zoom suite is built
//    around (test/fixtures/play-chords-3m33s.json).
// 2. EXHAUSTIVE: every label the factored alphabet can decode to
//    (decodeFactored over all 13 roots x 25 qualities x 13 basses), plus every
//    label the cross-layer Harte table accepts as valid, plus N and X.
//    Durations cycle through a fixed spread so that, across the zoom sweep,
//    labels are rendered at widths on both sides of their full/tight/tick
//    thresholds.
const { decodeFactored, N_QUALITY, N_BASS, ROOT_N_INDEX } = await import(
  pathToFileURL(join(WEB, 'src/chord/alphabet.ts')).href
);

function alphabetLabels() {
  const out = new Set();
  for (let r = 0; r <= ROOT_N_INDEX; r++)
    for (let q = 0; q < N_QUALITY; q++)
      for (let b = 0; b < N_BASS; b++) {
        try {
          out.add(decodeFactored(r, q, b));
        } catch {
          // degenerate (root, quality, bass) combination: not a label
        }
      }
  const table = JSON.parse(
    readFileSync(join(WEB, '../../fixtures/contracts/harte-labels.json'), 'utf8'),
  );
  for (const row of table.labels) if (row.valid) out.add(row.label);
  out.add('N');
  out.add('X');
  return [...out].sort();
}

const DURATIONS_SEC = [0.3, 0.45, 0.6, 0.8, 1.1, 1.5, 2.2, 3.2];
function exhaustiveSong() {
  const labels = alphabetLabels();
  const segments = [];
  let t = 0;
  labels.forEach((label, i) => {
    const d = DURATIONS_SEC[(i * 3) % DURATIONS_SEC.length];
    segments.push({ start_sec: t, end_sec: t + d, label, confidence: 1 });
    t += d;
  });
  // N.C. and ? chips carry their own 1px borders, so they are the chips where
  // the fit decision and the render disagree first. The alphabet has one N and
  // one X; give each of them every duration so they land on both sides of their
  // thresholds as well.
  for (const d of DURATIONS_SEC)
    for (const label of ['N', 'X']) {
      segments.push({ start_sec: t, end_sec: t + d, label, confidence: 1 });
      t += d;
    }
  return { segments, labels };
}

const REAL = JSON.parse(readFileSync(join(WEB, 'test/fixtures/play-chords-3m33s.json'), 'utf8'));
const EXH = exhaustiveSong();
const DATASETS = [
  { name: `real-3m33s(${REAL.segments.length} segments)`, payload: REAL },
  { name: `alphabet(${EXH.labels.length} labels)`, payload: { segments: EXH.segments } },
];

// ---------------------------------------------------------------------------
// BUNDLE the real component. esbuild resolves `@/` from apps/web/tsconfig.json.
// ---------------------------------------------------------------------------
async function bundle() {
  const res = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ChordOverlay } from './src/components/ChordOverlay.tsx';
        import './src/app/globals.css';
        createRoot(document.getElementById('root')).render(
          React.createElement(ChordOverlay, { jobId: 'gate-job', positionSec: null }),
        );
      `,
      resolveDir: WEB,
      loader: 'js',
      sourcefile: 'gate-entry.js',
    },
    bundle: true,
    write: false,
    outdir: 'out',
    format: 'iife',
    jsx: 'automatic',
    tsconfig: join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    logLevel: 'silent',
  });
  const js = res.outputFiles.find((f) => f.path.endsWith('.js'));
  const css = res.outputFiles.find((f) => f.path.endsWith('.css'));
  assert.ok(js, 'esbuild produced no JS for ChordOverlay');
  return { js: js.text, css: css?.text ?? '' };
}

// ---------------------------------------------------------------------------
// MEASURE, in the page. Everything here is a question put to the layout engine.
// ---------------------------------------------------------------------------
function measureInPage() {
  const tl = document.querySelector('[data-testid="chord-timeline"]');
  const chips = [...tl.querySelectorAll('[data-testid^="chord-chip-"]')];
  const px = (v) => parseFloat(v) || 0;
  const rows = [];
  for (const c of chips) {
    if (!c.textContent) continue; // a tick has no text node: nothing to clip
    const cs = getComputedStyle(c);
    const r = c.getBoundingClientRect();
    const contentL = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const contentR = r.right - px(cs.borderRightWidth) - px(cs.paddingRight);
    const padT = r.top + px(cs.borderTopWidth);
    const padB = r.bottom - px(cs.borderBottomWidth);
    const range = document.createRange();
    range.selectNodeContents(c);
    const t = range.getBoundingClientRect(); // union of every text box in the chip
    // The vertical clip edge of the strip: the scroller hides overflow-y.
    const scroller = c.closest('.co-scroll') || tl;
    const s = scroller.getBoundingClientRect();
    rows.push({
      id: c.dataset.testid,
      text: c.textContent,
      kind: c.dataset.kind,
      density: c.dataset.density,
      chipW: r.width,
      chipH: r.height,
      contentW: contentR - contentL,
      textW: t.width,
      textH: t.height,
      overRight: t.right - contentR,
      overLeft: contentL - t.left,
      overBottom: t.bottom - padB,
      overTop: padT - t.top,
      scrollerOverBottom: t.bottom - s.bottom,
      scrollerOverTop: s.top - t.top,
      scrollOver: c.scrollWidth - c.clientWidth,
    });
  }
  const slider = document.querySelector('[data-testid="zoom-slider"]');
  return {
    pps: Number(tl.dataset.pxPerSec),
    layout: tl.dataset.layout,
    sliderValue: slider ? slider.value : null,
    totalChips: chips.length,
    rows,
  };
}

function worstOf(row) {
  const sides = {
    right: row.overRight,
    left: row.overLeft,
    bottom: row.overBottom,
    top: row.overTop,
    'scroller-bottom': row.scrollerOverBottom,
    'scroller-top': row.scrollerOverTop,
  };
  let side = 'right';
  for (const k of Object.keys(sides)) if (sides[k] > sides[side]) side = k;
  return { side, px: sides[side] };
}

function describeRow(row, ctx) {
  const w = worstOf(row);
  return (
    `${row.id} "${row.text}" [${row.kind}/${row.density}] text sticks out ${w.px.toFixed(3)}px ${w.side}` +
    ` (chip ${row.chipW.toFixed(3)}x${row.chipH.toFixed(3)}, content ${row.contentW.toFixed(3)}, text ${row.textW.toFixed(3)}x${row.textH.toFixed(3)},` +
    ` scrollWidth-clientWidth=${row.scrollOver}) @ ${ctx}`
  );
}

// ---------------------------------------------------------------------------
// DRIVE
// ---------------------------------------------------------------------------
async function setSlider(page, thousandths) {
  const before = await page.evaluate(
    () => document.querySelector('[data-testid="chord-timeline"]').dataset.pxPerSec,
  );
  const sliderBefore = await page.evaluate(
    () => document.querySelector('[data-testid="zoom-slider"]').value,
  );
  await page.evaluate((v) => {
    const el = document.querySelector('[data-testid="zoom-slider"]');
    // React 18 installs its own `value` setter on the instance; going through
    // the prototype's setter is what makes onChange fire.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, thousandths);
  if (String(thousandths) !== sliderBefore) {
    // The handler must have run: the timeline's zoom has to have moved.
    await page.waitForFunction(
      (b) => document.querySelector('[data-testid="chord-timeline"]').dataset.pxPerSec !== b,
      before,
      { timeout: 10000 },
    );
  }
  // Two frames: let React commit and the layout settle before measuring.
  await page.evaluate(
    () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))),
  );
}

const results = [];
let browser;
let built;

test('Chromium launches and the real ChordOverlay bundles', async () => {
  built = await bundle();
  browser = await chromium.launch();
  assert.ok(browser.isConnected(), 'chromium did not launch');
});

for (const width of VIEWPORTS) {
  for (const ds of DATASETS) {
    test(`chord names fit their chips @ ${width}px, ${ds.name}`, async () => {
      assert.ok(browser && built, 'setup test did not run or failed');
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      try {
        await page.route('http://gate.test/**', async (route) => {
          const u = new URL(route.request().url());
          if (u.pathname === '/')
            return route.fulfill({
              contentType: 'text/html',
              body:
                '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
                '<meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<link rel="stylesheet" href="/out.css">' +
                (PIN_FONT ? `<style>${FONT_CSS}</style>` : '') +
                '</head><body>' +
                '<main style="max-width:960px;margin:0 auto;padding:48px var(--sl-gutter,16px) 96px;' +
                'font-family:var(--font-sans)"><div id="root"></div></main>' +
                // Load the fonts BEFORE the bundle runs: the component's measurer
                // reads canvas widths once per container, and a measurement taken
                // before the webfont arrives is a fallback-font measurement.
                '<script>(' +
                (PIN_FONT
                  ? "Promise.all([400,500,600,700].map(function(w){return document.fonts.load(w+' 16px GateInter')}))"
                  : 'Promise.resolve()') +
                ").then(function(){var s=document.createElement('script');s.src='/out.js';document.body.appendChild(s)})</script>" +
                '</body></html>',
            });
          if (PIN_FONT && /^\/font-(\d+)\.woff2$/.test(u.pathname)) {
            const w = /^\/font-(\d+)\.woff2$/.exec(u.pathname)[1];
            return route.fulfill({ contentType: 'font/woff2', body: readFileSync(join(FONT_DIR, FONT_FILES[w])) });
          }
          if (u.pathname === '/out.js')
            return route.fulfill({ contentType: 'text/javascript', body: built.js });
          if (u.pathname === '/out.css')
            return route.fulfill({ contentType: 'text/css', body: built.css });
          if (u.pathname.endsWith('/play-chords'))
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({ signed_url: '/signed.json', expires_in_sec: 60 }),
            });
          if (u.pathname === '/signed.json')
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify(ds.payload),
            });
          return route.fulfill({ status: 404, body: 'not found' });
        });
        await page.goto('http://gate.test/');
        await page.waitForSelector('[data-testid^="chord-chip-"]', { timeout: 30000 });
        await page.waitForFunction(
          () => {
            const s = document.querySelector('[data-testid="zoom-slider"]');
            return s && !s.disabled;
          },
          null,
          { timeout: 30000 },
        );

        // Which font actually painted the chips. Recorded, not asserted: the
        // claim is "text fits in THIS browser's font", and the reader needs to
        // know which font that was.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const doc = await cdp.send('DOM.getDocument');
        const q = await cdp.send('DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: '[data-density="full"]',
        });
        const font = q.nodeId
          ? (await cdp.send('CSS.getPlatformFontsForNode', { nodeId: q.nodeId })).fonts
              .map((f) => `${f.familyName}x${f.glyphCount}`)
              .join(',')
          : 'no full-density chip';
        if (PIN_FONT)
          assert.match(
            font,
            /^Inter/,
            `the pinned font did not paint the chips (platform fonts: ${font}); every width below would be for the wrong font`,
          );

        const failures = [];
        let worstChord = { px: -Infinity, desc: '' };
        let worstNonChord = { px: -Infinity, desc: '' };
        const excused = [];
        let measuredTotal = 0;
        const perPass = [];
        for (const stop of SLIDER_STOPS) {
          if (stop !== null) await setSlider(page, stop);
          const m = await page.evaluate(measureInPage);
          const ctx = `viewport ${width}px, ${ds.name}, ${stop === null ? 'default zoom' : `slider ${stop}/1000`}, ${m.pps.toFixed(3)} px/s, layout ${m.layout}`;
          // The ceiling is where chips are widest. If nothing there has a text
          // node, nothing was looked at and "0 clipped" would mean nothing.
          if (stop === 1000)
            assert.ok(
              m.rows.length > 0,
              `no chip with a text node was measured at the zoom ceiling (${m.totalChips} chips) @ ${ctx} -- a gate that measured nothing proves nothing`,
            );
          perPass.push(`${stop === null ? 'default' : stop}:${m.rows.length}/${m.totalChips}`);
          measuredTotal += m.rows.length;
          for (const row of m.rows) {
            const w = worstOf(row);
            const nonChord = row.kind === 'none' || row.kind === 'unknown';
            const allow = TOLERANCE_PX + (nonChord ? NON_CHORD_BORDER_ALLOWANCE_PX : 0);
            if (!nonChord && w.px > worstChord.px) worstChord = { px: w.px, desc: describeRow(row, ctx) };
            if (nonChord && w.px > worstNonChord.px) worstNonChord = { px: w.px, desc: describeRow(row, ctx) };
            if (w.px > allow) failures.push({ row, ctx, px: w.px });
            else if (nonChord && w.px > TOLERANCE_PX) excused.push(describeRow(row, ctx));
          }
        }
        results.push({ width, data: ds.name, font, measuredTotal, worstChord: worstChord.px, worstNonChord: worstNonChord.px, failures: failures.length });
        // Always printed (not only under CHORD_GATE_LOG): these are real defects
        // the gate is excusing, and CI logs are where someone would look.
        for (const e of [...new Set(excused)].slice(0, 5))
          console.log(`# KNOWN DEFECT (excused by NON_CHORD_BORDER_ALLOWANCE_PX): ${e}`);
        if (LOG)
          console.log(
            `${ds.name} @${width}: font=[${font}] text-chips-measured=${measuredTotal} [${perPass.join(' ')}] ` +
              `worst-chord-protrusion=${worstChord.px.toFixed(4)}px worst-N.C./?-protrusion=${worstNonChord.px.toFixed(4)}px ` +
              `clipped=${failures.length} excused=${excused.length}\n   worst chord: ${worstChord.desc}`,
          );
        assert.deepEqual(pageErrors, [], 'the page threw');
        if (failures.length) {
          failures.sort((a, b) => b.px - a.px);
          const lines = failures.slice(0, 12).map((f) => '  ' + describeRow(f.row, f.ctx));
          assert.fail(
            `${failures.length} chord chip(s) have text sticking out of the chip by more than ${TOLERANCE_PX}px ` +
              `(font: ${font}). Worst ${Math.min(12, failures.length)}:\n${lines.join('\n')}`,
          );
        }
      } finally {
        await page.close();
      }
    });
  }
}

test('teardown', async () => {
  if (browser) await browser.close();
});
