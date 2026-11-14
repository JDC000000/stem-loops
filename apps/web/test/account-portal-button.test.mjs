// E6 (emails v1.2 R4 account-page fix), narrowed by PR #272 review M-b:
// "Manage subscription" shows for anyone with a subscription that got past
// `incomplete` (paid at least once) and a customers_billing row for the
// current provider, not only for a paid effective plan. A paused or lapsed
// past_due subscriber reads as 'free' through effectivePlanCode but is
// exactly who R4 "paused" and R7 "Update your card" send to /account. An
// abandoned Checkout or a credit-only buyer does not see it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const dbStub = dataUrl(`export const db = { query: (...a) => globalThis.__portalDb(...a) };`);
const mod = await import(
  dataUrl(
    toJs(readFileSync(join(WEB, 'src/lib/billing/portal-eligibility.ts'), 'utf8'))
      .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub}'`),
  )
);

test('paused and lapsed past_due subscribers see the button even though the plan reads free', () => {
  for (const who of ['paused', 'past_due after grace']) {
    assert.equal(
      mod.showManageSubscription({ hasPortalSubscription: true, planCode: 'free' }),
      true,
      who,
    );
  }
});

test('no portal subscription (abandoned Checkout, credit-only): no button, whatever the plan reads', () => {
  assert.equal(mod.showManageSubscription({ hasPortalSubscription: false, planCode: 'free' }), false);
  assert.equal(mod.showManageSubscription({ hasPortalSubscription: false, planCode: 'pro' }), false);
});

test('read failed: fall back to the old paid-plan rule', () => {
  assert.equal(mod.showManageSubscription({ hasPortalSubscription: null, planCode: 'pro' }), true);
  assert.equal(mod.showManageSubscription({ hasPortalSubscription: null, planCode: 'free' }), false);
  assert.equal(mod.showManageSubscription({ hasPortalSubscription: null, planCode: null }), false);
});

test('hasPortalSubscription: joins customers_billing on the same provider, skips incomplete', async () => {
  const seen = [];
  globalThis.__portalDb = async (sql, p) => { seen.push({ sql, p }); return { rows: [{}], rowCount: 1 }; };
  assert.equal(await mod.hasPortalSubscription('u1', 'stripe'), true);
  const q = seen[0].sql.replace(/\s+/g, ' ');
  assert.match(q, /FROM subscriptions s JOIN customers_billing c ON c\.user_id = s\.user_id AND c\.provider = s\.provider/);
  assert.match(q, /s\.provider = \$2 AND s\.status <> 'incomplete'/);
  assert.deepEqual(seen[0].p, ['u1', 'stripe']);
  globalThis.__portalDb = async () => ({ rows: [], rowCount: 0 });
  assert.equal(await mod.hasPortalSubscription('u1', 'stripe'), false);
  globalThis.__portalDb = async () => { throw new Error('down'); };
  assert.equal(await mod.hasPortalSubscription('u1', 'stripe'), null);
});

test('billingProviderName follows BILLING_PROVIDER, default stripe', () => {
  assert.equal(mod.billingProviderName({}), 'stripe');
  assert.equal(mod.billingProviderName({ BILLING_PROVIDER: 'Paddle' }), 'paddle');
});

test('account page gates the portal button on showManageSubscription, not plan_code', () => {
  const src = readFileSync(join(WEB, 'src/app/account/page.tsx'), 'utf8');
  assert.match(src, /hasPortalSubscription\(user\.user_id\)/);
  assert.match(src, /\{showPortal && \(/);
  assert.doesNotMatch(src, /ent\.data\.plan_code !== 'free' && \(/);
});
