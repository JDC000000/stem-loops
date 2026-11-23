#!/usr/bin/env node
// US 3.4 / V3-J3: chord-change display latency versus audio (budget: p95 <= 50 ms).
//
//   node scripts/measure-chord-sync-latency.mjs [--out results.json] [--slugs a,b,c] [--cpu 4] [--max-sec N]
//
// NOT part of required CI. It plays three real songs' worth of real time
// (about 10 minutes at 1x) in Chromium; it is a measurement, run by hand.
//
// What runs: the PRODUCTION modules, bundled unchanged: the play engine, the device rule, the
// phone output route (MediaStream -> <audio>), `routeLatencySec`, the real PlayerView and the
// real ChordOverlay phone stage, fed by the REAL chord loader from each demo song's
// `play-chords` JSON (apps/web/test/fixtures/demo-chords). Only the audio bytes are synthetic
// (six silent Opus stems of the song's length: the demo audio lives in R2 and is not reachable
// from here). The engine position is the AudioContext clock whatever the audio contains, so the
// clock is the same as for the real stems; decode cost differs (see the doc).
//
// How a change is timed: a MutationObserver on the document reads the stage's Now-chord element
// (`playhead-now-name`) in the microtask after every DOM mutation. When its text changes, the
// observer records performance.now(), ctx.currentTime, ctx.getOutputTimestamp() and the engine's
// raw position, all in the same task. The expected change time is the chord segment's start_sec
// (the chord the audio reaches at that buffer position), matched to the nearest segment start.
//
//   lag_render = (rawPos - start_sec)            how far past the segment start the AudioContext
//                                                 render clock was when the DOM changed
//   lag_heard  = (heardPos - start_sec)          the same against the sample leaving the output,
//                                                 using getOutputTimestamp() (includes the
//                                                 context's output latency)
//   lag_heard_route = lag_heard - 17.5 ms        phone route only: also subtracts the measured
//                                                 MediaStream -> <audio> hop (docs/perf mobile-player
//                                                 2026-11-15 latency.json median), which no JS clock exposes
// Positive = the chord appeared AFTER the sound (late); negative = BEFORE it (early). The budget
// is on the absolute value. "+frame" adds one 60 Hz frame (16.7 ms), the worst case between the
// DOM change and the pixels, which headless Chromium cannot observe.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const esbuild = require('esbuild');

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(process.env.CHORD_GATE_SRC ?? join(HERE, '../../../apps/web'));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', join(tmpdir(), 'chord-sync-latency.json'));
const SLUGS = opt('slugs', 'lucky-ticket,im-asking-you,offline').split(',');
const CPU = Number(opt('cpu', 4));
const MAX_SEC = Number(opt('max-sec', 0)); // 0 = whole song
const ROUTE_HOP_MS = 17.5; // measured median, Pixel 7 / iPhone 14 emulated, 24 kHz: mobile-player-2026-11-15.latency.json
const FRAME_MS = 1000 / 60;
const BUDGET_MS = 50;
const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];

const FONT_DIR = join(dirname(require.resolve('@fontsource/inter/package.json')), 'files');
const FONT_CSS = [400, 500, 600, 700].map((w) => `@font-face{font-family:GateInter;font-weight:${w};src:url(/font-${w}.woff2) format('woff2')}`).join('')
  + '[data-testid="chord-overlay"]{font-family:GateInter,sans-serif !important}';

