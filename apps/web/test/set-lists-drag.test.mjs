// Set lists, B2 follow-up: drag to reorder inside a list (SetListView).
//
// The index math (reorderItem, dropIndex in src/lib/set-lists.ts) is pure and tested here in
// full. The wiring is tested on the REAL SetListView in happy-dom: pointer events with real
// capture state; row geometry is injected with dom.stubRect (no layout engine, so the numbers
// are ours). On drop the component sends the SAME request the Move buttons send: one PUT of the
// whole order to /api/set-lists/:id/songs. Reduced motion: the row does not follow the pointer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTOSCROLL_ARM_PX,
  EDGE_MAX_SPEED_PX_PER_S,
  EDGE_ZONE_PX,
  MAX_FRAME_DT_MS,
  NOMINAL_FRAME_MS,
  REDUCED_JUMP_INTERVAL_MS,
  REDUCED_JUMP_PX,
  autoScrollArmed,
  autoScrollStep,
  dragDelta,
  dropIndex,
  edgeScrollSpeed,
  frameDt,
  moveItem,
  parsePx,
  reorderItem,
  splitWholePx,
} from '../src/lib/set-lists.ts';
import { buildModuleGraph } from './helpers/module-graph.mjs';
import { withDom } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- index math ---------------------------------------------------------------------------

