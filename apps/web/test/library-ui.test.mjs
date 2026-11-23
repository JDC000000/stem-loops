// The song library page (/history; Phase B, B1): the REAL page and LibraryList from the module
// graph in happy-dom, GET /api/library stubbed. Layout and paint are out of reach here (no layout
// engine): the 390x844 / 360x800 screens are in docs/design/screens-2026-11-22/b1-library/, and
// packages/web-browser-gate/journeys/j11-library.mjs measures them in real Chromium.
//
// AC 9:  an expired row: title 16 px, "BPM · key" 13 px, "Audio expired", Re-make with the copy
//        "Re-make · uses 1 of your songs" (one tap -> the job page), no amber, no lime.
// AC 10: search (title; artist for demo rows only), sort control (Recent / Newest / A–Z).
// AC 11: Remove asks first, then deletes the entry (DELETE /api/library/:entryId).
// Q3:    an upload offers "Upload again", never Re-make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildModuleGraph } from './helpers/module-graph.mjs';
import { setNativeValue, withDom } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

const graph = buildModuleGraph({
  name: 'library-ui',
  entries: ['app/history/page.tsx'],
  overrides: { 'lib/history.ts': 'export const getHistoryEntries = () => [];' },
});
const React = (await import('react')).default;
const HistoryPage = (await import(graph.url('app/history/page.tsx'))).default;

const NOW = Date.now();
const D = 24 * 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const LINK = '22222222-0000-4000-8000-0000000000e1';
const UPLOAD = '22222222-0000-4000-8000-0000000000e2';
const LIVE = 'aaaaaaaa-0000-4000-8000-000000000001';
const NEWJOB = 'bbbbbbbb-0000-4000-8000-000000000009';

const LIBRARY = {
  songs: [
    { id: LIVE, title: 'Offline cover', youtube_url: 'https://youtu.be/aaaaaaaaaaa', video_id: null, bpm: 95, musical_key: 'G major', status: 'done', created_at: iso(NOW - D / 2), expires_at: iso(NOW + D / 2), is_demo: false },
  ],
  entries: [
    { entry_id: LINK, state: 'expired', input_kind: 'youtube', youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', original_filename: null, title: 'Never Gonna', video_id: 'dQw4w9WgXcQ', bpm: 113.2, musical_key: 'A major', created_at: iso(NOW - 3 * D) },
    { entry_id: UPLOAD, state: 'expired', input_kind: 'upload', youtube_url: null, original_filename: 'band take.wav', title: 'band take', video_id: null, bpm: null, musical_key: null, created_at: iso(NOW - 4 * D) },
  ],
  truncated: false,
};

function stubFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    const [status, body] = handler(String(url), init);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
function stubAssign(dom) {
  const went = [];
  const loc = dom.window.location;
  const real = loc.assign;
  loc.assign = (u) => went.push(u);
  return { went, restore: () => { loc.assign = real; } };
}
async function mountPage(dom) {
  await dom.mount(React.createElement(HistoryPage));
  await dom.act(() => new Promise((r) => setTimeout(r, 0)));
  await dom.act();
}
const entryRow = (dom, id) => dom.find(`[data-testid="library-entry"][data-entry="${id}"]`);

test('AC 9: an expired link row shows title (16 px), BPM · key (13 px), "Audio expired" and the Re-make copy', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(() => [200, LIBRARY]);
    try {
      await mountPage(dom);
      const row = entryRow(dom, LINK);
      assert.ok(row, 'the expired song is listed');
      const title = row.querySelector('[data-testid="song-title"]');
      assert.equal(title.textContent, 'Never Gonna');
      assert.equal(title.style.fontSize, '16px');
      const meta = row.querySelector('[data-testid="song-meta"]');
      assert.equal(meta.textContent, '113 BPM · A major');
      assert.equal(meta.parentElement.style.fontSize, '13px');
      assert.equal(row.querySelector('[data-testid="song-status"]').textContent, 'Audio expired');
      const btn = row.querySelector('[data-testid="library-remake"]');
      assert.equal(btn.textContent, 'Re-make · uses 1 of your songs');
      assert.equal(btn.style.minHeight, '44px');
      assert.equal(row.querySelector('a[href^="/jobs/"]'), null, 'an expired row does not link to a job (it has none)');
      // A live row next to it keeps its job link and shows BPM · key too.
      const live = dom.find(`a[href="/jobs/${LIVE}"]`);
      assert.equal(live.querySelector('[data-testid="song-meta"]').textContent, '95 BPM · G major');
    } finally {
      f.restore();
    }
  });
});

