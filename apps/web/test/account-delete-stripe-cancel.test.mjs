// QA-53: deleting an account must cancel EVERY subscription that can still bill
// (active, trialing, past_due, paused, incomplete, unpaid, and any status Stripe
// adds later), not just active / trialing / past_due, and must void an
// incomplete subscription's open first invoice (cancelling only stops automatic
// collection on it; the customer could still pay it). Exercises the REAL
// StripeProvider.cancelAllForAccountDeletion against the billing harness's
// faked Stripe client (no request leaves the process); the passthrough tests
// send calls through the real stripe-node request path to check the options
// it actually applies (PR #298 time budget).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEB, loadStripeProvider, subscriptionFixture } from './helpers/billing-harness.mjs';

let h;
beforeEach(async () => {
  h = await loadStripeProvider();
});

const FAR = () => Date.now() + 60_000;
const CUS = 'cus_del_1';
const openFirstInvoice = (id) => ({ id, object: 'invoice', status: 'open', billing_reason: 'subscription_create' });
const paidFirstInvoice = (id) => ({ id, object: 'invoice', status: 'paid', billing_reason: 'subscription_create' });
const sub = (id, status, over = {}) =>
  subscriptionFixture({ id, customer: CUS, status, latest_invoice: paidFirstInvoice(`in_${id}`), ...over });
const apis = (name) => h.calls.filter((c) => c.api === name);

for (const status of ['active', 'trialing', 'past_due', 'paused', 'incomplete', 'unpaid', 'some_future_status']) {
  test(`cancels a '${status}' subscription immediately, no final invoice, no proration`, async () => {
    h.subs.sub_x = sub('sub_x', status);
    const r = await h.provider.cancelAllForAccountDeletion(['sub_x'], CUS, FAR());
    assert.deepEqual(r.cancelled, ['sub_x']);
    const [c] = apis('subscriptions.cancel');
    assert.equal(c.id, 'sub_x');
    assert.equal(c.params.invoice_now, false);
    assert.equal(c.params.prorate, false);
    assert.deepEqual(c.params.expand, ['latest_invoice']);
    assert.equal(apis('subscriptions.update').length, 0, 'never cancel_at_period_end');
    assert.equal(h.subs.sub_x.status, 'canceled');
  });
}

test('paused (QA-53): found by the list with no DB row, cancelled, not counted as over', async () => {
  h.subs.sub_paused = sub('sub_paused', 'paused');
  const r = await h.provider.cancelAllForAccountDeletion([], CUS, FAR());
  assert.deepEqual(r.cancelled, ['sub_paused']);
  assert.deepEqual(r.alreadyOver, []);
});

for (const status of ['canceled', 'incomplete_expired']) {
  test(`a '${status}' subscription is already over: no cancel call`, async () => {
    h.subs.sub_x = sub('sub_x', status);
    const r = await h.provider.cancelAllForAccountDeletion(['sub_x'], CUS, FAR());
    assert.deepEqual(r.cancelled, []);
    assert.deepEqual(r.alreadyOver, ['sub_x']);
    assert.equal(apis('subscriptions.cancel').length, 0);
  });
}

test('incomplete: cancels, then VOIDS the open first invoice (it would stay payable)', async () => {
  h.subs.sub_inc = sub('sub_inc', 'incomplete', { latest_invoice: openFirstInvoice('in_first') });
  const r = await h.provider.cancelAllForAccountDeletion(['sub_inc'], CUS, FAR());
  assert.deepEqual(r.cancelled, ['sub_inc']);
  assert.deepEqual(r.voidedInvoices, ['in_first']);
  const order = h.calls.map((c) => c.api).filter((a) => a !== 'subscriptions.list');
  assert.deepEqual(order, ['subscriptions.cancel', 'invoices.voidInvoice'], 'cancel first, then void');
  assert.deepEqual(h.harness.voided, ['in_first']);
});

test('incomplete: an invoice Stripe already voided at cancel is not voided again', async () => {
  h.subs.sub_inc = sub('sub_inc', 'incomplete', { latest_invoice: openFirstInvoice('in_first') });
  h.harness.afterCancel = { sub_inc: { latest_invoice: { ...openFirstInvoice('in_first'), status: 'void' } } };
  const r = await h.provider.cancelAllForAccountDeletion(['sub_inc'], CUS, FAR());
  assert.deepEqual(r.voidedInvoices, []);
  assert.equal(apis('invoices.voidInvoice').length, 0);
});

test('past_due: an open RENEWAL invoice (a served period) is not voided; cancel stops its collection', async () => {
  h.subs.sub_pd = sub('sub_pd', 'past_due', {
    latest_invoice: { id: 'in_renew', object: 'invoice', status: 'open', billing_reason: 'subscription_cycle' },
  });
  const r = await h.provider.cancelAllForAccountDeletion(['sub_pd'], CUS, FAR());
  assert.deepEqual(r.cancelled, ['sub_pd']);
  assert.deepEqual(r.voidedInvoices, []);
});

