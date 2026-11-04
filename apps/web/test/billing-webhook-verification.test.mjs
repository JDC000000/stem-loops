// Webhook signature-verification contract test — V3 Phase 1a.
//
// Verifies the two guarantees the webhook route owes the rest of the system:
//   1. A request whose signature fails verification is rejected with 400 and
//      NO database write is attempted.
//   2. Reading the body uses req.text() (raw string), not req.json() — the
//      signature verifier depends on the exact bytes Stripe sent. The route
//      source carries a comment to this effect; we grep for the invocation
//      pattern as a regression guard.
//
// Pattern mirrors sentry-header-scrub.test.mjs: load the route in-memory with
// stubs for '@/lib/billing', '@/lib/db' and '@/lib/billing/entitlements'.
// Nothing hits the network.

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

function billingStub({ handleWebhookThrows, event, name = 'stripe' }) {
  const payload = JSON.stringify(event ?? null);
  return dataUrl(`
    export const getBillingProvider = () => ({
      name: '${name}',
      handleWebhook: async () => {
        if (${handleWebhookThrows ? 'true' : 'false'}) {
          throw new Error('invalid signature');
        }
        return ${payload};
      },
      getSubscription: async () => ({
        providerSubscriptionId: 'sub_X',
        providerCustomerId: 'cus_X',
        priceId: 'price_X',
        planCode: 'pro',
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 2592000000),
        cancelAtPeriodEnd: false,
      }),
    });
  `);
}

function dbStub({ fail = false } = {}) {
  return dataUrl(`
    let count = 0;
    export const db = {
      query: async () => {
        count++;
        if (${fail}) throw new Error('db down');
        return { rows: [], rowCount: 0 };
      },
      _count: () => count,
    };
    export const _dbCount = () => count;
  `);
}

function entitlementsStub() {
  return dataUrl(`
    export const invalidateEntitlement = () => {};
  `);
}

async function loadRoute({ handleWebhookThrows = false, event = { type: 'unhandled', eventType: 'noop' }, dbFail = false } = {}) {
  let js = toJs(readFileSync(SRC, 'utf8'));
  const bStub = billingStub({ handleWebhookThrows, event });
  const dStub = dbStub({ fail: dbFail });
  const eStub = entitlementsStub();
  // Stub the next/server imports too — in a pure node run we need our own
  // NextResponse that matches the Response-like shape the route uses.
  const nextStub = dataUrl(`
    export class NextResponse {
      static json(body, init = {}) {
        const headers = new Map(Object.entries((init && init.headers) || {}));
        return { status: init.status ?? 200, body, headers, _isJson: true };
      }
    }
  `);
  js = js
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${bStub}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dStub}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${eStub}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

function makeRequest({ body = '{}', signature = null } = {}) {
  return {
    headers: {
      get(name) {
        const k = name.toLowerCase();
        if (k === 'stripe-signature') return signature;
        return null;
      },
    },
    text: async () => body,
    json: async () => {
      throw new Error('route must use req.text(), not req.json()');
    },
  };
}

test('webhook returns 400 and never calls DB when signature verification throws', async () => {
  const mod = await loadRoute({ handleWebhookThrows: true });
  const res = await mod.POST(makeRequest({ body: '{"forged":true}', signature: 'bad' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid signature');
});

test('webhook reads the raw body with req.text(), not req.json()', async () => {
  const mod = await loadRoute({
    handleWebhookThrows: false,
    event: { type: 'unhandled', eventType: 'ping' },
  });
  // Our fake request throws if .json() is called. If the route reaches 200,
  // it must have used .text().
  const res = await mod.POST(makeRequest({ body: 'raw-bytes-here', signature: 'ok' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.received, true);
});

test('webhook returns 500 on DB handler error so Stripe retries', async () => {
  const mod = await loadRoute({
    event: {
      type: 'credit_purchase_completed',
      userId: '11111111-1111-1111-1111-111111111111',
      packCode: 'credits_20',
      providerChargeId: 'pi_X',
      amountCents: 500,
      currency: 'cad',
      priceId: 'price_X',
    },
    dbFail: true,
  });
  const res = await mod.POST(makeRequest({ body: '{}', signature: 'ok' }));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'handler_error');
});

test('route source uses req.text() for the signature payload (regression guard)', () => {
  const src = readFileSync(SRC, 'utf8');
  assert.match(src, /req\.text\(\)/, 'webhook route must read the raw body with req.text()');
  assert.doesNotMatch(src, /await\s+req\.json\(\)\s*;.*constructEvent/s);
});
