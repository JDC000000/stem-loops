// The chord timeline's DEFAULT view must show chord names.
//
// THE BUG THESE TESTS EXIST FOR
// -----------------------------
// On the job page at desktop widths the chord chips rendered but their text was
// invisible. The strip's default zoom was fit-the-whole-track: for the 3:33
// track in test/fixtures/play-chords-3m33s.json in a 904px container that is
// 4.24px/sec, so all 107 chips were 2.7-12.6px wide, every one of them fell
// into the `tick` density, and the `tick` branch painted the label
// `color: transparent`. Measured in Chromium before the fix: 107/107 chips with
// a text node whose contrast against its own background was 1.00. The user saw
// 3:33 of coloured slivers and no chord names at all.
//
// WHY THESE ASSERTIONS AND NOT EASIER ONES
// ----------------------------------------
//   - A fragment-presence check ("C:maj appears somewhere") PASSED throughout
//     the bug: `color: transparent` leaves the text node in the DOM. So the
//     render test below scopes its count to the timeline container and asserts
//     that NOTHING it counted is invisible — the chip's own declared colour
//     against the chip's own declared background.
//   - A source-text check ("the file mentions 40") is satisfied by a comment,
//     so every number here is IMPORTED and recomputed, never grepped.
//   - Node has no layout engine: `getBoundingClientRect` is 0 and
//     `getComputedStyle` reports DECLARED values. So nothing here claims to
//     measure geometry. It composes the REAL exported geometry functions the
//     component composes, over REAL chord data, and asserts on the pixel
//     numbers those functions return — the same numbers the component writes
//     into the chips' inline styles. The corresponding Chromium measurements
//     are in the PR description.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADVANCE_16PX,
  CHIP_FONT_PX,
  CHIP_FULL_PAD_PX,
  CHIP_GAP_PX,
  CHIP_TIGHT_FONT_PX,
  CHIP_TIGHT_PAD_PX,
  CEILING_SLACK_PX,
  MAX_PX_PER_SEC,
  MAX_TIMELINE_PX,
  MAX_WRAP_ROWS,
  READABLE_TIME_FRACTION,
  chipContentPx,
  densityCounts,
  layoutRows,
  ppsToSlider,
  runContentPx,
  segmentDensityCounts,
  shortestRunSec,
  sliderToPps,
  timeWeightedRunSec,
  widestLabelPx,
  zoomCeilingPxPerSec,
  canvasFontString,
  chipBox,
  chipDensity,
  clampPxPerSec,
  durationSec,
  estimateLabelPx,
  displayText,
  fitPxPerSec,
  makeCanvasMeasurer,
  NARROW_BREAKPOINT_PX,
  WRAP_DEFAULT_ROW_SEC,
  WRAP_MAX_ROW_SEC,
  observationsToRuns,
  readablePxPerSec,
} from '../src/components/ChordOverlay.helpers.ts';
import { HARTE_QUALITIES, HARTE_RE } from '../src/chord/harte.ts';
import { withDom } from './helpers/dom.mjs';
import { loadChordOverlay } from './helpers/load-chord-overlay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = JSON.parse(readFileSync(join(HERE, 'fixtures/play-chords-3m33s.json'), 'utf8'));
const OBSERVATIONS = PAYLOAD.segments.map((s) => ({
  startSec: s.start_sec,
  endSec: s.end_sec,
  label: s.label,
  confidence: s.confidence,
}));
const RUNS = observationsToRuns(OBSERVATIONS);
const DUR = durationSec(RUNS);

// ---------------------------------------------------------------------------
// THE MEASURER THE GATES USE IS THE ONE THE PRODUCT USES
// ---------------------------------------------------------------------------
//
// Every geometry gate in this file used to compute label widths with
// `estimateLabelPx` (the headless table) while ChordOverlay sizes both the zoom
// ceiling and chipDensity with `makeCanvasMeasurer`. Two instruments, and they
// disagreed in the unsafe direction: every px/sec figure here sat ~1.27% above
// what production derives, and a slack constant sized from a 13-label sample
// was applied to an alphabet of thousands.
//
// So the gates now call `makeCanvasMeasurer` itself -- the code that runs in
// every browser -- over a 2D context that serves what Chromium's canvas
// `measureText` actually returned. Node has no canvas, so those widths are
// PINNED, measured in Chromium 1280x900 on the CHIPS' font stack -- the one
// ChordOverlay's containerStyle declares and the chips inherit through
// `button { font: inherit }` (ui-sans-serif, system-ui, -apple-system,
// "Segoe UI", Roboto, sans-serif), NOT the globals.css body stack (an earlier
// note here said it was). Both resolve to Inter 4.000 on the box that measured
// them, weight 400, 16px, confirmed with CDP CSS.getPlatformFontsForNode,
// isCustomFont false. They are canvas
// numbers, not DOM numbers, which is the point. A label the table does not hold
// would make makeCanvasMeasurer fall back to the headless table SILENTLY (it
// swallows a bad width by design), so the context records every label it is
// asked for that it cannot serve, and the last test in the file fails on any.
const CHROMIUM_CANVAS_16PX = {
  'A:min': 42.9922, 'A:min7': 52.0469, 'Bb:maj': 51.75, 'C:maj': 43.1719,
  'C:maj6': 53.0938, 'C#:minmaj7': 89.7031, 'D:min7': 52.5547, 'E:min': 41.5703,
  'F:maj': 40.9297, 'F:maj7': 49.9844, 'F#:min7': 60.5859, 'G:7': 25.6016,
  'G:7/5': 41.0938, 'Ab:maj7/3': 77.0234, 'N.C.': 32.2578, '?': 8.1797,
  // Added with the table fix. Each is a label the table got wrong before it:
  // 'A/6' (bare root + slash, the table was 0.1094px UNDER), the two hdim7
  // labels ('h' was missing, 4.79 / 5.33px OVER) and the digit-heavy labels
  // that tabular digits widened by up to 15px.
  'A/6': 27.0391, 'A#:hdim7/11': 90.7656, 'Ab:hdim7/b11': 99.6875,
  'C:11': 29.3125, 'C#:11/11': 58.2266, 'Bb:add11/b3': 91.9141,
};
// The SAME labels measured a second way: a hidden <span> in the DOM, which is
// what the chip actually is. A canvas pin is only as good as whoever typed it;
// one that sits 0.9px low is invisible to the table comparison (which tolerates
// a 1px over-estimate) and quietly lowers every ceiling derived from it.
// Canvas and DOM agree to 0.0078px over all 21,002 labels of the grammar, so
// two numbers that disagree by more than 1/64px mean one of them is wrong.
const CHROMIUM_DOM_16PX = {
  'A:min': 43.0, 'A:min7': 52.0469, 'Bb:maj': 51.75, 'C:maj': 43.1719,
  'C:maj6': 53.0938, 'C#:minmaj7': 89.7031, 'D:min7': 52.5625, 'E:min': 41.5781,
  'F:maj': 40.9375, 'F:maj7': 49.9844, 'F#:min7': 60.5938, 'G:7': 25.6094,
  'G:7/5': 41.0938, 'Ab:maj7/3': 77.0313, 'N.C.': 32.2656, '?': 8.1875,
  'A/6': 27.0469, 'A#:hdim7/11': 90.7656, 'Ab:hdim7/b11': 99.6875,
  'C:11': 29.3125, 'C#:11/11': 58.2344, 'Bb:add11/b3': 91.9219,
};
// The pins above are 16px measurements. CHIP_FONT_PX is asserted equal to this
// in its own test, so changing the constant fails by NAME instead of letting
// every gate run on widths that belong to a different size.
const PIN_FONT_PX = 16;
const PROD_FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const UNPINNED_LABELS = new Set();
// Font strings the measurer set that this context could not serve.
const BAD_FONTS = new Set();
// WHAT THIS CONTEXT MODELS. It used to ignore `ctx.font` and hand back the 16px
// pin for any request, so if CHIP_FONT_PX ever moved every geometry gate in
// this file would have measured 16px widths against a different rendered size
// and stayed green. Now it reads the font the measurer assigned, refuses one it
// cannot serve (no px size, wrong weight, wrong family) and scales the pin by
// size/16 -- the same linearity estimateLabelPx relies on (measured: a label's
// 10px width is 0.625x its 16px width to 3dp). A request for a size it cannot
// serve answers NaN, which makeCanvasMeasurer turns into the table fallback,
// which the last test in the file reports.
const PROD_CTX = {
  font: '',
  measureText(text) {
    if (text === '') return { width: 0 }; // what canvas returns for ''
    const m = /^(\d+) (\d+(?:\.\d+)?)px (.+)$/.exec(String(this.font));
    if (!m || m[1] !== '400' || m[3] !== PROD_FONT_FAMILY) {
      BAD_FONTS.add(String(this.font));
      return { width: NaN };
    }
    const w = CHROMIUM_CANVAS_16PX[text];
    if (w === undefined) UNPINNED_LABELS.add(text);
    return { width: w === undefined ? NaN : (w * Number(m[2])) / PIN_FONT_PX };
  },
};
const PROD_MEASURE = makeCanvasMeasurer(PROD_CTX, {
  fontFamily: PROD_FONT_FAMILY,
  fontWeight: '400',
});

// The container widths the job page actually gives the overlay, MEASURED in
// Chromium. JobView's wrap is `maxWidth: 960` with `padding: 48px
// var(--sl-gutter, 16px) 96px`, and --sl-gutter is 16px at :root but 32px above
// 760px (design-tokens.css), so every desktop width uses the 32px gutter:
// 960 - 64 - 24px of overlay padding = 872, and at 768 the viewport binds
// instead: 768 - 64 - 24 = 680. 1280 and 1440 are the same container.
// (JobView.tsx's own comment claims --sl-gutter is out of scope on this route
// and that its 16px fallback is load-bearing. Both are false; see the PR.)
const DESKTOP_WIDTHS = [
  { viewport: 768, containerPx: 680 },
  { viewport: 1280, containerPx: 872 },
  { viewport: 1440, containerPx: 872 },
];

// ---------------------------------------------------------------------------
// THE ADVERSARIAL SHAPES. Neither was chosen by whoever wrote this fix.
// ---------------------------------------------------------------------------
//
// The register's rule: if you picked the example yourself and it works, you
// have tested nothing. So the two songs that drive the reachability gates both
// come from somewhere else, with numbers published before this change existed:
//
//   BIMODAL   - #207's own Residue section, measured and reproduced by two
//               reviewers: "60 x 4s verse + 55 x 0.4s bridge (115 chords,
//               4:22): the median comes from the sparse half, so the default is
//               19.396 px/sec and 55/115 chips (48%) are nameless at every zoom
//               the slider reaches." That is the defect this file now gates.
//   JITTER400 - #207's Scaling table, which is where the SECOND half of the
//               defect was already visible and went unread: "400 chords / 3:33,
//               jittered 0.32-0.69s | 80.000 | 50 full / 218 tight / 132 tick
//               -- the short tail falls below `tight`." Those 132 were nameless
//               AT MAXIMUM ZOOM and the table recorded it as scaling behaviour.
//
// Both are built from the fixture's own label alphabet, so `widest` is the same
// `F#:min7` the real song has and the only thing that varies is the durations.
const FIX_LABELS = [...new Set(PAYLOAD.segments.map((s) => s.label))];