test('retry after a failed void: the now-cancelled subscription still gets its open first invoice voided', async () => {
  h.subs.sub_inc = sub('sub_inc', 'incomplete', { latest_invoice: openFirstInvoice('in_first') });
  h.harness.voidError = Object.assign(new Error('api down'), { type: 'StripeAPIError', statusCode: 500 });
  await assert.rejects(() => h.provider.cancelAllForAccountDeletion(['sub_inc'], CUS, FAR()));
  assert.equal(h.subs.sub_inc.status, 'canceled');
  h.harness.voidError = null;
  h.calls.length = 0;
  const r = await h.provider.cancelAllForAccountDeletion(['sub_inc'], CUS, FAR());
  assert.equal(apis('subscriptions.cancel').length, 0, 'no second cancel');
  assert.deepEqual(r.alreadyOver, ['sub_inc']);
  assert.deepEqual(r.voidedInvoices, ['in_first']);
});

test('the Stripe list catches a subscription our DB does not have yet (webhook lag)', async () => {
  h.subs.sub_db = sub('sub_db', 'active');
  h.subs.sub_new = sub('sub_new', 'incomplete', { latest_invoice: openFirstInvoice('in_new') });
  const r = await h.provider.cancelAllForAccountDeletion(['sub_db'], CUS, FAR());
  assert.deepEqual(r.cancelled.sort(), ['sub_db', 'sub_new']);
  assert.deepEqual(r.voidedInvoices, ['in_new']);
  const [l] = apis('subscriptions.list');
  assert.equal(l.params.customer, CUS);
  assert.equal(l.params.status, 'all', "status 'all': the default list omits canceled but ALSO must not miss paused/incomplete");
  assert.deepEqual(l.params.expand, ['data.latest_invoice']);
  assert.equal(apis('subscriptions.retrieve').length, 0, 'ids the list returned are not read again');
});

test('a DB id the list did not return is retrieved (expanded); one Stripe no longer has counts as over', async () => {
  h.subs.sub_other = { ...sub('sub_other', 'paused'), customer: 'cus_elsewhere' };
  h.harness.retrieveErrors = { sub_gone: Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 }) };
  const r = await h.provider.cancelAllForAccountDeletion(['sub_other', 'sub_gone'], CUS, FAR());
  assert.deepEqual(r.cancelled, ['sub_other']);
  assert.deepEqual(r.alreadyOver, ['sub_gone']);
  const ret = apis('subscriptions.retrieve').find((c) => c.id === 'sub_other');
  assert.deepEqual(ret.params, { expand: ['latest_invoice'] });
});

test('no customer id: only the DB ids are read (no list call)', async () => {
  h.subs.sub_x = sub('sub_x', 'paused');
  const r = await h.provider.cancelAllForAccountDeletion(['sub_x'], null, FAR());
  assert.deepEqual(r.cancelled, ['sub_x']);
  assert.equal(apis('subscriptions.list').length, 0);
});

test('list pages are followed with starting_after', async () => {
  h.harness.listPages = [
    { object: 'list', data: [sub('sub_p1', 'canceled')], has_more: true },
    { object: 'list', data: [sub('sub_p2', 'paused')], has_more: false },
  ];
  h.subs.sub_p2 = sub('sub_p2', 'paused');
  const r = await h.provider.cancelAllForAccountDeletion([], CUS, FAR());
  assert.deepEqual(r.cancelled, ['sub_p2']);
  const lists = apis('subscriptions.list');
  assert.equal(lists.length, 2);
  assert.equal(lists[1].params.starting_after, 'sub_p1');
});

test('a cancel Stripe answers "already canceled" counts as over; any other refusal throws', async () => {
  h.subs.sub_a = sub('sub_a', 'active');
  h.harness.cancelErrors = { sub_a: Object.assign(new Error('This subscription has already been canceled.'), { type: 'StripeInvalidRequestError' }) };
  const r = await h.provider.cancelAllForAccountDeletion(['sub_a'], CUS, FAR());
  assert.deepEqual(r.alreadyOver, ['sub_a']);

  h.harness.cancelErrors = { sub_a: Object.assign(new Error('card_declined?'), { type: 'StripeAPIError', statusCode: 500 }) };
  h.subs.sub_a = sub('sub_a', 'paused');
  await assert.rejects(() => h.provider.cancelAllForAccountDeletion(['sub_a'], CUS, FAR()), /card_declined/);
});

test('a list failure throws (deletion must not go ahead blind)', async () => {
  h.harness.listError = Object.assign(new Error('timeout'), { type: 'StripeConnectionError' });
  h.subs.sub_x = sub('sub_x', 'active');
  await assert.rejects(() => h.provider.cancelAllForAccountDeletion(['sub_x'], CUS, FAR()), /timeout/);
  assert.equal(apis('subscriptions.cancel').length, 0);
});

