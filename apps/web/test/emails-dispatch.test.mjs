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
      queries: [],
    };
    export const db = {
      query: async (text, params) => {
        globalThis.__db.queries.push({ text, params });
        if (/SELECT email FROM users/i.test(text)) {
          return { rows: [{ email: globalThis.__db.email }], rowCount: 1 };
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
  const welcome = dataUrl(`
    export const renderWelcome = () => ({ subject: 'Welcome', html: '<p>hi</p>' });
  `);
  const sub = dataUrl(`
    export const renderSubscriptionChanged = (vars) => ({
      subject: 'Sub ' + vars.status, html: '<p>sub</p>',
    });
  `);
  const receipt = dataUrl(`
    export const renderReceipt = (vars) => ({ subject: 'Receipt', html: '<p>r</p>' });
  `);
  return { welcome, sub, receipt };
}

// Erase the ambient billing-types import at transpile time.
const billingTypesStub = dataUrl(`export {};`);

async function loadDispatch({ db = {}, resend = {} } = {}) {
  globalThis.__sent = [];
  const dbCfg = { initialWelcomedAt: null, email: 'u@example.com', ...db };
  const templates = templatesStub();
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${dbStub(dbCfg)}'`)
    .replace(/from ['"]@\/lib\/billing\/types['"]/g, `from '${billingTypesStub}'`)
    .replace(/from ['"]\.\/resend['"]/g, `from '${resendStub(resend)}'`)
    .replace(/from ['"]\.\/templates\/welcome['"]/g, `from '${templates.welcome}'`)
    .replace(/from ['"]\.\/templates\/subscription-changed['"]/g, `from '${templates.sub}'`)
    .replace(/from ['"]\.\/templates\/receipt['"]/g, `from '${templates.receipt}'`);
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

test('sendSubscriptionChanged: idempotency key is sub-changed:<sub_id>:<status>', async () => {
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
    'sub-changed:sub_abc123:active',
    'sub-changed key folds status in so a plan change under the same sub id gets its own send',
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
