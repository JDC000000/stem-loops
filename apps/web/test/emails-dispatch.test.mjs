// Email dispatcher tests — V3 Phase 1b (PR #38 Lens A follow-up).
//
// Stubs @/lib/db, ./resend, and the templates so we can assert:
//   1. Welcome idempotency: calling sendWelcomeIfFirstTime twice for the
//      same user sends ONE email. The second call reads welcomed_at and
//      short-circuits.
//   2. Welcome marks the user welcomed only after a successful send; a
//      failed send leaves welcomed_at NULL so a retry can try again.
//   3. Idempotency-Key shapes: welcome / sub-changed / receipt dispatchers
//      compose the key from the stable business id, not from a uuid.
//
// Uses the same ts-to-data-url pattern as the rest of the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/lib/emails/dispatch.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

// ── Stubs ──────────────────────────────────────────────────────────────

// db stub: starts with welcomed_at=null, flips to a date when markWelcomed
// runs. Records every query so tests can introspect.
function dbStub({ initialWelcomedAt = null, email = 'u@example.com' } = {}) {
  const payload = JSON.stringify({ initialWelcomedAt, email });
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__db = {
      welcomed_at: cfg.initialWelcomedAt,
      email: cfg.email,
      deleted: false,
      quotas: { free: 5, pro: 50, studio: 150 },
      queries: [],
    };
    export const db = {
      query: async (text, params) => {
        globalThis.__db.queries.push({ text, params });
        if (/SELECT email FROM users/i.test(text)) {
          // Emulates the SQL: a tombstoned user matches only a query that
          // does NOT filter on deleted_at (E7).
          if (globalThis.__db.deleted && /deleted_at IS NULL/i.test(text)) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [{ email: globalThis.__db.email }], rowCount: 1 };
        }
        if (/SELECT monthly_job_quota FROM plans WHERE code/i.test(text)) {
          const q = globalThis.__db.quotas[params[0]];
          return q === undefined ? { rows: [], rowCount: 0 } : { rows: [{ monthly_job_quota: q }], rowCount: 1 };
        }
        if (/SELECT welcomed_at FROM users/i.test(text)) {
          return { rows: [{ welcomed_at: globalThis.__db.welcomed_at }], rowCount: 1 };
        }
        if (/UPDATE users SET welcomed_at/i.test(text)) {
          globalThis.__db.welcomed_at = new Date().toISOString();
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
  `);
}

// resend stub: records every sendEmail call. By default returns ok:true.
// Set `ok: false` to simulate a failed send (welcome should NOT then mark).
function resendStub({ ok = true } = {}) {
  const payload = JSON.stringify({ ok });
  return dataUrl(`
    const cfg = ${payload};
    globalThis.__sent = [];
    export const sendEmail = async (input) => {
      globalThis.__sent.push(input);
      return { ok: cfg.ok, id: cfg.ok ? 'em_x' : undefined };
    };
  `);
}

// Template stubs: deterministic subject/html so assertions can match.
function templatesStub() {
  const receipt = dataUrl(`
    export const renderReceipt = (vars) => ({ subject: 'Receipt', html: '<p>r</p>', text: 'r', vars });
  `);
  // The v1.2 template stubs record the vars they were rendered with, so tests can see what the
  // dispatcher computed (quota, grace date, on_free).
  const echo = (fn) => dataUrl(`
    export const ${fn} = (vars) => {
      (globalThis.__rendered ??= []).push({ fn: '${fn}', vars });
      return { subject: '${fn}', html: '<p>${fn}</p>', text: '${fn} text' };
    };
  `);
  return {
    welcome: echo('renderWelcome'),
    sub: echo('renderSubscriptionChanged'),
    receipt,
    ending: echo('renderPlanEnding'),
    ended: echo('renderPlanEnded'),
    failed: echo('renderPaymentFailed'),
  };
}

const entitlementsStub = dataUrl(`export const PAST_DUE_GRACE_MS = 7 * 24 * 3600 * 1000;`);

// Erase the ambient billing-types import at transpile time.
const billingTypesStub = dataUrl(`export {};`);

async function loadDispatch({ db = {}, resend = {} } = {}) {
  globalThis.__sent = [];
  globalThis.__rendered = [];
  const dbCfg = { initialWelcomedAt: null, email: 'u@example.com', ...db };
  const templates = templatesStub();
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub(dbCfg)}'`)
    .replace(/from ['"]@\/lib\/billing\/types['"]/g, `from '${billingTypesStub}'`)
    .replace(/from ['"]\.\/resend['"]/g, `from '${resendStub(resend)}'`)
    .replace(/from ['"]\.\/templates\/welcome['"]/g, `from '${templates.welcome}'`)
    .replace(/from ['"]\.\/templates\/subscription-changed['"]/g, `from '${templates.sub}'`)
    .replace(/from ['"]\.\/templates\/receipt['"]/g, `from '${templates.receipt}'`)
    .replace(/from ['"]\.\/templates\/plan-ending['"]/g, `from '${templates.ending}'`)
    .replace(/from ['"]\.\/templates\/plan-ended['"]/g, `from '${templates.ended}'`)
    .replace(/from ['"]\.\/templates\/payment-failed['"]/g, `from '${templates.failed}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${entitlementsStub}'`);
  const mod = await import(dataUrl(js) + '#' + Math.random());
  // The ./resend and @/lib/db stubs are cached by data-URL across tests
  // (Node module cache), so their top-level `globalThis.__sent = []` and
  // `globalThis.__db = {...}` initializers only run on FIRST import. Force
  // a clean state here on every test — otherwise state from a prior test
  // with the same payload leaks forward.
  globalThis.__sent = [];
  globalThis.__db = {
    welcomed_at: dbCfg.initialWelcomedAt,
    email: dbCfg.email,
    deleted: !!dbCfg.deleted,
    quotas: { free: 5, pro: 50, studio: 150 },
    queries: [],
  };
  return mod;
}

const USER = '11111111-1111-1111-1111-111111111111';

// ── Tests ───────────────────────────────────────────────────────────────

// Fix #1 core guarantee: second call MUST NOT re-send.
test('sendWelcomeIfFirstTime: sends once per user (PR #38 Lens A / migration 019)', async () => {
  const mod = await loadDispatch({ db: { initialWelcomedAt: null } });
  await mod.sendWelcomeIfFirstTime(USER);
  await mod.sendWelcomeIfFirstTime(USER);
  assert.equal(globalThis.__sent.length, 1, 'welcome must send exactly once per user');
  assert.equal(globalThis.__sent[0].tag, 'welcome');
  assert.equal(
    globalThis.__sent[0].idempotencyKey,
    `welcome:${USER}`,
    'welcome key is welcome:<user_id>',
  );
});

test('sendWelcomeIfFirstTime: does NOT send when welcomed_at is already set', async () => {
  const mod = await loadDispatch({
    db: { initialWelcomedAt: '2026-01-01T00:00:00Z' },
  });
  await mod.sendWelcomeIfFirstTime(USER);
  assert.equal(globalThis.__sent.length, 0, 'already-welcomed user must get no email');
});

test('sendWelcomeIfFirstTime: skips when email is the @noemail.local placeholder', async () => {
  const mod = await loadDispatch({
    db: { initialWelcomedAt: null, email: `${USER}@noemail.local` },
  });
  await mod.sendWelcomeIfFirstTime(USER);
  assert.equal(globalThis.__sent.length, 0, 'placeholder email must not be sent to');
});

test('sendWelcomeIfFirstTime: does NOT mark welcomed_at on a failed Resend send', async () => {
  const mod = await loadDispatch({
    db: { initialWelcomedAt: null },
    resend: { ok: false },
  });
  await mod.sendWelcomeIfFirstTime(USER);
  assert.equal(globalThis.__sent.length, 1, 'first attempt must still try');
  // Second call should ALSO try, because the first one failed → welcomed_at stays NULL.
  await mod.sendWelcomeIfFirstTime(USER);
  assert.equal(globalThis.__sent.length, 2, 'failed send leaves user eligible for retry');
});

// emails v1.2 §2.7 changes this pin: the plan is now in the key, so a
// Pro -> Studio switch under the same subscription id is not deduped by
// Resend as a repeat of the earlier "active" send.
test('sendSubscriptionChanged: idempotency key is sub-changed:<sub_id>:<status>:<plan>', async () => {
  const mod = await loadDispatch();
  await mod.sendSubscriptionChanged(USER, {
    plan_code: 'pro',
    status: 'active',
    period_end: '2027-01-01T00:00:00Z',
    provider_subscription_id: 'sub_abc123',
  });
  assert.equal(globalThis.__sent.length, 1);
  assert.equal(globalThis.__sent[0].tag, 'subscription-changed');
  assert.equal(
    globalThis.__sent[0].idempotencyKey,
    'sub-changed:sub_abc123:active:pro',
    'sub-changed key folds status and plan in so a plan change under the same sub id gets its own send',
  );
});

test('sendReceipt (subscription): idempotency key is receipt-sub:<invoice_id>', async () => {
  const mod = await loadDispatch();
  await mod.sendReceipt(USER, {
    amount_cad_cents: 1299,
    plan_or_pack_label: 'pro plan renewal',
    invoice_url: 'https://invoice.stripe.com/x',
    receipt_source: { kind: 'subscription', invoice_id: 'in_xyz' },
  });
  assert.equal(globalThis.__sent.length, 1);
  assert.equal(
    globalThis.__sent[0].idempotencyKey,
    'receipt-sub:in_xyz',
  );
});

test('sendReceipt (credit): idempotency key is receipt-credit:<charge_id>', async () => {
  const mod = await loadDispatch();
  await mod.sendReceipt(USER, {
    amount_cad_cents: 500,
    plan_or_pack_label: '20 credits',
    invoice_url: null,
    receipt_source: { kind: 'credit', provider_charge_id: 'ch_777' },
  });
  assert.equal(globalThis.__sent.length, 1);
  assert.equal(globalThis.__sent[0].idempotencyKey, 'receipt-credit:ch_777');
});

// ── emails v1.2 (EM-1, EM-2) ────────────────────────────────────────────

// E7: a user whose deleted_at is stamped gets no email, whatever the sender.
test('emailForUser: a deleted user (deleted_at set) receives nothing (E7)', async () => {
  const mod = await loadDispatch({ db: { deleted: true } });
  assert.equal(await mod.sendWelcomeIfFirstTime(USER, { plan_code: 'pro' }), false);
  await mod.sendSubscriptionChanged(USER, {
    plan_code: 'pro', status: 'active', period_end: null, provider_subscription_id: 'sub_1',
  });
  await mod.sendPlanEnded(USER, {
    plan_code: 'pro', period_end: null, provider_subscription_id: 'sub_1', on_free: true,
  });
  await mod.sendReceipt(USER, {
    amount_cad_cents: 1, plan_or_pack_label: 'x', invoice_url: null,
    receipt_source: { kind: 'credit', provider_charge_id: 'ch_1' },
  });
  assert.equal(globalThis.__sent.length, 0);
  const q = globalThis.__db.queries.find((x) => /SELECT email FROM users/.test(x.text));
  assert.match(q.text, /AND deleted_at IS NULL/);
});

test('every dispatcher passes the plain-text part through to sendEmail (E9)', async () => {
  const mod = await loadDispatch();
  await mod.sendWelcomeIfFirstTime(USER, { plan_code: 'pro', period_end: '2027-01-15T00:00:00Z' });
  await mod.sendSubscriptionChanged(USER, { plan_code: 'pro', status: 'paused', period_end: null, provider_subscription_id: 's' });
  await mod.sendPlanEnding(USER, { plan_code: 'pro', period_end: '2027-01-15T00:00:00Z', provider_subscription_id: 's' });
  await mod.sendPlanEnded(USER, { plan_code: 'pro', period_end: null, provider_subscription_id: 's', on_free: true });
  await mod.sendPaymentFailed(USER, { plan_code: 'pro', period_start: '2026-11-13T00:00:00Z', next_attempt: null, provider_invoice_id: 'in_1', attempt_count: 1 });
  await mod.sendReceipt(USER, { amount_cad_cents: 1, plan_or_pack_label: 'x', invoice_url: null, receipt_source: { kind: 'credit', provider_charge_id: 'c' } });
  assert.equal(globalThis.__sent.length, 6);
  for (const m of globalThis.__sent) assert.ok(typeof m.text === 'string' && m.text.length > 0, `${m.tag} has text`);
});

test('sendWelcomeIfFirstTime: returns true only when it sent; passes plan, renewal and quota (R2)', async () => {
  const mod = await loadDispatch();
  assert.equal(await mod.sendWelcomeIfFirstTime(USER, { plan_code: 'studio', period_end: '2027-01-15T00:00:00Z' }), true);
  assert.equal(await mod.sendWelcomeIfFirstTime(USER, { plan_code: 'studio' }), false, 'already welcomed');
  assert.equal(globalThis.__sent[0].html, '<p>renderWelcome</p>');
  assert.deepEqual(globalThis.__rendered[0].vars, {
    plan_code: 'studio', period_end: '2027-01-15T00:00:00Z', monthly_job_quota: 150,
  });
  const quotaQ = globalThis.__db.queries.find((x) => /FROM plans/.test(x.text));
  assert.deepEqual(quotaQ.params, ['studio']);
});

test('sendWelcomeIfFirstTime: a failed send returns false', async () => {
  const mod = await loadDispatch({ resend: { ok: false } });
  assert.equal(await mod.sendWelcomeIfFirstTime(USER, { plan_code: 'pro' }), false);
});

test('sendPlanEnding (R5): key plan-ending:<sub_id>:<period_end ISO>, tag plan-ending', async () => {
  const mod = await loadDispatch();
  await mod.sendPlanEnding(USER, { plan_code: 'pro', period_end: '2027-01-15T00:00:00Z', provider_subscription_id: 'sub_abc' });
  assert.equal(globalThis.__sent[0].tag, 'plan-ending');
  assert.equal(globalThis.__sent[0].idempotencyKey, 'plan-ending:sub_abc:2027-01-15T00:00:00.000Z');
});

test('sendPlanEnded (R6): keeps the sub-changed:<sub_id>:canceled key shape', async () => {
  const mod = await loadDispatch();
  await mod.sendPlanEnded(USER, { plan_code: 'studio', period_end: null, provider_subscription_id: 'sub_abc', on_free: true });
  assert.equal(globalThis.__sent[0].tag, 'subscription-changed');
  assert.equal(globalThis.__sent[0].idempotencyKey, 'sub-changed:sub_abc:canceled');
});

test('sendPaymentFailed (R7): key payment-failed:<invoice>:<attempt>; skipped without a period start', async () => {
  const mod = await loadDispatch();
  await mod.sendPaymentFailed(USER, { plan_code: 'pro', period_start: '2026-11-13T00:00:00Z', next_attempt: null, provider_invoice_id: 'in_9', attempt_count: 2 });
  await mod.sendPaymentFailed(USER, { plan_code: 'pro', period_start: '2026-11-13T00:00:00Z', next_attempt: null, provider_invoice_id: 'in_9', attempt_count: 3 });
  assert.deepEqual(globalThis.__sent.map((m) => m.idempotencyKey), ['payment-failed:in_9:2', 'payment-failed:in_9:3']);
  assert.equal(globalThis.__sent[0].tag, 'payment-failed');
  const orig = console.warn; console.warn = () => {};
  try {
    await mod.sendPaymentFailed(USER, { plan_code: 'pro', period_start: 'garbage', next_attempt: null, provider_invoice_id: 'in_x', attempt_count: 1 });
  } finally { console.warn = orig; }
  assert.equal(globalThis.__sent.length, 2, 'no send without a usable period start');
});

test('sendPaymentFailed: grace_end is period start + PAST_DUE_GRACE_MS (7 days)', async () => {
  const mod = await loadDispatch();
  await mod.sendPaymentFailed(USER, { plan_code: 'pro', period_start: '2026-11-13T00:00:00Z', next_attempt: '2026-11-16T00:00:00Z', provider_invoice_id: 'in_1', attempt_count: 1, now: new Date('2026-11-14T00:00:00Z') });
  const v = globalThis.__rendered.find((r) => r.fn === 'renderPaymentFailed').vars;
  assert.equal(new Date(v.grace_end).toISOString(), '2026-11-20T00:00:00.000Z');
  assert.equal(new Date(v.now).toISOString(), '2026-11-14T00:00:00.000Z');
});

test('sendPlanEnded: reads the Free quota only when the account is on Free', async () => {
  const mod = await loadDispatch();
  await mod.sendPlanEnded(USER, { plan_code: 'pro', period_end: null, provider_subscription_id: 's1', on_free: true });
  await mod.sendPlanEnded(USER, { plan_code: 'pro', period_end: null, provider_subscription_id: 's2', on_free: false });
  const [a, b] = globalThis.__rendered.filter((r) => r.fn === 'renderPlanEnded').map((r) => r.vars);
  assert.equal(a.free_quota, 5);
  assert.equal(a.on_free, true);
  assert.equal(b.free_quota, null);
  assert.equal(b.on_free, false);
});

test('sendSubscriptionChanged: passes switch, resume and quota to the template', async () => {
  const mod = await loadDispatch();
  await mod.sendSubscriptionChanged(USER, { plan_code: 'studio', status: 'active', period_end: null, provider_subscription_id: 's', previous_plan_code: 'pro' });
  const v = globalThis.__rendered[0].vars;
  assert.equal(v.previous_plan_code, 'pro');
  assert.equal(v.resumed, false);
  assert.equal(v.monthly_job_quota, 150);
});
