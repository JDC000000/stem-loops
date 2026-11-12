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
// Two further instruments exist because "fits" is not "is seen" and "fits" is
// not "is there" (round 3; see TICK JUSTIFICATION and INK below):
//
//   * every character of every chip is LOOKED AT: two screenshots, one with the
//     chip's text paint switched off, and a character that changes no pixel in
//     its own box is not on screen, whatever made it so;
//   * every tick must be justified: its name, measured in a probe span at the
//     smallest legible size, must NOT have fit.
//
// WHAT THIS IS NOT. It is not airtight, and nothing in the PR claims it is. It
// finds a real defect today (7 of 10 tests fail on v3/main) and it kills the
// mutants listed in prove-non-vacuous.mjs, each of which was watched going from
// green to red. Anything not on that list is untested, not covered.
//
// HOW IT IS KEPT HONEST
// ---------------------
//  * It FAILS (does not skip) if Chromium is missing or the page does not
//    render. A gate that skips is advice.
//  * It asserts the zoom handler RAN (data-px-per-sec moved) -- React 18
//    installs its own `value` setter, so `el.value = x` alone drives nothing.
//  * It asserts it MEASURED text chips in every pass, so "0 clipped" cannot be
//    the result of "0 looked at"; the same for ticks (every tick on the page was
//    examined) and for the pixel check (it looked at every text chip on the real
//    song, and at a printed number of windows on the alphabet).
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
//   CHORD_GATE_INK_BATCHES  windows per pass the pixel check looks at on the big
//                    alphabet dataset (default 10; the real song is always looked
//                    at in full). `all` looks at every chip on both: several
//                    minutes.

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
//   0.02 px.  Layout is in 1/64 px units (LayoutUnit, 0.015625 px): 0.02 is
//   above ONE unit and below TWO.
//   Floor:   two figures, and they are different things. (1) At the gate's own
//            64 swept configurations (4 viewports x 2 datasets x 8 zoom stops)
//            the worst chord protrusion on the clean tree is 0.0000 px: that
//            is what a gate run prints. (2) BETWEEN those configurations a
//            protrusion of 0.0156 px, one LayoutUnit, is real (reviewer round 2:
//            chord-chip-581 "B:11/5" 0.016 px right at a 320 px viewport). The
//            tolerance has to clear (2), not (1), which is why it is 0.02.
//   Ceiling: there is NO gap between "fits" and "clipped" above that unit.
//            Round 1 of this PR set 0.25 and argued a ceiling from "bare <b>
//            overflows by at least 1.734 px"; that figure came from printing
//            the three worst chips. A reviewer's full dump of the bare-<b>
//            mutant has 1,220 chord chips protruding in a CONTINUUM from
//            0.0156 px to 5.0938 px, 157 of them at or below 0.25 px, and
//            screenshots of the ones between 0.047 and 0.219 px all paint an
//            ellipsis ("D:aug" at 0.047 px paints "D:a..."). A mutant that adds
//            0.1 px of padding per side passed the 0.25 gate 10/10 while
//            Chromium painted "C:m..." for "C:maj6" (0.147 px), "A..." for
//            "A:5" (0.225 px). Measured threshold at which Chromium starts to
//            ellipsize: between 0.022 px (paints in full) and 0.038 px (paints
//            "G#:minmaj7/..."). So the tolerance is the layout-unit floor, not
//            a number with headroom: anything the browser can see is a failure.
// If this ever flaps on a clean tree, the finding is that the residue moved,
// not that the constant should be widened back: say so, with the figure.
export const TOLERANCE_PX = 0.02;

// KNOWN DEFECT, NOT A TOLERANCE. `N.C.` and `?` chips (kind none / unknown)
// carry a 1px border on each side (restChipStyle / unknownChipStyle), and the
// component's fit decision (chipDensity / fullChipPx) budgets padding but not
// border. So in a narrow window of widths such a chip is judged to fit when its
// content box is up to 2px too small, and Chromium ellipsizes it ("N...." for
// "N.C."). Found by this gate on PR #212's head at 360px, slider 250/1000, chip
// 48.641px wide: text 32.266px in a 30.641px content box (1.625px over).
// This is a real, visible defect and it is NOT fixed here (this PR changes no
// product code). The worst figure seen anywhere is 2.0156 px: two 1px borders
// plus one LayoutUnit. The allowance applies ONLY to a chip whose kind AND text
// are exactly ('none','N.C.') or ('unknown','?'): those texts are constants of
// the product, so a real chord cannot inherit the excuse through product logic,
// and a regression on such a chip that changes its text (or any other chip's
// kind) is held to TOLERANCE_PX like everything else. Every chip it excuses is
// printed (`# KNOWN DEFECT`). Delete this constant when the component budgets
// the border.
export const NON_CHORD_BORDER_ALLOWANCE_PX = 2;
const EXCUSED_TEXT = { none: 'N.C.', unknown: '?' };

