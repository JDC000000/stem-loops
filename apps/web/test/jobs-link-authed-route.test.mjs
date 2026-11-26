// Phase B B0, review R1 blocker: the ROUTE side of the signed-in link hand-off
// (src/app/api/jobs/route.ts, `if (user) { const r = await createAuthedLinkJob(...) }`).
// create-link-job.test.mjs proves the lib; this file proves the route passes the request's
// fields through, computes the IP hash only when the lib asks for it, and maps every result
// back to the same NextResponse it always built:
//   • admission AT_CAPACITY → 503 WITH Retry-After (NextResponse.json + headers)
//   • burst → raw `new NextResponse(JSON.stringify(...))` 429 with Retry-After + content-type
//   • stems / loop_length_bars reach the INSERT, and a bad value is still a 400
//   • ALLOW_YOUTUBE_INPUT unset or a bad body → 403/400 even when clientIpHashOf throws
//     (IP_HASH_KEY unset in production), never a 500.
// Instrument: route.ts transpiled in memory, every import rewritten to a stub below (the lib
// and the same-origin guard are the REAL modules). No DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SAME_ORIGIN_URL, sameOriginHeaders } from './helpers/same-origin.mjs';
import { LINK_JOB_URL, NO_PASTE_HOOKS_URL } from './helpers/create-link-job.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const read = (rel) => readFileSync(join(WEB, 'src', rel), 'utf8');

const USER_ID = '22222222-2222-4222-8222-222222222222';
const URL_OK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// State the stubs read and write, reset per test.
const S = () => globalThis.__lr;

const STUBS = {
  'next/server': dataUrl(`
    const hdrs = (h) => new Map(Object.entries(h ?? {}));
    export class NextResponse {
      constructor(body, init = {}) { this.kind = 'raw'; this.status = init.status ?? 200; this.body = body; this.headers = hdrs(init.headers); }
      static json(body, init = {}) { return { kind: 'json', status: init.status ?? 200, body, headers: hdrs(init.headers) }; }
    }
    export class NextRequest {}`),
  '@sentry/nextjs': dataUrl(`export const captureException = (e) => { globalThis.__lr.sentry.push(e); };`),
  '@/lib/db': dataUrl(`
    const client = { query: async (sql, params) => {
      const s = globalThis.__lr;
      if (/^INSERT INTO jobs/.test(sql)) { s.inserts.push(params); return { rows: [{ id: params[0] }], rowCount: 1 }; }
      throw new Error('unexpected SQL ' + sql);
    } };
    export const db = { query: client.query, tx: async (fn) => fn(client) };`),
  '@/lib/admission': dataUrl(`
    const no = (n) => async () => { throw new Error('not on the signed-in link path: ' + n); };
    export const checkAdmission = async (h) => { globalThis.__lr.log.push('checkAdmission:' + h); return globalThis.__lr.admission; };
    export const RATE_LIMIT = 10, RATE_WINDOW_MS = 60000, IN_FLIGHT_STATUSES = ['queued'];
    export const anonJobCapsWhere = () => 'TRUE', anonPresignedWhere = () => 'TRUE', presignRecordKey = () => 'k';
    export const anonJobDailyCap = () => 10, anonJobMaxInFlight = () => 2;
    export const hasAnonPresign = no('hasAnonPresign'), lockAnonIp = no('lockAnonIp'), checkAnonJobCaps = no('checkAnonJobCaps');`),
  '@/lib/client-ip': dataUrl(`export const clientIpHashOf = () => {
      const s = globalThis.__lr; s.log.push('clientIpHashOf');
      if (s.ipThrows) throw new Error('IP_HASH_KEY is not set'); return 'iphash'; };`),
  '@/lib/youtube-url': dataUrl(`export const canonicalizeYoutubeUrl = (u) => (/youtu/.test(u) ? u : null);`),
  '@/lib/upload': dataUrl(`export const isValidUploadKey = () => false;`),
  '@/lib/auth/supabase': dataUrl(`export const getUser = async () => ({ user_id: '${USER_ID}', email: 'a@b.co' });`),
  '@/lib/error-copy': dataUrl(toJs(read('lib/error-copy.ts'))),
  '@/lib/billing/rate-limit': dataUrl(`
    const L = (n) => globalThis.__lr.log.push(n);
    export const checkBurstLimit = async () => { L('checkBurstLimit'); return globalThis.__lr.burst; };
    export const checkMonthlyQuota = async () => { L('checkMonthlyQuota'); return globalThis.__lr.quota ?? null; };
    export const bumpJobsUsed = async () => { L('bumpJobsUsed'); };
    export const bumpJobsUsedWithinQuota = async () => { L('bumpJobsUsedWithinQuota'); return true; };
    export const recordAllowanceDebit = async () => { L('recordAllowanceDebit'); return true; };
    export const rollPeriodIfStale = async () => { L('rollPeriodIfStale'); };`),
  '@/lib/billing/entitlements': dataUrl(`
    export class EntitlementError extends Error { constructor(code, m) { super(m ?? code); this.code = code; this.status = 402; } }
    export const getEntitlementSnapshot = async () => ({ plan_code: globalThis.__lr.plan, jobs_quota: 5, credits_remaining: 0 });
    export const enforceEntitlement = async () => {};
    export const billingEnforced = () => false;
    export const FREE_QUOTA_EXHAUSTED_MESSAGE = 'FREE_MSG';`),
  '@/lib/trial': dataUrl(`export const consumeTrialInTx = async () => { globalThis.__lr.log.push('consumeTrialInTx'); return { ok: false }; };`),
  '@/lib/billing/credits': dataUrl(`export const consumeCreditInTx = async () => { throw new Error('credits are never spent on a link'); };`),
  '@/lib/same-origin': SAME_ORIGIN_URL,
  '@/lib/jobs/create-link-job': LINK_JOB_URL,
  '@/lib/library-server': NO_PASTE_HOOKS_URL, // #372's dedupe hooks: test/jobs-link-dedupe.test.mjs
};

