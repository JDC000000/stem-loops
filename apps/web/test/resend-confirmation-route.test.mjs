// POST /api/auth/resend-confirmation (QW-7): CSRF guard, per-IP rate limit, hCaptcha before
// Supabase, and NO account enumeration (the same 200 body whatever Supabase says, and inside the
// per-address window).
//
// The route is transpiled in memory with the REAL same-origin guard, hCaptcha helper, password
// rules, return-to sanitiser and limiter; Supabase, Sentry, next/server and client-ip are stubbed.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SAME_ORIGIN_URL, SAME_ORIGIN_IMPORT_RE } from './helpers/same-origin.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

const hcaptchaUrl = dataUrl(toJs(read('src/lib/hcaptcha.ts')));
const rulesUrl = dataUrl(toJs(read('src/lib/auth/password-rules.ts')));
const returnToUrl = dataUrl(toJs(read('src/lib/auth/return-to.ts')));
// One limiter module for the whole file, so tests can reset it through the same instance.
const limitUrl = dataUrl(toJs(read('src/lib/auth/resend-limit.ts')));
const limit = await import(limitUrl);
const nextStub = dataUrl(`
  export class NextResponse {
    constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = new Map(Object.entries(init.headers ?? {})); }
    static json(body, init = {}) { return new NextResponse(body, init); }
  }`);
const sentryStub = dataUrl(`
  export function captureException(err, ctx) { globalThis.__sentry.push({ kind: 'exception', ctx }); }
  export function captureMessage(msg, ctx) { globalThis.__sentry.push({ kind: 'message', msg, ctx }); }`);
const clientIpStub = dataUrl(`
  export function clientIp(req) { return req.headers.get('x-forwarded-for') ?? '0.0.0.0'; }`);
// globalThis.__resend scripts Supabase: { error } object, or 'throw'.
const supabaseStub = dataUrl(`
  export async function createServerClient() {
    return { auth: { resend: async (args) => {
      globalThis.__resendCalls.push(args);
      if (globalThis.__resend === 'throw') throw new Error('supabase down');
      return { data: { user: null, session: null }, error: globalThis.__resend ?? null };
    } } };
  }`);

