// Tests for scripts/smoke_prod_web.mjs (J1a; Jon L9; R1 fixes for PR #518).
//
//   node --test scripts/smoke_prod_web.test.mjs
//
// No network: every request goes to a stub HTTP server on 127.0.0.1 that plays production web.
// Most tests call runSmoke() in-process with `base` pointed at the stub; the subprocess tests run
// the REAL script (also through a symlink) to prove the entry point, SMOKE_BASE_URL and exit codes.
// Not run by CI yet (no workflow runs scripts/*.test.mjs); run it by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHECKOUT, MARKERS, NO_SHA_REASON, PRIVATE_APIS, clean, isEntry, normBase, runSmoke } from './smoke_prod_web.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'smoke_prod_web.mjs');
const DPL = 'dpl_TestDeploy123';
const DEMOS = [
  { id: '9c5ba587-b83a-4d70-85ed-24b6ee75b869', slug: 'lucky-ticket', title: 'Lucky Ticket' },
  { id: '32f99278-2fe3-477b-9b67-effffc60066d', slug: 'im-asking-you', title: 'I’m Asking You' },
  { id: '3d43d743-92af-48e4-8298-031156434d2e', slug: 'offline', title: 'Offline' },
];

const html = (title, body, dpl = DPL) =>
  `<!DOCTYPE html><html><head><title>${title}</title>` +
  `<script src="/_next/static/chunks/main.js?dpl=${dpl}" async=""></script></head><body>${body}` +
  `<script>self.__next_f.push([1,"{\\"buildId\\":\\"TestBuild_1\\"}"])</script></body></html>`;
const SEC_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'; object-src 'none'",
};
const HOME_BODY = '<h1 id="h1"><span class="h1-line">Paste a song.</span> <span class="h1-line">Play along.</span></h1>';
const HOME = html('stem-loops: play along with any song, stem by stem', HOME_BODY);
const card = (label, inner) => `<section class="pr-card" aria-label="${label}">${inner}</section>`;
const hidden = `<p class="pr-cta pr-cta-current" data-testid="checkout-unavailable">${CHECKOUT.label}</p>`;
const PRICING_BODY =
  '<h1 class="pr-h1">Pricing</h1>' +
  card('Free', '<a href="/">Start free</a>') +
  card('Pro', `<p>$4.99 CAD</p>${hidden}`) +
  card('Studio', `<p>$12 CAD</p>${hidden}`) +
  card('20 credits for $5 CAD', hidden);
const PRICING_OK = html('Pricing · stem-loops', PRICING_BODY);
const json = (o, status = 200) => [status, { 'content-type': 'application/json' }, JSON.stringify(o)];
const demoJob = (d, extra = {}) => ({ id: d.id, status: 'done', is_demo: true, loops: [{ id: 1, stem: 'bass', signed_url: null }], ...extra });

/** The healthy site. Each value: [status, headers, body] or a function (req, res) => void. Paths match without the query. */
function healthyRoutes() {
  const r = {
    '/': [200, SEC_HEADERS, HOME],
    '/pricing': [200, {}, PRICING_OK],
    '/login': [200, {}, html('Sign in · stem-loops', '<h1>Sign in</h1><button data-testid="login-google">Continue with Google</button>')],
    '/help': [200, {}, html('Help · stem-loops', '<h1>Help</h1>')],
    '/terms': [200, {}, html('Terms · stem-loops', `<h1>Terms</h1><p>but they ${CHECKOUT.termsBeta}.</p>`)],
    '/privacy': [200, {}, html('Privacy · stem-loops', '<h1>Privacy</h1>')],
    '/api/demos': json({ demos: DEMOS.map((d) => ({ ...d, artist: 'x', bpm: 100 })) }),
    '/api/library': json({ error_code: 'AUTH_REQUIRED', songs: [] }, 401),
    '/api/billing/credits/balance': json({ error: 'Sign in to view credits.', code: 'UNAUTHENTICATED' }, 401),
    '/api/set-lists': json({ error_code: 'AUTH_REQUIRED' }, 401),
  };
  for (const d of DEMOS) {
    r[`/demo/${d.slug}`] = [200, {}, html(`Play along to ${d.title} · stem-loops`, '<main><a href="/">Start a new song →</a><p>Loading…</p></main>')];
    r[`/api/jobs/${d.id}`] = json(demoJob(d));
  }
  return r;
}

