// J5 — the account page: plan, monthly allowance label, credits (after a beta grant),
// recent jobs, and the delete flow. The delete is CONFIRMED only for a throwaway user
// minted for this journey.
import { Journey, mintUser, newContext, sql } from './lib.mjs';

export const id = 'j5-account';

export default async function run() {
  const j = new Journey(id, 'Account page: credits, allowance label, delete flow');
  const user = mintUser('j5');
  const { ctx, log } = await newContext({ user });
  const page = await ctx.newPage();
  try {
    await page.goto('/account');
    let t = (await j.text(page, 'account-fresh')).replace(/\s+/g, ' ');
    await j.shot(page, 'account-fresh');
    j.check('shows the signed-in email', t.includes(user.email), user.email);
    j.check('plan section shows "Monthly allowance used: 0 / 5" for a free user', /Monthly allowance used: 0 \/ 5/.test(t), (t.match(/Plan.{0,120}/) ?? [''])[0]);
    j.check('credits section shows 0 remaining', /Credits 0 remaining/.test(t), (t.match(/Credits.{0,60}/) ?? [''])[0]);

    // the beta credit path: credit_adjustments manual_grant
    sql(`INSERT INTO credit_adjustments (user_id, credits_delta, reason, provider, provider_event_id) VALUES ('${user.user_id}', 50, 'manual_grant', 'beta', 'w4-j5-${user.user_id}')`);
    await page.reload();
    t = (await j.text(page, 'account-granted')).replace(/\s+/g, ' ');
    await j.shot(page, 'account-granted');
    j.check('after a 50-credit beta grant: "50 remaining"', /Credits 50 remaining/.test(t), (t.match(/Credits.{0,80}/) ?? [''])[0]);
    j.step('credits section copy after a grant (a grant is not a purchase)', 'info', (t.match(/Credits.{0,80}/) ?? [''])[0]);

    // delete flow: page, gating, then confirm (throwaway user)
    await page.getByRole('link', { name: 'Delete account' }).click();
    await page.waitForURL(/\/account\/delete/);
    const dt = (await j.text(page, 'delete-page')).replace(/\s+/g, ' ');
    await j.shot(page, 'delete-page');
    j.step('delete page copy', 'info', dt.slice(0, 400));
    const btn = page.getByRole('button', { name: /Permanently delete/ });
    j.check('delete button disabled until the email is typed', await btn.isDisabled(), '');
    await page.locator('input[type="email"]').fill('someone-else@example.test');
    j.check('still disabled for a different email', await btn.isDisabled(), '');
    await page.locator('input[type="email"]').fill(user.email.toUpperCase());
    j.check('enabled once the email matches (case-insensitive)', await btn.isEnabled(), '');
    await btn.click();
    const gone = await page.waitForURL(/flash=account_deleted/, { timeout: 30_000 }).then(() => true, () => false);
    await j.shot(page, 'after-delete');
    const flash = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    j.check('after confirming: lands on / with an "account deleted" message', gone && /deleted/i.test(flash), (flash.match(/.{0,40}deleted.{0,80}/i) ?? [page.url()])[0]);
    // The cascade (auth.users → public.users) needs real GoTrue; the fake one answers the
    // admin delete without touching the DB. What the route itself does is the tombstone.
    const stamped = sql(`SELECT (deleted_at IS NOT NULL)::text FROM public.users WHERE id='${user.user_id}'`);
    j.check('public.users.deleted_at stamped (tombstone; cascade not testable on fake GoTrue)', stamped === 'true', `deleted_at set=${stamped}`);
    await page.goto('/account');
    j.check('/account now redirects to sign-in', /\/login/.test(page.url()), page.url());
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
    await j.shot(page, 'abort');
  } finally {
    await ctx.close();
  }
  return j.result(log);
}