/** A song from [durationSec, count] blocks, cycling the fixture's chord names. */
function songOf(blocks) {
  const obs = [];
  let t = 0;
  let i = 0;
  for (const [d, n] of blocks) {
    for (let k = 0; k < n; k++) {
      obs.push({ startSec: t, endSec: t + d, label: FIX_LABELS[i++ % FIX_LABELS.length], confidence: 1 });
      t += d;
    }
  }
  return observationsToRuns(obs);
}

/** The reviewer's shape: a sparse verse and a dense bridge. */
const BIMODAL = songOf([[4, 60], [0.4, 55]]);
/** The same two populations with FIVE chords moved across. */
const BIMODAL_FLIPPED = songOf([[4, 55], [0.4, 60]]);
/** #207's Scaling row: 400 chords over ~3:22, durations walked over 0.32-0.69s. */
const JITTER400 = songOf(
  Array.from({ length: 400 }, (_, i) => [0.32 + ((i * 97) % 38) / 100, 1]),
);

const ADVERSARIAL = [
  ['bimodal 60x4.0s + 55x0.4s (reviewer)', BIMODAL],
  ['bimodal flipped 55x4.0s + 60x0.4s', BIMODAL_FLIPPED],
  ['jittered 400 x 0.32-0.69s (#207 table)', JITTER400],
];

/** The px/sec at which THIS run can print its own name at full size. */
function ppsForFullName(run) {
  const labelPx = PROD_MEASURE(displayText(run), CHIP_FONT_PX);
  return (labelPx + CHIP_FULL_PAD_PX + CHIP_GAP_PX) / (run.endSec - run.startSec);
}
/** ... and at the 10px `tight` size, which is the last size before no name. */
function ppsForTightName(run) {
  const labelPx = PROD_MEASURE(displayText(run), CHIP_FONT_PX);
  return ((labelPx * CHIP_TIGHT_FONT_PX) / CHIP_FONT_PX + CHIP_TIGHT_PAD_PX + CHIP_GAP_PX) / (run.endSec - run.startSec);
}

/** The job's own zoom ceiling for the strip, as ChordOverlay derives it. */
function stripCeiling(runs) {
  return zoomCeilingPxPerSec(runs, PROD_MEASURE, {
    durSec: durationSec(runs),
    maxPaintedPx: MAX_TIMELINE_PX,
  });
}

/** Exactly what ChordOverlay does for the strip: the default px/sec it lands on. */
function defaultStripPps(containerPx) {
  const fit = fitPxPerSec(DUR, containerPx);
  return clampPxPerSec(readablePxPerSec(RUNS, PROD_MEASURE), fit);
}

/** Density of every chip at a given zoom, exactly as renderChip derives it. */
function densitiesAt(pps) {
  return RUNS.map((run) => {
    const w = Math.max(1, chipBox(run, pps).widthPx - 1);
    return chipDensity(w, PROD_MEASURE(displayText(run), CHIP_FONT_PX));
  });
}

// ---------------------------------------------------------------------------
// 1. The default zoom is derived from the data, not from a constant
// ---------------------------------------------------------------------------

test('the headless table and the canvas measurer both agree with Chromium', () => {
  // Pinned against real measurements on the chips' own font stack (see the
  // block comment above: ui-sans-serif ... sans-serif -> Inter 4.000, weight
  // 400, 16px), Chromium 1280x900. These are the widths of the SHIPPED chip
  // (proportional digits), canvas measureText and DOM span alike: they agree to
  // 0.0078px over all 21,002 labels of the grammar, which is the property this
  // PR depends on. If this drifts, every width below is measuring the wrong
  // thing.
  //
  // Three instruments are checked against each other: the headless table the
  // component falls back to, the production canvas measurer (through its real
  // factory) over a context serving the canvas numbers, and a DOM-span number
  // for the same label. The DOM column is what makes a mistyped CANVAS pin
  // visible: the table comparison alone tolerates 1px of over-estimate, so a
  // pin 0.9px low passed it while lowering every ceiling derived from it.
  for (const [label, real] of Object.entries(CHROMIUM_CANVAS_16PX)) {
    const dom = CHROMIUM_DOM_16PX[label];
    assert.ok(dom !== undefined, `${label}: has a canvas pin but no DOM pin`);
    assert.ok(
      Math.abs(real - dom) <= 1 / 64 + 1e-9,
      `${label}: canvas pin ${real}px vs DOM pin ${dom}px -- one of the two is mistyped`,
    );
    const table = estimateLabelPx(label, PIN_FONT_PX);
    // The table must NEVER sit under the DOM width (that declares text to fit
    // when it does not); over-estimating only costs a little zoom, and by no
    // more than a pixel for any label pinned here.
    assert.ok(
      table - dom >= 0 && table - dom <= 1,
      `${label}: headless table ${table.toFixed(3)}px vs Chromium DOM ${dom}px`,
    );
    assert.equal(PROD_MEASURE(label, PIN_FONT_PX), real, `${label}: production measurer`);
  }
  assert.deepEqual(
    Object.keys(CHROMIUM_DOM_16PX).sort(),
    Object.keys(CHROMIUM_CANVAS_16PX).sort(),
    'a DOM pin without a canvas pin (or the reverse)',
  );
  // And the table scales linearly with font size, which is how `tight` is judged.
  assert.ok(Math.abs(estimateLabelPx('F#:min7', 10) - 60.594 * 0.625) < 0.2);
});

test('the pins are 16px measurements, so CHIP_FONT_PX may not move without re-measuring them', () => {
  // THE LATENT TRAP THIS CLOSES. The pins are canvas widths at 16px, and the
  // sizing pass will want to change CHIP_FONT_PX. PROD_CTX used to ignore the
  // font the measurer set and serve the 16px pin for any size, so every
  // geometry gate would have kept measuring 16px widths against a different
  // rendered size and stayed green. It now scales the pin by size/16, which is
  // right only while canvas advances stay linear in size at the new size AND
  // still agree with the DOM there -- neither of which was measured. So a
  // different CHIP_FONT_PX fails HERE, by name, until someone re-pins both
  // columns at the new size and moves PIN_FONT_PX.
  assert.equal(
    CHIP_FONT_PX,
    PIN_FONT_PX,
    `CHIP_FONT_PX is ${CHIP_FONT_PX} but CHROMIUM_CANVAS_16PX / CHROMIUM_DOM_16PX were measured at ${PIN_FONT_PX}px: ` +
      're-measure both at the new size (canvas AND a DOM span), then update PIN_FONT_PX',
  );
});

test('the pinned canvas context honours the font it is given', () => {
  // The context is the instrument every geometry gate reads through, so it gets
  // its own gate. Ask it for other sizes: the answer must follow the size.
  const spec = { fontFamily: PROD_FONT_FAMILY, fontWeight: '400' };
  const fresh = makeCanvasMeasurer(PROD_CTX, spec);
  const at16 = fresh('F#:min7', 16);
  assert.equal(at16, CHROMIUM_CANVAS_16PX['F#:min7']);
  assert.ok(Math.abs(fresh('F#:min7', 10) - at16 * 0.625) < 1e-9, 'a 10px request must not be served the 16px pin');
  assert.ok(Math.abs(fresh('F#:min7', 20) - at16 * 1.25) < 1e-9, 'a 20px request must not be served the 16px pin');
  assert.ok(fresh('F#:min7', 20) > fresh('F#:min7', 16) && fresh('F#:min7', 16) > fresh('F#:min7', 10));
  // A weight or family the pins were not measured at is refused, not served.
  const wrongFamily = makeCanvasMeasurer(PROD_CTX, { fontFamily: 'serif', fontWeight: '400' });
  const wrongWeight = makeCanvasMeasurer(PROD_CTX, { fontFamily: PROD_FONT_FAMILY, fontWeight: '700' });
  const kept = [...BAD_FONTS];
  BAD_FONTS.clear();
  assert.equal(wrongFamily('G:7', 16), estimateLabelPx('G:7', 16), 'a wrong family must fall back, not be served the pin');
  assert.equal(wrongWeight('G:7', 16), estimateLabelPx('G:7', 16), 'a wrong weight must fall back, not be served the pin');
  assert.equal(BAD_FONTS.size, 2, 'the context did not record the fonts it refused');
  // The two probes above were deliberate; forget them (and keep what the other
  // gates recorded) so the final test only reports a REAL gate that measured at
  // a font the pins cannot serve.
  BAD_FONTS.clear();
  for (const f of kept) BAD_FONTS.add(f);
});

test('the advance table holds exactly the glyphs the Harte grammar renders', () => {
  // The grammar, from the real source (harte.ts is the TS mirror of the worker's
  // HARTE_RE): 21 roots x (no quality + 24 qualities) x (no bass + b/#/natural
  // x degrees 1..13), plus what displayText draws for N and X. Built here,
  // not typed, so a new quality adds its glyphs to the requirement.
  const roots = [];
  for (const l of 'ABCDEFG') for (const a of ['', '#', 'b']) roots.push(l + a);
  const bass = [''];
  for (let d = 1; d <= 13; d++) for (const a of ['', 'b', '#']) bass.push(`/${a}${d}`);
  const labels = [];
  for (const r of roots) for (const q of ['', ...HARTE_QUALITIES.map((x) => `:${x}`)]) for (const b of bass) labels.push(r + q + b);
  assert.equal(labels.length, 21 * 25 * 40);
  assert.ok(labels.every((l) => HARTE_RE.test(l)), 'the generated alphabet is wider than the grammar');
  const used = new Set([...labels.join(''), ...displayText({ kind: 'none', label: 'N' }), ...displayText({ kind: 'unknown', label: 'X' })]);
  const have = new Set(Object.keys(ADVANCE_16PX));
  // A glyph the table lacks is charged the WIDEST advance: safe, but it made
  // every hdim7 label up to 5.33px too wide for months ('h' was the one).
  assert.deepEqual([...used].filter((g) => !have.has(g)).sort(), [], 'a glyph the grammar renders has no advance in the table');
  // An entry nothing renders is defended by no label: mutating the space, '-',
  // '(' and ')' entries to 1.5 left the whole suite green.
  assert.deepEqual([...have].filter((g) => !used.has(g)).sort(), [], 'the table has an advance for a glyph nothing renders');
  for (const l of FIX_LABELS) {
    assert.ok([...l].every((g) => have.has(g)), `fixture label ${l} uses a glyph outside the table`);
  }
});

test('the OLD default (fit-the-whole-track) made every chord label unshowable', () => {
  // This is the bug, reproduced through the real exported functions. It is here
  // so that a change which quietly restores fit-to-width as the strip default
  // fails loudly instead of going green.
  for (const { viewport, containerPx } of DESKTOP_WIDTHS) {
    const oldPps = fitPxPerSec(DUR, containerPx);
    const ticks = densitiesAt(oldPps).filter((d) => d === 'tick').length;
    assert.equal(
      ticks,
      RUNS.length,
      `@${viewport}: fit-to-width is ${oldPps.toFixed(2)}px/sec and leaves ${ticks}/${RUNS.length} chips unable to show a label`,
    );
  }
});