test('reorderItem: takes the item out and puts it back at the target, others keep their order', () => {
  const abcd = ['a', 'b', 'c', 'd'];
  assert.deepEqual(reorderItem(abcd, 0, 3), ['b', 'c', 'd', 'a']);
  assert.deepEqual(reorderItem(abcd, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(reorderItem(abcd, 1, 2), ['a', 'c', 'b', 'd']);
  assert.deepEqual(reorderItem(abcd, 2, 1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(reorderItem(abcd, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(abcd, ['a', 'b', 'c', 'd'], 'the input is not changed');
});

test('reorderItem: same index or out of range gives the same order, as a copy', () => {
  const abc = ['a', 'b', 'c'];
  for (const [f, t] of [[1, 1], [-1, 0], [0, -1], [3, 0], [0, 3], [0.5, 1], [NaN, 1]]) {
    const out = reorderItem(abc, f, t);
    assert.deepEqual(out, abc, `${f}->${t}`);
    assert.notEqual(out, abc, 'a copy, not the same array');
  }
  assert.deepEqual(reorderItem([], 0, 0), []);
});

test('reorderItem to a neighbour is the same as a Move up / Move down', () => {
  const xs = ['a', 'b', 'c', 'd', 'e'];
  for (let i = 0; i < xs.length; i += 1) {
    if (i > 0) assert.deepEqual(reorderItem(xs, i, i - 1), moveItem(xs, i, -1));
    if (i < xs.length - 1) assert.deepEqual(reorderItem(xs, i, i + 1), moveItem(xs, i, 1));
  }
});

test('dropIndex: a row moves one place once its centre passes a neighbour’s centre', () => {
  const mids = [25, 85, 145, 205]; // 60px rows
  assert.equal(dropIndex(mids, 0, 25), 0, 'no movement: stays');
  assert.equal(dropIndex(mids, 0, 85), 0, 'exactly on the neighbour: not passed yet');
  assert.equal(dropIndex(mids, 0, 86), 1);
  assert.equal(dropIndex(mids, 0, 146), 2);
  assert.equal(dropIndex(mids, 0, 9999), 3, 'past the end: last');
  assert.equal(dropIndex(mids, 3, 205), 3);
  assert.equal(dropIndex(mids, 3, 145), 2, 'exactly on the neighbour above: passed');
  assert.equal(dropIndex(mids, 3, 146), 3);
  assert.equal(dropIndex(mids, 3, -9999), 0, 'past the top: first');
  assert.equal(dropIndex(mids, 2, 30), 1);
  assert.equal(dropIndex(mids, 1, 150), 2);
});

test('dropIndex: always within 0..n-1, and 0 for an empty list', () => {
  assert.equal(dropIndex([], 0, 100), 0);
  assert.equal(dropIndex([10], 0, 1e9), 0);
  const mids = [10, 20, 30];
  for (let y = -50; y <= 80; y += 1) {
    for (let from = 0; from < 3; from += 1) {
      const to = dropIndex(mids, from, y);
      assert.ok(to >= 0 && to <= 2, `${from}@${y} -> ${to}`);
    }
  }
});

// ---- the real component -------------------------------------------------------------------

const graph = buildModuleGraph({ name: 'set-lists-drag', entries: ['components/setlists/SetListView.tsx'] });
const React = (await import('react')).default;
const { SetListView } = await import(graph.url('components/setlists/SetListView.tsx'));

const LIST = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
const items = () => [
  { item_id: 'a0000000-0000-4000-8000-000000000001', position: 0, source: 'link', title: 'Wonderwall', state: 'ready', job_id: 'j1' },
  { item_id: 'a0000000-0000-4000-8000-000000000002', position: 1, source: 'link', title: 'Creep', state: 'expired', job_id: null },
  { item_id: 'a0000000-0000-4000-8000-000000000003', position: 2, source: 'upload', title: 'my-take.wav', state: 'ready', job_id: 'j3' },
];
const ids = items().map((it) => it.item_id);

function stubFetch(handler) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'fetch');
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    const [status, body] = handler(String(url), init);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, restore: () => { if (had) globalThis.fetch = real; else delete globalThis.fetch; } };
}

/** Mount a 3-song list and lay its rows out 60px apart (row i: top 100 + 60i, height 52). */
async function mountList(dom) {
  await dom.mount(React.createElement(SetListView, { id: LIST }));
  await dom.act();
  const rows = () => dom.findAll('[data-testid="set-item"]');
  rows().forEach((r, i) => dom.stubRect(r, { top: 100 + 60 * i, height: 52, left: 0, width: 360 }));
  return { rows, handle: (i) => rows()[i].querySelector('[data-testid="set-drag"]') };
}
const okList = (url, init) => (init.method === 'PUT' ? [200, { ok: true }] : [200, { list: { id: LIST, name: 'JAMS', is_demo: false, items: items() } }]);
const order = () => [...globalThis.document.querySelectorAll('[data-testid="set-item"]')].map((r) => r.dataset.item);

test('drag the first song below the last: ONE PUT of the whole new order, the same request Move sends', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    try {
      const { handle } = await mountList(dom);
      const h = handle(0);
      assert.ok(h, 'an editable list has a drag handle on each row');
      assert.equal(h.getAttribute('aria-hidden'), 'true', 'pointer-only: the Move buttons are the keyboard path');
      assert.equal(h.textContent, '', 'the grip is CSS, the row text is the song alone');
      assert.equal(h.dataset.pos, '1', 'the handle carries the row number');
      // Centre of row 0 is 126; row 2's centre is 246. Drag 130px down: centre 256 > 246.
      await dom.drag(h, [[20, 126], [20, 160], [20, 200], [20, 256]], { pointerId: 7 });
      await dom.act();
      const puts = f.calls.filter((c) => c.method === 'PUT');
      assert.equal(puts.length, 1, 'one request for the whole drop');
      assert.equal(puts[0].url, `/api/set-lists/${LIST}/songs`);
      assert.deepEqual(puts[0].body, { order: [ids[1], ids[2], ids[0]] });
      assert.deepEqual(order(), [ids[1], ids[2], ids[0]], 'the list shows the new order at once');
      assert.match(dom.find('[data-testid="set-notice"]').textContent, /^Moved Wonderwall to position 3\.$/);
      assert.equal(dom.find('[data-drag="true"]'), null, 'no row is left in the dragging state');
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('mid-drag: the row takes the selected style and follows the pointer; a line marks where it lands', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    try {
      const { rows, handle } = await mountList(dom);
      const h = handle(2);
      await dom.pointer('pointerdown', h, { clientX: 20, clientY: 246 });
      assert.equal(h.hasPointerCapture(1), true, 'the handle captures the pointer');
      await dom.pointer('pointermove', h, { clientX: 20, clientY: 176 }); // centre 176 < 186: it has passed Creep
      assert.equal(rows()[2].dataset.drag, 'true');
      assert.equal(rows()[2].style.transform, 'translateY(-70px)', 'the row follows the pointer');
      assert.equal(rows()[1].dataset.drop, 'before', 'it would land above Creep');
      assert.equal(rows()[0].dataset.drop, undefined);
      await dom.pointer('pointermove', h, { clientX: 20, clientY: 100 }); // past Wonderwall (126)
      assert.equal(rows()[0].dataset.drop, 'before');
      assert.equal(rows()[1].dataset.drop, undefined);
      assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 0, 'nothing is sent mid-drag');
      await dom.pointer('pointerup', h, { clientX: 20, clientY: 100 });
      await dom.act();
      assert.deepEqual(f.calls.find((c) => c.method === 'PUT').body.order, [ids[2], ids[0], ids[1]]);
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('a drag that ends where it started, or is cancelled, sends nothing and changes nothing', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    try {
      const { handle } = await mountList(dom);
      await dom.drag(handle(1), [[20, 186], [20, 200], [20, 190]]); // never passes a neighbour
      await dom.pointer('pointerdown', handle(0), { clientX: 20, clientY: 126 });
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 300 });
      await dom.pointer('pointercancel', handle(0), { clientX: 20, clientY: 300 });
      await dom.act();
      assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 0);
      assert.deepEqual(order(), ids);
      assert.equal(dom.find('[data-drag="true"]'), null);
      assert.equal(dom.find('[data-drop]'), null);
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

for (const [name, end] of [
  ['pointercancel', async (dom, h) => dom.pointer('pointercancel', h, { clientX: 20, clientY: 300 })],
  ['lostpointercapture', async (dom, h) => dom.pointer('lostpointercapture', h, { clientX: 20, clientY: 300 })],
  ['Escape', async (dom) => dom.keydown('Escape')],
]) {
  test(`${name} mid-drag cancels: the row goes back, the line goes, nothing is sent, and the next drag works`, async () => {
    await withDom(async (dom) => {
      const f = stubFetch(okList);
      try {
        const { rows, handle } = await mountList(dom);
        const h = handle(0);
        await dom.pointer('pointerdown', h, { clientX: 20, clientY: 126 });
        await dom.pointer('pointermove', h, { clientX: 20, clientY: 300 });
        assert.equal(rows()[0].dataset.drag, 'true');
        assert.ok(dom.find('[data-drop]'), 'mid-drag there is a landing line');
        await end(dom, h);
        assert.equal(dom.find('[data-drag="true"]'), null, 'no row is left dragging');
        assert.equal(dom.find('[data-drop]'), null, 'no landing line is left');
        assert.equal(rows()[0].style.transform, '', 'the row is back in place');
        assert.equal(h.hasPointerCapture(1), false, 'capture is released');
        // A release after the cancel does not commit.
        await dom.pointer('pointerup', h, { clientX: 20, clientY: 300 });
        await dom.act();
        assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 0, 'nothing was sent');
        assert.deepEqual(order(), ids);
        // The cancel did not leave the view stuck: a new drag works.
        await dom.drag(handle(0), [[20, 126], [20, 200]], { pointerId: 2 });
        await dom.act();
        assert.deepEqual(f.calls.filter((c) => c.method === 'PUT').map((c) => c.body.order), [[ids[1], ids[0], ids[2]]]);
      } finally {
        f.restore();
        await dom.unmountAll();
      }
    });
  });
}

test('a key other than Escape does not cancel a drag', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    try {
      const { handle } = await mountList(dom);
      await dom.pointer('pointerdown', handle(0), { clientX: 20, clientY: 126 });
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 200 });
      await dom.keydown('Enter');
      assert.equal(dom.find('[data-drag="true"]')?.dataset.item, ids[0]);
      await dom.pointer('pointerup', handle(0), { clientX: 20, clientY: 200 });
      await dom.act();
      assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1);
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('a refused drop reloads the list as the server has it and says so', async () => {
  await withDom(async (dom) => {
    const f = stubFetch((url, init) => (init.method === 'PUT' ? [409, { message: 'That list changed. Try again.' }] : okList(url, init)));
    try {
      const { handle } = await mountList(dom);
      await dom.drag(handle(0), [[20, 126], [20, 200]]);
      await dom.act();
      assert.deepEqual(order(), ids, 'back to the server order');
      assert.match(dom.find('[data-testid="set-notice"]').textContent, /That list changed/);
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('reduced motion: the dragged row does not move with the pointer; only the state changes', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    const realMM = globalThis.matchMedia;
    globalThis.matchMedia = (q) => ({ matches: /prefers-reduced-motion: reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
    try {
      const { rows, handle } = await mountList(dom);
      await dom.pointer('pointerdown', handle(0), { clientX: 20, clientY: 126 });
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 200 });
      assert.equal(rows()[0].dataset.drag, 'true', 'still marked as the dragged row');
      assert.equal(rows()[0].style.transform, '', 'no movement');
      assert.equal(rows()[1].dataset.drop, 'after');
      await dom.pointer('pointerup', handle(0), { clientX: 20, clientY: 200 });
      await dom.act();
      assert.deepEqual(order(), [ids[1], ids[0], ids[2]]);
    } finally {
      if (realMM === undefined) delete globalThis.matchMedia;
      else globalThis.matchMedia = realMM;
      f.restore();
      await dom.unmountAll();
    }
  });
  const css = readFileSync(join(WEB, 'src/components/setlists/SetLists.module.css'), 'utf8');
  const reduce = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)[1];
  assert.match(reduce, /\.row\.dragging \{\s*transform: none !important;/);
});

test('the handle is 44px, never scrolls the page on touch, and the dragged row is #222 + 2px #fff', () => {
  const css = readFileSync(join(WEB, 'src/components/setlists/SetLists.module.css'), 'utf8');
  const handle = css.match(/\n\.handle \{([^}]*)\}/)[1];
  assert.match(handle, /width: var\(--touch-min\);/);
  assert.match(handle, /min-height: var\(--touch-min\);/);
  assert.match(handle, /touch-action: none;/);
  const dragging = css.match(/\n\.row\.dragging \{([^}]*)\}/)[1];
  assert.match(dragging, /background: var\(--bg-selected\);/);
  assert.match(dragging, /border-color: var\(--text-primary\);/);
  assert.match(dragging, /box-shadow: 0 0 0 1px var\(--text-primary\);/);
  assert.doesNotMatch(css, /#a3e635|--accent|--chord-now/, 'no lime and no amber on the set-list page');
});

test('the Demo set and a one-song list have no drag handle; Move buttons stay on editable lists', async () => {
  await withDom(async (dom) => {
    const f = stubFetch((url) =>
      url.includes('/demo')
        ? [200, { list: { id: 'demo', name: 'Demo set', is_demo: true, items: items() } }]
        : [200, { list: { id: LIST, name: 'ONE', is_demo: false, items: items().slice(0, 1) } }],
    );
    try {
      await dom.mount(React.createElement(SetListView, { id: 'demo' }));
      await dom.act();
      assert.equal(dom.findAll('[data-testid="set-drag"]').length, 0, 'demo: read-only');
      await dom.unmountAll();
      await dom.mount(React.createElement(SetListView, { id: LIST }));
      await dom.act();
      assert.equal(dom.findAll('[data-testid="set-drag"]').length, 0, 'one song: nothing to reorder');
      assert.equal(dom.findAll('[data-move]').length, 2, 'Move up / Move down are still there');
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

// ---- auto-scroll while dragging (#343) -----------------------------------------------------

test('edgeScrollSpeed: 0 away from the edges; grows with depth into the 48px zone; up at the top, down at the bottom', () => {
  const H = 800;
  assert.equal(EDGE_ZONE_PX, 48);
  for (const y of [48, 100, 400, 752]) assert.equal(edgeScrollSpeed(y, H), 0, `y=${y}`);
  const top = [47, 36, 24, 12, 0].map((y) => edgeScrollSpeed(y, H));
  const bottom = [753, 764, 776, 788, 800].map((y) => edgeScrollSpeed(y, H));
  for (const s of top) assert.ok(s < 0, 'top scrolls up');
  for (const s of bottom) assert.ok(s > 0, 'bottom scrolls down');
  for (let i = 1; i < 5; i += 1) {
    assert.ok(-top[i] >= -top[i - 1], 'deeper at the top is at least as fast');
    assert.ok(bottom[i] >= bottom[i - 1], 'deeper at the bottom is at least as fast');
  }
  assert.ok(-top[2] < EDGE_MAX_SPEED_PX_PER_S && bottom[2] < EDGE_MAX_SPEED_PX_PER_S, 'half way in is slower than the edge');
  assert.equal(edgeScrollSpeed(0, H), -EDGE_MAX_SPEED_PX_PER_S);
  assert.equal(edgeScrollSpeed(-50, H), -EDGE_MAX_SPEED_PX_PER_S, 'past the edge: capped');
  assert.equal(edgeScrollSpeed(H + 50, H), EDGE_MAX_SPEED_PX_PER_S);
  assert.equal(edgeScrollSpeed(NaN, H), 0);
  assert.equal(edgeScrollSpeed(10, 0), 0, 'no viewport: no scroll');
});

test('autoScrollStep: full motion is the edge speed; reduced motion jumps a fixed step, at most once per interval', () => {
  const H = 800;
  assert.equal(
    autoScrollStep({ clientY: 790, viewportH: H, reduced: false, now: 0, lastJumpAt: null }),
    (edgeScrollSpeed(790, H) * NOMINAL_FRAME_MS) / 1000,
    'first frame: the edge speed over one nominal 60Hz frame',
  );
  assert.equal(autoScrollStep({ clientY: 400, viewportH: H, reduced: true, now: 0, lastJumpAt: null }), 0, 'not at an edge: nothing');
  assert.equal(autoScrollStep({ clientY: 790, viewportH: H, reduced: true, now: 1000, lastJumpAt: null }), REDUCED_JUMP_PX);
  assert.equal(autoScrollStep({ clientY: 760, viewportH: H, reduced: true, now: 1000, lastJumpAt: null }), REDUCED_JUMP_PX, 'fixed: not by depth');
  assert.equal(autoScrollStep({ clientY: 5, viewportH: H, reduced: true, now: 1000, lastJumpAt: null }), -REDUCED_JUMP_PX);
  assert.equal(autoScrollStep({ clientY: 790, viewportH: H, reduced: true, now: 1000 + REDUCED_JUMP_INTERVAL_MS - 1, lastJumpAt: 1000 }), 0, 'too soon');
  assert.equal(autoScrollStep({ clientY: 790, viewportH: H, reduced: true, now: 1000 + REDUCED_JUMP_INTERVAL_MS, lastJumpAt: 1000 }), REDUCED_JUMP_PX);
});

test('dragDelta: pointer movement plus page scroll since the drag began', () => {
  assert.equal(dragDelta(300, 200, 0, 0), 100);
  assert.equal(dragDelta(200, 200, 150, 0), 150, 'page scrolled 150 with the pointer still: the row moves 150 down the list');
  assert.equal(dragDelta(250, 200, 40, 100), -10, 'scrolled back up 60, pointer down 50');
});

/** Make the page scrollable in happy-dom: a viewport of `h` px and a scrollBy that moves scrollY. */
function stubViewport(window, h) {
  let y = 0;
  const calls = [];
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => h });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
  window.scrollBy = (opts) => {
    calls.push(opts.top);
    y = Math.max(0, y + opts.top);
  };
  return { calls, setY: (v) => { y = v; } };
}

test('auto-scroll: holding at the bottom edge scrolls the page each frame; the row keeps up; the drop saves where the line is', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    try {
      const vp = stubViewport(dom.window, 300);
      const { rows, handle } = await mountList(dom);
      await dom.pointer('pointerdown', handle(0), { clientX: 20, clientY: 126 });
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 296 }); // 4px from the bottom
      assert.equal(rows()[0].style.transform, 'translateY(170px)');
      await dom.nextFrame();
      await dom.advance(20); // a real frame gap: the speed is per second, not per frame
      await dom.nextFrame();
      assert.equal(vp.calls.length, 2, 'one scroll per frame');
      assert.ok(vp.calls.every((t) => t > 0 && Number.isInteger(t)), 'scrolls down, in whole pixels');
      const scrolled = vp.calls.reduce((a, b) => a + b, 0);
      assert.equal(rows()[0].style.transform, `translateY(${170 + scrolled}px)`, 'the row moves with the scroll');
      await dom.pointer('pointerup', handle(0), { clientX: 20, clientY: 296 });
      await dom.act();
      assert.equal(dom.pendingFrames, 0, 'the loop stops on drop');
      assert.deepEqual(f.calls.find((c) => c.method === 'PUT').body.order, [ids[1], ids[2], ids[0]]);
      await dom.nextFrame();
      assert.equal(vp.calls.length, 2, 'no scroll after the drop');
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

/**
 * Hold the pointer 4px from the bottom edge and run `frames` frames, each `dtMs` apart on the
 * rAF clock (the timestamp the component sees is synthetic; the harness's own clock is real time).
 * Returns every scrollBy the page received. Wiring test for #343/#355 (#360): it goes through
 * SetListView's real rAF loop, so it covers what the pure-helper tests cannot.
 */
async function runEdgeHold(dtMs, frames) {
  return withDom(async (dom) => {
    const f = stubFetch(okList);
    const realRaf = dom.window.requestAnimationFrame;
    let fakeNow = 1000;
    // Same queue as the harness (so pendingFrames and teardown checks still work), synthetic time.
    dom.window.requestAnimationFrame = (cb) => realRaf.call(dom.window, () => cb(fakeNow));
    try {
      const vp = stubViewport(dom.window, 300);
      const { handle } = await mountList(dom);
      await dom.pointer('pointerdown', handle(0), { clientX: 20, clientY: 126 });
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 296 });
      for (let i = 0; i < frames; i++) {
        await dom.nextFrame();
        fakeNow += dtMs;
      }
      await dom.pointer('pointerup', handle(0), { clientX: 20, clientY: 296 });
      await dom.act();
      return vp.calls;
    } finally {
      dom.window.requestAnimationFrame = realRaf;
      f.restore();
      await dom.unmountAll();
    }
  });
}
const sum = (a) => a.reduce((x, y) => x + y, 0);

test('auto-scroll wiring: the same elapsed time scrolls the same distance at 120Hz as at 60Hz (frame time is used)', async () => {
  // Frame 1 has no previous frame (nominal 16.67ms); the rest use the real gap. 160ms of gaps each.
  const at120 = await runEdgeHold(8, 21);
  const at60 = await runEdgeHold(16, 11);
  assert.ok(at120.length > 0 && at60.length > 0, 'the loop scrolls the page (deleting the scrollPageBy wiring fails here)');
  const speed = edgeScrollSpeed(296, 300); // px per second at 4px from the bottom
  const ideal = (speed * 160) / 1000 + (speed * NOMINAL_FRAME_MS) / 1000; // gaps + the nominal first frame
  assert.ok(Math.abs(sum(at120) - ideal) < 1, `120Hz total ${sum(at120)} within 1px of ${ideal.toFixed(2)}`);
  assert.ok(Math.abs(sum(at60) - ideal) < 1, `60Hz total ${sum(at60)} within 1px of ${ideal.toFixed(2)}`);
  assert.ok(Math.abs(sum(at120) - sum(at60)) <= 1, 'frame rate does not change the speed (lastFrameAt must be recorded each frame)');
});

test('auto-scroll wiring: a sub-pixel step per frame still adds up (fractional carry)', async () => {
  // 4ms frames at ~990px/s is ~3.96px a frame: whole-pixel rounding per frame would lose ~1px each.
  const calls = await runEdgeHold(4, 31);
  assert.ok(calls.every((t) => Number.isInteger(t) && t > 0), 'whole pixels only');
  const speed = edgeScrollSpeed(296, 300);
  const ideal = (speed * 120) / 1000 + (speed * NOMINAL_FRAME_MS) / 1000;
  assert.ok(sum(calls) > ideal - 1 && sum(calls) <= ideal + 1e-6, `total ${sum(calls)} tracks the ideal ${ideal.toFixed(2)} (carry kept)`);
});

test('auto-scroll: nothing scrolls away from the edges; the top edge scrolls up', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    try {
      const vp = stubViewport(dom.window, 300);
      vp.setY(200);
      const { handle } = await mountList(dom);
      await dom.pointer('pointerdown', handle(1), { clientX: 20, clientY: 186 });
      await dom.nextFrame();
      assert.equal(vp.calls.length, 0, 'mid-screen: no scroll');
      await dom.pointer('pointermove', handle(1), { clientX: 20, clientY: 10 });
      await dom.advance(20);
      await dom.nextFrame();
      assert.equal(vp.calls.length, 1);
      assert.ok(vp.calls[0] < 0, 'scrolls up');
      await dom.keydown('Escape');
      assert.equal(dom.pendingFrames, 0, 'the loop stops on cancel');
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('a mouse-wheel scroll mid-drag keeps the row under the pointer and moves the landing line to match', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    try {
      const vp = stubViewport(dom.window, 800);
      const { rows, handle } = await mountList(dom);
      await dom.pointer('pointerdown', handle(0), { clientX: 20, clientY: 126 });
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 136 });
      assert.equal(rows()[0].style.transform, 'translateY(10px)');
      assert.equal(rows()[1].dataset.drop, undefined);
      vp.setY(100); // wheel: the list moves up 100px under a still pointer
      await dom.act(() => { dom.window.dispatchEvent(new dom.window.Event('scroll')); });
      assert.equal(rows()[0].style.transform, 'translateY(110px)', 'the row stays under the pointer');
      assert.equal(rows()[1].dataset.drop, 'after', 'centre 126 + 110 = 236 has passed Creep (186), not my-take.wav (246)');
      await dom.pointer('pointerup', handle(0), { clientX: 20, clientY: 136 });
      await dom.act();
      assert.deepEqual(f.calls.find((c) => c.method === 'PUT').body.order, [ids[1], ids[0], ids[2]], 'saved where the line was');
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('reduced motion: at an edge the page jumps a fixed step, not every frame, and never animates', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    const realMM = globalThis.matchMedia;
    globalThis.matchMedia = (q) => ({ matches: /prefers-reduced-motion: reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
    const scrollOpts = [];
    try {
      const vp = stubViewport(dom.window, 300);
      const by = dom.window.scrollBy;
      dom.window.scrollBy = (o) => { scrollOpts.push(o); by(o); };
      const { rows, handle } = await mountList(dom);
      await dom.pointer('pointerdown', handle(0), { clientX: 20, clientY: 126 });
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 296 });
      await dom.nextFrame();
      await dom.nextFrame();
      await dom.nextFrame();
      assert.deepEqual(vp.calls, [REDUCED_JUMP_PX], 'one fixed jump, then a pause');
      assert.ok(scrollOpts.every((o) => o.behavior !== 'smooth'), 'no animated scroll');
      assert.equal(rows()[0].style.transform, '', 'the row still does not follow');
      await dom.pointer('pointerup', handle(0), { clientX: 20, clientY: 296 });
      await dom.act();
      assert.equal(dom.pendingFrames, 0);
    } finally {
      if (realMM === undefined) delete globalThis.matchMedia;
      else globalThis.matchMedia = realMM;
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('unmounting mid-drag stops the auto-scroll loop', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    try {
      stubViewport(dom.window, 300);
      const { handle } = await mountList(dom);
      await dom.pointer('pointerdown', handle(0), { clientX: 20, clientY: 296 });
      assert.ok(dom.pendingFrames > 0, 'the loop runs while dragging');
      await dom.unmountAll();
      assert.equal(dom.pendingFrames, 0);
    } finally {
      f.restore();
    }
  });
});

// ---- auto-scroll polish (#355) --------------------------------------------------------------

test('F1 autoScrollArmed: armed only once the pointer has moved AUTOSCROLL_ARM_PX either way', () => {
  assert.equal(AUTOSCROLL_ARM_PX, 8);
  assert.equal(autoScrollArmed(296, 296), false);
  assert.equal(autoScrollArmed(303, 296), false, '7px: not yet');
  assert.equal(autoScrollArmed(304, 296), true, '8px down');
  assert.equal(autoScrollArmed(288, 296), true, '8px up');
  assert.equal(autoScrollArmed(NaN, 296), false);
  assert.equal(autoScrollStep({ clientY: 799, viewportH: 800, reduced: false, now: 0, lastJumpAt: null, armed: false }), 0, 'not armed: no scroll');
  assert.equal(autoScrollStep({ clientY: 799, viewportH: 800, reduced: true, now: 0, lastJumpAt: null, armed: false }), 0, 'not armed: no jump either');
  assert.ok(autoScrollStep({ clientY: 799, viewportH: 800, reduced: false, now: 0, lastJumpAt: null, armed: true }) > 0);
});

test('F2 frameDt: nominal on the first frame, clamped to 0..MAX_FRAME_DT_MS after', () => {
  assert.equal(frameDt(1000, null), NOMINAL_FRAME_MS);
  assert.equal(frameDt(1008, 1000), 8);
  assert.equal(frameDt(1000, 1008), 0, 'a clock that goes back: no scroll, never backwards');
  assert.equal(frameDt(5000, 1000), MAX_FRAME_DT_MS, 'a stalled tab does not jump the page');
  assert.equal(frameDt(NaN, 1000), NOMINAL_FRAME_MS);
});

test('F2 auto-scroll is time-based: one second at the edge scrolls the same at 60Hz and 120Hz', () => {
  const H = 800;
  const run = (hz) => {
    const period = 1000 / hz;
    let total = 0;
    let carry = 0;
    let last = null;
    for (let i = 0; i < hz; i += 1) {
      const now = 1000 + i * period;
      const step = autoScrollStep({ clientY: 800, viewportH: H, reduced: false, now, lastJumpAt: null, lastFrameAt: last, armed: true });
      last = now;
      const { px, carry: rest } = splitWholePx(carry + step);
      carry = rest;
      total += px;
    }
    return total;
  };
  const at60 = run(60);
  const at120 = run(120);
  assert.ok(Math.abs(at60 - EDGE_MAX_SPEED_PX_PER_S) <= 20, `60Hz ~1s of max speed (${at60})`);
  assert.ok(Math.abs(at60 - at120) <= 10, `60Hz ${at60} vs 120Hz ${at120}`);
  // A per-frame speed (the old 18px/frame) would make 120Hz twice as fast.
  assert.ok(at120 < at60 * 1.1);
});

test('F2 splitWholePx: whole pixels now, the fraction carried (toward zero), so slow speeds add up', () => {
  assert.deepEqual(splitWholePx(16.5), { px: 16, carry: 0.5 });
  assert.deepEqual(splitWholePx(0.4), { px: 0, carry: 0.4 });
  const neg = splitWholePx(-2.25);
  assert.equal(neg.px, -2);
  assert.ok(Math.abs(neg.carry + 0.25) < 1e-9);
  assert.deepEqual(splitWholePx(NaN), { px: 0, carry: 0 });
  let carry = 0;
  let total = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = splitWholePx(carry + 0.3);
    carry = r.carry;
    total += r.px;
  }
  assert.equal(total, 3, '10 frames of 0.3px scroll 3px, not 0');
});

test('F4 edgeScrollSpeed: the bottom zone sits above the safe-area inset; inside the inset is past the edge', () => {
  const H = 800;
  const max = EDGE_MAX_SPEED_PX_PER_S;
  assert.equal(edgeScrollSpeed(740, H), 0, 'no inset: 60px from the bottom is outside the zone');
  assert.ok(edgeScrollSpeed(740, H, EDGE_ZONE_PX, max, 34) > 0, '34px inset: 26px above the usable bottom scrolls');
  assert.equal(edgeScrollSpeed(780, H, EDGE_ZONE_PX, max, 34), max, 'inside the inset: full speed');
  assert.equal(edgeScrollSpeed(700, H, EDGE_ZONE_PX, max, 34), 0);
  assert.equal(edgeScrollSpeed(10, H, EDGE_ZONE_PX, max, 34), edgeScrollSpeed(10, H), 'the top edge is unchanged');
  assert.equal(edgeScrollSpeed(740, H, EDGE_ZONE_PX, max, NaN), 0, 'a bad inset is 0');
  assert.equal(edgeScrollSpeed(740, H, EDGE_ZONE_PX, max, -50), 0, 'a negative inset is 0');
  assert.equal(edgeScrollSpeed(10, 30, EDGE_ZONE_PX, max, 40), 0, 'inset taller than the viewport: no scroll');
  assert.equal(
    autoScrollStep({ clientY: 740, viewportH: H, reduced: true, now: 0, lastJumpAt: null, insetBottom: 34 }),
    REDUCED_JUMP_PX,
    'autoScrollStep passes the inset through',
  );
  assert.equal(parsePx('34px'), 34);
  assert.equal(parsePx('0px'), 0);
  assert.equal(parsePx(''), 0);
  assert.equal(parsePx('env(safe-area-inset-bottom, 0px)'), 0);
  assert.equal(parsePx(undefined), 0);
  assert.equal(parsePx('-3px'), 0);
});

test('M7 edgeScrollSpeed on a viewport under 96px: each zone is half the viewport, no overlap', () => {
  const H = 60;
  const max = EDGE_MAX_SPEED_PX_PER_S;
  assert.equal(edgeScrollSpeed(30, H), 0, 'the exact middle scrolls neither way');
  assert.equal(edgeScrollSpeed(0, H), -max);
  assert.equal(edgeScrollSpeed(60, H), max);
  assert.equal(edgeScrollSpeed(15, H), -max / 2, 'half way into a 30px top zone: half speed');
  assert.equal(edgeScrollSpeed(45, H), max / 2, 'half way into a 30px bottom zone: half speed');
  assert.ok(edgeScrollSpeed(29, H) < 0);
  assert.ok(edgeScrollSpeed(31, H) > 0);
  // At 96px and above the zone is the full 48px.
  assert.equal(edgeScrollSpeed(24, 96), -max / 2);
  assert.equal(edgeScrollSpeed(48, 96), 0);
});

test('F1 a drag that starts inside the bottom edge zone does not scroll until the pointer moves 8px', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    try {
      const vp = stubViewport(dom.window, 300);
      const { handle } = await mountList(dom);
      await dom.pointer('pointerdown', handle(0), { clientX: 20, clientY: 290 });
      await dom.nextFrame();
      await dom.advance(20);
      await dom.nextFrame();
      assert.deepEqual(vp.calls, [], 'pressed in the zone: no scroll yet');
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 293 }); // 3px
      await dom.advance(20);
      await dom.nextFrame();
      assert.deepEqual(vp.calls, [], 'a 3px wobble does not start it');
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 298 }); // 8px
      await dom.advance(20);
      await dom.nextFrame();
      assert.equal(vp.calls.length, 1, 'moved 8px: auto-scroll starts');
      assert.ok(vp.calls[0] > 0);
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 290 }); // back to the start point
      await dom.advance(20);
      await dom.nextFrame();
      assert.equal(vp.calls.length, 2, 'once armed it stays armed for this drag');
      await dom.keydown('Escape');
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('F3 a scrollBy that throws on the options form falls back to scrollBy(x, y); the loop keeps going', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    try {
      const vp = stubViewport(dom.window, 300);
      const plain = [];
      const byOpts = dom.window.scrollBy;
      dom.window.scrollBy = (a, b) => {
        if (typeof a === 'object') throw new TypeError("'instant' is not a valid ScrollBehavior");
        plain.push([a, b]);
        byOpts({ top: b });
      };
      const { rows, handle } = await mountList(dom);
      await dom.pointer('pointerdown', handle(0), { clientX: 20, clientY: 126 });
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 296 });
      await dom.nextFrame();
      await dom.advance(20);
      await dom.nextFrame();
      assert.equal(plain.length, 2, 'both frames scrolled through the fallback');
      assert.ok(plain.every(([x, y]) => x === 0 && y > 0));
      assert.ok(dom.pendingFrames > 0, 'the loop is still alive');
      const scrolled = vp.calls.reduce((a, b) => a + b, 0);
      assert.equal(rows()[0].style.transform, `translateY(${170 + scrolled}px)`, 'the row keeps up');
      // Both forms throwing: still no crash, the loop still runs.
      dom.window.scrollBy = () => { throw new Error('nope'); };
      await dom.advance(20);
      await dom.nextFrame();
      assert.ok(dom.pendingFrames > 0, 'the loop survives a scrollBy that always throws');
      await dom.pointer('pointerup', handle(0), { clientX: 20, clientY: 296 });
      await dom.act();
      assert.equal(dom.pendingFrames, 0);
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('F4 the bottom zone starts above the safe-area inset read from env(safe-area-inset-bottom)', async () => {
  for (const [inset, expectScroll] of [['0px', false], ['34px', true]]) {
    await withDom(async (dom) => {
      const f = stubFetch(okList);
      const realGCS = dom.window.getComputedStyle;
      const probes = [];
      dom.window.getComputedStyle = function (el, ...rest) {
        if (el?.hasAttribute?.('data-safe-area-probe')) {
          probes.push(el);
          return { paddingBottom: inset };
        }
        return realGCS.call(this, el, ...rest);
      };
      try {
        const vp = stubViewport(dom.window, 300);
        const { handle } = await mountList(dom);
        await dom.pointer('pointerdown', handle(0), { clientX: 20, clientY: 126 });
        assert.equal(probes.length, 1, 'the inset is read once, when the drag starts');
        assert.equal(probes[0].isConnected, false, 'the probe is removed again');
        await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 240 }); // 60px from the bottom
        await dom.nextFrame();
        assert.equal(vp.calls.length > 0, expectScroll, `inset ${inset}`);
        await dom.keydown('Escape');
      } finally {
        dom.window.getComputedStyle = realGCS;
        f.restore();
        await dom.unmountAll();
      }
    });
  }
});

