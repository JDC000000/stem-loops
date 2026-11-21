// J9 — Slice 2a: a SIGNED-OUT visitor plays a demo song (design v1.5 P3.1, P4; DB-12a).
//
//   home → the live demo poster (no network until the tap) → Play along → the real player
//   → Play → chords visible → tap a section → it jumps there → hold it → it loops
//   → back to home  (D4, 2026-11-21: tap = jump, long-press = loop)
//
// at 390×844 and 360×800 portrait (touch), then the demo's stand-alone URL and the route
// rules a signed-out visitor meets (reads open; download, loop cutting and ordinary jobs
// closed).
//
// SETUP. The stack has no demo song, so the journey makes one the way prod did: a "demo
// system account" uploads a song through the landing, the worker processes it, and the row
// is flagged `is_demo` (prod: Jon's approved write, LEDGER-17 04:47Z). Any older demo row in
// this throwaway database is unflagged first, so the home demo can only open this one.
import { Journey, mintUser, newContext, sleep, sql, uploadViaLanding } from './lib.mjs';

export const id = 'j9-demo-signed-out';

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
];

async function makeDemo(j) {
  const system = mintUser('j9-demo-system');
  const { ctx } = await newContext({ user: system });
  const page = await ctx.newPage();
  try {
    const jobId = await uploadViaLanding(page, j);
    let status = '';
    for (let i = 0; i < 90 && !['done', 'failed'].includes(status); i += 1) {
      await sleep(2000);
      status = sql(`SELECT status FROM jobs WHERE id='${jobId}'`);
    }
    if (!j.check('setup: the demo song is processed by the worker', status === 'done', `status=${status}`)) return null;
    sql(`UPDATE jobs SET is_demo = false WHERE is_demo AND id <> '${jobId}'`);
    sql(`UPDATE jobs SET is_demo = true WHERE id = '${jobId}'`);
    j.step('setup: flagged is_demo, owned by the demo system account', 'info', `${jobId} owner=${sql(`SELECT user_id FROM jobs WHERE id='${jobId}'`)}`);
    return jobId;
  } finally {
    await ctx.close();
  }
}

