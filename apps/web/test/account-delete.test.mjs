// DELETE /api/users/me contract test — V3 Phase 1b (TSD §6.3, RGPD).
//
// Same mocking strategy as claim-jobs.test.mjs: transpile the route in
// memory and swap @/lib/auth/supabase, @/lib/billing, @/lib/db and
// next/server for data-URL stubs. Calls are recorded on globalThis.__ad.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createHmac } from 'node:crypto';
import { SAME_ORIGIN_URL, SAME_ORIGIN_IMPORT_RE } from './helpers/same-origin.mjs';
import { wirePureLibs } from './helpers/pure-libs.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/app/api/users/me/route.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const USER = { user_id: '33333333-3333-3333-3333-333333333333', email: 'Jon@Example.com' };

function authStub(user, { deleteFails = false } = {}) {
  return dataUrl(`
    export const getUser = async () => (${JSON.stringify(user)});
    export const deleteAuthUser = async (id) => {
      globalThis.__ad.calls.push(['deleteAuthUser', id]);
      if (${deleteFails}) throw new Error('admin down');
    };
  `);
}

function billingStub({ cancelError = null, expireError = null, expired = [] } = {}) {
  return dataUrl(`
    export const getBillingProvider = () => ({
      name: 'stripe',
      cancelSubscription: async (id, atPeriodEnd) => {
        globalThis.__ad.calls.push(['cancelSubscription', id, atPeriodEnd]);
        if (${JSON.stringify(cancelError)}) throw Object.assign(new Error('stripe'), ${JSON.stringify(cancelError)});
      },
      // QA-72: deletion expires the customer's open checkout sessions first.
      expireOpenCheckoutSessions: async (customerId, deadlineMs) => {
        globalThis.__ad.calls.push(['expireOpenCheckoutSessions', customerId, deadlineMs]);
        if (${JSON.stringify(expireError)}) throw Object.assign(new Error('stripe expire'), ${JSON.stringify(expireError)});
        return { expired: ${JSON.stringify(expired)} };
      },
    });
  `);
}

// Records Sentry captures on globalThis.__ad.sentry.
const sentryStub = () =>
  dataUrl(`
    export const captureMessage = (message, opts) => { (globalThis.__ad.sentry ??= []).push({ message, opts }); };
    export const captureException = (e, opts) => { (globalThis.__ad.sentry ??= []).push({ e, opts }); };
  `);

// Records tx lifecycle as ['tx','begin'|'commit'|'rollback'] so tests can assert
// that a failure inside the erase+cancel transaction rolls it back.
// opts.errors maps a statement regex source -> { code, message } to throw.
function dbStub(subIds, errors = {}, customerId = null) {
  return dataUrl(`
    const errors = ${JSON.stringify(errors)};
    const customerId = ${JSON.stringify(customerId)};
    const run = async (text, params) => {
      globalThis.__ad.calls.push(['query', text, params]);
      for (const [re, e] of Object.entries(errors)) {
        if (new RegExp(re).test(text)) throw Object.assign(new Error(e.message), { code: e.code });
      }
      if (/FROM public\\.customers_billing/.test(text)) {
        return customerId ? { rows: [{ provider_customer_id: customerId }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/FROM public\\.subscriptions/.test(text)) {
        return { rows: ${JSON.stringify(subIds)}.map((id) => ({ provider_subscription_id: id })), rowCount: ${subIds.length} };
      }
      return { rows: [], rowCount: 1 };
    };
    export const db = {
      query: run,
      tx: async (fn) => {
        globalThis.__ad.calls.push(['tx', 'begin']);
        try {
          // Statements issued on the TRANSACTION's client are also noted in __ad.txq, so a test
          // can tell them from a pool query (db.query) made while the tx is open: that one runs
          // on another connection, commits at once and is NOT rolled back with the tx.
          const r = await fn({ query: (text, params) => { (globalThis.__ad.txq ??= []).push(text); return run(text, params); } });
          globalThis.__ad.calls.push(['tx', 'commit']);
          return r;
        } catch (e) {
          globalThis.__ad.calls.push(['tx', 'rollback']);
          throw e;
        }
      },
    };
  `);
}

