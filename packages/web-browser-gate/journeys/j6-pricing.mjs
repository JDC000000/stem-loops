// J6 — pricing page: what "Get Pro" / "Get Studio" / "Buy Credits" do. On the local stack
// STRIPE_SECRET_KEY is unset, so this observes the no-key posture; production's sandbox key
// (a real Stripe test-mode redirect) cannot be reached from here and is reported as such.
//
// B-8w "P" (Jon, 2026-11-25): checkout is hidden during the beta unless the web server has
// BILLING_CHECKOUT_ENABLED=true (apps/web/src/lib/billing/checkout-switch.ts; unset = OFF).
// The stack does not set it, so CI checks the OFF posture: prices shown, the beta copy on
// every paid plan and pack, no purchase button or link, and the checkout API refusing with
// 403 CHECKOUT_DISABLED. Export BILLING_CHECKOUT_ENABLED=true for BOTH the stack and this
// runner to check the enabled path instead (the original checks, unchanged).
import { Journey, mintUser, newContext } from './lib.mjs';

export const id = 'j6-pricing';

const BETA_COPY = 'Coming soon — free during the beta';
const PURCHASE = /^(Get Pro|Get Studio|Get Free|Buy credits)$/i;

export default async function run() {
  return process.env.BILLING_CHECKOUT_ENABLED === 'true' ? runEnabled() : runDisabled();
}

/** Checkout OFF (the default): nothing on /pricing can start a purchase, and the API refuses. */
async function runDisabled() {
  const j = new Journey(id, 'Pricing: checkout hidden during the beta');
  const anon = await newContext();
  const user = mintUser('j6');
  const signed = await newContext({ user });
  const log = { console: [], http: [] };
  try {
    for (const [who, ctx] of [['signed out', anon.ctx], ['signed in', signed.ctx]]) {
      const pg = await ctx.newPage();
      await pg.goto('/pricing');
      const t = (await j.text(pg, `pricing-${who.replace(' ', '-')}`)).replace(/\s+/g, ' ');
      await j.shot(pg, `pricing-${who.replace(' ', '-')}`);
      j.step(`${who}: plans and prices shown`, 'info', (t.match(/Free.{0,400}/) ?? [t.slice(0, 400)])[0]);
      j.check(`${who}: no "unlimited" claim on the page`, !/unlimited/i.test(t), '');
      j.check(`${who}: plan prices visible`, t.includes('$4.99 CAD') && t.includes('$12 CAD'), '');
      const beta = await pg.getByText(BETA_COPY, { exact: true }).count();
      // Pro + Studio + at least one credit pack.
      j.check(`${who}: "${BETA_COPY}" on every paid plan and pack`, beta >= 3, `count=${beta}`);
      const buttons = await pg.getByRole('button', { name: PURCHASE }).count();
      const links = await pg.getByRole('link', { name: PURCHASE }).count();
      j.check(`${who}: no purchase button or link (Get Pro / Get Studio / Buy credits)`, buttons === 0 && links === 0, `buttons=${buttons} links=${links}`);
      const captcha = await pg.locator('[aria-label="Verify you are human to continue to checkout"]').count();
      j.check(`${who}: no checkout verify panel`, captcha === 0, `count=${captcha}`);
      if (who === 'signed in') {
        // A same-origin call from the page itself (cookies and Origin as the browser sends
        // them): the server must refuse before it starts anything.
        const r = await pg.evaluate(async () => {
          const res = await fetch('/api/billing/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_code: 'pro' }) });
          return { status: res.status, body: await res.text() };
        });
        j.check('signed in: POST /api/billing/checkout is refused 403 CHECKOUT_DISABLED', r.status === 403 && /"code":"CHECKOUT_DISABLED"/.test(r.body), `HTTP ${r.status} ${r.body.slice(0, 200)}`);
      }
    }
    log.console.push(...anon.log.console, ...signed.log.console);
    log.http.push(...anon.log.http, ...signed.log.http);
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
  } finally {
    await anon.ctx.close();
    await signed.ctx.close();
  }
  return j.result(log);
}

/** Checkout ON (BILLING_CHECKOUT_ENABLED=true): the original journey, unchanged. */
async function runEnabled() {
  const j = new Journey(id, 'Pricing: Get Pro / Get Studio / Buy Credits');
  const anon = await newContext();
  const user = mintUser('j6');
  const signed = await newContext({ user });
  const log = { console: [], http: [] };
  try {
    // signed out
    const p = await anon.ctx.newPage();
    await p.goto('/pricing');
    const t = (await j.text(p, 'pricing-signed-out')).replace(/\s+/g, ' ');
    await j.shot(p, 'pricing-signed-out');
    j.step('plans and prices shown', 'info', (t.match(/Free.{0,400}/) ?? [t.slice(0, 400)])[0]);
    j.check('no "unlimited" claim on the page', !/unlimited/i.test(t), '');
    const getPro = p.getByRole('link', { name: 'Get Pro' });
    j.check('signed out: "Get Pro" links to sign-in with return_to=/pricing', (await getPro.getAttribute('href')) === '/login?return_to=/pricing', await getPro.getAttribute('href'));

    // signed in
    const s = await signed.ctx.newPage();
    await s.goto('/pricing');
    await j.shot(s, 'pricing-signed-in');
    for (const plan of ['Pro', 'Studio']) {
      const respP = s.waitForResponse((r) => r.url().includes('/api/billing/checkout'), { timeout: 15_000 }).catch(() => null);
      await s.getByRole('button', { name: `Get ${plan}` }).click();
      const resp = await respP;
      const body = resp ? (await resp.text().catch(() => '')).slice(0, 200) : '';
      await s.waitForTimeout(800);
      const alert = await s.locator(`section[aria-label="${plan}"] [role="alert"]`).innerText().catch(() => '');
      const url = s.url();
      j.step(`signed in: "Get ${plan}" → checkout API`, 'info', `HTTP ${resp?.status()} ${body} | page=${url} | message="${alert}"`);
      j.check(`signed in: "Get ${plan}" does not navigate off-site with no Stripe key, and says billing is unavailable`, url.startsWith('http://127.0.0.1') && /unavailable/i.test(alert), alert || url);
      await j.shot(s, `get-${plan.toLowerCase()}`);
      if (!url.includes('/pricing')) await s.goto('/pricing');
    }
    // credit pack
    const buy = s.getByRole('button', { name: 'Buy Credits' }).first();
    if (await buy.count()) {
      await buy.click();
      await s.waitForTimeout(1500);
      const grp = s.locator('[aria-label="Verify you are human to continue to checkout"]');
      const tt = (await grp.innerText().catch(() => '(no verify panel)')).replace(/\s+/g, ' ');
      await j.shot(s, 'buy-credits');
      j.step('signed in: "Buy Credits" → what appears', 'info', tt.slice(0, 300));
    } else {
      j.step('"Buy Credits" button', 'fail', 'not found');
    }
    j.note('Production posture (Stripe sandbox key → Stripe test checkout redirect) is NOT observable from the local stack.');
    log.console.push(...anon.log.console, ...signed.log.console);
    log.http.push(...anon.log.http, ...signed.log.http);
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
  } finally {
    await anon.ctx.close();
    await signed.ctx.close();
  }
  return j.result(log);
}
