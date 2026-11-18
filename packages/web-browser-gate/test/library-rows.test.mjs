// REAL-BROWSER GATE: the library rows on a phone (QA A-06).
//
// QA track A (2026-11-18), /history at 390x844 signed in:
//   * "The Royal Sun…": the title got 105 px, because "deleted in 22 hours" took
//     the rest of a one-line row, and was cut to ~13 characters;
//   * the DOWNLOAD_PRIVATE job looked exactly like a ready song;
//   * a thumbnail that failed to load showed the browser's broken-image icon.
// This renders the REAL /history page (src/app/history/page.tsx) with the real
// CSS in real Chromium, its GET /api/library answered here, and the i.ytimg.com
// thumbnails answered 404 (so every image breaks). At 390x844 and 360x800 it
// checks that:
//   * a long title gets most of the row's width and up to two lines (it is
//     never cut to one line while a second would fit);
//   * a failed song shows a visible "Failed" chip (a 22 px pill) and no video
//     still; a processing song a "Processing" chip; a ready song no chip;
//   * no <img> is left on the page in a broken state, and each broken one is
//     replaced by a placeholder of the same size;
//   * the page does not scroll sideways, and every row is a >= 44 px target.
// It FAILS (never skips) when Chromium or the page is missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const esbuild = require('esbuild');

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(process.env.CHORD_GATE_SRC ?? join(HERE, '../../../apps/web'));
const LONG_TITLE = 'The Royal Sundowners — Lucky Ticket (Official Audio, Remastered 2026 Extended Version)';

