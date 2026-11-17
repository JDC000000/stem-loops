// J6 — pricing page: what "Get Pro" / "Get Studio" / "Buy Credits" do. On the local stack
// STRIPE_SECRET_KEY is unset, so this observes the no-key posture; production's sandbox key
// (a real Stripe test-mode redirect) cannot be reached from here and is reported as such.
import { Journey, mintUser, newContext } from './lib.mjs';

export const id = 'j6-pricing';

export default async function run() {
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