const nextStub = () =>
  dataUrl(`
    export class NextResponse {
      constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; }
      static json(body, init = {}) { return { status: init.status ?? 200, body }; }
    }
    export class NextRequest {}
  `);

async function loadRoute({
  user = USER, subIds = [], cancelError = null, deleteFails = false, dbErrors = {},
  customerId = null, expireError = null, expired = [],
} = {}) {
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub(user, { deleteFails })}'`)
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billingStub({ cancelError, expireError, expired })}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub(subIds, dbErrors, customerId)}'`)
    .replace(SAME_ORIGIN_IMPORT_RE, `from '${SAME_ORIGIN_URL}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub()}'`);
  return await import(dataUrl(wirePureLibs(js)) + '#' + Math.random());
}

// Default headers include a same-origin pair so tests that aren't exercising
// the origin guard still pass. Override via the second arg to test guard paths.
const DEFAULT_HEADERS = { origin: 'https://stem-loops.com', host: 'stem-loops.com' };
const makeReq = (body, headers = DEFAULT_HEADERS) => ({
  json: async () => body,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

beforeEach(() => {
  globalThis.__ad = { calls: [] };
});
const names = () => globalThis.__ad.calls.map((c) => c[0]);
const auditInserts = () =>
  globalThis.__ad.calls.filter((c) => c[0] === 'query' && /INSERT INTO public\.usage_events/.test(c[1]));

test('DELETE /api/users/me — 401 when unauthenticated, nothing touched', async () => {
  const mod = await loadRoute({ user: null });
  const res = await mod.DELETE(makeReq({ confirm_email: 'x@y.co' }));
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHENTICATED');
  assert.deepEqual(names(), []);
});

test('DELETE /api/users/me — 400 EMAIL_MISMATCH, nothing touched', async () => {
  const mod = await loadRoute({ subIds: ['sub_1'] });
  const res = await mod.DELETE(makeReq({ confirm_email: 'someone@else.com' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'EMAIL_MISMATCH');
  assert.deepEqual(names(), []);
});

test('DELETE /api/users/me — 400 EMAIL_MISMATCH when confirm_email missing', async () => {
  const mod = await loadRoute();
  const res = await mod.DELETE(makeReq({}));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'EMAIL_MISMATCH');
});

test('DELETE /api/users/me — 403 on cross-origin request', async () => {
  const mod = await loadRoute();
  const res = await mod.DELETE(
    makeReq({ confirm_email: USER.email }, { origin: 'https://evil.example', host: 'stem-loops.com' }),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(names(), []);
});

test('DELETE /api/users/me — happy path: cancels Stripe, deletes auth user, audits, 204', async () => {
  const mod = await loadRoute({ subIds: ['sub_a', 'sub_b'] });
  const res = await mod.DELETE(
    makeReq({ confirm_email: '  jon@example.com ' }, { origin: 'https://stem-loops.com', host: 'stem-loops.com' }),
  );
  assert.equal(res.status, 204);
  assert.equal(res.body, null);

  const calls = globalThis.__ad.calls;
  const cancels = calls.filter((c) => c[0] === 'cancelSubscription');
  assert.deepEqual(cancels, [
    ['cancelSubscription', 'sub_a', false],
    ['cancelSubscription', 'sub_b', false],
  ]);
  const del = calls.filter((c) => c[0] === 'deleteAuthUser');
  assert.deepEqual(del, [['deleteAuthUser', USER.user_id]]);

  // Order: erase chord_edits (fn) → cancel Stripe → COMMIT → tombstone → deleteAuthUser → audit.
  const order = calls.map((c) => {
    if (c[0] === 'tx') return `tx:${c[1]}`;
    if (c[0] !== 'query') return c[0];
    if (/INSERT/.test(c[1])) return 'query:audit';
    if (/UPDATE\s+public\.jobs\b/.test(c[1])) return 'query:jobs_expire';
    if (/UPDATE/.test(c[1])) return 'query:tombstone';
    if (/delete_chord_edits_for_user/.test(c[1])) return 'query:chord_edits_erase';
    return 'query:select';
  });
  const at = (k) => order.indexOf(k);
  assert.ok(at('tx:begin') < at('query:chord_edits_erase'));
  assert.ok(at('query:chord_edits_erase') < at('cancelSubscription'), 'erase BEFORE the irreversible Stripe cancel');
  assert.ok(at('cancelSubscription') < at('tx:commit'));
  assert.ok(at('tx:commit') < at('query:tombstone'));
  assert.ok(at('query:tombstone') < at('deleteAuthUser'));
  assert.ok(at('deleteAuthUser') < at('query:audit'));
  assert.ok(!order.includes('tx:rollback'));

  // Erasure goes through the SECURITY DEFINER function (migration 031), never a
  // raw DELETE (stemloops_app has no DELETE on chord_edits — migration 025).
  assert.ok(
    !calls.some((c) => c[0] === 'query' && /DELETE\s+FROM\s+public\.chord_edits/i.test(c[1])),
    'raw DELETE FROM chord_edits would raise 42501 as stemloops_app',
  );
  const sweep = calls.find((c) => c[0] === 'query' && /delete_chord_edits_for_user/.test(c[1]));
  assert.ok(sweep, 'expected a delete_chord_edits_for_user() call before deleteAuthUser');
  assert.deepEqual(sweep[2], [USER.user_id]);

  // Subscription lookup scoped to this user and live statuses.
  const sel = calls.find((c) => c[0] === 'query' && /FROM public\.subscriptions/.test(c[1]));
  assert.equal(sel[2][0], USER.user_id);
  assert.deepEqual(sel[2][2], ['active', 'trialing', 'past_due']);

  // usage_events audit row: kind=account_deleted, no raw user id / email.
  const audit = auditInserts();
  assert.equal(audit.length, 1);
  assert.match(audit[0][1], /'account_deleted'/);
  const detail = JSON.parse(audit[0][2][0]);
  assert.equal(detail.subscriptions_cancelled, 2);
  assert.match(detail.user_hash, /^[0-9a-f]{64}$/);
  assert.ok(!audit[0][2][0].includes(USER.user_id));
  assert.ok(!audit[0][2][0].toLowerCase().includes('jon@example.com'));
});

test('DELETE /api/users/me — no subscriptions: still deletes', async () => {
  const mod = await loadRoute({ subIds: [] });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 204);
  assert.ok(!names().includes('cancelSubscription'));
  assert.ok(names().includes('deleteAuthUser'));
});

test('DELETE /api/users/me — Stripe failure ROLLS BACK the erasure, no tombstone (502)', async () => {
  const mod = await loadRoute({ subIds: ['sub_a'], cancelError: { code: 'api_connection_error' } });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'SUBSCRIPTION_CANCEL_FAILED');
  const calls = globalThis.__ad.calls;
  assert.ok(calls.some((c) => c[0] === 'tx' && c[1] === 'rollback'), 'erase+cancel tx must roll back');
  assert.ok(!calls.some((c) => c[0] === 'tx' && c[1] === 'commit'));
  assert.ok(!calls.some((c) => c[0] === 'query' && /UPDATE public\.users/.test(c[1])), 'no tombstone');
  assert.ok(!names().includes('deleteAuthUser'));
  assert.equal(auditInserts().length, 0);
});

test('DELETE /api/users/me — Stripe resource_missing counts as already cancelled', async () => {
  const mod = await loadRoute({ subIds: ['sub_gone'], cancelError: { code: 'resource_missing' } });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 204);
  assert.ok(names().includes('deleteAuthUser'));
});

test('DELETE /api/users/me — Supabase admin failure → 500, no audit row', async () => {
  const mod = await loadRoute({ deleteFails: true });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'DELETE_FAILED');
  assert.equal(auditInserts().length, 0);
});