async function loadRoute() {
  const js = toJs(read('src/app/api/auth/resend-confirmation/route.ts'))
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${supabaseStub}'`)
    .replace(/from ['"]@\/lib\/auth\/password-rules['"]/g, `from '${rulesUrl}'`)
    .replace(/from ['"]@\/lib\/auth\/return-to['"]/g, `from '${returnToUrl}'`)
    .replace(/from ['"]@\/lib\/hcaptcha['"]/g, `from '${hcaptchaUrl}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${clientIpStub}'`)
    .replace(/from ['"]@\/lib\/auth\/resend-limit['"]/g, `from '${limitUrl}'`)
    .replace(SAME_ORIGIN_IMPORT_RE, `from '${SAME_ORIGIN_URL}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

const { POST } = await loadRoute();

let ipSeq = 0;
const freshIp = () => `198.51.100.${++ipSeq}`;
const makeReq = (body, { origin = 'https://stem-loops.com', host = 'stem-loops.com', ip = freshIp() } = {}) => {
  const h = new Headers({ 'x-forwarded-for': ip });
  if (origin !== null) h.set('origin', origin);
  if (host !== null) h.set('host', host);
  return {
    nextUrl: new URL('https://stem-loops.com/api/auth/resend-confirmation'),
    headers: h,
    json: async () => { if (body === undefined) throw new Error('no body'); return body; },
  };
};
let mailSeq = 0;
const valid = () => ({ email: `user${++mailSeq}@example.com`, hcaptcha_token: 'tok' });

const realFetch = globalThis.fetch;
let verifyCalls;
function stubHcaptcha(result) {
  globalThis.fetch = async (url, init) => {
    verifyCalls.push({ url, init });
    return { ok: true, status: 200, json: async () => result };
  };
}

beforeEach(() => {
  verifyCalls = [];
  globalThis.__resendCalls = [];
  globalThis.__sentry = [];
  globalThis.__resend = null;
  limit._resetResendLimits();
  process.env.HCAPTCHA_SECRET_KEY = '0x0000000000000000000000000000000000000000';
  stubHcaptcha({ success: true });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.HCAPTCHA_SECRET_KEY;
  delete globalThis.__resend;
});

// ─── CSRF ──────────────────────────────────────────────────────────────────────────────────

for (const [name, opts] of [
  ['no Origin', { origin: null }],
  ['Origin: null', { origin: 'null' }],
  ['cross-site Origin', { origin: 'https://evil.example' }],
  ['no Host', { host: null }],
  ['malformed Origin', { origin: 'not a url' }],
]) {
  test(`CSRF: ${name} -> 403 BAD_ORIGIN; no hCaptcha verify, no resend`, async () => {
    const res = await POST(makeReq(valid(), opts));
    assert.equal(res.status, 403);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error_code, 'BAD_ORIGIN');
    assert.equal(verifyCalls.length, 0);
    assert.equal(globalThis.__resendCalls.length, 0);
  });
}

test('CSRF: same origin with a default port on Host is accepted', async () => {
  const res = await POST(makeReq(valid(), { host: 'stem-loops.com:443' }));
  assert.equal(res.status, 200);
  assert.equal(globalThis.__resendCalls.length, 1);
});

// ─── hCaptcha ──────────────────────────────────────────────────────────────────────────────

test('hCaptcha: missing token -> 400 BOT_CHALLENGE_FAILED, no verify, no resend', async () => {
  const res = await POST(makeReq({ email: 'a@example.com' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'BOT_CHALLENGE_FAILED');
  assert.equal(verifyCalls.length, 0);
  assert.equal(globalThis.__resendCalls.length, 0);
});

test('hCaptcha: failed verify -> 400, no resend', async () => {
  stubHcaptcha({ success: false, 'error-codes': ['invalid-input-response'] });
  const res = await POST(makeReq(valid()));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'BOT_CHALLENGE_FAILED');
  assert.equal(verifyCalls.length, 1);
  assert.equal(globalThis.__resendCalls.length, 0);
});

test('hCaptcha: no secret configured fails CLOSED', async () => {
  delete process.env.HCAPTCHA_SECRET_KEY;
  const res = await POST(makeReq(valid()));
  assert.equal(res.status, 400);
  assert.equal(globalThis.__resendCalls.length, 0);
});

test('shape-invalid email -> 400 RESEND_INVALID_EMAIL (structural), no resend', async () => {
  const res = await POST(makeReq({ email: 'not-an-email', hcaptcha_token: 'tok' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'RESEND_INVALID_EMAIL');
  assert.equal(globalThis.__resendCalls.length, 0);
});

// ─── happy path ────────────────────────────────────────────────────────────────────────────

test('valid request -> resend type=signup, link through /auth/callback?type=signup, 200 { ok: true }, no-store', async () => {
  const body = { ...valid(), return_to: '/?resume=link&n=' + 'b'.repeat(32) };
  const res = await POST(makeReq(body));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(globalThis.__resendCalls.length, 1);
  const call = globalThis.__resendCalls[0];
  assert.equal(call.type, 'signup');
  assert.equal(call.email, body.email);
  const u = new URL(call.options.emailRedirectTo);
  assert.equal(u.origin, 'https://stem-loops.com');
  assert.equal(u.pathname, '/auth/callback');
  assert.equal(u.searchParams.get('type'), 'signup');
  assert.equal(u.searchParams.get('next'), body.return_to);
});

test('return_to to another host is sanitised to /account', async () => {
  await POST(makeReq({ ...valid(), return_to: 'https://evil.example/x' }));
  const u = new URL(globalThis.__resendCalls[0].options.emailRedirectTo);
  assert.equal(u.searchParams.get('next'), '/account');
});

// ─── no account enumeration ────────────────────────────────────────────────────────────────

test('no enumeration: success, unknown address, already confirmed, Supabase rate limit and a throw all give the SAME reply', async () => {
  const outcomes = [
    null,
    { name: 'AuthApiError', code: 'user_not_found', status: 404, message: 'User not found' },
    { name: 'AuthApiError', code: 'email_already_confirmed', status: 422, message: 'already confirmed' },
    { name: 'AuthApiError', code: 'over_email_send_rate_limit', status: 429, message: 'rate limit' },
    'throw',
  ];
  const replies = [];
  for (const o of outcomes) {
    globalThis.__resend = o;
    const res = await POST(makeReq(valid()));
    replies.push({ status: res.status, body: res.body, headers: [...res.headers.entries()] });
  }
  for (const r of replies) assert.deepEqual(r, replies[0]);
  assert.equal(replies[0].status, 200);
  assert.equal(globalThis.__resendCalls.length, outcomes.length);
});

test('Supabase errors reach Sentry with code and status only, never the address', async () => {
  globalThis.__resend = { name: 'AuthApiError', code: 'user_not_found', status: 404, message: 'User a@b.c not found' };
  const body = valid();
  await POST(makeReq(body));
  assert.equal(globalThis.__sentry.length, 1);
  const s = JSON.stringify(globalThis.__sentry);
  assert.doesNotMatch(s, new RegExp(body.email.replace('.', '\\.')));
  assert.doesNotMatch(s, /a@b\.c/);
  assert.equal(globalThis.__sentry[0].ctx.tags.auth_code, 'user_not_found');
  assert.equal(globalThis.__sentry[0].ctx.tags.auth_status, '404');
});

test('per-address window: a second request within 60 s sends nothing and replies exactly like a send', async () => {
  const body = valid();
  const first = await POST(makeReq(body));
  const second = await POST(makeReq({ ...body, email: body.email.toUpperCase() }));
  assert.equal(globalThis.__resendCalls.length, 1, 'only one mail');
  assert.equal(second.status, first.status);
  assert.deepEqual(second.body, first.body);
});

test('the per-address window is spent only after hCaptcha passes', async () => {
  const body = valid();
  stubHcaptcha({ success: false });
  await POST(makeReq(body));
  stubHcaptcha({ success: true });
  await POST(makeReq(body));
  assert.equal(globalThis.__resendCalls.length, 1, 'a failed bot check did not block the real owner');
});

// ─── per-IP rate limit ─────────────────────────────────────────────────────────────────────

test('rate limit: the 6th request from one IP in the window -> 429 RATE_LIMITED + Retry-After, nothing verified or sent', async () => {
  const ip = '203.0.113.50';
  for (let i = 0; i < limit.RESEND_IP_LIMIT; i++) {
    const ok = await POST(makeReq(valid(), { ip }));
    assert.equal(ok.status, 200, `request ${i + 1}`);
  }
  const verifiesBefore = verifyCalls.length;
  const sendsBefore = globalThis.__resendCalls.length;
  const res = await POST(makeReq(valid(), { ip }));
  assert.equal(res.status, 429);
  assert.equal(res.body.error_code, 'RATE_LIMITED');
  assert.ok(Number(res.headers.get('Retry-After')) >= 1);
  assert.equal(verifyCalls.length, verifiesBefore);
  assert.equal(globalThis.__resendCalls.length, sendsBefore);
  // Another IP is unaffected.
  assert.equal((await POST(makeReq(valid(), { ip: '203.0.113.51' }))).status, 200);
});

test('rate limit counts requests that fail the bot check too', async () => {
  const ip = '203.0.113.60';
  stubHcaptcha({ success: false });
  for (let i = 0; i < limit.RESEND_IP_LIMIT; i++) await POST(makeReq(valid(), { ip }));
  stubHcaptcha({ success: true });
  assert.equal((await POST(makeReq(valid(), { ip }))).status, 429);
});

test('cross-origin requests are refused before they count against the IP', async () => {
  const ip = '203.0.113.70';
  for (let i = 0; i < 10; i++) await POST(makeReq(valid(), { ip, origin: 'https://evil.example' }));
  assert.equal((await POST(makeReq(valid(), { ip }))).status, 200);
});

// ─── limiter unit ──────────────────────────────────────────────────────────────────────────

test('limiter: IP window resets after RESEND_IP_WINDOW_MS; email window after RESEND_EMAIL_WINDOW_MS', () => {
  limit._resetResendLimits();
  const t0 = 1_000_000;
  for (let i = 0; i < limit.RESEND_IP_LIMIT; i++) assert.equal(limit.admitResendIp('x', t0), true);
  assert.equal(limit.admitResendIp('x', t0 + 1), false);
  assert.equal(limit.resendIpRetryAfterSec('x', t0 + 1), Math.ceil((limit.RESEND_IP_WINDOW_MS - 1) / 1000));
  assert.equal(limit.admitResendIp('x', t0 + limit.RESEND_IP_WINDOW_MS), true);
  assert.equal(limit.admitResendEmail(' A@x.com ', t0), true);
  assert.equal(limit.admitResendEmail('a@x.com', t0 + limit.RESEND_EMAIL_WINDOW_MS - 1), false);
  assert.equal(limit.admitResendEmail('a@x.com', t0 + limit.RESEND_EMAIL_WINDOW_MS), true);
});