const ROUTE_JS = toJs(read('app/api/jobs/route.ts')).replace(
  /import\s+([\s\S]+?)\s+from\s+['"]([^'"]+)['"];?/g,
  (all, clause, spec) => {
    if (spec === 'crypto' || spec.startsWith('node:')) return all;
    if (!STUBS[spec]) throw new Error(`route.ts imports ${spec}: add a stub`);
    return `import ${clause} from '${STUBS[spec]}';`;
  },
);
const route = await import(dataUrl(ROUTE_JS));

async function post(body, state = {}) {
  globalThis.__lr = {
    log: [], inserts: [], sentry: [],
    admission: { allowed: true, error_code: null },
    burst: null, quota: null, plan: 'free', ipThrows: false,
    ...state,
  };
  const prev = process.env.ALLOW_YOUTUBE_INPUT;
  if (state.allowYoutube === false) delete process.env.ALLOW_YOUTUBE_INPUT;
  else process.env.ALLOW_YOUTUBE_INPUT = 'true';
  try {
    return await route.POST({ headers: sameOriginHeaders(), json: async () => body });
  } finally {
    if (prev === undefined) delete process.env.ALLOW_YOUTUBE_INPUT; else process.env.ALLOW_YOUTUBE_INPUT = prev;
  }
}

test('signed-in link at global capacity → 503 with Retry-After (header reaches the response)', async () => {
  const res = await post({ url: URL_OK }, {
    admission: { allowed: false, error_code: 'AT_CAPACITY', message: 'busy', retry_after_s: 45 },
  });
  assert.equal(res.kind, 'json');
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error_code: 'AT_CAPACITY', message: 'busy' });
  assert.equal(res.headers.get('Retry-After'), '45');
  assert.equal(S().inserts.length, 0);
});

test('signed-in link per-client refusal → 429 JSON with no headers', async () => {
  const res = await post({ url: URL_OK }, {
    admission: { allowed: false, error_code: 'RATE_LIMITED', reason: 'per_client', message: 'slow' },
  });
  assert.equal(res.kind, 'json');
  assert.equal(res.status, 429);
  assert.deepEqual(res.body, { error_code: 'RATE_LIMITED', message: 'slow' });
  assert.equal(res.headers.size, 0);
});

test('signed-in burst → the raw NextResponse 429 with Retry-After and content-type', async () => {
  const res = await post({ url: URL_OK }, { burst: { retry_after_s: 7 } });
  assert.equal(res.kind, 'raw', 'built with new NextResponse(JSON.stringify(...)), as before B0');
  assert.equal(res.status, 429);
  assert.equal(res.body, JSON.stringify({
    error: 'too many requests', code: 'rate_limit_burst', retry_after_s: 7,
    error_code: 'RATE_LIMITED', message: "You're sending requests too fast. Wait a minute and try again.",
  }));
  assert.equal(res.headers.get('Retry-After'), '7');
  assert.equal(res.headers.get('content-type'), 'application/json');
});

