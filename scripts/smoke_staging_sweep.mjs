#!/usr/bin/env node
// smoke_staging_sweep.mjs — delete leaked smoke-test users (and their Stripe
// sandbox customers) from STAGING. Companion to smoke_staging.mjs, run by
// .github/workflows/nightly-staging-smoke.yml in an `if: always()` step.
//
// Why it exists: smoke_staging.mjs cleans up in a try/finally, but a runner
// cancel or timeout delivers SIGTERM/SIGKILL, which skips `finally`. This
// sweeps up whatever such a run left behind.
//
// Safety (this script DELETES things):
//   - SUPABASE_URL host must be exactly the staging project, else exit 2.
//   - STRIPE_SECRET_KEY, if set, must be a TEST key, else exit 2.
//   - Only users whose email matches ^smoke-test-<13 digits>@stemloops.test$
//     AND whose user_metadata.smoke_test === true AND older than
//     SWEEP_MIN_AGE_MIN (default 10) are touched. The age floor avoids racing
//     a human running smoke_staging.mjs locally.
//   - SWEEP_DRY_RUN=1 lists without deleting.
//
// Exit codes: 0 swept (or nothing to sweep), 1 a deletion failed, 2 guard/setup.
// Zero dependencies, Node >= 18.

const STAGING_HOST = 'ylzokjwnsraehmpclnkx.supabase.co';
const norm = (u) => (u ? (/^https?:\/\//.test(u) ? u : `https://${u}`).replace(/\/+$/, '') : '');
const SB_URL = norm(process.env.SUPABASE_URL);
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const MIN_AGE_MS = Number(process.env.SWEEP_MIN_AGE_MIN || 10) * 60_000;
const DRY = process.env.SWEEP_DRY_RUN === '1';
const EMAIL_RE = /^smoke-test-\d{13}@stemloops\.test$/;

const die = (code, msg) => { console.error(msg); process.exit(code); };

let host = '';
try { host = new URL(SB_URL).hostname; } catch { /* handled below */ }
if (host !== STAGING_HOST) die(2, `Refusing to sweep: SUPABASE_URL host is "${host || '(unset)'}", expected ${STAGING_HOST}.`);
if (!KEY) die(2, 'Refusing to sweep: SUPABASE_SERVICE_ROLE_KEY is unset.');
if (STRIPE_KEY && !/^(sk|rk)_test_/.test(STRIPE_KEY)) die(2, 'Refusing to sweep: STRIPE_SECRET_KEY is not a test-mode key.');

async function call(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(25_000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const sb = (path, opts = {}) =>
  call(`${SB_URL}${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Accept-Profile': 'public', ...(opts.headers || {}) } });

// Collect candidates (paginated).
const candidates = [];
const PER = 200;
for (let page = 1; page <= 50; page++) {
  const r = await sb(`/auth/v1/admin/users?page=${page}&per_page=${PER}`);
  if (r.status !== 200) die(1, `Could not list users: HTTP ${r.status} ${r.text.slice(0, 120)}`);
  const users = r.json?.users ?? [];
  for (const u of users) {
    const age = Date.now() - Date.parse(u.created_at);
    if (EMAIL_RE.test(u.email || '') && u.user_metadata?.smoke_test === true && age >= MIN_AGE_MS) candidates.push(u);
  }
  if (users.length < PER) break;
}

console.log(`smoke-test sweep: ${candidates.length} leaked user(s) older than ${MIN_AGE_MS / 60_000} min${DRY ? ' (dry run)' : ''}`);
let failed = 0;
for (const u of candidates) {
  const label = `${u.email} (${u.id.slice(0, 8)}...)`;
  if (DRY) { console.log(`  would delete ${label}`); continue; }
  try {
    if (STRIPE_KEY) {
      const c = await sb(`/rest/v1/customers_billing?user_id=eq.${u.id}&select=provider_customer_id`);
      const cid = c.json?.[0]?.provider_customer_id;
      if (typeof cid === 'string' && /^cus_[A-Za-z0-9]+$/.test(cid)) {
        const d = await call(`https://api.stripe.com/v1/customers/${cid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
        if (d.status !== 200 && d.status !== 404) throw new Error(`Stripe customer delete HTTP ${d.status}`);
      }
    }
    const d = await sb(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' });
    if (d.status >= 300 && d.status !== 404) throw new Error(`user delete HTTP ${d.status}`);
    console.log(`  deleted ${label}`);
  } catch (e) {
    failed++;
    console.error(`  FAILED ${label}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
