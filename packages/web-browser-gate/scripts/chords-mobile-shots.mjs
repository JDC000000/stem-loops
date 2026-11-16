#!/usr/bin/env node
// Phone chord view screenshots (design record, Stories 3 and 4.8 on phones).
//
//   node scripts/chords-mobile-shots.mjs <outDir>
//
// Renders the REAL PlayerView (real ChordOverlay, real CSS) at 390x844 and
// 360x800, mobile + touch, fed the synthetic 4-minute two-chord-bar fixture
// (apps/web/test/fixtures/play-chords-4m-two-chord-bars.json) through the real
// loader, with the fixture's beat grid passed the way Player passes it from the
// job's loops rows. The playhead sits mid-song inside a two-chord bar.
// (The three design candidates were shot with an earlier revision of this
// script that passed ?chordview=lane|grid|focus; only the winner ships.)
// Also writes a reduced-motion shot per viewport.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const esbuild = require('esbuild');

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(process.env.CHORD_GATE_SRC ?? join(HERE, '../../../apps/web'));
const OUT = resolve(process.argv[2] ?? 'shots');
const FONT_DIR = join(dirname(require.resolve('@fontsource/inter/package.json')), 'files');
const FONT_CSS =
  [400, 500, 600, 700].map((w) => `@font-face{font-family:GateInter;font-weight:${w};src:url(/font-${w}.woff2) format('woff2')}`).join('') +
  '[data-testid="chord-overlay"]{font-family:GateInter,sans-serif !important}';

const FIX = JSON.parse(readFileSync(join(WEB, 'test/fixtures/play-chords-4m-two-chord-bars.json'), 'utf8'));
const GRID = { beatSec: 60 / FIX._fixture.bpm, anchorSec: FIX._fixture.anchor_sec, measured: true };
// '-no-tempo' shots pass no grid: the plain chord-sequence fallback.
const SECTIONS = FIX._fixture.sections;
const DURATION = FIX.duration_sec;
// Mid-song, beat 3 of a split bar in the second chorus (E:min7 | A:min).
const split = FIX.segments.filter((s) => s.label === 'A:min' && s.start_sec > 110)[0];
const POSITION = split.start_sec + 0.2;
const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];

async function bundle() {
  const res = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { PlayerView } from './src/components/play/Player.tsx';
        import './src/app/globals.css';
        const noop = () => {};
        createRoot(document.getElementById('root')).render(
          React.createElement(PlayerView, {
            jobId: 'shots-job', phase: { kind: 'ready' }, snapshot: window.__snap,
            sections: window.__sections, beatGrid: window.__grid,
            onPlay: noop, onPause: noop, onSeek: noop, onGain: noop, onMute: noop, onSolo: noop, onLoop: noop,
          }),
        );`,
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

const snap = {
  status: 'playing', positionSec: POSITION, durationSec: DURATION,
  stems: STEMS.map((name) => ({ name, availability: 'ready', gain: 0.8, muted: false, soloed: false, effectivelySilent: false })),
  loop: null, degraded: null, error: null,
};

const built = await bundle();
const browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
mkdirSync(OUT, { recursive: true });
for (const [variant, grid] of [['', GRID], ['-no-tempo', null]]) {
  for (const [w, h] of [[390, 844], [360, 800]]) {
    for (const reduced of variant ? [false] : [false, true]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: reduced ? 'reduce' : 'no-preference' });
      const page = await ctx.newPage();
      await page.route('http://shots.test/**', async (route) => {
        const u = new URL(route.request().url());
        if (u.pathname === '/')
          return route.fulfill({ contentType: 'text/html', body:
            '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            `<link rel="stylesheet" href="/out.css"><style>${FONT_CSS}</style></head><body>` +
            '<main style="max-width:960px;margin:0 auto;padding:24px var(--sl-gutter,16px) 96px"><div id="root"></div></main>' +
            `<script>window.__snap=${JSON.stringify(snap)};window.__sections=${JSON.stringify(SECTIONS)};window.__grid=${JSON.stringify(grid)};</script>` +
            '<script>Promise.all([400,500,600,700].map(function(w){return document.fonts.load(w+" 16px GateInter")})).then(function(){var s=document.createElement("script");s.src="/out.js";document.body.appendChild(s)})</script>' +
            '</body></html>' });
        const fm = /^\/font-(\d+)\.woff2$/.exec(u.pathname);
        if (fm) return route.fulfill({ contentType: 'font/woff2', body: readFileSync(join(FONT_DIR, `inter-latin-${fm[1]}-normal.woff2`)) });
        if (u.pathname === '/out.js') return route.fulfill({ contentType: 'text/javascript', body: built.js });
        if (u.pathname === '/out.css') return route.fulfill({ contentType: 'text/css', body: built.css });
        if (u.pathname.endsWith('/play-chords')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ signed_url: '/signed.json', expires_in_sec: 60 }) });
        if (u.pathname === '/signed.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(FIX) });
        return route.fulfill({ status: 404, body: '' });
      });
      await page.goto('http://shots.test/');
      await page.waitForSelector('[data-testid="phone-chords"]', { timeout: 30000 });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
      const name = `shipped${variant}-${w}x${h}${reduced ? '-reduced-motion' : ''}`;
      // What the phone shows once the user has scrolled to the chords.
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="chord-overlay"]');
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 56);
      });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
      writeFileSync(join(OUT, `${name}.png`), await page.screenshot());
      const layoutUsed = await page.evaluate(() => document.querySelector('[data-testid="phone-chords"]').dataset.mode);
      console.log(`${name}: mode=${layoutUsed}`);
      await ctx.close();
    }
  }
}
await browser.close();
