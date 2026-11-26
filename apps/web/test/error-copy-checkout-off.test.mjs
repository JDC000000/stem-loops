// #453 item 3: while checkout is hidden (B-8w "P", #455), TRIAL_EXHAUSTED and
// CREDIT_BALANCE_INSUFFICIENT must not tell anyone to buy. lib/error-copy.ts swaps in
// CHECKOUT_OFF_COPY on the same switch as lib/billing/checkout-switch.ts; ERROR_COPY keeps the
// checkout-ON sentences, so they return by themselves when checkout reopens.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const load = (p) => import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(read(p), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64'));

const copy = await load('src/lib/error-copy.ts');
const sw = await load('src/lib/billing/checkout-switch.ts');

const SAVED = process.env.BILLING_CHECKOUT_ENABLED;
afterEach(() => {
  if (SAVED === undefined) delete process.env.BILLING_CHECKOUT_ENABLED;
  else process.env.BILLING_CHECKOUT_ENABLED = SAVED;
});
const setSwitch = (v) => {
  if (v === undefined) delete process.env.BILLING_CHECKOUT_ENABLED;
  else process.env.BILLING_CHECKOUT_ENABLED = v;
};

const CODES = ['TRIAL_EXHAUSTED', 'CREDIT_BALANCE_INSUFFICIENT'];
// What a user must not be told while nothing can be bought.
const BUY_RE = /\b(buy|purchase|pick a plan|upgrade|subscribe|get pro|get studio)\b/i;
const line = (c) => `${c.headline} ${c.action}`;

test('the switch read here is the checkout-switch rule, input for input', () => {
  // error-copy.ts cannot import checkout-switch.ts (tests load it standalone), so it inlines the
  // rule. Pin the variable name and the parse to the real module.
  assert.equal(sw.CHECKOUT_ENV, 'BILLING_CHECKOUT_ENABLED');
  assert.match(read('src/lib/error-copy.ts'), /process\.env\?\.BILLING_CHECKOUT_ENABLED === 'true'/);
  for (const v of [undefined, '', 'true', 'TRUE', 'True', '1', 'yes', ' true', 'true ', 'false']) {
    setSwitch(v);
    assert.equal(copy.checkoutEnabledNow(), sw.isCheckoutEnabled(), `BILLING_CHECKOUT_ENABLED=${JSON.stringify(v)}`);
    assert.equal(copy.checkoutEnabledNow(), sw.checkoutEnabledFromEnv(v), `parse of ${JSON.stringify(v)}`);
  }
});

test('checkout OFF (unset, the beta default): no buy instruction, the beta copy is shown', () => {
  for (const v of [undefined, '', 'TRUE', '1']) {
    setSwitch(v);
    for (const code of CODES) {
      const msg = copy.entitlementMessage(code);
      assert.equal(msg, line(copy.CHECKOUT_OFF_COPY[code]), `${code} @ ${JSON.stringify(v)}`);
      assert.doesNotMatch(msg, BUY_RE, `${code}: tells the user to buy while checkout is off: ${msg}`);
      assert.match(msg, /during the beta/, `${code}: says why`);
      // The internal detail never reaches the copy in either posture.
      assert.equal(copy.entitlementMessage(code, 'internal detail xyz'), msg);
    }
  }
});

test('checkout ON (exactly "true"): the original ERROR_COPY sentences come back unchanged', () => {
  setSwitch('true');
  assert.equal(copy.entitlementMessage('TRIAL_EXHAUSTED'), "You've used all the tracks in your free trial. Pick a plan or buy a credit pack to keep going.");
  assert.equal(copy.entitlementMessage('CREDIT_BALANCE_INSUFFICIENT'), "You're out of credits. Buy a credit pack to add more tracks.");
  for (const code of CODES) assert.equal(copy.entitlementMessage(code), line(copy.ERROR_COPY[code]));
});

test('errorCopy: explicit posture wins; only the two codes change; unknown codes stay DEFAULT_ERROR', () => {
  setSwitch(undefined);
  for (const code of CODES) {
    assert.deepEqual(copy.errorCopy(code, true), copy.ERROR_COPY[code]);
    assert.deepEqual(copy.errorCopy(code, false), copy.CHECKOUT_OFF_COPY[code]);
  }
  assert.deepEqual(Object.keys(copy.CHECKOUT_OFF_COPY).sort(), [...CODES].sort());
  for (const code of Object.keys(copy.ERROR_COPY).filter((c) => !CODES.includes(c))) {
    assert.deepEqual(copy.errorCopy(code, false), copy.ERROR_COPY[code], code);
    assert.deepEqual(copy.errorCopy(code, true), copy.ERROR_COPY[code], code);
  }
  assert.deepEqual(copy.errorCopy('NOT_A_CODE', false), copy.DEFAULT_ERROR);
  assert.deepEqual(copy.errorCopy('NOT_A_CODE', true), copy.DEFAULT_ERROR);
});

test('the switch is read per call, not cached at import', () => {
  setSwitch(undefined);
  const off = copy.entitlementMessage('CREDIT_BALANCE_INSUFFICIENT');
  setSwitch('true');
  const on = copy.entitlementMessage('CREDIT_BALANCE_INSUFFICIENT');
  assert.notEqual(off, on);
  setSwitch(undefined);
  assert.equal(copy.entitlementMessage('CREDIT_BALANCE_INSUFFICIENT'), off);
});