async function withStub(overrides, fn) {
  const routes = { ...healthyRoutes(), ...overrides };
  const seen = []; // { method, url, headers, bodyBytes }
  const sockets = new Set();
  const server = createServer((req, res) => {
    let bodyBytes = 0;
    req.on('data', (c) => (bodyBytes += c.length));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, bodyBytes });
      const r = routes[req.url.split('?')[0]];
      if (typeof r === 'function') return r(req, res);
      if (!r) { res.writeHead(404); return res.end('not found'); }
      const [status, headers, body] = r;
      res.writeHead(status, headers);
      res.end(body);
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, seen);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
}

const quiet = () => {};
const run = (base, opts = {}) =>
  runSmoke({ base, expectSha: '', expectDpl: '', timeoutMs: 2000, deadlineMs: 20_000, retryDelayMs: 10, log: quiet, ...opts });
const byName = (results, prefix) => results.find((r) => r.name.startsWith(prefix));
const failsOnly = (results) => results.filter((r) => r.status === 'FAIL').map((r) => r.name);
// 8 page/posture checks (home, headers, pricing, checkout, login, help, terms, privacy), demo list,
// 2 per demo, the private APIs, build identity.
const N_CHECKS = 8 + 1 + 2 * DEMOS.length + PRIVATE_APIS.length + 1;

// -------------------------------------------------------------------- pass
test('healthy site: every check PASSes, exit 0, all demos checked', async () => {
  await withStub({}, async (base) => {
    const { results, code } = await run(base);
    assert.equal(code, 0, JSON.stringify(results, null, 1));
    assert.equal(results.length, N_CHECKS);
    assert.ok(results.every((r) => r.status === 'PASS'));
    for (const d of DEMOS) {
      assert.equal(byName(results, `demo page signed out /demo/${d.slug}`).status, 'PASS');
      assert.equal(byName(results, `demo job API signed out ${d.slug}`).status, 'PASS');
    }
  });
});

// ------------------------------------------------------------ read-only pins (M-11)
test('read-only: GET only, no Cookie, no Authorization, no body, no credential-ish header', async () => {
  await withStub({}, async (base, seen) => {
    await run(base);
    assert.ok(seen.length >= N_CHECKS - 4, `only ${seen.length} requests`);
    for (const r of seen) {
      assert.equal(r.method, 'GET', r.url);
      assert.equal(r.bodyBytes, 0, r.url);
      assert.equal(r.headers.cookie, undefined, `Cookie sent on ${r.url}`);
      assert.equal(r.headers.authorization, undefined, `Authorization sent on ${r.url}`);
      assert.equal(r.headers['content-length'] ?? '0', '0', r.url);
      assert.equal(r.headers['transfer-encoding'], undefined, r.url);
      const extra = Object.keys(r.headers).filter((h) => /cookie|auth|token|apikey|bypass|secret|key/i.test(h));
      assert.deepEqual(extra, [], `${r.url}: ${extra}`);
    }
  });
});

test('HTML GETs carry the cache-busting query; API GETs do not', async () => {
  await withStub({}, async (base, seen) => {
    await run(base);
    const urls = seen.map((r) => r.url);
    for (const p of ['/', '/pricing', '/login', '/help', '/terms', '/privacy', '/demo/offline']) {
      assert.ok(urls.some((u) => u.startsWith(`${p}?smoke=`) && /^\d+$/.test(u.slice(p.length + 7))), `${p}: ${urls}`);
    }
    assert.ok(urls.includes('/api/demos') && urls.includes('/api/library'));
  });
});

