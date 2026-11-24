// Phase A (2026-11-21), the chord stage, on the REAL <ChordOverlay /> in happy-dom:
//   J4  the dead "Change chord" editor is hidden: with no edit handler, no
//       chord cell or chip is a button and nothing opens a picker; with one,
//       cells open it only while PAUSED (never under a strumming hand).
//   J5  the countdown under Now: "N beats" (20px) and four segments, in EVERY
//       mode with a beat grid (the dense demo's plain-list mode included); a
//       time bar with no grid; discrete steps under reduced motion; Next grows
//       32 -> 64px on the last beat.
//   D6  Simple chords on the demo data: 201 -> 109 chips in the chart.
// happy-dom has no layout: the stage's size is injected through
// getBoundingClientRect (what the component's ResizeObserver effect reads).
// The real-Chromium gates (packages/web-browser-gate) check geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withDom } from './helpers/dom.mjs';
import { loadChordOverlay } from './helpers/load-chord-overlay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LUCKY = JSON.parse(readFileSync(join(HERE, 'fixtures/demo-chords/lucky-ticket.json'), 'utf8'));
const PAYLOAD = { key: null, provider: 'klangio', provider_version: 'fixture', duration_sec: LUCKY.duration_sec, model_ms: 1, segments: LUCKY.segments.map((s) => ({ ...s, confidence: 1 })) };
const BEAT = 60 / LUCKY.bpm;
const GRID = { beatSec: BEAT, anchorSec: LUCKY.sections[0].start_sec, measured: true };
const SECTIONS = LUCKY.sections.map((s) => ({ startSec: s.start_sec, endSec: s.end_sec, label: s.label }));

