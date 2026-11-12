#!/usr/bin/env node
// smoke_staging.mjs — end-to-end billing-path smoke test for stem-loops V3.
//
// Runs against the LIVE staging deployment (Vercel + Supabase + Stripe BC
// sandbox). Creates an ephemeral Supabase user, drives the billing API as that
// user, then deletes the user and verifies the cascade. See
// scripts/SMOKE-TEST-README.md for setup.
//
// Dependencies: none (node:fetch, node:crypto, node:fs). Node >= 18.
// Exit codes: 0 all PASS/SKIP, 1 any FAIL, 2 setup error (missing env).
//
// SAFETY: refuses to run against stem-loops.com unless SMOKE_ALLOW_PROD=1.
// Stripe card entry is NOT bypassed; that step is reported SKIP.
//
// Supabase Auth's built-in captcha protection (Dashboard > Authentication >
// Attack Protection) stays ON. Step 3b mints its session through the Admin
// API, which is not captcha-gated. NB: admin credentials also skip captcha on
// the gated routes (GoTrue middleware.go:254-257), so the old password grant
// was fixable too -- the Admin API is a choice, not the only option. See
// scripts/lib/smoke_session.mjs for the reasoning and the endpoint shapes.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mintServiceRoleSession } from './lib/smoke_session.mjs';

// ---------------------------------------------------------------- env loading
const here = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = process.env.SMOKE_ENV_FILE
  ? resolve(process.env.SMOKE_ENV_FILE)
  : [resolve(process.cwd(), '.env.staging'), resolve(here, '..', '.env.staging')].find(existsSync);

