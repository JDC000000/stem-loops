#!/usr/bin/env node
// Route-latency measurement for the phone output path. See latency.html and
// docs/perf/mobile-player-2026-11-14.md ("Chord sync on the phone route").
//   node scripts/perf/mobile-player/latency.mjs [--reps 10] [--out file.json]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const REPS = Number(opt('reps', 10));
const req = createRequire(import.meta.url);
const { chromium, devices } = req(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const html = fs.readFileSync(path.join(here, 'latency.html'));
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); }).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const PROFILES = { 'Pixel 7 (emulated)': devices['Pixel 7'],
  'iPhone 14 (emulated on Chromium)': (({ defaultBrowserType, ...d }) => d)(devices['iPhone 14']) };
const rows = [];
for (const [profile, desc] of Object.entries(PROFILES)) for (const rate of [24000, 48000]) {
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome',
    args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext(desc)).newPage();
  await page.goto(base);
  const res = await page.evaluate(([r, n]) => window.measure(r, n), [rate, REPS]);
  for (const x of res) rows.push({ profile, rate, ...x });
  const ok = res.filter((x) => x.transportMs != null).map((x) => x.transportMs).sort((a, b) => a - b);
  console.log(JSON.stringify({ profile, rate, n: ok.length, min: ok[0], median: ok[Math.floor(ok.length / 2)], max: ok.at(-1),
    outputLatencyA: res[0]?.outputLatencyA, baseLatencyA: res[0]?.baseLatencyA }));
  await browser.close();
}
server.close();
const OUT = opt('out', null);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), rows }, null, 2));
