#!/usr/bin/env node
/**
 * Story 8.1 — 360px sweep. Opens each non-player page at a 360 x 740 phone
 * viewport (touch, isMobile), reports any horizontal overflow and the elements
 * that cause it, and saves a full-page screenshot.
 *
 *   BASE=http://127.0.0.1:3000 node scripts/design/mobile-sweep-360.mjs [outDir]
 *
 * The job page is driven with mocked /api/jobs/:id responses (a processing job
 * and a done job), so no worker, database or storage is needed. Pages behind
 * sign-in (/account, /jobs/:id) redirect to /login without a session; the
 * 2026-11-14 run patched their getUser() call LOCALLY (never committed) to see
 * the signed-in layout — see docs/perf/mobile-player-2026-11-14.md, "360px sweep".
 *
 * Exit code 1 if any page overflows.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const req = createRequire(import.meta.url);
const { chromium } = req(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const BASE = (process.env.BASE ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const OUT = process.argv[2] ?? 'docs/design/screens-2026-11-14/mobile';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
fs.mkdirSync(OUT, { recursive: true });

const JOB = '00000000-0000-4000-8000-000000000360';
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const baseJob = {
  id: JOB, input_kind: 'youtube', youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  original_filename: 'A song with a fairly long title that has to wrap on a phone (live at the venue, 2026 remaster).mp3',
  created_at: iso(now - 90_000), updated_at: iso(now - 5_000), expires_at: iso(now + 23 * 3600_000),
  input_trim_used_sec: 300, input_trim_source_sec: 372,
};
const processing = {
  ...baseJob, status: 'separating',
  events: [
    { stage: 'downloading', phase: 'started', pct: 5, created_at: iso(now - 80_000) },
    { stage: 'downloading', phase: 'completed', pct: 15, created_at: iso(now - 60_000) },
    { stage: 'separating', phase: 'started', pct: 40, created_at: iso(now - 50_000) },
  ],
};
const done = { ...baseJob, status: 'done', bpm: 120, musical_key: 'E minor', events: [], loops: [] };

const PAGES = [
  { name: 'landing', path: '/' },
  { name: 'sign-in', path: '/login' },
  { name: 'history-empty', path: '/history' },
  { name: 'history-entries', path: '/history', seedHistory: true },
  { name: 'account', path: '/account' },
  { name: 'account-nav-open', path: '/account', click: 'button[aria-controls="sin-menu"]' },
  { name: 'job-progress', path: `/jobs/${JOB}`, job: processing, waitFor: 'text=Processing' },
  { name: 'job-done-player-unsupported', path: `/jobs/${JOB}`, job: done, waitFor: '[data-testid="player-device-unsupported"]' },
  { name: 'pricing', path: '/pricing' },
  { name: 'terms', path: '/terms' },
  { name: 'privacy', path: '/privacy' },
  { name: 'not-found', path: '/no-such-page' },
];

const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome' });
const ctx = await browser.newContext({
  viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  // next dev needs eval, which the app's CSP (correctly) forbids; production builds do not.
  bypassCSP: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
});
let failed = 0;
const report = [];
async function sweep(p) {
  const page = await ctx.newPage();
  if (p.job) {
    await page.route(`**/api/jobs/${JOB}`, (r) => r.fulfill({ json: p.job, headers: { date: new Date().toUTCString() } }));
    await page.route(`**/api/jobs/${JOB}/**`, (r) => r.fulfill({ status: 404, json: { error: 'NOT_FOUND' } }));
  }
  if (p.seedHistory) {
    await page.addInitScript((id) => {
      const at = Date.now() - 3600_000;
      const ids = [id, '11111111-2222-4333-8444-555555555555', '66666666-7777-4888-8999-aaaaaaaaaaaa'];
      try { localStorage.setItem('stem-loops-history', JSON.stringify(ids.map((x, i) => ({ id: x, at: at - i * 600_000 })))); } catch {}
    }, JOB);
  }
  const res = await page.goto(BASE + p.path, { waitUntil: 'networkidle', timeout: 120_000 }).catch((e) => e);
  if (p.click) await page.click(p.click);
  if (p.waitFor) await page.waitForSelector(p.waitFor, { timeout: 120_000 });
  await page.waitForTimeout(800);
  const finalPath = new URL(page.url()).pathname;
  const info = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const sw = document.documentElement.scrollWidth;
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' && cs.visibility === 'hidden') continue;
      if (r.right > vw + 0.5 || r.left < -0.5) {
        let clipped = false;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          const o = getComputedStyle(a).overflowX;
          if (o === 'hidden' || o === 'auto' || o === 'scroll' || o === 'clip') { clipped = true; break; }
        }
        if (!clipped) bad.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''} [${Math.round(r.left)}..${Math.round(r.right)}]`);
      }
    }
    return { vw, sw, bad: bad.slice(0, 12) };
  });
  const overflow = info.sw > info.vw;
  if (overflow) failed++;

  const shot = path.join(OUT, `${p.name}-360.png`);
  await page.screenshot({ path: shot, fullPage: true });
  const row = { name: p.name, path: p.path, finalPath, status: res?.status?.() ?? String(res), ...info, overflow, shot };
  report.push(row);
  console.log(JSON.stringify(row));
  await page.close();
}
for (const p of PAGES) {
  if (ONLY && !ONLY.has(p.name)) continue;
  // A shared, memory-tight host can crash a renderer mid-sweep; one retry.
  try { await sweep(p); } catch (e) {
    console.error(`${p.name}: ${String(e.message).split('\n')[0]} — retrying once`);
    try { await sweep(p); } catch (e2) { failed++; report.push({ name: p.name, error: String(e2.message).split('\n')[0] }); }
  }
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'sweep-360.json'), JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