test('signed-in link: stems and loop_length_bars reach the INSERT; defaults when absent', async () => {
  const res = await post({ url: URL_OK, stems: ['bass', 'drums'], loop_length_bars: 8 });
  assert.equal(res.status, 201);
  assert.equal(res.kind, 'json');
  assert.equal(S().inserts.length, 1);
  const p = S().inserts[0];
  assert.equal(p[1], URL_OK);
  assert.deepEqual(p[2], ['bass', 'drums']);
  assert.equal(p[3], 8);
  assert.equal(p[4], 'iphash');
  assert.equal(p[7], USER_ID);
  assert.deepEqual(res.body, { id: p[0], status: 'queued' });

  const d = await post({ url: URL_OK });
  assert.equal(d.status, 201);
  assert.deepEqual(S().inserts[0][2], ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other']);
  assert.equal(S().inserts[0][3], 4);
});

test('signed-in link: bad stems / bars / url are still 400s, before any gate', async () => {
  for (const [body, message] of [
    [{ url: URL_OK, stems: ['piano'] }, 'stems must be a non-empty list of supported stems.'],
    [{ url: URL_OK, stems: [] }, 'stems must be a non-empty list of supported stems.'],
    [{ url: URL_OK, loop_length_bars: 3 }, 'loop_length_bars must be 1, 2, 4, or 8'],
    [{ url: 'https://example.com/v' }, 'That doesn’t look like a YouTube video link. Paste a full youtube.com or youtu.be link.'],
    [{}, 'url is required'],
  ]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(res.body, { error_code: 'DOWNLOAD_INVALID_URL', message });
    assert.deepEqual(S().log, [], 'no gate, no IP hash');
    assert.equal(S().inserts.length, 0);
  }
});

test('signed-in link: 403 / 400 stay 403 / 400 when clientIpHashOf throws (IP hash computed late)', async () => {
  const off = await post({ url: URL_OK }, { allowYoutube: false, ipThrows: true });
  assert.equal(off.status, 403);
  assert.deepEqual(off.body, { error_code: 'DOWNLOAD_INVALID_URL', message: 'YouTube links are paused right now. Upload the audio file instead.' });
  const bad = await post({ url: URL_OK, stems: ['piano'] }, { ipThrows: true });
  assert.equal(bad.status, 400);
  assert.ok(!S().log.includes('clientIpHashOf'), 'the hash is never computed for a refused body');
  // On the happy path it is computed exactly once, just before checkAdmission.
  const ok = await post({ url: URL_OK });
  assert.equal(ok.status, 201);
  const i = S().log.indexOf('clientIpHashOf');
  assert.equal(S().log.filter((s) => s === 'clientIpHashOf').length, 1);
  assert.equal(S().log[i + 1], 'checkAdmission:iphash');
});

// ── Beta QA S1/S2 (QW-1): the refusals carry the real sentence ─────────────────────────────
// The REAL error-copy module, checkout OFF (BILLING_CHECKOUT_ENABLED unset, the beta posture).
const FREE_QUOTA_SENTENCE = "You've used all your free tracks this month. Your allowance resets at the start of next month.";
const NO_BUY = /\bbuy\b|purchase|credit pack|pick a plan|upgrade/i;

test('S1: a free user out of songs pastes a link → 402 with the upload path\'s code and sentence', async () => {
  assert.notEqual(process.env.BILLING_CHECKOUT_ENABLED, 'true', 'beta posture: checkout hidden');
  const res = await post({ url: URL_OK }, { quota: { kind: 'quota_exceeded', resets_at: '2026-12-01T00:00:00Z' } });
  assert.equal(res.status, 402, 'status code unchanged');
  assert.equal(res.body.code, 'quota_exceeded', 'old field kept');
  assert.equal(res.body.resets_at, '2026-12-01T00:00:00Z');
  assert.equal(res.body.error_code, 'FREE_MONTHLY_QUOTA_EXHAUSTED');
  assert.equal(res.body.message, FREE_QUOTA_SENTENCE);
  assert.doesNotMatch(res.body.message, NO_BUY);
  assert.doesNotMatch(res.body.message, /on our end/);
  assert.equal(S().inserts.length, 0, 'nothing created');
});

test('S1: a paid plan refused by checkMonthlyQuota gets the plan-allowance sentence, not the free one', async () => {
  const res = await post({ url: URL_OK }, { plan: 'pro', quota: { kind: 'quota_exceeded', resets_at: '' } });
  assert.equal(res.status, 402);
  assert.equal(res.body.error_code, 'ENTITLEMENT_UNAVAILABLE');
  assert.equal(res.body.message, "You've used this month's allowance on your plan. Your account page shows when the period ends.");
  assert.doesNotMatch(res.body.message, NO_BUY);
});

test('S2: the 3-starts-per-60-s burst limit → 429 with the per-client sentence', async () => {
  const res = await post({ url: URL_OK }, { burst: { retry_after_s: 60 } });
  assert.equal(res.status, 429);
  const body = JSON.parse(res.body);
  assert.equal(body.error_code, 'RATE_LIMITED');
  assert.equal(body.message, "You're sending requests too fast. Wait a minute and try again.");
  assert.equal(res.headers.get('Retry-After'), '60');
});
