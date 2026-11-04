// M4 follow-up: pro-rata clawback for PARTIAL refunds (Option A):
// total clawed = floor(refunded / amount_total * credits_granted), delta per event.

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

const PRORATA = join(WEB, 'src/lib/billing/prorata.ts');
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
    export const sendReceipt = async () => {};
  `);
  const next = dataUrl(`
    export class NextResponse {
      static json(body, init = {}) { return { status: init.status ?? 200, body }; }
    }
  `);
  const prorata = dataUrl(toJs(readFileSync(PRORATA, 'utf8')));
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

const { computeProRataClawback: calc } = await import(
  dataUrl(toJs(readFileSync(PRORATA, 'utf8')))
);
const partial = (n, amountRefunded, over = {}) =>
  refund({ providerEventId: `evt_${n}`, fullyRefunded: false, amountRefunded, ...over });
const total = (state) => state.adjustments.reduce((n, a) => n - a.credits_delta, 0);
async function send(state, evt) {
  const mod = await loadRoute(evt, state);
  const res = await mod.POST(req());
  assert.equal(res.status, 200);
}
const base = { amountTotal: 3000, creditsGranted: 60, alreadyClawed: 0, isFullRefund: false };

// ---- computeProRataClawback (pure) ----
test('calc: 50% of 60 credits -> 30', () => {
  assert.equal(calc({ ...base, amountRefunded: 1500 }), 30);
});
test('calc: floors fractional credits', () => {
  assert.equal(calc({ ...base, amountRefunded: 1000, amountTotal: 2999, creditsGranted: 20 }), 6);
  assert.equal(calc({ ...base, amountRefunded: 1 }), 0);
});
test('calc: subtracts already clawed; never negative', () => {
  assert.equal(calc({ ...base, amountRefunded: 2000, alreadyClawed: 20 }), 20);
  assert.equal(calc({ ...base, amountRefunded: 1000, alreadyClawed: 40 }), 0);
});
test('calc: full refund claws exactly the remainder', () => {
  assert.equal(calc({ ...base, amountRefunded: 3000, alreadyClawed: 37, isFullRefund: true }), 23);
  assert.equal(calc({ ...base, amountRefunded: 3000, alreadyClawed: 60, isFullRefund: true }), 0);
  assert.equal(calc({ ...base, amountRefunded: 0, isFullRefund: true }), 60);
});
test('calc: zero / negative / NaN inputs are no-ops', () => {
  assert.equal(calc({ ...base, amountRefunded: 0 }), 0);
  assert.equal(calc({ ...base, amountRefunded: -5 }), 0);
  assert.equal(calc({ ...base, amountRefunded: NaN }), 0);
  assert.equal(calc({ ...base, amountRefunded: 100, amountTotal: 0 }), 0);
  assert.equal(calc({ ...base, amountRefunded: 100, creditsGranted: 0 }), 0);
});
test('calc: over-refund capped at credits_granted', () => {
  assert.equal(calc({ ...base, amountRefunded: 9000 }), 60);
  assert.equal(calc({ ...base, amountRefunded: 9000, alreadyClawed: 55 }), 5);
});
test('calc: integer math has no float drift at boundaries', () => {
  assert.equal(calc({ ...base, amountRefunded: 30, amountTotal: 100, creditsGranted: 20 }), 6);
  assert.equal(calc({ ...base, amountRefunded: 7, amountTotal: 10, creditsGranted: 20 }), 14);
});
test('calc: sequence invariant — cumulative <= floor target, ends exactly at granted', () => {
  for (const [granted, totalAmt] of [[20, 1999], [60, 2999], [180, 7777]]) {
    let clawed = 0;
    const steps = 17;
    for (let i = 1; i <= steps; i++) {
      const refunded = Math.round((totalAmt * i) / steps);
      const full = i === steps;
      const d = calc({ amountRefunded: refunded, amountTotal: totalAmt, creditsGranted: granted, alreadyClawed: clawed, isFullRefund: full });
      assert.ok(d >= 0);
      clawed += d;
      if (!full) assert.ok(clawed <= Math.floor((refunded * granted) / totalAmt));
    }
    assert.equal(clawed, granted);
  }
});

// ---- webhook integration ----
test('single partial: 50% refunded -> 30 credits', async () => {
  const state = makeState();
  await send(state, partial(1, 1500));
  assert.equal(state.adjustments.length, 1);
  assert.equal(state.adjustments[0].credits_delta, -30);
  assert.equal(state.usage.length, 1);
  assert.equal(state.usage[0].detail.partial, true);
});

test('two sequential partials ($10 + $10 of $30) -> 20 + 20 = 40', async () => {
  const state = makeState();
  await send(state, partial(1, 1000));
  await send(state, partial(2, 2000));
  assert.deepEqual(state.adjustments.map((a) => a.credits_delta), [-20, -20]);
  assert.equal(total(state), 40);
});

test('partial then full: $15 (30) then rest of $30 -> total 60', async () => {
  const state = makeState();
  await send(state, partial(1, 1500));
  await send(state, refund({ providerEventId: 'evt_2', fullyRefunded: true, amountRefunded: 3000 }));
  assert.deepEqual(state.adjustments.map((a) => a.credits_delta), [-30, -30]);
  assert.equal(total(state), 60);
});

test('idempotency: same partial event twice -> clawed once', async () => {
  const state = makeState();
  await send(state, partial(1, 1500));
  await send(state, partial(1, 1500));
  assert.equal(state.adjustments.length, 1);
  assert.equal(state.usage.length, 1);
});

test('idempotency: distinct event with same cumulative amount -> no-op', async () => {
  const state = makeState();
  await send(state, partial(1, 1500));
  await send(state, partial(2, 1500));
  assert.equal(total(state), 30);
  assert.equal(state.adjustments.length, 1);
});

test('out-of-order: stale smaller partial after a larger one -> no-op', async () => {
  const state = makeState();
  await send(state, partial(2, 2000));
  await send(state, partial(1, 1000));
  assert.equal(total(state), 40);
  assert.equal(state.adjustments.length, 1);
});

test('floor residual: uneven partials, final full event closes gap exactly', async () => {
  const state = makeState();
  state.purchases[0].amount_cad_cents = 2999;
  // 1000/2999*60=20.01->20 ; 2000->40.01->40 ; 2900->58.02->58 ; full closes the last 2
  await send(state, partial(1, 1000));
  await send(state, partial(2, 2000));
  await send(state, partial(3, 2900));
  assert.equal(total(state), 58);
  await send(state, refund({ providerEventId: 'evt_4', fullyRefunded: true, amountRefunded: 2999 }));
  assert.equal(total(state), 60);
  assert.equal(state.adjustments.at(-1).credits_delta, -2);
});

test('zero-amount refund -> no clawback, no audit row', async () => {
  const state = makeState();
  await send(state, partial(1, 0));
  assert.equal(state.adjustments.length, 0);
  assert.equal(state.usage.length, 0);
});

test('over-refund: events totalling > original cap at credits_granted', async () => {
  const state = makeState();
  await send(state, partial(1, 2000));
  await send(state, partial(2, 9000));
  assert.equal(total(state), 60);
  await send(state, partial(3, 12000));
  await send(state, refund({ providerEventId: 'evt_4', fullyRefunded: true, amountRefunded: 12000 }));
  assert.equal(total(state), 60);
});

test('free (amount 0) purchase: partial no-ops, full still claws', async () => {
  const state = makeState();
  state.purchases[0].amount_cad_cents = 0;
  await send(state, partial(1, 500));
  assert.equal(total(state), 0);
  await send(state, refund({ providerEventId: 'evt_2', fullyRefunded: true, amountRefunded: 500 }));
  assert.equal(total(state), 60);
});

test('partial refund of an unknown charge -> no writes', async () => {
  const state = makeState();
  await send(state, partial(1, 1500, { providerChargeId: 'ch_NOPE', providerPaymentIntentId: 'pi_NOPE' }));
  assert.equal(state.adjustments.length, 0);
});
