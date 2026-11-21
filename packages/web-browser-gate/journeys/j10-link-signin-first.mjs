// J10 — a YouTube link pasted SIGNED OUT goes to sign-in FIRST, then starts after sign-in
// (A4, PR #332 round 2; Jon's J1 story). Real Chromium, real landing, real /login, real
// /api/auth/me against the stack's fake GoTrue. Never real Google: "signing in" is the minted
// session cookie the other journeys use, then the browser follows the same return_to /login
// would send it to.
//
// /api/jobs POSTs are intercepted and COUNTED (the stack's server does not take link jobs, and the
// point here is how many the page asks for, not the worker): 0 before sign-in, exactly 1 after,
// 0 on a replay of the marker. The clipboard is a spy (the page's own navigator.clipboard.readText
// is wrapped, never a real system clipboard): 0 reads before the Paste tap, 1 on the tap.
import { Journey, mintUser, newContext, sleep } from './lib.mjs';

export const id = 'j10-link-signin-first';
const LINK = 'https://youtu.be/dQw4w9WgXcQ?si=j10';
const CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const JOB = '10101010-1010-4010-8010-101010101010';

const CLIPBOARD_SPY = (link) => {
  window.__readTextCalls = 0;
  const fake = { readText: async () => { window.__readTextCalls += 1; return link; }, writeText: async () => {} };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => fake });
};

export default async function run() {
  const j = new Journey(id, 'Link pasted signed out: sign-in first, then it starts (once)');
  const { ctx, log } = await newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(CLIPBOARD_SPY, LINK);
  const posts = [];
  await ctx.route('**/api/jobs', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: JOB, status: 'queued' }) });
  });
  await ctx.route(`**/jobs/${JOB}`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>job</h1>' }));
  const page = await ctx.newPage();
  try {
    await page.goto('/');
    const hasBox = await page.locator('#source').isVisible().catch(() => false);
    if (!j.check('the landing shows the link box (NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT on in the stack)', hasBox)) throw new Error('no link box');
    await page.locator('#paste-btn').waitFor({ state: 'visible', timeout: 10_000 });
    await sleep(500);
    j.check('the clipboard is read 0 times before the Paste tap', (await page.evaluate(() => window.__readTextCalls)) === 0,
      `reads=${await page.evaluate(() => window.__readTextCalls)}`);
    await page.locator('#paste-btn').tap();
    await sleep(200);
    const value = await page.inputValue('#source');
    const focus = await page.evaluate(() => document.activeElement?.id);
    j.check('Paste: one read, the link fills the box, focus on Separate and play',
      (await page.evaluate(() => window.__readTextCalls)) === 1 && value === LINK && focus === 'cta', `value=${value} focus=${focus}`);
    const cta = await page.locator('#cta').boundingBox();
    j.check('390x844: the submit button is above the fold', cta && cta.y + cta.height <= 844, `cta bottom=${cta && Math.round(cta.y + cta.height)}`);

    await page.locator('#cta').tap();
    await page.waitForURL(/\/login\?/, { timeout: 15_000 });
    const loginUrl = new URL(page.url());
    const returnTo = loginUrl.searchParams.get('return_to') ?? '';
    j.check('signed out: the browser goes to sign-in FIRST, and no job is POSTed', posts.length === 0 && /^\/\?resume=link&n=[0-9a-f]{32}$/.test(returnTo),
      `posts=${posts.length} return_to=${returnTo}`);
    await page.locator('[data-testid="login-google"]').waitFor({ timeout: 10_000 });
    const waiting = await page.locator('[data-testid="login-link-waiting"]').innerText().catch(() => '');
    j.check('/login: Google first, the waiting line states the allowance', /uses 1 of your monthly songs/.test(waiting), waiting.replace(/\s+/g, ' '));
    await j.shot(page, 'login-link-waiting', { fullPage: false });

    // "Sign in": the minted session, then the return_to /login would assign after SIGNED_IN.
    const user = mintUser('j10');
    await ctx.addCookies(user.cookies);
    await page.goto(returnTo);
    const started = await page.waitForURL(new RegExp(`/jobs/${JOB}`), { timeout: 20_000 }).then(() => true, () => false);
    j.check('after sign-in the saved link starts ONCE, as the canonical URL', started && posts.length === 1 && posts[0]?.url === CANON,
      `posts=${JSON.stringify(posts)} url=${page.url()}`);

    // Replay the marker: nothing may start again.
    await page.goto(returnTo);
    await sleep(2000);
    j.check('replaying the marker starts nothing, and the marker is stripped', posts.length === 1 && !page.url().includes('resume='),
      `posts=${posts.length} url=${page.url()}`);
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
    await j.shot(page, 'abort');
  } finally {
    await ctx.close();
  }
  return j.result(log);
}
