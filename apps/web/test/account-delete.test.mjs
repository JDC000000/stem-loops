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

function billingStub({ cancelError = null } = {}) {
  return dataUrl(`
    export const getBillingProvider = () => ({
      name: 'stripe',
      cancelSubscription: async (id, atPeriodEnd) => {
        globalThis.__ad.calls.push(['cancelSubscription', id, atPeriodEnd]);
        if (${JSON.stringify(cancelError)}) throw Object.assign(new Error('stripe'), ${JSON.stringify(cancelError)});
      },
    });
  `);
}

function dbStub(subIds) {
  return dataUrl(`
    export const db = {
      query: async (text, params) => {
        globalThis.__ad.calls.push(['query', text, params]);
        if (/FROM public\\.subscriptions/.test(text)) {
          return { rows: ${JSON.stringify(subIds)}.map((id) => ({ provider_subscription_id: id })), rowCount: ${subIds.length} };
        }
        return { rows: [], rowCount: 1 };
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

async function loadRoute({ user = USER, subIds = [], cancelError = null, deleteFails = false } = {}) {
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${authStub(user, { deleteFails })}'`)
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billingStub({ cancelError })}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub(subIds)}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`);
  return await import(dataUrl(js) + '#' + Math.random());
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

  // Order: cancel before deleteAuthUser before audit insert.
  const order = calls.map((c) => c[0] + (c[0] === 'query' ? (/INSERT/.test(c[1]) ? ':audit' : /UPDATE/.test(c[1]) ? ':tombstone' : ':select') : ''));
  assert.ok(order.indexOf('cancelSubscription') < order.indexOf('query:tombstone'));
  assert.ok(order.indexOf('query:tombstone') < order.indexOf('deleteAuthUser'));
  assert.ok(order.indexOf('deleteAuthUser') < order.indexOf('query:audit'));

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

test('DELETE /api/users/me — Stripe failure aborts BEFORE any deletion (502)', async () => {
  const mod = await loadRoute({ subIds: ['sub_a'], cancelError: { code: 'api_connection_error' } });
  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'SUBSCRIPTION_CANCEL_FAILED');
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

test('DELETE /api/users/me — tolerates users.deleted_at column absent (42703)', async () => {
  // Re-stub db so UPDATE public.users throws Postgres column-does-not-exist;
  // route should catch and continue, still deleting auth user + writing audit.
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(
      /from ['"]@\/lib\/auth\/supabase['"]/g,
      `from '${authStub(USER, { deleteFails: false })}'`,
    )
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billingStub({ cancelError: null })}'`)
    .replace(
      /from ['"]@\/lib\/db['"]/g,
      `from '${dataUrl(`
        export const db = {
          query: async (text, params) => {
            globalThis.__ad.calls.push(['query', text, params]);
            if (/FROM public\\.subscriptions/.test(text)) {
              return { rows: [], rowCount: 0 };
            }
            if (/UPDATE public\\.users/.test(text)) {
              const err = new Error('column "deleted_at" does not exist');
              err.code = '42703';
              throw err;
            }
            return { rows: [], rowCount: 1 };
          },
        };
      `)}'`,
    )
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub()}'`);
  const mod = await import(dataUrl(js) + '#' + Math.random());

  const res = await mod.DELETE(makeReq({ confirm_email: USER.email }));
  assert.equal(res.status, 204, 'tolerance path: tombstone attempt swallows 42703 and continues');
  assert.ok(names().includes('deleteAuthUser'));
  assert.equal(auditInserts().length, 1);
});
