// Q-C (Phase B, B2; AC 10): DELETE /api/users/me refuses, with 409
// DEMO_ACCOUNT_DELETE_REFUSED, an account that OWNS any is_demo job — before any subscription
// read and before any Stripe call — so the demo songs (and the code-defined Demo set built on
// them) can never be taken down by deleting their owner from the app. An account with no demo
// jobs deletes exactly as before.
//
// Same harness shape as account-delete.test.mjs (route transpiled in memory; auth, billing
// provider, db, Sentry and next/server stubbed; every call recorded on globalThis.__dg), which
// this file does not edit. The DB stub answers the guard's query from a per-user table of job
// rows, honouring only the predicates the SQL actually carries: a guard that dropped its
// is_demo or user_id filter, or checked a fixed account id instead, goes red here.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { SAME_ORIGIN_URL, SAME_ORIGIN_IMPORT_RE } from './helpers/same-origin.mjs';
import { wirePureLibs } from './helpers/pure-libs.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/app/api/users/me/route.ts');
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const REFUSAL = "This account holds the demo songs and can't be deleted here.";

const stubs = {
  auth: dataUrl(`
    export const getUser = async () => globalThis.__dg.user;
    export const deleteAuthUser = async (id) => { globalThis.__dg.calls.push(['deleteAuthUser', id]); };`),
  // The provider stub: every Stripe-touching method records itself. AC 10: zero of them.
  billing: dataUrl(`
    export const getBillingProvider = () => ({
      name: 'stripe',
      cancelSubscription: async () => { globalThis.__dg.calls.push(['stripe:cancelSubscription']); },
      cancelAllForAccountDeletion: async (ids, cus) => { globalThis.__dg.calls.push(['stripe:cancelAll', ids, cus]); return { cancelled: ids, alreadyOver: [], voidedInvoices: [] }; },
      expireOpenCheckoutSessions: async (cus) => { globalThis.__dg.calls.push(['stripe:expireOpenCheckoutSessions', cus]); return { expired: ['cs_open_1'] }; },
    });`),
  sentry: dataUrl(`export const captureMessage = () => {}; export const captureException = () => {};`),
  db: dataUrl(`
    const run = async (text, params) => {
      const D = globalThis.__dg;
      D.calls.push(['query', text, params]);
      if (D.failOn && new RegExp(D.failOn).test(text)) throw Object.assign(new Error('db down'), { code: '57P01' });
      if (/FROM public\\.jobs/.test(text) && /^\\s*SELECT/.test(text)) {
        // Honour only the predicates the statement carries.
        const byUser = /user_id\\s*=\\s*\\$1/.test(text);
        const demoOnly = /is_demo(\\s*=\\s*true)?\\b/.test(text) && !/is_demo\\s*=\\s*false/.test(text);
        const rows = D.jobs.filter((j) => (!byUser || j.user_id === params[0]) && (!demoOnly || j.is_demo)).map(() => ({ '?column?': 1 }));
        return { rows: rows.slice(0, /LIMIT 1/.test(text) ? 1 : undefined), rowCount: rows.length };
      }
      if (/FROM public\\.customers_billing/.test(text)) return { rows: [{ provider_customer_id: 'cus_live' }], rowCount: 1 };
      if (/FROM public\\.subscriptions/.test(text)) return { rows: [{ provider_subscription_id: 'sub_live' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    export const db = {
      query: run,
      tx: async (fn) => { globalThis.__dg.calls.push(['tx', 'begin']); const r = await fn({ query: run }); globalThis.__dg.calls.push(['tx', 'commit']); return r; },
    };`),
  next: dataUrl(`
    export class NextResponse { constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; }
      static json(body, init = {}) { return { status: init.status ?? 200, body }; } }
    export class NextRequest {}`),
};

async function loadRoute() {
  const js = toJs(readFileSync(SRC, 'utf8'))
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${stubs.auth}'`)
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${stubs.billing}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${stubs.db}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${stubs.sentry}'`)
    .replace(SAME_ORIGIN_IMPORT_RE, `from '${SAME_ORIGIN_URL}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${stubs.next}'`);
  return import(dataUrl(wirePureLibs(js)) + '#' + Math.random());
}

const req = (email) => ({
  json: async () => ({ confirm_email: email }),
  headers: { get: (k) => ({ origin: 'https://stem-loops.com', host: 'stem-loops.com' })[k.toLowerCase()] ?? null },
});
const stripeCalls = () => globalThis.__dg.calls.filter((c) => String(c[0]).startsWith('stripe:'));
const queries = () => globalThis.__dg.calls.filter((c) => c[0] === 'query').map((c) => c[1]);

/** A user (any id: the guard is by ownership, not by a known account id) with these jobs. */
function account({ demo = 0, ordinary = 0 } = {}) {
  const user = { user_id: randomUUID(), email: `u${Math.random().toString(36).slice(2, 8)}@example.test` };
  const jobs = [
    ...Array.from({ length: demo }, () => ({ user_id: user.user_id, is_demo: true })),
    ...Array.from({ length: ordinary }, () => ({ user_id: user.user_id, is_demo: false })),
  ];
  return { user, jobs };
}