// Review-fix tests (PR #54 round-2 adversarial findings)

test('DELETE /api/users/me — 403 when Origin header missing (fail-closed)', async () => {
  const mod = await loadRoute();
  const res = await mod.DELETE(
    makeReq({ confirm_email: USER.email }, { host: 'stem-loops.com' }),
  );
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'BAD_ORIGIN');
  assert.deepEqual(names(), []);
});

test('DELETE /api/users/me — 403 when Origin is literal "null" (sandboxed iframe)', async () => {
  const mod = await loadRoute();
  const res = await mod.DELETE(
    makeReq({ confirm_email: USER.email }, { origin: 'null', host: 'stem-loops.com' }),
  );
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'BAD_ORIGIN');
  assert.deepEqual(names(), []);
});

test('DELETE /api/users/me — Host header with default port :443 still matches origin', async () => {
  // Proxy sometimes forwards `Host: x.com:443`; route normalizes both sides.
  const mod = await loadRoute({ subIds: [] });
  const res = await mod.DELETE(
    makeReq({ confirm_email: USER.email }, { origin: 'https://stem-loops.com', host: 'stem-loops.com:443' }),
  );
  assert.equal(res.status, 204);
});

// The erasure failing must stop the request BEFORE the irreversible Stripe cancel
// (this is the prod bug: 42501 after the subscription was already cancelled).
for (const [label, code, message] of [
  ['permission denied (42501)', '42501', 'permission denied for function delete_chord_edits_for_user'],
  ['function missing, migration 031 not applied (42883)', '42883', 'function public.delete_chord_edits_for_user(uuid) does not exist'],
  ['table missing (42P01) is no longer swallowed', '42P01', 'relation "public.chord_edits" does not exist'],
  ['deadlock (40P01)', '40P01', 'deadlock detected'],
]) {
  test(`DELETE /api/users/me — chord_edits erasure failure, ${label}: 500, NOTHING cancelled`, async () => {
    const mod = await loadRoute({
      subIds: ['sub_a'],
      dbErrors: { 'delete_chord_edits_for_user': { code, message } },
    });
    const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'DELETE_FAILED');
    assert.ok(!names().includes('cancelSubscription'), 'subscription must NOT be cancelled');
    assert.ok(!names().includes('deleteAuthUser'));
    assert.ok(
      !globalThis.__ad.calls.some((c) => c[0] === 'query' && /UPDATE public\.users/.test(c[1])),
      'deleted_at must NOT be stamped',
    );
    assert.equal(auditInserts().length, 0);
  });
}

