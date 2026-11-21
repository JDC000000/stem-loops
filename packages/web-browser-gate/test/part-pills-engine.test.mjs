// REAL-BROWSER GATE: the "my part" pills (Phase A D5; PR #331 review H1, L4, L5)
// driven by REAL touch input against the REAL WebAudioPlayEngine (a real
// AudioContext and real GainNodes), in real Chromium.
//
// WHAT IT CHECKS
//   1. A tap on Gtr: the guitar GainNode goes to 0.3, then 0 (muted), then 1;
//      the pill and the Mix label say so ("Guitar 30%", "Guitar muted", "Full song").
//   2. A long-press (a real CDP touch held 650 ms): Guitar is soloed — every
//      other GainNode goes to 0 — and the label says "Guitar solo". A tap on the
//      soloed pill ends the solo; it never mutes it (H1).
//   3. NEVER TOTAL SILENCE (H1): 80 seeded random taps and long-presses across
//      the pills, and after every one at least one GainNode is audibly above 0.
//   4. No restart and no reseek through all of it: no new buffer source is
//      started and the playhead never moves backwards (Stories 2.5 / 2.6).
//   5. L5: every pill's name and state fit inside the pill at 360 and 390 px,
//      with clearance from the edge ("Drums" is the widest name).
//
// HOW IT IS KEPT HONEST. It FAILS (does not skip) when Chromium or the page is
// missing, and it asserts the engine actually reached `playing` and that the
// gain nodes it reads exist, so a page that never loaded cannot pass.

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

/** A GainNode is "audible" above this (the ramps are setTargetAtTime: never exactly 0). */
const AUDIBLE = 0.05;
/** Settling time after a mix change: setTargetAtTime's time constant is ~10-20 ms. */
const SETTLE_MS = 250;

const ENTRY = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlayerView } from './src/components/play/Player.tsx';
import { WebAudioPlayEngine } from './src/lib/play/engine.ts';
import './src/app/globals.css';