test('AC 9: Re-make is ONE tap to the job page (POST /api/library/remake with the entry id)', async () => {
  await withDom(async (dom) => {
    const f = stubFetch((url, init) => (url === '/api/library/remake' ? [201, { id: NEWJOB, status: 'queued' }] : [200, LIBRARY]));
    const nav = stubAssign(dom);
    try {
      await mountPage(dom);
      await dom.act(() => entryRow(dom, LINK).querySelector('[data-testid="library-remake"]').click());
      await dom.act(() => new Promise((r) => setTimeout(r, 0)));
      const post = f.calls.find((c) => c.url === '/api/library/remake');
      assert.deepEqual(post, { url: '/api/library/remake', method: 'POST', body: { entry_id: LINK } });
      assert.deepEqual(nav.went, [`/jobs/${NEWJOB}`]);
    } finally {
      nav.restore();
      f.restore();
    }
  });
});

test('AC 5 (UI): a refused Re-make (at quota) shows the route\'s message on the row and stays put', async () => {
  const MSG = "You've used this month's free songs.";
  await withDom(async (dom) => {
    const f = stubFetch((url) => (url === '/api/library/remake' ? [402, { code: 'quota_exceeded', message: MSG }] : [200, LIBRARY]));
    const nav = stubAssign(dom);
    try {
      await mountPage(dom);
      await dom.act(() => entryRow(dom, LINK).querySelector('[data-testid="library-remake"]').click());
      await dom.act(() => new Promise((r) => setTimeout(r, 0)));
      assert.equal(entryRow(dom, LINK).querySelector('[data-testid="library-remake-error"]').textContent, MSG);
      assert.deepEqual(nav.went, []);
      assert.equal(entryRow(dom, LINK).querySelector('[data-testid="library-remake"]').disabled, false, 'can try again');
    } finally {
      nav.restore();
      f.restore();
    }
  });
});

test('Q3: an expired upload offers "Upload again" (home), never Re-make', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(() => [200, LIBRARY]);
    try {
      await mountPage(dom);
      const row = entryRow(dom, UPLOAD);
      // #352: compare `=== null`, not the node itself: a failing assert.equal on a DOM node OOMs while printing it.
      assert.equal(row.querySelector('[data-testid="library-remake"]') === null, true, 'an upload offers no Re-make');
      const again = row.querySelector('[data-testid="library-upload-again"]');
      assert.equal(again.textContent, 'Upload again');
      assert.equal(again.getAttribute('href'), '/');
    } finally {
      f.restore();
    }
  });
});

test('AC 11: Remove asks first; confirming deletes the entry and the row goes', async () => {
  await withDom(async (dom) => {
    const f = stubFetch((url, init) => (init.method === 'DELETE' ? [200, { ok: true }] : [200, LIBRARY]));
    try {
      await mountPage(dom);
      await dom.act(() => entryRow(dom, LINK).querySelector('[data-testid="library-remove"]').click());
      const sheet = dom.find('[data-testid="library-remove-sheet"]');
      assert.match(sheet.textContent, /Remove “Never Gonna” from your library\?/);
      assert.match(sheet.textContent, /Its link, title, BPM and key are deleted\./);
      assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 0, 'nothing deleted before the confirm');
      await dom.act(() => dom.find('[data-testid="library-remove-confirm"]').click());
      await dom.act(() => new Promise((r) => setTimeout(r, 0)));
      assert.deepEqual(f.calls.filter((c) => c.method === 'DELETE').map((c) => c.url), [`/api/library/${LINK}`]);
      assert.equal(entryRow(dom, LINK), null, 'the row is gone');
      assert.ok(entryRow(dom, UPLOAD), 'the other row stays');
    } finally {
      f.restore();
    }
  });
});

