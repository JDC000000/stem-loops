#!/usr/bin/env node
/**
 * Mobile player memory/decode measurement (Story 8.3). See
 * docs/perf/mobile-player-2026-11-14.md for method and caveats.
 *
 *   node scripts/perf/mobile-player/measure.mjs [--reps 3] [--out results.json]
 *
 * Needs: ffmpeg, a Chromium-family browser Playwright can drive (CHROME_CHANNEL,
 * default "chrome"), Linux /proc (for renderer VmHWM/VmRSS), and permission to
 * write /proc/<pid>/clear_refs. PLAYWRIGHT_MODULE overrides where `playwright`
 * is imported from. Generated audio goes to a temp dir and is never committed.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const REPS = Number(opt('reps', 3));
const OUT = opt('out', path.join(os.tmpdir(), 'mobile-player-results.json'));

const req = createRequire(import.meta.url);
const { chromium, devices } = req(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

// ── 1. audio: six stereo Ogg/Opus stems per duration, ~64 kb/s like production ──
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slmob-'));
const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const DURS = [300, 120];
for (const d of DURS) {
  fs.mkdirSync(path.join(work, 'audio', String(d)), { recursive: true });
  STEMS.forEach((s, i) => {
    execFileSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', `anoisesrc=d=${d}:c=pink:r=48000:a=0.2:seed=${i + 1}`,
      '-f', 'lavfi', '-i', `sine=f=${110 * (i + 1)}:d=${d}:r=48000`,
      '-filter_complex', '[0][1]amerge=inputs=2[a]', '-map', '[a]', '-ac', '2',
      '-c:a', 'libopus', '-b:a', '64k', path.join(work, 'audio', String(d), `${s}.opus`)]);
  });
}

// ── 2. bundle the production engine, unchanged ──
const esbuild = req(req.resolve('esbuild', { paths: [path.join(repo, 'apps/web'), repo,
  ...fs.readdirSync(path.join(repo, 'node_modules/.pnpm')).filter((d) => d.startsWith('esbuild@'))
    .map((d) => path.join(repo, 'node_modules/.pnpm', d, 'node_modules'))] }));
esbuild.buildSync({ entryPoints: [path.join(repo, 'apps/web/src/lib/play/engine.ts')], bundle: true,
  format: 'iife', globalName: 'SL', outfile: path.join(work, 'engine.bundle.js'), target: 'es2020', logLevel: 'error' });
fs.copyFileSync(path.join(here, 'harness.html'), path.join(work, 'index.html'));

// ── 3. static server ──
const server = http.createServer((q, r) => {
  const f = path.join(work, decodeURIComponent(new URL(q.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!f.startsWith(work) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'audio/ogg' });
  fs.createReadStream(f).pipe(r);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

// ── 4. /proc helpers (KiB -> MiB) ──
const status = (pid) => Object.fromEntries(fs.readFileSync(`/proc/${pid}/status`, 'utf8').split('\n')
  .filter((l) => /^Vm(HWM|RSS)/.test(l)).map((l) => [l.split(':')[0], Number(l.split(/\s+/)[1]) / 1024]));
const resetHwm = (pid) => fs.writeFileSync(`/proc/${pid}/clear_refs`, '5');

const PROFILES = {
  'Desktop Chrome (baseline)': { viewport: { width: 1280, height: 800 } },
  'Pixel 7 (emulated)': devices['Pixel 7'],
  'iPhone 14 (emulated on Chromium)': (({ defaultBrowserType, ...d }) => d)(devices['iPhone 14']),
};
const RATES = [48000, 24000];

const rows = [];
for (const [profile, desc] of Object.entries(PROFILES)) {
  for (const dur of DURS) for (const rate of RATES) for (let rep = 0; rep < REPS; rep++) {
    const availMiB = Math.round(Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)[1]) / 1024);
    let browser;
    try {
    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome',
      args: ['--autoplay-policy=no-user-gesture-required', '--js-flags=--expose-gc',
        '--disable-features=SpareRendererForSitePerProcess'] });
    const ctx = await browser.newContext(desc);
    const page = await ctx.newPage();
    await page.goto(base);
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const renderers = processInfo.filter((p) => p.type === 'renderer');
    if (renderers.length !== 1) throw new Error(`expected 1 renderer, got ${renderers.length}`);
    const pid = renderers[0].id;
    const pcdp = await ctx.newCDPSession(page);
    await pcdp.send('Performance.enable');
    const env = await page.evaluate(() => window.env());
    const encodedBytes = await page.evaluate((d) => window.fetchStems(d), dur);
    await page.evaluate(() => window.gc && window.gc());
    const before = status(pid);
    resetHwm(pid);
    const res = await page.evaluate((r) => window.runLoad(r), rate);
    const hwm = status(pid).VmHWM;
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.gc && window.gc());
    await page.waitForTimeout(500);
    const settled = status(pid).VmRSS;
    const m = Object.fromEntries((await pcdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    const pcmMiB = (6 * dur * rate * 4) / 2 ** 20;
    const row = { profile, dur, rate, rep, decodeMs: Math.round(res.ms), status: res.status, error: res.error,
      stemsReady: res.stems, encodedMiB: +(encodedBytes / 2 ** 20).toFixed(1), pcmMiB: +pcmMiB.toFixed(1),
      rssBeforeMiB: Math.round(before.VmRSS), hwmMiB: Math.round(hwm), settledMiB: Math.round(settled),
      jsHeapUsedMiB: +(m.JSHeapUsedSize / 2 ** 20).toFixed(1), env };
    rows.push(row);
    row.hostAvailMiB = availMiB;
    console.log(JSON.stringify({ ...row, env: undefined }));
    } catch (e) {
      // A renderer crash (e.g. the kernel OOM killer) is a RESULT, not a harness
      // failure: record it with the host's free memory and carry on.
      const row = { profile, dur, rate, rep, crashed: String(e.message ?? e).split('\n')[0], hostAvailMiB: availMiB };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    await browser?.close().catch(() => {});
  }
}
server.close();
fs.rmSync(work, { recursive: true, force: true });
fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), host: { cpus: os.cpus().length,
  cpuModel: os.cpus()[0]?.model, memMiB: Math.round(os.totalmem() / 2 ** 20) }, rows }, null, 2));
console.log(`wrote ${OUT}`);
