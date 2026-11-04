// M7: the same checkout.session.completed delivered twice (Stripe retry) must
// leave exactly one promo_redemptions row when stripe_promotion_code_id is set.
// The db stub emulates Postgres UNIQUE (user_id, stripe_promotion_code_id)
// semantics, including NULLs being distinct.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/app/api/billing/webhook/route.ts');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const USER = '11111111-1111-1111-1111-111111111111';
const baseEvt = {
  type: 'credit_purchase_completed',
  userId: USER,
  packCode: 'credits_20',
  providerChargeId: 'pi_1',
  amountCents: 500,
  currency: 'cad',
  priceId: 'price_1',
  promoCode: 'SAVE10',
  customerEmail: 'a@example.com',
};

async function loadRoute(evt) {
  const billing = dataUrl(`
    export class UnknownPriceError extends Error {}
    export const getBillingProvider = () => ({
      name: 'stripe',
      handleWebhook: async () => (${JSON.stringify(evt)}),
    });`);
  const db = dataUrl(`
    const q = async (sql, params = []) => {
      if (/INSERT INTO promo_redemptions/.test(sql)) {
        const [user_id, code, pcid] = params;
        // Postgres: NULL keys never conflict.
        const key = pcid == null ? null : user_id + '|' + pcid;
        if (key !== null && globalThis.__promoKeys.has(key)) return { rows: [], rowCount: 0 };
        if (key !== null) globalThis.__promoKeys.add(key);
        globalThis.__promoRows.push({ user_id, code, stripe_promotion_code_id: pcid ?? null });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    export const db = { query: q, tx: async (fn) => fn({ query: q }) };`);
  const ent = dataUrl(`export const invalidateEntitlement = () => {};`);
  const em = dataUrl(`
    export const sendWelcomeIfFirstTime = async () => {};
    export const sendSubscriptionChanged = async () => {};
    export const sendReceipt = async () => {};`);
  const next = dataUrl(`
    export class NextResponse {
      static json(body, init = {}) { return { status: init.status ?? 200, body }; }
    }`);
  const js = toJs(readFileSync(SRC, 'utf8'))
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billing}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${ent}'`)
    .replace(/from ['"]@\/lib\/emails\/dispatch['"]/g, `from '${em}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${next}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

const req = () => ({
  headers: { get: (n) => (n.toLowerCase() === 'stripe-signature' ? 'sig' : null) },
  text: async () => '{}',
});

beforeEach(() => {
  globalThis.__promoRows = [];
  globalThis.__promoKeys = new Set();
});

test('same event twice with promoCodeId -> exactly 1 promo_redemptions row', async () => {
  const mod = await loadRoute({ ...baseEvt, promoCodeId: 'promo_abc' });
  assert.equal((await mod.POST(req())).status, 200);
  assert.equal((await mod.POST(req())).status, 200);
  assert.equal(globalThis.__promoRows.length, 1);
  assert.equal(globalThis.__promoRows[0].stripe_promotion_code_id, 'promo_abc');
});

test('without promoCodeId (legacy session) -> NULL key, documented Phase 1a behaviour', async () => {
  const mod = await loadRoute({ ...baseEvt });
  await mod.POST(req());
  await mod.POST(req());
  assert.equal(globalThis.__promoRows.length, 2);
  assert.equal(globalThis.__promoRows[0].stripe_promotion_code_id, null);
});
