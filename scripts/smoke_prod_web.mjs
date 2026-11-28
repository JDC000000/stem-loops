#!/usr/bin/env node
// smoke_prod_web.mjs — read-only post-merge smoke of PRODUCTION web (J1a; Jon L9).
//
// Vercel rebuilds production on every merge to v3/main. This answers one question after a
// merge: "is production web up, in the expected posture, and serving the expected build?" See
// scripts/SMOKE-TEST-README.md ("Post-merge production web smoke").
//
//   EXPECT_DPL=dpl_... node scripts/smoke_prod_web.mjs     # https://stem-loops.com
//   SMOKE_BASE_URL=https://<preview>.vercel.app node scripts/smoke_prod_web.mjs
//
// BUILD IDENTITY: every HTML page Next serves carries the Vercel deployment id on its asset URLs
// (`?dpl=dpl_...`). The script FAILs if a page carries none, or the pages disagree, and, when
// EXPECT_DPL is set, unless every page carries exactly that id. Without EXPECT_DPL a green run
// proves the site is up and consistent, NOT that it is the merge commit's build; the Total line
// says so. The site exposes no git SHA, so EXPECT_SHA alone can only SKIP.
//
// READ-ONLY BY CONSTRUCTION: every request is a GET with no credential, no cookie and no body.
// No sign-in, no POST, no job creation, no spend. The one helper that talks to the network
// (get()) has no method parameter.
//
// Dependencies: none (global fetch). Node >= 18.
// Exit codes: 0 all PASS/SKIP (and at least one check ran), 1 any FAIL or zero checks ran,
// 2 bad configuration (SMOKE_BASE_URL, EXPECT_DPL, SMOKE_TIMEOUT_MS or SMOKE_DEADLINE_MS unusable).
//
// Bounds: per-request timeout 15 s (SMOKE_TIMEOUT_MS), overall deadline 100 s
// (SMOKE_DEADLINE_MS): no request is given longer than what is left of the deadline, and a check
// that starts after it FAILs as "overall deadline exceeded". A request is retried ONCE, and only
// on a network error (fetch rejected: DNS, refused, reset). A timeout, an HTTP error status or a
// wrong body is never retried, so a slow or broken site cannot stretch the run. HTML GETs carry a
// `?smoke=<ts>` query. NB: Vercel's CDN still answers static pages from cache with it (observed
// x-vercel-cache: HIT on /?smoke=...), so the dpl check, not the query, is what detects a stale build.
//
// Every marker below is pinned to the apps/web source at v3/main; the file:line of each is in
// the comment beside it. If a marker moves, update it here AND in the README table, never loosen
// the check to "contains anything".

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE = 'https://stem-loops.com';
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_DEADLINE_MS = 100_000;
export const MAX_TIMEOUT_MS = 60_000;
export const MAX_DEADLINE_MS = 600_000;
export const MAX_DEMOS = 10;

// ------------------------------------------------------------------ pinned markers
// layout.tsx:13 title template '%s · stem-loops'; page titles from lib/seo/pages.ts.
const TITLE = (t) => `<title>${t} · stem-loops</title>`;

export const MARKERS = Object.freeze({
  // app/(landing)/page.tsx:54 and lib/seo/pages.ts:19 (absolute title, no template).
  homeTitle: '<title>stem-loops: play along with any song, stem by stem</title>',
  // app/(landing)/page.tsx:87 (the hero h1, two spans).
  homeH1: ['<span class="h1-line">Paste a song.</span>', '<span class="h1-line">Play along.</span>'],
  // lib/seo/pages.ts:31 + app/pricing/page.tsx:160.
  pricingTitle: TITLE('Pricing'),
  pricingH1: '<h1 class="pr-h1">Pricing</h1>',
  // app/pricing/page.tsx:164: the FALLBACK-catalog banner (DB unreachable). Its presence is a FAIL.
  pricingDegraded: 'live plan data is temporarily unavailable',
  // app/login/page.tsx:4 (title 'Sign in') + components/LoginForm.tsx:356 (Google button).
  loginTitle: TITLE('Sign in'),
  loginGoogle: 'data-testid="login-google"',
  // lib/seo/pages.ts:34/45/42 + the h1 on each page:
  // app/(landing)/help/page.tsx:27, terms/page.tsx:61, privacy/page.tsx:33.
  helpTitle: TITLE('Help'),
  helpH1: '<h1>Help</h1>',
  termsTitle: TITLE('Terms'),
  termsH1: '<h1>Terms</h1>',
  privacyTitle: TITLE('Privacy'),
  privacyH1: '<h1>Privacy</h1>',
  // lib/seo/demo-pages.ts:23: `Play along to ${d.title}` (+ the layout template).
  demoTitlePrefix: 'Play along to ',
  // app/jobs/[id]/JobView.tsx:423: what the player body server-renders before the job loads.
  // Not in app/error.tsx or app/not-found.tsx, so an error page with the right <title> fails.
  demoBody: 'Loading…',
});

