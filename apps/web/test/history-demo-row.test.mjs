// Run: pnpm --filter web test
//
// /history (the library list) hides "deleted in …" for a DEMO song (V3 Slice 0, migration 040).
//
// A demo row's retained-until is the finite far-future DEMO_RETAINED_UNTIL (2099-12-31), so
// formatExpiresIn would print "deleted in ~27,000 days". The page must show no countdown for
// it, and keep the countdown for every other row.
//
// HARNESS: real React, real effect (happy-dom via helpers/dom.mjs), the REAL page, the REAL
// lib/library.ts, lib/job-label.ts and lib/retention.ts (transpiled), a stubbed fetch for
// GET /api/library and a stubbed browser history. The page's only data source is the fetch,
// so what is asserted is what a signed-in user's browser renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { withDom } from './helpers/dom.mjs';
import { buildModuleGraph } from './helpers/module-graph.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;

// Phase B, B1: the page now renders components/library/LibraryList.tsx (search, sort, the
// expired rows); the REAL module graph is loaded (helpers/module-graph.mjs), only the browser
// history is stubbed.
const graph = buildModuleGraph({
  name: 'history-demo-row',
  entries: ['app/history/page.tsx', 'lib/retention.ts'],
  overrides: { 'lib/history.ts': 'export const getHistoryEntries = () => globalThis.__browserHistory ?? [];' },
});
const React = (await import('react')).default;
const HistoryPage = (await import(graph.url('app/history/page.tsx'))).default;
const { DEMO_RETAINED_UNTIL } = await import(graph.url('lib/retention.ts'));

// Installed ONCE before any withDom() (see job-view-poll.test.mjs): each test swaps `songs`.
let songs = [];
let libraryStatus = 200;
globalThis.fetch = async (url) => {
  assert.equal(String(url), '/api/library');
  if (libraryStatus !== 200) return { status: libraryStatus, ok: false, json: async () => ({ error: 'AUTH_REQUIRED' }) };
  return { status: 200, ok: true, json: async () => ({ songs, truncated: false }) };
};

const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const DEMO = 'dddddddd-0000-4000-8000-000000000001';
const MINE = 'aaaaaaaa-0000-4000-8000-000000000002';

async function render(rows) {
  songs = rows;
  return withDom(async (dom) => {
    const host = await dom.mount(React.createElement(HistoryPage));
    await dom.act(() => new Promise((r) => setTimeout(r, 0)));
    return [...host.querySelectorAll('li')].map((li) => ({
      href: li.querySelector('a')?.getAttribute('href'),
      text: li.textContent,
      thumb: li.querySelector('img[data-testid="song-thumb"]'),
    }));
  });
}

test('/history: a demo row (is_demo) shows no "deleted in"; a regular library row does', async () => {
  const now = Date.now();
  const items = await render([
    {
      id: DEMO, title: 'Lucky Ticket', original_filename: null, youtube_url: null, status: 'done',
      created_at: iso(now - 2 * DAY), expires_at: DEMO_RETAINED_UNTIL, is_demo: true,
    },
    {
      id: MINE, title: null, original_filename: 'take-5.mp3', youtube_url: null, status: 'done',
      created_at: iso(now - 1 * DAY), expires_at: iso(now + 20 * DAY), is_demo: false,
    },
  ]);
  const byHref = Object.fromEntries(items.map((i) => [i.href, i.text]));
  assert.ok(byHref[`/jobs/${DEMO}`], 'the demo song is LISTED (its expiry is finite)');
  assert.match(byHref[`/jobs/${DEMO}`], /Lucky Ticket/);
  assert.doesNotMatch(byHref[`/jobs/${DEMO}`], /deleted/, 'a demo must not read "deleted in ~27,000 days"');
  // Discriminating: the same page renders the countdown for a non-demo row.
  assert.match(byHref[`/jobs/${MINE}`], /deleted in 1\d days/);
});

test('/history: without is_demo the SAME far-future row would read "deleted in 2xxxx days"', async () => {
  // What the flag prevents, pinned so the negative above cannot pass for a wrong reason.
  const now = Date.now();
  const [item] = await render([
    {
      id: DEMO, title: 'Lucky Ticket', original_filename: null, youtube_url: null, status: 'done',
      created_at: iso(now - 2 * DAY), expires_at: DEMO_RETAINED_UNTIL,
    },
  ]);
  assert.match(item.text, /deleted in \d{5} days/);
});

