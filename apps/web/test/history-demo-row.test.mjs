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

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;

const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'history-demo-row-'));
const put = (name, code) => {
  writeFileSync(join(dir, name), code);
  return './' + name;
};

const retentionMod = put('retention.mjs', toJs(read('src/lib/retention.ts')));
const jobLabelMod = put('job-label.mjs', toJs(read('src/lib/job-label.ts')));
const youtubeUrlMod = put('youtube-url.mjs', toJs(read('src/lib/youtube-url.ts')));
const songThumbMod = put(
  'song-thumb.mjs',
  toJs(read('src/lib/song-thumb.ts')).replace(/from ['"]\.\/youtube-url\.ts['"]/g, `from '${youtubeUrlMod}'`),
);
const libraryMod = put(
  'library.mjs',
  toJs(read('src/lib/library.ts'))
    .replace(/from ['"]\.\/job-label\.ts['"]/g, `from '${jobLabelMod}'`)
    .replace(/from ['"]\.\/song-thumb\.ts['"]/g, `from '${songThumbMod}'`)
    .replace(/from ['"]\.\/retention\.ts['"]/g, `from '${retentionMod}'`),
);
const historyMod = put('history.mjs', 'export const getHistoryEntries = () => globalThis.__browserHistory ?? [];');

const pageJs = toJs(read('src/app/history/page.tsx'))
  .replace(/from ['"]@\/lib\/history['"]/g, `from '${historyMod}'`)
  .replace(/from ['"]@\/lib\/retention['"]/g, `from '${retentionMod}'`)
  .replace(/from ['"]@\/lib\/library['"]/g, `from '${libraryMod}'`);
writeFileSync(join(dir, 'page.mjs'), pageJs);

const UNRESOLVED = [
  ...[pageJs, read('src/lib/library.ts')].flatMap((js) => [...js.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1])),
]
  .filter((spec) => !spec.startsWith('.'))
  .filter((spec) => spec !== 'react' && spec !== 'react/jsx-runtime');

const React = (await import('react')).default;
const HistoryPage = (await import(pathToFileURL(join(dir, 'page.mjs')).href)).default;
const { DEMO_RETAINED_UNTIL } = await import(pathToFileURL(join(dir, 'retention.mjs')).href);

// Installed ONCE before any withDom() (see job-view-poll.test.mjs): each test swaps `songs`.
let songs = [];
globalThis.fetch = async (url) => {
  assert.equal(String(url), '/api/library');
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

test('harness: every import of the page and of lib/library.ts is mapped', () => {
  assert.deepEqual(UNRESOLVED, [], `unmapped imports: ${UNRESOLVED.join(', ')}`);
});

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