test('AC 10: search narrows the list; no match says so', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(() => [200, LIBRARY]);
    try {
      await mountPage(dom);
      const box = dom.find('[data-testid="library-search"]');
      await dom.act(() => setNativeValue(box, 'never'));
      const titles = () => [...dom.window.document.querySelectorAll('[data-testid="song-title"]')].map((t) => t.textContent);
      assert.deepEqual(titles(), ['Never Gonna']);
      await dom.act(() => setNativeValue(box, 'zzz'));
      assert.deepEqual(titles(), []);
      assert.match(dom.find('[data-testid="library-no-match"]').textContent, /No songs match “zzz”/);
    } finally {
      f.restore();
    }
  });
});

test('AC 10: the sort control has Recent (default) / Newest / A–Z, one pressed, neutral selected state', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(() => [200, LIBRARY]);
    try {
      await mountPage(dom);
      const btns = [...dom.find('[data-testid="library-sort"]').querySelectorAll('button')];
      assert.deepEqual(btns.map((b) => b.textContent), ['Recent', 'Newest', 'A–Z']);
      assert.deepEqual(btns.map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
      assert.match(btns[0].style.background, /#222|rgb\(34, 34, 34\)/);
      assert.match(btns[0].style.border, /2px solid (#fff|rgb\(255, 255, 255\)|white)/);
      await dom.act(() => btns[2].click());
      const titles = [...dom.window.document.querySelectorAll('[data-testid="song-title"]')].map((t) => t.textContent);
      assert.deepEqual(titles, ['band take', 'Never Gonna', 'Offline cover']);
      assert.equal(btns[2].getAttribute('aria-pressed'), 'true');
    } finally {
      f.restore();
    }
  });
});

test('brand: no amber and no lime fill in the library UI source', () => {
  const src = read('src/components/library/LibraryList.tsx').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /chord-now|amber|#f59e0b|#fbbf24/i);
  assert.doesNotMatch(src, /--accent\b|#a3e635/i);
});

test('the /jobs/[id] layout only marks last-opened (no data, no fetch)', () => {
  const src = read('src/app/jobs/[id]/layout.tsx').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /<LastOpenedMarker jobId=\{params\.id\} \/>/);
  assert.doesNotMatch(src, /fetch\(|db\b|getUser/);
  const marker = read('src/components/library/LastOpenedMarker.tsx').replace(/\/\/[^\n]*/g, '');
  assert.match(marker, /recordLastOpened\(window\.localStorage, jobId\)/);
  assert.doesNotMatch(marker, /fetch\(/);
});

test('signed in, the library links to the set lists (/sets) with a 44 px tap target', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(() => [200, LIBRARY]);
    try {
      await mountPage(dom);
      const a = dom.find('[data-testid="history-sets-link"]');
      assert.ok(a, 'the set lists link is shown');
      assert.equal(a.tagName, 'A');
      assert.equal(a.getAttribute('href'), '/sets');
      assert.equal(a.textContent, 'Your set lists →');
      assert.equal(a.style.minHeight, 'var(--touch-min)');
    } finally {
      f.restore();
    }
  });
});

test('signed out, the library does not show the set lists link', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(() => [401, {}]);
    try {
      await mountPage(dom);
      assert.equal(dom.find('[data-testid="history-sets-link"]') === null, true, 'signed out: no set lists link');
      assert.ok(dom.find('[data-testid="history-sign-in"]'), 'the sign-in prompt shows instead');
    } finally {
      f.restore();
    }
  });
});

// #352 F2: a library fetch error (500) is not "signed in": the set lists link stays hidden.
test('library fetch error (500): the set lists link is hidden', async () => {
  await withDom(async (dom) => {
    const f = stubFetch(() => [500, {}]);
    try {
      await mountPage(dom);
      assert.equal(dom.find('[data-testid="history-sets-link"]') === null, true, 'fetch error: no set lists link');
      assert.match(dom.window.document.body.textContent, /We could not load your library just now\./, 'the error note shows');
    } finally {
      f.restore();
    }
  });
});
