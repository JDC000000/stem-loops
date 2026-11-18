// MEASURE the chord-label widths the #212 geometry gates pin, in real Chromium.
//
// WHAT THIS IS FOR
// ----------------
// apps/web/test/chord-default-zoom.test.mjs runs in Node, which has no layout
// engine and no canvas, so it serves PINNED Chromium widths to the production
// measurer (makeCanvasMeasurer). ChordOverlay.helpers.ts's headless fallback
// table (ADVANCE_16PX, ESTIMATE_PAD_PX) is pinned the same way. Those numbers
// used to come from a one-off box ("Inter 4.000 on the box that measured
// them"): a machine with Inter installed system-wide, which nobody else had and
// nothing re-checked.
//
// THE REFERENCE IS NOW THE CI CHROMIUM (Jon, 2026-11-17: "re-measure those
// widths on the test machine the automated checks already run on, making it the
// new reference"). That is the `Chord chip fit (real Chromium)` job in
// .github/workflows/ci.yml: ubuntu-latest, the Playwright version pinned in
// pnpm-lock.yaml and its Chromium, `playwright install --with-deps chromium`,
// and the chips' font pinned the same way chord-chip-fit.test.mjs pins it:
// @fontsource/inter's inter-latin-400-normal.woff2 as `GateInter`, on a
// container whose family is `GateInter, sans-serif`.
//
// WHY THE MACHINE MATTERS NOW. Guitarist notation paints U+266F (♯) and U+266D
// (♭). The pinned Inter file is the `latin` subset, which has neither, so
// Chromium falls back to `sans-serif` for those two glyphs -- and what
// `sans-serif` is depends on the machine's fontconfig (DejaVu Sans on a stock
// runner, Inter on a box that has it installed). A width measured anywhere else
// is a width of a different font. This script records which platform fonts
// painted the probe (CDP CSS.getPlatformFontsForNode), so the reference says
// what it is.
//
// HOW IT IS USED
//   * test/chord-label-widths.test.mjs runs it in that CI job on every PR and
//     FAILS when the pinned numbers are not what the reference measures, printing
//     the full replacement fixture. So the reference is enforced, not described.
//   * By hand: `node --experimental-strip-types scripts/measure-chord-label-widths.mjs`
//     prints the same JSON (the fixture file's content). `--write` writes it to
//     apps/web/test/fixtures/chord-label-widths.json. Only numbers printed BY
//     THE CI JOB are the reference; on any other machine this prints that
//     machine's numbers and the CI test will (correctly) disagree.
//
// WHAT IT MEASURES, all at 16px, weight 400, in one page:
//   advance16  every glyph the chart can paint, one DOM span each (the
//              headless table's unit; 1/64px LayoutUnits), plus the measured
//              first-glyph surplus (see THE HEADLESS TABLE below);
//   canvas16   each pinned label through canvas measureText (what production
//              measures with);
//   dom16      the same labels as DOM spans (what the chip is);
//   alphabet   EVERY string the chart can paint (displayText over the Harte
//              grammar, plus N.C. and ?) as DOM spans and through canvas: the
//              table's worst under/over-estimate and the canvas-DOM spread, i.e.
//              the claims the helpers' comments make, re-derived here.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
export const WEB = resolve(process.env.CHORD_GATE_SRC ?? join(HERE, '../../../apps/web'));
export const FIXTURE_PATH = join(WEB, 'test/fixtures/chord-label-widths.json');

export const FONT_PX = 16;
export const FONT_WEIGHT = '400';
/** What getComputedStyle reads on the pinned container (chord-chip-fit.test.mjs PINNED_FAMILY). */
export const FAMILY = 'GateInter, sans-serif';
const FONT_PKG = require.resolve('@fontsource/inter/package.json');
const FONT_FILE = join(dirname(FONT_PKG), 'files', 'inter-latin-400-normal.woff2');