test('the default zoom comes from the widest chord name in THIS job, not a constant', () => {
  // NOT a recomputation of the helper's own arithmetic. The previous version of
  // this test rebuilt `(widest + pad + gap) / median` from the same inputs and
  // asserted equality, which proves only that the code applied its own rule.
  // These are properties of the ANSWER instead: it must respond to the label
  // widths, respond to the run durations, and be in the units it claims.
  const base = readablePxPerSec(RUNS, PROD_MEASURE);

  // Longer names -> wider zoom. The widest name is the numerator.
  const longerNames = RUNS.map((r) => ({ ...r, label: 'C#:minmaj7', kind: 'chord' }));
  assert.ok(
    readablePxPerSec(longerNames, PROD_MEASURE) > base,
    'a job whose chord names are longer must default to a wider zoom',
  );
  // Longer chords -> narrower zoom. The run duration is the denominator.
  const slower = RUNS.map((r) => ({ ...r, startSec: r.startSec * 2, endSec: r.endSec * 2 }));
  assert.ok(
    readablePxPerSec(slower, PROD_MEASURE) < base,
    'a job whose chords last twice as long must default to half the zoom',
  );
  // And it is a px/sec that actually does the job it is named for: at this
  // zoom a run of the length the statistic picked carries the longest name.
  const picked = timeWeightedRunSec(
    RUNS.map((r) => r.endSec - r.startSec),
    READABLE_TIME_FRACTION,
  );
  const widest = widestLabelPx(RUNS, PROD_MEASURE);
  assert.equal(
    chipDensity(chipContentPx(picked * base), widest),
    'full',
    'the default zoom does not make a run of the length it sized for readable',
  );
});

test('the default statistic is duration-weighted, and that is what kills a 4x cliff', () => {
  // THE DEFECT THIS REPLACES. The old statistic was the COUNT median, which on
  // a song with two sections lands on whichever population has more chips --
  // and jumps to the other one when a handful of chords move across. Modelled
  // here as the old rule (written out, not imported) against the new one.
  const countMedian = (runs) => {
    const a = runs.map((r) => r.endSec - r.startSec).filter((d) => d > 0).sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };
  const oldRule = (runs) =>
    clampPxPerSec(
      (widestLabelPx(runs, PROD_MEASURE) + CHIP_FULL_PAD_PX + CHIP_GAP_PX) / countMedian(runs),
      fitPxPerSec(durationSec(runs), 872),
    );

  const a = oldRule(BIMODAL);
  const b = oldRule(BIMODAL_FLIPPED);
  assert.ok(
    b / a > 3,
    `the old count median was supposed to be unstable here: ${a.toFixed(3)} vs ${b.toFixed(3)}`,
  );

  // The new statistic returns the SAME answer for both mixes. Not "close":
  // equal, because the duration-weighted median of these two populations is
  // the same 4.0s run either way.
  assert.equal(
    readablePxPerSec(BIMODAL, PROD_MEASURE),
    readablePxPerSec(BIMODAL_FLIPPED, PROD_MEASURE),
    'moving five chords between sections must not move the default zoom',
  );

  // And the weighting is real, not a relabelling: on a song whose chip counts
  // and whose time shares disagree, the two statistics differ.
  assert.notEqual(
    timeWeightedRunSec(BIMODAL.map((r) => r.endSec - r.startSec), READABLE_TIME_FRACTION),
    countMedian(BIMODAL_FLIPPED),
  );
});

test('at the default zoom the chips can show their names at every desktop width', () => {
  for (const { viewport, containerPx } of DESKTOP_WIDTHS) {
    const pps = defaultStripPps(containerPx);
    const d = densitiesAt(pps);
    const ticks = d.filter((x) => x === 'tick').length;

    assert.ok(
      ticks <= 1,
      `@${viewport}: ${ticks}/${RUNS.length} chips still cannot show a label at ${pps.toFixed(2)}px/sec`,
    );
    // HALF THE TRACK'S TIME, at full size. The bar used to be stated over the
    // median CHIP, which is the statistic this PR moved away from, so asserting
    // it would have pinned the old rule. The thing the new default promises is
    // READABLE_TIME_FRACTION of the song's chord seconds in `full` chips --
    // measured here by summing the durations of the runs that came out `full`.
    const fullSec = RUNS.reduce(
      (acc, r, i) => (d[i] === 'full' ? acc + (r.endSec - r.startSec) : acc),
      0,
    );
    const totalSec = RUNS.reduce((acc, r) => acc + (r.endSec - r.startSec), 0);
    assert.ok(
      fullSec / totalSec >= READABLE_TIME_FRACTION,
      `@${viewport}: only ${((100 * fullSec) / totalSec).toFixed(1)}% of the track's chord time ` +
        `is in chips that fit their name at full size (want >= ${100 * READABLE_TIME_FRACTION}%)`,
    );
  }
});

test('a sparse song still fits the strip; a dense song is capped, not run away', () => {
  // 12 chords over the same 3:33: the readable zoom is BELOW fit-to-width, so
  // the floor wins and the whole track still fills the container (no empty strip).
  const sparse = observationsToRuns(
    Array.from({ length: 12 }, (_, i) => ({
      startSec: (i * DUR) / 12,
      endSec: ((i + 1) * DUR) / 12,
      label: ['C:maj', 'A:min7', 'F:maj7', 'G:7'][i % 4],
      confidence: 1,
    })),
  );
  const fit = fitPxPerSec(durationSec(sparse), 904);
  assert.ok(readablePxPerSec(sparse, PROD_MEASURE) < fit);
  assert.equal(clampPxPerSec(readablePxPerSec(sparse, PROD_MEASURE), fit), fit);

  // 400 chords over the same 3:33: the derivation wants far more than the
  // maximum zoom, and must be capped there rather than returning Infinity.
  const dense = observationsToRuns(
    Array.from({ length: 400 }, (_, i) => ({
      startSec: (i * DUR) / 400,
      endSec: ((i + 1) * DUR) / 400,
      label: 'F#:min7',
      confidence: 1,
    })),
  );
  const densePps = readablePxPerSec(dense, PROD_MEASURE);
  assert.ok(Number.isFinite(densePps));
  // The imported constant, not a literal that merely happens to equal it today.
  assert.equal(densePps, MAX_PX_PER_SEC);
  assert.ok(readablePxPerSec(dense, PROD_MEASURE, MAX_PX_PER_SEC) <= MAX_PX_PER_SEC);
});

// ---------------------------------------------------------------------------
// 1b. THE ZOOM CEILING: every chord in the job must be reachable
// ---------------------------------------------------------------------------
//
// THE DEFECT THESE GATES EXIST FOR
// --------------------------------
// `MAX_PX_PER_SEC = 80` was the maximum zoom, and it was a bound on nothing --
// 80px/sec is not a statement about any text. A chord needs
// (labelPx + pad + gap) / durationSec px/sec to carry its name, so below about
// 0.52s of run (one chord per beat at 115bpm) no zoom the slider could reach
// would name it. On the reviewer's bimodal song that left 25 of 115 chords
// with no readable name AT ANY ZOOM; on #207's own jittered-400 row it left 91.
// The user could not get at them, and nothing said so.

test('the OLD cap left chords that no zoom could name — the defect, reproduced', () => {
  // Driven off the IMPORTED constant, so this reproduces the old ceiling rather
  // than a literal 80 that merely equals it today.
  for (const [name, runs] of ADVERSARIAL) {
    const unreachable = runs.filter((r) => ppsForTightName(r) > MAX_PX_PER_SEC);
    assert.ok(
      unreachable.length > 0,
      `${name}: expected the old cap to strand chords, found none — has the shape drifted?`,
    );
    // And it is not a rounding-margin case: they need multiples of the old cap.
    const worst = Math.max(...runs.map(ppsForTightName));
    assert.ok(
      worst > MAX_PX_PER_SEC * 1.25,
      `${name}: worst chord needs ${worst.toFixed(1)}px/sec against a ${MAX_PX_PER_SEC} cap`,
    );
  }
});

test('the derived ceiling names EVERY chord in the job, at full size', () => {
  for (const [name, runs] of ADVERSARIAL.concat([['the real 3:33 fixture', RUNS]])) {
    const ceiling = stripCeiling(runs);
    // The requirement, built per-run from the exported geometry constants --
    // NOT from zoomCeilingPxPerSec's own shortest-run shortcut. If the helper
    // picked the wrong run, or dropped the gap, or used the wrong label, this
    // maximum does not move with it.
    const required = Math.max(...runs.map(ppsForFullName));
    assert.ok(
      ceiling >= required - 1e-9,
      `${name}: ceiling ${ceiling.toFixed(3)} < ${required.toFixed(3)} px/sec needed by its shortest chord`,
    );
    // The consequence, counted over the real density function: nothing nameless.
    const counts = densityCounts(runs, ceiling, PROD_MEASURE);
    assert.equal(
      counts.tick,
      0,
      `${name}: ${counts.tick}/${runs.length} chords still have no name at the top of the slider`,
    );
    assert.equal(
      counts.tight,
      0,
      `${name}: ${counts.tight} chords only reach the 10px size at the top of the slider`,
    );
  }
});

test('the ceiling keeps the one pixel of slack clientWidth rounding needs', () => {
  // WHAT THIS REPLACED. It asserted CEILING_SLACK_PX >= 1.664, "the delta canvas
  // cannot see", a figure taken from a 13-label sample. Over the real alphabet
  // that delta was up to 15.164px (C:11 alone 7.4px), so the assertion passed
  // while 24 chips at the ceiling were clipped by 13px. The disagreement is now
  // removed at its cause (chips carry no tabular digits; see the render gate
  // below), so what is left for the slack to cover is the ~1px integer
  // rounding of clientWidth that #207 recorded -- a number from outside this file.
  //
  // WHAT THIS DEFENDS, EXACTLY. Only `CEILING_SLACK_PX >= 1` (the rounding
  // artifact) -- and in fact only that plus the 0.0078px canvas-vs-DOM
  // disagreement, so anything from about 1.01 up. The shipped value is 2.
  // Mutated to 1, 1.9 or 1.5 this file stays green, and that is deliberate
  // rather than an oversight: nothing measured says 2 beats 1.9, so no test
  // pretends to. Mutated to 0.5 it goes red, here.
  const CLIENTWIDTH_ROUNDING_PX = 1;
  assert.ok(CEILING_SLACK_PX >= CLIENTWIDTH_ROUNDING_PX);
  for (const [name, runs] of ADVERSARIAL.concat([['fixture', RUNS]])) {
    const ceiling = stripCeiling(runs);
    // The widest name on the shortest run: the one chip that sits at the limit.
    const content = chipContentPx(shortestRunSec(runs) * ceiling);
    const headroom = content - CHIP_FULL_PAD_PX - widestLabelPx(runs, PROD_MEASURE);
    assert.ok(
      headroom >= CLIENTWIDTH_ROUNDING_PX - 1e-9,
      `${name}: only ${headroom.toFixed(3)}px of headroom at the ceiling, needs ${CLIENTWIDTH_ROUNDING_PX}px`,
    );
  }
});

