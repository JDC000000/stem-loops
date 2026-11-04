// B2 (credit-ledger review 2026-11-03): invoice_paid must NOT swallow a
// getSubscription failure. A 200 tells Stripe not to retry, so the
// entitlement period never advances. The route must return 500.

import { test } from 'node:test';
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

const EVENT = {
  type: 'invoice_paid',
  userId: '11111111-1111-1111-1111-111111111111',
  providerSubscriptionId: 'sub_X',
  invoice: { amountCents: 1500, hostedInvoiceUrl: 'https://x', providerInvoiceId: 'in_X' },
};

function billingStub({ getSubscriptionThrows }) {
  return dataUrl(`
    export class UnknownPriceError extends Error {
      constructor(m) { super(m); this.name = 'UnknownPriceError'; }
    }
    export const getBillingProvider = () => ({
      name: 'stripe',
      handleWebhook: async () => (${JSON.stringify(EVENT)}),
      getSubscription: async () => {
        if (${getSubscriptionThrows}) throw new UnknownPriceError('price_unknown');
        return {
          providerSubscriptionId: 'sub_X', providerCustomerId: 'cus_X', priceId: 'price_X',
          planCode: 'pro', status: 'active',
          currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 2592000000),
          cancelAtPeriodEnd: false,
        };
      },
    });
  `);
}

async function loadRoute(opts) {
  globalThis.__receipts = 0;
  const db = dataUrl(`
    export const db = { query: async () => ({ rows: [], rowCount: 0 }),
                        tx: async (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }) };
  `);
  const ent = dataUrl(`export const invalidateEntitlement = () => {};`);
  const em = dataUrl(`
    export const sendWelcomeIfFirstTime = async () => {};
    export const sendSubscriptionChanged = async () => {};
    export const sendReceipt = async () => { globalThis.__receipts++; };
  `);
  const next = dataUrl(`
    export class NextResponse {
      static json(body, init = {}) { return { status: init.status ?? 200, body }; }
    }
  `);
  const js = toJs(readFileSync(SRC, 'utf8'))
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billingStub(opts)}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${ent}'`)
    .replace(/from ['"]@\/lib\/billing\/prorata['"]/g, `from 'data:text/javascript,export const computeProRataClawback = () => 0;'`)
    .replace(/from ['"]@\/lib\/emails\/dispatch['"]/g, `from '${em}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${next}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

const req = () => ({
  headers: { get: (n) => (n.toLowerCase() === 'stripe-signature' ? 'sig' : null) },
  text: async () => '{}',
});

test('invoice_paid: getSubscription throws UnknownPriceError -> 500 (Stripe retries)', async () => {
  const mod = await loadRoute({ getSubscriptionThrows: true });
  const res = await mod.POST(req());
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'handler_error');
  assert.equal(globalThis.__receipts, 0, 'no receipt for a renewal we failed to apply');
});

test('invoice_paid: getSubscription succeeds -> 200', async () => {
  const mod = await loadRoute({ getSubscriptionThrows: false });
  const res = await mod.POST(req());
  assert.equal(res.status, 200);
  assert.equal(res.body.received, true);
});