/**
 * The labels whose canvas AND DOM widths are pinned, as HARTE (the data), so
 * the pinned strings are whatever the formatter paints for them and a formatter
 * change re-keys the fixture instead of leaving stale keys. Each earned its
 * place in an earlier round (see chord-default-zoom.test.mjs); the ones added
 * with the notation switch put ♯, ♭, '(' and ')' in pinned labels, so every
 * table entry is defended by at least one pin.
 */
export const PIN_SOURCE_HARTE = [
  // the 3:33 fixture's whole alphabet (every label the real song measures)
  'C:maj', 'A:min7', 'F:maj7', 'G:7', 'E:min', 'F#:min7', 'Bb:maj', 'D:min7', 'G:7/5', 'C:maj6', 'A:min', 'F:maj',
  // earlier rounds' pins
  'C#:minmaj7', 'Ab:maj7/3', 'A/6', 'A#:hdim7/11', 'Ab:hdim7/b11', 'C:11', 'C#:11/11', 'Bb:add11/b3',
  'C:maj9', 'G:sus4', 'D:sus2', 'B:9/10', 'Eb:aug7/8',
  // the notation switch: flat/sharp in root, quality and bass positions
  'C#:hdim7/5', 'Eb:min', 'Db:maj7/3', 'F#:dim7', 'Ab:aug',
  // Harte labels the formatter cannot spell exactly, painted as-is: they keep
  // '#' and 'n' (and ':' 'h') in the painted alphabet, so they need pins too
  'C#:add9', 'G:min/b11',
  // the bare-root slash pair the first-glyph surplus exists for
  'A/3',
  // non-chords
  'N', 'X',
];

async function loadWeb() {
  const helpers = await import(pathToFileURL(join(WEB, 'src/components/ChordOverlay.helpers.ts')).href);
  const harte = await import(pathToFileURL(join(WEB, 'src/chord/harte.ts')).href);
  return { helpers, harte };
}

/** What the chart paints for a Harte label (N.C. / ? / guitarist notation). */
export function paintedFor(helpers, harte) {
  return helpers.displayText({ kind: helpers.classifyLabel(harte), label: harte });
}

/**
 * Every Harte label of the grammar: 21 roots x (no quality + 24) x (no bass +
 * b/#/natural x 1..13), the same construction as chord-default-zoom's glyph
 * test, plus N and X. Returns the distinct painted strings.
 */
export function paintedAlphabet(helpers, harte) {
  const roots = [];
  for (const l of 'ABCDEFG') for (const a of ['', '#', 'b']) roots.push(l + a);
  const bass = [''];
  for (let d = 1; d <= 13; d++) for (const a of ['', 'b', '#']) bass.push(`/${a}${d}`);
  const labels = ['N', 'X'];
  for (const r of roots)
    for (const q of ['', ...harte.HARTE_QUALITIES.map((x) => `:${x}`)]) for (const b of bass) labels.push(r + q + b);
  return { harteCount: labels.length, painted: [...new Set(labels.map((l) => paintedFor(helpers, l)))].sort() };
}

/**
 * Text rendering, pinned exactly as chord-chip-fit.test.mjs pins it. Without
 * these the runner's fontconfig turns hinting on and rounds every advance to a
 * whole pixel (that gate's first CI run: 5.0000px where a developer box had
 * 8.4688px), so the "reference" would be a hinted font no user sees.
 */
export const LAUNCH_ARGS = ['--font-render-hinting=none', '--enable-font-subpixel-positioning'];

const r4 = (x) => Math.round(x * 10000) / 10000;
/** Ten glyphs' worth of 1e-4 rounding: a residual this small is arithmetic, not font shaping. */
const ROUNDING_NOISE_PX = 0.0005;