test('the ceiling only ever ADDS zoom range — no job loses what it has today', () => {
  // A fix that improves a metric by removing a capability is not a fix. A slow
  // song's shortest run may need less than the old cap; the ceiling must not
  // follow it down.
  const slow = songOf([[12, 20]]);
  assert.ok(
    Math.max(...slow.map(ppsForFullName)) < MAX_PX_PER_SEC,
    'the slow song is supposed to need less than the old cap',
  );
  for (const [, runs] of ADVERSARIAL.concat([['fixture', RUNS], ['slow', slow]])) {
    assert.ok(
      stripCeiling(runs) >= MAX_PX_PER_SEC,
      `a job's zoom ceiling fell below MAX_PX_PER_SEC (${MAX_PX_PER_SEC})`,
    );
  }
  // Degenerate input cannot produce a ceiling below the floor either.
  assert.equal(zoomCeilingPxPerSec([], PROD_MEASURE, { durSec: 10 }), MAX_PX_PER_SEC);
  assert.equal(
    zoomCeilingPxPerSec([{ startSec: 0, endSec: 0, label: 'C:maj', kind: 'chord' }], PROD_MEASURE, { durSec: 0 }),
    MAX_PX_PER_SEC,
  );
});

test('the slider reaches the ceiling, and the ceiling is where it stops', () => {
  // The ceiling is only a capability if the control gets there. Both ends, on
  // the shape whose top end used to be unreachable.
  const runs = BIMODAL;
  const dur = durationSec(runs);
  const minPps = fitPxPerSec(dur, 872);
  const maxPps = stripCeiling(runs);
  assert.ok(maxPps > MAX_PX_PER_SEC, 'this shape should raise its own ceiling');

  assert.ok(Math.abs(sliderToPps(1, minPps, maxPps) - maxPps) < 1e-9);
  assert.ok(Math.abs(ppsToSlider(maxPps, minPps, maxPps) - 1) < 1e-9);
  assert.equal(sliderToPps(0, minPps, maxPps), minPps);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(ppsToSlider(sliderToPps(t, minPps, maxPps), minPps, maxPps) - t) < 1e-9);
  }
  // And at the top of that slider the chords really are named.
  assert.equal(densityCounts(runs, sliderToPps(1, minPps, maxPps), PROD_MEASURE).tick, 0);
});

test('the painted-length budget binds on malformed data, and nothing else', () => {
  // A single 5ms run would otherwise demand ~15,700px/sec and a 3.8M-px strip.
  // The budget is a guard against data the 10fps detector cannot emit, so it
  // must bind THERE and not on any of the real shapes.
  const pathological = songOf([[0.005, 1], [3, 80]]);
  const dur = durationSec(pathological);
  const ceiling = stripCeiling(pathological);
  assert.ok(
    Math.max(...pathological.map(ppsForFullName)) > ceiling,
    'the pathological run was supposed to out-demand the budget',
  );
  assert.ok(
    dur * ceiling <= MAX_TIMELINE_PX + 1e-6,
    `strip would paint ${(dur * ceiling).toFixed(0)}px against a ${MAX_TIMELINE_PX}px budget`,
  );
  // On every real shape the budget is slack, so the ceiling is the data's.
  for (const [name, runs] of ADVERSARIAL.concat([['fixture', RUNS]])) {
    const d = durationSec(runs);
    assert.ok(
      d * stripCeiling(runs) < MAX_TIMELINE_PX / 10,
      `${name}: the budget is doing the deciding (${(d * stripCeiling(runs)).toFixed(0)}px)`,
    );
  }
});

test('the wrapped layout gets the same ceiling, bounded by rows of DOM', () => {
  // The strip's chip count does not change with zoom; a wrapped row is created
  // per rowSec, so here the ceiling really does buy DOM. Rows must stay inside
  // the measured budget, and the phone must still reach every chord.
  // THE NUMBER THIS IS JUDGED AGAINST IS NOT MAX_WRAP_ROWS. An earlier version
  // asserted `rows <= MAX_WRAP_ROWS` with the constant imported, so both sides
  // of the comparison moved together and the gate could not fail: raising
  // MAX_WRAP_ROWS from 800 to 100_000 left the whole suite green with the
  // pathological song at ~6,900 rows. Found by mutation testing, not by
  // reading it.
  //
  // So the bar is the MEASURED cost boundary instead, which no edit to the
  // constant moves: Chromium at 390x800, 3 nodes per row, build+layout is flat
  // from the 73 rows today's cap produces (26.8ms) through 800 rows (31.5ms),
  // then 2,000 rows costs 62.2ms -- roughly double -- and 7,000 rows 238.3ms.
  const ROWS_WHERE_LAYOUT_COST_DOUBLES = 2000;
  assert.ok(
    MAX_WRAP_ROWS <= ROWS_WHERE_LAYOUT_COST_DOUBLES,
    `MAX_WRAP_ROWS=${MAX_WRAP_ROWS} is at or past the row count where wrapped ` +
      `layout cost doubles (${ROWS_WHERE_LAYOUT_COST_DOUBLES})`,
  );

  const rowWidthPx = Math.max(120, NARROW_CONTAINER_PX - GUTTER_PX);
  for (const [name, runs] of ADVERSARIAL.concat([['pathological', songOf([[0.005, 1], [3, 80]])]])) {
    const ceiling = zoomCeilingPxPerSec(runs, PROD_MEASURE, {
      durSec: durationSec(runs),
      maxPaintedPx: Math.min(MAX_TIMELINE_PX, MAX_WRAP_ROWS * rowWidthPx),
    });
    const rows = layoutRows(runs, rowWidthPx / ceiling, ceiling).length;
    assert.ok(
      rows <= ROWS_WHERE_LAYOUT_COST_DOUBLES,
      `${name}: ${rows} wrapped rows at the ceiling, past the measured ` +
        `${ROWS_WHERE_LAYOUT_COST_DOUBLES}-row cost cliff`,
    );
    assert.ok(
      rows <= MAX_WRAP_ROWS,
      `${name}: ${rows} wrapped rows at the ceiling, over the ${MAX_WRAP_ROWS} budget`,
    );
    assert.ok(ceiling >= MAX_PX_PER_SEC, `${name}: the phone lost zoom range`);
  }
});

test('the wrapped layout keeps SOME nameless chips at any zoom, and the ceiling cuts them', () => {
  // WHAT THE CEILING DOES NOT PROMISE ON A PHONE, asserted so nobody reads the
  // strip's guarantee as universal. `layoutRows` splits a run that crosses a
  // row boundary and each piece is narrower than the run, so no finite zoom
  // makes every PIECE readable. Counting runs instead of segments is what hid
  // this: an earlier version of this gate asserted tick === 0 here and passed,
  // while Chromium at 390px showed 21 nameless chips at the same zoom.
  const rowWidthPx = Math.max(120, NARROW_CONTAINER_PX - GUTTER_PX);
  const ceiling = zoomCeilingPxPerSec(BIMODAL, PROD_MEASURE, {
    durSec: durationSec(BIMODAL),
    maxPaintedPx: Math.min(MAX_TIMELINE_PX, MAX_WRAP_ROWS * rowWidthPx),
  });
  const segsAt = (pps) =>
    segmentDensityCounts(BIMODAL, layoutRows(BIMODAL, rowWidthPx / pps, pps), PROD_MEASURE);

  // Counting runs would claim zero. Counting what renders does not.
  assert.equal(densityCounts(BIMODAL, ceiling, PROD_MEASURE).tick, 0);
  assert.ok(
    segsAt(ceiling).tick > 0,
    'the wrapped layout is expected to keep split-run ticks; if this is now 0, strengthen the claim',
  );

  // What the ceiling DOES buy the phone: strictly fewer nameless chips than
  // the old cap could reach, and strictly more readable ones.
  const old = segsAt(MAX_PX_PER_SEC);
  const now = segsAt(ceiling);
  assert.ok(
    now.tick < old.tick,
    `the phone's ceiling did not reduce nameless chips: ${old.tick} -> ${now.tick}`,
  );
  assert.ok(now.full > old.full, `readable chips did not increase: ${old.full} -> ${now.full}`);
  // And they stay a minority, which is the bar the wrapped layout already had.
  const total = now.full + now.tight + now.tick;
  assert.ok(now.tick < total * 0.25, `${now.tick}/${total} nameless on the phone at its ceiling`);
});

test('the default is still an overview — the ceiling was not reached by zooming in', () => {
  // The cheap way to make "nameless chips" go to zero is to default to the
  // ceiling, which would trade the whole timeline for four chords on screen.
  // On the reviewer's shape the default must stay well below its own ceiling
  // and still show a usable span of the song.
  const dur = durationSec(BIMODAL);
  const def = clampPxPerSec(
    readablePxPerSec(BIMODAL, PROD_MEASURE),
    fitPxPerSec(dur, 872),
    stripCeiling(BIMODAL),
  );
  assert.ok(def < stripCeiling(BIMODAL) / 4, `default ${def.toFixed(3)} is near its ceiling`);
  assert.ok(872 / def > 30, `the default shows only ${(872 / def).toFixed(1)}s of a ${dur.toFixed(0)}s track`);
  // And the time-coverage promise still holds on this shape, which is the
  // reason the dense half is allowed to be ticks at the default at all.
  const fullSec = BIMODAL.reduce(
    (acc, r) =>
      chipDensity(runContentPx(r, def), PROD_MEASURE(displayText(r), CHIP_FONT_PX)) === 'full'
        ? acc + (r.endSec - r.startSec)
        : acc,
    0,
  );
  assert.ok(fullSec / dur >= READABLE_TIME_FRACTION);
});

test('chipContentPx is the one rule for a chip width, gap included', () => {
  // `renderChip` had a bare `widthPx - 1` while `fullChipPx` reserved
  // CHIP_GAP_PX -- the last untied literal of the family #207 closed for the
  // padding and the tight font size. One function now, so the number that
  // decides a label fits and the number that sizes the box cannot drift.
  assert.equal(chipContentPx(100), 100 - CHIP_GAP_PX);
  assert.equal(chipContentPx(0), 1, 'a chip never has a non-positive content width');
  assert.equal(runContentPx({ startSec: 1, endSec: 3 }, 50), 100 - CHIP_GAP_PX);
  // The gap is really reserved by the fit rule: a box exactly one label wide
  // plus padding is NOT full, because the gap is taken off it first.
  const labelPx = PROD_MEASURE('F#:min7', CHIP_FONT_PX);
  assert.equal(chipDensity(chipContentPx(labelPx + CHIP_FULL_PAD_PX), labelPx), 'tight');
  assert.equal(chipDensity(chipContentPx(labelPx + CHIP_FULL_PAD_PX + CHIP_GAP_PX), labelPx), 'full');
});