const SR = 24000, SECS = 30;
function wav(freq) {
  const n = SR * SECS; const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * freq * i / SR) * 4000), true);
  return buf;
}
window.__starts = 0;
const engine = new WebAudioPlayEngine({
  createAudioContext: (opts) => {
    const ctx = new AudioContext(opts);
    const orig = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => { const s = orig(); const st = s.start.bind(s); s.start = (...a) => { window.__starts++; return st(...a); }; return s; };
    return ctx;
  },
});
window.__engine = engine;
window.__gains = () => Object.fromEntries(Array.from(engine.gains.entries()).map(([k, g]) => [k, g.gain.value]));
const NAMES = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const FREQ = { drums: 110, bass: 82, guitar: 330, keys: 440, vocals: 523, other: 660 };
const SECTIONS = [{ startSec: 0, endSec: 15, label: 'verse' }, { startSec: 15, endSec: 30, label: 'chorus' }];
function App() {
  const [snap, setSnap] = useState(engine.getSnapshot());
  const [phase, setPhase] = useState({ kind: 'loading' });
  useEffect(() => {
    const un = engine.subscribe((s) => { window.__snap = s; setSnap(s); });
    engine.load(NAMES.map((name) => ({ name, bytes: wav(FREQ[name]) }))).then(() => setPhase({ kind: 'ready' }));
    return un;
  }, []);
  return React.createElement(PlayerView, {
    jobId: 'pills-gate', phase, snapshot: snap, sections: SECTIONS, title: 'Pills gate',
    onPlay: () => engine.play(), onPause: () => engine.pause(), onSeek: (s) => engine.seek(s),
    onGain: (s, g) => engine.setGain(s, g), onMute: (s, m) => engine.setMute(s, m),
    onSolo: (s, m) => engine.setSolo(s, m), onLoop: (r) => engine.setLoop(r),
  });
}
createRoot(document.getElementById('root')).render(React.createElement(App));
`;

let browser = null;
let built = null;

test('setup: bundle the real PlayerView + WebAudioPlayEngine and launch Chromium', async () => {
  const res = await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: WEB, loader: 'js', sourcefile: 'pills-gate-entry.js' },
    bundle: true, write: false, outdir: 'out', format: 'iife', jsx: 'automatic',
    tsconfig: join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.onnx': 'empty', '.wasm': 'empty' },
    logLevel: 'error',
    plugins: [{
      name: 'stub-sentry',
      setup(b) {
        b.onResolve({ filter: /^@sentry\/nextjs$/ }, () => ({ path: 's', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export function captureMessage() {}', loader: 'js' }));
      },
    }],
  });
  built = { js: res.outputFiles.find((f) => f.path.endsWith('.js')).text, css: res.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '' };
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});

test.after(async () => {
  await browser?.close();
});

async function openPage(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('http://pills.test/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/')
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/out.css"></head><body><div id="root"></div><script src="/out.js"></script></body></html>' });
    if (u.pathname === '/out.js') return route.fulfill({ contentType: 'text/javascript', body: built.js });
    if (u.pathname === '/out.css') return route.fulfill({ contentType: 'text/css', body: built.css });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://pills.test/');
  await page.waitForFunction(() => window.__snap && window.__snap.status === 'ready', null, { timeout: 30_000 });
  await page.waitForSelector('[data-testid="part-pills"] button[data-stem="guitar"]', { timeout: 30_000 });
  return { ctx, page, errors };
}

const pill = (stem) => `[data-testid="part-pills"] button[data-stem="${stem}"]`;
const settle = (page) => page.waitForTimeout(SETTLE_MS);
const gains = (page) => page.evaluate(() => window.__gains());
const label = (page) => page.locator('[data-testid="transport-mix"] span:last-child').innerText();

async function longPress(page, stem) {
  const b = await page.locator(pill(stem)).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const pt = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
  await page.waitForTimeout(650);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('pills drive the real engine: tap 30% / muted / 100%, long-press solo, a tap ends a solo; no restart, no reseek', async () => {
  assert.ok(browser && built, 'setup did not run');
  const { ctx, page, errors } = await openPage(390, 844);
  try {
    await page.evaluate(() => window.__engine.play());
    await page.waitForFunction(() => window.__snap.status === 'playing', null, { timeout: 10_000 });
    await settle(page);
    const starts0 = await page.evaluate(() => window.__starts);
    assert.ok(starts0 >= 6, `the engine started ${starts0} sources`);
    const g0 = await gains(page);
    assert.deepEqual(Object.keys(g0).sort(), ['bass', 'drums', 'guitar', 'keys', 'other', 'vocals'], 'the gain nodes exist');
    assert.equal(await label(page), 'Full song');

    let lastPos = await page.evaluate(() => window.__snap.positionSec);
    const posForward = async (tag) => {
      const p = await page.evaluate(() => window.__snap.positionSec);
      assert.ok(p >= lastPos, `${tag}: the playhead went back (${lastPos} -> ${p})`);
      lastPos = p;
    };

    await page.tap(pill('guitar'));
    await settle(page);
    let g = await gains(page);
    assert.ok(Math.abs(g.guitar - 0.3) < 0.03, `tap 1: guitar gain ${g.guitar}, want 0.3`);
    assert.ok(g.bass > 0.95, 'the other stems are untouched');
    assert.equal(await page.locator(pill('guitar')).innerText().then((t) => t.replace(/\s+/g, ' ')), 'Gtr 30%');
    assert.equal(await label(page), 'Guitar 30%');
    await posForward('tap 1');

    await page.tap(pill('guitar'));
    await settle(page);
    g = await gains(page);
    assert.ok(g.guitar < 0.02, `tap 2: guitar gain ${g.guitar}, want 0 (muted)`);
    assert.equal(await label(page), 'Guitar muted');

    await page.tap(pill('guitar'));
    await settle(page);
    g = await gains(page);
    assert.ok(g.guitar > 0.95, `tap 3: guitar gain ${g.guitar}, want 1`);
    assert.equal(await label(page), 'Full song');
    await posForward('tap 3');

    await longPress(page, 'guitar');
    await settle(page);
    g = await gains(page);
    assert.ok(g.guitar > 0.95, `solo: guitar ${g.guitar}`);
    for (const s of ['drums', 'bass', 'keys', 'vocals', 'other']) assert.ok(g[s] < 0.02, `solo: ${s} still sounds (${g[s]})`);
    assert.equal(await label(page), 'Guitar solo', 'the release did not also step the level');
    assert.match(await page.locator(pill('guitar')).getAttribute('aria-label'), /^Guitar, solo/);

    // H1: a tap on the soloed pill ends the solo; it never mutes it.
    await page.tap(pill('guitar'));
    await settle(page);
    g = await gains(page);
    assert.ok(Object.values(g).every((v) => v > 0.95), `after un-solo every stem sounds: ${JSON.stringify(g)}`);
    assert.equal(await label(page), 'Full song');
    await posForward('un-solo');

    const starts1 = await page.evaluate(() => window.__starts);
    assert.equal(starts1, starts0, 'a mix change started new sources (a restart or reseek)');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('H1: never total silence — 80 seeded random taps and long-presses on the real engine always leave a stem sounding', async () => {
  assert.ok(browser && built, 'setup did not run');
  const { ctx, page, errors } = await openPage(390, 844);
  try {
    await page.evaluate(() => window.__engine.play());
    await page.waitForFunction(() => window.__snap.status === 'playing', null, { timeout: 10_000 });
    const starts0 = await page.evaluate(() => window.__starts);
    const stems = ['guitar', 'bass', 'keys', 'drums', 'vocals', 'other'];
    let seed = 331;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    let holds = 0;
    for (let step = 0; step < 80; step++) {
      const stem = stems[Math.floor(rnd() * stems.length)];
      const hold = rnd() < 0.3;
      if (hold) {
        holds++;
        await longPress(page, stem);
      } else {
        await page.tap(pill(stem));
      }
      await settle(page);
      const g = await gains(page);
      const loudest = Math.max(...Object.values(g));
      assert.ok(loudest > AUDIBLE, `step ${step} (${hold ? 'hold' : 'tap'} ${stem}): total silence ${JSON.stringify(g)}`);
    }
    assert.ok(holds >= 15, `only ${holds} long-presses in the sequence`);
    assert.equal(await page.evaluate(() => window.__starts), starts0, 'no restart through 80 mix changes');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('L5: every pill name and state fit inside the pill with clearance, at 360 and 390 ("Drums" is the widest)', async () => {
  assert.ok(browser && built, 'setup did not run');
  for (const [w, h] of [[360, 800], [390, 844]]) {
    const { ctx, page } = await openPage(w, h);
    try {
      const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="part-pills"] button')].map((b) => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        const inner = { l: r.left + parseFloat(cs.borderLeftWidth), r: r.right - parseFloat(cs.borderRightWidth) };
        return {
          stem: b.dataset.stem,
          spans: [...b.querySelectorAll('span')].filter((s) => s.textContent.trim()).map((s) => {
            const range = document.createRange();
            range.selectNodeContents(s);
            const t = range.getBoundingClientRect();
            return { text: s.textContent, left: t.left - inner.l, right: inner.r - t.right, clipped: s.scrollWidth > s.clientWidth + 0.5 };
          }),
        };
      }));
      assert.ok(rows.length >= 5, `${w}: ${rows.length} pills`);
      for (const row of rows)
        for (const s of row.spans) {
          assert.ok(!s.clipped, `${w}: "${s.text}" on ${row.stem} is clipped`);
          assert.ok(s.left >= 3 && s.right >= 3, `${w}: "${s.text}" on ${row.stem} sits ${s.left.toFixed(1)}/${s.right.toFixed(1)}px from the edge (< 3px)`);
        }
    } finally {
      await ctx.close();
    }
  }
});
