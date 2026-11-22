// J13 — "Try again" on a failed link song (Phase B B3, #321), in real Chromium on the stack, at
// 390×844 and 360×800. Real /jobs/[id] page, real GET /api/jobs/:id and GET /api/jobs/:id/retry
// against the migrated database (045 included). Failed jobs are seeded with psql, because the
// stack's worker does not take link jobs.
//
// POST /api/jobs/:id/retry is sent for REAL once: the stack's server keeps ALLOW_YOUTUBE_INPUT
// off, so the retry must be refused by B0's gate (403, nothing written, retried_at NULL) — the
// retry goes through the same path as a pasted link (AC8). The 429 (C-1) and the success
// redirect are then intercepted and counted, as j10 does for /api/jobs.
import { Journey, mintUser, newContext, sleep, sql } from './lib.mjs';

export const id = 'j13-retry';
const CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
];

const seedLink = (uid, { code = 'FETCH_PROXY_FAILED', depth = 0, retryOf = null } = {}) =>
  sql(`INSERT INTO jobs (id, youtube_url, title, requested_stems, loop_length_bars, status, error_code, error_message_user,
                         client_ip_hash, client_fingerprint, user_id, retry_depth, retry_of)
       VALUES (gen_random_uuid(), '${CANON}', 'Never Gonna Give You Up', ARRAY['drums','bass'], 4, 'failed', '${code}',
               'Something went wrong on our end fetching this video. Try again later.', 'j13-seed', '', '${uid}', ${depth},
               ${retryOf ? `'${retryOf}'` : 'NULL'})
       RETURNING id`);
const seedUpload = (uid) =>
  sql(`INSERT INTO jobs (id, input_kind, upload_r2_key, original_filename, requested_stems, loop_length_bars, status, error_code,
                         error_message_user, client_ip_hash, client_fingerprint, user_id)
       VALUES (gen_random_uuid(), 'upload', 'j13/_input.mp3', 'take-5.mp3', ARRAY['drums'], 4, 'failed', 'SEPARATION_FAILED',
               'Stem separation failed.', 'j13-seed', '', '${uid}')
       RETURNING id`);

