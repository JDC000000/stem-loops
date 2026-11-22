// The /sets pages (#322; Phase B, B2): SetListsIndex and SetListView from the REAL module
// graph in happy-dom, fetch stubbed per test. Layout and paint are out of reach here (no layout
// engine): the 390x844 / 360x800 screens are in docs/design/screens-2026-11-22/b2-set-lists/.
//
// AC 7: create = "+ New set list" (1) -> "Create" with "Set list 1" prefilled (2).
// AC 8: Move up / Move down are real buttons (keyboard-operable), >= 44px, and keep focus on
//       the moved song.
// AC 3: the delete confirm says deleting a list never deletes songs.
// AC 6: the Demo set, signed out, read-only, with "Unavailable" rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildModuleGraph } from './helpers/module-graph.mjs';
import { withDom } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

const graph = buildModuleGraph({
  name: 'set-lists-ui',
  entries: ['components/setlists/SetListsIndex.tsx', 'components/setlists/SetListView.tsx'],
});
const React = (await import('react')).default;
const { SetListsIndex } = await import(graph.url('components/setlists/SetListsIndex.tsx'));
const { SetListView } = await import(graph.url('components/setlists/SetListView.tsx'));

const LIST = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
const NEW = '9e8d7c6b-5a49-4382-9172-6a5b4c3d2e1f';

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
function stubAssign(dom) {
  const went = [];
  const loc = dom.window.location;
  const real = loc.assign;
  loc.assign = (u) => went.push(u);
  return { went, restore: () => { loc.assign = real; } };
}