// Checkout posture (B-8w "P", #453/#455): checkout stays hidden during the beta.
export const CHECKOUT = Object.freeze({
  // lib/billing/checkout-switch.ts:32 CHECKOUT_DISABLED_LABEL, rendered by
  // app/pricing/page.tsx:218-219 (plan cards) and :262-263 (credit packs).
  label: 'Coming soon — free during the beta',
  testid: 'data-testid="checkout-unavailable"',
  // app/pricing/page.tsx:183 (plan card, aria-label=display_name) and :257 (pack card). The Free
  // card offers "Start free" (:194-196); EVERY other card must carry the testid + label.
  freeCard: 'Free',
  // What /pricing renders for a signed-out visitor ONLY when checkout is enabled.
  // Visible text (comments and tags stripped, so React's "Get <!-- -->Pro" reads "Get Pro"):
  forbiddenText: [
    'Get Pro', //    app/pricing/page.tsx:222-223 `Get {p.display_name}` sign-in link
    'Get Studio', // same line, Studio card
    'Buy credits', // app/pricing/page.tsx:243 (PackBuyButton) and :245-246 (sign-in link)
  ],
  // Raw HTML, inline RSC payload included:
  forbiddenRaw: [
    'return_to=/pricing', //  app/pricing/page.tsx:222 and :245 (the purchase sign-in hrefs)
    '/api/billing/checkout', // app/pricing/page.tsx:211 (BillingButton endpoint prop)
    'Verify you are human to continue to checkout', // components/BillingButton.tsx:169 (hCaptcha)
  ],
  // app/(landing)/terms/page.tsx:79 (checkout off branch, read at build).
  termsBeta: 'aren’t on sale during the beta',
});

// Private APIs that a signed-out GET must refuse. (GET /api/jobs and GET /api/users/me have no
// GET handler at main, so they answer 405 and prove nothing about auth; these three do.)
// Exactly HTTP 401 with the app's own JSON refusal: a 403 or an HTML 401 from an edge, a WAF or
// Vercel deployment protection is not the app's auth answering, so it FAILs.
export const PRIVATE_APIS = Object.freeze([
  { path: '/api/library', field: 'error_code', code: 'AUTH_REQUIRED' }, //              app/api/library/route.ts:81-85
  { path: '/api/billing/credits/balance', field: 'code', code: 'UNAUTHENTICATED' }, // app/api/billing/credits/balance/route.ts:44-48
  { path: '/api/set-lists', field: 'error_code', code: 'AUTH_REQUIRED' }, //            app/api/set-lists/route.ts:35 (fail() helper)
]);

// app/api/jobs/[id]/route.ts:30-31: stripped from a demo job read by anyone but its owner.
export const DEMO_OWNER_ONLY_JOB_FIELDS = Object.freeze(['upload_r2_key', 'original_filename', 'youtube_url']);
export const DEMO_OWNER_ONLY_LOOP_FIELDS = Object.freeze(['r2_key', 'filename']);

export const NO_SHA_REASON =
  'production web exposes no git SHA (no build-id meta, SHA header or health route in apps/web; the apps ' +
  'freeze forbids adding one). Map the SHA to its Vercel deployment id and pass EXPECT_DPL (README).';

