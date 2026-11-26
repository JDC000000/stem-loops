// Tests for the beta checkout posture in scripts/smoke_staging.mjs (#453).
//
//   node --test scripts/smoke_staging_checkout.test.mjs
//
// Two layers:
//   1. the pure helpers in scripts/lib/smoke_checkout.mjs;
//   2. the REAL smoke script run as a subprocess against a local stub server that plays
//      staging, Supabase Auth and the billing API. No outbound request is made: every URL
//      points at 127.0.0.1, STRIPE_SECRET_KEY is empty, and SMOKE_ALLOW_PROD=1 is set only
//      so the staging-host guard lets a 127.0.0.1 SUPABASE_URL through.
// The open-checkout success path (200 + GET of an https Stripe URL) needs the network and
// is not driven here; the hidden path, the wrong-refusal paths and the step 7/8 posture
// mismatch are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHECKOUT_DISABLED, CHECKOUT_HIDDEN_OK, isCheckoutHidden, postureMismatch } from './lib/smoke_checkout.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'smoke_staging.mjs');

// ------------------------------------------------------------------ 1. helpers
test('isCheckoutHidden: only HTTP 403 with JSON code CHECKOUT_DISABLED', () => {
  assert.equal(CHECKOUT_DISABLED, 'CHECKOUT_DISABLED');
  assert.equal(isCheckoutHidden({ status: 403, json: { code: 'CHECKOUT_DISABLED' }, text: '' }), true);
  for (const r of [
    { status: 403, json: { code: 'BAD_ORIGIN' } },
    { status: 403, json: null, text: 'CHECKOUT_DISABLED' }, // non-JSON body naming the code
    { status: 403, json: { error: 'CHECKOUT_DISABLED' } },
    { status: 403, json: { code: 'checkout_disabled' } },
    { status: 401, json: { code: 'CHECKOUT_DISABLED' } },
    { status: 200, json: { code: 'CHECKOUT_DISABLED' } },
    { status: 400, json: { code: 'BOT_CHALLENGE_FAILED' } },
    { status: 403, json: 'CHECKOUT_DISABLED' },
    null,
    undefined,
  ]) {
    assert.equal(isCheckoutHidden(r), false, JSON.stringify(r));
  }
});

test('postureMismatch: only two different known postures are a mismatch', () => {
  assert.equal(postureMismatch(null, 'hidden'), null);
  assert.equal(postureMismatch('hidden', null), null);
  assert.equal(postureMismatch('hidden', 'hidden'), null);
  assert.equal(postureMismatch('open', 'open'), null);
  assert.match(postureMismatch('hidden', 'open'), /changed mid-run.*hidden.*open/);
  assert.match(postureMismatch('open', 'hidden'), /changed mid-run.*open.*hidden/);
});

// ---------------------------------------------------- 2. the real script, stubbed
const PRICING_HTML = `<html><body>
<section aria-label="Pro"><p>$4.99 CAD</p></section>
<section aria-label="Studio"><p>$12 CAD</p></section>
<section aria-label="20 credits for $3.99 CAD"></section>
<section aria-label="60 credits for $9.99 CAD"></section>
<section aria-label="180 credits for $24.99 CAD"></section>
</body></html>`;

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** A stub of staging + Supabase. `checkoutReplies` answers POST /api/billing/checkout in order. */
async function startStub(checkoutReplies) {
  const USER_ID = '22222222-2222-2222-2222-222222222222';
  const state = { email: null, deleted: false, grants: 0, checkoutCalls: [], unexpected: [] };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      const key = `${req.method} ${path}`;
      if (key === 'GET /pricing') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PRICING_HTML); }
      if (key === 'POST /auth/v1/admin/users') { state.email = JSON.parse(raw).email; return json(res, 200, { id: USER_ID, email: state.email }); }
      if (key === `GET /auth/v1/admin/users/${USER_ID}`) return state.deleted ? json(res, 404, {}) : json(res, 200, { id: USER_ID, email: state.email });
      if (key === `DELETE /auth/v1/admin/users/${USER_ID}`) { state.deleted = true; return json(res, 200, {}); }
      if (key === 'POST /auth/v1/admin/generate_link') return json(res, 200, { hashed_token: 'hashed-tok', verification_type: 'magiclink' });
      if (key === 'POST /auth/v1/verify') {
        return json(res, 200, { access_token: 'FAKE-AT', refresh_token: 'FAKE-RT', token_type: 'bearer', expires_in: 3600, user: { id: USER_ID } });
      }
      if (key === 'POST /api/users/me/trial/grant') {
        state.grants += 1;
        return json(res, 200, { granted: state.grants === 1, songs_remaining: 3, expires_at: '2026-12-25T00:00:00Z' });
      }
      if (key === 'GET /api/entitlements') return json(res, 200, { plan_code: 'free', services: ['youtube'], jobs_quota: 5, trial_songs_remaining: 3 });
      if (key === 'GET /api/billing/credits/balance') return json(res, 200, { credits_remaining: 0 });
      if (key === 'POST /api/billing/checkout') {
        state.checkoutCalls.push(JSON.parse(raw || 'null'));
        const [status, body] = checkoutReplies.shift() ?? [599, { code: 'STUB_EXHAUSTED' }];
        return json(res, status, body);
      }
      if (req.method === 'GET' && path.startsWith('/rest/v1/')) return json(res, 200, []);
      state.unexpected.push(key);
      return json(res, 500, { code: 'UNEXPECTED_STUB_ROUTE' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, close: () => new Promise((r) => server.close(r)) };
}