test('DELETE /api/users/me — tolerates users.deleted_at column absent (42703)', async () => {
  // UPDATE public.users throws column-does-not-exist; route should catch and
  // continue, still deleting auth user + writing audit.
  const mod = await loadRoute({
    dbErrors: { 'UPDATE public\\.users': { code: '42703', message: 'column "deleted_at" does not exist' } },
  });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 204, 'tolerance path: tombstone attempt swallows 42703 and continues');
  assert.ok(names().includes('deleteAuthUser'));
  assert.equal(auditInserts().length, 1);
});

// W1 overnight 2026-11-12: deleting the account used to leave the user's live jobs
// (audio, stems, loops; up to 24 h) in place with user_id flipped to NULL by the
// FK's ON DELETE SET NULL. An ownerless job is the ANONYMOUS posture: any link
// holder may then cut its loops and any Studio account may sign its full-length
// WAVs, which the owner's own job never allowed. The deletion page promises the
// job history goes. The route must expire the user's jobs (every job route treats
// expires_at <= now() as gone; the worker's sweep then removes the objects) and
// must do it INSIDE the erase transaction, so a failed Stripe cancel leaves them.
const jobsExpiry = () =>
  globalThis.__ad.calls.filter((c) => c[0] === 'query' && /UPDATE\s+public\.jobs\b/i.test(c[1]));

