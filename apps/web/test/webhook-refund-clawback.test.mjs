// M4 (credit-ledger review 2026-11-03): charge.refunded must claw back the
// credits granted by the original credit purchase, idempotently.

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

const USER = '11111111-1111-1111-1111-111111111111';

// Fake DB emulating just the statements the refund path issues, including the
// two uniqueness constraints on credit_adjustments.
function makeState() {
  return {
    purchases: [
      { user_id: USER, provider: 'stripe', provider_charge_id: 'pi_ABC', credits_granted: 60, amount_cad_cents: 3000 },
    ],
    adjustments: [],
    usage: [],
  };
}

async function loadRoute(event, state) {
  globalThis.__state = state;
  globalThis.__event = event;
  const billing = dataUrl(`
    export const getBillingProvider = () => ({
      name: 'stripe',
      handleWebhook: async () => globalThis.__event,
    });
  `);
  const db = dataUrl(`
    const query = async (sql, p) => {
      const s = globalThis.__state;
      if (/pg_advisory_xact_lock/.test(sql)) {
        (s.locks ??= []).push(p[0]);
        return { rows: [], rowCount: 1 };
      }
      if (/FROM credit_purchases/.test(sql)) {
        const rows = s.purchases.filter((r) => r.provider === p[0] && p[1].includes(r.provider_charge_id));
        return { rows: rows.slice(0, 1), rowCount: Math.min(rows.length, 1) };
      }
      if (/FROM credit_adjustments/.test(sql)) {
        const sum = s.adjustments
          .filter((a) => a.reason === 'refund' && a.provider === p[0] && a.provider_charge_id === p[1])
          .reduce((n, a) => n - a.credits_delta, 0);
        return { rows: [{ clawed: sum }], rowCount: 1 };
      }
      if (/INSERT INTO credit_adjustments/.test(sql)) {
        const [user_id, credits_delta, provider, event_id, charge_id] = p;
        // 024 dropped the one-refund-per-charge index; only per-event dedup remains.
        const dup = s.adjustments.some(
          (a) => a.provider === provider && a.provider_event_id === event_id);
        if (dup) return { rows: [], rowCount: 0 };
        s.adjustments.push({ user_id, credits_delta, reason: 'refund', provider,
          provider_event_id: event_id, provider_charge_id: charge_id });
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO usage_events/.test(sql)) {
        s.usage.push({ user_id: p[0], kind: 'refund_processed', detail: JSON.parse(p[1]) });
        return { rows: [], rowCount: 1 };
      }
      throw new Error('unexpected SQL: ' + sql);
    };
    export const db = { query, tx: async (fn) => fn({ query }) };
  `);
  const ent = dataUrl(`export const invalidateEntitlement = () => {};`);
  const em = dataUrl(`
    export const sendWelcomeIfFirstTime = async () => {};
    export const sendSubscriptionChanged = async () => {};
    export const sendPlanEnding = async () => {};
    export const sendPlanEnded = async () => {};
    export const sendPaymentFailed = async () => {};
    export const sendReceipt = async () => {};
  `);
  const next = dataUrl(`
    export class NextResponse {
      static json(body, init = {}) { return { status: init.status ?? 200, body }; }
    }
  `);
  const prorata = dataUrl(toJs(readFileSync(join(WEB, 'src/lib/billing/prorata.ts'), 'utf8')));
  const js = toJs(readFileSync(SRC, 'utf8'))
    .replace(/from ['"]@\/lib\/billing\/prorata['"]/g, `from '${prorata}'`)
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${billing}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${ent}'`)
    .replace(/from ['"]@\/lib\/emails\/dispatch['"]/g, `from '${em}'`)
    .replace(/from ['"]next\/server['"]/g, `from '${next}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

const req = () => ({
  headers: { get: (n) => (n.toLowerCase() === 'stripe-signature' ? 'sig' : null) },
  text: async () => '{}',
});

const refund = (over = {}) => ({
  type: 'refund_created',
  providerEventId: 'evt_1',
  providerChargeId: 'ch_ABC',
  providerPaymentIntentId: 'pi_ABC',
  fullyRefunded: true,
  amountRefunded: 3000,
  ...over,
});

test('refund of an existing credit purchase writes a negative adjustment + audit event', async () => {
  const state = makeState();
  const mod = await loadRoute(refund(), state);
  const res = await mod.POST(req());
  assert.equal(res.status, 200);
  assert.equal(state.adjustments.length, 1);
  assert.equal(state.adjustments[0].credits_delta, -60);
  assert.equal(state.adjustments[0].reason, 'refund');
  assert.equal(state.adjustments[0].user_id, USER);
  assert.equal(state.adjustments[0].provider_event_id, 'evt_1');
  assert.equal(state.usage.length, 1);
  assert.equal(state.usage[0].kind, 'refund_processed');
});

test('retry of the same event id writes 0 new rows', async () => {
  const state = makeState();
  const mod = await loadRoute(refund(), state);
  await mod.POST(req());
  const res = await mod.POST(req());
  assert.equal(res.status, 200);
  assert.equal(state.adjustments.length, 1);
  assert.equal(state.usage.length, 1, 'no duplicate audit row on retry');
});

test('a second distinct event on the same charge does not double-claw-back', async () => {
  const state = makeState();
  let mod = await loadRoute(refund(), state);
  await mod.POST(req());
  mod = await loadRoute(refund({ providerEventId: 'evt_2' }), state);
  await mod.POST(req());
  assert.equal(state.adjustments.length, 1);
});

test('refund of an unknown charge logs and returns 200 with no writes', async () => {
  const state = makeState();
  const mod = await loadRoute(
    refund({ providerChargeId: 'ch_NOPE', providerPaymentIntentId: 'pi_NOPE' }),
    state,
  );
  const res = await mod.POST(req());
  assert.equal(res.status, 200);
  assert.equal(state.adjustments.length, 0);
  assert.equal(state.usage.length, 0);
});

test('partial refund with no refunded amount does not claw back', async () => {
  const state = makeState();
  const mod = await loadRoute(refund({ fullyRefunded: false, amountRefunded: 0 }), state);
  const res = await mod.POST(req());
  assert.equal(res.status, 200);
  assert.equal(state.adjustments.length, 0);
});
