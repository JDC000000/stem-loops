#!/usr/bin/env node
/**
 * Two-products nav audit (2026-11-15). For every page, signed OUT and signed IN, at 1280 and
 * 390 px: which header renders, whether "Download loops" is in it, which item is current, and
 * whether the page sells loop/stem downloads. Saves a screenshot per cell.
 *
 *   BASE=http://127.0.0.1:3000 node scripts/design/nav-audit.mjs [outDir]
 *
 * Signed-in pages need a session. There is no test login here (no auth flows from agents), so
 * the 2026-11-15 run used the same LOCAL, NEVER-COMMITTED patch as the 2026-11-14 360px sweep:
 * getUser() answers from an `audit_user=1` cookie. Without that patch the signed-in column
 * shows what a signed-out visitor sees. The job page is fed a mocked done job.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const req = createRequire(import.meta.url);
const { chromium } = req(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const BASE = (process.env.BASE ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const OUT = process.argv[2] ?? 'docs/design/screens-2026-11-15/nav';
fs.mkdirSync(OUT, { recursive: true });

const JOB = '00000000-0000-4000-8000-000000000415';
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const done = {
  id: JOB, input_kind: 'upload', original_filename: 'lucky-ticket.mp3', status: 'done', bpm: 102, musical_key: 'G minor',
  created_at: iso(now - 3600_000), updated_at: iso(now - 3500_000), expires_at: iso(now + 20 * 3600_000), events: [], loops: [],
};

const PAGES = [
  ['landing', '/'],
  ['pricing', '/pricing'],
  ['privacy', '/privacy'],
  ['terms', '/terms'],
  ['sign-in', '/login'],
  ['history', '/history'],
  ['account', '/account'],
  ['job', `/jobs/${JOB}`],
  ['loops', '/loops'],
  ['not-found', '/no-such-page'],
];
// Phrases that sell loop or stem downloads. The landing must carry none of them.
const SELLING = /download (the )?loops|take the loops home|loop files?|bar-length loops|24-bit wav|\.wav\b|cut and download/i;

const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome' });
const rows = [];
for (const signedIn of [false, true]) {
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({
      viewport: { width, height: width > 500 ? 900 : 844 },
      deviceScaleFactor: 1,
      isMobile: width < 500,
      hasTouch: width < 500,
      bypassCSP: true, // next dev needs eval; production builds do not
    });
    // audit_user drives the patched getUser(); the sb-*-auth-token cookie is what the static
    // pages' label hint looks for (a real session sets one).
    if (signedIn) await ctx.addCookies([{ name: 'audit_user', value: '1', url: BASE }, { name: 'sb-audit-auth-token', value: 'x', url: BASE }]);
    for (const [name, p] of PAGES) {
      const page = await ctx.newPage();
      await page.route(`**/api/jobs/${JOB}`, (r) => r.fulfill({ json: done }));
      await page.route(`**/api/jobs/${JOB}/**`, (r) => r.fulfill({ status: 404, json: { error: 'NOT_FOUND' } }));
      await page.route('**/api/history**', (r) => r.fulfill({ json: { jobs: [] } }));
      await page.route('**/api/entitlements**', (r) => r.fulfill({ json: { plan: 'free' } }));
      let status = 0;
      try {
        const res = await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 60_000 });
        status = res?.status() ?? 0;
      } catch (e) {
        status = -1;
      }
      await page.waitForTimeout(400);
      const info = await page.evaluate((sellingSrc) => {
        const header = document.querySelector('header');
        const kind = document.querySelector('.sin-bar') ? 'top-nav' : document.querySelector('.site-header') ? 'SiteHeader (old)' : header ? 'other' : 'none';
        const items = [...(header?.querySelectorAll('a') ?? [])].map((a) => a.textContent.trim()).filter(Boolean);
        const current = [...(header?.querySelectorAll('[aria-current="page"]') ?? [])].map((a) => a.textContent.trim());
        const tag = document.querySelector('[data-testid="sin-product"]')?.textContent.trim() ?? '';
        const main = document.querySelector('main')?.innerText ?? document.body.innerText;
        const sells = (main.match(new RegExp(sellingSrc, 'gi')) ?? []).slice(0, 4);
        const overflow = document.documentElement.scrollWidth > window.innerWidth;
        return { kind, items, current, tag, sells, overflow };
      }, SELLING.source);
      const file = `${name}-${signedIn ? 'in' : 'out'}-${width}.png`;
      await page.screenshot({ path: path.join(OUT, file), fullPage: false });
      if (width < 500 && name === 'landing') {
        const t = page.locator('button[aria-controls="sin-menu"]');
        if (await t.count()) {
          await t.click();
          await page.waitForTimeout(150);
          await page.screenshot({ path: path.join(OUT, `landing-${signedIn ? 'in' : 'out'}-390-menu-open.png`) });
        }
      }
      rows.push({ page: name, path: p, session: signedIn ? 'in' : 'out', width, status, url: page.url().replace(BASE, ''), ...info });
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();

const md = [
  '| page | session | width | status → url | header | items | current | tag | loop-selling phrases in main | h-overflow |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) =>
    `| ${r.page} | ${r.session} | ${r.width} | ${r.status} → ${r.url} | ${r.kind} | ${r.items.join(' · ')} | ${r.current.join(', ')} | ${r.tag} | ${r.sells.join('; ') || '—'} | ${r.overflow ? 'YES' : 'no'} |`,
  ),
].join('\n');
fs.writeFileSync(path.join(OUT, 'audit.md'), md + '\n');
console.log(md);
