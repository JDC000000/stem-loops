// QA track B, B-07: Stripe redirect targets come from config, never the request's Origin.
//
// Before: checkout and portal built success_url / cancel_url / return_url from
// `req.headers.get('origin') ?? 'https://stem-loops.com'`, so a direct caller could make Stripe
// send a payer to any origin after payment. The REAL routes run here with a stub provider that
// records the URLs it is handed. The caller's Origin is a foreign host that still PASSES the
// same-origin guard (Host matches it, as a direct non-browser caller can arrange), so the only
// thing deciding the URL is the route's own source of truth.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { wirePureLibs } from './helpers/pure-libs.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

const stubs = {
  next: dataUrl(`
    export class NextRequest {}
    export class NextResponse {
      constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; }
      static json(body, init = {}) { return new NextResponse(body, init); }
    }`),
  auth: dataUrl(`export async function getUser() { return { user_id: '00000000-0000-0000-0000-000000000001', email: 'a@example.com' }; }`),
  hcaptcha: dataUrl(`export async function verifyHcaptchaToken() { return { success: true }; }`),
  billing: dataUrl(`
    export function getBillingProvider() {
      return {
        name: 'stripe',
        createCustomer: async () => ({ providerCustomerId: 'cus_test' }),
        createCreditPurchaseSession: async (_u, _p, s, c) => { globalThis.__urls.push({ s, c }); return { sessionId: 'cs', url: 'https://checkout.test/x' }; },
        createCheckoutSession: async (_u, _p, s, c) => { globalThis.__urls.push({ s, c }); return { sessionId: 'cs', url: 'https://checkout.test/x' }; },
        createPortalSession: async (_cid, ret) => { globalThis.__urls.push({ ret }); return { url: 'https://portal.test/x' }; },
        applyPromoCode: async () => {},
        resolvePromotionCodeId: async () => null,
      };
    }`),
  db: dataUrl(`
    export const db = {
      tx: async (fn) => fn({ query: async (sql) => (/COUNT/.test(sql) ? { rows: [{ n: '0' }] } : { rows: [] }) }),
      query: async (sql) => (/customers_billing/.test(sql) ? { rows: [{ provider_customer_id: 'cus_test' }] } : { rows: [] }),
    };`),
};