async function mount(dom, props, { w = 358, h = 520, reduce = false } = {}) {
  const React = (await import('react')).default;
  const { ChordOverlay } = await loadChordOverlay();
  const win = dom.window;
  const proto = Object.getOwnPropertyDescriptor(win.HTMLElement.prototype, 'getBoundingClientRect') ? win.HTMLElement.prototype : win.Element.prototype;
  const realDesc = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect');
  const realRect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function patched() {
    const v = this.dataset?.view;
    const tid = this.dataset?.testid;
    if ((tid === 'chord-overlay' && v === 'stage') || tid === 'chord-timeline') {
      const box = { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h };
      return { ...box, toJSON: () => box };
    }
    return realRect.call(this);
  };
  const realMM = win.matchMedia;
  win.matchMedia = (q) => ({ matches: reduce && /reduced-motion/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
  const hadFetch = Object.prototype.hasOwnProperty.call(globalThis, 'fetch');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).includes('/play-chords')
      ? { ok: true, status: 200, json: async () => ({ signed_url: '/signed', expires_in_sec: 60 }) }
      : { ok: true, status: 200, json: async () => props.payload ?? PAYLOAD };
  const restore = () => {
    if (realDesc) Object.defineProperty(proto, 'getBoundingClientRect', realDesc);
    else delete proto.getBoundingClientRect;
    win.matchMedia = realMM;
    if (hadFetch) globalThis.fetch = realFetch;
    else delete globalThis.fetch;
  };
  const el = (p) => React.createElement(ChordOverlay, { jobId: 'demo', view: 'stage', beatGrid: GRID, sections: SECTIONS, ...p });
  let host;
  try {
    host = await dom.mount(el(props));
    await dom.act();
    await dom.act();
  } catch (e) {
    restore();
    throw e;
  }
  return { restore, rerender: async (p) => { await dom.rerender(host, el({ ...props, ...p })); await dom.act(); } };
}

const stageButtons = (dom) => dom.findAll('[data-testid="phone-chords"] button');
const slots = (dom) => dom.findAll('[data-testid^="phone-slot-"]');

test('J4: no edit handler -> chord cells are not buttons, carry no "edit", and a tap opens nothing (playing or paused)', async () => {
  await withDom(async (dom) => {
    for (const playing of [true, false]) {
      const m = await mount(dom, { positionSec: 30, playing });
      try {
        assert.ok(slots(dom).length > 0, 'cells rendered');
        assert.equal(stageButtons(dom).length, 0, `no buttons on the stage (playing=${playing})`);
        for (const s of slots(dom)) {
          assert.equal(s.getAttribute('role'), 'img');
          assert.doesNotMatch(s.getAttribute('aria-label'), /edit/);
        }
        await dom.act(() => slots(dom)[0].click());
        assert.equal(dom.find('[data-testid="chord-popover"]'), null, 'no picker');
      } finally {
        m.restore();
        await dom.unmountAll();
      }
    }
  });
});

test('J4: with an edit handler, cells open the editor only while paused', async () => {
  await withDom(async (dom) => {
    const onChordLabelEdit = () => {};
    const m = await mount(dom, { positionSec: 30, playing: true, onChordLabelEdit });
    try {
      assert.equal(stageButtons(dom).length, 0, 'playing: nothing to hit by accident');
      await m.rerender({ playing: false });
      assert.ok(stageButtons(dom).length > 0, 'paused: the cells are buttons');
      await dom.act(() => stageButtons(dom)[0].click());
      assert.ok(dom.find('[data-testid="chord-popover"]'), 'paused: the editor opens');
    } finally {
      m.restore();
      await dom.unmountAll();
    }
  });
});

test('J5: the countdown is always there on the dense demo (plain-list mode too): "N beats" at 20px and 4 segments', async () => {
  await withDom(async (dom) => {
    // Detailed: the raw 201 chords, too dense for bars (the review's case).
    const m = await mount(dom, { positionSec: 30, playing: true, simplify: false });
    try {
      const mode = dom.find('[data-testid="phone-chords"]').dataset.mode;
      assert.equal(mode, 'sequence', 'the raw demo is the plain list');
      let seen = 0;
      const grownTo = [];
      for (let t = 20; t < 200; t += 0.37) {
        await m.rerender({ positionSec: t });
        const cd = dom.find('[data-testid="phone-countdown"]');
        if (!dom.find('[data-testid="phone-next"]')) continue;
        assert.ok(cd, `countdown at ${t.toFixed(2)}`);
        assert.equal(cd.dataset.kind, 'beats');
        const n = Number(cd.dataset.beatsLeft);
        assert.ok(n >= 1, `beats left ${n}`);
        const text = dom.find('[data-testid="phone-countdown-text"]');
        assert.equal(text.textContent, `${n} beat${n === 1 ? '' : 's'}`);
        assert.equal(text.style.fontSize, '20px');
        const segs = dom.findAll('[data-testid="phone-countdown-seg"]');
        assert.equal(segs.length, 4);
        const lit = segs.filter((s) => s.dataset.on === 'true').length;
        assert.equal(lit, n <= 4 ? 5 - n : 0, `lit segments for ${n} beats`);
        const next = dom.find('[data-testid="phone-next-name"]');
        assert.equal(next.style.fontSize, n === 1 ? `${next.dataset.growPx}px` : '44px', `Next size with ${n} beats left`);
        if (n === 1) grownTo.push(Number(next.dataset.growPx));
        seen++;
      }
      assert.ok(seen > 300, `checked ${seen} positions`);
      // 64px whenever Now is tall enough to hold it (most of the song); a long,
      // smaller Now caps it so the bars below never move.
      assert.ok(grownTo.length > 20 && grownTo.every((p) => p >= 44 && p <= 64), `Next on the last beat: ${grownTo}`);
      assert.ok(grownTo.filter((p) => p > 44).length >= grownTo.length * 0.75, `Next grew on most last beats: ${grownTo}`);
      // Review of #333 (H-1): no amber in the countdown, no beat dots beside it.
      assert.equal(dom.find('[data-testid="phone-beats"]'), null);
    } finally {
      m.restore();
      await dom.unmountAll();
    }
  });
});

test('J5: no beat grid -> a time bar to the change and "x.x s"; reduced motion -> 4 discrete segments, no transition', async () => {
  await withDom(async (dom) => {
    const m = await mount(dom, { positionSec: 30.2, playing: true, beatGrid: null });
    try {
      const cd = dom.find('[data-testid="phone-countdown"]');
      assert.equal(cd.dataset.kind, 'time');
      assert.equal(cd.dataset.continuous, 'true');
      assert.ok(dom.find('[data-testid="phone-countdown-track"]'));
      assert.match(dom.find('[data-testid="phone-countdown-text"]').textContent, /^\d+(\.\d)? s$/);
      assert.match(dom.find('[data-testid="phone-next-name"]').style.transition, /font-size/);
    } finally {
      m.restore();
      await dom.unmountAll();
    }
    const r = await mount(dom, { positionSec: 30.2, playing: true, beatGrid: null }, { reduce: true });
    try {
      const cd = dom.find('[data-testid="phone-countdown"]');
      assert.equal(cd.dataset.continuous, undefined);
      assert.equal(dom.findAll('[data-testid="phone-countdown-seg"]').length, 4);
      assert.equal(dom.find('[data-testid="phone-next-name"]').style.transition, 'none');
    } finally {
      r.restore();
      await dom.unmountAll();
    }
  });
});

test('the duplicate "Now" label is gone: the stage names no "Now" above the chord', async () => {
  await withDom(async (dom) => {
    const m = await mount(dom, { positionSec: 30, playing: true });
    try {
      const now = dom.find('[data-testid="playhead-now"]');
      assert.ok(now);
      assert.doesNotMatch(now.textContent, /^Now/);
      assert.equal(now.children.length, 1, 'only the chord name');
    } finally {
      m.restore();
      await dom.unmountAll();
    }
  });
});

test('D6: Simple on Lucky Ticket draws 87 chords in the chart where Detailed draws all 201', async () => {
  await withDom(async (dom) => {
    for (const [simplify, want] of [[false, 201], [true, 87]]) {
      const m = await mount(dom, { view: 'chart', positionSec: null, simplify }, { w: 1200, h: 400 });
      try {
        const prim = dom.findAll('[data-testid^="chord-chip-"]').filter((c) => /^chord-chip-\d+$/.test(c.dataset.testid));
        assert.equal(prim.length, want, `simplify=${simplify}`);
        // No editor handler: chips are pictures of chords, not buttons.
        assert.ok(prim.every((c) => c.tagName === 'SPAN' && c.getAttribute('role') === 'img'));
      } finally {
        m.restore();
        await dom.unmountAll();
      }
    }
  });
});


test('C4: Capo / transpose on the REAL overlay: stage chip, Now / Next and the aria-label show the shifted name; the chart too', async () => {
  const seg = (a, b, label) => ({ start_sec: a, end_sec: b, label, confidence: 1 });
  const payload = { ...PAYLOAD, duration_sec: 40, segments: [seg(0, 8, 'A:min7'), seg(8, 16, 'D:maj/3'), seg(16, 24, 'E:min7'), seg(24, 32, 'A:maj'), seg(32, 40, 'D:maj')] };
  await withDom(async (dom) => {
    const texts = (sel) => dom.findAll(sel).map((e) => e.textContent);
    // Detailed (simplify false) so the names are exactly the payload's.
    const m = await mount(dom, { payload, positionSec: 10, playing: true, simplify: false, transpose: -2, musicalKey: 'A major' });
    try {
      // Capo 2 in A major: D/F# shows as C/E, the next E:min7 as Dm7 (2 semitones DOWN)
      assert.equal(dom.find('[data-testid="playhead-now-name"]').textContent, 'C/E');
      assert.equal(dom.find('[data-testid="phone-next-name"]').textContent, 'Dm7');
      assert.match(dom.find('[data-testid="phone-now-spoken"]').textContent, /^Now C over E\. .*D minor 7\./);
      const slotTexts = texts('[data-testid^="phone-slot-"]').join('|');
      assert.match(slotTexts, /Dm7/);
      assert.doesNotMatch(slotTexts, /Em7/, 'the stored E:min7 is not shown');
      assert.ok(dom.findAll('[aria-label]').every((e) => !/D major over F/.test(e.getAttribute('aria-label'))), 'no stale name in an aria-label');
      // the key decides the spelling: in F major the same Capo 2 spells flats
      await m.rerender({ transpose: 3, musicalKey: 'F major' });
      assert.equal(dom.find('[data-testid="playhead-now-name"]').textContent, 'F/A');
      // D/F# up 3 = F/A (key F major +3 = Ab major)
      // the key picks the accidental: Am7 up 1 in E major (new key F major) is B-flat, not A-sharp
      await m.rerender({ positionSec: 4, transpose: 1, musicalKey: 'E major' });
      assert.equal(dom.find('[data-testid="playhead-now-name"]').textContent, 'B\u266Dm7');
      await m.rerender({ positionSec: 10 });
      // Capo off: the stored names again
      await m.rerender({ transpose: 0 });
      assert.equal(dom.find('[data-testid="playhead-now-name"]').textContent, 'D/F\u266F');
      assert.equal(dom.find('[data-testid="phone-next-name"]').textContent, 'Em7');
      // Simple stays on when transposed (the chart draws the merged run set)
      await m.rerender({ transpose: -2, simplify: true });
      assert.equal(dom.find('[data-testid="playhead-now-name"]').textContent, 'C/E');
    } finally {
      m.restore();
      await dom.unmountAll();
    }
    // the "See all chords" chart
    const c = await mount(dom, { payload, view: 'chart', positionSec: null, simplify: false, transpose: -2, musicalKey: 'A major' }, { w: 1200, h: 400 });
    try {
      const chips = dom.findAll('[data-testid^="chord-chip-"]').filter((x) => /^chord-chip-\d+$/.test(x.dataset.testid));
      const label = (x) => x.getAttribute('aria-label') ?? '';
      const joined = chips.map((x) => `${x.textContent}~${label(x)}`).join('|');
      assert.match(joined, /Gm7/);
      assert.match(joined, /C\/E/);
      assert.doesNotMatch(joined, /Am7/);
    } finally {
      c.restore();
      await dom.unmountAll();
    }
  });
});

test('C4: Simple stays on when a capo is set: Lucky Ticket draws 87 chips in the chart at Capo 2, with shifted names', async () => {
  await withDom(async (dom) => {
    const chipsOf = () => dom.findAll('[data-testid^="chord-chip-"]').filter((c) => /^chord-chip-\d+$/.test(c.dataset.testid));
    const m0 = await mount(dom, { view: 'chart', positionSec: null, simplify: true, transpose: 0 }, { w: 1200, h: 400 });
    let plain;
    try {
      plain = chipsOf().map((c) => c.textContent);
      assert.equal(plain.length, 87);
    } finally {
      m0.restore();
      await dom.unmountAll();
    }
    const m = await mount(dom, { view: 'chart', positionSec: null, simplify: true, transpose: -2, musicalKey: 'A major' }, { w: 1200, h: 400 });
    try {
      const shifted = chipsOf().map((c) => c.textContent);
      assert.equal(shifted.length, 87, 'Simple (87), not Detailed (201), when transposed');
      assert.notDeepEqual(shifted, plain, 'the names moved');
      assert.ok(shifted.some((t) => /^G/.test(t)) && plain.some((t) => /^A/.test(t)), 'A shapes show as G');
    } finally {
      m.restore();
      await dom.unmountAll();
    }
  });
});

test('review #333: Simple (bars) hides the beat dots beside the countdown; Next grows only into the width Now leaves', async () => {
  await withDom(async (dom) => {
    const m = await mount(dom, { positionSec: 30, playing: true, simplify: true });
    try {
      assert.equal(dom.find('[data-testid="phone-chords"]').dataset.mode, 'bars');
      let checked = 0;
      for (let t = 20; t < 120; t += 0.37) {
        await m.rerender({ positionSec: t });
        if (!dom.find('[data-testid="phone-countdown"]')) continue;
        assert.equal(dom.find('[data-testid="phone-beats"]'), null, `beat dots beside the countdown at ${t.toFixed(2)}`);
        checked++;
      }
      assert.ok(checked > 200);
    } finally {
      m.restore();
      await dom.unmountAll();
    }
    // A narrow stage: Now (sized first) leaves less width, so Next grows less than 64 on some last beats.
    const n = await mount(dom, { positionSec: 30, playing: true, simplify: false }, { w: 250, h: 520 });
    try {
      const grown = [];
      for (let t = 20; t < 200; t += 0.37) {
        await n.rerender({ positionSec: t });
        const next = dom.find('[data-testid="phone-next-name"]');
        if (next?.dataset.grown === 'true') grown.push(Number(next.dataset.growPx));
      }
      assert.ok(grown.length > 20, `${grown.length} last beats`);
      assert.ok(grown.some((p) => p < 64), `Next grew to 64 on every last beat at 250px: ${grown}`);
      assert.ok(grown.every((p) => p >= 44));
    } finally {
      n.restore();
      await dom.unmountAll();
    }
  });
});