function rows() {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const base = { original_filename: null, created_at: iso(now - 3600e3), expires_at: iso(now + 22 * 3600e3) };
  return [
    { ...base, id: 'aaaaaaaa-0000-4000-8000-0000000000a1', title: LONG_TITLE, youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', status: 'done', created_at: iso(now - 60e3) },
    { ...base, id: 'aaaaaaaa-0000-4000-8000-0000000000a2', title: null, youtube_url: 'https://www.youtube.com/watch?v=9bZkp7q19f0', status: 'failed', created_at: iso(now - 120e3) },
    { ...base, id: 'aaaaaaaa-0000-4000-8000-0000000000a3', title: 'Still cooking', youtube_url: 'https://youtu.be/kJQP7kiw5Fk', status: 'separating', created_at: iso(now - 180e3) },
    { ...base, id: 'aaaaaaaa-0000-4000-8000-0000000000a4', title: null, original_filename: 'take-5.mp3', youtube_url: null, status: 'done', created_at: iso(now - 240e3) },
  ];
}

let browser;
let built;
test('Chromium launches and the real /history page bundles', async () => {
  const res = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import HistoryPage from './src/app/history/page.tsx';
        import './src/app/globals.css';
        createRoot(document.getElementById('root')).render(React.createElement(HistoryPage));`,
      resolveDir: WEB,
      loader: 'js',
    },
    bundle: true,
    write: false,
    outdir: 'out',
    format: 'iife',
    jsx: 'automatic',
    tsconfig: join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    logLevel: 'silent',
  });
  const js = res.outputFiles.find((f) => f.path.endsWith('.js'));
  assert.ok(js, 'esbuild produced no JS');
  built = { js: js.text, css: res.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '' };
  browser = await chromium.launch();
  assert.ok(browser.isConnected());
});

for (const [w, h] of [[390, 844], [360, 800]]) {
  test(`A-06 library rows @ ${w}x${h}: two-line titles, failed and processing chips, no broken images`, async () => {
    assert.ok(browser && built, 'setup test did not run or failed');
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    let thumbs = 0;
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === 'i.ytimg.com') { thumbs++; return route.fulfill({ status: 404, body: '' }); }
      if (u.hostname !== 'gate.test') return route.abort();
      if (u.pathname === '/')
        return route.fulfill({ contentType: 'text/html', body:
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<link rel="stylesheet" href="/out.css"></head><body><div id="root"></div><script src="/out.js"></script></body></html>' });
      if (u.pathname === '/out.js') return route.fulfill({ contentType: 'text/javascript', body: built.js });
      if (u.pathname === '/out.css') return route.fulfill({ contentType: 'text/css', body: built.css });
      if (u.pathname === '/api/library') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ songs: rows(), truncated: false }) });
      return route.fulfill({ status: 404, body: '' });
    });
    try {
      await page.goto('http://gate.test/');
      await page.waitForSelector('li a[href^="/jobs/"]', { timeout: 30000 });
      // Let the thumbnails fail and the page react.
      await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 10000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const m = await page.evaluate(() => {
        const out = [];
        const WANT = { a1: 'ready', a2: 'failed', a3: 'processing', a4: 'ready' };
        for (const a of document.querySelectorAll('li a[href^="/jobs/"]')) {
          // The row's title: the page's title element, else (an older page) the row's text span.
          const t = a.querySelector('[data-testid="song-title"]') ?? a.querySelector('.jp-row-id') ?? a;
          const chip = a.querySelector('[data-testid="song-status"]');
          const ph = a.querySelector('[data-testid="song-thumb-placeholder"]');
          const tcs = getComputedStyle(t);
          const lh = parseFloat(tcs.lineHeight) || parseFloat(tcs.fontSize) * 1.2; // 'normal' -> ~1.2em
          const ar = a.getBoundingClientRect();
          const cs = chip ? getComputedStyle(chip) : null;
          const cr = chip?.getBoundingClientRect();
          out.push({
            state: WANT[a.getAttribute('href').slice(-2)],
            title: t.textContent,
            titleW: t.getBoundingClientRect().width,
            titleLines: Math.round(t.getBoundingClientRect().height / lh),
            titleClipped: t.scrollHeight > t.clientHeight + 1,
            rowW: ar.width,
            rowH: ar.height,
            chip: chip ? { text: chip.textContent, h: cr.height, r: cs.borderTopLeftRadius, visible: cr.width > 0 && cs.visibility !== 'hidden' } : null,
            imgs: [...a.querySelectorAll('img')].map((i) => ({ broken: i.complete && i.naturalWidth === 0 })),
            ph: ph ? { w: ph.getBoundingClientRect().width, h: ph.getBoundingClientRect().height } : null,
          });
        }
        return { rows: out, docOver: document.scrollingElement.scrollWidth - innerWidth };
      });
      const f = [];
      const tag = `${w}x${h}`;
      if (m.rows.length !== 4) f.push(`${tag}: ${m.rows.length} rows rendered, want 4`);
      if (thumbs === 0) f.push(`${tag}: no thumbnail was requested, so the broken-image case tested nothing`);
      const long = m.rows.find((r) => r.title === LONG_TITLE);
      if (!long) f.push(`${tag}: the long title is not listed`);
      else {
        if (long.titleW < long.rowW * 0.6) f.push(`${tag}: the title gets ${long.titleW.toFixed(0)}px of a ${long.rowW.toFixed(0)}px row`);
        if (long.titleLines < 2) f.push(`${tag}: the long title is on ${long.titleLines} line(s), want 2`);
        if (long.titleLines > 2) f.push(`${tag}: the long title runs to ${long.titleLines} lines, want at most 2`);
      }
      for (const r of m.rows) {
        const rt = `${tag} [${r.state}] "${r.title}"`;
        if (r.rowH < 44) f.push(`${rt}: row is ${r.rowH.toFixed(1)}px tall`);
        for (const i of r.imgs) if (i.broken) f.push(`${rt}: a broken <img> is still on the page`);
        if (r.state === 'failed') {
          if (!r.chip || r.chip.text !== 'Failed' || !r.chip.visible) f.push(`${rt}: no visible "Failed" chip (${JSON.stringify(r.chip)})`);
          if (r.imgs.length) f.push(`${rt}: a failed song shows a video still`);
          if (/https?:/.test(r.title)) f.push(`${rt}: the title is the raw URL`);
        } else if (r.state === 'processing') {
          if (!r.chip || r.chip.text !== 'Processing') f.push(`${rt}: no "Processing" chip`);
        } else if (r.chip) f.push(`${rt}: a ${r.state} song carries a chip "${r.chip.text}"`);
        if (r.chip && (Math.abs(r.chip.h - 22) > 0.5 || parseFloat(r.chip.r) < 11)) f.push(`${rt}: chip is ${r.chip.h}px tall, radius ${r.chip.r} (want a 22px pill)`);
      }
      // Every linked song (all but the upload) had its thumbnail fail: each must have a stand-in.
      for (const r of m.rows.filter((x) => x.title !== 'take-5.mp3')) {
        if (!r.ph) f.push(`${tag} [${r.state}] "${r.title}": no placeholder where the thumbnail failed`);
        else if (Math.abs(r.ph.w - 64) > 0.5 || Math.abs(r.ph.h - 36) > 0.5) f.push(`${tag}: placeholder is ${r.ph.w}x${r.ph.h}, want 64x36`);
      }
      if (m.docOver > 0) f.push(`${tag}: the page scrolls sideways by ${m.docOver}px`);
      assert.deepEqual(errors, [], 'the page threw');
      if (f.length) assert.fail(`GATE-FAIL ${f.length}:\n  ${f.join('\n  ')}`);
    } finally {
      await ctx.close();
    }
  });
}

test('teardown', async () => {
  if (browser) await browser.close();
});