async function box(page) {
  return (await page.locator('.jp-failed').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
}

export default async function run() {
  const j = new Journey(id, 'Try again on a failed link song (cap 2, Upload again, Retry of)');
  const user = mintUser('j13');
  const logs = [];
  try {
    for (const vp of VIEWPORTS) {
      const tag = `${vp.width}x${vp.height}`;
      const { ctx, log } = await newContext({ user, viewport: vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      logs.push(log);
      const page = await ctx.newPage();
      try {
        // ── failed link job: the button ───────────────────────────────────────────────
        const parent = seedLink(user.user_id);
        await page.goto(`/jobs/${parent}`);
        const btn = page.locator('[data-testid="job-retry"]');
        const shown = await btn.waitFor({ timeout: 20_000 }).then(() => true, () => false);
        const bb = shown ? await btn.boundingBox() : null;
        j.check(`${tag}: failed link job shows "Try this song again", ≥ 44 px tall`, shown && bb && bb.height >= 44,
          `${(await box(page)).slice(0, 220)} h=${bb && Math.round(bb.height)}`);
        j.check(`${tag}: the cost is said before the tap (free: nothing was given back)`,
          /on us/.test(await page.locator('[data-testid="job-retry-cost"]').innerText().catch(() => '')));
        await j.shot(page, `failed-link-try-again-${tag}`, { fullPage: false });

        // ── AC8: the REAL POST goes through B0's gate (ALLOW_YOUTUBE_INPUT off in the stack) ──
        await btn.tap();
        const refused = await page.locator('[data-testid="job-retry-note"]').waitFor({ timeout: 15_000 }).then(() => true, () => false);
        const note = await page.locator('[data-testid="job-retry-note"]').innerText().catch(() => '');
        const after = sql(`SELECT coalesce(retried_at::text,'NULL') || ' ' || (SELECT count(*) FROM jobs WHERE retry_of = '${parent}') FROM jobs WHERE id = '${parent}'`);
        j.check(`${tag}: real POST refused by ALLOW_YOUTUBE_INPUT (403): no job, retried_at NULL, button kept`,
          refused && /paused/i.test(note) && after === 'NULL 0' && (await btn.isVisible()), `${note} | ${after}`);

        // ── C-1: a 429 keeps the button ───────────────────────────────────────────────
        let posts = 0;
        await page.route(`**/api/jobs/${parent}/retry`, (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          posts += 1;
          return route.fulfill({ status: 429, contentType: 'application/json',
            body: JSON.stringify({ error_code: 'RATE_LIMITED', message: "You're sending requests too fast. Wait a minute and try again." }) });
        });
        await btn.tap();
        await page.waitForFunction(() => /too fast/.test(document.querySelector('[data-testid="job-retry-note"]')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => {});
        j.check(`${tag}: 429 → the reason is shown and the button is still there`, posts === 1 && (await btn.isVisible())
          && /too fast/.test(await page.locator('[data-testid="job-retry-note"]').innerText().catch(() => '')), `posts=${posts}`);
        await j.shot(page, `retry-429-button-kept-${tag}`, { fullPage: false });
        await page.unroute(`**/api/jobs/${parent}/retry`);

        // ── success: one tap → the retry's page, which links "Retry of" ───────────────
        const child = seedLink(user.user_id, { code: 'SEPARATION_FAILED', depth: 1, retryOf: parent });
        await page.route(`**/api/jobs/${parent}/retry`, (route) =>
          route.request().method() === 'POST'
            ? route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: child, status: 'queued' }) })
            : route.continue());
        await btn.tap();
        const moved = await page.waitForURL(new RegExp(`/jobs/${child}`), { timeout: 15_000 }).then(() => true, () => false);
        const retryOf = page.locator('[data-testid="job-retry-of"] a');
        const linked = await retryOf.waitFor({ timeout: 20_000 }).then(() => true, () => false);
        const href = linked ? await retryOf.getAttribute('href') : null;
        j.check(`${tag}: one tap → the retry's page, which links "Retry of" the original`, moved && href === `/jobs/${parent}`, `href=${href}`);
        j.check(`${tag}: the first retry (depth 1) can be tried once more`,
          await page.locator('[data-testid="job-retry"]').waitFor({ timeout: 10_000 }).then(() => true, () => false));
        await j.shot(page, `retry-of-link-${tag}`, { fullPage: false });

        // ── after 2 retries: no button, the limit sentence ────────────────────────────
        const second = seedLink(user.user_id, { code: 'SEPARATION_FAILED', depth: 2, retryOf: child });
        await page.goto(`/jobs/${second}`);
        const limit = await page.locator('[data-testid="job-retry-limit"]').waitFor({ timeout: 20_000 }).then(() => true, () => false);
        await sleep(500);
        j.check(`${tag}: after 2 retries the button is gone and the limit is said`,
          limit && (await page.locator('[data-testid="job-retry"]').count()) === 0, (await box(page)).slice(0, 220));
        await j.shot(page, `after-2-retries-${tag}`, { fullPage: false });

        // ── failed upload: "Upload again", no retry ───────────────────────────────────
        const up = seedUpload(user.user_id);
        await page.goto(`/jobs/${up}`);
        const again = await page.locator('[data-testid="job-upload-again"]').waitFor({ timeout: 20_000 }).then(() => true, () => false);
        await sleep(500);
        j.check(`${tag}: failed upload shows "Upload again" and no retry button`,
          again && (await page.locator('[data-testid="job-retry"]').count()) === 0, (await box(page)).slice(0, 220));
        await j.shot(page, `failed-upload-again-${tag}`, { fullPage: false });
      } catch (e) {
        j.step(`${tag}: journey aborted`, 'fail', String(e).slice(0, 400));
        await j.shot(page, `abort-${tag}`);
      } finally {
        await ctx.close();
      }
    }

    // ── AC3: someone else's failed job: no button (the job is not theirs to see) ─────────
    const owner = mintUser('j13-owner');
    const theirs = seedLink(owner.user_id);
    const { ctx, log } = await newContext({ user, viewport: VIEWPORTS[0] });
    logs.push(log);
    const page = await ctx.newPage();
    try {
      await page.goto(`/jobs/${theirs}`);
      await sleep(3000);
      j.check('another user\'s failed job: no retry button', (await page.locator('[data-testid="job-retry"]').count()) === 0);
    } finally {
      await ctx.close();
    }
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
  }
  // 4xx from the deliberate refusals (403 real POST, intercepted 429, 404 for the other user's
  // job) are expected; they are recorded, not failed on.
  return j.result({ console: logs.flatMap((l) => l.console), http: logs.flatMap((l) => l.http) });
}
