// _mapStripeStatus contract test — V3 Phase 1b launch blocker.
//
// Context: Stripe's Subscription.Status has 8 values; our DB CHECK on
// subscriptions.status (migration 013:117) accepts 6. Blind casting
// `sub.status as SubscriptionStatus` CHECK-violated the webhook on
// 'unpaid' / 'incomplete_expired' and silently dropped sub-state updates.
// Fix: _mapStripeStatus remaps the two extra values and throws on unknown.
//
// This test covers:
//   - 6 passthrough cases (trialing, active, past_due, canceled, incomplete, paused)
//   - 2 remapped cases (incomplete_expired → canceled, unpaid → past_due)
//   - 1 unknown value throws UnknownStatusError (fail-loud contract)
//
// Load approach parallels billing-webhook-verification.test.mjs: transpile
// the stripe provider in-memory, stub the 'stripe' SDK import with a
// no-op, then invoke the named exports directly. No real DB, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/lib/billing/providers/stripe.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

// Stripe SDK stub — the constructor is called at getClient() time only,
// and we never call getClient() in this test. But we still need a module
// shape the transpiled source can import without blowing up.
function stripeStub() {
  return dataUrl(`
    class Stripe {
      constructor() {}
    }
    Stripe.default = Stripe;
    export default Stripe;
  `);
}

async function loadModule() {
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js.replace(/from ['"]stripe['"]/g, `from '${stripeStub()}'`);
  // Keep the types import — it's a type-only import, erased by transpile.
  // Billing/types resolves relative to the source dir, but data-URL modules
  // can't do relative node_modules resolution, so stub it to an empty
  // module (the types are erased, so runtime values aren't needed).
  js = js.replace(/from ['"]\.\.\/types['"]/g, `from 'data:text/javascript,export {};'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

test('_mapStripeStatus: trialing passes through unchanged', async () => {
  const mod = await loadModule();
  assert.equal(mod._mapStripeStatus('trialing'), 'trialing');
});

test('_mapStripeStatus: active passes through unchanged', async () => {
  const mod = await loadModule();
  assert.equal(mod._mapStripeStatus('active'), 'active');
});

test('_mapStripeStatus: past_due passes through unchanged', async () => {
  const mod = await loadModule();
  assert.equal(mod._mapStripeStatus('past_due'), 'past_due');
});

test('_mapStripeStatus: canceled passes through unchanged', async () => {
  const mod = await loadModule();
  assert.equal(mod._mapStripeStatus('canceled'), 'canceled');
});

test('_mapStripeStatus: incomplete passes through unchanged', async () => {
  const mod = await loadModule();
  assert.equal(mod._mapStripeStatus('incomplete'), 'incomplete');
});

test('_mapStripeStatus: paused passes through unchanged', async () => {
  const mod = await loadModule();
  assert.equal(mod._mapStripeStatus('paused'), 'paused');
});

test('_mapStripeStatus: incomplete_expired remaps to canceled', async () => {
  const mod = await loadModule();
  // Stripe gives up after ~23h of an unpaid initial invoice — the
  // subscription is effectively dead. The DB has no 'incomplete_expired'
  // value, so we fold it into 'canceled' rather than CHECK-violate.
  assert.equal(mod._mapStripeStatus('incomplete_expired'), 'canceled');
});

test('_mapStripeStatus: unpaid remaps to past_due', async () => {
  const mod = await loadModule();
  // Stripe's 'unpaid' is "dunning exhausted but not yet canceled". We
  // don't track that extra state; collapsing it to 'past_due' keeps the
  // dunning email + access gate firing without a CHECK violation.
  assert.equal(mod._mapStripeStatus('unpaid'), 'past_due');
});

test('_mapStripeStatus: unknown status throws UnknownStatusError (fail loud)', async () => {
  const mod = await loadModule();
  assert.throws(
    // Cast through unknown — the whole point is runtime drift (Stripe
    // adds a new value in a future API version).
    () => mod._mapStripeStatus('some_future_stripe_status'),
    (err) => {
      assert.equal(err.name, 'UnknownStatusError');
      assert.equal(err.stripeStatus, 'some_future_stripe_status');
      assert.match(err.message, /not recognized/);
      return true;
    },
  );
});