function runSmoke(base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        SMOKE_ENV_FILE: '/dev/null',
        STAGING_BASE_URL: base,
        SUPABASE_URL: base,
        SUPABASE_SERVICE_ROLE_KEY: 'FAKE-SERVICE-ROLE-KEY-FOR-SUBPROCESS-TEST',
        SUPABASE_ANON_KEY: '',
        STRIPE_SECRET_KEY: '',
        VERCEL_AUTOMATION_BYPASS_SECRET: '',
        SMOKE_ALLOW_PROD: '1', // only so the staging-host guard accepts 127.0.0.1
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}

const row = (out, re) => out.split('\n').find((l) => re.test(l)) ?? '';

async function scenario(replies) {
  const stub = await startStub(replies);
  try {
    const r = await runSmoke(stub.base);
    assert.deepEqual(stub.state.unexpected, [], `stub saw unexpected routes:\n${r.out}`);
    assert.equal(stub.state.deleted, true, `cleanup must still run:\n${r.out}`);
    return { ...r, calls: stub.state.checkoutCalls };
  } finally {
    await stub.close();
  }
}

const HIDDEN = [403, { error: 'Checkout is not open during the beta.', code: 'CHECKOUT_DISABLED' }];

test('checkout hidden: steps 7 and 8 PASS as the beta posture, bot gate SKIPs, exit 0', async () => {
  const r = await scenario([HIDDEN, HIDDEN]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, [{ pack_code: 'credits_20' }, { plan_code: 'pro' }]);
  assert.match(row(r.out, /7\. Checkout: credits_20/), /\| PASS +\| checkout hidden \(beta\) — OK/);
  assert.match(row(r.out, /8\. Checkout: pro/), /\| PASS +\| checkout hidden \(beta\) — OK/);
  // The gate was not observed, so it must not claim a PASS.
  assert.match(row(r.out, /7\. Credit-pack bot gate armed/), /\| SKIP +\|/);
  assert.ok(r.out.includes(CHECKOUT_HIDDEN_OK));
  assert.doesNotMatch(r.out, /\| FAIL /);
});

test('a 403 with another code (BAD_ORIGIN) is NOT the beta posture: FAIL, exit 1', async () => {
  const bad = [403, { error: 'cross-origin', code: 'BAD_ORIGIN' }];
  const r = await scenario([bad, bad]);
  assert.equal(r.code, 1, r.out);
  assert.match(row(r.out, /7\. Credit-pack bot gate armed/), /\| FAIL +\|.*BAD_ORIGIN/);
  assert.match(row(r.out, /8\. Checkout: pro/), /\| FAIL +\| HTTP 403/);
  assert.doesNotMatch(r.out, /checkout hidden \(beta\)/);
});

test('a non-JSON 403 that merely mentions CHECKOUT_DISABLED is a FAIL', async () => {
  const text = [403, 'CHECKOUT_DISABLED']; // a string body is sent as-is: not JSON
  const r = await scenario([text, text]);
  assert.equal(r.code, 1, r.out);
  assert.match(row(r.out, /7\. Credit-pack bot gate armed/), /\| FAIL +\|/);
  assert.match(row(r.out, /8\. Checkout: pro/), /\| FAIL +\|/);
});

test('hidden in step 7 but a 5xx in step 8 still FAILs step 8', async () => {
  const r = await scenario([HIDDEN, [500, { code: 'INTERNAL_ERROR' }]]);
  assert.equal(r.code, 1, r.out);
  assert.match(row(r.out, /7\. Checkout: credits_20/), /\| PASS +\|/);
  assert.match(row(r.out, /8\. Checkout: pro/), /\| FAIL +\| HTTP 500/);
});

test('posture mismatch: hidden in step 7, checkout_url in step 8 -> FAIL before the URL is fetched', async () => {
  const r = await scenario([HIDDEN, [200, { checkout_url: 'https://checkout.stripe.invalid/c/pay/cs_test_abc' }]]);
  assert.equal(r.code, 1, r.out);
  assert.match(row(r.out, /8\. Checkout: pro/), /\| FAIL +\| checkout posture changed mid-run: an earlier step saw checkout hidden, this one saw it open/);
});

test('posture mismatch: bot gate armed in step 7 (open), CHECKOUT_DISABLED in step 8 -> FAIL', async () => {
  const r = await scenario([[400, { code: 'BOT_CHALLENGE_FAILED' }], HIDDEN]);
  assert.equal(r.code, 1, r.out);
  assert.match(row(r.out, /7\. Credit-pack bot gate armed/), /\| PASS +\|/);
  assert.match(row(r.out, /8\. Checkout: pro/), /\| FAIL +\| checkout posture changed mid-run: an earlier step saw checkout open, this one saw it hidden/);
});

test('checkout open: the bot-gate assertion is unchanged (a 200 pack checkout is still a FAIL)', async () => {
  const r = await scenario([[200, { checkout_url: 'https://checkout.stripe.invalid/x' }], [500, { code: 'X' }]]);
  assert.equal(r.code, 1, r.out);
  assert.match(row(r.out, /7\. Credit-pack bot gate armed/), /\| FAIL +\| pack checkout SUCCEEDED with no hCaptcha token/);
});