// ── P5.1 (Slice 1b): titles and thumbnails in the library ──
test('/history: a linked song shows its title and its i.ytimg.com thumbnail; an upload shows neither image', async () => {
  const now = Date.now();
  const LINKED = 'eeeeeeee-0000-4000-8000-000000000003';
  const items = await render([
    {
      id: LINKED, title: 'Lucky Ticket', original_filename: null,
      youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', status: 'done',
      created_at: iso(now - 1 * DAY), expires_at: iso(now + 20 * DAY),
    },
    {
      id: MINE, title: 'take-5', original_filename: 'take-5.mp3', youtube_url: null, status: 'done',
      created_at: iso(now - 2 * DAY), expires_at: iso(now + 20 * DAY),
    },
  ]);
  const linked = items.find((i) => i.href === `/jobs/${LINKED}`);
  assert.match(linked.text, /^Lucky Ticket/, 'the title, not the URL');
  assert.doesNotMatch(linked.text, /youtube\.com/);
  assert.ok(linked.thumb, 'a linked song has a thumbnail');
  assert.equal(linked.thumb.getAttribute('src'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  assert.equal(linked.thumb.getAttribute('alt'), '', 'decorative: the title beside it names the song');
  assert.equal(linked.thumb.getAttribute('referrerpolicy'), 'no-referrer');
  const upload = items.find((i) => i.href === `/jobs/${MINE}`);
  assert.match(upload.text, /^take-5/);
  assert.equal(upload.thumb, null, 'an upload has no thumbnail');
});

// ── QA A-06 (track A, 2026-11-18): failed songs looked playable; broken thumbnails ──
// The DOWNLOAD_PRIVATE job was listed "https://www.yo…" in the same style as a ready
// song, with no status; a thumbnail that failed to load showed the browser's broken-image
// icon. The two-line title is a layout property: see the real-Chromium gate
// packages/web-browser-gate/test/library-rows.test.mjs.
async function renderRows(rows, poke) {
  songs = rows;
  return withDom(async (dom) => {
    const host = await dom.mount(React.createElement(HistoryPage));
    await dom.act(() => new Promise((r) => setTimeout(r, 0)));
    if (poke) await dom.act(async () => poke(host));
    return [...host.querySelectorAll('li a')].map((a) => ({
      href: a.getAttribute('href'),
      state: a.getAttribute('data-state'),
      title: a.querySelector('[data-testid="song-title"]')?.textContent ?? null,
      chip: a.querySelector('[data-testid="song-status"]')?.textContent ?? null,
      img: a.querySelector('img'),
      placeholder: a.querySelector('[data-testid="song-thumb-placeholder"]'),
    }));
  });
}

test('A-06: a failed song carries a "Failed" chip and no thumbnail; a processing one says so; a ready one has no chip', async () => {
  const now = Date.now();
  const FAILED = 'ffffffff-0000-4000-8000-000000000004';
  const BUSY = 'bbbbbbbb-0000-4000-8000-000000000005';
  const READY = 'cccccccc-0000-4000-8000-000000000006';
  const base = { original_filename: null, created_at: iso(now - DAY / 2), expires_at: iso(now + DAY / 2) };
  const rows = await renderRows([
    { ...base, id: FAILED, title: null, youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', status: 'failed' },
    { ...base, id: BUSY, title: 'Still cooking', youtube_url: 'https://www.youtube.com/watch?v=9bZkp7q19f0', status: 'separating' },
    { ...base, id: READY, title: 'Lucky Ticket', youtube_url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', status: 'done' },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.href.slice(6), r]));
  assert.equal(by[FAILED].state, 'failed');
  assert.equal(by[FAILED].chip, 'Failed', 'a failed song has no status chip');
  assert.equal(by[FAILED].img, null, 'a failed song still shows a video still (looks playable)');
  assert.ok(by[FAILED].placeholder, 'a failed song has no neutral stand-in for its picture');
  assert.equal(by[FAILED].title, 'youtube.com · dQw4w9WgXcQ', 'a link with no title is listed by its short form, not the raw URL');
  assert.equal(by[BUSY].chip, 'Processing');
  assert.ok(by[BUSY].img, 'a processing link song keeps its thumbnail');
  assert.equal(by[READY].chip, null, 'a ready song carries no chip');
  assert.equal(by[READY].state, 'ready');
  assert.ok(by[READY].img);
});

test('A-06: a thumbnail that fails to load is replaced by a neutral placeholder, not the broken-image icon', async () => {
  const now = Date.now();
  const id = 'abababab-0000-4000-8000-000000000007';
  const row = { id, title: 'Lucky Ticket', original_filename: null, youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', status: 'done', created_at: iso(now - DAY / 2), expires_at: iso(now + DAY / 2) };
  const [before] = await renderRows([row]);
  assert.ok(before.img, 'harness: the thumbnail renders before the error');
  const [after] = await renderRows([row], (host) => {
    const img = host.querySelector('img[data-testid="song-thumb"]');
    img.dispatchEvent(new host.ownerDocument.defaultView.Event('error'));
  });
  assert.equal(after.img, null, 'the broken <img> is still on the page');
  assert.ok(after.placeholder, 'no placeholder took its place');
  assert.equal(after.placeholder.textContent, '', 'a ready song\'s placeholder is neutral (no failure mark)');
});

// ── QA A-14: signed out, "No songs yet" read as a lost library ──
test('A-14: signed out (GET /api/library 401) with nothing on this browser says "Sign in to see your library"', async () => {
  songs = [];
  libraryStatus = 401;
  try {
    const text = await withDom(async (dom) => {
      const host = await dom.mount(React.createElement(HistoryPage));
      await dom.act(() => new Promise((r) => setTimeout(r, 0)));
      return { all: host.textContent, link: host.querySelector('[data-testid="history-sign-in"] a')?.getAttribute('href') };
    });
    assert.match(text.all, /Sign in to see your library\./);
    assert.doesNotMatch(text.all, /No songs yet/, 'a signed-out visitor is told they have no songs');
    assert.equal(text.link, '/login?return_to=/history');
  } finally {
    libraryStatus = 200;
  }
  // Signed in with an empty library still says "No songs yet" (the prompt is for signed-out only).
  const empty = await withDom(async (dom) => {
    const host = await dom.mount(React.createElement(HistoryPage));
    await dom.act(() => new Promise((r) => setTimeout(r, 0)));
    return host.textContent;
  });
  assert.match(empty, /No songs yet/);
});
