// J2 — the anonymous upload path, and what the UI shows when the user needs to sign in.
// Records facts rather than asserting a policy (anonymous uploads on/off is Jon's call):
// whether the landing lets a signed-out visitor upload, whether a job row is created and
// processed (spend), where the browser ends up, and what that page says.
import { Journey, mintUser, newContext, sleep, sql, uploadViaLanding } from './lib.mjs';

export const id = 'j2-anonymous';
export default async function run() {
  const j = new Journey(id, 'Anonymous upload path and the sign-in wall');
  const { ctx, log } = await newContext();
  const page = await ctx.newPage();
  try {
    await page.goto('/');
    const landing = await j.text(page, 'landing');
    j.step('landing (signed out) mentions sign-in near the tool', /sign in|log in|account/i.test(landing) ? 'info' : 'info', (landing.match(/.{0,60}(sign in|log in|create an account).{0,60}/i) ?? ['(no sign-in copy)'])[0]);
    await j.shot(page, 'landing-signed-out');

    const before = Number(sql(`SELECT count(*) FROM jobs WHERE user_id IS NULL`));
    await uploadViaLanding(page, j, undefined, { expectJobPage: false });
    // Either the landing refuses (an error under the CTA), or it navigates to /jobs/<id> → /login.
    const outcome = await Promise.race([
      page.waitForURL(/\/login\?/, { timeout: 60_000 }).then(() => 'login'),
      page.locator('#job-msg.is-failed').waitFor({ timeout: 60_000 }).then(() => 'refused'),
    ]).catch(() => 'timeout');
    await j.shot(page, `after-submit-${outcome}`);
    const after = Number(sql(`SELECT count(*) FROM jobs WHERE user_id IS NULL`));
    const jobRow = sql(`SELECT id||' '||status FROM jobs WHERE user_id IS NULL ORDER BY created_at DESC LIMIT 1`);
    j.step('anonymous upload created a job row', after > before ? 'info' : 'info', `anonymous jobs ${before} → ${after}; latest: ${jobRow}`);

    if (outcome === 'login') {
      const url = new URL(page.url());
      const txt = await j.text(page, 'login-wall');
      j.check('redirected to /login with return_to = the job', /^\/jobs\/[0-9a-f-]{36}$/.test(url.searchParams.get('return_to') ?? ''), page.url());
      // Does the wall tell the visitor WHY they are here, and that their upload is waiting?
      const explains = /(sign in|log in).{0,80}(job|track|song|upload|stems|player)|your (track|song|job|upload|player)/i.test(txt);
      j.check('sign-in page explains that the uploaded track is waiting behind sign-in', explains, txt.replace(/\s+/g, ' ').slice(0, 300));
      const jid = url.searchParams.get('return_to').split('/').pop();
      await sleep(8000);
      const st = sql(`SELECT status FROM jobs WHERE id='${jid}'`);
      j.step('the anonymous job is processed by the worker while the visitor sits at sign-in (spend)', 'info', `status after 8 s: ${st}`);

      // Sign in (cookie injection stands in for the form) and follow return_to.
      const user = mintUser('j2');
      await ctx.addCookies(user.cookies);
      await page.goto(url.searchParams.get('return_to'));
      const reached = await page.waitForSelector('[data-testid="player"], [role="progressbar"], .jp-failed', { timeout: 120_000 }).then(() => true, () => false);
      j.check('after sign-in, return_to lands on the job page', reached && page.url().includes(jid), page.url());
      const owner = sql(`SELECT coalesce(user_id::text,'NULL') FROM jobs WHERE id='${jid}'`);
      j.step('job ownership after signing in', 'info', `jobs.user_id = ${owner} (signed-in user ${user.user_id}); account page lists only own jobs`);
      await page.goto('/account');
      const acct = await j.text(page, 'account-after-anon');
      // Fact, not a pass/fail: the job stays user_id NULL, so it is reachable only by its link / the history cookie.
      j.step('the anonymous job is NOT attached to the account that signs in after it (not in Recent jobs)', 'info', `listed=${/done ·|queued ·|uploading ·/.test(acct)}; ${acct.replace(/\s+/g, ' ').slice(0, 200)}`);
    } else {
      j.step('landing outcome', outcome === 'refused' ? 'info' : 'fail', `${outcome}: ${await page.locator('#job-msg').innerText().catch(() => '')}`);
    }
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
    await j.shot(page, 'abort');
  } finally {
    await ctx.close();
  }
  return j.result(log);
}
