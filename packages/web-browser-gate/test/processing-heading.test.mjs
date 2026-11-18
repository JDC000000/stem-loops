// REAL-BROWSER GATE: the processing page's <h1> stays on screen (QA A-04).
//
// QA track A (2026-11-18) found the processing page headed by the RAW URL in a
// centred 2xl <h1> with no wrapping: "ttps://www.youtube.com/watch?" was cut
// off on both edges at 390 px. This renders the real ProcessingHeading
// (src/components/ProcessingHeading.tsx) with the real CSS, inside the job
// page's own frame (JobView's <main>: max 960, centred column, the app gutter),
// at phone widths, for: a link job with no title yet, a 400-character
// unbroken title, and a long unbroken file name. For each it checks that:
//   * no part of the heading is outside the viewport or clipped (its box and
//     its scroll width), and the page does not scroll sideways;
//   * a link job with no title is headed by the short host/ID form, never by
//     anything that looks like a URL.
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

const CASES = [
  { name: 'link job, no title yet', job: { title: null, original_filename: null, youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1' }, noUrl: true },
  { name: 'short link with tracking, no title yet', job: { title: null, original_filename: null, youtube_url: 'https://youtu.be/dQw4w9WgXcQ?si=abc123abc123abc123' }, noUrl: true },
  { name: '400-character unbroken title', job: { title: 'W'.repeat(400), original_filename: null, youtube_url: 'https://youtu.be/dQw4w9WgXcQ' } },
  { name: 'long unbroken file name', job: { title: null, original_filename: `${'my_song_final_master_v2_'.repeat(12)}.mp3`, youtube_url: null } },
];
const VIEWPORTS = [[360, 800], [390, 844], [844, 390]];

let browser;
let built;
test('Chromium launches and the real ProcessingHeading bundles', async () => {
  const res = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ProcessingHeading } from './src/components/ProcessingHeading.tsx';
        import './src/app/globals.css';
        createRoot(document.getElementById('root')).render(React.createElement(ProcessingHeading, { job: window.__job }));`,
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

for (const [w, h] of VIEWPORTS) {
  test(`A-04 processing heading @ ${w}x${h}: stays on screen for every case`, async () => {
    assert.ok(browser && built, 'setup test did not run or failed');
    const f = [];
    for (const c of CASES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < h, hasTouch: w < h });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.route('http://gate.test/**', async (route) => {
        const u = new URL(route.request().url());
        if (u.pathname === '/')
          return route.fulfill({ contentType: 'text/html', body:
            '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<link rel="stylesheet" href="/out.css"></head><body>' +
            // JobView's own <main> (the `wrap` style), with the "Processing…" line under the heading.
            '<main style="max-width:960px;margin:0 auto;padding:48px var(--sl-gutter,16px) 96px;font-family:var(--font-sans);display:flex;flex-direction:column;align-items:center;gap:28px">' +
            '<div id="root" style="display:contents"></div><p style="margin:-16px 0 0">Processing…</p></main>' +
            `<script>window.__job=${JSON.stringify(c.job)};</script><script src="/out.js"></script></body></html>` });
        if (u.pathname === '/out.js') return route.fulfill({ contentType: 'text/javascript', body: built.js });
        if (u.pathname === '/out.css') return route.fulfill({ contentType: 'text/css', body: built.css });
        return route.fulfill({ status: 404, body: '' });
      });
      try {
        await page.goto('http://gate.test/');
        await page.waitForSelector('[data-testid="job-heading"]', { timeout: 30000 });
        const m = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="job-heading"]');
          const r = el.getBoundingClientRect();
          const rg = document.createRange();
          rg.selectNodeContents(el);
          const t = rg.getBoundingClientRect();
          return {
            text: el.textContent,
            box: { l: r.left, r: r.right },
            ink: { l: t.left, r: t.right },
            over: el.scrollWidth - el.clientWidth,
            docOver: document.scrollingElement.scrollWidth - innerWidth,
            vw: innerWidth,
          };
        });
        const tag = `${w}x${h} ${c.name}`;
        const E = 0.5;
        if (m.box.l < -E || m.box.r > m.vw + E) f.push(`${tag}: heading box ${m.box.l.toFixed(1)}–${m.box.r.toFixed(1)} is outside the ${m.vw}px viewport`);
        if (m.ink.l < -E || m.ink.r > m.vw + E) f.push(`${tag}: heading text ${m.ink.l.toFixed(1)}–${m.ink.r.toFixed(1)} runs off the ${m.vw}px viewport`);
        if (m.over > 0) f.push(`${tag}: heading overflows its own box by ${m.over}px`);
        if (m.docOver > 0) f.push(`${tag}: the page scrolls sideways by ${m.docOver}px`);
        if (c.noUrl && /https?:|\/\/|www\.|\?/.test(m.text)) f.push(`${tag}: the heading shows a URL: "${m.text}"`);
        if (!m.text.trim()) f.push(`${tag}: the heading is empty`);
        assert.deepEqual(errors, [], 'the page threw');
      } finally {
        await ctx.close();
      }
    }
    if (f.length) assert.fail(`GATE-FAIL ${f.length}:\n  ${f.join('\n  ')}`);
  });
}

test('teardown', async () => {
  if (browser) await browser.close();
});