// INVISIBLE TEXT. A name that is present, correctly sized, and painted at
// opacity 0 or `color: transparent` fits perfectly and shows nothing (the
// component used to render ticks that way). Rendering proves presence, not
// visibility, so each measured chip must also be visible, have a non-zero text
// box, and paint with effective alpha (text colour alpha x the product of every
// ancestor's opacity) of at least MIN_PAINT_ALPHA. This is a "is it painted at
// all" floor, NOT a contrast check: it does not know the background.
export const MIN_PAINT_ALPHA = 0.4;

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
// gate in Inter fails 7 of 10 tests -- a gate that is green for the wrong font is
// vacuous for that whole class. So the page pins Inter (@fontsource/inter,
// version-pinned in this package's lockfile entry, OFL) via @font-face.
//
// WHERE IT IS PINNED IS THE POINT. Round 1 forced it with
// `* { font-family: GateInter !important }`, which overrode EVERY element,
// chips included, so any non-!important family a defect set on a chip (a
// stylesheet `button{font-family:ui-monospace}`, a `chipStyle` fontFamily, an
// effect doing `b.style.fontFamily`) was erased before it was measured: five
// such mutants were 10/10 green here while 39 names clipped in the system font.
// Now ONLY the overlay container (`chord-overlay`, which sets its own
// `fontFamily` inline and is what the chips and the canvas measurer inherit
// from) is pinned, so the chips inherit exactly as they do in production, and
// the gate ASSERTS, on EVERY measured chip, that the computed family is the
// pinned one (or, with CHORD_GATE_FONT=system, the container's own) and that the
// computed font-style is `normal`.
//
// ITALIC FACES ARE SHIPPED (round 3). Round 2 pinned only upright faces, and
// globals.css sets `font-synthesis:none`, so an italic request had no face to
// land on and painted UPRIGHT Inter at the upright width. The per-chip
// `font-style` read therefore had to carry the whole italic class, and it reads
// the chip's OWN computed style: `button::first-line{font-style:italic}` is not
// the chip's computed style, left the gate 10/10 green AND the apps/web suite
// green, and was a real defect (the same gate on the system font, whose Inter
// has an italic face, fails 8 of 10: Inter Italic's `a` is 9.82 px against
// 8.984 px upright at 16 px, so every maj/aug/add label widens). With the
// italic faces in the pin an italic glyph is an italic glyph, it is WIDER, and
// the width measurement that already runs sees it through every channel
// (`::first-line`, a descendant, a stylesheet, an effect) without anyone
// enumerating the channels. The per-chip font-style read stays as a cheap second
// opinion and is no longer what the class depends on. The faces come from the
// same @fontsource/inter package that is already pinned: no new dependency, no
// lockfile change. The CDP check additionally asserts that Inter actually
// painted a chip. Inter is what a user whose system font is Inter-like gets; it
// is not a claim about every user's font.
const PIN_FONT = process.env.CHORD_GATE_FONT !== 'system';
const FONT_DIR = join(dirname(require.resolve('@fontsource/inter/package.json')), 'files');
const WEIGHTS = [400, 500, 600, 700];
const FONT_FILES = Object.fromEntries(WEIGHTS.map((w) => [`${w}`, `inter-latin-${w}-normal.woff2`]));
const FONT_FILES_ITALIC = Object.fromEntries(WEIGHTS.map((w) => [`${w}-italic`, `inter-latin-${w}-italic.woff2`]));
const FONT_CSS =
  WEIGHTS.map((w) => `@font-face{font-family:GateInter;font-weight:${w};font-style:normal;src:url(/font-${w}.woff2) format('woff2')}`)
    .concat(WEIGHTS.map((w) => `@font-face{font-family:GateInter;font-weight:${w};font-style:italic;src:url(/font-${w}-italic.woff2) format('woff2')}`))
    .join('') + '[data-testid="chord-overlay"]{font-family:GateInter,sans-serif !important}';