// ---------------------------------------------------------------------------
// 2. The measurer that actually runs in a browser
// ---------------------------------------------------------------------------
//
// happy-dom's `getContext('2d')` returns null (asserted below), so under the
// DOM harness the component ALWAYS falls back to `estimateLabelPx`. Without
// these tests the canvas path -- the one path every real user is served -- is
// executed by nothing. A mutant that quartered `measureText(...).width`, or
// dropped the `px` unit from the font shorthand, left the whole suite green
// while restoring the defect in Chromium.

/** A 2D context that only measures what its font is actually set to. */
function fakeCtx({ widths, initialFont = '10px sans-serif', strict = true } = {}) {
  return {
    font: initialFont,
    set _(v) {},
    measureText(text) {
      const m = /(?:^|\s)(\d+(?:\.\d+)?)px(?:\s|$)/.exec(this.font);
      const px = m ? Number(m[1]) : 10;
      return { width: widths(text, px) };
    },
    // Canvas IGNORES an invalid shorthand and keeps the old value. Model that.
    assign(v) {
      if (!strict || /(?:^|\s)\d+(?:\.\d+)?px(?:\s|$)/.test(v)) this.font = v;
    },
  };
}
/** Wrap so `ctx.font = x` goes through the canvas accept/ignore rule. */
function strictCtx(opts) {
  const inner = fakeCtx(opts);
  return {
    get font() { return inner.font; },
    set font(v) { inner.assign(v); },
    measureText: (t) => inner.measureText(t),
  };
}

test('happy-dom really has no 2D context — so these tests are the only cover', async () => {
  await withDom(async (dom) => {
    const ctx = dom.window.document.createElement('canvas').getContext('2d');
    assert.equal(ctx, null, 'if happy-dom gained a canvas, revisit what the render gate proves');
    // And the factory degrades to the calibrated table rather than throwing.
    const m = makeCanvasMeasurer(ctx, { fontFamily: 'x', fontWeight: '400' });
    assert.equal(m('F#:min7', CHIP_FONT_PX), estimateLabelPx('F#:min7', CHIP_FONT_PX));
  });
});

test('canvasFontString always carries an explicit px size', () => {
  const f = canvasFontString('400', 16, 'ui-sans-serif, system-ui');
  assert.match(f, /(?:^|\s)16px(?:\s|$)/, `font shorthand had no px size: "${f}"`);
  assert.equal(f, '400 16px ui-sans-serif, system-ui');
  assert.equal(canvasFontString('700', 10, 'x'), '700 10px x');
});

test('the canvas measurer reports the size it ASKED for, or falls back', () => {
  // A context that honours the font: the measurer must pass the width through.
  const honest = strictCtx({ widths: (t, px) => estimateLabelPx(t, px) });
  const m = makeCanvasMeasurer(honest, { fontFamily: 'ui-sans-serif', fontWeight: '400' });
  assert.equal(m('F#:min7', CHIP_FONT_PX), estimateLabelPx('F#:min7', CHIP_FONT_PX));
  assert.equal(m('F#:min7', 10), estimateLabelPx('F#:min7', 10));
  assert.ok(m('F#:min7', CHIP_FONT_PX) > m('G:7', CHIP_FONT_PX));

  // A context that REFUSES the font (the shorthand was invalid) keeps its old
  // 10px default and would otherwise hand back a width ~1.6x too small, in the
  // direction that declares text to fit when it does not. The read-back must
  // catch that and fall back to the table.
  const refusing = {
    _f: '10px sans-serif',
    get font() { return this._f; },
    set font(_v) { /* canvas IGNORES a shorthand it cannot parse */ },
    measureText(t) { return { width: estimateLabelPx(t, 10) }; },
  };
  const m2 = makeCanvasMeasurer(refusing, { fontFamily: 'ui-sans-serif', fontWeight: '400' });
  assert.equal(
    m2('F#:min7', CHIP_FONT_PX),
    estimateLabelPx('F#:min7', CHIP_FONT_PX),
    'a context stuck at 10px must not be believed about a 16px label',
  );
  assert.ok(m2('F#:min7', CHIP_FONT_PX) > estimateLabelPx('F#:min7', 10) * 1.5);
});

test('the canvas measurer never reports a width it did not measure', () => {
  for (const bad of [0, -5, NaN, Infinity, undefined]) {
    const ctx = strictCtx({ widths: () => bad });
    const m = makeCanvasMeasurer(ctx, { fontFamily: 'x', fontWeight: '400' });
    assert.equal(
      m('F#:min7', CHIP_FONT_PX),
      estimateLabelPx('F#:min7', CHIP_FONT_PX),
      `width ${String(bad)} must fall back to the table, not be passed through`,
    );
  }
  // A context that throws is a fallback, not a crash.
  const throwing = { font: '', measureText() { throw new Error('nope'); } };
  const m = makeCanvasMeasurer(throwing, { fontFamily: 'x', fontWeight: '400' });
  assert.equal(m('C:maj', CHIP_FONT_PX), estimateLabelPx('C:maj', CHIP_FONT_PX));
  assert.equal(makeCanvasMeasurer(null, { fontFamily: 'x', fontWeight: '400' })('C:maj', 16),
    estimateLabelPx('C:maj', 16));
});

test('a measurer that under-reports moves the default zoom, and the gate sees it', () => {
  // The shape of M3 (`width / 4`) and M7 (dropped unit), expressed as a property:
  // a measurer that reports less than the truth lowers the default zoom, which
  // is exactly how the chips stopped fitting their names.
  const honest = makeCanvasMeasurer(
    strictCtx({ widths: (t, px) => estimateLabelPx(t, px) }),
    { fontFamily: 'x', fontWeight: '400' },
  );
  const quartered = (label, px) => estimateLabelPx(label, px) / 4;
  const truePps = readablePxPerSec(RUNS, honest);
  const badPps = readablePxPerSec(RUNS, quartered);
  assert.ok(
    badPps < truePps / 2,
    `under-measuring must lower the zoom: ${badPps.toFixed(3)} vs ${truePps.toFixed(3)}`,
  );

  // And at that zoom the chips demonstrably cannot carry their names.
  const clipped = RUNS.filter((run) => {
    const w = Math.max(1, chipBox(run, badPps).widthPx - 1);
    return chipDensity(w, PROD_MEASURE(displayText(run), CHIP_FONT_PX)) !== 'full';
  }).length;
  assert.ok(clipped > RUNS.length * 0.9, `${clipped}/${RUNS.length} chips clipped at the bad zoom`);
});

// ---------------------------------------------------------------------------
// 3. The render gate: nothing counted may be invisible
// ---------------------------------------------------------------------------

/**
 * Drive a React controlled <input type="range"> the way a user would.
 *
 * WHY THIS IS NOT `el.value = x`. React 18 installs its own `value` setter on
 * the input INSTANCE and uses it as a change tracker: assigning through it
 * records the new value, so the `input` event that follows is judged a no-op
 * and `onChange` is never called. Measured in this harness — three imperative
 * assignments moved `el.value` and produced ZERO onChange calls.
 *
 * Two tests below used to set `.value` directly and assert on "the zoomed-out
 * state". The zoom never moved: they were reading the DEFAULT view, and their
 * assertions (`some tick chips exist`, `no tick chip carries text`) happen to
 * hold there too, so they passed without exercising the thing they named. The
 * native prototype setter bypasses the instance tracker, so React sees a real
 * change — which is also what makes the ceiling gates able to fail.
 */
