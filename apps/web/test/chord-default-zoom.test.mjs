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
  CHIP_FONT_PX,
  CHIP_FULL_PAD_PX,
  MAX_PX_PER_SEC,
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

/** Exactly what ChordOverlay does for the strip: the default px/sec it lands on. */
function defaultStripPps(containerPx) {
  const fit = fitPxPerSec(DUR, containerPx);
  return clampPxPerSec(readablePxPerSec(RUNS, estimateLabelPx), fit);
}

/** Density of every chip at a given zoom, exactly as renderChip derives it. */
function densitiesAt(pps) {
  return RUNS.map((run) => {
    const w = Math.max(1, chipBox(run, pps).widthPx - 1);
    return chipDensity(w, estimateLabelPx(displayText(run), CHIP_FONT_PX));
  });
}

// ---------------------------------------------------------------------------
// 1. The default zoom is derived from the data, not from a constant
// ---------------------------------------------------------------------------

test('the headless label measurer agrees with Chromium', () => {
  // Pinned against real measurements on the job page's own font stack
  // (ui-sans-serif/system-ui, weight 400, 16px, tabular-nums), Chromium
  // 1280x900. If this drifts, every width below is measuring the wrong thing.
  const CHROMIUM_16PX = {
    'C:maj': 42.859,
    'G:7': 26.609,
    'F#:min7': 61.594,
    'C#:minmaj7': 90.719,
    'Ab:maj7/3': 78.531,
    'N.C.': 32.344,
    '?': 8.188,
  };
  for (const [label, real] of Object.entries(CHROMIUM_16PX)) {
    const got = estimateLabelPx(label, CHIP_FONT_PX);
    assert.ok(
      Math.abs(got - real) <= 0.5,
      `${label}: estimate ${got.toFixed(3)}px vs Chromium ${real}px`,
    );
  }
  // And it scales linearly with font size, which is how the `tight` branch is judged.
  assert.ok(Math.abs(estimateLabelPx('F#:min7', 10) - 61.594 * 0.625) < 0.01);
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
  // The derivation, recomputed here from the same inputs the helper uses.
  const widest = Math.max(...RUNS.map((r) => estimateLabelPx(displayText(r), CHIP_FONT_PX)));
  const durs = RUNS.map((r) => r.endSec - r.startSec).filter((d) => d > 0).sort((a, b) => a - b);
  const medianDur = durs[Math.floor(durs.length / 2)];
  const expected = (widest + CHIP_FULL_PAD_PX + 1) / medianDur;

  assert.ok(Math.abs(readablePxPerSec(RUNS, estimateLabelPx) - expected) < 1e-9);

  // It really does depend on the data: widen the names and the zoom follows.
  const longerNames = RUNS.map((r) => ({ ...r, label: 'C#:minmaj7', kind: 'chord' }));
  assert.ok(
    readablePxPerSec(longerNames, estimateLabelPx) > readablePxPerSec(RUNS, estimateLabelPx),
    'a job whose chord names are longer must default to a wider zoom',
  );
});

test('at the default zoom the chips can show their names at every desktop width', () => {
  for (const { viewport, containerPx } of DESKTOP_WIDTHS) {
    const pps = defaultStripPps(containerPx);
    const d = densitiesAt(pps);
    const ticks = d.filter((x) => x === 'tick').length;
    const widths = RUNS.map((r) => chipBox(r, pps).widthPx).sort((a, b) => a - b);
    const median = widths[Math.floor(widths.length / 2)];

    assert.ok(
      ticks <= 1,
      `@${viewport}: ${ticks}/${RUNS.length} chips still cannot show a label at ${pps.toFixed(2)}px/sec`,
    );
    // The median chip must carry its name at FULL size, not at the 10px fallback.
    assert.ok(
      median >= Math.max(...RUNS.map((r) => estimateLabelPx(displayText(r), CHIP_FONT_PX))) + CHIP_FULL_PAD_PX,
      `@${viewport}: median chip is ${median.toFixed(1)}px, too narrow for the longest name`,
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
  assert.ok(readablePxPerSec(sparse, estimateLabelPx) < fit);
  assert.equal(clampPxPerSec(readablePxPerSec(sparse, estimateLabelPx), fit), fit);

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
  const densePps = readablePxPerSec(dense, estimateLabelPx);
  assert.ok(Number.isFinite(densePps));
  // The imported constant, not a literal that merely happens to equal it today.
  assert.equal(densePps, MAX_PX_PER_SEC);
  assert.ok(readablePxPerSec(dense, estimateLabelPx, MAX_PX_PER_SEC) <= MAX_PX_PER_SEC);
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
    return chipDensity(w, estimateLabelPx(displayText(run), CHIP_FONT_PX)) !== 'full';
  }).length;
  assert.ok(clipped > RUNS.length * 0.9, `${clipped}/${RUNS.length} chips clipped at the bad zoom`);
});

// ---------------------------------------------------------------------------
// 3. The render gate: nothing counted may be invisible
// ---------------------------------------------------------------------------

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
 * Mount the real component at a given container width and read every chip in
 * the timeline container. happy-dom has no layout, so the container width is
 * injected the only way the component can take one: through the element's own
 * getBoundingClientRect, which is what its ResizeObserver effect reads.
 */
async function mountOverlay(dom, { containerPx, afterMount } = {}) {
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
    return { ok: true, status: 200, json: async () => PAYLOAD };
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
    // chain for an inherited background, because happy-dom resolves no cascade
    // and the overlay's own ancestors declare none. `parseColor('transparent')`
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
      const labelPx = estimateLabelPx(text, CHIP_FONT_PX);
      return {
        density: chip.dataset.density,
        text,
        hasText: text.length > 0,
        color: cs.color,
        opacity: o,
        widthPx: declaredW,
        fitsDensity: text.length === 0 ? null : chipDensity(declaredW, labelPx),
        contrast: contrast(fgPainted, bgPainted),
      };
    });
    return { timeline, chips, rows };
  } finally {
    if (realDesc) Object.defineProperty(proto, 'getBoundingClientRect', realDesc);
    else delete proto.getBoundingClientRect;
    if (hadFetch) globalThis.fetch = realFetch;
    else delete globalThis.fetch;
  }
}

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
        await d.act(() => {
          slider.value = '0';
          slider.dispatchEvent(new d.window.Event('input', { bubbles: true }));
        });
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
        await d.act(() => {
          slider.value = '0';
          slider.dispatchEvent(new d.window.Event('input', { bubbles: true }));
        });
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
    return chipDensity(w, estimateLabelPx(displayText(run), CHIP_FONT_PX)) === 'tick';
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
    // Nameless ticks are legitimate on a phone, but they must stay a minority.
    const named = rows.filter((r) => r.hasText).length;
    assert.ok(
      named >= rows.length * 0.75,
      `only ${named}/${rows.length} chips on the phone carry a name`,
    );
    await dom.unmountAll();
  });
});