// What getComputedStyle(chip).fontFamily reads when the pin is inherited intact.
const PINNED_FAMILY = 'GateInter, sans-serif';

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
  { name: `real-3m33s(${REAL.segments.length} segments)`, payload: REAL, inkBatches: null },
  { name: `alphabet(${EXH.labels.length} labels)`, payload: { segments: EXH.segments }, inkBatches: 10 },
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
function measureInPage(arg) {
  const tl = document.querySelector('[data-testid="chord-timeline"]');
  const chips = [...tl.querySelectorAll('[data-testid^="chord-chip-"]')];
  const px = (v) => parseFloat(v) || 0;
  const rows = [];
  const overlayFamily = getComputedStyle(document.querySelector('[data-testid="chord-overlay"]')).fontFamily;
  const tickRows = [];
  const probes = document.createElement('div');
  probes.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none';
  tl.parentElement.appendChild(probes);
  let primaryChips = 0;
  let ticks = 0;
  let emptyNonTick = 0;
  const alphaOf = (col) => {
    const m = /^rgba?\(([^)]*)\)$/.exec(col);
    if (!m) return 1;
    const parts = m[1].split(/[ ,/]+/).filter(Boolean);
    return parts.length > 3 ? Number(parts[3]) : 1;
  };
  for (const c of chips) {
    if (/^chord-chip-\d+$/.test(c.dataset.testid)) primaryChips++;
    if (c.dataset.density === 'tick') ticks++;
    if (!c.textContent) {
      // a tick has no text node: nothing to clip. A chip that CLAIMS to be
      // full/tight but has no text is a different thing -- a name that vanished.
      if (c.dataset.density !== 'tick') {
        emptyNonTick++;
        continue;
      }
      // A TICK MUST BE JUSTIFIED. A tick is a chip that gave up its name, and
      // nothing above can see a chip that gives up a name it could have kept:
      // it fits perfectly (it has nothing to fit), the count of primary chips is
      // right, and `emptyNonTick` is 0 because it admits to being a tick. So ask
      // the layout engine directly: the name (a chord's is on its `title`; the two
      // non-chord kinds' text is a constant of the product), set at the smallest
      // size the gate accepts as legible in a probe span with the chip's own font
      // properties, against the chip's own content box. If it would have fit with
      // room to spare, the tick is unjustified. Nothing here is the component's
      // own arithmetic: no padding or font-size constant, only the chip's computed
      // style and a measured span.
      const tcs = getComputedStyle(c);
      const label = c.dataset.kind === 'chord' ? c.getAttribute('title') : arg.constLabels[c.dataset.kind];
      const tr = c.getBoundingClientRect();
      const tContent =
        tr.width - px(tcs.borderLeftWidth) - px(tcs.borderRightWidth) - px(tcs.paddingLeft) - px(tcs.paddingRight);
      // Only READ here; the probe spans are written and measured after the loop.
      // Interleaving a DOM write with a layout read per tick (thousands of them)
      // forces a full layout each time.
      const font = {};
      for (const k of ['fontFamily', 'fontWeight', 'fontStyle', 'fontVariantNumeric', 'fontFeatureSettings', 'fontKerning', 'letterSpacing', 'wordSpacing', 'textTransform'])
        font[k] = tcs[k];
      tickRows.push({ id: c.dataset.testid, kind: c.dataset.kind, label, contentW: tContent, probeW: null, spare: null, font });
      continue;
    }
    const cs = getComputedStyle(c);
    let opacity = 1;
    for (let e = c; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
    const r = c.getBoundingClientRect();
    const contentL = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const contentR = r.right - px(cs.borderRightWidth) - px(cs.paddingRight);
    const padT = r.top + px(cs.borderTopWidth);
    const padB = r.bottom - px(cs.borderBottomWidth);
    const range = document.createRange();
    range.selectNodeContents(c);
    const t = range.getBoundingClientRect(); // union of every text box in the chip
    // For the two excusable non-chord chips only: how wide the same text is in a
    // bare span carrying the chip's OWN font properties. A chip whose text is
    // wider than that (a <b>, a span with letter-spacing, a heavier weight) has
    // a regression that is not the known border defect, and gets no excuse.
    let probeW = null;
    if ((c.dataset.kind === 'none' && c.textContent === 'N.C.') || (c.dataset.kind === 'unknown' && c.textContent === '?')) {
      const sp = document.createElement('span');
      sp.textContent = c.textContent;
      for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariantNumeric', 'fontFeatureSettings', 'fontKerning', 'letterSpacing', 'wordSpacing', 'textTransform'])
        sp.style[k] = cs[k];
      sp.style.cssText += ';position:absolute;left:0;top:0;white-space:nowrap;visibility:hidden';
      c.parentElement.appendChild(sp);
      probeW = sp.getBoundingClientRect().width;
      sp.remove();
    }
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
      probeW,
      fontFamily: cs.fontFamily,
      fontStyle: cs.fontStyle,
      visibility: cs.visibility,
      display: cs.display,
      paintAlpha: alphaOf(cs.color) * opacity,
    });
  }
  for (const t of tickRows) {
    if (!t.label) continue;
    const sp = document.createElement('span');
    sp.textContent = t.label;
    for (const k in t.font) sp.style[k] = t.font[k];
    sp.style.fontSize = arg.legiblePx + 'px';
    sp.style.whiteSpace = 'nowrap';
    probes.appendChild(sp);
    t.sp = sp;
  }
  for (const t of tickRows) {
    if (t.sp) {
      t.probeW = t.sp.getBoundingClientRect().width;
      t.spare = t.contentW - t.probeW;
    }
    delete t.sp;
    delete t.font;
  }
  probes.remove();
  const slider = document.querySelector('[data-testid="zoom-slider"]');
  return {
    pps: Number(tl.dataset.pxPerSec),
    layout: tl.dataset.layout,
    sliderValue: slider ? slider.value : null,
    totalChips: chips.length,
    primaryChips,
    ticks,
    emptyNonTick,
    overlayFamily,
    rows,
    tickRows,
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


// ---------------------------------------------------------------------------
// TICK JUSTIFICATION
// ---------------------------------------------------------------------------
// Round 2 removed "no ticks at the zoom ceiling" (on v3/main 1,018 short chips
// are legitimately ticks there) and left NOTHING in its place, so a mutant that
// turns names into ticks was green in BOTH layouts: the strip tests at 1280 and
// 820 measured 54 text chips instead of 550 (real song, 1280) and 146 instead of
// 10,524 (alphabet, 1280) and passed; fewer chips measured is fewer chances to
// fail. The replacement is a rule about the tick itself: "a tick must be
// justified". A tick is justified when its name would NOT have fit its box at the
// smallest size this gate accepts as legible. Measured in a probe span in the
// browser (see measureInPage); fails when the name would have fit with at least
// UNJUSTIFIED_SPARE_PX to spare.
//
//  * LEGIBLE_PX is the GATE's own statement of "the smallest chord name worth
//    showing", not read from the component. It equals the size the component's
//    `tight` density uses today (10px); if the product shrinks it, ticks the
//    product now calls justified stay justified here (the rule gets weaker, not
//    wrong) and someone should look at this constant.
//  * UNJUSTIFIED_SPARE_PX is the margin. The component keeps its own few pixels
//    of margin before it will print a `tight` name (and decides on a canvas
//    measure of the 16px label scaled to 10px, which is not exactly the width
//    the layout engine gives a 10px label), so a tick whose name fits by a few
//    pixels is the product being conservative, not a defect. The number is not a
//    tolerance for noise (measurement is exact to one LayoutUnit): it is where
//    this rule STOPS CLAIMING. Calibration, clean tree (#212 head), all 64
//    passes: the tightest tick the product calls justified has a SPARE of
//    +2.922 px (`A#:hdim7/b7`, 1280px alphabet, slider 850) and no tick has more;
//    the constant is that plus about two pixels. A mutant that demotes names to
//    ticks is therefore seen only when the demoted name would have fit with
//    5 px or more to spare: a tick that gives up a name by less is NOT covered.
export const LEGIBLE_PX = 10;
export const UNJUSTIFIED_SPARE_PX = 5;
const CONST_LABELS = { none: 'N.C.', unknown: '?' };

// ---------------------------------------------------------------------------
// INK: LOOK AT THE PIXELS WHERE THE TEXT SHOULD BE
// ---------------------------------------------------------------------------
// Everything above this line asks the layout engine WHERE the text is. Nothing
// asks whether it is SEEN. Round 2 found five ways a tree could leave every
// measurement green while Chromium shows no chord names (or half of them):
// `-webkit-text-fill-color:transparent`, `clip-path:inset(0 0 0 100%)`, a sibling
// chip widened by `button{min-width:44px}` painting over its neighbour's text, a
// `::first-line` italic, and names turned into ticks. Each time the response was
// to enumerate one more channel (colour alpha, then font-style, ...), and each
// enumeration left the next channel open: the shape of that fix is wrong, not its
// coverage. This is the class-level instrument: render, then LOOK.
//
// For each chip that has text, in batches that are scrolled into view:
//   1. Range-measure every non-space CHARACTER (not the chip): where the layout
//      says each glyph's box is.
//   2. Screenshot the viewport as it is.
//   3. Screenshot it again with the chips' text paint switched off
//      (colour, text-fill, stroke, shadow: `HIDE_TEXT_CSS`). Layout does not move.
//   4. A character is PAINTED if the two screenshots differ inside its box.
//      A character is covered, clipped, transparent, ellipsized away, or the
//      colour of its background if they do not. Nothing about HOW it got hidden
//      is consulted, which is the point.
//   5. `elementFromPoint` at each character's centre must be the chip (or inside
//      it). Redundant with 4 for most causes; it is here because step 4 attributes
//      ink to a box, and a neighbour's glyph that happens to lie in this box
//      would count as this chip's ink. (A cover that belongs to the chip itself,
//      `button::after`, passes 5 and is caught by 4 only; a `pointer-events:none`
//      overlay passes 5 and is caught by 4 only.)
//
// WHAT IT DOES NOT DO. It does not check contrast beyond "different from the
// background by more than INK_MIN_DIFF in some channel at some pixel of every
// glyph". It checks glyphs, not their legibility. It looks at the chips it was
// asked to look at: coverage is printed per pass (`ink X/Y`), and on the large
// alphabet dataset it is a deterministic SAMPLE of windows (`inkBatches` evenly
// spaced seeds per pass, each bringing the chips around it), not every chip. The chips whose fit the gate already excuses (the N.C. / ?
// known border defect, which paints "N....") are not pixel-checked, for the
// same reason they are excused; they are counted (`ink-excused`).
export const INK_MIN_DIFF = 24; // per-channel difference that counts as "painted"
export const INK_MIN_PIXELS = 1;
// Real song: every chip is looked at (null). Alphabet (up to ~12,000 text chips
// per pass): this many windows per pass. Set CHORD_GATE_INK_BATCHES=all to look
// at everything on both (slow: several minutes).
const INK_BATCHES_ENV = process.env.CHORD_GATE_INK_BATCHES;
const INK_ALL = INK_BATCHES_ENV === 'all';
const inkBatchesFor = (ds) => (INK_ALL || ds.inkBatches === null ? null : Number(INK_BATCHES_ENV ?? ds.inkBatches));
const HIDE_TEXT_CSS =
  '[data-gate-hide],[data-gate-hide] *,[data-gate-hide]::first-line,[data-gate-hide]::first-letter' +
  '{color:transparent !important;-webkit-text-fill-color:transparent !important;-webkit-text-stroke:0 !important;text-shadow:none !important;text-decoration-color:transparent !important}';

// In the page. Brings the next chip (or, when sampling, the next seed) to the
// middle of the view, then returns every not-yet-checked chip NEAR it in document
// order whose characters are ALL inside the viewport and the scroller's clip,
// with each character's box. (Document order is time order in the strip and
// row-major in the wrapped layout, so "near in the DOM" is "near on screen";
// anything the outward scan misses stays unchecked and gets its own turn.)
function inkPlan(arg) {
  const tl = document.querySelector('[data-testid="chord-timeline"]');
  if (arg.reset) {
    window.__ink = null;
    return { reset: true };
  }
  let st = window.__ink;
  if (!st) {
    st = window.__ink = { done: new Set(), order: [...tl.querySelectorAll('[data-testid^="chord-chip-"]')].filter((c) => c.textContent), seedIx: 0, seeds: null, first: 0, batch: [] };
    st.skip = new Set(arg.skipIds);
    for (const id of st.skip) st.done.add(id);
    const todo = st.order.filter((c) => !st.done.has(c.dataset.testid));
    // maxBatches == null: look at every chip. Otherwise: that many evenly spaced
    // seeds (by position in document order), each of which brings a window of
    // neighbours with it.
    const k = arg.maxBatches == null ? 0 : Math.min(arg.maxBatches, todo.length);
    st.seeds = arg.maxBatches == null ? null : Array.from({ length: k }, (_, i) => todo[Math.floor((i * todo.length) / k)].dataset.testid);
  }
  const summary = () => ({ total: st.order.length, skipped: st.skip.size, checked: st.done.size - st.skip.size });
  let ti = -1;
  if (st.seeds) {
    while (st.seedIx < st.seeds.length && st.done.has(st.seeds[st.seedIx])) st.seedIx++;
    if (st.seedIx >= st.seeds.length) return { items: [], ...summary() };
    ti = st.order.findIndex((c) => c.dataset.testid === st.seeds[st.seedIx]);
  } else {
    while (st.first < st.order.length && st.done.has(st.order[st.first].dataset.testid)) st.first++;
    if (st.first >= st.order.length) return { items: [], ...summary() };
    ti = st.first;
  }
  const target = st.order[ti];
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const W = innerWidth;
  const H = innerHeight;
  const items = [];
  const unreachable = [];
  st.batch = [];
  const look = (c) => {
    // returns 'out' (nowhere near the view), 'skip' (partly in view, left for later) or 'ok'
    const id = c.dataset.testid;
    const r = c.getBoundingClientRect();
    if (r.right < 0 || r.left > W || r.bottom < 0 || r.top > H) return 'out';
    const sr = (c.closest('.co-scroll') || tl).getBoundingClientRect();
    const chars = [];
    const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); )
      for (let i = 0; i < n.length; i++) {
        if (/\s/.test(n.data[i])) continue;
        const rg = document.createRange();
        rg.setStart(n, i);
        rg.setEnd(n, i + 1);
        const b = rg.getBoundingClientRect();
        if (b.width < 0.5 || b.height < 0.5) continue;
        if (b.left < 0 || b.right > W || b.top < 0 || b.bottom > H || b.left < sr.left - 0.5 || b.right > sr.right + 0.5) return 'skip';
        const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        const hit = !!el && c.contains(el);
        chars.push({ ch: n.data[i], x: b.left, y: b.top, w: b.width, h: b.height, hit, by: hit ? null : el ? el.getAttribute('data-testid') || el.tagName.toLowerCase() : 'nothing' });
      }
    items.push({ id, text: c.textContent, chars });
    st.batch.push(c);
    return 'ok';
  };
  const first = look(target);
  if (first !== 'ok') unreachable.push(target.dataset.testid);
  for (const dir of [1, -1]) {
    let out = 0;
    for (let j = ti + dir; j >= 0 && j < st.order.length && out < 12; j += dir) {
      const c = st.order[j];
      if (st.done.has(c.dataset.testid)) continue;
      const v = look(c);
      out = v === 'out' ? out + 1 : 0;
    }
  }
  for (const it of items) st.done.add(it.id);
  for (const id of unreachable) st.done.add(id);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) for (const ch of it.chars) { x0 = Math.min(x0, ch.x); y0 = Math.min(y0, ch.y); x1 = Math.max(x1, ch.x + ch.w); y1 = Math.max(y1, ch.y + ch.h); }
  return { items, unreachable, ...summary(), sx: scrollX, sy: scrollY, union: items.length ? { x0, y0, x1, y1 } : null };
}

