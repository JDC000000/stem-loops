// Tests for scripts/smoke_prod_web.mjs (J1a; Jon L9).
//
//   node --test scripts/smoke_prod_web.test.mjs
//
// No network: every request goes to a stub HTTP server on 127.0.0.1 that plays production web.
// Most tests call runSmoke() in-process with `base` pointed at the stub; two run the REAL script
// as a subprocess to prove the SMOKE_BASE_URL override and the exit codes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHECKOUT, MARKERS, NO_SHA_REASON, PRIVATE_APIS, normBase, runSmoke } from './smoke_prod_web.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'smoke_prod_web.mjs');
const DEMO_ID = '9c5ba587-b83a-4d70-85ed-24b6ee75b869';

const html = (title, body) => `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const SEC_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'; object-src 'none'",
};
const PRICING_OK = html(
  'Pricing · stem-loops',
  `<h1 class="pr-h1">Pricing</h1>
   <section aria-label="Free"><a href="/">Start free</a></section>
   <section aria-label="Pro"><p data-testid="checkout-unavailable">${CHECKOUT.label}</p></section>
   <section aria-label="20 credits for $5 CAD"><p data-testid="checkout-unavailable">${CHECKOUT.label}</p></section>
   <script>self.__next_f.push([1,"harmless payload"])</script>`,
);

/** The healthy site. Each value: [status, headers, body] or a function (req, res) => void. */
function healthyRoutes() {
  const json = (o, status = 200) => [status, { 'content-type': 'application/json' }, JSON.stringify(o)];
  return {
    '/': [200, SEC_HEADERS, html('stem-loops: play along with any song, stem by stem',
      '<h1 id="h1"><span class="h1-line">Paste a song.</span> <span class="h1-line">Play along.</span></h1>')],
    '/pricing': [200, {}, PRICING_OK],
    '/login': [200, {}, html('Sign in · stem-loops', '<button data-testid="login-google">Continue with Google</button>')],
    '/help': [200, {}, html('Help · stem-loops', '<h1>Help</h1>')],
    '/terms': [200, {}, html('Terms · stem-loops', `<h1>Terms</h1><p>but they ${CHECKOUT.termsBeta}.</p>`)],
    '/privacy': [200, {}, html('Privacy · stem-loops', '<h1>Privacy</h1>')],
    '/api/demos': json({ demos: [{ id: DEMO_ID, slug: 'lucky-ticket', title: 'Lucky Ticket', artist: 'x', bpm: 102 }] }),
    '/demo/lucky-ticket': [200, {}, html('Play along to Lucky Ticket · stem-loops', '<div id="player"></div>')],
    [`/api/jobs/${DEMO_ID}`]: json({ id: DEMO_ID, status: 'done', is_demo: true, loops: [{ id: 1, stem: 'bass', signed_url: null }] }),
    '/api/library': json({ error_code: 'AUTH_REQUIRED' }, 401),
    '/api/billing/credits/balance': json({ code: 'UNAUTHENTICATED' }, 401),
    '/api/set-lists': json({ error_code: 'AUTH_REQUIRED' }, 401),
  };
}

async function withStub(overrides, fn) {
  const routes = { ...healthyRoutes(), ...overrides };
  const seen = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const r = routes[req.url];
    if (typeof r === 'function') return r(req, res);
    if (!r) { res.writeHead(404); return res.end('not found'); }
    const [status, headers, body] = r;
    res.writeHead(status, headers);
    res.end(body);
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
const run = (base, opts = {}) => runSmoke({ base, expectSha: '', timeoutMs: 2000, deadlineMs: 20_000, retryDelayMs: 10, log: quiet, ...opts });
const byName = (results, prefix) => results.find((r) => r.name.startsWith(prefix));
const failsOnly = (results) => results.filter((r) => r.status === 'FAIL').map((r) => r.name);

// -------------------------------------------------------------------- pass
test('healthy site: every check PASSes, exit 0, GETs only', async () => {
  await withStub({}, async (base, seen) => {
    const { results, code } = await run(base);
    assert.equal(code, 0, JSON.stringify(results, null, 1));
    assert.equal(results.length, 11 + PRIVATE_APIS.length);
    assert.ok(results.every((r) => r.status === 'PASS'));
    assert.ok(seen.length > 0 && seen.every((s) => s.startsWith('GET ')), seen.join(','));
  });
});

// --------------------------------------------------------- each failure kind
const failCases = [
  ['page non-200', { '/help': [500, {}, 'boom'] }, 'help /help', /HTTP 500/],
  ['page redirect is not followed', { '/login': [307, { location: '/elsewhere' }, ''] }, 'login /login', /HTTP 307 -> \/elsewhere/],
  ['page missing marker', { '/privacy': [200, {}, html('Privacy · stem-loops', '<h1>Privcy</h1>')] }, 'privacy /privacy', /missing marker.*<h1>Privacy<\/h1>/],
  ['home wrong title', { '/': [200, SEC_HEADERS, html('Oops', 'Paste a song. Play along.')] }, 'home /', /missing marker/],
  ['security header missing', { '/': [200, { 'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'none'" },
    html('stem-loops: play along with any song, stem by stem', 'Paste a song. Play along.')] }, 'security headers', /x-frame-options=null/],
  ['pricing degraded banner', { '/pricing': [200, {}, PRICING_OK.replace('</body>', `<p>Showing standard pricing; ${MARKERS.pricingDegraded}.</p></body>`)] },
    'pricing /pricing', /degraded banner/],
  ['checkout label gone', { '/pricing': [200, {}, PRICING_OK.replaceAll(CHECKOUT.label, 'Soon')] }, 'checkout hidden', /missing beta label/],
  ['checkout enabled: sign-in buy link (React comment split)', {
    '/pricing': [200, {}, PRICING_OK.replace('</body>', '<a href="/login?return_to=/pricing">Get <!-- -->Pro</a></body>')] },
    'checkout hidden', /"Get Pro".*"return_to=\/pricing"/],
  ['checkout enabled: Buy credits', { '/pricing': [200, {}, PRICING_OK.replace('</body>', '<a>Buy credits</a></body>')] }, 'checkout hidden', /"Buy credits"/],
  ['checkout enabled: endpoint in RSC payload', {
    '/pricing': [200, {}, PRICING_OK.replace('harmless payload', '{\\"endpoint\\":\\"/api/billing/checkout\\"}')] },
    'checkout hidden', /"\/api\/billing\/checkout"/],
  ['terms lost beta copy', { '/terms': [200, {}, html('Terms · stem-loops', '<h1>Terms</h1>')] }, 'terms /terms', /aren’t on sale/],
  ['demo list empty', { '/api/demos': [200, {}, '{"demos":[]}'] }, 'demo list', /non-empty/],
  ['demo page wrong title', { '/demo/lucky-ticket': [200, {}, html('Play along: demo song', '')] }, 'demo page', /expected "Play along to Lucky Ticket · stem-loops"/],
  ['demo page 404', { '/demo/lucky-ticket': [404, {}, 'nf'] }, 'demo page', /HTTP 404/],
  ['demo job leaks owner-only field', {
    [`/api/jobs/${DEMO_ID}`]: [200, {}, JSON.stringify({ status: 'done', is_demo: true, youtube_url: 'x', loops: [{ r2_key: 'k', signed_url: 'https://s' }] })] },
    'demo job API', /youtube_url, loops\[\]\.r2_key, loops\[\]\.signed_url/],
  ['demo job not a demo', { [`/api/jobs/${DEMO_ID}`]: [200, {}, JSON.stringify({ status: 'done', is_demo: false, loops: [] })] }, 'demo job API', /is_demo=true/],
  ['private API answers 200', { '/api/library': [200, {}, '{"songs":[]}'] }, 'private API refuses signed out /api/library', /HTTP 200, expected 401\/403/],
  ['private API answers 500', { '/api/set-lists': [500, {}, 'x'] }, 'private API refuses signed out /api/set-lists', /HTTP 500/],
];

for (const [label, override, check, re] of failCases) {
  test(`FAIL: ${label}`, async () => {
    await withStub(override, async (base) => {
      const { results, code } = await run(base);
      assert.equal(code, 1);
      const r = byName(results, check);
      assert.ok(r, `no result named ${check}`);
      assert.equal(r.status, 'FAIL', JSON.stringify(r));
      assert.match(r.detail, re);
    });
  });
}

test('private API 403 is accepted as a refusal', async () => {
  await withStub({ '/api/billing/credits/balance': [403, {}, '{}'] }, async (base) => {
    const { code, results } = await run(base);
    assert.equal(code, 0, JSON.stringify(failsOnly(results)));
  });
});

test('demo checks FAIL (not crash) when /api/demos is down', async () => {
  await withStub({ '/api/demos': [503, {}, 'down'] }, async (base) => {
    const { results } = await run(base);
    assert.deepEqual(failsOnly(results), ['demo list /api/demos', 'demo page signed out /demo/<slug>', 'demo job API signed out (public view)']);
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
  await withStub({ '/privacy': (req, res) => { if (++hits === 1) return req.socket.destroy(); res.writeHead(200); res.end(html('Privacy · stem-loops', '<h1>Privacy</h1>')); } }, async (base) => {
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
    assert.ok(results.slice(1).every((r) => r.status === 'FAIL' && /deadline/.test(r.detail)), JSON.stringify(results.slice(1, 3)));
    assert.ok(Date.now() - t < 3000);
  });
});

// ------------------------------------------------------------------ EXPECT_SHA
test('EXPECT_SHA set: SKIP with the no-SHA reason; exit stays 0', async () => {
  await withStub({}, async (base) => {
    const { results, code } = await run(base, { expectSha: '75ea4e9abcdef' });
    assert.equal(code, 0);
    const r = byName(results, 'deployed SHA');
    assert.equal(r.status, 'SKIP');
    assert.equal(r.detail, NO_SHA_REASON);
  });
});

// ------------------------------------------------------- base URL + subprocess
test('normBase: default, trailing slash, rejects non-http and paths', () => {
  assert.equal(normBase(undefined), 'https://stem-loops.com');
  assert.equal(normBase('https://x.vercel.app/'), 'https://x.vercel.app');
  assert.equal(normBase('http://127.0.0.1:9/'), 'http://127.0.0.1:9');
  assert.equal(normBase('ftp://x'), null);
  assert.equal(normBase('not a url'), null);
  assert.equal(normBase('https://x.com/pricing'), null);
});

function runScript(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('subprocess: SMOKE_BASE_URL override (trailing slash) is the target; exit 0', async () => {
  await withStub({}, async (base, seen) => {
    const { code, out } = await runScript({ SMOKE_BASE_URL: `${base}/`, SMOKE_TIMEOUT_MS: '2000' });
    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`target: ${base.replace(/[.]/g, '\\.')}\\n`));
    assert.match(out, /Total: 14 PASS, 0 FAIL, 0 SKIP/);
    assert.ok(seen.includes('GET /pricing'));
  });
});

test('subprocess: one failure gives exit 1; bad SMOKE_BASE_URL gives exit 2', async () => {
  await withStub({ '/terms': [500, {}, ''] }, async (base) => {
    const r = await runScript({ SMOKE_BASE_URL: base, SMOKE_TIMEOUT_MS: '2000' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL {2}terms \/terms: GET \/terms: HTTP 500/);
  });
  const bad = await runScript({ SMOKE_BASE_URL: 'ftp://stem-loops.com' });
  assert.equal(bad.code, 2, bad.out);
});