test('DELETE /api/users/me — expires the user\'s live jobs inside the erase tx, before deleteAuthUser', async () => {
  const mod = await loadRoute({ subIds: ['sub_a'] });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 204);

  const exp = jobsExpiry();
  assert.equal(exp.length, 1, 'expected exactly one UPDATE public.jobs (expire the user\'s jobs)');
  // 2026-11-15: expires_at = created_at, not now(). A Pro/Studio library is retained PAST
  // expires_at by the subscription (lib/retention.ts JOB_RETAINED_UNTIL_SQL), which ignores
  // the subscription once expires_at <= created_at; so this kills paid retention too.
  // A DEMO song (migration 040) is retained until 2099-12-31 whatever expires_at says, so the
  // same UPDATE also clears is_demo: otherwise the owner's deletion would leave demos retained
  // AND anonymous (user_id ON DELETE SET NULL). Real-DB pin:
  // apps/worker/tests/test_paid_retention.py::test_account_deletion_statement_ends_a_demo.
  assert.match(exp[0][1], /,\s*is_demo\s*=\s*false\s+WHERE/i, 'the deletion must clear is_demo');
  assert.match(exp[0][1], /\(\s*expires_at\s*>\s*created_at\s+OR\s+is_demo\s*\)/i, 'an already-killed demo is still cleared');
  assert.match(exp[0][1], /SET\s+expires_at\s*=\s*LEAST\(expires_at,\s*created_at\)/i);
  assert.match(exp[0][1], /WHERE\s+user_id\s*=\s*\$1::uuid/i);
  assert.match(exp[0][1], /expires_at\s*>\s*created_at/i, 'every not-yet-killed job, including a paid one past its 24 h');
  assert.deepEqual(exp[0][2], [USER.user_id]);

  const calls = globalThis.__ad.calls;
  const idx = (pred) => calls.findIndex(pred);
  const iExp = idx((c) => c[0] === 'query' && /UPDATE\s+public\.jobs\b/i.test(c[1]));
  const iBegin = idx((c) => c[0] === 'tx' && c[1] === 'begin');
  const iCommit = idx((c) => c[0] === 'tx' && c[1] === 'commit');
  const iDel = idx((c) => c[0] === 'deleteAuthUser');
  assert.ok(iBegin < iExp && iExp < iCommit, 'job expiry must be inside the erase transaction');
  assert.ok(iExp < iDel, 'job expiry must happen before the auth user (and the FK SET NULL) goes');
});

test('DELETE /api/users/me — Stripe failure rolls back the job expiry too (jobs stay live, 502)', async () => {
  const mod = await loadRoute({ subIds: ['sub_a'], cancelError: { code: 'api_error', statusCode: 500 } });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 502);
  const calls = globalThis.__ad.calls;
  const iExp = calls.findIndex((c) => c[0] === 'query' && /UPDATE\s+public\.jobs\b/i.test(c[1]));
  const iRollback = calls.findIndex((c) => c[0] === 'tx' && c[1] === 'rollback');
  assert.ok(iExp >= 0 && iRollback > iExp, 'the expiry ran inside the tx that rolled back');
  assert.ok(!calls.some((c) => c[0] === 'deleteAuthUser'));
});

// Reviewer probes (merge gate, #241). Two mutants passed the two tests above:
//   - the UPDATE issued with `db.query` instead of the tx client (it then commits on its own
//     connection and a failed Stripe cancel does NOT bring the jobs back), and
//   - `SET expires_at = now() + interval '24 hours'` (the jobs are extended, not expired).
test('DELETE /api/users/me — the job expiry runs on the TRANSACTION client, and is exactly "expire now"', async () => {
  const mod = await loadRoute({ subIds: ['sub_a'], cancelError: { code: 'api_error', statusCode: 500 } });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 502);
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  const inTx = (globalThis.__ad.txq ?? []).map(norm).filter((t) => /UPDATE public\.jobs/.test(t));
  assert.deepEqual(
    inTx,
    ['UPDATE public.jobs SET expires_at = LEAST(expires_at, created_at), is_demo = false WHERE user_id = $1::uuid AND (expires_at > created_at OR is_demo)'],
    'the expiry must be issued on the tx client (so ROLLBACK undoes it) and must set expires_at to created_at, never later',
  );
  assert.equal(jobsExpiry().length, 1, 'and it is the only jobs UPDATE, pool or tx');
});

// ---- QA-72: deletion expires the user's open Stripe Checkout Sessions -------
// A session stays open 24 h; completed after the deletion, it billed a
// subscription for a user who no longer exists. The route now expires every
// open session of the user's customer BEFORE the erase+cancel transaction.

const hmacOf = (id) => createHmac('sha256', process.env.IP_HASH_KEY || 'dev-key').update(id).digest('hex');

