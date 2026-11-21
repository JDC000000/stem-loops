// REAL-BROWSER GATE: every section chip is on screen, or the strip says it is not
// (review B1 + M2 on #330; v4.0 Story 1.6 / 4.5: "none off-screen for <= 12 sections").
//
// PHASE A RULE (orchestrator, PR #331): while the "my part" pills row is on the
// play screen the strip shows ONE row plus the "+N more" cue; 2 rows (3 at
// >= 800px tall) only when the pills are not there. So every case is measured
// twice: as shipped (pills shown: one row, and every hidden chip counted by the
// cue, which must not cover a pill), and with the pills row removed (the bands
// below, which are A3's).
//
// WHAT IT CHECKS, in real Chromium with the real PlayerView and the real CSS:
//   * at 390x844 and 360x800 (the phones the play screen is designed for), for
//     5, 7, 8 and 12 sections AND for the three public demo songs (their real
//     loop rows through deriveSections: 6, 8 and 8 parts): EVERY chip is fully
//     inside the strip's visible box and the viewport, the strip does not need
//     to scroll, and no "+N more" cue is shown;
//   * at 375x667 and 320x568 (short phones): either every chip is visible, or
//     the "+N more" cue is shown and its N is exactly the number of chips out
//     of view;
//   * at all four sizes: the page itself does not scroll (the S1 rule), and
//     every chip is >= 44px tall.
//
// HOW IT IS KEPT HONEST. It FAILS (does not skip) when Chromium or the page is
// missing, asserts it measured the number of chips it rendered, and prints the
// measurements with CHORD_GATE_LOG=1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const esbuild = require('esbuild');

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(process.env.CHORD_GATE_SRC ?? join(HERE, '../../../apps/web'));
const LOG = process.env.CHORD_GATE_LOG === '1';

const CHORDS = JSON.parse(readFileSync(join(WEB, 'test/fixtures/play-chords-3m33s.json'), 'utf8'));
const DEMOS = JSON.parse(readFileSync(join(WEB, 'test/fixtures/demo-section-rows.json'), 'utf8')).songs;
const DURATION = 213;
const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const FULL = [[390, 844], [360, 800]];
const SHORT = [[375, 667], [320, 568]];
const MIN_CHIP_PX = 44;

/** n contiguous sections over the track (the shape deriveSections returns). */
const even = (n, dur = DURATION) =>
  Array.from({ length: n }, (_, i) => ({ startSec: Math.round((i * dur * 1000) / n) / 1000, endSec: Math.round(((i + 1) * dur * 1000) / n) / 1000, label: 'x' }));

const CASES = [
  ...[5, 7, 8, 12].map((n) => ({ name: `${n} sections`, sections: even(n), duration: DURATION })),
  ...Object.entries(DEMOS).map(([slug, s]) => ({ name: `demo ${slug}`, rows: s.rows, duration: s.duration_sec })),
];

