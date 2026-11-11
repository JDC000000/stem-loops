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
  chipBox,
  chipDensity,
  clampPxPerSec,
  durationSec,
  estimateLabelPx,
  displayText,
  fitPxPerSec,
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

// The container widths the job page actually gives the overlay. JobView caps at
// maxWidth 960 with 16px gutters, so 1280 and 1440 are the same container; 768
// is gutter-limited. Both verified in Chromium (904px and 712px).
const DESKTOP_WIDTHS = [
  { viewport: 768, containerPx: 712 },
  { viewport: 1280, containerPx: 904 },
  { viewport: 1440, containerPx: 904 },
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
  assert.equal(densePps, 80); // MAX_PX_PER_SEC, imported transitively via the helper
});

// ---------------------------------------------------------------------------
// 2. The render gate: nothing counted may be invisible
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
    const pageBg = parseColor('#0b0d12');
    const rows = chips.map((chip) => {
      const cs = w.getComputedStyle(chip);
      const fg = parseColor(cs.color) ?? { r: 255, g: 255, b: 255, a: 1 };
      const bg = parseColor(cs.backgroundColor) ?? parseColor(cs.background) ?? pageBg;
      return {
        density: chip.dataset.density,
        text: chip.textContent,
        hasText: chip.textContent.length > 0,
        color: cs.color,
        contrast: contrast(fg, bg),
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
    const { rows } = await mountOverlay(dom, { containerPx: 904 });

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
    await dom.unmountAll();
  });
});

test('at ANY zoom a chip either shows a readable label or carries no text at all', async () => {
  // The invariant the `color: transparent` branch broke. Driving the zoom
  // slider to 0 reproduces the old default exactly, so this covers the state
  // the user used to land in as well as the one they land in now.
  await withDom(async (dom) => {
    const { rows } = await mountOverlay(dom, {
      containerPx: 904,
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
      containerPx: 904,
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