async function ahHa(j, demoId, vp) {
  const tag = `${vp.width}x${vp.height}`;
  const { ctx, log } = await newContext({ viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const api = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) api.push(`${r.method()} ${u.pathname}`);
  });
  try {
    await page.goto('/');
    const poster = page.locator('[data-testid="home-demo"]');
    await poster.waitFor({ timeout: 20_000 });
    const box = await page.locator('[data-testid="home-demo-play"]').boundingBox();
    // "Near the top": the Play button is on the first screen or one short scroll below it.
    j.check(`${tag}: home shows the demo's Play near the top (within 1.5 screens)`, box && box.y + box.height <= vp.height * 1.5, `play button bottom=${box && Math.round(box.y + box.height)}px`);
    j.check(`${tag}: the poster says no account is needed`, /no account needed/i.test(await poster.innerText()));
    await sleep(500);
    j.check(`${tag}: nothing is fetched before the tap (P4.2)`, api.length === 0, api.join(', ') || 'no /api requests');
    await page.locator('[data-testid="home-demo-play"]').scrollIntoViewIfNeeded();
    await j.shot(page, `${tag}-01-home-poster`, { fullPage: false });

    await page.locator('[data-testid="home-demo-play"]').tap();
    await page.locator('[data-testid="home-demo-layer"] [data-testid="player"]').waitFor({ timeout: 30_000 });
    await page
      .waitForSelector('[data-testid="player"][data-phase="ready"], [data-testid="player"][data-phase="load-error"], [data-testid="player"][data-phase="no-stems"]', { timeout: 60_000 })
      .catch(() => {});
    const phase = await page.getAttribute('[data-testid="player"]', 'data-phase');
    j.check(`${tag}: the real player opens over home, signed out, and loads the stems`, phase === 'ready', `phase=${phase}; api: ${api.join(', ')}`);
    j.check(`${tag}: still on the home URL (no sign-in wall)`, new URL(page.url()).pathname === '/', page.url());

    const facts = await page.locator('[data-testid="player-facts"]').innerText().catch(() => '');
    j.check(`${tag}: BPM and key are shown`, /\bBPM\b/.test(facts) && /(major|minor)/i.test(facts), facts);
    const screenText = await page.locator('[data-testid="player"]').innerText();
    j.check(`${tag}: no "deleted in" text for a demo`, !/deleted in/i.test(screenText) && !/deleted\s+\d/i.test(screenText), '');
    const back = await page.locator('[data-testid="player"] header a').first().getAttribute('aria-label');
    j.check(`${tag}: back arrow says "Back to home"`, back === 'Back to home', back);

    const layout = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="player"]');
      const r = root.getBoundingClientRect();
      const play = document.querySelector('[data-testid="transport-play"]').getBoundingClientRect();
      return {
        hscroll: document.documentElement.scrollWidth - window.innerWidth,
        rootH: Math.round(r.height),
        innerH: window.innerHeight,
        playBottom: Math.round(play.bottom),
        portrait: window.innerHeight > window.innerWidth,
      };
    });
    j.check(
      `${tag}: portrait, no flip: the whole player fits the screen (Play reachable, no sideways scroll)`,
      layout.portrait && layout.hscroll <= 0 && layout.playBottom <= layout.innerH,
      JSON.stringify(layout),
    );

    await page.locator('[data-testid="transport-play"]').tap();
    await sleep(2500);
    const label = await page.locator('[data-testid="transport-play"]').getAttribute('aria-label');
    const time = await page.locator('[data-testid="transport-time"]').innerText().catch(() => '');
    j.check(`${tag}: Play plays (the transport says Pause and the clock moved)`, /pause/i.test(label ?? '') && !/^0:00\b/.test(time.trim()), `label=${label} time=${time.replace(/\s+/g, ' ')}`);

    const now = page.locator('[data-testid="phone-chords"] [data-testid="playhead-now-name"]').first();
    const chordVisible = await now.isVisible().catch(() => false);
    const chordName = chordVisible ? (await now.innerText()).trim() : '';
    j.check(`${tag}: chords are visible on the stage`, chordVisible && chordName.length > 0, `now="${chordName}"`);
    await j.shot(page, `${tag}-02-player-playing`, { fullPage: false });

    const chips = page.locator('[data-testid="section-strip"] button');
    const n = await chips.count();
    if (j.check(`${tag}: the section strip has sections`, n > 0, `${n} chips`)) {
      const target = chips.nth(Math.min(2, n - 1));
      const chipText = (await target.innerText()).replace(/\s+/g, ' ');
      j.check(`${tag}: sections have neutral names ("Part N · m:ss")`, /^Part \d+( ·)? \d+:\d\d$/.test(chipText), `"${chipText}"`);
      // TAP = jump there and play; nothing loops.
      await target.tap();
      await sleep(600);
      const jumped = await page.locator('[data-testid="transport-time"]').innerText().catch(() => '');
      const tapPressed = await target.getAttribute('aria-pressed');
      j.check(`${tag}: tapping a section jumps there, without looping`, tapPressed === 'false', `chip=${tapPressed} time=${jumped.replace(/\s+/g, ' ')}`);
      // HOLD (Shift+Enter is the strip's keyboard long-press; the touch long-press is
      // covered by the real-Chromium R1 gate in test/player-text-size.test.mjs).
      await target.focus();
      await page.keyboard.press('Shift+Enter');
      await sleep(600);
      const pressed = await target.getAttribute('aria-pressed');
      const loopOn = await page.locator('[data-testid="transport-loop"]').getAttribute('aria-pressed');
      const loopText = await page.locator('[data-testid="transport-loop-text"]').innerText().catch(() => '');
      j.check(`${tag}: holding a section loops it`, pressed === 'true' && loopOn === 'true', `chip=${pressed} loop=${loopOn} "${loopText.replace(/\s+/g, ' ')}"`);
      await j.shot(page, `${tag}-03-section-loop`, { fullPage: false });
    }

    const wrote = api.filter((a) => !a.startsWith('GET '));
    j.check(`${tag}: the whole demo session made only GET requests`, wrote.length === 0, api.join(', '));
    j.check(`${tag}: no WAV download or loop-cut call was made`, !api.some((a) => /\/download|\/loops/.test(a)), api.join(', '));

    await page.locator('[data-testid="transport-play"]').tap().catch(() => {});
    await page.locator('[data-testid="player"] header a').first().tap();
    await page.locator('[data-testid="home-demo-layer"]').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    const closed = (await page.locator('[data-testid="home-demo-layer"]').count()) === 0;
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    j.check(`${tag}: back closes the demo in place and returns focus to Play`, closed && focused === 'home-demo-play' && new URL(page.url()).pathname === '/', `closed=${closed} focus=${focused}`);
    const inert = await page.evaluate(() => [...document.body.children].filter((c) => c.hasAttribute('inert')).length);
    j.check(`${tag}: the page is interactive again (no inert left behind)`, inert === 0, `inert=${inert}`);
  } catch (e) {
    j.step(`${tag}: aborted`, 'fail', String(e).slice(0, 400));
    await j.shot(page, `${tag}-abort`);
  } finally {
    await ctx.close();
  }
  return log;
}