// In the page. Switch the text paint off on exactly the chips of the last batch
// (attribute-scoped, so only those elements are restyled), or back on.
function inkHide({ on, css }) {
  const st = window.__ink;
  if (!document.getElementById('__gate_hide_text')) {
    const style = document.createElement('style');
    style.id = '__gate_hide_text';
    style.textContent = css;
    document.head.appendChild(style);
  }
  for (const c of st.batch) (on ? c.setAttribute('data-gate-hide', '') : c.removeAttribute('data-gate-hide'));
  return document.body.offsetHeight; // force the style recalc before the screenshot
}

// In a SECOND page: decode two PNGs and count, per box, the pixels that differ.
async function inkDiff({ a, b, boxes, minDiff }) {
  const load = async (b64) => {
    const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const cv = new OffscreenCanvas(bm.width, bm.height);
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bm, 0, 0);
    return cx.getImageData(0, 0, bm.width, bm.height);
  };
  const A = await load(a);
  const B = await load(b);
  if (A.width !== B.width || A.height !== B.height) return { error: `screenshots differ in size ${A.width}x${A.height} vs ${B.width}x${B.height}` };
  const out = [];
  for (const bx of boxes) {
    const x0 = Math.max(0, Math.floor(bx.x));
    const x1 = Math.min(A.width, Math.ceil(bx.x + bx.w));
    const y0 = Math.max(0, Math.floor(bx.y));
    const y1 = Math.min(A.height, Math.ceil(bx.y + bx.h));
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * A.width + x) * 4;
        const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
        if (d >= minDiff) n++;
      }
    out.push(n);
  }
  return { counts: out };
}