async function load(rel) {
  const js = toJs(read(rel))
    .replace(/from ['"]next\/server['"]/g, `from '${stubs.next}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${stubs.auth}'`)
    .replace(/from ['"]@\/lib\/billing['"]/g, `from '${stubs.billing}'`)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${stubs.db}'`)
    .replace(/from ['"]@\/lib\/hcaptcha['"]/g, `from '${stubs.hcaptcha}'`);
  return import(dataUrl(wirePureLibs(js)) + '#' + Math.random());
}

const FOREIGN = { origin: 'https://evil.example', host: 'evil.example' };
const req = (body, h = FOREIGN) => ({ headers: new Headers(h), json: async () => body });

let saved;
beforeEach(() => {
  globalThis.__urls = [];
  saved = process.env.APP_URL;
  delete process.env.APP_URL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = saved;
});

test('checkout (plan): success and cancel URLs ignore the Origin header', async () => {
  const { POST } = await load('src/app/api/billing/checkout/route.ts');
  const res = await POST(req({ plan_code: 'pro' }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [{ s, c }] = globalThis.__urls;
  assert.equal(s, 'https://stem-loops.com/success?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(c, 'https://stem-loops.com/pricing');
});

test('checkout (credits): same, with the credits param', async () => {
  const { POST } = await load('src/app/api/billing/checkout/route.ts');
  const res = await POST(req({ pack_code: 'credits_20', hcaptcha_token: 't' }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(globalThis.__urls[0].s, 'https://stem-loops.com/success?session_id={CHECKOUT_SESSION_ID}&credits=20');
});

test('portal: return URL ignores the Origin header', async () => {
  const { POST } = await load('src/app/api/billing/portal/route.ts');
  const res = await POST(req({}));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(globalThis.__urls[0].ret, 'https://stem-loops.com/account');
});

test('APP_URL (staging) sets the origin; its path is dropped', async () => {
  process.env.APP_URL = 'https://staging.stem-loops.com/some/path';
  const { POST } = await load('src/app/api/billing/portal/route.ts');
  await POST(req({}));
  assert.equal(globalThis.__urls[0].ret, 'https://staging.stem-loops.com/account');
});

test('a non-https or malformed APP_URL is ignored (falls back to production), never followed', async () => {
  for (const bad of ['http://evil.example', 'javascript:alert(1)', 'not a url', 'ftp://x.example']) {
    globalThis.__urls = [];
    process.env.APP_URL = bad;
    const { POST } = await load('src/app/api/billing/portal/route.ts');
    await POST(req({}));
    assert.equal(globalThis.__urls[0].ret, 'https://stem-loops.com/account', bad);
  }
});

test('the default app URL equals the SEO SITE_URL (one production origin)', () => {
  const site = read('src/lib/seo/site.ts').match(/SITE_URL\s*=\s*'([^']+)'/)[1];
  const def = read('src/lib/app-url.ts').match(/DEFAULT_APP_URL\s*=\s*'([^']+)'/)[1];
  assert.equal(def, site);
});

test('cross-origin requests to checkout and portal are refused before auth (403 BAD_ORIGIN)', async () => {
  for (const rel of ['src/app/api/billing/checkout/route.ts', 'src/app/api/billing/portal/route.ts']) {
    const { POST } = await load(rel);
    const res = await POST(req({ plan_code: 'pro' }, { origin: 'https://evil.example', host: 'stem-loops.com' }));
    assert.equal(res.status, 403, rel);
    assert.equal(res.body.code, 'BAD_ORIGIN');
    assert.equal(globalThis.__urls.length, 0);
  }
});

// PR #300 review SF-1: APP_URL unset on a deployment that is not the production site still
// falls back to the production origin, but must SAY so (one structured warning per process).
const appUrlFresh = () => import(dataUrl(toJs(read('src/lib/app-url.ts'))) + '#' + Math.random());
function warnsDuring(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return lines;
}

test('SF-1: APP_URL unset on a Vercel preview -> production origin, ONE app_url_default_used warning', async () => {
  const saved = { e: process.env.VERCEL_ENV, p: process.env.VERCEL_PROJECT_PRODUCTION_URL };
  try {
    process.env.VERCEL_ENV = 'preview';
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const m = await appUrlFresh();
    const lines = warnsDuring(() => {
      assert.equal(m.appOrigin(), 'https://stem-loops.com');
      assert.equal(m.appOrigin(), 'https://stem-loops.com');
    });
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).event, 'app_url_default_used');
  } finally {
    for (const [k, v] of [['VERCEL_ENV', saved.e], ['VERCEL_PROJECT_PRODUCTION_URL', saved.p]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('SF-1: the staging project (VERCEL_ENV=production, its own production URL) warns; the real site does not', async () => {
  const saved = { e: process.env.VERCEL_ENV, p: process.env.VERCEL_PROJECT_PRODUCTION_URL };
  try {
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'stem-loops-staging.vercel.app';
    let m = await appUrlFresh();
    assert.equal(warnsDuring(() => m.appOrigin()).length, 1, 'staging must warn');
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'stem-loops.com';
    m = await appUrlFresh();
    assert.equal(warnsDuring(() => m.appOrigin()).length, 0, 'the production site must not warn');
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    m = await appUrlFresh();
    assert.equal(warnsDuring(() => m.appOrigin()).length, 0, 'local dev/test must not warn');
  } finally {
    for (const [k, v] of [['VERCEL_ENV', saved.e], ['VERCEL_PROJECT_PRODUCTION_URL', saved.p]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
