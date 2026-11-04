// POST /api/auth/signup hCaptcha gate — V3-C1. Verifies the server rejects
// missing/invalid tokens BEFORE Supabase signUp is ever called.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
const nextStub = dataUrl(`
  export class NextResponse {
    constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; }
    static json(body, init = {}) { return new NextResponse(body, init); }
  }`);
const sentryStub = dataUrl(`export function captureException() {}`);
const supabaseStub = dataUrl(`
  export async function createServerClient() {
    return { auth: { signUp: async (args) => {
      globalThis.__signUpCalls.push(args);
      return { data: { session: null }, error: null };
    } } };
  }`);

async function loadRoute() {
  const js = toJs(read('src/app/api/auth/signup/route.ts'))
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${supabaseStub}'`)
    .replace(/from ['"]@\/lib\/auth\/password-rules['"]/g, `from '${rulesUrl}'`)
    .replace(/from ['"]@\/lib\/auth\/return-to['"]/g, `from '${returnToUrl}'`)
    .replace(/from ['"]@\/lib\/hcaptcha['"]/g, `from '${hcaptchaUrl}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

const makeReq = (body) => ({
  nextUrl: new URL('https://stem-loops.com/api/auth/signup'),
  headers: new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }),
  json: async () => { if (body === undefined) throw new Error('no body'); return body; },
});
const valid = { email: 'alice@example.com', password: 'correcthorse1battery' };

const realFetch = globalThis.fetch;
let verifyCalls;
function stubHcaptcha(result) {
  globalThis.fetch = async (url, init) => {
    verifyCalls.push({ url, init });
    if (result instanceof Error) throw result;
    return { ok: true, status: 200, json: async () => result };
  };
}

beforeEach(() => {
  verifyCalls = [];
  globalThis.__signUpCalls = [];
  process.env.HCAPTCHA_SECRET_KEY = '0x0000000000000000000000000000000000000000';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.HCAPTCHA_SECRET_KEY;
});

test('missing token -> 400 BOT_CHALLENGE_FAILED, no verify call, no signUp', async () => {
  stubHcaptcha({ success: true });
  const { POST } = await loadRoute();
  const res = await POST(makeReq(valid));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'BOT_CHALLENGE_FAILED');
  assert.equal(verifyCalls.length, 0);
  assert.equal(globalThis.__signUpCalls.length, 0);
});

test('unparseable body -> 400 BOT_CHALLENGE_FAILED', async () => {
  const { POST } = await loadRoute();
  const res = await POST(makeReq(undefined));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'BOT_CHALLENGE_FAILED');
  assert.equal(globalThis.__signUpCalls.length, 0);
});

test('invalid token -> 400 BOT_CHALLENGE_FAILED, signUp never called', async () => {
  stubHcaptcha({ success: false, 'error-codes': ['invalid-input-response'] });
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ ...valid, hcaptcha_token: 'bad' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'BOT_CHALLENGE_FAILED');
  assert.equal(verifyCalls.length, 1);
  assert.equal(globalThis.__signUpCalls.length, 0);
});

test('hCaptcha network error fails closed', async () => {
  stubHcaptcha(new Error('ECONNRESET'));
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ ...valid, hcaptcha_token: 'tok' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'BOT_CHALLENGE_FAILED');
  assert.equal(globalThis.__signUpCalls.length, 0);
});

test('valid token -> verifies (with client IP) then calls Supabase signUp', async () => {
  stubHcaptcha({ success: true });
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ ...valid, hcaptcha_token: 'good', return_to: '/pricing' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.needs_confirmation, true);
  assert.equal(verifyCalls.length, 1);
  assert.equal(new URLSearchParams(verifyCalls[0].init.body).get('remoteip'), '203.0.113.9');
  assert.equal(globalThis.__signUpCalls.length, 1);
  assert.equal(globalThis.__signUpCalls[0].email, 'alice@example.com');
  assert.match(globalThis.__signUpCalls[0].options.emailRedirectTo, /^https:\/\/stem-loops\.com\/login\?return_to=/);
});