beforeEach(() => {
  globalThis.__dg = { calls: [], jobs: [], user: null, failOn: null };
});

function seed(...accounts) {
  globalThis.__dg.jobs = accounts.flatMap((a) => a.jobs);
}

test('AC 10: an account owning >= 1 is_demo job -> 409 DEMO_ACCOUNT_DELETE_REFUSED, ZERO Stripe calls, no tombstone, is_demo untouched', async () => {
  // Fixture per the brief: this account has a customers_billing row, a live subscription and
  // an open checkout (the stub would report all three if anything asked).
  const demoAcct = account({ demo: 3, ordinary: 2 });
  const other = account({ ordinary: 1 });
  seed(demoAcct, other);
  globalThis.__dg.user = demoAcct.user;
  const res = await (await loadRoute()).DELETE(req(demoAcct.user.email));
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: REFUSAL, code: 'DEMO_ACCOUNT_DELETE_REFUSED' });
  assert.deepEqual(stripeCalls(), [], 'a refused deletion must not reach Stripe');
  const q = queries();
  assert.equal(q.length, 1, `only the guard ran: ${q.join(' | ')}`);
  assert.match(q[0], /FROM public\.jobs/);
  assert.ok(!q.some((t) => /FROM public\.(subscriptions|customers_billing)/.test(t)), 'no subscription read (step 2) before the refusal');
  assert.ok(!q.some((t) => /UPDATE public\.users SET deleted_at/.test(t)), 'no tombstone');
  assert.ok(!q.some((t) => /UPDATE public\.jobs/.test(t)), 'is_demo / expires_at untouched');
  assert.ok(!globalThis.__dg.calls.some((c) => c[0] === 'deleteAuthUser' || c[0] === 'tx'));
  assert.deepEqual(globalThis.__dg.calls.find((c) => c[0] === 'query')[2], [demoAcct.user.user_id]);
});

test('AC 10: one demo job is enough, whatever the account id', async () => {
  for (let i = 0; i < 3; i += 1) {
    globalThis.__dg = { calls: [], jobs: [], user: null, failOn: null };
    const a = account({ demo: 1 });
    seed(a);
    globalThis.__dg.user = a.user;
    const res = await (await loadRoute()).DELETE(req(a.user.email));
    assert.equal(res.status, 409);
    assert.deepEqual(stripeCalls(), []);
  }
});

test('AC 10: an account with no demo jobs (ordinary jobs only) deletes exactly as before: 204 through Stripe', async () => {
  const demoAcct = account({ demo: 3 });
  const plain = account({ ordinary: 4 });
  seed(demoAcct, plain);
  globalThis.__dg.user = plain.user;
  const res = await (await loadRoute()).DELETE(req(plain.user.email));
  assert.equal(res.status, 204);
  const names = globalThis.__dg.calls.map((c) => c[0]);
  assert.deepEqual(stripeCalls().map((c) => c[0]), ['stripe:expireOpenCheckoutSessions', 'stripe:cancelAll']);
  assert.ok(names.includes('deleteAuthUser'));
  assert.ok(queries().some((t) => /UPDATE public\.users SET deleted_at/.test(t)), 'tombstoned');
});

test('the guard runs after step 1 (auth + confirm) and before step 2 (subscription reads)', async () => {
  const a = account({ demo: 1 });
  seed(a);
  globalThis.__dg.user = a.user;
  const mod = await loadRoute();
  const wrong = await mod.DELETE(req('someone@else.test'));
  assert.equal(wrong.status, 400, 'a wrong confirm email is still 400 first');
  assert.deepEqual(globalThis.__dg.calls, []);
  globalThis.__dg.user = null;
  assert.equal((await mod.DELETE(req(a.user.email))).status, 401);
  const src = readFileSync(SRC, 'utf8');
  const guard = src.indexOf("err(409, 'DEMO_ACCOUNT_DELETE_REFUSED'");
  const tryAt = src.indexOf('  try {\n', src.indexOf('const userHash'));
  assert.ok(tryAt > 0 && guard > tryAt, 'the guard is inside the try (a DB error is the normal 500)');
  assert.ok(guard < src.indexOf('FROM public.subscriptions'), 'before step 2');
  assert.ok(guard < src.indexOf('expireOpenCheckoutSessions(customerId'), 'before step 2b');
});

test('a DB error in the guard is the normal 500 DELETE_FAILED, with nothing sent to Stripe', async () => {
  const a = account({ ordinary: 1 });
  seed(a);
  globalThis.__dg.user = a.user;
  globalThis.__dg.failOn = 'FROM public\\.jobs';
  const res = await (await loadRoute()).DELETE(req(a.user.email));
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'DELETE_FAILED');
  assert.deepEqual(stripeCalls(), []);
});