async function bundle() {
  const res = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { PlayerView, LATENCY_RESAMPLE_MS } from './src/components/play/Player.tsx';
        import { createPlayEngine } from './src/lib/play/engine.ts';
        import { playbackProfile, readDeviceSignals } from './src/lib/play/device-support.ts';
        import { createBackgroundOutput, routeLatencySec } from './src/lib/play/background-audio.ts';
        import './src/app/globals.css';
        const noop = () => {};
        const root = createRoot(document.getElementById('root'));
        window.__events = [];
        window.__setup = (bytes) => {
          const profile = playbackProfile(readDeviceSignals(globalThis));
          const output = profile.backgroundOutput ? createBackgroundOutput(document, {}) : null;
          const engine = createPlayEngine({
            decodeSampleRate: profile.decodeSampleRate,
            createAudioContext: (o) => { const c = new AudioContext({ sampleRate: o.sampleRate }); window.__ctx = c; return c; },
            ...(output ? { createOutput: output.createOutput } : {}),
          });
          window.__engine = engine; window.__output = output; window.__profile = profile;
          let latency = 0;
          const render = (snapshot) => root.render(React.createElement(PlayerView, {
            jobId: 'sync-latency', phase: { kind: 'ready' }, snapshot, chordLatencySec: latency,
            sections: window.__sections, beatGrid: window.__grid, lightAudio: profile.reason !== null,
            onPlay: noop, onPause: noop, onSeek: noop, onGain: noop, onMute: noop, onSolo: noop, onLoop: noop,
          }));
          // Same wiring as Player.tsx (refreshLatency / resample): read on the playing edge, on 'running', and after 250 ms and 1 s.
          const refresh = () => {
            if (engine.getSnapshot().status !== 'playing') return;
            latency = routeLatencySec(engine.audioLatency?.(), !!output?.routed);
            window.__latency = latency;
            render(engine.getSnapshot());
          };
          engine.onAudioStateChange?.((s) => { if (s === 'running') refresh(); });
          let was = false; let resample = [];
          engine.subscribe((s) => {
            render(s);
            const playing = s.status === 'playing';
            if (was && !playing) output?.pause();
            if (playing && !was) { refresh(); if (output) { resample.forEach(clearTimeout); resample = LATENCY_RESAMPLE_MS.map((ms) => setTimeout(refresh, ms)); } }
            was = playing;
          });
          return engine.load(bytes).then(() => { render(engine.getSnapshot()); const s = engine.getSnapshot(); return { status: s.status, durationSec: s.durationSec, error: s.error && s.error.code, rate: engine.sampleRate, reason: profile.reason, routed: !!(output && output.routed) }; });
        };
        window.__observe = () => {
          let last = null;
          const ctx = () => window.__ctx;
          const mo = new MutationObserver(() => {
            const el = document.querySelector('[data-testid="playhead-now-name"]');
            const text = el ? el.textContent : null;
            if (text === last) return;
            last = text;
            const e = window.__engine; const c = ctx();
            if (!e || !c || e.getSnapshot().status !== 'playing') return;
            const perf = performance.now();
            const ct = c.currentTime;
            const rawPos = e.getSnapshot().positionSec;
            const ts = c.getOutputTimestamp ? c.getOutputTimestamp() : null;
            const ev = { text, perf, ct, rawPos, ctxPerf: ts && ts.performanceTime, ctxOut: ts && ts.contextTime, outLat: c.outputLatency, baseLat: c.baseLatency, comp: window.__latency || 0 };
            window.__events.push(ev);
            requestAnimationFrame(() => { ev.rafPerf = performance.now(); });
          });
          mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        };
        window.__play = () => { window.__output && window.__output.play(); window.__engine.play(); };
        window.__pos = () => { const s = window.__engine.getSnapshot(); return { status: s.status, pos: s.positionSec }; };`,
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
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.onnx': 'empty', '.wasm': 'empty' },
    logLevel: 'silent',
    plugins: [{
      name: 'stub-sentry',
      setup(b) {
        b.onResolve({ filter: /^@sentry\/nextjs$/ }, () => ({ path: 's', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export function captureMessage() {}', loader: 'js' }));
      },
    }],
  });
  return { js: res.outputFiles.find((f) => f.path.endsWith('.js')).text, css: res.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '' };
}

function makeStems(dir, durSec) {
  const out = {};
  STEMS.forEach((s) => {
    const f = join(dir, `${s}-${Math.ceil(durSec)}.opus`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', String(Math.ceil(durSec) + 1), '-c:a', 'libopus', '-b:a', '32k', f]);
    out[s] = readFileSync(f);
  });
  return out;
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
function stats(v) {
  const abs = v.map(Math.abs);
  return { n: v.length, signed_p50: r1(pct(v, 50)), signed_min: r1(Math.min(...v)), signed_max: r1(Math.max(...v)), abs_p50: r1(pct(abs, 50)), abs_p95: r1(pct(abs, 95)), abs_max: r1(Math.max(...abs)) };
}

/** Pair each DOM change with the nearest chord segment start (one event per segment). */
function analyse(D, events, extraMs) {
  const starts = D.segments.map((s) => s.start_sec);
  const rows = [];
  const used = new Set();
  let unmatchedEvents = 0;
  for (const e of events) {
    const heardPos = e.rawPos - (e.ct - e.ctxOut - (e.perf - e.ctxPerf) / 1000);
    const heardOk = Number.isFinite(heardPos) && e.ctxPerf > 0;
    // The segment the audio has most recently entered (last start <= the render clock), one match per segment.
    // A DOM change is a reaction to a boundary already passed, so "nearest" would pair it with the next one.
    let k = -1;
    starts.forEach((st, i) => { if (i > 0 && st <= e.rawPos) k = i; });
    if (k < 0 || used.has(k) || e.rawPos - starts[k] > 1.0) { unmatchedEvents += 1; continue; }
    used.add(k);
    const s = starts[k];
    rows.push({
      seg: k, label: D.segments[k].label, start: s,
      lag_render: (e.rawPos - s) * 1000,
      lag_heard: heardOk ? (heardPos - s) * 1000 : null,
      lag_heard_route: heardOk ? (heardPos - s) * 1000 - extraMs : null,
      comp_ms: e.comp * 1000,
      raf_after_ms: e.rafPerf ? e.rafPerf - e.perf : null,
    });
  }
  // A segment shows no change when its label equals the previous one's (or it is shorter than a frame): count the ones that should have.
  const shouldChange = D.segments.filter((s, i) => i > 0 && s.label !== D.segments[i - 1].label).length;
  return { rows, unmatchedEvents, shouldChange, matched: rows.length };
}

const built = await bundle();
const work = mkdtempSync(join(tmpdir(), 'chord-sync-'));
const device = (({ defaultBrowserType, ...d }) => d)(devices['Pixel 7']);
const browser = await chromium.launch({ headless: true, channel: process.env.CHROME_CHANNEL ?? 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const result = { when: new Date().toISOString(), cpuThrottle: CPU, viewport: '390x844', profile: 'Pixel 7 (emulated, viewport 390x844)', browserVersion: browser.version(), budgetMs: BUDGET_MS, routeHopMs: ROUTE_HOP_MS, songs: {} };
const all = { render: [], heard: [], heard_route: [] };
const allFrame = { render: [], heard: [], heard_route: [] };

for (const slug of SLUGS) {
  const D = JSON.parse(readFileSync(join(WEB, 'test/fixtures/demo-chords', `${slug}.json`), 'utf8'));
  const grid = { beatSec: 60 / D.bpm, anchorSec: D.sections[0].start_sec, measured: true };
  const sections = D.sections.map((s) => ({ startSec: s.start_sec, endSec: s.end_sec, label: s.label }));
  const payload = { key: null, provider: 'klangio', provider_version: 'demo', duration_sec: D.duration_sec, model_ms: 1, segments: D.segments.map((s) => ({ ...s, confidence: 1 })) };
  const stems = makeStems(work, D.duration_sec);
  const ctx = await browser.newContext({ ...device, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('http://gate.test/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + `<link rel="stylesheet" href="/out.css"><style>${FONT_CSS}</style></head><body><main style="max-width:960px;margin:0 auto;padding:24px 16px 96px"><div id="root"></div></main>`
        + '<script>try{localStorage.setItem("sl.play.chordMode.v1","detailed")}catch(e){}</script>'
        + `<script>window.__sections=${JSON.stringify(sections)};window.__grid=${JSON.stringify(grid)};</script>`
        + '<script>Promise.all([400,500,600,700].map(function(w){return document.fonts.load(w+" 16px GateInter")})).then(function(){var s=document.createElement("script");s.src="/out.js";document.body.appendChild(s)})</script></body></html>' });
    }
    const fm = /^\/font-(\d+)\.woff2$/.exec(u.pathname);
    if (fm) return route.fulfill({ contentType: 'font/woff2', body: readFileSync(join(FONT_DIR, `inter-latin-${fm[1]}-normal.woff2`)) });
    if (u.pathname === '/out.js') return route.fulfill({ contentType: 'text/javascript', body: built.js });
    if (u.pathname === '/out.css') return route.fulfill({ contentType: 'text/css', body: built.css });
    if (u.pathname.endsWith('/play-chords')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ signed_url: '/signed.json', expires_in_sec: 60 }) });
    if (u.pathname === '/signed.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://gate.test/');
  await page.waitForFunction(() => typeof window.__setup === 'function', null, { timeout: 30000 });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const b64 = Object.fromEntries(Object.entries(stems).map(([k, v]) => [k, v.toString('base64')]));
  const loaded = await page.evaluate(async (m) => {
    const bytes = Object.entries(m).map(([name, s]) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return { name, bytes: u.buffer }; });
    return window.__setup(bytes);
  }, b64);
  if (loaded.error || loaded.status === 'error') throw new Error(`${slug}: engine load failed ${JSON.stringify(loaded)}`);
  await page.waitForSelector('[data-testid="phone-chords"]', { timeout: 30000 });
  await page.evaluate(() => window.__observe());
  await page.evaluate(() => window.__play());
  const t0 = Date.now();
  const limit = (MAX_SEC > 0 ? MAX_SEC : D.duration_sec) + 20;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const p = await page.evaluate(() => window.__pos());
    if (p.status !== 'playing' || (MAX_SEC > 0 && p.pos >= MAX_SEC) || Date.now() - t0 > limit * 1000) break;
  }
  const events = await page.evaluate(() => window.__events);
  const env = await page.evaluate(() => ({ ua: navigator.userAgent, profileReason: window.__profile.reason, routed: !!(window.__output && window.__output.routed), rate: window.__engine.sampleRate, outputLatency: window.__ctx.outputLatency, baseLatency: window.__ctx.baseLatency, compSec: window.__latency }));
  await ctx.close();

  const maxPos = MAX_SEC > 0 ? MAX_SEC : Infinity;
  const evs = events.filter((e) => e.rawPos <= maxPos);
  const a = analyse(D, evs, ROUTE_HOP_MS);
  const col = (k) => a.rows.map((r) => r[k]).filter((x) => x !== null);
  const song = {
    durationSec: D.duration_sec, segments: D.segments.length, domChanges: evs.length, matched: a.matched, shouldHaveChanged: a.shouldChange, unmatchedDomChanges: a.unmatchedEvents,
    env, pageErrors: errors,
    render: stats(col('lag_render')), heard: col('lag_heard').length ? stats(col('lag_heard')) : null, heard_route: col('lag_heard_route').length ? stats(col('lag_heard_route')) : null,
    render_plus_frame: stats(col('lag_render').map((x) => x + FRAME_MS)), heard_route_plus_frame: col('lag_heard_route').length ? stats(col('lag_heard_route').map((x) => x + FRAME_MS)) : null,
    rows: a.rows.map((r) => ({ seg: r.seg, label: r.label, start: r.start, render: r1(r.lag_render), heard: r1(r.lag_heard), heard_route: r1(r.lag_heard_route) })),
  };
  result.songs[slug] = song;
  for (const r of a.rows) {
    all.render.push(r.lag_render); allFrame.render.push(r.lag_render + FRAME_MS);
    if (r.lag_heard !== null) { all.heard.push(r.lag_heard); allFrame.heard.push(r.lag_heard + FRAME_MS); all.heard_route.push(r.lag_heard_route); allFrame.heard_route.push(r.lag_heard_route + FRAME_MS); }
  }
  console.log(slug, JSON.stringify({ matched: a.matched, of: a.shouldChange, render: song.render, heard: song.heard, heard_route: song.heard_route, env }));
}
await browser.close();
result.overall = {
  render: stats(all.render), heard: all.heard.length ? stats(all.heard) : null, heard_route: all.heard_route.length ? stats(all.heard_route) : null,
  render_plus_frame: stats(allFrame.render), heard_route_plus_frame: all.heard_route.length ? stats(allFrame.heard_route) : null,
};
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log('overall', JSON.stringify(result.overall));
console.log('wrote', OUT);