// Vercel deployment id on Next asset URLs (`/_next/static/...?dpl=dpl_...`), and the Next buildId
// in the RSC payload (`"buildId":"..."`, escaped inside the inline script). The buildId is printed
// for the record only; the dpl id is the one compared.
const DPL_RE = /[?&]dpl=(dpl_[A-Za-z0-9]+)/g;
const BUILD_ID_RE = /\\?"buildId\\?":\\?"([A-Za-z0-9_-]+)\\?"/;
export const DPL_SHAPE = /^dpl_[A-Za-z0-9]+$/;

// ------------------------------------------------------------------ helpers
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
export const textOf = (html) =>
  stripComments(html).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const visibleHtml = (html) => stripComments(html).replace(/<script[\s\S]*?<\/script>/g, ' ');
/** Remote text goes to a terminal: drop control characters (ESC sequences and the like). */
export const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
const decode = (s) =>
  s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function normBase(raw) {
  const s = (raw || DEFAULT_BASE).trim().replace(/\/+$/, '');
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.pathname !== '/' && u.pathname !== '') return null; // a base, not a page
  return `${u.protocol}//${u.host}`;
}

class CheckError extends Error {}
const must = (cond, msg) => { if (!cond) throw new CheckError(msg); };

/**
 * Run every check. Pure apart from the GETs: returns { results, code } and prints only through
 * `log`. Options default to the environment so the CLI and the tests share one path.
 */