export default async function run() {
  const j = new Journey(id, 'Signed out: home → demo → play → chords → section loop (390×844, 360×800)');
  const logs = { console: [], http: [] };
  try {
    const demoId = await makeDemo(j);
    if (!demoId) return j.result(logs);
    for (const vp of VIEWPORTS) {
      const log = await ahHa(j, demoId, vp);
      logs.console.push(...log.console);
      logs.http.push(...log.http);
    }

    // The stand-alone demo URL and the route rules, signed out.
    const { ctx, log } = await newContext({ viewport: VIEWPORTS[0], isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    try {
      await page.goto(`/demo/${demoId}`);
      const ok = await page.waitForSelector('[data-testid="player"]', { timeout: 30_000 }).then(() => true, () => false);
      j.check('/demo/<id> opens the player signed out', ok && !page.url().includes('/login'), page.url());
      await page.goto(`/jobs/${demoId}`);
      const ok2 = await page.waitForSelector('[data-testid="player"]', { timeout: 30_000 }).then(() => true, () => false);
      j.check('/jobs/<demo id> opens the player signed out (no /login redirect)', ok2 && !page.url().includes('/login'), page.url());

      const r = page.request;
      const st = async (method, path) => (await r.fetch(path, { method, failOnStatusCode: false, headers: { origin: new URL(page.url()).origin } })).status();
      j.check('signed out: GET the demo job is 200', (await st('GET', `/api/jobs/${demoId}`)) === 200);
      j.check('signed out: GET the demo stems is 200', (await st('GET', `/api/jobs/${demoId}/stems`)) === 200);
      j.check('signed out: GET the demo chords is 200', (await st('GET', `/api/jobs/${demoId}/play-chords`)) === 200);
      j.check('signed out: WAV download of a demo stem is refused (401)', (await st('GET', `/api/jobs/${demoId}/download?stem=drums`)) === 401);
      j.check('signed out: cutting demo loops is refused (404)', (await st('POST', `/api/jobs/${demoId}/loops`)) === 404);
      j.check('signed out: polling demo loop cuts is refused (404)', (await st('GET', `/api/jobs/${demoId}/loops`)) === 404);

      const other = sql(`SELECT id FROM jobs WHERE NOT is_demo AND user_id IS NOT NULL AND status='done' ORDER BY created_at DESC LIMIT 1`);
      if (other) {
        j.check('signed out: an ordinary owned job is still a 404', (await st('GET', `/api/jobs/${other}`)) === 404, other);
        await page.goto(`/jobs/${other}`);
        await page.waitForURL(/\/login\?/, { timeout: 15_000 }).catch(() => {});
        j.check('signed out: an ordinary job page still redirects to /login', page.url().includes('/login?return_to='), page.url());
      } else {
        j.step('ordinary-job control', 'not-reached', 'no ordinary owned done job in this database');
      }
      logs.console.push(...log.console);
      logs.http.push(...log.http.filter((h) => !/^(401|404) /.test(h)));
    } finally {
      await ctx.close();
    }
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
  }
  return j.result(logs);
}