function loadEnvFile(path) {
  // Minimal dotenv: KEY=VALUE, optional quotes, # comments. Shell env wins.
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
if (ENV_FILE && existsSync(ENV_FILE)) loadEnvFile(ENV_FILE);

const normUrl = (u) => (u ? (/^https?:\/\//.test(u) ? u : `https://${u}`).replace(/\/+$/, '') : '');
const BASE = normUrl(process.env.STAGING_BASE_URL || 'https://stem-loops-staging.vercel.app');
const SB_URL = normUrl(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
// OPTIONAL. Not used to sign in any more (that was the captcha-blocked
// password grant). Step 3b passes it to mintServiceRoleSession purely as the
// `apikey` on the PUBLIC /auth/v1/verify call, so the service-role key is not
// sent to an unauthenticated endpoint. Absent, the service key is used there
// instead and the test still works; present, it is the least-privileged key
// that clears the Supabase gateway. The nightly workflow's preflight still
// requires the STAGING_SUPABASE_ANON_KEY secret.
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '';

const IS_PROD_TARGET = /^https:\/\/(www\.)?stem-loops\.com/.test(BASE);

// The staging Supabase project. scripts/smoke_staging_sweep.mjs has pinned its
// host since it was written; this script checked only STAGING_BASE_URL, so
// SUPABASE_URL could be pointed at the production project while the base URL
// still looked like staging -- and every admin call,
// including the user DELETE in step 9, would have landed there. Closing that.
// Honours the same SMOKE_ALLOW_PROD escape hatch as the two guards below, so
// the documented prod path in scripts/SMOKE-TEST-README.md still works; CI
// forces SMOKE_ALLOW_PROD empty and re-asserts it in the workflow.
const STAGING_SB_HOST = 'ylzokjwnsraehmpclnkx.supabase.co';
let SB_HOST = '';
try { SB_HOST = new URL(SB_URL).hostname; } catch { /* reported below */ }

// -------------------------------------------------------------------- results
const results = []; // { n, name, status: PASS|FAIL|SKIP, detail }
let stepNo = 0;
const rec = (name, status, detail = '') => {
  results.push({ n: ++stepNo, name, status, detail });
  return status === 'PASS';
};
const pass = (name, detail) => rec(name, 'PASS', detail);
const fail = (name, detail) => rec(name, 'FAIL', detail);
const skip = (name, detail) => rec(name, 'SKIP', detail);

function printTable() {
  const head = ['#', 'Step', 'Result', 'Detail'];
  const rows = results.map((r) => [String(r.n), r.name, r.status, r.detail]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (i < 3 ? r[i].length : 0))));
  const fmt = (r) => r.map((c, i) => (i < 3 ? c.padEnd(w[i]) : c)).join(' | ');
  console.log('\n' + fmt(head));
  console.log(`${'-'.repeat(w[0])}-+-${'-'.repeat(w[1])}-+-${'-'.repeat(w[2])}-+-${'-'.repeat(40)}`);
  for (const r of rows) console.log(fmt(r));
  const c = (s) => results.filter((r) => r.status === s).length;
  console.log(`\nTotal: ${c('PASS')} PASS, ${c('FAIL')} FAIL, ${c('SKIP')} SKIP`);
}

function finish(code) {
  printTable();
  process.exit(code);
}

// ------------------------------------------------------------------- helpers
const TIMEOUT = 25_000;
async function http(url, { method = 'GET', headers = {}, body, redirect = 'follow' } = {}) {
  const h = { ...headers };
  if (BYPASS && url.startsWith(BASE)) h['x-vercel-protection-bypass'] = BYPASS;
  const res = await fetch(url, { method, headers: h, body, redirect, signal: AbortSignal.timeout(TIMEOUT) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json, url: res.url };
}

// Every request below that carries a credential uses redirect: 'manual'.
// undici follows redirects by default, and while it strips `Authorization`
// cross-origin per fetch spec it does NOT strip a custom header such as
// `apikey`, so a 30x off the Supabase host would hand the next origin the
// service-role key -- which bypasses RLS. Reproduced locally on Node v22.23.4
// with two servers: redirect:'follow' delivered the full apikey to the second
// origin; 'manual' never makes the hop. Callers already treat >= 300 as a
// failure, so a redirect now surfaces as one instead of being followed.
//
// Two requests deliberately stay on 'follow', and the honest reasons are not
// the ones an earlier version of this comment gave:
//
//   - Step 1's GET /pricing. It DOES carry a credential: the Vercel bypass
//     secret defeats deployment protection. And it is NOT guaranteed
//     same-origin -- step 1 itself looks for `vercel.com/sso-api` in the
//     response, i.e. it EXPECTS a cross-origin redirect when protection is on,
//     and with 'follow' the bypass header is forwarded to vercel.com. This is
//     accepted rather than fixed: the destination is the secret's own issuer,
//     and 'manual' would replace step 1's actionable "deployment protection is
//     on. Set VERCEL_AUTOMATION_BYPASS_SECRET" with a bare HTTP 307.
//   - The GET of a Stripe checkout_url in steps 7-8. This one genuinely
//     carries no credential of ours and legitimately redirects.
//
// http()'s own default therefore stays 'follow'; every credentialled request
// opts into 'manual' explicitly below.
const sbAdmin = (path, opts = {}) =>
  http(`${SB_URL}${path}`, {
    ...opts,
    // AFTER the spread: before it, a caller passing { redirect: 'follow' }
    // would silently override the guard. No call site does, but a guard a
    // caller can switch off is not a guard.
    redirect: 'manual',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });

const stripe = (path, { method = 'GET', form } = {}) =>
  http(`https://api.stripe.com${path}`, {
    method,
    redirect: 'manual',
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });

const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
const textOf = (html) => stripComments(html).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/** Build the @supabase/ssr auth cookie (base64url value, 3180-char chunks). */
function sessionCookieHeader(session) {
  const ref = new URL(SB_URL).hostname.split('.')[0];
  const name = `sb-${ref}-auth-token`;
  const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const CHUNK = 3180;
  if (value.length <= CHUNK) return `${name}=${value}`;
  const parts = [];
  for (let i = 0, k = 0; i < value.length; i += CHUNK, k++) parts.push(`${name}.${k}=${value.slice(i, i + CHUNK)}`);
  return parts.join('; ');
}

const setupHelp = (missing) => `
Setup required: missing ${missing}.

Create ./.env.staging (gitignored) in the repo root:

  STAGING_BASE_URL=https://stem-loops-staging.vercel.app
  SUPABASE_URL=https://ylzokjwnsraehmpclnkx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=...   # Supabase dashboard > Project Settings > API > service_role
                                  #   (or: vercel env pull .env.staging --environment=preview)
                                  #   Also mints the test user's session (Admin API), so it is required.
  SUPABASE_ANON_KEY=...           # optional: same page, publishable key. Used only as the apikey on the
                                  #   public /auth/v1/verify call, to keep the service key off it.
  STRIPE_SECRET_KEY=sk_test_...   # Stripe sandbox > Developers > API keys (optional: enables session verification + cleanup)

Or export the same variables in your shell / CI secrets.
See scripts/SMOKE-TEST-README.md.`;

// ---------------------------------------------------------------------- main
console.log(`stem-loops staging smoke test
  target:   ${BASE}
  supabase: ${SB_URL || '(unset)'}
  env file: ${ENV_FILE && existsSync(ENV_FILE) ? ENV_FILE : '(none; using shell env only)'}
  stripe:   ${STRIPE_KEY ? STRIPE_KEY.slice(0, 8) + '...' : '(unset; Stripe verification will SKIP)'}`);

if (SB_URL && SB_HOST !== STAGING_SB_HOST && process.env.SMOKE_ALLOW_PROD !== '1') {
  console.error(`\nRefusing to run: SUPABASE_URL host is "${SB_HOST || '(unparseable)'}", expected ${STAGING_SB_HOST}. Set SMOKE_ALLOW_PROD=1 to override.`);
  process.exit(2);
}
if (IS_PROD_TARGET && process.env.SMOKE_ALLOW_PROD !== '1') {
  console.error('\nRefusing to run against production (stem-loops.com). Set SMOKE_ALLOW_PROD=1 to override.');
  process.exit(2);
}
if (STRIPE_KEY.startsWith('sk_live_') && process.env.SMOKE_ALLOW_PROD !== '1') {
  console.error('\nRefusing to use a LIVE Stripe key without SMOKE_ALLOW_PROD=1.');
  process.exit(2);
}

// ---- Step 1: health (public) -------------------------------------------------
let pricingHtml = '';
try {
  const r = await http(`${BASE}/pricing`);
  pricingHtml = r.text;
  if (r.status === 401 || /Authentication Required|vercel\.com\/sso-api/i.test(r.text.slice(0, 4000))) {
    fail('1. Health: /pricing', `HTTP ${r.status}: Vercel deployment protection is on. Set VERCEL_AUTOMATION_BYPASS_SECRET.`);
    finish(1);
  } else if (r.status !== 200) {
    fail('1. Health: /pricing', `HTTP ${r.status}`);
    finish(1);
  } else if (/live plan data is temporarily unavailable/i.test(textOf(r.text))) {
    fail('1. Health: /pricing', 'DB connection degraded, bail out (page is serving FALLBACK catalog)');
    finish(1);
  } else {
    pass('1. Health: /pricing', 'HTTP 200, no degraded-mode banner');
  }
} catch (e) {
  fail('1. Health: /pricing', `request failed: ${e.message}`);
  finish(1);
}

// ---- Step 2: plans catalog (public) -----------------------------------------
{
  const t = textOf(pricingHtml);
  const problems = [];
  if (!/aria-label="Pro"/.test(pricingHtml) || !t.includes('$4.99 CAD')) problems.push('Pro $4.99 CAD missing');
  if (!/aria-label="Studio"/.test(pricingHtml) || !t.includes('$12 CAD')) problems.push('Studio $12 CAD missing');
  const packs = [...stripComments(pricingHtml).matchAll(/aria-label="(\d+) credits for \$([\d.]+) CAD"/g)].map((m) => [Number(m[1]), m[2]]);
  const got = packs.map((p) => p[0]).sort((a, b) => a - b).join(',');
  if (got !== '20,60,180') problems.push(`credit packs rendered: [${got}] expected [20,60,180]`);
  if (problems.length) fail('2. Plans catalog', problems.join('; '));
  else pass('2. Plans catalog', `Pro $4.99, Studio $12, packs ${packs.map((p) => `${p[0]}cr=$${p[1]}`).join(' ')} (CAD)`);
}

// ---- Setup gate for authenticated steps --------------------------------------
{
  const missing = [];
  if (!SB_URL) missing.push('SUPABASE_URL');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    fail('3. Ephemeral user (setup)', `missing env: ${missing.join(', ')}${ENV_FILE ? '' : ' (.env.staging not found)'}`);
    printTable();
    console.error(setupHelp(missing.join(', ')));
    process.exit(2);
  }
}

// ---- Steps 3-8 (authenticated), with guaranteed cleanup ----------------------
const email = `smoke-test-${Date.now()}@stemloops.test`;
// Still set on the created user (step 3 passes it to admin/users) so the
// fixture matches a real signed-up account's shape. It is never used to sign
// in any more -- step 3b mints the session over the Admin API instead.
const password = randomBytes(18).toString('base64url') + 'aA1!';
let userId = null;
let stripeCustomerId = null;
const stripeSessions = [];
let cookie = null;
// redirect: 'manual' -- these carry the session cookie and the Vercel bypass
// secret; see the note above sbAdmin. Steps 4-8 already require HTTP 200.
const authed = (extra = {}) => ({ redirect: 'manual', headers: { Cookie: cookie, Origin: BASE, ...extra } });

try {
  // Step 3: create user via Admin API and verify it is readable
  try {
    const c = await sbAdmin('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { smoke_test: true } }) });
    if (c.status >= 300 || !c.json?.id) throw new Error(`create HTTP ${c.status}: ${c.text.slice(0, 160)}`);
    userId = c.json.id;
    const g = await sbAdmin(`/auth/v1/admin/users/${userId}`);
    if (g.status !== 200 || g.json?.email !== email) throw new Error(`admin lookup HTTP ${g.status}`);
    pass('3. Ephemeral user', `created ${email} (${userId.slice(0, 8)}...), present in auth.users`);
  } catch (e) {
    fail('3. Ephemeral user', e.message);
  }

  // Step 3b: mint a session for the test user (the app is cookie-auth only).
  //
  // NOT an anonymous password grant: POST /auth/v1/token?grant_type=password
  // sent with only the publishable key is captcha-gated by Supabase Auth's
  // Attack Protection setting, which is on in staging on purpose -- that is
  // what broke this test for five nights. We generate a magic link with the
  // service role and redeem its hashed_token at /auth/v1/verify, which returns
  // the identical session shape. (Admin credentials would ALSO have skipped
  // captcha on /token; see scripts/lib/smoke_session.mjs for why this path was
  // chosen over that one-liner.)
  if (userId) {
    try {
      // onNotice surfaces the anon-key fallback. Without it, a permanently
      // rejected anon key would quietly use the service key on every run and
      // nothing in the output would say the preference had stopped working.
      const notices = [];
      const session = await mintServiceRoleSession({
        sbUrl: SB_URL,
        serviceKey: SERVICE_KEY,
        anonKey: ANON_KEY,
        email,
        onNotice: (m) => {
          notices.push(m);
          console.warn(`::warning title=Smoke session fell back to the service-role key::${m}`);
        },
      });
      cookie = sessionCookieHeader(session);
      pass(
        '3b. Sign in (session cookie)',
        `admin generate_link + verify OK; @supabase/ssr cookie built${notices.length ? ' -- WITH FALLBACK: ' + notices.join(' ') : ''}`,
      );
    } catch (e) {
      fail('3b. Sign in (session cookie)', e.message);
    }
  }

  const needAuth = (name) => (cookie ? true : (skip(name, 'no session (step 3/3b failed)'), false));

  // Step 4: trial grant, twice
  if (needAuth('4. Trial grant')) {
    try {
      const a = await http(`${BASE}/api/users/me/trial/grant`, { method: 'POST', ...authed() });
      if (a.status !== 200 || a.json?.granted !== true || a.json?.songs_remaining !== 3) throw new Error(`HTTP ${a.status} ${a.text.slice(0, 140)}`);
      pass('4a. Trial grant (first)', `granted=true songs_remaining=3 expires_at=${a.json.expires_at}`);
      const b = await http(`${BASE}/api/users/me/trial/grant`, { method: 'POST', ...authed() });
      // Shipped contract is an idempotent 200 {granted:false}, NOT 409 TRIAL_ALREADY_USED.
      if (b.status === 200 && b.json?.granted === false && b.json?.songs_remaining === 3) pass('4b. Trial grant (repeat)', 'idempotent: HTTP 200 granted=false, no second trial');
      else fail('4b. Trial grant (repeat)', `expected HTTP 200 {granted:false}; got HTTP ${b.status} ${b.text.slice(0, 140)}`);
    } catch (e) {
      fail('4a. Trial grant (first)', e.message);
    }
  }

  // Step 5: entitlements
  if (needAuth('5. Entitlements')) {
    try {
      const r = await http(`${BASE}/api/entitlements`, authed());
      const svc = r.json?.services ?? [];
      const miss = ['youtube', 'spotify', 'soundcloud'].filter((s) => !svc.includes(s));
      if (r.status !== 200 || r.json?.plan_code !== 'free' || miss.length) throw new Error(`HTTP ${r.status} plan_code=${r.json?.plan_code} missing_services=[${miss}] body=${r.text.slice(0, 120)}`);
      pass('5. Entitlements', `plan_code=free services=[${svc}] trial_songs_remaining=${r.json.trial_songs_remaining}`);
    } catch (e) {
      fail('5. Entitlements', e.message);
    }
  }

  // Step 6: credit balance
  if (needAuth('6. Credit balance')) {
    try {
      const r = await http(`${BASE}/api/billing/credits/balance`, authed());
      if (r.status !== 200 || r.json?.credits_remaining !== 0) throw new Error(`HTTP ${r.status} body=${r.text.slice(0, 140)}`);
      pass('6. Credit balance', 'credits_remaining=0, no purchases');
    } catch (e) {
      fail('6. Credit balance', e.message);
    }
  }

  // Steps 7-8: checkout (credits, subscription)
  const checkout = async (label, body, expect) => {
    if (!needAuth(label)) return;
    try {
      const r = await http(`${BASE}/api/billing/checkout`, { method: 'POST', ...authed({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
      const url = r.json?.checkout_url;
      if (r.status !== 200 || typeof url !== 'string' || !url.startsWith('https://')) throw new Error(`HTTP ${r.status} body=${r.text.slice(0, 160)}`);
      const sid = (url.match(/\/(cs_(?:test|live)_[A-Za-z0-9]+)/) || [])[1];
      if (sid) stripeSessions.push(sid);
      const reach = await http(url);
      if (reach.status !== 200) throw new Error(`checkout_url returned HTTP ${reach.status}`);
      let extra = 'session not verified (STRIPE_SECRET_KEY unset)';
      if (STRIPE_KEY && sid) {
        const s = await stripe(`/v1/checkout/sessions/${sid}`);
        const j = s.json || {};
        const bad = [];
        if (s.status !== 200) bad.push(`Stripe API HTTP ${s.status}`);
        else {
          if (j.mode !== expect.mode) bad.push(`mode=${j.mode} expected ${expect.mode}`);
          if (j.currency !== 'cad') bad.push(`currency=${j.currency} expected cad`);
          if (j.amount_total !== expect.cents) bad.push(`amount_total=${j.amount_total} expected ${expect.cents}`);
          if (j.customer) stripeCustomerId = j.customer;
        }
        if (bad.length) throw new Error(bad.join('; '));
        extra = `Stripe: mode=${j.mode} ${j.currency.toUpperCase()} ${(j.amount_total / 100).toFixed(2)}`;
      }
      pass(label, `checkout_url reachable (HTTP 200); ${extra}`);
      skip(`${label} (card submit)`, 'manual step: Stripe card form + hCaptcha not scripted');
    } catch (e) {
      fail(label, e.message);
    }
  };
  // Step 7: the credit-pack BOT GATE. This deliberately does NOT attempt a
  // purchase, because it CANNOT succeed from a script and never could.
  //
  // apps/web/src/app/api/billing/checkout/route.ts:126-140 (V3-C1):
  //   "credit-pack purchases require a solved hCaptcha challenge. Subscription
  //    checkout (plan_code) is NOT gated - authenticated + rate limited already."
  //
  // So a scripted pack checkout returns 400 BOT_CHALLENGE_FAILED by DESIGN, and
  // the old step 7 asserted a 200. It had therefore failed every night since the
  // gate shipped, for a reason no change to this repo could ever fix.
  //
  // A smoke that is red every night for a structural reason is WORSE THAN NO
  // SMOKE: it trains everyone to ignore the alarm. It did. On 2026-11-11 this
  // run was 11 PASS / 1 FAIL / 1 SKIP and nobody had read the 11.
  //
  // So assert the thing that IS checkable and actually matters: THE GATE IS
  // ARMED. A 200 here would mean credit packs can be bought with no bot
  // challenge at all, which is the V3-C1 control silently disabled - and
  // nothing else in this repo tests it.
  if (needAuth('7. Credit-pack bot gate armed')) {
    try {
      const r = await http(`${BASE}/api/billing/checkout`, {
        method: 'POST',
        ...authed({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ pack_code: 'credits_20' }),
      });
      if (r.status === 200) {
        throw new Error(
          `pack checkout SUCCEEDED with no hCaptcha token (HTTP 200). The V3-C1 bot ` +
          `gate is DISARMED: credit packs can be bought by a script. See ` +
          `api/billing/checkout/route.ts:131-140. body=${r.text.slice(0, 160)}`,
        );
      }
      if (r.status !== 400 || r.json?.code !== 'BOT_CHALLENGE_FAILED') {
        throw new Error(
          `expected HTTP 400 BOT_CHALLENGE_FAILED, got HTTP ${r.status} ` +
          `code=${r.json?.code} body=${r.text.slice(0, 160)}`,
        );
      }
      pass('7. Credit-pack bot gate armed', 'unsolved pack checkout correctly refused: 400 BOT_CHALLENGE_FAILED');
      skip('7. Checkout: credits_20 (purchase)', 'manual step: hCaptcha challenge not scriptable (V3-C1)');
    } catch (e) {
      fail('7. Credit-pack bot gate armed', e.message);
    }
  }

  await checkout('8. Checkout: pro', { plan_code: 'pro' }, { mode: 'subscription', cents: 499 });
} catch (e) {
  fail('Unexpected error', e.stack || e.message);
} finally {
  // ---- Step 9: cleanup + cascade verification --------------------------------
  if (!userId) {
    skip('9. Cleanup', 'no user was created');
  } else {
    // [table, user column]. usage_events.user_id is ON DELETE SET NULL, so a
    // surviving row has user_id NULL and the eq filter still counts 0.
    const TABLES = [
      ['users', 'id'], ['trial_grants', 'user_id'], ['customers_billing', 'user_id'], ['subscriptions', 'user_id'],
      ['entitlements', 'user_id'], ['credit_purchases', 'user_id'], ['credit_consumption', 'user_id'],
      ['promo_redemptions', 'user_id'], ['usage_events', 'user_id'],
    ];
    const count = async (t, col) => {
      const r = await sbAdmin(`/rest/v1/${t}?${col}=eq.${userId}&select=${col}`, { headers: { 'Accept-Profile': 'public' } });
      return r.status === 200 && Array.isArray(r.json) ? r.json.length : null; // null = not exposed / error
    };
    const before = {};
    for (const [t, col] of TABLES) before[t] = await count(t, col);

    // Stripe side: expire open sessions, delete the customer (sandbox only).
    let stripeNote = '';
    if (STRIPE_KEY) {
      try {
        if (!stripeCustomerId) {
          const r = await sbAdmin(`/rest/v1/customers_billing?user_id=eq.${userId}&select=provider_customer_id`, { headers: { 'Accept-Profile': 'public' } });
          stripeCustomerId = r.json?.[0]?.provider_customer_id ?? null;
        }
        for (const sid of stripeSessions) await stripe(`/v1/checkout/sessions/${sid}/expire`, { method: 'POST', form: {} });
        if (stripeCustomerId) {
          const d = await stripe(`/v1/customers/${stripeCustomerId}`, { method: 'DELETE' });
          stripeNote = d.json?.deleted ? `; Stripe customer ${stripeCustomerId} deleted, ${stripeSessions.length} session(s) expired` : `; Stripe customer delete HTTP ${d.status}`;
        }
      } catch (e) {
        stripeNote = `; Stripe cleanup error: ${e.message}`;
      }
    }

    try {
      const d = await sbAdmin(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
      if (d.status >= 300) throw new Error(`delete HTTP ${d.status}: ${d.text.slice(0, 120)}`);
      const g = await sbAdmin(`/auth/v1/admin/users/${userId}`);
      if (g.status !== 404) throw new Error(`user still present after delete (HTTP ${g.status})`);
      pass('9a. Cleanup: auth.users', `deleted and verified absent${stripeNote}`);

      const leftovers = [];
      const unknown = [];
      for (const [t, col] of TABLES) {
        const n = await count(t, col);
        if (n === null) unknown.push(t);
        else if (n > 0) leftovers.push(`${t}(${n})`);
      }
      const seeded = Object.entries(before).filter(([, n]) => n > 0).map(([t, n]) => `${t}:${n}`).join(' ') || 'none';
      if (leftovers.length) fail('9b. Cleanup: DB cascade', `rows remain: ${leftovers.join(', ')}`);
      else if (unknown.length === TABLES.length) skip('9b. Cleanup: DB cascade', 'public schema not exposed via PostgREST; verify manually');
      else pass('9b. Cleanup: DB cascade', `0 rows left in ${TABLES.length - unknown.length} tables (pre-delete rows: ${seeded})${unknown.length ? `; not checkable: ${unknown.join(',')}` : ''}`);
    } catch (e) {
      fail('9a. Cleanup: auth.users', `${e.message} -- MANUAL CLEANUP NEEDED for ${email} (${userId})`);
    }
  }
}

finish(results.some((r) => r.status === 'FAIL') ? 1 : 0);