export async function runSmoke({
  base = normBase(process.env.SMOKE_BASE_URL),
  expectSha = process.env.EXPECT_SHA || '',
  expectDpl = process.env.EXPECT_DPL || '',
  timeoutMs = process.env.SMOKE_TIMEOUT_MS ? Number(process.env.SMOKE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
  deadlineMs = process.env.SMOKE_DEADLINE_MS ? Number(process.env.SMOKE_DEADLINE_MS) : DEFAULT_DEADLINE_MS,
  retryDelayMs = 500,
  log = console.log,
  // Test seam: the check list. Production always runs the full list (null).
  only = null,
} = {}) {
  const results = [];
  const configError = (why) => {
    // The rejected value is NOT echoed: a URL with userinfo would land in the log.
    log(`FAIL  config: ${why}`);
    return { results: [{ name: 'config', status: 'FAIL', detail: why }], code: 2 };
  };
  if (!base) return configError('SMOKE_BASE_URL is not an http(s) origin (scheme://host[:port] only)');
  if (expectDpl && !DPL_SHAPE.test(expectDpl)) return configError('EXPECT_DPL is not a Vercel deployment id (dpl_...)');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
    return configError(`SMOKE_TIMEOUT_MS must be an integer 1..${MAX_TIMEOUT_MS}`);
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS)
    return configError(`SMOKE_DEADLINE_MS must be an integer 1..${MAX_DEADLINE_MS}`);
  // `only` is a list of check-name prefixes (tests only; no env var reaches it).
  const want = (name) => !only || only.some((o) => name.startsWith(o));
  const t0 = Date.now();
  const remaining = () => deadlineMs - (Date.now() - t0);
  let requests = 0;

  /** The ONLY network call. GET, no credential, redirects not followed (a 3xx is reported). */
  const bust = `smoke=${Date.now()}`;
  /** HTML pages get a cache-busting query (see the header note on what it does not achieve). */
  const getHtml = (path) => get(`${path}${path.includes('?') ? '&' : '?'}${bust}`, path);
  async function get(path, label = path) {
    const url = `${base}${path}`;
    path = label;
    for (let attempt = 1; ; attempt++) {
      const budget = Math.min(timeoutMs, remaining());
      if (budget <= 0) throw new CheckError('overall deadline exceeded before request');
      requests++;
      try {
        const res = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': 'stem-loops-prod-web-smoke/1 (read-only)', Accept: '*/*' },
          signal: AbortSignal.timeout(budget),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, headers: res.headers, text, json, location: clean(res.headers.get('location') || '') };
      } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
          throw new CheckError(`GET ${path}: timed out after ${budget} ms (not retried)`);
        }
        const why = clean(e?.cause?.code || e?.cause?.message || e?.message || String(e));
        if (attempt >= 2) throw new CheckError(`GET ${path}: network error after 1 retry: ${why}`);
        log(`      (network error on GET ${path}: ${why}; retrying once)`);
        await new Promise((r) => setTimeout(r, Math.min(retryDelayMs, Math.max(0, remaining()))));
      }
    }
  }

  const expect200 = (r, path) =>
    must(r.status === 200, `GET ${path}: HTTP ${r.status}${r.location ? ` -> ${r.location}` : ''}, expected 200`);

  async function check(name, fn) {
    name = clean(name);
    if (remaining() <= 0) {
      results.push({ name, status: 'FAIL', detail: 'overall deadline exceeded' });
      log(`FAIL  ${name}: overall deadline exceeded`);
      return;
    }
    try {
      const out = await fn();
      const status = out?.skip ? 'SKIP' : 'PASS';
      const detail = clean(out?.skip ?? out ?? 'ok');
      results.push({ name, status, detail });
      log(`${status}  ${name}: ${detail}`);
    } catch (e) {
      const detail = clean(e instanceof CheckError ? e.message : `unexpected error: ${e?.stack || e}`);
      results.push({ name, status: 'FAIL', detail });
      log(`FAIL  ${name}: ${detail}`);
    }
  }

  log(`stem-loops production web smoke (read-only GETs)\n  target: ${base}\n  expect: ${expectDpl || '(EXPECT_DPL unset: build identity NOT verified)'}${expectSha ? ` / sha ${clean(expectSha)}` : ''}\n`);

  // Every HTML page's deployment id(s), for the build-identity check.
  const builds = []; // { path, dpls: string[], buildId }
  const recordBuild = (path, r) => {
    const dpls = [...new Set([...r.text.matchAll(DPL_RE)].map((m) => m[1]))];
    builds.push({ path, dpls, buildId: (r.text.match(BUILD_ID_RE) || [])[1] || null });
  };

  // Simple public pages: 200 + title + one structural marker.
  let homeRes = null;
  // `title` is matched in the raw HTML; every `body` marker must be in the RENDERED markup (comments
  // and <script> payloads removed), so a marker that only survives inside the RSC payload, or a
  // right <title> over an error body, FAILs.
  const page = (name, path, title, body, keep) =>
    want(name) && check(name, async () => {
      must(body.length > 0, 'internal: a page check needs a body marker');
      const r = await getHtml(path);
      expect200(r, path);
      recordBuild(path, r);
      const vis = visibleHtml(r.text);
      const missing = [...(r.text.includes(title) ? [] : [title]), ...body.filter((m) => !vis.includes(m))];
      must(!missing.length, `GET ${path}: 200 but missing marker(s): ${missing.map((m) => JSON.stringify(m)).join(', ')}`);
      if (keep) keep(r);
      return `200, title + ${body.length} body marker(s)`;
    });

  await page('home /', '/', MARKERS.homeTitle, MARKERS.homeH1, (r) => { homeRes = r; });

  if (want('security headers (home)')) await check('security headers (home)', async () => {
    must(homeRes, 'home page not fetched');
    const h = homeRes.headers;
    const bad = [];
    if ((h.get('x-frame-options') || '').toUpperCase() !== 'DENY') bad.push(`x-frame-options=${h.get('x-frame-options')}`);
    if ((h.get('x-content-type-options') || '').toLowerCase() !== 'nosniff') bad.push(`x-content-type-options=${h.get('x-content-type-options')}`);
    // src/middleware.ts:146,155-156
    if (!(h.get('content-security-policy') || '').includes("frame-ancestors 'none'")) bad.push("CSP lacks frame-ancestors 'none'");
    must(!bad.length, bad.join('; '));
    return "X-Frame-Options DENY, nosniff, CSP frame-ancestors 'none'";
  });

  let pricing = null;
  if (want('pricing /pricing')) await check('pricing /pricing', async () => {
    const r = await getHtml('/pricing');
    expect200(r, '/pricing');
    recordBuild('/pricing', r);
    must(r.text.includes(MARKERS.pricingTitle), `missing ${JSON.stringify(MARKERS.pricingTitle)}`);
    const t = textOf(r.text);
    must(visibleHtml(r.text).includes(MARKERS.pricingH1), `missing ${JSON.stringify(MARKERS.pricingH1)}`);
    must(!t.includes(MARKERS.pricingDegraded), `degraded banner shown: "${MARKERS.pricingDegraded}" (DB unreachable, FALLBACK catalog)`);
    pricing = r;
    return '200, title + h1, no degraded banner';
  });

  if (want('checkout hidden (/pricing)')) await check('checkout hidden (/pricing)', async () => {
    must(pricing, '/pricing not fetched');
    const raw = pricing.text;
    const t = textOf(raw);
    const cards = [...visibleHtml(raw).matchAll(/<section\b[^>]*\baria-label="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)]
      .map((m) => ({ label: decode(m[1]), body: m[2] }))
      .filter((c) => c.label !== CHECKOUT.freeCard);
    must(t.includes(CHECKOUT.label), `missing beta label ${JSON.stringify(CHECKOUT.label)}`);
    must(cards.length > 0, 'no paid plan or credit-pack card found');
    const open = cards.filter((c) => !c.body.includes(CHECKOUT.testid) || !textOf(c.body).includes(CHECKOUT.label));
    must(!open.length, `card(s) without ${CHECKOUT.testid} + label: ${open.map((c) => JSON.stringify(c.label)).join(', ')}`);
    const n = cards.length;
    const seen = [
      ...CHECKOUT.forbiddenText.filter((s) => t.includes(s)),
      ...CHECKOUT.forbiddenRaw.filter((s) => raw.includes(s)),
    ];
    must(!seen.length, `checkout-enabled markup present: ${seen.map((s) => JSON.stringify(s)).join(', ')}`);
    return `beta label on all ${n} paid/pack card(s); none of ${CHECKOUT.forbiddenText.length + CHECKOUT.forbiddenRaw.length} buy markers`;
  });

  await page('login /login', '/login', MARKERS.loginTitle, [MARKERS.loginGoogle]);
  await page('help /help', '/help', MARKERS.helpTitle, [MARKERS.helpH1]);
  await page('terms /terms', '/terms', MARKERS.termsTitle, [MARKERS.termsH1, CHECKOUT.termsBeta]);
  await page('privacy /privacy', '/privacy', MARKERS.privacyTitle, [MARKERS.privacyH1]);

  let demos = [];
  if (want('demo list /api/demos')) await check('demo list /api/demos', async () => {
    const r = await get('/api/demos'); // app/api/demos/route.ts:21 -> { demos: [...] }
    expect200(r, '/api/demos');
    const list = r.json?.demos;
    must(Array.isArray(list) && list.length > 0, `expected non-empty { demos: [...] }, got ${r.text.slice(0, 120)}`);
    const bad = list.filter((d) => typeof d?.slug !== 'string' || !d.slug || typeof d?.id !== 'string' || typeof d?.title !== 'string');
    must(!bad.length, `${bad.length} demo(s) without id, slug and title`);
    must(list.length <= MAX_DEMOS, `${list.length} demos, more than the ${MAX_DEMOS} this smoke bounds itself to`);
    demos = list;
    return `${list.length} demo(s): ${list.map((d) => d.slug).join(', ')}`;
  });

  // Every demo, not just the first: a 404 or a leak on any one of them FAILs.
  for (const demo of demos) {
    const path = `/demo/${encodeURIComponent(demo.slug)}`;
    if (want('demo page')) await check(`demo page signed out ${path}`, async () => {
      const r = await getHtml(path);
      expect200(r, path);
      recordBuild(path, r);
      const m = r.text.match(/<title>([^<]*)<\/title>/);
      const wantTitle = `${MARKERS.demoTitlePrefix}${demo.title} · stem-loops`;
      must(m && decode(m[1]) === wantTitle, `title ${JSON.stringify(m ? decode(m[1]) : null)}, expected ${JSON.stringify(wantTitle)}`);
      must(textOf(r.text).includes(MARKERS.demoBody), `body lacks the player's ${JSON.stringify(MARKERS.demoBody)} (error page?)`);
      return `200, "${wantTitle}" + player body`;
    });

    const api = `/api/jobs/${encodeURIComponent(demo.id)}`;
    if (want('demo job API')) await check(`demo job API signed out ${demo.slug}`, async () => {
      const r = await get(api);
      expect200(r, api);
      const j = r.json;
      must(j && j.status === 'done' && j.is_demo === true, `expected status=done is_demo=true, got ${r.text.slice(0, 120)}`);
      must(Array.isArray(j.loops) && j.loops.length > 0, 'expected a non-empty loops array (the leak check would be vacuous)');
      const leaked = DEMO_OWNER_ONLY_JOB_FIELDS.filter((f) => f in j);
      for (const l of j.loops) {
        must(l && typeof l === 'object', 'a loops[] entry is not an object');
        for (const f of DEMO_OWNER_ONLY_LOOP_FIELDS) if (f in l) leaked.push(`loops[].${f}`);
        if (l.signed_url !== null && l.signed_url !== undefined) leaked.push('loops[].signed_url');
      }
      must(!leaked.length, `owner-only fields in the public demo view: ${[...new Set(leaked)].join(', ')}`);
      return `200 done, ${j.loops.length} loop(s), no owner-only fields or signed URLs`;
    });
  }

  for (const { path, field, code } of PRIVATE_APIS) {
    if (want('private API')) await check(`private API refuses signed out ${path}`, async () => {
      const r = await get(path);
      must(r.status === 401, `GET ${path}: HTTP ${r.status}, expected exactly 401`);
      must(r.json && r.json[field] === code, `GET ${path}: 401 but not the app's refusal (want JSON ${field}=${code}), got ${r.text.slice(0, 80)}`);
      return `HTTP 401 ${field}=${code}`;
    });
  }

  // Build identity: every HTML page must carry exactly one deployment id, the same one.
  let observedDpl = null;
  if (want('build identity')) await check('build identity (dpl)', async () => {
    must(builds.length > 0, 'no HTML page was fetched, nothing to read a deployment id from');
    const none = builds.filter((b) => b.dpls.length === 0).map((b) => b.path);
    must(!none.length, `no dpl= deployment id on: ${none.join(', ')}`);
    const multi = builds.filter((b) => b.dpls.length > 1).map((b) => `${b.path} [${b.dpls.join(' ')}]`);
    must(!multi.length, `more than one deployment id on: ${multi.join('; ')}`);
    const ids = [...new Set(builds.map((b) => b.dpls[0]))];
    must(ids.length === 1, `pages disagree on the deployment: ${builds.map((b) => `${b.path}=${b.dpls[0]}`).join(', ')}`);
    observedDpl = ids[0];
    const bid = [...new Set(builds.map((b) => b.buildId).filter(Boolean))].join(',') || '(none seen)';
    if (expectDpl) {
      must(observedDpl === expectDpl, `serving ${observedDpl}, expected ${expectDpl} (stale or failed build?)`);
      return `all ${builds.length} page(s) on ${observedDpl} = EXPECT_DPL (buildId ${bid})`;
    }
    return `all ${builds.length} page(s) on ${observedDpl} (buildId ${bid}); EXPECT_DPL unset, so NOT compared`;
  });

  if (expectSha && want('deployed SHA')) {
    // Searched apps/web at main: no build-id <meta>, no SHA response header, no /api/health or
    // /api/version route, next.config.js sets no env/generateBuildId. The dpl id is the build check.
    await check(`deployed SHA = ${expectSha.slice(0, 12)}`, async () => ({ skip: NO_SHA_REASON }));
  }

  const c = (st) => results.filter((x) => x.status === st).length;
  if (results.length === 0) {
    results.push({ name: 'checks ran', status: 'FAIL', detail: 'zero checks ran' });
    log('FAIL  checks ran: zero checks ran');
  }
  const verified = expectDpl && observedDpl === expectDpl;
  log(`\nTotal: ${c('PASS')} PASS, ${c('FAIL')} FAIL, ${c('SKIP')} SKIP; ${requests} GET(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s` +
    `; build ${verified ? `VERIFIED (${expectDpl})` : expectDpl ? 'NOT verified (EXPECT_DPL mismatch or unread)' : 'NOT verified (set EXPECT_DPL)'}`);
  return { results, code: c('FAIL') ? 1 : 0 };
}

/** True when this module is the process entry point, through symlinks too (R1 B1). */
export function isEntry(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntry()) {
  const { code } = await runSmoke();
  process.exit(code);
}
