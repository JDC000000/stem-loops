// PR #298 review R2-2: the webhook holds a pooled DB connection and an open
// transaction across Stripe reads, so every wait on that path must be bounded,
// and the bounds must add up to less than the route's maxDuration.
//
// The request-option checks go through the REAL stripe-node request path: the
// harness's `passthrough` sends the call into the SDK, whose transport is the
// harness's blocking httpClient (no request leaves the process). The SDK hands
// that transport the per-request timeout, and calls it once per attempt, so
// these tests observe the options stripe-node actually applies, not the
// arguments a mock happened to receive.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WEB, loadStripeProvider, loadWebhookRoute, makeState, envelope, sign,
  creditSessionFixture, subscriptionFixture,
} from './helpers/billing-harness.mjs';

const src = (f) => readFileSync(join(WEB, f), 'utf8');
const num = (re, text, what) => {
  const m = text.match(re);
  assert.ok(m, `could not find ${what}`);
  return Number(m[1]);
};

let h;
beforeEach(async () => { h = await loadStripeProvider(); });

const attemptsFor = (path) => h.harness.netAttempts.filter((a) => a.path.startsWith(path));

test('getSubscription: one attempt (no SDK retries), 8 s timeout, through the real SDK', async () => {
  h.harness.passthrough = true;
  await assert.rejects(() => h.provider.getSubscription('sub_budget'));
  const a = attemptsFor('/v1/subscriptions/sub_budget');
  assert.equal(a.length, 1, `stripe-node retried: ${a.length} attempts`);
  assert.equal(a[0].timeout, 8000);
});

test('getInvoiceState: one attempt, 8 s timeout, through the real SDK', async () => {
  h.harness.passthrough = true;
  await assert.rejects(() => h.provider.getInvoiceState('in_budget'));
  const a = attemptsFor('/v1/invoices/in_budget');
  assert.equal(a.length, 1);
  assert.equal(a[0].timeout, 8000);
});

test('credit session line-item read: one attempt, 8 s timeout; failure is a retryable 500 error', async () => {
  h.harness.passthrough = true;
  const { body, signature } = sign(envelope('checkout.session.completed', creditSessionFixture({ id: 'cs_budget' })));
  await assert.rejects(() => h.provider.handleWebhook(body, signature), (e) => e.name === 'BillingProviderUnavailableError');
  const a = attemptsFor('/v1/checkout/sessions/cs_budget');
  assert.equal(a.length, 1);
  assert.equal(a[0].timeout, 8000);
});

test('L-4 re-read of a stale unknown payload: one attempt, 8 s timeout', async () => {
  h.harness.passthrough = true;
  const legacy = subscriptionFixture({
    id: 'sub_budget_l4',
    items: { object: 'list', data: [{ ...subscriptionFixture().items.data[0], price: { id: 'price_legacy', object: 'price' } }] },
  });
  const { body, signature } = sign(envelope('customer.subscription.updated', legacy, { metadata: {} }));
  await assert.rejects(() => h.provider.handleWebhook(body, signature), (e) => e.name === 'BillingProviderUnavailableError');
  const a = attemptsFor('/v1/subscriptions/sub_budget_l4');
  assert.equal(a.length, 1);
  assert.equal(a[0].timeout, 8000);
});

test('time budget: every bounded wait on the webhook path adds up to less than maxDuration', async () => {
  const route = src('src/app/api/billing/webhook/route.ts');
  const stripe = src('src/lib/billing/providers/stripe.ts');
  const db = src('src/lib/db.ts');
  const maxDuration = num(/^export const maxDuration = (\d+);/m, route, 'maxDuration');
  const lock = num(/^const LOCK_TIMEOUT = '(\d+)s';/m, route, 'LOCK_TIMEOUT');
  const stmt = num(/^const STATEMENT_TIMEOUT = '(\d+)s';/m, route, 'STATEMENT_TIMEOUT');
  const idle = num(/^const IDLE_IN_TX_TIMEOUT = '(\d+)s';/m, route, 'IDLE_IN_TX_TIMEOUT');
  const read = num(/STRIPE_WEBHOOK_READ_OPTIONS = Object\.freeze\(\{ timeout: (\d+), maxNetworkRetries: 0 \}\)/, stripe, 'read options') / 1000;
  const connect = num(/^const WEBHOOK_POOL_CONNECT_TIMEOUT_MS = (\d+);/m, db, 'webhook pool connect timeout') / 1000;

  // The route module really exports it (Next reads the export, not a comment).
  const mod = await loadWebhookRoute(h.provider, makeState());
  assert.equal(mod.maxDuration, maxDuration);

  // One read outside the lock, a connection, the lock wait, two reads inside.
  const waits = read + connect + lock + 2 * read;
  assert.ok(waits < maxDuration, `bounded waits ${waits}s >= maxDuration ${maxDuration}s`);
  assert.ok(maxDuration <= 60, 'maxDuration above the 60 s that every Vercel plan allows without Fluid compute');
  // Idle-in-transaction must outlast the longest gap between two statements
  // of the locked transaction (one Stripe read), or it would kill healthy work.
  assert.ok(idle > read, `idle_in_transaction ${idle}s <= one Stripe read ${read}s`);
  // A statement must never be cut short before the lock wait it contains.
  assert.ok(stmt >= lock, `statement_timeout ${stmt}s < lock_timeout ${lock}s`);
  assert.ok(connect < maxDuration);
});