export async function measure({ chromium } = {}) {
  const { helpers, harte } = await loadWeb();
  const pw = chromium ?? require('playwright').chromium;
  const { painted, harteCount } = paintedAlphabet(helpers, harte);
  const glyphs = [...new Set(painted.join(''))].sort();
  const pins = [...new Set(PIN_SOURCE_HARTE.map((h) => paintedFor(helpers, h)))];
  const fontBytes = readFileSync(FONT_FILE);

  const browser = await pw.launch({ args: LAUNCH_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const css =
      `@font-face{font-family:GateInter;font-weight:400;font-style:normal;` +
      `src:url(data:font/woff2;base64,${fontBytes.toString('base64')}) format('woff2')}` +
      `#c{font-family:GateInter,sans-serif;font-weight:400;font-size:${FONT_PX}px;font-style:normal;` +
      `position:absolute;left:0;top:0;visibility:hidden}` +
      `#c span{white-space:nowrap;display:inline-block}`;
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>` +
      `<body><div id="c"><span id="probe"></span><span id="probe-acc">♭♯</span></div></body></html>`);
    const res = await page.evaluate(
      async ({ glyphs, pins, painted, fontPx, weight }) => {
        await document.fonts.load(`${weight} ${fontPx}px GateInter`);
        await document.fonts.ready;
        const c = document.getElementById('c');
        const family = getComputedStyle(c).fontFamily;
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = `${weight} ${fontPx}px ${family}`;
        const fontTook = ctx.font;
        const span = (t) => {
          const s = document.createElement('span');
          s.textContent = t;
          c.appendChild(s);
          return s;
        };
        // Write everything, then read once (one layout, not one per label).
        const gS = glyphs.map(span);
        const pS = pins.map(span);
        const aS = painted.map(span);
        const out = {
          family,
          fontTook,
          fontLoaded: document.fonts.check(`${weight} ${fontPx}px GateInter`),
          advance: Object.fromEntries(glyphs.map((g, i) => [g, gS[i].getBoundingClientRect().width])),
          canvas: Object.fromEntries(pins.map((p) => [p, ctx.measureText(p).width])),
          dom: Object.fromEntries(pins.map((p, i) => [p, pS[i].getBoundingClientRect().width])),
          alphabetDom: aS.map((s) => s.getBoundingClientRect().width),
          alphabetCanvas: painted.map((p) => ctx.measureText(p).width),
        };
        document.getElementById('probe').textContent = glyphs.join('');
        return out;
      },
      { glyphs, pins, painted, fontPx: FONT_PX, weight: FONT_WEIGHT },
    );
    // Which platform fonts actually painted the full glyph set.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const fontsOf = async (selector) => {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      return (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    };
    const fonts = await fontsOf('#probe');
    // Which fonts painted ONLY the accidentals (the fallback the reference depends on).
    const acc = { fonts: await fontsOf('#probe-acc') };

    // THE HEADLESS TABLE. advance16 starts as each glyph's own DOM width. Inter
    // shapes some pairs wider than their parts (on the reference: a bare root
    // "A" followed by "/", e.g. "A/C" is 0.3125px wider than A + / + C), so a
    // plain sum UNDER-estimates exactly those labels -- the unsafe direction.
    // Covering that with ESTIMATE_PAD_PX alone charges every label for one
    // pair and pushes short labels ("N.C.") more than 1px over. So the surplus
    // is charged to the glyph that STARTS the short labels (their root): for
    // each first glyph, the worst shortfall of any painted label beginning with
    // it, rounded UP to a 1/64px LayoutUnit. Then the pad covers whatever is
    // left, as the next 1/64px step above the worst remaining shortfall. Both
    // are derived here from the measurement; nothing is chosen by hand.
    const single = Object.fromEntries(Object.entries(res.advance).map(([g, w]) => [g, r4(w)]));
    const residual = (table, p, i) => res.alphabetDom[i] - [...p].reduce((a, g) => a + table[g], 0);
    const surplus = {};
    painted.forEach((p, i) => {
      const r = residual(single, p, i);
      const g = [...p][0];
      // Below ROUNDING_NOISE_PX a "shortfall" is the 1e-4 rounding of the
      // advances summed over a label, not shaping; the pad covers it.
      if (r > ROUNDING_NOISE_PX) surplus[g] = Math.max(surplus[g] ?? 0, Math.ceil(r * 64 - 1e-6) / 64);
    });
    const adv = Object.fromEntries(Object.entries(single).map(([g, w]) => [g, r4(w + (surplus[g] ?? 0))]));
    let maxUnder = -Infinity;
    let worstUnder = '';
    let maxOverNoPad = -Infinity;
    let worstOver = '';
    let maxCanvasDom = 0;
    let worstCanvasDom = '';
    painted.forEach((p, i) => {
      const r = residual(adv, p, i);
      if (r > maxUnder) { maxUnder = r; worstUnder = p; }
      if (-r > maxOverNoPad) { maxOverNoPad = -r; worstOver = p; }
      const d = Math.abs(res.alphabetCanvas[i] - res.alphabetDom[i]);
      if (d > maxCanvasDom) { maxCanvasDom = d; worstCanvasDom = p; }
    });
    // ESTIMATE_PAD_PX: the next 1/64px step strictly above the worst remaining
    // shortfall, so "the table never under-estimates" holds over the whole alphabet.
    const padPx = (Math.floor(Math.max(0, maxUnder) * 64) + 1) / 64;

    return {
      reference: {
        what: 'CI Chromium: the "Chord chip fit (real Chromium)" job of .github/workflows/ci.yml',
        measuredBy: 'packages/web-browser-gate/scripts/measure-chord-label-widths.mjs',
        os: `${os.type()} ${os.release()} ${os.arch()}`,
        osRelease: readOsRelease(),
        ci: process.env.GITHUB_ACTIONS === 'true'
          ? { runnerImage: `${process.env.ImageOS ?? '?'} ${process.env.ImageVersion ?? '?'}`, runId: process.env.GITHUB_RUN_ID ?? null }
          : null,
        playwright: require('playwright/package.json').version,
        chromium: browser.version(),
        font: {
          file: '@fontsource/inter@' + require(FONT_PKG).version + '/files/inter-latin-400-normal.woff2',
          sha256: createHash('sha256').update(fontBytes).digest('hex'),
          containerFamily: res.family,
          canvasFont: res.fontTook,
          loaded: res.fontLoaded,
          platformFonts: fonts.map((f) => ({ familyName: f.familyName, postScriptName: f.postScriptName, isCustomFont: f.isCustomFont, glyphCount: f.glyphCount })),
          accidentalsPaintedBy: acc.fonts.map((f) => ({ familyName: f.familyName, postScriptName: f.postScriptName, isCustomFont: f.isCustomFont, glyphCount: f.glyphCount })),
        },
        fontPx: FONT_PX,
        fontWeight: Number(FONT_WEIGHT),
        viewport: '1280x900',
        launchArgs: LAUNCH_ARGS,
      },
      advance16: adv,
      canvas16: Object.fromEntries(pins.map((p) => [p, r4(res.canvas[p])])),
      dom16: Object.fromEntries(pins.map((p) => [p, r4(res.dom[p])])),
      alphabet: {
        harteLabels: harteCount,
        paintedStrings: painted.length,
        glyphs: glyphs.join(''),
        firstGlyphSurplusPx: Object.fromEntries(Object.entries(surplus).map(([g, v]) => [g, r4(v)]).sort()),
        tableMaxUnderPxBeforePad: r4(maxUnder),
        tableWorstUnder: worstUnder,
        estimatePadPx: padPx,
        tableMaxOverPxWithPad: r4(maxOverNoPad + padPx),
        tableWorstOver: worstOver,
        canvasDomMaxDiffPx: r4(maxCanvasDom),
        canvasDomWorst: worstCanvasDom,
      },
    };
  } finally {
    await browser.close();
  }
}

function readOsRelease() {
  try {
    const m = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(readFileSync('/etc/os-release', 'utf8'));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = await measure();
  const text = JSON.stringify(out, null, 2) + '\n';
  if (process.argv.includes('--write')) {
    writeFileSync(FIXTURE_PATH, text);
    console.error(`wrote ${FIXTURE_PATH}`);
  } else {
    process.stdout.write(text);
  }
}