// --------------------------------------------------------- each failure kind
const replaceIn = (route, a, b) => {
  const r = healthyRoutes()[route];
  assert.ok(r[2].includes(a), `fixture ${route} lacks ${a}`);
  return { [route]: [r[0], r[1], r[2].replace(a, b)] };
};
const homeHeaders = (h) => ({ '/': [200, h, HOME] });
const without = (o, k) => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));
const D0 = DEMOS[0];
const D2 = DEMOS[2];
const H1P = '<h1 class="pr-h1">Pricing</h1>';
const HOME_TITLE = 'stem-loops: play along with any song, stem by stem';

const failCases = [
  ['page non-200', { '/help': [500, {}, 'boom'] }, 'help /help', /HTTP 500/],
  ['page redirect is not followed', { '/login': [307, { location: '/elsewhere' }, ''] }, 'login /login', /HTTP 307 -> \/elsewhere/],
  ['page missing h1 marker', replaceIn('/privacy', '<h1>Privacy</h1>', '<h1>Privcy</h1>'), 'privacy /privacy', /missing marker.*<h1>Privacy<\/h1>/],
  ['page right title, wrong body (help)', replaceIn('/help', '<h1>Help</h1>', '<h1>Application error</h1>'), 'help /help', /<h1>Help<\/h1>/],
  ['terms right title, wrong h1', replaceIn('/terms', '<h1>Terms</h1>', '<h1>Oops</h1>'), 'terms /terms', /<h1>Terms<\/h1>/],
  ['home wrong title', replaceIn('/', `<title>${HOME_TITLE}</title>`, '<title>Oops</title>'), 'home /', /missing marker.*<title>stem-loops/],
  ['home h1 only inside a <script> payload', { '/': [200, SEC_HEADERS, html(HOME_TITLE, `<h1>x</h1><script>var s='${HOME_BODY}'</script>`)] }, 'home /', /Paste a song/],
  ['home h1 only inside an HTML comment', { '/': [200, SEC_HEADERS, html(HOME_TITLE, `<!-- ${HOME_BODY} --><h1>x</h1>`)] }, 'home /', /Paste a song/],
  ['login lost the Google button', replaceIn('/login', 'data-testid="login-google"', 'data-testid="login-x"'), 'login /login', /login-google/],
  ['login wrong title', replaceIn('/login', '<title>Sign in · stem-loops</title>', '<title>Sign in</title>'), 'login /login', /Sign in · stem-loops/],
  ['security: X-Frame-Options missing', homeHeaders(without(SEC_HEADERS, 'x-frame-options')), 'security headers', /x-frame-options=null/],
  ['security: nosniff missing', homeHeaders(without(SEC_HEADERS, 'x-content-type-options')), 'security headers', /x-content-type-options=null/],
  ['security: nosniff wrong value', homeHeaders({ ...SEC_HEADERS, 'x-content-type-options': 'sniff' }), 'security headers', /x-content-type-options=sniff/],
  ['security: CSP missing', homeHeaders(without(SEC_HEADERS, 'content-security-policy')), 'security headers', /CSP lacks frame-ancestors/],
  ['security: CSP allows framing', homeHeaders({ ...SEC_HEADERS, 'content-security-policy': "default-src 'self'; frame-ancestors *" }), 'security headers', /CSP lacks frame-ancestors/],
  ['pricing wrong title', replaceIn('/pricing', '<title>Pricing · stem-loops</title>', '<title>Prices</title>'), 'pricing /pricing', /Pricing · stem-loops/],
  ['pricing h1 missing', replaceIn('/pricing', H1P, '<h1>Oops</h1>'), 'pricing /pricing', /pr-h1/],
  ['pricing degraded banner', replaceIn('/pricing', H1P, `${H1P}<p>Showing standard pricing; ${MARKERS.pricingDegraded}.</p>`), 'pricing /pricing', /degraded banner/],
  ['checkout label gone', { '/pricing': [200, {}, PRICING_OK.replaceAll(CHECKOUT.label, 'Soon')] }, 'checkout hidden', /missing beta label/],
  ['checkout: one card lost the testid (partial enable)', replaceIn('/pricing', `<p>$12 CAD</p>${hidden}`, `<p>$12 CAD</p><p>${CHECKOUT.label}</p>`),
    'checkout hidden', /without data-testid="checkout-unavailable" \+ label: "Studio"/],
  ['checkout: one card has the testid but no label', replaceIn('/pricing', `<p>$12 CAD</p>${hidden}`, '<p>$12 CAD</p><p data-testid="checkout-unavailable">Buy</p>'),
    'checkout hidden', /"Studio"/],
  ['checkout: no paid cards at all', { '/pricing': [200, {}, html('Pricing · stem-loops', `${H1P}${card('Free', 'Start free')}<p>${CHECKOUT.label}</p>`)] },
    'checkout hidden', /no paid plan or credit-pack card/],
  ['checkout enabled: sign-in buy link (React comment split)', replaceIn('/pricing', H1P, `${H1P}<a href="/login?return_to=/pricing">Get <!-- -->Pro</a>`),
    'checkout hidden', /"Get Pro".*"return_to=\/pricing"/],
  ['checkout enabled: Get Studio', replaceIn('/pricing', H1P, `${H1P}<a>Get Studio</a>`), 'checkout hidden', /"Get Studio"/],
  ['checkout enabled: Buy credits', replaceIn('/pricing', H1P, `${H1P}<a>Buy credits</a>`), 'checkout hidden', /"Buy credits"/],
  ['checkout enabled: endpoint in RSC payload', replaceIn('/pricing', 'TestBuild_1\\"}', 'TestBuild_1\\",\\"endpoint\\":\\"/api/billing/checkout\\"}'),
    'checkout hidden', /"\/api\/billing\/checkout"/],
  ['checkout enabled: hCaptcha label', replaceIn('/pricing', H1P, `${H1P}<div aria-label="Verify you are human to continue to checkout"></div>`),
    'checkout hidden', /Verify you are human/],
  ['terms lost beta copy', replaceIn('/terms', CHECKOUT.termsBeta, 'are on sale'), 'terms /terms', /aren’t on sale/],
  ['demo list empty', { '/api/demos': [200, {}, '{"demos":[]}'] }, 'demo list', /non-empty/],
  ['demo list entry without slug', { '/api/demos': json({ demos: [{ id: D0.id, title: 'x' }] }) }, 'demo list', /without id, slug and title/],
  ['demo page (third demo) 404', { [`/demo/${D2.slug}`]: [404, {}, 'nf'] }, `demo page signed out /demo/${D2.slug}`, /HTTP 404/],
  ['demo page wrong title', { [`/demo/${D0.slug}`]: [200, {}, html('Play along: demo song', '<p>Loading…</p>')] }, `demo page signed out /demo/${D0.slug}`,
    /expected "Play along to Lucky Ticket · stem-loops"/],
  ['demo page title must match exactly', { [`/demo/${D0.slug}`]: [200, {}, html('Play along to Lucky Ticket (old) · stem-loops', '<p>Loading…</p>')] },
    `demo page signed out /demo/${D0.slug}`, /expected/],
  ['demo page right title, error body', { [`/demo/${D0.slug}`]: [200, {}, html('Play along to Lucky Ticket · stem-loops', '<h1>Application error</h1><a>Start a new song →</a>')] },
    `demo page signed out /demo/${D0.slug}`, /Loading…/],
  ['demo job (third demo) leaks owner-only fields', { [`/api/jobs/${D2.id}`]: json(demoJob(D2, { youtube_url: 'x', loops: [{ r2_key: 'k', signed_url: 'https://s' }] })) },
    `demo job API signed out ${D2.slug}`, /youtube_url, loops\[\]\.r2_key, loops\[\]\.signed_url/],
  ['demo job leaks upload_r2_key', { [`/api/jobs/${D0.id}`]: json(demoJob(D0, { upload_r2_key: 'k' })) }, `demo job API signed out ${D0.slug}`, /upload_r2_key/],
  ['demo job leaks original_filename', { [`/api/jobs/${D0.id}`]: json(demoJob(D0, { original_filename: 'a.wav' })) }, `demo job API signed out ${D0.slug}`, /original_filename/],
  ['demo job leaks loop filename', { [`/api/jobs/${D0.id}`]: json(demoJob(D0, { loops: [{ filename: 'f.wav', signed_url: null }] })) },
    `demo job API signed out ${D0.slug}`, /loops\[\]\.filename/],
  ['demo job not a demo', { [`/api/jobs/${D0.id}`]: json(demoJob(D0, { is_demo: false })) }, `demo job API signed out ${D0.slug}`, /is_demo=true/],
  ['demo job not done', { [`/api/jobs/${D0.id}`]: json(demoJob(D0, { status: 'queued' })) }, `demo job API signed out ${D0.slug}`, /status=done/],
  ['demo job loops not an array (vacuous)', { [`/api/jobs/${D0.id}`]: json(demoJob(D0, { loops: undefined, stems: [{ r2_key: 'k' }] })) },
    `demo job API signed out ${D0.slug}`, /non-empty loops/],
  ['demo job loops empty (vacuous)', { [`/api/jobs/${D0.id}`]: json(demoJob(D0, { loops: [] })) }, `demo job API signed out ${D0.slug}`, /non-empty loops/],
  ['private API answers 200', { '/api/library': [200, {}, '{"songs":[]}'] }, 'private API refuses signed out /api/library', /HTTP 200, expected exactly 401/],
  ['private API answers 403 (not the app)', { '/api/billing/credits/balance': [403, {}, '<html>blocked</html>'] },
    'private API refuses signed out /api/billing/credits/balance', /expected exactly 401/],
  ['private API answers HTML 401 (edge, not the app)', { '/api/set-lists': [401, {}, '<html>Authentication Required</html>'] },
    'private API refuses signed out /api/set-lists', /not the app's refusal/],
  ['private API 401 with the wrong code', { '/api/library': json({ error_code: 'NOPE' }, 401) }, 'private API refuses signed out /api/library', /error_code=AUTH_REQUIRED/],
  ['private API 401 with the code in the wrong field', { '/api/billing/credits/balance': json({ error_code: 'UNAUTHENTICATED' }, 401) },
    'private API refuses signed out /api/billing/credits/balance', /code=UNAUTHENTICATED/],
  ['private API answers 500', { '/api/set-lists': [500, {}, 'x'] }, 'private API refuses signed out /api/set-lists', /HTTP 500/],
  ['build: a page carries no dpl id', { '/help': [200, {}, html('Help · stem-loops', '<h1>Help</h1>').replace(/\?dpl=[A-Za-z0-9_]+/, '')] },
    'build identity', /no dpl= deployment id on: \/help/],
  ['build: pages disagree', { '/terms': [200, {}, html('Terms · stem-loops', `<h1>Terms</h1><p>${CHECKOUT.termsBeta}</p>`, 'dpl_Other9')] },
    'build identity', /pages disagree.*\/terms=dpl_Other9/],
  ['build: two ids on one page', { '/privacy': [200, {}, html('Privacy · stem-loops', '<h1>Privacy</h1><img src="/a.png?dpl=dpl_Other9">')] },
    'build identity', /more than one deployment id on: \/privacy/],
];

for (const [label, override, check, re] of failCases) {
  test(`FAIL: ${label}`, async () => {
    await withStub(override, async (base) => {
      const { results, code } = await run(base);
      assert.equal(code, 1, JSON.stringify(results.filter((r) => r.status !== 'PASS')));
      const r = byName(results, check);
      assert.ok(r, `no result named ${check}`);
      assert.equal(r.status, 'FAIL', JSON.stringify(r));
      assert.match(r.detail, re);
    });
  });
}

test('demo list down: FAILs (no crash), and no per-demo check pretends to pass', async () => {
  await withStub({ '/api/demos': [503, {}, 'down'] }, async (base) => {
    const { results, code } = await run(base);
    assert.equal(code, 1);
    assert.deepEqual(failsOnly(results), ['demo list /api/demos']);
    assert.ok(!results.some((r) => r.name.startsWith('demo page') || r.name.startsWith('demo job')));
  });
});

// ------------------------------------------------------------------ build identity
test('EXPECT_DPL matching every page: PASS and the Total line says VERIFIED', async () => {
  await withStub({}, async (base) => {
    const lines = [];
    const { results, code } = await run(base, { expectDpl: DPL, log: (l) => lines.push(l) });
    assert.equal(code, 0);
    assert.match(byName(results, 'build identity').detail, /all 9 page\(s\) on dpl_TestDeploy123 = EXPECT_DPL/);
    assert.match(lines.at(-1), new RegExp(`build VERIFIED \\(${DPL}\\)`));
  });
});

test('EXPECT_DPL mismatch (stale or failed build): FAIL, exit 1, NOT verified', async () => {
  await withStub({}, async (base) => {
    const lines = [];
    const { results, code } = await run(base, { expectDpl: 'dpl_NewBuild42', log: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.deepEqual(failsOnly(results), ['build identity (dpl)']);
    assert.match(byName(results, 'build identity').detail, /serving dpl_TestDeploy123, expected dpl_NewBuild42/);
    assert.match(lines.at(-1), /build NOT verified \(EXPECT_DPL mismatch/);
  });
});

test('EXPECT_DPL unset: build check PASSes on consistency only and the Total line says NOT verified', async () => {
  await withStub({}, async (base) => {
    const lines = [];
    const { results } = await run(base, { log: (l) => lines.push(l) });
    assert.match(byName(results, 'build identity').detail, /EXPECT_DPL unset, so NOT compared/);
    assert.match(byName(results, 'build identity').detail, /buildId TestBuild_1/);
    assert.match(lines.at(-1), /build NOT verified \(set EXPECT_DPL\)/);
  });
});

test('EXPECT_SHA set: SKIP with the no-SHA reason; exit stays 0; build still NOT verified', async () => {
  await withStub({}, async (base) => {
    const lines = [];
    const { results, code } = await run(base, { expectSha: '75ea4e9abcdef', log: (l) => lines.push(l) });
    assert.equal(code, 0);
    const r = byName(results, 'deployed SHA');
    assert.equal(r.status, 'SKIP');
    assert.equal(r.detail, NO_SHA_REASON);
    assert.match(lines.at(-1), /1 SKIP.*NOT verified/);
  });
});

// ------------------------------------------------------- timeout, retries, deadline
test('timeout: a hung page FAILs after the per-request timeout and is not retried', async () => {
  let hits = 0;
  await withStub({ '/help': () => { hits++; /* never respond */ } }, async (base) => {
    const t = Date.now();
    const { results, code } = await run(base, { timeoutMs: 300 });
    assert.equal(code, 1);
    assert.match(byName(results, 'help').detail, /timed out after 300 ms \(not retried\)/);
    assert.equal(hits, 1);
    assert.deepEqual(failsOnly(results), ['help /help']);
    assert.ok(Date.now() - t < 5000);
  });
});

test('network error: retried once, then PASS', async () => {
  let hits = 0;
  const ok = healthyRoutes()['/privacy'];
  await withStub({ '/privacy': (req, res) => { if (++hits === 1) return req.socket.destroy(); res.writeHead(200); res.end(ok[2]); } }, async (base) => {
    const lines = [];
    const { code } = await run(base, { log: (l) => lines.push(l) });
    assert.equal(code, 0);
    assert.equal(hits, 2);
    assert.ok(lines.some((l) => /network error on GET \/privacy.*retrying once/.test(l)));
  });
});

test('network error twice: FAIL after exactly one retry', async () => {
  let hits = 0;
  await withStub({ '/privacy': (req) => { hits++; req.socket.destroy(); } }, async (base) => {
    const { results } = await run(base);
    assert.equal(hits, 2);
    assert.match(byName(results, 'privacy').detail, /network error after 1 retry/);
  });
});

test('HTTP 5xx is not retried', async () => {
  let hits = 0;
  await withStub({ '/help': (req, res) => { hits++; res.writeHead(502); res.end(); } }, async (base) => {
    await run(base);
    assert.equal(hits, 1);
  });
});

test('overall deadline: later checks FAIL as "overall deadline exceeded"', async () => {
  await withStub({ '/': (req, res) => setTimeout(() => { res.writeHead(200, SEC_HEADERS); res.end('slow'); }, 400) }, async (base) => {
    const t = Date.now();
    const { results, code } = await run(base, { deadlineMs: 300, timeoutMs: 5000 });
    assert.equal(code, 1);
    assert.match(results[0].detail, /timed out after \d+ ms/);
    assert.ok(results.length > 5);
    assert.ok(results.slice(1).every((r) => r.status === 'FAIL' && /deadline/.test(r.detail)), JSON.stringify(results.slice(1, 3)));
    assert.ok(Date.now() - t < 3000);
  });
});

// ------------------------------------------------------------ zero checks, config
test('zero checks ran is itself a FAIL (exit 1), never a silent green', async () => {
  await withStub({}, async (base, seen) => {
    const lines = [];
    const { results, code } = await run(base, { only: [], log: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.deepEqual(results.map((r) => [r.name, r.status]), [['checks ran', 'FAIL']]);
    assert.equal(seen.length, 0);
    assert.ok(lines.some((l) => /zero checks ran/.test(l)));
  });
});

test('build identity with no HTML page fetched FAILs with its own reason', async () => {
  await withStub({}, async (base) => {
    const { results, code } = await run(base, { only: ['build identity'] });
    assert.equal(code, 1);
    assert.deepEqual(results.map((r) => r.name), ['build identity (dpl)']);
    assert.match(results[0].detail, /no HTML page was fetched/);
  });
});

test('more demos than the bound FAILs the demo list instead of fanning out', async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ id: `00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`, slug: `d${i}`, title: `T${i}` }));
  await withStub({ '/api/demos': json({ demos: many }) }, async (base, seen) => {
    const { results } = await run(base);
    assert.match(byName(results, 'demo list').detail, /11 demos, more than the 10/);
    assert.ok(!seen.some((r) => r.url.startsWith('/demo/') || r.url.startsWith('/api/jobs/')));
  });
});

test('config errors exit 2 and never echo the rejected value', async () => {
  for (const opts of [
    { base: null },
    { expectDpl: 'not-a-dpl' },
    { timeoutMs: 1e13 },
    { timeoutMs: 0 },
    { timeoutMs: Number.NaN },
    { deadlineMs: -5 },
    { deadlineMs: 1e9 },
  ]) {
    const lines = [];
    const { code } = await runSmoke({ base: 'http://127.0.0.1:9', log: (l) => lines.push(l), ...opts });
    assert.equal(code, 2, JSON.stringify(opts));
    assert.ok(!lines.join('\n').includes('not-a-dpl'), 'echoed EXPECT_DPL');
  }
});

test('remote text is printed without control characters', async () => {
  assert.equal(clean('a\u001b[31mb\u0007c\n'), 'a?[31mb?c?');
  const evil = [{ id: DEMOS[0].id, slug: 'x\u001b[2J', title: 't' }];
  await withStub({ '/api/demos': json({ demos: evil }) }, async (base) => {
    const lines = [];
    await run(base, { log: (l) => lines.push(l) });
    assert.ok(lines.join('\n').includes('x?[2J'));
    assert.ok(!lines.join('\n').includes('\u001b'), 'ESC reached the log');
  });
});

// ------------------------------------------------------- base URL + subprocess
test('normBase: default, trailing slash, rejects non-http and paths, drops userinfo', () => {
  assert.equal(normBase(undefined), 'https://stem-loops.com');
  assert.equal(normBase('https://x.vercel.app/'), 'https://x.vercel.app');
  assert.equal(normBase('http://127.0.0.1:9/'), 'http://127.0.0.1:9');
  assert.equal(normBase('https://u:p@x.com'), 'https://x.com');
  assert.equal(normBase('ftp://x'), null);
  assert.equal(normBase('not a url'), null);
  assert.equal(normBase('https://x.com/pricing'), null);
});

function runScript(script, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('subprocess: SMOKE_BASE_URL override (trailing slash) is the target; EXPECT_DPL via env; exit 0', async () => {
  await withStub({}, async (base, seen) => {
    const { code, out } = await runScript(SCRIPT, { SMOKE_BASE_URL: `${base}/`, SMOKE_TIMEOUT_MS: '2000', EXPECT_DPL: DPL });
    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`target: ${base.replace(/[.]/g, '\\.')}\\n`));
    assert.match(out, new RegExp(`Total: ${N_CHECKS} PASS, 0 FAIL, 0 SKIP;.*build VERIFIED`));
    assert.ok(seen.some((r) => r.url.startsWith('/pricing?smoke=')));
  });
});

test('subprocess: one failure gives exit 1; bad config gives exit 2', async () => {
  await withStub({ '/terms': [500, {}, ''] }, async (base) => {
    const r = await runScript(SCRIPT, { SMOKE_BASE_URL: base, SMOKE_TIMEOUT_MS: '2000' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL {2}terms \/terms: GET \/terms: HTTP 500/);
  });
  for (const env of [{ SMOKE_BASE_URL: 'ftp://stem-loops.com' }, { EXPECT_DPL: 'abc' }, { SMOKE_TIMEOUT_MS: '1e13' }]) {
    const bad = await runScript(SCRIPT, env);
    assert.equal(bad.code, 2, `${JSON.stringify(env)}: ${bad.out}`);
  }
});

test('subprocess through a SYMLINKED path still runs every check (R1 B1): dead target -> exit 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-prod-web-'));
  try {
    const linkDir = join(dir, 'lnk');
    symlinkSync(HERE, linkDir, 'dir'); // a symlinked directory, as in the R1 repro
    const fileLink = join(dir, 'smoke.mjs');
    symlinkSync(SCRIPT, fileLink); // and a symlinked file
    for (const script of [join(linkDir, 'smoke_prod_web.mjs'), fileLink]) {
      const r = await runScript(script, { SMOKE_BASE_URL: 'http://127.0.0.1:9', SMOKE_TIMEOUT_MS: '500', SMOKE_DEADLINE_MS: '5000' });
      assert.equal(r.code, 1, `${script}: ${r.out}`);
      assert.match(r.out, /FAIL {2}home \//);
      assert.match(r.out, /Total: 0 PASS, \d+ FAIL/);
    }
    await withStub({}, async (base) => {
      const r = await runScript(join(linkDir, 'smoke_prod_web.mjs'), { SMOKE_BASE_URL: base, SMOKE_TIMEOUT_MS: '2000' });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, new RegExp(`Total: ${N_CHECKS} PASS`));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isEntry: real path, other file, missing argv, missing file', () => {
  const url = new URL('./smoke_prod_web.mjs', import.meta.url).href;
  assert.equal(isEntry(SCRIPT, url), true);
  assert.equal(isEntry(join(HERE, 'smoke_prod_web.test.mjs'), url), false);
  assert.equal(isEntry(undefined, url), false);
  assert.equal(isEntry('/no/such/file.mjs', url), false);
});