test('QA-72: open checkouts are expired first (customer id, deadline from request start), then the deletion runs', async () => {
  const before = Date.now();
  const mod = await loadRoute({ subIds: ['sub_a'], customerId: 'cus_jon', expired: ['cs_1', 'cs_2'] });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 204);
  const seq = names();
  const ex = globalThis.__ad.calls.find((c) => c[0] === 'expireOpenCheckoutSessions');
  assert.ok(ex, 'open checkouts were not expired');
  assert.equal(ex[1], 'cus_jon');
  assert.ok(ex[2] >= before + 24_000 && ex[2] <= Date.now() + 24_000, `deadline ${ex[2] - before} ms from start`);
  const exAt = seq.indexOf('expireOpenCheckoutSessions');
  const txAt = globalThis.__ad.calls.findIndex((c) => c[0] === 'tx' && c[1] === 'begin');
  assert.ok(exAt < txAt, 'expiry must run before the erase+cancel transaction');
  assert.ok(exAt < seq.indexOf('cancelSubscription'), 'expiry must run before the cancels');
  const cb = globalThis.__ad.calls.find((c) => c[0] === 'query' && /FROM public\.customers_billing/.test(c[1]));
  assert.deepEqual(cb[2], [USER.user_id, 'stripe']);
  const audit = JSON.parse(auditInserts()[0][2][0]);
  assert.equal(audit.checkouts_expired, 2);
  assert.equal(audit.user_hash, hmacOf(USER.user_id));
});

test('QA-72: no Stripe customer -> no expiry call, deletion proceeds', async () => {
  const mod = await loadRoute({ subIds: [] });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 204);
  assert.ok(!names().includes('expireOpenCheckoutSessions'));
  assert.equal(JSON.parse(auditInserts()[0][2][0]).checkouts_expired, 0);
});

test('QA-72: expiry refused -> 502 CHECKOUT_EXPIRE_FAILED, NOTHING deleted or cancelled, Sentry alert with user_hash only', async () => {
  const mod = await loadRoute({ subIds: ['sub_a'], customerId: 'cus_jon', expireError: { code: 'rate_limit', type: 'StripeRateLimitError' } });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'CHECKOUT_EXPIRE_FAILED');
  assert.match(res.body.error, /not deleted\. Please try again\.$/);
  const seq = names();
  assert.ok(!seq.includes('tx'), 'the erase transaction must not start');
  assert.ok(!seq.includes('cancelSubscription'));
  assert.ok(!seq.includes('deleteAuthUser'));
  assert.equal(auditInserts().length, 0);
  const [alert] = globalThis.__ad.sentry ?? [];
  assert.ok(alert, 'no Sentry alert for a refused deletion');
  assert.equal(alert.opts.level, 'error');
  assert.equal(alert.opts.extra.step, 'checkout_expire');
  assert.equal(alert.opts.extra.user_hash, hmacOf(USER.user_id), 'review L-5: the operator can find the stuck user');
  const blob = JSON.stringify(alert);
  assert.ok(!blob.includes(USER.user_id), 'raw user id in Sentry');
  assert.ok(!blob.toLowerCase().includes(USER.email.toLowerCase()), 'email in Sentry');
});

test('QA-72 / L-5: a refused subscription cancel is alerted with the user_hash too', async () => {
  const mod = await loadRoute({ subIds: ['sub_a'], cancelError: { code: 'api_connection_error' } });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 502);
  const [alert] = globalThis.__ad.sentry ?? [];
  assert.equal(alert.opts.extra.step, 'subscription_cancel');
  assert.equal(alert.opts.extra.user_hash, hmacOf(USER.user_id));
});

test('L-4: resource_missing that says the subscription exists in the OTHER mode is NOT "already cancelled" (502)', async () => {
  const mod = await loadRoute({
    subIds: ['sub_live'],
    cancelError: {
      code: 'resource_missing',
      message: "No such subscription: 'sub_live'; a similar object exists in live mode, but a test mode key was used to make this request.",
    },
  });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 502, 'a wrong-mode key would let deletion finish while the real subscription bills');
  assert.ok(!names().includes('deleteAuthUser'));
});

test('QA-72: maxDuration is 60 and the expiry budget leaves room for the rest of the request', () => {
  const src = readFileSync(SRC, 'utf8');
  assert.match(src, /export const maxDuration = 60;/);
  assert.match(src, /const CHECKOUT_EXPIRE_BUDGET_MS = 24_000;/);
  assert.match(src, /const t0 = Date\.now\(\);/);
});
