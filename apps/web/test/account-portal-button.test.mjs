// E6 (emails v1.2 R4 account-page fix): "Manage subscription" shows for
// anyone with a customers_billing row, not only for a paid effective plan.
// A paused, incomplete or lapsed past_due subscriber reads as 'free' through
// effectivePlanCode but is exactly who R4 "paused" and R7 "Update your card"
// send to /account.

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

test('paused, incomplete and lapsed past_due users with a billing row all see the button', () => {
  // Each of these reads as plan 'free' on the account page.
  for (const who of ['paused', 'incomplete', 'past_due after grace']) {
    assert.equal(
      mod.showManageSubscription({ hasBillingCustomer: true, planCode: 'free' }),
      true,
      who,
    );
  }
});

test('no billing row: no button, whatever the plan reads', () => {
  assert.equal(mod.showManageSubscription({ hasBillingCustomer: false, planCode: 'free' }), false);
  assert.equal(mod.showManageSubscription({ hasBillingCustomer: false, planCode: 'pro' }), false);
});

test('billing read failed: fall back to the old paid-plan rule', () => {
  assert.equal(mod.showManageSubscription({ hasBillingCustomer: null, planCode: 'pro' }), true);
  assert.equal(mod.showManageSubscription({ hasBillingCustomer: null, planCode: 'free' }), false);
  assert.equal(mod.showManageSubscription({ hasBillingCustomer: null, planCode: null }), false);
});

test('hasBillingCustomer: row -> true, none -> false, error -> null', async () => {
  const seen = [];
  globalThis.__portalDb = async (sql, p) => { seen.push({ sql, p }); return { rows: [{}], rowCount: 1 }; };
  assert.equal(await mod.hasBillingCustomer('u1'), true);
  assert.match(seen[0].sql, /FROM customers_billing WHERE user_id = \$1/);
  assert.deepEqual(seen[0].p, ['u1']);
  globalThis.__portalDb = async () => ({ rows: [], rowCount: 0 });
  assert.equal(await mod.hasBillingCustomer('u1'), false);
  globalThis.__portalDb = async () => { throw new Error('down'); };
  assert.equal(await mod.hasBillingCustomer('u1'), null);
});

test('account page gates the portal button on showManageSubscription, not plan_code', () => {
  const src = readFileSync(join(WEB, 'src/app/account/page.tsx'), 'utf8');
  assert.match(src, /hasBillingCustomer\(user\.user_id\)/);
  assert.match(src, /\{showPortal && \(/);
  assert.doesNotMatch(src, /ent\.data\.plan_code !== 'free' && \(/);
});
