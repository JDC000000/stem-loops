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
        assert.equal(next.style.fontSize, n === 1 ? `${next.dataset.growPx}px` : '32px', `Next size with ${n} beats left`);
        if (n === 1) grownTo.push(Number(next.dataset.growPx));
        seen++;
      }
      assert.ok(seen > 300, `checked ${seen} positions`);
      // 64px whenever Now is tall enough to hold it (most of the song); a long,
      // smaller Now caps it so the bars below never move.
      assert.ok(grownTo.length > 20 && grownTo.every((p) => p >= 32 && p <= 64), `Next on the last beat: ${grownTo}`);
      assert.ok(grownTo.filter((p) => p === 64).length >= grownTo.length * 0.75, `Next reached 64px on most last beats: ${grownTo}`);
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

test('D6: Simple on Lucky Ticket draws 109 chords in the chart where Detailed draws all 201', async () => {
  await withDom(async (dom) => {
    for (const [simplify, want] of [[false, 201], [true, 109]]) {
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