async function bundle() {
  const res = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { PlayerView } from './src/components/play/Player.tsx';
        import { deriveSections } from './src/lib/play/sections.ts';
        import './src/app/globals.css';
        const noop = () => {};
        const snap = window.__snap;
        const sections = window.__rows ? deriveSections(window.__rows, { durationSec: snap.durationSec }) : window.__sections;
        window.__count = sections.length;
        createRoot(document.getElementById('root')).render(React.createElement(PlayerView, {
          jobId: 'strip-gate', phase: { kind: 'ready' }, snapshot: snap, sections,
          bpm: 102, musicalKey: 'A major', title: 'Lucky Ticket', artist: 'The Royal Sundowners',
          onPlay: noop, onPause: noop, onSeek: noop, onGain: noop, onMute: noop, onSolo: noop, onLoop: noop,
        }));
      `,
      resolveDir: WEB,
      loader: 'js',
      sourcefile: 'strip-gate-entry.js',
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
    plugins: [
      {
        name: 'stub-sentry',
        setup(b) {
          b.onResolve({ filter: /^@sentry\/nextjs$/ }, () => ({ path: 'sentry-stub', namespace: 'gate-stub' }));
          b.onLoad({ filter: /.*/, namespace: 'gate-stub' }, () => ({ contents: 'export function captureMessage() {}', loader: 'js' }));
        },
      },
    ],
  });
  const js = res.outputFiles.find((f) => f.path.endsWith('.js'));
  const css = res.outputFiles.find((f) => f.path.endsWith('.css'));
  assert.ok(js, 'esbuild produced no JS for PlayerView');
  return { js: js.text, css: css?.text ?? '' };
}

async function measure(browser, built, [width, height], c, { pills = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
  // The one-time light-audio note is dismissed, as a returning visitor sees it.
  await ctx.addInitScript(() => {
    try { localStorage.setItem('sl.play.lightNoteSeen.v1', '1'); } catch { /* none */ }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const snap = {
    status: 'ready', positionSec: 10, durationSec: c.duration,
    stems: STEMS.map((name) => ({ name, availability: 'ready', gain: 1, muted: false, soloed: false, effectivelySilent: false })),
    loop: null, degraded: null, error: null,
  };
  await page.route('http://gate.test/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<link rel="stylesheet" href="/out.css"></head><body style="margin:0"><div id="root"></div>' +
          `<script>window.__snap=${JSON.stringify(snap)};window.__rows=${JSON.stringify(c.rows ?? null)};window.__sections=${JSON.stringify(c.sections ?? null)};</script>` +
          '<script src="/out.js"></script></body></html>',
      });
    if (u.pathname === '/out.js') return route.fulfill({ contentType: 'text/javascript', body: built.js });
    if (u.pathname === '/out.css') return route.fulfill({ contentType: 'text/css', body: built.css });
    if (u.pathname.endsWith('/play-chords')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ signed_url: '/signed.json', expires_in_sec: 60 }) });
    if (u.pathname === '/signed.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(CHORDS) });
    return route.fulfill({ status: 404, body: 'not found' });
  });
  try {
    await page.goto('http://gate.test/');
    await page.waitForSelector('[data-testid="section-strip"] button', { timeout: 30000 });
    await page.waitForSelector('[data-testid="phone-chords"]', { timeout: 30000 });
    if (!pills) await page.evaluate(() => document.querySelector('[data-testid="part-pills"]')?.remove());
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
    const m = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="section-strip"]');
      const list = strip.querySelector('button[data-index]').parentElement;
      const l = list.getBoundingClientRect();
      const chips = [...list.querySelectorAll('button[data-index]')].map((b) => {
        const r = b.getBoundingClientRect();
        const inList = r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5 && r.left >= l.left - 0.5 && r.right <= l.right + 0.5;
        const inView = r.top >= -0.5 && r.bottom <= innerHeight + 0.5 && r.left >= -0.5 && r.right <= innerWidth + 0.5;
        return { text: b.textContent, h: r.height, w: r.width, visible: inList && inView };
      });
      const cue = document.querySelector('[data-testid="section-more"]');
      const cr = cue?.getBoundingClientRect();
      const pl = document.querySelector('[data-testid="part-pills"]');
      const plr = pl && getComputedStyle(pl).display !== 'none' ? pl.getBoundingClientRect() : null;
      const covered = !!plr && !!cr && cr.width > 0 && cr.bottom > plr.top + 0.5 && cr.top < plr.bottom - 0.5;
      // PR #331 r2 M-1: the first-run line must sit ABOVE the chips, never next to
      // or under the pills (where "hold" solos), and must not collide with the cue.
      const fh = document.querySelector('[data-testid="section-first-hint"]');
      const fr = fh ? fh.getBoundingClientRect() : null;
      const firstChip = list.querySelector('button[data-index]').getBoundingClientRect();
      const ro = (a, b) => !!a && !!b && a.width > 0 && b.width > 0 && a.right > b.left + 0.5 && a.left < b.right - 0.5 && a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5;
      const firstHint = fr ? {
        text: fh.textContent,
        aboveChips: fr.bottom <= firstChip.top + 0.5,
        abovePills: !plr || fr.bottom <= plr.top - 40,
        overCue: ro(fr, cr),
        clipped: fh.scrollWidth > fh.clientWidth + 0.5,
      } : null;
      const chipH = 44;
      return {
        firstHint,
        pills: !!plr,
        cueCoversPills: covered,
        rows: Math.round((l.height - 8 + 8) / (chipH + 8)),
        stage: Math.round(document.querySelector('[data-testid="player-harmony-track"]').getBoundingClientRect().height),
        count: window.__count,
        chips,
        listScroll: [list.scrollHeight, list.clientHeight],
        cue: cue ? cue.textContent : null,
        cueVisible: !!cr && cr.width > 0 && cr.top >= -0.5 && cr.bottom <= innerHeight + 0.5,
        pageScroll: document.scrollingElement.scrollHeight - innerHeight,
        playerScroll: (() => { const p = document.querySelector('[data-testid="player"]'); return p.scrollHeight - p.clientHeight; })(),
      };
    });
    m.errors = errors;
    return m;
  } finally {
    await ctx.close();
  }
}

let browser;
let built;
test('setup: bundle PlayerView and launch Chromium', async () => {
  built = await bundle();
  browser = await chromium.launch();
});

for (const vp of [...FULL, ...SHORT]) {
  const full = FULL.includes(vp);
  test(`section strip @ ${vp[0]}x${vp[1]} without the pills: ${full ? 'every chip visible, no cue' : 'every chip visible, or the "+N more" cue counts the hidden ones'}; no page scroll`, async () => {
    assert.ok(browser && built, 'setup test did not run or failed');
    const f = [];
    const log = [];
    for (const c of CASES) {
      const m = await measure(browser, built, vp, c, { pills: false });
      const ctx = `${c.name} @ ${vp[0]}x${vp[1]} (no pills)`;
      const hidden = m.chips.filter((x) => !x.visible);
      log.push(`${ctx}: ${m.chips.length} chips, ${hidden.length} hidden, rows ${m.rows}, list ${m.listScroll.join('/')}, cue ${JSON.stringify(m.cue)}, page scroll ${m.pageScroll}`);
      if (m.pills) f.push(`${ctx}: the pills row is still there`);
      if (m.errors.length) f.push(`${ctx}: page errors ${m.errors.join(' | ')}`);
      if (m.chips.length !== m.count || m.count < 5) f.push(`${ctx}: measured ${m.chips.length} chips for ${m.count} sections`);
      if (m.pageScroll > 0 || m.playerScroll > 0) f.push(`${ctx}: the screen scrolls (page ${m.pageScroll}px, player ${m.playerScroll}px)`);
      for (const x of m.chips) if (x.h + 0.02 < MIN_CHIP_PX) f.push(`${ctx}: chip "${x.text}" is ${x.h.toFixed(1)}px tall`);
      if (full) {
        if (hidden.length) f.push(`${ctx}: ${hidden.length} chip(s) off-screen: ${hidden.map((x) => x.text).join(', ')}`);
        if (m.listScroll[0] > m.listScroll[1]) f.push(`${ctx}: the strip needs to scroll (${m.listScroll.join(' > ')})`);
        if (m.cue) f.push(`${ctx}: the cue "${m.cue}" shows although every chip fits`);
      } else if (hidden.length) {
        const want = new RegExp(`^\\+${hidden.length} more [\\u2193\\u2191]$`);
        if (!m.cue || !want.test(m.cue) || !m.cueVisible) f.push(`${ctx}: ${hidden.length} chip(s) hidden but the cue is ${JSON.stringify(m.cue)}${m.cueVisible ? '' : ' (not visible)'}`);
      } else if (m.cue) f.push(`${ctx}: the cue "${m.cue}" shows although every chip fits`);
    }
    if (LOG) for (const l of log) console.log(`# ${l}`);
    if (f.length) assert.fail(`GATE-FAIL ${f.length}:\n  ${f.join('\n  ')}\n${log.map((l) => '  # ' + l).join('\n')}`);
  });

  // As shipped on a phone: the pills row is there, so the strip is ONE row and
  // the cue counts exactly the chips out of view, without covering a pill.
  test(`section strip @ ${vp[0]}x${vp[1]} with the pills: one row, the "+N more" cue counts the hidden chips exactly and covers no pill; no page scroll`, async () => {
    assert.ok(browser && built, 'setup test did not run or failed');
    const f = [];
    const log = [];
    for (const c of CASES) {
      const m = await measure(browser, built, vp, c);
      const ctx = `${c.name} @ ${vp[0]}x${vp[1]} (pills)`;
      const hidden = m.chips.filter((x) => !x.visible);
      log.push(`${ctx}: ${m.chips.length} chips, ${hidden.length} hidden, rows ${m.rows}, stage ${m.stage}px, cue ${JSON.stringify(m.cue)}`);
      if (!m.pills) f.push(`${ctx}: no pills row, so this case does not test what it names`);
      if (m.rows !== 1) f.push(`${ctx}: the strip is ${m.rows} rows tall with the pills shown, want 1`);
      if (m.errors.length) f.push(`${ctx}: page errors ${m.errors.join(' | ')}`);
      if (m.chips.length !== m.count || m.count < 5) f.push(`${ctx}: measured ${m.chips.length} chips for ${m.count} sections`);
      if (m.pageScroll > 0 || m.playerScroll > 0) f.push(`${ctx}: the screen scrolls (page ${m.pageScroll}px, player ${m.playerScroll}px)`);
      for (const x of m.chips) if (x.h + 0.02 < MIN_CHIP_PX) f.push(`${ctx}: chip "${x.text}" is ${x.h.toFixed(1)}px tall`);
      if (hidden.length) {
        const want = new RegExp(`^\\+${hidden.length} more [\\u2193\\u2191]$`);
        if (!m.cue || !want.test(m.cue) || !m.cueVisible) f.push(`${ctx}: ${hidden.length} chip(s) hidden but the cue is ${JSON.stringify(m.cue)}${m.cueVisible ? '' : ' (not visible)'}`);
      } else if (m.cue) f.push(`${ctx}: the cue "${m.cue}" shows although every chip fits`);
      if (m.cueCoversPills) f.push(`${ctx}: the cue covers the pills row`);
      if (!m.firstHint) f.push(`${ctx}: no first-run hint (a first visit must show it)`);
      else {
        if (!m.firstHint.aboveChips || !m.firstHint.abovePills) f.push(`${ctx}: the first-run hint is not above the chips and clear of the pills`);
        if (m.firstHint.overCue) f.push(`${ctx}: the first-run hint overlaps the "+N more" cue`);
        if (m.firstHint.clipped) f.push(`${ctx}: the first-run hint "${m.firstHint.text}" is clipped`);
      }
    }
    if (LOG) for (const l of log) console.log(`# ${l}`);
    if (f.length) assert.fail(`GATE-FAIL ${f.length}:\n  ${f.join('\n  ')}\n${log.map((l) => '  # ' + l).join('\n')}`);
  });
}

test('teardown', async () => {
  if (browser) await browser.close();
});
