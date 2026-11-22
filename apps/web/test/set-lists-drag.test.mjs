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

import { dropIndex, moveItem, reorderItem } from '../src/lib/set-lists.ts';
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