test('every Stripe POST carries a fresh idempotency key and the bounded call options', async () => {
  h.subs.sub_inc = sub('sub_inc', 'incomplete', { latest_invoice: openFirstInvoice('in_first') });
  await h.provider.cancelAllForAccountDeletion(['sub_inc'], CUS, FAR());
  for (const c of h.calls) {
    assert.equal(c.ropts.timeout, 6000, c.api);
    assert.equal(c.ropts.maxNetworkRetries, 0, c.api);
  }
  const [cancel] = apis('subscriptions.cancel');
  const [v] = apis('invoices.voidInvoice');
  assert.match(cancel.ropts.idempotencyKey, /^account-delete-cancel-sub_inc-[0-9a-f-]{36}$/);
  assert.match(v.ropts.idempotencyKey, /^account-delete-void-in_first-[0-9a-f-]{36}$/);
});

test('deadline: no Stripe call starts unless it can finish (worst 2 x 6 s) before the deadline', async () => {
  h.subs.sub_x = sub('sub_x', 'active');
  await assert.rejects(
    () => h.provider.cancelAllForAccountDeletion(['sub_x'], CUS, Date.now() + 11_000),
    (e) => e.name === 'StripeDeadlineError',
  );
  assert.equal(h.calls.length, 0, 'nothing was sent');
  assert.equal(h.mod.STRIPE_CALL_WORST_MS, 12_000);
});

test('passthrough (real stripe-node): list is one attempt, 6 s timeout', async () => {
  h.harness.passthrough = true;
  await assert.rejects(() => h.provider.cancelAllForAccountDeletion([], CUS, FAR()));
  const a = h.harness.netAttempts;
  assert.equal(a.length, 1, `stripe-node retried: ${a.length} attempts`);
  assert.match(a[0].path, /^\/v1\/subscriptions\?/);
  assert.equal(a[0].timeout, 6000);
});

test('passthrough (real stripe-node): cancel is one attempt, 6 s timeout', async () => {
  h.subs.sub_x = sub('sub_x', 'paused');
  h.harness.passthroughApis = ['subscriptions.cancel'];
  await assert.rejects(() => h.provider.cancelAllForAccountDeletion(['sub_x'], CUS, FAR()));
  const a = h.harness.netAttempts;
  assert.equal(a.length, 1, `stripe-node retried: ${a.length} attempts`);
  assert.equal(a[0].method, 'DELETE');
  assert.ok(a[0].path.startsWith('/v1/subscriptions/sub_x?'), a[0].path);
  assert.match(a[0].path, /invoice_now=false/);
  assert.match(a[0].path, /prorate=false/);
  assert.equal(a[0].timeout, 6000);
});

test('passthrough (real stripe-node): void is one attempt, 6 s timeout', async () => {
  h.subs.sub_inc = sub('sub_inc', 'incomplete', { latest_invoice: openFirstInvoice('in_first') });
  h.harness.passthroughApis = ['invoices.voidInvoice'];
  await assert.rejects(() => h.provider.cancelAllForAccountDeletion(['sub_inc'], CUS, FAR()));
  const a = h.harness.netAttempts;
  assert.equal(a.length, 1, `stripe-node retried: ${a.length} attempts`);
  assert.equal(a[0].path, '/v1/invoices/in_first/void');
  assert.equal(a[0].timeout, 6000);
});

test('passthrough (real stripe-node): a reset socket on cancel is retried once -> worst call = 2 x timeout', async () => {
  h.subs.sub_x = sub('sub_x', 'paused');
  h.harness.passthroughApis = ['subscriptions.cancel'];
  h.harness.netErrorCode = 'ECONNRESET';
  await assert.rejects(() => h.provider.cancelAllForAccountDeletion(['sub_x'], CUS, FAR()));
  assert.equal(h.harness.netAttempts.length, 2);
});

test('time budget: the route bound fits one subscription worst case and stays under maxDuration', () => {
  const route = readFileSync(join(WEB, 'src/app/api/users/me/route.ts'), 'utf8');
  const maxDuration = Number(route.match(/^export const maxDuration = (\d+);/m)?.[1]);
  const budgetMs = Number(route.match(/^const STRIPE_BUDGET_MS = ([\d_]+);/m)?.[1].replace(/_/g, ''));
  assert.ok(maxDuration > 0 && budgetMs > 0, 'maxDuration / STRIPE_BUDGET_MS not found');
  const worst = h.mod.STRIPE_CALL_WORST_MS;
  assert.ok(budgetMs >= 3 * worst, 'a list + cancel + void must fit the budget');
  assert.ok(budgetMs / 1000 + 20 <= maxDuration, 'leave >= 20 s for auth, statements, COMMIT, admin delete, audit');
  assert.ok(maxDuration <= 60);
});