// CDP clip is in DOCUMENT coordinates (viewport + scroll); verified by hand.
async function shot(cdp, clip) {
  try {
    return (await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip: { ...clip, scale: 1 } })).data;
  } catch (e) {
    throw new Error(`${e.message} (clip ${JSON.stringify(clip)})`);
  }
}

// Returns { findings: [string], checked, total, skipped, batches }.
async function inkCheck(page, helper, cdp, skipIds, maxBatches, ctx) {
  const findings = [];
  let batches = 0;
  let last = null;
  await page.evaluate(inkPlan, { reset: true });
  for (;;) {
    const plan = await page.evaluate(inkPlan, { skipIds, maxBatches });
    last = plan;
    for (const id of plan.unreachable ?? []) findings.push(`${id} could not be brought fully into view to be looked at @ ${ctx}`);
    if (!plan.items.length) {
      if (plan.unreachable?.length) continue; // progressed (the target is now done); look for the next
      break;
    }
    batches++;
    // Crop to the characters of this batch (+2px): the PNG, not the page, is
    // what costs.
    const M = 2;
    const cx = Math.max(0, Math.floor(plan.union.x0) - M);
    const cy = Math.max(0, Math.floor(plan.union.y0) - M);
    const cw = Math.ceil(plan.union.x1) + M - cx;
    const ch = Math.ceil(plan.union.y1) + M - cy;
    // (html{scroll-behavior:smooth} is in the app's stylesheet: every scroll in
    // here is `instant`, or the rects read below belong to a frame that has passed.)
    const clip = { x: cx + plan.sx, y: cy + plan.sy, width: Math.max(1, cw), height: Math.max(1, ch) };
    if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)) {
      findings.push(`no usable capture rectangle for a window of ${plan.items.length} chip(s): ${JSON.stringify(plan.union)} @ ${ctx}`);
      continue;
    }
    const a = await shot(cdp, clip);
    await page.evaluate(inkHide, { on: true, css: HIDE_TEXT_CSS });
    const b = await shot(cdp, clip);
    await page.evaluate(inkHide, { on: false, css: HIDE_TEXT_CSS });
    const boxes = [];
    const owner = [];
    for (const it of plan.items) for (const c of it.chars) { boxes.push({ x: c.x - cx, y: c.y - cy, w: c.w, h: c.h }); owner.push([it, c]); }
    const d = await helper.evaluate(inkDiff, { a, b, boxes, minDiff: INK_MIN_DIFF });
    if (d.error) { findings.push(`${d.error} @ ${ctx}`); break; }
    d.counts.forEach((n, i) => {
      const [it, c] = owner[i];
      if (n < INK_MIN_PIXELS) findings.push(`${it.id} "${it.text}" character '${c.ch}' paints no pixels where its box is (${c.w.toFixed(1)}x${c.h.toFixed(1)}) @ ${ctx}`);
      else if (!c.hit) findings.push(`${it.id} "${it.text}" character '${c.ch}' is covered by ${c.by} (hit-test at its centre) @ ${ctx}`);
    });
  }
  await page.evaluate(() => {
    window.__ink = null;
    for (const sc of document.querySelectorAll('.co-scroll')) sc.scrollLeft = 0;
    scrollTo({ top: 0, left: 0, behavior: 'instant' });
  });
  return { findings, batches, checked: last?.checked ?? 0, total: last?.total ?? 0, skipped: last?.skipped ?? 0 };
}