test('AC 7: "+ New set list" (tap 1) opens a sheet prefilled "Set list 1"; "Create" (tap 2) makes it and opens it', async () => {
  await withDom(async (dom) => {
    const f = stubFetch((url, init) => (init.method === 'POST'
      ? [201, { list: { id: NEW, name: 'Set list 1', song_count: 0, updated_at: 'x' } }]
      : [200, { lists: [], max_lists: 50 }]));
    const nav = stubAssign(dom);
    try {
      await dom.mount(React.createElement(SetListsIndex));
      await dom.act();
      assert.ok(dom.find('[data-testid="sets-empty"]'), 'empty state');
      assert.ok(dom.find('[data-testid="sets-demo"]'), 'the Demo set is listed');
      await dom.act(() => dom.find('[data-testid="sets-new"]').click()); // tap 1
      assert.equal(dom.find('[data-testid="sets-new-name"]').value, 'Set list 1');
      assert.equal(dom.window.document.activeElement, dom.find('[data-testid="sets-new-name"]'), 'the name field has focus');
      await dom.act(() => dom.find('[data-testid="sets-create"]').click()); // tap 2
      await dom.act();
      const post = f.calls.find((c) => c.method === 'POST');
      assert.deepEqual([post.url, post.body], ['/api/set-lists', { name: 'Set list 1' }]);
      assert.deepEqual(nav.went, [`/sets/${NEW}`]);
      // The sheet's Create is the view's one lime action.
      assert.match(dom.find('[data-testid="sets-create"]').getAttribute('style'), /var\(--accent\)/);
    } finally {
      nav.restore();
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('index: two lists show with their counts; the next prefill skips a taken name', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(() => [200, { lists: [
      { id: LIST, name: 'Set list 1', song_count: 3, updated_at: 'x' },
      { id: NEW, name: 'JAMS', song_count: 1, updated_at: 'x' },
    ] }]);
    try {
      await dom.mount(React.createElement(SetListsIndex));
      await dom.act();
      assert.deepEqual([...dom.findAll('[data-testid="sets-row"]')].map((r) => r.textContent), ['Set list 13 songs', 'JAMS1 song']);
      await dom.act(() => dom.find('[data-testid="sets-new"]').click());
      assert.equal(dom.find('[data-testid="sets-new-name"]').value, 'Set list 2');
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('index signed out: the Demo set is still there, with a sign-in line, no "+ New set list"', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(() => [401, {}]);
    try {
      await dom.mount(React.createElement(SetListsIndex));
      await dom.act();
      assert.ok(dom.find('[data-testid="sets-demo"]'));
      assert.ok(dom.find('[data-testid="sets-sign-in"]'));
      assert.equal(dom.find('[data-testid="sets-new"]'), null);
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

const items3 = () => [
  { item_id: 'a0000000-0000-4000-8000-000000000001', position: 0, source: 'link', title: 'Wonderwall', state: 'ready', job_id: 'j1' },
  { item_id: 'a0000000-0000-4000-8000-000000000002', position: 1, source: 'link', title: 'Creep', state: 'expired', job_id: null },
  { item_id: 'a0000000-0000-4000-8000-000000000003', position: 2, source: 'upload', title: 'my-take.wav', state: 'ready', job_id: 'j3' },
];

test('AC 8: Move up / Move down are keyboard-operable buttons; the order is sent whole; focus follows the song', async () => {
  await withDom(async (dom) => {
    const f = stubFetch((url, init) => (init.method === 'PUT' ? [200, { ok: true }] : [200, { list: { id: LIST, name: 'JAMS', is_demo: false, items: items3() } }]));
    try {
      await dom.mount(React.createElement(SetListView, { id: LIST }));
      await dom.act();
      const rows = () => [...dom.findAll('[data-testid="set-item"]')];
      assert.deepEqual(rows().map((r) => r.dataset.state), ['ready', 'expired', 'ready']);
      assert.equal(rows()[1].querySelector('[data-testid="set-item-state"]').textContent, 'Audio expired');
      assert.equal(rows()[0].querySelector('a').getAttribute('href'), `/jobs/j1?set=${LIST}`);
      assert.equal(rows()[1].querySelector('a'), null, 'an expired song is not a link');
      const up = (i) => rows()[i].querySelector('[data-move="up"]');
      const down = (i) => rows()[i].querySelector('[data-move="down"]');
      assert.equal(up(0).disabled, true, 'the first song cannot move up');
      assert.equal(down(2).disabled, true, 'the last song cannot move down');
      for (const b of [up(1), down(1)]) {
        assert.equal(b.tagName, 'BUTTON');
        assert.equal(b.getAttribute('type'), 'button');
        assert.match(b.getAttribute('aria-label'), /^Move Creep (up|down)$/);
      }
      down(1).focus();
      await dom.act(() => down(1).click()); // Enter/Space on a <button> is a click
      await dom.act();
      const put = f.calls.find((c) => c.method === 'PUT');
      assert.equal(put.url, `/api/set-lists/${LIST}/songs`);
      assert.deepEqual(put.body.order, [items3()[0].item_id, items3()[2].item_id, items3()[1].item_id]);
      assert.deepEqual(rows().map((r) => r.textContent.replace(/[↑↓×]/g, '')), ['1Wonderwall', '2my-take.wav', '3CreepAudio expired']);
      const active = dom.window.document.activeElement;
      assert.equal(active.closest('[data-testid="set-item"]').dataset.item, items3()[1].item_id, 'focus stayed on Creep');
      assert.match(dom.find('[data-testid="set-notice"]').textContent, /Moved Creep down/);
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
  const css = read('src/components/setlists/SetLists.module.css');
  const btn = css.match(/\n\.iconBtn\s*\{([^}]*)\}/)[1];
  assert.match(btn, /min-width:\s*var\(--touch-min\);/);
  assert.match(btn, /min-height:\s*var\(--touch-min\);/);
  assert.match(btn, /border:\s*1\.5px solid var\(--border-control\);/);
});

test('AC 3: Delete list asks first and says deleting a list never deletes songs; confirming deletes and goes back', async () => {
  await withDom(async (dom) => {
    const f = stubFetch((url, init) => (init.method === 'DELETE' ? [204, null] : [200, { list: { id: LIST, name: 'JAMS', is_demo: false, items: items3() } }]));
    const nav = stubAssign(dom);
    try {
      await dom.mount(React.createElement(SetListView, { id: LIST }));
      await dom.act();
      assert.match(dom.find('[data-testid="set-view"]').textContent, /Deleting a list never deletes songs\./);
      await dom.act(() => dom.find('[data-testid="set-delete"]').click());
      const sheet = dom.find('[data-testid="set-delete-sheet"]');
      assert.match(sheet.textContent, /Delete “JAMS”\?/);
      assert.match(sheet.textContent, /Deleting a list never deletes songs\./);
      assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 0, 'nothing deleted before the confirm');
      await dom.act(() => dom.find('[data-testid="set-delete-confirm"]').click());
      await dom.act();
      assert.deepEqual(f.calls.filter((c) => c.method === 'DELETE').map((c) => c.url), [`/api/set-lists/${LIST}`]);
      assert.deepEqual(nav.went, ['/sets']);
    } finally {
      nav.restore();
      f.restore();
      await dom.unmountAll();
    }
  });
});

test('AC 6: the Demo set view is read-only (no move, remove, rename or delete) and shows "Unavailable" rows', async () => {
  await withDom(async (dom) => {
    const f = stubFetch((url) => (url === '/api/set-lists/demo' ? [200, { list: { id: 'demo', name: 'Demo set', is_demo: true, items: [
      { item_id: 'im-asking-you', position: 0, source: 'demo', title: 'I’m Asking You', state: 'ready', job_id: 'd1' },
      { item_id: 'offline', position: 1, source: 'demo', title: 'Offline', state: 'unavailable', job_id: null },
      { item_id: 'lucky-ticket', position: 2, source: 'demo', title: 'Lucky Ticket', state: 'ready', job_id: 'd3' },
    ] } }] : [404, {}]));
    try {
      await dom.mount(React.createElement(SetListView, { id: 'demo' }));
      await dom.act();
      assert.equal(f.calls[0].url, '/api/set-lists/demo');
      assert.equal(dom.find('[data-testid="set-name"]').textContent, 'Demo set');
      assert.equal(dom.findAll('[data-move]').length, 0);
      assert.equal(dom.find('[data-testid="set-delete"]'), null);
      assert.ok(![...dom.findAll('button')].some((b) => /Rename|Take/.test(b.textContent + (b.getAttribute('aria-label') ?? ''))));
      const states = [...dom.findAll('[data-testid="set-item"]')].map((r) => [r.dataset.state, r.querySelector('[data-testid="set-item-state"]')?.textContent ?? null]);
      assert.deepEqual(states, [['ready', null], ['unavailable', 'Unavailable'], ['ready', null]]);
      assert.equal(dom.find('[data-testid="set-item"] a').getAttribute('href'), '/jobs/d1?set=demo');
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});

test("a list that is not the caller's reads as not found", async () => {
  await withDom(async (dom) => {
    const f = stubFetch(() => [404, { error_code: 'NOT_FOUND' }]);
    try {
      await dom.mount(React.createElement(SetListView, { id: LIST }));
      await dom.act();
      assert.equal(dom.find('[data-testid="set-view"]').dataset.state, 'not_found');
    } finally {
      f.restore();
      await dom.unmountAll();
    }
  });
});