async function dragRange(dom, el, value) {
  const nativeSet = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    'value',
  ).set;
  await dom.act(() => {
    nativeSet.call(el, String(value));
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

/** rgb()/rgba()/named -> {r,g,b,a}. Returns null for a value we cannot read. */
function parseColor(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (v === 'white' || v === '#fff' || v === '#ffffff') return { r: 255, g: 255, b: 255, a: 1 };
  const hex = v.match(/^#([0-9a-f]{6})$/);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const fn = v.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const p = fn[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  const hsl = v.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/);
  if (hsl) {
    const [h, s, l] = [Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100];
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
    return { r: (seg[0] + m) * 255, g: (seg[1] + m) * 255, b: (seg[2] + m) * 255, a: 1 };
  }
  return null;
}

const toLin = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
const lum = (c) => 0.2126 * toLin(c.r) + 0.7152 * toLin(c.g) + 0.0722 * toLin(c.b);

/** WCAG contrast of `fg` composited over `bg`, over `bg`. 1.0 = literally invisible. */
function contrast(fg, bg) {
  const mix = { r: 0, g: 0, b: 0 };
  for (const k of ['r', 'g', 'b']) mix[k] = fg[k] * fg.a + bg[k] * (1 - fg.a);
  const [a, b] = [lum(mix), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * A chip's declared font size in px. `rem` is resolved against a 16px root (the
 * harness has none); anything else, and nothing at all, is NaN -- which every
 * caller treats as "this chip does not say what size it renders at".
 */
function parseFontPx(value) {
  const v = String(value ?? '').trim();
  const px = /^(\d+(?:\.\d+)?)px$/.exec(v);
  if (px) return Number(px[1]);
  const rem = /^(\d+(?:\.\d+)?)rem$/.exec(v);
  if (rem) return Number(rem[1]) * 16;
  return NaN;
}

/**
 * Mount the real component at a given container width and read every chip in
 * the timeline container. happy-dom has no layout, so the container width is
 * injected the only way the component can take one: through the element's own
 * getBoundingClientRect, which is what its ResizeObserver effect reads.
 */
async function mountOverlay(dom, { containerPx, afterMount, payload = PAYLOAD } = {}) {
  const React = (await import('react')).default;
  const { ChordOverlay } = await loadChordOverlay();
  const w = dom.window;

  // Patch the prototype that OWNS the method, and remember its exact descriptor:
  // assigning onto HTMLElement.prototype (which does not own it) leaves an own
  // property behind, and the harness correctly reports that as pollution.
  const proto = Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, 'getBoundingClientRect')
    ? w.HTMLElement.prototype
    : w.Element.prototype;
  const realDesc = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect');
  const realRect = proto.getBoundingClientRect;
  const hadFetch = Object.prototype.hasOwnProperty.call(globalThis, 'fetch');
  const realFetch = globalThis.fetch;
  proto.getBoundingClientRect = function patched() {
    if (this.dataset && this.dataset.testid === 'chord-timeline') {
      const box = { x: 0, y: 0, top: 0, left: 0, right: containerPx, bottom: 36, width: containerPx, height: 36 };
      return { ...box, toJSON: () => box };
    }
    return realRect.call(this);
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/play-chords')) {
      return { ok: true, status: 200, json: async () => ({ signed_url: '/signed', expires_in_sec: 60 }) };
    }
    return { ok: true, status: 200, json: async () => payload };
  };

  try {
    await dom.mount(React.createElement(ChordOverlay, { jobId: 'fixture-job' }));
    await dom.act();
    if (afterMount) await afterMount(dom);
    const timeline = dom.find('[data-testid="chord-timeline"]');
    assert.ok(timeline, 'the timeline container did not render');
    // SCOPED to the container: a chip counted here is a chip on the timeline.
    const chips = [...timeline.querySelectorAll('[data-testid^="chord-chip-"]')];
    // WHAT THIS MODELS, EXACTLY -- so the assertions are not read as more than
    // they are. Each chip's own DECLARED text colour composited over its own
    // DECLARED background, and both of those composited over the page
    // background with the chip's element `opacity` (the component sets 0.85 on
    // continued-row chips, which fades text and background together towards the
    // page and so really does cut contrast). It does NOT walk the ancestor
    // chain: happy-dom resolves no cascade, so an ancestor's background is not
    // reachable from a chip's computed style here. One ancestor DOES declare
    // one -- `[data-testid="chord-overlay"]` is `rgba(0,0,0,0.6)` -- so the
    // earlier claim that the overlay's ancestors declare none was wrong.
    // Ignoring it is safe in one direction only: compositing a chip over the
    // near-black page instead of over that slightly lighter panel can only
    // UNDERstate contrast on this palette, never overstate it. On a light
    // palette the same reasoning would not hold. `parseColor('transparent')`
    // deliberately returns an alpha-0 colour rather than null so it composites
    // instead of being swapped for an opaque default.
    const pageBg = parseColor('#0b0d12');
    const over = (c, under) => ({
      r: c.r * c.a + under.r * (1 - c.a),
      g: c.g * c.a + under.g * (1 - c.a),
      b: c.b * c.a + under.b * (1 - c.a),
      a: 1,
    });
    const rows = chips.map((chip) => {
      const cs = w.getComputedStyle(chip);
      const fg = parseColor(cs.color) ?? { r: 255, g: 255, b: 255, a: 1 };
      const bgRaw = parseColor(cs.backgroundColor) ?? parseColor(cs.background) ?? { r: 0, g: 0, b: 0, a: 0 };
      const o = Number.isFinite(Number(cs.opacity)) && cs.opacity !== '' ? Number(cs.opacity) : 1;
      // chip background as painted, then the text on top of it, both faded by o.
      const bgPainted = over({ ...bgRaw, a: bgRaw.a * o }, pageBg);
      const fgPainted = over({ ...fg, a: fg.a * o }, bgPainted);
      const text = chip.textContent;
      // FIT, independent of colour: the chip's own inline width, put back
      // through the real density function with the real label. A chip that
      // paints readable text in a box too small for it is still a failure.
      const declaredW = parseFloat(chip.style.width) || 0;
      const labelPx = PROD_MEASURE(text, CHIP_FONT_PX);
      // ... and again at the size the CHIP ITSELF declares, read off the element
      // and not from a constant: a chip that renders at a size other than the
      // one the measurer was asked about cannot hide behind the constant. An
      // undeclared or unparseable size is NaN and counts as not fitting.
      const fontPx = parseFontPx(chip.style.fontSize);
      const chipDensityNow = chip.dataset.density;
      const fitsAtDeclaredSize =
        text.length === 0
          ? null
          : !Number.isFinite(fontPx)
            ? false
            : chipDensityNow === 'full'
              ? declaredW >= PROD_MEASURE(text, fontPx) + CHIP_FULL_PAD_PX
              : chipDensityNow === 'tight'
                ? declaredW >= PROD_MEASURE(text, fontPx) + CHIP_TIGHT_PAD_PX
                : false;
      return {
        fontPx,
        fitsAtDeclaredSize,
        density: chip.dataset.density,
        testid: chip.dataset.testid,
        text,
        hasText: text.length > 0,
        color: cs.color,
        opacity: o,
        widthPx: declaredW,
        fitsDensity: text.length === 0 ? null : chipDensity(declaredW, labelPx),
        contrast: contrast(fgPainted, bgPainted),
      };
    });
    const hint = dom.find('[data-testid="timeline-hint"]');
    const namelessNode = dom.find('[data-testid="timeline-nameless"]');
    return {
      timeline,
      chips,
      rows,
      renderedPps: Number(timeline.dataset.pxPerSec),
      hintText: hint ? hint.textContent : '',
      namelessText: namelessNode ? namelessNode.textContent : null,
    };
  } finally {
    if (realDesc) Object.defineProperty(proto, 'getBoundingClientRect', realDesc);
    else delete proto.getBoundingClientRect;
    if (hadFetch) globalThis.fetch = realFetch;
    else delete globalThis.fetch;
  }
}

// ---------------------------------------------------------------------------
// 3a. THE FONT-CHANNEL ALLOWLIST
// ---------------------------------------------------------------------------
//
// THE PROPERTY. The zoom ceiling and every chip's density are decided with a
// canvas measurer that is told ONE size, ONE weight and ONE family. A chip is
// as wide as that measurement says only if nothing else changes the advances of
// its glyphs. Canvas cannot express font-variant-numeric, font-feature-settings,
// letter-spacing, word-spacing, a different weight or size, kerning,
// text-transform, zoom -- and the list is open: a new spelling tomorrow is not
// on any list written today.
//
// WHAT THIS REPLACED. A test titled "no chord chip declares a font feature that
// canvas cannot express" whose comment claimed "a differently spelled
// declaration cannot satisfy it and cannot hide it", and whose body was a regex
// of SEVEN KEYWORDS over the chip's own inline style. Measured against the real
// component in Chromium, each of these left that file at 33/33 green while chips
// clipped:
//   fontFeatureSettings: '"tnum"' on a chip          7 clipped 5.92px at the ceiling
//   fontVariantNumeric on the CONTAINER (the parent)  7 clipped 5.92px
//   fontSize: '1.25rem' on a chip                    21 clipped 13.16px
//   fontWeight: 700 + letterSpacing on a chip         7 clipped 10.8px
// The first is a spelling the regex did not list; the second is a property on an
// ANCESTOR, which a chip-only read cannot see; the rest are not "numeric
// features" at all.
//
// WHAT THIS DOES INSTEAD. It ENUMERATES what is permitted and fails on anything
// else, on every element from a chip up to the overlay root:
//   - a CHIP may declare exactly CHIP_DECLARES. The only one of those that
//     changes glyph advances is `fontSize`, and its VALUE is checked against the
//     constants the measurer and chipDensity use (CHIP_FONT_PX, or
//     CHIP_TIGHT_FONT_PX for a tight chip), imported, not retyped.
//   - an ANCESTOR may declare exactly ANCESTOR_DECLARES (layout and paint only).
//     `fontFamily` is additionally permitted on the measured wrap and above,
//     because that is where the measurer READS the family from; between the wrap
//     and the chip it is invisible to the measurer and therefore forbidden.
//   - nothing may carry a class but `co-scroll`, and the one <style> the overlay
//     renders may declare only scrollbar properties, so a stylesheet cannot
//     carry what an inline style may not.
// A property the allowlist does not know FAILS, with its name, and the fix is a
// deliberate edit here -- which is where a reviewer sees it -- not a keyword.
//
// TWO CHANNELS, because each misses something. React's own props
// (`__reactProps$...`.style) carry every key the component wrote, including the
// vendor-prefixed and unknown ones happy-dom's `style` setter DROPS
// (`WebkitTextSizeAdjust` and `fontSmooth` serialise to nothing). The serialised
// `style` attribute carries what actually landed on the element, including
// anything an effect set imperatively through a ref. The gate takes the union.
//
// WHAT IT CANNOT SEE, stated so it is not read as more: happy-dom resolves no
// cascade, so a rule in a stylesheet outside this component (globals.css's
// `button { font: inherit }`, a browser setting, a user stylesheet) is
// invisible here. The sizes that matter are measured in real Chromium and
// recorded in the PR; the declared px size is what stops the browser's default
// font size reaching the chips at all.

// Custom properties (`--x`) keep their spelling; everything else, vendor prefixes included, is camelCased.
const kebabToCamel = (n) => (n.startsWith('--') ? n : n.replace(/-([a-z])/g, (_m, c) => c.toUpperCase()));

/** Everything an element declares inline, camelCased, from both channels. */
function declaredProps(el) {
  const names = new Set();
  const reactKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  const rs = reactKey ? el[reactKey].style : undefined;
  if (rs && typeof rs === 'object') for (const k of Object.keys(rs)) names.add(k);
  for (const decl of (el.getAttribute('style') ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) names.add(kebabToCamel(decl.slice(0, i).trim()));
  }
  return { names, reactStyle: rs && typeof rs === 'object' ? rs : null, reactReadable: Boolean(reactKey) };
}

/** What a chip (a <button> on the timeline) may declare. Nothing here but fontSize touches glyph advances. */
const CHIP_DECLARES = new Set([
  'background', 'border', 'borderRadius', 'borderTopLeftRadius', 'borderBottomLeftRadius',
  'boxSizing', 'color', 'cursor', 'fontSize', 'height', 'left', 'opacity', 'overflow',
  'padding', 'position', 'textOverflow', 'top', 'whiteSpace', 'width',
]);
/** What any element BETWEEN the overlay root and a chip may declare: layout and paint, no text properties. */
const ANCESTOR_DECLARES = new Set([
  'alignItems', 'background', 'borderRadius', 'color', 'display', 'flex', 'flexBasis', 'flexDirection',
  'flexGrow', 'flexShrink', 'gap',
  'height', 'left', 'minHeight', 'overflowX', 'overflowY', 'padding', 'position', 'right', 'top',
  'visibility', 'width',
]);
/** Permitted only on the measured wrap and above: it is where the measurer reads the family from. */
const MEASURED_TIER_EXTRA = new Set(['fontFamily']);
const ALLOWED_CLASSES = new Set(['co-scroll']);
/** The declarations the overlay's own <style> may contain. */
const STYLE_ELEMENT_PROPS = new Set([
  'scrollbar-width', 'scrollbar-color', 'height', 'background', 'border-radius', 'border', 'background-clip',
]);

/** Every violation of the allowlist for the mounted chips; [] when the font channels are closed. */
function fontChannelViolations(dom, chips) {
  const out = [];
  const root = dom.find('[data-testid="chord-overlay"]');
  if (!root) return ['no [data-testid="chord-overlay"] root: the ancestor walk has nothing to stop at'];
  const seenAncestors = new Set();
  for (const chip of chips) {
    const id = chip.dataset.testid;
    const { names, reactStyle, reactReadable } = declaredProps(chip);
    if (!reactReadable) out.push(`${id}: React props unreadable (the gate would see only happy-dom's serialisation)`);
    for (const n of names) if (!CHIP_DECLARES.has(n)) out.push(`${id}: declares ${n}, which a chip may not`);
    // The one allowed property that moves glyph advances: its value is tied.
    const density = chip.dataset.density;
    const want = `${density === 'tight' ? CHIP_TIGHT_FONT_PX : CHIP_FONT_PX}px`;
    if (chip.style.fontSize !== want) out.push(`${id}: font-size is "${chip.style.fontSize}", want "${want}" for a ${density} chip`);
    if (reactStyle && reactStyle.fontSize !== want) out.push(`${id}: React fontSize is "${reactStyle.fontSize}", want "${want}"`);
    if (reactStyle && reactStyle.whiteSpace !== 'nowrap') out.push(`${id}: whiteSpace is "${reactStyle.whiteSpace}", want "nowrap"`);
    if (reactStyle && reactStyle.boxSizing !== 'border-box') out.push(`${id}: boxSizing is "${reactStyle.boxSizing}"`);
    const wantPad = density === 'full' ? `0 ${CHIP_FULL_PAD_PX / 2}px` : '0';
    if (reactStyle && reactStyle.padding !== wantPad) out.push(`${id}: padding is "${reactStyle.padding}", want "${wantPad}"`);
    const chipCls = (chip.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    for (const c of chipCls) if (!ALLOWED_CLASSES.has(c)) out.push(`${id}: carries class "${c}"`);

    // Walk UP to the root. `tier` flips to "measured" at the wrap and stays.
    let tier = 'unmeasured';
    for (let el = chip.parentElement; el; el = el.parentElement) {
      if (el.dataset?.testid === 'chord-timeline') tier = 'measured';
      if (!seenAncestors.has(el)) {
        seenAncestors.add(el);
        const label = el.dataset?.testid ?? `<${el.tagName.toLowerCase()}>`;
        const p = declaredProps(el);
        const allowed = tier === 'measured' ? new Set([...ANCESTOR_DECLARES, ...MEASURED_TIER_EXTRA]) : ANCESTOR_DECLARES;
        for (const n of p.names) {
          if (!allowed.has(n)) {
            out.push(
              `${label} (${tier}): declares ${n}` +
                (n === 'fontFamily' ? ' between the measured wrap and the chip, where the measurer cannot read it' : ''),
            );
          }
        }
        for (const c of (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) {
          if (!ALLOWED_CLASSES.has(c)) out.push(`${label}: carries class "${c}"`);
        }
      }
      if (el === root) break;
    }
  }
  // The overlay's own <style>: selectors under .co-scroll, scrollbar properties only.
  for (const st of root.querySelectorAll('style')) {
    for (const rule of st.textContent.split('}')) {
      const brace = rule.indexOf('{');
      if (brace < 0) continue;
      const selector = rule.slice(0, brace).trim();
      if (!selector.startsWith('.co-scroll')) out.push(`<style>: selector "${selector}" is not under .co-scroll`);
      for (const decl of rule.slice(brace + 1).split(';')) {
        const i = decl.indexOf(':');
        if (i <= 0) continue;
        const prop = decl.slice(0, i).trim();
        if (!STYLE_ELEMENT_PROPS.has(prop)) out.push(`<style>: "${selector}" declares ${prop}`);
      }
    }
  }
  return [...new Set(out)];
}

/** N and X chips are the rest/unknown styles; the fixture has none of them in strip view. */
const ALL_KINDS_PAYLOAD = {
  segments: [
    ...PAYLOAD.segments,
    { start_sec: 213.0, end_sec: 214.5, label: 'N', confidence: 1 },
    { start_sec: 214.5, end_sec: 216.0, label: 'X', confidence: 1 },
    { start_sec: 216.0, end_sec: 218.0, label: 'A#:hdim7/11', confidence: 1 },
  ],
};

test('the allowlist reader sees a font property however it is spelled and wherever it was declared', async () => {
  // A check that cannot fail has not checked. Feed the reader the spellings the
  // old keyword regex missed, plus ones happy-dom's style setter drops, and
  // confirm each comes out as a name the allowlist will reject.
  await withDom(async (dom) => {
    const d = dom.window.document;
    const el = d.createElement('button');
    el.setAttribute(
      'style',
      'font-feature-settings: "tnum"; letter-spacing: .02em; font: 700 20px serif; -webkit-text-size-adjust: 120%; --x: 1; font-variant-numeric: var(--x)',
    );
    const { names } = declaredProps(el);
    for (const n of ['fontFeatureSettings', 'letterSpacing', 'font', 'WebkitTextSizeAdjust', '--x', 'fontVariantNumeric']) {
      assert.ok(names.has(n), `the reader did not surface ${n}: ${[...names].join(', ')}`);
      assert.ok(!CHIP_DECLARES.has(n) && !ANCESTOR_DECLARES.has(n), `${n} is on an allowlist`);
    }
    // And the one font property a chip IS allowed is still the only one.
    assert.deepEqual([...CHIP_DECLARES].filter((n) => /^font|^letter|^word|^text(?!Overflow)|^zoom|^transform/i.test(n)), ['fontSize']);
    assert.deepEqual([...ANCESTOR_DECLARES].filter((n) => /^font|^letter|^word|^text|^zoom|^transform/i.test(n)), []);
  });
});

test('no chord chip, and nothing above one, declares a property that can change glyph advances', async () => {
  const cases = [
    ['strip, default zoom', { containerPx: 872 }, 'strip'],
    ['strip, zoomed all the way out (ticks)', {
      containerPx: 872,
      afterMount: async (d) => dragRange(d, d.find('[data-testid="zoom-slider"]'), 0),
    }, 'strip'],
    ['strip, every chip kind (chord, none, unknown)', { containerPx: 872, payload: ALL_KINDS_PAYLOAD }, 'strip'],
    ['wrapped (phone)', { containerPx: NARROW_CONTAINER_PX }, 'wrapped'],
    ['wrapped, every chip kind', { containerPx: NARROW_CONTAINER_PX, payload: ALL_KINDS_PAYLOAD }, 'wrapped'],
  ];
  for (const [name, opts, layout] of cases) {
    await withDom(async (dom) => {
      const { chips, timeline } = await mountOverlay(dom, opts);
      assert.equal(timeline.dataset.layout, layout, `${name}: wrong layout, the case would not test what it names`);
      assert.ok(chips.length >= 100, `${name}: only ${chips.length} chips mounted; the gate would be vacuous`);
      assert.deepEqual(fontChannelViolations(dom, chips), [], `${name}: a font-affecting declaration reached a chip`);
      await dom.unmountAll();
    });
  }
});

test('the allowlist gate meets every density and every kind, so it is not a vacuous pass', async () => {
  await withDom(async (dom) => {
    const { chips } = await mountOverlay(dom, { containerPx: 872, payload: ALL_KINDS_PAYLOAD });
    const seen = new Set(chips.map((c) => `${c.dataset.kind}/${c.dataset.density}`));
    for (const want of ['chord/full', 'chord/tight', 'none/full', 'unknown/full']) {
      assert.ok(seen.has(want), `no ${want} chip mounted (saw ${[...seen].sort().join(', ')})`);
    }
    // The tied size is not one value: full and tight chips differ, and tick chips carry the full one.
    const sizes = new Set(chips.map((c) => c.style.fontSize));
    assert.deepEqual([...sizes].sort(), [`${CHIP_TIGHT_FONT_PX}px`, `${CHIP_FONT_PX}px`].sort());
    await dom.unmountAll();
  });
});

test('default view: every chord chip on the timeline shows a READABLE label', async () => {
  await withDom(async (dom) => {
    const { rows } = await mountOverlay(dom, { containerPx: 872 });

    assert.equal(rows.length, RUNS.length, 'wrong number of chips on the timeline');

    const invisible = rows.filter((r) => r.hasText && r.contrast < 1.05);
    assert.deepEqual(
      invisible.map((r) => `${r.text} @ ${r.color}`),
      [],
      'a chip has a text node the user cannot see',
    );

    const readable = rows.filter((r) => r.hasText && r.contrast >= 3);
    assert.ok(
      readable.length >= rows.length - 1,
      `only ${readable.length}/${rows.length} chips carry a readable label`,
    );

    // Colour is not fit. A chip can paint perfectly legible text in a box too
    // small to hold it, which is what the old 34px `full` threshold produced.
    // Put each chip's OWN inline width back through the real density function
    // with its real label and require the answer to match what it rendered as.
    const mismatched = rows.filter((r) => r.hasText && r.fitsDensity !== r.density);
    assert.deepEqual(
      mismatched.map((r) => `${r.text}: ${r.widthPx}px rendered as ${r.density}, fits ${r.fitsDensity}`),
      [],
      'a chip\'s declared width does not match the density it rendered at',
    );
    const notFull = rows.filter((r) => r.hasText && r.fitsDensity === 'tick');
    assert.deepEqual(notFull.map((r) => r.text), [], 'a chip has text in a box too small for any size');
    // And again at the size each CHIP DECLARES (read off the element, measured
    // by the production measurer at that size). The two checks above ask about
    // CHIP_FONT_PX; a chip rendering at any other size answers this one.
    assert.deepEqual(
      rows.filter((r) => r.hasText && !r.fitsAtDeclaredSize).map((r) => `${r.text}: ${r.widthPx}px box, font ${r.fontPx}px`),
      [],
      'a chip\'s text is wider than its box at the font size the chip itself declares',
    );
    await dom.unmountAll();
  });
});

test('at ANY zoom a chip either shows a readable label or carries no text at all', async () => {
  // The invariant the `color: transparent` branch broke. Driving the zoom
  // slider to 0 reproduces the old default exactly, so this covers the state
  // the user used to land in as well as the one they land in now.
  await withDom(async (dom) => {
    const { rows } = await mountOverlay(dom, {
      containerPx: 872,
      afterMount: async (d) => {
        const slider = d.find('[data-testid="zoom-slider"]');
        assert.ok(slider, 'no zoom slider');
        await dragRange(d, slider, 0);
        // Proof the drag landed: the component's own px/sec is now BELOW the
        // default it mounted at. Without this the test reads the default view
        // and its assertions hold there too, which is how it used to pass.
        const moved = Number(d.find('[data-testid="chord-timeline"]').dataset.pxPerSec);
        assert.ok(
          moved < defaultStripPps(872) - 1,
          `the slider did not move: still ${moved}px/sec at slider 0 (see dragRange)`,
        );
      },
    });

    const ticks = rows.filter((r) => r.density === 'tick');
    assert.ok(ticks.length > 0, 'the zoomed-out state did not produce any tick chips to check');
    assert.deepEqual(
      ticks.filter((r) => r.hasText).map((r) => r.text),
      [],
      'a tick chip still carries text — it is in the DOM but cannot be read',
    );
    for (const r of rows) {
      assert.ok(
        !r.hasText || r.contrast >= 1.05,
        `chip "${r.text}" has invisible text at ${r.color}`,
      );
    }
    await dom.unmountAll();
  });
});

test('a tick chip keeps its chord on an accessible name even with no visible text', async () => {
  await withDom(async (dom) => {
    const { chips } = await mountOverlay(dom, {
      containerPx: 872,
      afterMount: async (d) => {
        const slider = d.find('[data-testid="zoom-slider"]');
        await dragRange(d, slider, 0);
      },
    });
    const ticks = chips.filter((c) => c.dataset.density === 'tick');
    assert.ok(ticks.length > 0);
    for (const c of ticks) {
      const name = c.getAttribute('aria-label') ?? '';
      assert.ok(name.length > 0, 'a tick chip lost its accessible name');
    }
    // And the first chord's real label is reachable there, not merely "a string".
    const first = chips[0].getAttribute('aria-label');
    assert.match(first, /C/, `first chip's accessible name was "${first}"`);
    await dom.unmountAll();
  });
});

// ---------------------------------------------------------------------------
// 3b. The render gate for the ceiling: the user can actually get there
// ---------------------------------------------------------------------------
//
// The gates above are arithmetic over the exported functions. These drive the
// real component's own zoom slider on the reviewer's bimodal song and count
// what came out of the DOM, because "the ceiling is 196px/sec" and "the user
// can read the bridge" are different claims and only the second one matters.

/** The reviewer's bimodal song in the fixture's own on-the-wire shape. */
const BIMODAL_PAYLOAD = {
  segments: BIMODAL.map((r) => ({
    start_sec: r.startSec,
    end_sec: r.endSec,
    label: r.label,
    confidence: 1,
  })),
};

test('bimodal song: the default names the verse and SAYS how many it cannot name', async () => {
  await withDom(async (dom) => {
    const { rows, namelessText, renderedPps } = await mountOverlay(dom, {
      containerPx: 872,
      payload: BIMODAL_PAYLOAD,
    });
    assert.equal(rows.length, BIMODAL.length);

    // Counted out of the DOM, not out of densityCounts: the chips that
    // rendered with no text node at all.
    const domNameless = rows.filter((r) => !r.hasText);
    assert.ok(
      domNameless.length > 0,
      'this song is supposed to have nameless chips at its default — shape drifted?',
    );

    // The hint line must report THAT number. A hint that says "0" or says
    // nothing leaves the raised ceiling as a capability nobody is told about.
    assert.ok(namelessText, 'no nameless-chord hint rendered on a song that has them');
    const said = Number((namelessText.match(/(\d+)/) ?? [])[1]);
    assert.equal(
      said,
      domNameless.length,
      `the hint says ${said} chords are unnamed; ${domNameless.length} chips rendered without text`,
    );
    assert.match(namelessText, /zoom in/, 'the hint does not say the names are reachable');

    // Nothing that DID render is invisible or in a box too small for it.
    assert.deepEqual(rows.filter((r) => r.hasText && r.contrast < 1.05).map((r) => r.text), []);
    assert.deepEqual(
      rows.filter((r) => r.hasText && r.fitsDensity !== r.density).map((r) => `${r.text}@${r.widthPx}px`),
      [],
    );
    // And every nameless chip still carries its chord where a reader can get it.
    for (const c of [...dom.find('[data-testid="chord-timeline"]').querySelectorAll('[data-density="tick"]')]) {
      assert.ok((c.getAttribute('aria-label') ?? '').length > 0);
    }
    assert.ok(renderedPps > 0 && renderedPps < stripCeiling(BIMODAL));
    await dom.unmountAll();
  });
});

test('bimodal song: driving the slider to the top names EVERY chord', async () => {
  // THE CAPABILITY. Before this change the slider's top was 80px/sec and 25 of
  // these 115 chords could not be named at it. The component is driven through
  // its own control, so the ceiling has to be plumbed into sliderToPps, the
  // clamp and the chip geometry for this to come out right.
  await withDom(async (dom) => {
    const { rows, renderedPps, namelessText } = await mountOverlay(dom, {
      containerPx: 872,
      payload: BIMODAL_PAYLOAD,
      afterMount: async (d) => {
        const slider = d.find('[data-testid="zoom-slider"]');
        assert.ok(slider, 'no zoom slider');
        assert.ok(!slider.disabled, 'the zoom slider is disabled on a song that needs it');
        await dragRange(d, slider, 1000);
      },
    });

    // It really went past the old cap, read off the component's own attribute.
    assert.ok(
      renderedPps > MAX_PX_PER_SEC,
      `the slider topped out at ${renderedPps}px/sec, still at or below the old ${MAX_PX_PER_SEC} cap`,
    );

    const nameless = rows.filter((r) => !r.hasText);
    assert.deepEqual(
      nameless.map((r) => r.testid),
      [],
      `${nameless.length}/${rows.length} chords still have no name at the top of the slider`,
    );
    // Every one of them at FULL size, not the 10px fallback, and none of them
    // in a box too small for the text it is painting.
    assert.deepEqual(rows.filter((r) => r.density !== 'full').map((r) => `${r.text}:${r.density}`), []);
    assert.deepEqual(
      rows.filter((r) => r.fitsDensity !== r.density).map((r) => `${r.text}@${r.widthPx}px`),
      [],
    );
    assert.deepEqual(rows.filter((r) => r.contrast < 3).map((r) => r.text), []);
    // Nothing left to tell the user about.
    assert.equal(namelessText, null, `the hint still reports unnamed chords: ${namelessText}`);
    await dom.unmountAll();
  });
});

test('bimodal song: the + button is live until the ceiling, then stops', async () => {
  // At the old cap `+` went dead at 80px/sec while 25 chords were still
  // nameless, which is the same defect wearing a different hat.
  await withDom(async (dom) => {
    await mountOverlay(dom, {
      containerPx: 872,
      payload: BIMODAL_PAYLOAD,
      afterMount: async (d) => {
        const plus = d.find('[data-testid="zoom-in"]');
        assert.ok(!plus.disabled, '+ is dead at the default zoom');
        // 1.5x per press from ~19.6px/sec reaches ~196px/sec in 6 presses.
        for (let i = 0; i < 20 && !d.find('[data-testid="zoom-in"]').disabled; i++) {
          const btn = d.find('[data-testid="zoom-in"]');
          await d.act(() => btn.click());
        }
        const tl = d.find('[data-testid="chord-timeline"]');
        const pps = Number(tl.dataset.pxPerSec);
        assert.ok(
          pps > MAX_PX_PER_SEC,
          `+ went dead at ${pps}px/sec, at or below the old ${MAX_PX_PER_SEC} cap`,
        );
        assert.ok(
          Math.abs(pps - stripCeiling(BIMODAL)) < 0.5,
          `+ stopped at ${pps} rather than the job's ceiling ${stripCeiling(BIMODAL).toFixed(3)}`,
        );
        assert.equal(densityCounts(BIMODAL, pps, PROD_MEASURE).tick, 0);
      },
    });
    await dom.unmountAll();
  });
});

test('the real fixture is unchanged in kind: no nameless-chord hint it does not need', async () => {
  // #207's measured outcome on the real song must survive this change. One
  // chip is nameless at the default there, so the hint appears and says 1.
  await withDom(async (dom) => {
    const { rows, namelessText } = await mountOverlay(dom, { containerPx: 872 });
    const domNameless = rows.filter((r) => !r.hasText).length;
    assert.ok(domNameless <= 1, `${domNameless} nameless chips on the real song's default`);
    if (domNameless === 0) assert.equal(namelessText, null);
    else assert.equal(Number((namelessText.match(/(\d+)/) ?? [])[1]), domNameless);
    await dom.unmountAll();
  });
});

// ---------------------------------------------------------------------------
// 4. The wrapped (narrow) layout
// ---------------------------------------------------------------------------
//
// The strip and the wrapped layout take their defaults from DIFFERENT places
// (`readablePxPerSec` vs `WRAP_DEFAULT_ROW_SEC`), so gating the strip gates
// nothing here. A mutant that moved WRAP_DEFAULT_ROW_SEC from 8 to 40 left the
// whole suite green with half the phone's chips nameless.

/** 390px viewport -> 334px container, measured in Chromium. */
const NARROW_CONTAINER_PX = 334;
const GUTTER_PX = 44; // row-time labels, mirrors ChordOverlay

test('the wrapped layout is the one the phone gets at 390px', () => {
  assert.ok(
    NARROW_CONTAINER_PX < NARROW_BREAKPOINT_PX,
    `a ${NARROW_CONTAINER_PX}px container must take the wrapped layout`,
  );
  assert.ok(WRAP_DEFAULT_ROW_SEC < WRAP_MAX_ROW_SEC, 'the default row must be tighter than the loosest');
});

test('the narrow default puts chord names on the phone, not ticks', () => {
  const rowWidthPx = Math.max(120, NARROW_CONTAINER_PX - GUTTER_PX);
  const minPps = Math.min(MAX_PX_PER_SEC, rowWidthPx / WRAP_MAX_ROW_SEC);
  const pps = clampPxPerSec(rowWidthPx / WRAP_DEFAULT_ROW_SEC, minPps);

  const ticks = RUNS.filter((run) => {
    const w = Math.max(1, chipBox(run, pps).widthPx - 1);
    return chipDensity(w, PROD_MEASURE(displayText(run), CHIP_FONT_PX)) === 'tick';
  }).length;
  assert.ok(
    ticks <= 2,
    `${ticks}/${RUNS.length} chords are nameless at the phone's default (${pps.toFixed(2)}px/sec)`,
  );

  // And the default really is tighter than the floor -- if it collapsed onto
  // minPps the way the strip's default used to, this is where it would show.
  assert.ok(pps > minPps, `the narrow default collapsed onto its minimum (${pps} vs ${minPps})`);
});

test('wrapped render: nothing on the phone timeline is invisible or mis-sized', async () => {
  await withDom(async (dom) => {
    const { rows } = await mountOverlay(dom, { containerPx: NARROW_CONTAINER_PX });
    const timeline = dom.find('[data-testid="chord-timeline"]');
    assert.equal(timeline.dataset.layout, 'wrapped', 'expected the wrapped layout at 334px');
    assert.ok(rows.length >= RUNS.length, 'runs split across rows should produce at least one chip each');

    assert.deepEqual(
      rows.filter((r) => r.hasText && r.contrast < 1.05).map((r) => `${r.text} @ ${r.color}`),
      [],
      'a chip on the phone has a text node the user cannot see',
    );
    assert.deepEqual(
      rows.filter((r) => r.hasText && r.fitsDensity === 'tick').map((r) => r.text),
      [],
      'a chip on the phone has text in a box too small for any size',
    );
    assert.deepEqual(
      rows.filter((r) => r.hasText && !r.fitsAtDeclaredSize).map((r) => `${r.text}: ${r.widthPx}px box, font ${r.fontPx}px`),
      [],
      'a chip on the phone is wider than its box at the font size it declares',
    );
    // Nameless ticks are legitimate on a phone, but they must stay a minority.
    const named = rows.filter((r) => r.hasText).length;
    assert.ok(
      named >= rows.length * 0.75,
      `only ${named}/${rows.length} chips on the phone carry a name`,
    );
    await dom.unmountAll();
  });
});

test('every label the geometry gates measured was pinned (no silent fallback)', () => {
  // makeCanvasMeasurer swallows an unusable width and returns the headless
  // table's instead, by design. Without this, a gate fed a label outside
  // CHROMIUM_CANVAS_16PX would run on the estimate and look identical to green.
  assert.deepEqual([...UNPINNED_LABELS], [], 'a gate measured a label with no pinned Chromium canvas width');
  // And none was measured at a font the pins cannot serve (the wrong size
  // string, weight or family): that too falls back to the table silently.
  assert.deepEqual([...BAD_FONTS], [], 'a gate measured with a font the pinned context could not serve');
});