const results = [];
let browser;
let built;

test('Chromium launches and the real ChordOverlay bundles', async () => {
  built = await bundle();
  // Text rendering is pinned as well as the font. On the first CI run the same
  // pinned Inter measured integer widths (worst 5.0000px) where a developer
  // machine measured fractional ones (8.4688px): the runner's fontconfig turned
  // hinting on, which rounds glyph advances to whole pixels. Users on macOS and
  // Windows get unhinted, subpixel-positioned text, so that is what is pinned.
  browser = await chromium.launch({
    args: ['--font-render-hinting=none', '--enable-font-subpixel-positioning'],
  });
  assert.ok(browser.isConnected(), 'chromium did not launch');
});

for (const width of VIEWPORTS) {
  for (const ds of DATASETS) {
    test(`chord names fit their chips @ ${width}px, ${ds.name}`, async () => {
      assert.ok(browser && built, 'setup test did not run or failed');
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      let helper = null;
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
                  ? "Promise.all([400,500,600,700].reduce(function(a,w){return a.concat([document.fonts.load(w+' 16px GateInter'),document.fonts.load('italic '+w+' 16px GateInter')])},[]))"
                  : 'Promise.resolve()') +
                ").then(function(){var s=document.createElement('script');s.src='/out.js';document.body.appendChild(s)})</script>" +
                '</body></html>',
            });
          if (PIN_FONT && /^\/font-(\d+(?:-italic)?)\.woff2$/.test(u.pathname)) {
            const key = /^\/font-(\d+(?:-italic)?)\.woff2$/.exec(u.pathname)[1];
            const file = FONT_FILES[key] ?? FONT_FILES_ITALIC[key];
            return file
              ? route.fulfill({ contentType: 'font/woff2', body: readFileSync(join(FONT_DIR, file)) })
              : route.fulfill({ status: 404, body: 'no such face' });
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

        // Which font actually painted the chips. Recorded here (and asserted,
        // in pinned mode, below): the claim is "text fits in THIS browser's font",
        // and the reader needs to know which font that was.
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
        helper = await browser.newPage(); // its own context: the page under test stays the foreground page
        const failures = [];
        const styleFailures = [];
        const countFailures = [];
        const paintFailures = [];
        const tickFailures = [];
        let ticksExamined = 0;
        let ticksSeen = 0;
        let tightestJustified = { spare: Infinity, desc: 'none' };
        let widestUnjustified = { spare: -Infinity, desc: 'none' };
        let inkChecked = 0;
        let inkExcused = 0;
        let inkTotal = 0;
        let inkBatches = 0;
        let worstChord = { px: -Infinity, desc: '' };
        let worstNonChord = { px: -Infinity, desc: '' };
        const excused = [];
        let measuredTotal = 0;
        const perPass = [];
        for (const stop of SLIDER_STOPS) {
          if (stop !== null) await setSlider(page, stop);
          const m = await page.evaluate(measureInPage, { legiblePx: LEGIBLE_PX, constLabels: CONST_LABELS });
          const ctx = `viewport ${width}px, ${ds.name}, ${stop === null ? 'default zoom' : `slider ${stop}/1000`}, ${m.pps.toFixed(3)} px/s, layout ${m.layout}`;
          // The ceiling is where chips are widest. If nothing there has a text
          // node, nothing was looked at and "0 clipped" would mean nothing.
          if (stop === 1000)
            assert.ok(
              m.rows.length > 0,
              `GATE-FAIL no chip with a text node was measured at the zoom ceiling (${m.totalChips} chips) @ ${ctx} -- a gate that measured nothing proves nothing`,
            );
          // THE GATE MUST HAVE LOOKED AT THE DATASET. A mutant that makes most
          // names disappear used to leave the four alphabet tests green (text
          // chips 10,524 -> 6,077): fewer chips measured is fewer chances to
          // fail. So the count is checked against the data, not against itself.
          //  * every segment has exactly one primary chip, at every zoom;
          //  * a chip that claims to be full/tight has its name (a vanished
          //    name is not a tick).
          // (Not asserted: "no ticks at the ceiling". On v3/main the ceiling is
          // 80 px/s and 1,018 short chips are legitimately ticks there; that is
          // product behaviour, not this gate's business.)
          if (m.primaryChips !== ds.payload.segments.length)
            countFailures.push(`${m.primaryChips} primary chips for ${ds.payload.segments.length} segments @ ${ctx}`);
          if (m.emptyNonTick > 0)
            countFailures.push(`${m.emptyNonTick} chip(s) claim a full/tight density but have no text @ ${ctx}`);
          measuredTotal += m.rows.length;
          const excusedIds = [];
          for (const row of m.rows) {
            const w = worstOf(row);
            // Excused ONLY if kind AND text are the product's own constants.
            // ... AND only if its text is as wide as that text is in the chip's
            // own font (see probeW): the known defect is a missing border
            // budget, which does not change the width of the text.
            const nonChord =
              EXCUSED_TEXT[row.kind] !== undefined &&
              row.text === EXCUSED_TEXT[row.kind] &&
              row.probeW !== null &&
              Math.abs(row.textW - row.probeW) <= TOLERANCE_PX;
            const allow = TOLERANCE_PX + (nonChord ? NON_CHORD_BORDER_ALLOWANCE_PX : 0);
            const wantFamily = PIN_FONT ? PINNED_FAMILY : m.overlayFamily;
            if (row.fontFamily !== wantFamily)
              styleFailures.push(`${row.id} "${row.text}" font-family is [${row.fontFamily}], want [${wantFamily}] (inherited from the overlay) @ ${ctx}`);
            if (row.fontStyle !== 'normal')
              styleFailures.push(`${row.id} "${row.text}" font-style is [${row.fontStyle}], want normal @ ${ctx}`);
            if (row.visibility !== 'visible' || row.display === 'none' || row.textW <= 0 || row.textH <= 0)
              styleFailures.push(`${row.id} "${row.text}" is not painted (visibility ${row.visibility}, display ${row.display}, text box ${row.textW}x${row.textH}) @ ${ctx}`);
            else if (row.paintAlpha < MIN_PAINT_ALPHA)
              styleFailures.push(`${row.id} "${row.text}" is painted at effective alpha ${row.paintAlpha.toFixed(3)} < ${MIN_PAINT_ALPHA} (colour alpha x ancestor opacity) @ ${ctx}`);
            if (!nonChord && w.px > worstChord.px) worstChord = { px: w.px, desc: describeRow(row, ctx) };
            if (nonChord && w.px > worstNonChord.px) worstNonChord = { px: w.px, desc: describeRow(row, ctx) };
            if (w.px > allow) failures.push({ row, ctx, px: w.px });
            else if (nonChord && w.px > TOLERANCE_PX) excused.push(describeRow(row, ctx));
            if (nonChord && w.px > TOLERANCE_PX) excusedIds.push(row.id);
          }

          // A TICK MUST BE JUSTIFIED (see UNJUSTIFIED_SPARE_PX). Every tick on the
          // page is examined; one with no recoverable name is a finding too.
          ticksSeen += m.ticks;
          for (const t of m.tickRows) {
            ticksExamined++;
            if (t.spare === null) {
              tickFailures.push(`${t.id} [${t.kind}/tick] has no name to measure (no title, and not a constant-label kind) @ ${ctx}`);
              continue;
            }
            const d = `${t.id} "${t.label}" [${t.kind}/tick] label at ${LEGIBLE_PX}px is ${t.probeW.toFixed(3)}px, tick content box ${t.contentW.toFixed(3)}px, spare ${t.spare.toFixed(3)}px @ ${ctx}`;
            if (t.spare >= UNJUSTIFIED_SPARE_PX) {
              tickFailures.push(d);
              if (t.spare > widestUnjustified.spare) widestUnjustified = { spare: t.spare, desc: d };
            }
            if (t.spare < UNJUSTIFIED_SPARE_PX && (tightestJustified.spare === Infinity || t.spare > tightestJustified.spare))
              tightestJustified = { spare: t.spare, desc: d };
          }

          // INK: look at the pixels where the text should be.
          const ink = await inkCheck(page, helper, cdp, excusedIds, inkBatchesFor(ds), ctx);
          paintFailures.push(...ink.findings);
          inkChecked += ink.checked;
          inkExcused += ink.skipped;
          inkTotal += ink.total;
          inkBatches += ink.batches;
          perPass.push(`${stop === null ? 'default' : stop}:${m.rows.length}/${m.totalChips}(ink ${ink.checked}/${ink.total})`);
        }
        results.push({ width, data: ds.name, font, measuredTotal, worstChord: worstChord.px, worstNonChord: worstNonChord.px, failures: failures.length });
        // The two new instruments must have LOOKED, or "0 findings" means nothing.
        //  * every tick the page reported was examined;
        //  * the pixel check looked at every text chip it was asked to (all of them
        //    on the real song) and at something on every dataset.
        if (ticksExamined !== ticksSeen)
          countFailures.push(`${ticksSeen} tick chip(s) on the page but ${ticksExamined} examined for justification`);
        if (measuredTotal > 0 && inkChecked === 0)
          countFailures.push(`the pixel check looked at 0 of ${inkTotal} text chips (${inkExcused} excused)`);
        if (inkBatchesFor(ds) === null && inkChecked + inkExcused !== inkTotal)
          countFailures.push(`the pixel check was to look at every text chip but looked at ${inkChecked} (+${inkExcused} excused) of ${inkTotal}`);
        // Always printed (not only under CHORD_GATE_LOG): these are real defects
        // the gate is excusing, and CI logs are where someone would look.
        for (const e of [...new Set(excused)].slice(0, 5))
          console.log(`# KNOWN DEFECT (excused by NON_CHORD_BORDER_ALLOWANCE_PX): ${e}`);
        if (LOG)
          console.log(
            `${ds.name} @${width}: font=[${font}] text-chips-measured=${measuredTotal} [${perPass.join(' ')}] ` +
              `worst-chord-protrusion=${worstChord.px.toFixed(4)}px worst-N.C./?-protrusion=${worstNonChord.px.toFixed(4)}px ` +
              `clipped=${failures.length} excused=${excused.length}\n   worst chord: ${worstChord.desc}\n` +
              `   ticks examined=${ticksExamined} unjustified=${tickFailures.length} ` +
              `tightest-justified-tick: ${tightestJustified.desc}\n` +
              `   ink: looked at ${inkChecked} of ${inkTotal} text chips in ${inkBatches} windows (${inkExcused} known-defect chips not pixel-checked), ` +
              `${paintFailures.length} finding(s)`,
          );
        assert.deepEqual(pageErrors, [], 'the page threw');
        // ALL findings are reported, not the first category that happens to be
        // checked first: a defect that trips two instruments (a ::first-line italic
        // widens the text AND ellipsizes it away) should say so. Every section
        // starts with the GATE-FAIL tag; prove-non-vacuous.mjs anchors on the
        // first.
        const sections = [];
        const list = (arr, n = 8) => arr.slice(0, n).map((l) => '  ' + l).join('\n');
        if (countFailures.length)
          sections.push(`GATE-FAIL the gate did not look at the dataset (${countFailures.length} finding(s)):\n${list(countFailures)}`);
        if (tickFailures.length)
          sections.push(
            `GATE-FAIL ${tickFailures.length} tick(s) are not justified: the chord name would have fit its chip at ${LEGIBLE_PX}px with at least ` +
              `${UNJUSTIFIED_SPARE_PX}px to spare, so the chip gave up a name it could have kept. First ${Math.min(8, tickFailures.length)}:\n${list(tickFailures)}`,
          );
        if (paintFailures.length)
          sections.push(
            `GATE-FAIL ${paintFailures.length} character(s) are not painted where the layout puts them (looked at pixels, not styles). ` +
              `First ${Math.min(8, paintFailures.length)}:\n${list(paintFailures)}`,
          );
        if (styleFailures.length)
          sections.push(
            `GATE-FAIL ${styleFailures.length} chip measurement(s) are not of the chip as it ships (font/style/visibility), ` +
              `so the widths measured are not trustworthy. First ${Math.min(8, styleFailures.length)}:\n${list(styleFailures)}`,
          );
        // Only when nothing above explains it: a chip whose name vanished has no
        // platform font at all and used to be reported here as a font problem.
        if (PIN_FONT && !sections.length && !/^Inter/.test(font))
          sections.push(`GATE-FAIL the pinned font did not paint the chips (platform fonts: ${font}); every width below would be for the wrong font`);
        if (failures.length) {
          failures.sort((a, b) => b.px - a.px);
          sections.push(
            `GATE-FAIL ${failures.length} chord chip(s) have text sticking out of the chip by more than ${TOLERANCE_PX}px ` +
              `(font: ${font}). Worst ${Math.min(12, failures.length)}:\n${list(failures.map((f) => describeRow(f.row, f.ctx)), 12)}`,
          );
        }
        if (sections.length) assert.fail(sections.join('\n'));
      } finally {
        await page.close();
        if (helper) await helper.close();
      }
    });
  }
}

test('teardown', async () => {
  if (browser) await browser.close();
});