for (const name of ['pointercancel', 'lostpointercapture']) {
  test(`F6 ${name} stops the auto-scroll loop: no frame left queued, no more scrolling`, async () => {
    await withDom(async (dom) => {
      const f = stubFetch(okList);
      try {
        const vp = stubViewport(dom.window, 300);
        const { handle } = await mountList(dom);
        const h = handle(0);
        await dom.pointer('pointerdown', h, { clientX: 20, clientY: 126 });
        await dom.pointer('pointermove', h, { clientX: 20, clientY: 296 });
        await dom.nextFrame();
        assert.equal(vp.calls.length, 1, 'scrolling at the edge');
        assert.ok(dom.pendingFrames > 0, 'the loop is running');
        await dom.pointer(name, h, { clientX: 20, clientY: 296 });
        await dom.act();
        assert.equal(dom.pendingFrames, 0, `${name} cancelled the frame`);
        await dom.advance(20);
        await dom.nextFrame();
        assert.equal(vp.calls.length, 1, 'no scroll after the cancel');
        assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 0, 'nothing was sent');
      } finally {
        f.restore();
        await dom.unmountAll();
      }
    });
  });
}

test('M5 reduced motion: leave the edge and come back, and the next jump comes at once (not after the interval)', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(okList);
    const realMM = globalThis.matchMedia;
    globalThis.matchMedia = (q) => ({ matches: /prefers-reduced-motion: reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
    try {
      const vp = stubViewport(dom.window, 300);
      const { handle } = await mountList(dom);
      await dom.pointer('pointerdown', handle(0), { clientX: 20, clientY: 126 });
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 296 });
      await dom.nextFrame();
      await dom.nextFrame();
      assert.deepEqual(vp.calls, [REDUCED_JUMP_PX], 'one jump, then the interval holds');
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 150 }); // away from both edges
      await dom.nextFrame();
      await dom.pointer('pointermove', handle(0), { clientX: 20, clientY: 296 }); // back, well inside 450ms
      await dom.nextFrame();
      assert.deepEqual(vp.calls, [REDUCED_JUMP_PX, REDUCED_JUMP_PX], 're-entering the edge jumps at once');
      await dom.nextFrame();
      assert.equal(vp.calls.length, 2, 'and then waits again');
      await dom.pointer('pointerup', handle(0), { clientX: 20, clientY: 296 });
      await dom.act();
    } finally {
      if (realMM === undefined) delete globalThis.matchMedia;
      else globalThis.matchMedia = realMM;
      f.restore();
      await dom.unmountAll();
    }
  });
});
