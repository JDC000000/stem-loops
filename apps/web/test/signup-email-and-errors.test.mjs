// Sign-up fixes from Jon's live test (Slice 1b):
//   1. an email whose LOCAL part has a character most providers refuse (`name!@gmail.com`
//      bounced twice) is refused on the sign-up form AND by POST /api/auth/signup, with one
//      line: "Check your email address — it has a character most email providers don't accept."
//      Sign-in and password reset keep the old check, so no existing account is locked out.
//   2. signUp() errors never reach the user as provider text. "Error sending confirmation
//      email" (an already-registered address), send failures and rate limits all read
//      "If you already have an account, sign in instead — or wait a minute and try again."
//      with a Sign in link — the same line for each, so it reveals nothing about the account.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { withDom } from './helpers/dom.mjs';
import { loadLoginFormComponent } from './helpers/render-login-form.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src) => ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const rulesUrl = dataUrl(toJs(read('src/lib/auth/password-rules.ts')));
const errorsUrl = dataUrl(toJs(read('src/lib/auth/signup-errors.ts')));
const rules = await import(rulesUrl);
const errs = await import(errorsUrl);

const MSG = "Check your email address — it has a character most email providers don't accept.";
const RETRY = 'If you already have an account, sign in instead — or wait a minute and try again.';

// ── 1. the email rule ──────────────────────────────────────────────────────────────────────
test('sign-up email: refuses ! , spaces, consecutive dots and a leading/trailing dot in the local part', () => {
  assert.equal(rules.SIGNUP_EMAIL_CHAR_MSG, MSG);
  for (const bad of ['name!@gmail.com', 'na me@gmail.com', 'first..last@gmail.com', '.name@gmail.com', 'name.@gmail.com',
    'a#b@example.com', 'a(b)@example.com', 'a"b@example.com', 'a,b@example.com', 'a;b@example.com', 'a<b>@example.com']) {
    assert.equal(rules.validateSignupEmail(bad), MSG, bad);
  }
});

test('N-6: the same check covers the DOMAIN: a@gm!ail.com and friends are refused', () => {
  for (const bad of ['a@gm!ail.com', 'a@gmail.com!', 'a@!gmail.com', 'name@gma il.com', 'a@gmail..com', 'a@.gmail.com',
    'a@gmail.com.', 'a@gm#ail.com', 'a@gm(ail).com', 'a@gm,ail.com', 'a@[1.2.3.4]', 'a@b!@gmail.com']) {
    assert.equal(rules.validateSignupEmail(bad), MSG, bad);
  }
  for (const ok of ['a@mail.example-host.co.uk', 'a@sub.domain.io', 'a@münchen.de', 'a@xn--mnchen-3ya.de']) {
    assert.equal(rules.validateSignupEmail(ok), null, ok);
  }
  assert.equal(rules.validateEmail('a@gm!ail.com'), null, 'sign-in keeps the old permissive check');
});

test('sign-up email: ordinary addresses still pass, and the base checks still apply', () => {
  for (const ok of ['alice@example.com', 'first.last@gmail.com', 'bob+tag@stem-loops.co.uk', 'o’neil@example.com', "o'neil@example.com",
    'under_score-dash@example.com', '  padded@example.com  ', 'josé@example.com']) {
    assert.equal(rules.validateSignupEmail(ok), null, ok);
  }
  assert.match(rules.validateSignupEmail(''), /Enter your email/);
  assert.match(rules.validateSignupEmail('nope'), /valid email/);
  assert.match(rules.validateSignupEmail('a@b'), /valid email/);
  assert.match(rules.validateSignupEmail(42), /Enter your email/);
});

test('sign-in and reset keep the old check: an existing name!@ account is not locked out', () => {
  assert.equal(rules.validateEmail('name!@gmail.com'), null);
  assert.doesNotMatch(read('src/app/api/auth/reset-password-request/route.ts'), /validateSignupEmail/);
  assert.doesNotMatch(read('src/components/ResetPasswordRequestForm.tsx'), /validateSignupEmail/);
});

// ── 2. the error mapping ───────────────────────────────────────────────────────────────────
test('signUp errors map to one plain line each; the account/send/rate cases share one line with a Sign in link', () => {
  const cases = [
    [{ status: 500, code: 'unexpected_failure', message: 'Error sending confirmation email' }, 'SIGNUP_RETRY_OR_SIGN_IN', RETRY, true],
    [{ status: 500, message: 'Error sending confirmation email' }, 'SIGNUP_RETRY_OR_SIGN_IN', RETRY, true],
    [{ status: 429, code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' }, 'SIGNUP_RETRY_OR_SIGN_IN', RETRY, true],
    [{ status: 429, code: 'over_request_rate_limit', message: 'Request rate limit reached' }, 'SIGNUP_RETRY_OR_SIGN_IN', RETRY, true],
    [{ status: 422, code: 'user_already_exists', message: 'User already registered' }, 'SIGNUP_RETRY_OR_SIGN_IN', RETRY, true],
    [{ status: 422, code: 'email_exists', message: 'Email address already registered' }, 'SIGNUP_RETRY_OR_SIGN_IN', RETRY, true],
    [{ status: 422, code: 'weak_password', message: 'Password is known to be weak' }, 'SIGNUP_WEAK_PASSWORD', errs.SIGNUP_WEAK_PASSWORD, false],
    [{ status: 400, code: 'email_address_invalid', message: 'Email address "x" is invalid' }, 'SIGNUP_EMAIL_REFUSED', errs.SIGNUP_EMAIL_REFUSED, false],
    [{ status: 400, code: 'email_address_not_authorized', message: 'Email address not authorized' }, 'SIGNUP_EMAIL_REFUSED', errs.SIGNUP_EMAIL_REFUSED, false],
    [{ status: 422, code: 'signup_disabled', message: 'Signups not allowed for this instance' }, 'SIGNUP_DISABLED', errs.SIGNUP_DISABLED, false],
    [{ status: 418, code: 'something_new', message: 'teapot internals at db.host:5432' }, 'SIGNUP_FAILED', errs.SIGNUP_GENERIC, false],
    [null, 'SIGNUP_FAILED', errs.SIGNUP_GENERIC, false],
  ];
  for (const [err, code, text, signIn] of cases) {
    const r = errs.signupErrorReply(err);
    assert.equal(r.code, code, JSON.stringify(err));
    assert.equal(r.error, text, JSON.stringify(err));
    assert.equal(r.sign_in, signIn, JSON.stringify(err));
    if (err?.message) assert.ok(!r.error.includes(err.message), 'provider text leaked');
  }
  for (const t of [RETRY, errs.SIGNUP_WEAK_PASSWORD, errs.SIGNUP_EMAIL_REFUSED, errs.SIGNUP_DISABLED, errs.SIGNUP_GENERIC]) {
    assert.equal(t.split(/(?<=[.!?])\s+(?=[A-Z])/).length, 1, `one line: ${t}`);
  }
});

// ── the route, end to end with a scripted signUp() ─────────────────────────────────────────
const nextStub = dataUrl(`export class NextResponse { constructor(b, i = {}) { this.body = b; this.status = i.status ?? 200; }
  static json(b, i = {}) { return new NextResponse(b, i); } }`);
const sentryStub = dataUrl(`export function captureException() {}
  export function captureMessage(m, o) { (globalThis.__sentry ??= []).push([m, o]); }`);
const supabaseStub = dataUrl(`export async function createServerClient() {
  return { auth: { signUp: async (a) => { globalThis.__signUpCalls.push(a); return globalThis.__signUpResult; } } }; }`);
async function loadRoute() {
  const js = toJs(read('src/app/api/auth/signup/route.ts'))
    .replace(/from ['"]next\/server['"]/g, `from '${nextStub}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${supabaseStub}'`)
    .replace(/from ['"]@\/lib\/auth\/password-rules['"]/g, `from '${rulesUrl}'`)
    .replace(/from ['"]@\/lib\/auth\/return-to['"]/g, `from '${dataUrl(toJs(read('src/lib/auth/return-to.ts')))}'`)
    .replace(/from ['"]@\/lib\/hcaptcha['"]/g, `from '${dataUrl('export async function verifyHcaptchaToken() { return { success: true }; }')}'`)
    .replace(/from ['"]@\/lib\/auth\/signup-errors['"]/g, `from '${errorsUrl}'`);
  return import(dataUrl(js) + '#' + Math.random());
}
const req = (body) => ({ nextUrl: new URL('https://stem-loops.com/api/auth/signup'), headers: new Headers(), json: async () => body });
const body = (email) => ({ email, password: 'correcthorse1battery', hcaptcha_token: 'ok' });

beforeEach(() => { globalThis.__signUpCalls = []; globalThis.__sentry = []; globalThis.__signUpResult = { data: { session: null }, error: null }; });
afterEach(() => { delete globalThis.__signUpResult; });

test('route: name!@gmail.com is refused with the one-line message, before signUp is called', async () => {
  const { POST } = await loadRoute();
  const res = await POST(req(body('name!@gmail.com')));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'SIGNUP_INVALID');
  assert.equal(res.body.error, MSG);
  assert.equal(globalThis.__signUpCalls.length, 0);
});

test('route: "Error sending confirmation email" becomes the neutral line with sign_in, never the raw text', async () => {
  globalThis.__signUpResult = { data: {}, error: { name: 'AuthApiError', status: 500, code: 'unexpected_failure', message: 'Error sending confirmation email' } };
  const { POST } = await loadRoute();
  const res = await POST(req(body('alice@example.com')));
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { ok: false, code: 'SIGNUP_RETRY_OR_SIGN_IN', error: RETRY, sign_in: true });
  assert.doesNotMatch(JSON.stringify(res.body), /confirmation email/i);
  // SF-1 (review round 2): `unexpected_failure` is GoTrue's code for EVERY 500, so it is reported
  // (the reply to the person is unchanged) — code and status only.
  assert.equal(globalThis.__sentry.length, 1, 'a server failure is a Sentry event');
  const [msg, opts] = globalThis.__sentry[0];
  assert.equal(msg, 'signup: auth server failure');
  assert.equal(opts.level, 'error');
  assert.deepEqual(opts.tags, { route: 'api/auth/signup', auth_code: 'unexpected_failure', auth_status: '500' });
  assert.doesNotMatch(JSON.stringify(globalThis.__sentry), /confirmation|alice|example\.com/i, 'no provider text or address');
});

test('SF-1 route: a 5xx with "Database error saving new user" keeps the neutral reply and is reported, code+status only', async () => {
  globalThis.__signUpResult = { data: {}, error: { name: 'AuthApiError', status: 500, code: 'unexpected_failure', message: 'Database error saving new user bob@example.com' } };
  const { POST } = await loadRoute();
  const res = await POST(req(body('bob@example.com')));
  assert.deepEqual(res.body, { ok: false, code: 'SIGNUP_RETRY_OR_SIGN_IN', error: RETRY, sign_in: true });
  assert.equal(globalThis.__sentry.length, 1);
  assert.doesNotMatch(JSON.stringify(globalThis.__sentry), /Database|bob|example\.com/i);
});

test('SF-1 route: a 503 with no code is generic for the person and reported as a server failure', async () => {
  globalThis.__signUpResult = { data: {}, error: { name: 'AuthRetryableFetchError', status: 503, message: 'upstream connect error carol@example.com' } };
  const { POST } = await loadRoute();
  const res = await POST(req(body('carol@example.com')));
  assert.equal(res.body.error, errs.SIGNUP_GENERIC);
  assert.equal(globalThis.__sentry.length, 1);
  assert.equal(globalThis.__sentry[0][0], 'signup: auth server failure');
  assert.deepEqual(globalThis.__sentry[0][1].tags, { route: 'api/auth/signup', auth_code: '', auth_status: '503' });
  assert.doesNotMatch(JSON.stringify(globalThis.__sentry), /upstream|carol/i);
});

test('SF-1 route: the known 4xx cases (existing account, rate limit, weak password) are NOT reported', async () => {
  for (const error of [
    { status: 422, code: 'user_already_exists', message: 'User already registered' },
    { status: 429, code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' },
    { status: 422, code: 'weak_password', message: 'weak' },
    { status: 400, code: 'email_address_invalid', message: 'bad' },
  ]) {
    globalThis.__sentry = [];
    globalThis.__signUpResult = { data: {}, error };
    const { POST } = await loadRoute();
    await POST(req(body('dave@example.com')));
    assert.equal(globalThis.__sentry.length, 0, error.code);
  }
});

test('SF-1 mapping: report is server_failure for unexpected_failure or any status >= 500, else null/unmapped', () => {
  const r = (e) => errs.signupErrorReply(e);
  assert.equal(r({ status: 500, code: 'unexpected_failure' }).report, 'server_failure');
  assert.equal(r({ status: 0, code: 'unexpected_failure' }).report, 'server_failure', 'the code alone is enough');
  assert.equal(r({ status: 500, message: 'Error sending confirmation email' }).report, 'server_failure', 'the status alone is enough');
  assert.equal(r({ status: 502, code: 'weak_password' }).report, 'server_failure');
  assert.equal(r({ status: 504 }).report, 'server_failure');
  assert.equal(r({ status: 418, code: 'something_new' }).report, 'unmapped');
  assert.equal(r({ status: 429, code: 'over_request_rate_limit' }).report, null);
  assert.equal(r({ status: 422, code: 'email_exists' }).report, null);
  for (const e of [{ status: 500, code: 'unexpected_failure' }, { status: 418 }, { status: 422, code: 'email_exists' }]) {
    assert.equal(r(e).unexpected, r(e).report !== null, JSON.stringify(e));
  }
  // The reply the person sees for unexpected_failure is unchanged.
  assert.equal(r({ status: 500, code: 'unexpected_failure' }).error, RETRY);
  assert.equal(r({ status: 500, code: 'unexpected_failure' }).status, 400);
});

test('SF-1: the Sentry code tag forwards only identifier-shaped codes', () => {
  assert.equal(errs.safeAuthCode('unexpected_failure'), 'unexpected_failure');
  assert.equal(errs.safeAuthCode('Error for alice@example.com'), 'other');
  assert.equal(errs.safeAuthCode(undefined), '');
  assert.equal(errs.safeAuthCode(42), 'other');
});

test('N-4: signup-errors.ts names the test file that really exists', () => {
  const src = read('src/lib/auth/signup-errors.ts');
  for (const m of src.matchAll(/test\/[\w.-]+\.test\.mjs/g)) {
    assert.ok(existsSync(join(WEB, m[0])), `comment cites ${m[0]}, which does not exist`);
  }
  assert.match(src, /test\/signup-email-and-errors\.test\.mjs/);
});

test('route: an unmapped error is generic for the user, and reported with code and status only', async () => {
  globalThis.__signUpResult = { data: {}, error: { status: 418, code: 'something_new', message: 'leaky detail alice@example.com' } };
  const { POST } = await loadRoute();
  const res = await POST(req(body('alice@example.com')));
  assert.equal(res.body.error, errs.SIGNUP_GENERIC);
  assert.equal(globalThis.__sentry.length, 1);
  assert.doesNotMatch(JSON.stringify(globalThis.__sentry), /leaky|alice/, 'no provider text or address sent to Sentry');
});

// ── the form ───────────────────────────────────────────────────────────────────────────────
const { React, Form } = await loadLoginFormComponent();
const typeInto = async (dom, el, v) => dom.act(async () => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
async function signupWith(dom, email, reply) {
  process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY = 'test-site-key';
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init]); return { ok: false, status: 400, json: async () => reply }; };
  await dom.mount(React.createElement(Form, { initialMode: 'signup' }));
  await typeInto(dom, dom.find('input[type="email"]'), email);
  await typeInto(dom, dom.find('input[autocomplete="new-password"]'), 'correcthorse1battery');
  await dom.act(async () => { dom.find('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
  await dom.act(() => new Promise((r) => setTimeout(r, 0)));
  return calls;
}

const realFetch = globalThis.fetch;
const restoreFetch = () => { globalThis.fetch = realFetch; };

test('form: name!@gmail.com is caught on the form, before any request', async () => {
  await withDom(async (dom) => {
    try {
      const calls = await signupWith(dom, 'name!@gmail.com', {});
      assert.equal(calls.length, 0, 'no request for an address the form already refuses');
      assert.equal(dom.find('[role="alert"]')?.textContent, MSG);
    } finally { restoreFetch(); }
  });
});

test('form: the neutral reply shows its line and a Sign in link that switches to sign-in', async () => {
  await withDom(async (dom) => {
    try {
      const calls = await signupWith(dom, 'alice@example.com', { ok: false, code: 'SIGNUP_RETRY_OR_SIGN_IN', error: RETRY, sign_in: true });
      assert.equal(calls.length, 1);
      assert.equal(dom.find('[role="alert"]')?.textContent, RETRY);
      const link = dom.find('[data-testid="signup-sign-in"]');
      assert.ok(link, 'a Sign in link is offered');
      assert.equal(link.getAttribute('type'), 'button');
      await dom.act(async () => { link.click(); });
      assert.equal(dom.find('h1').textContent, 'Sign in');
      assert.equal(dom.find('[role="alert"]'), null);
    } finally { restoreFetch(); }
  });
});

test('form: a reply without sign_in shows no Sign in link', async () => {
  await withDom(async (dom) => {
    try {
      await signupWith(dom, 'alice@example.com', { ok: false, code: 'SIGNUP_WEAK_PASSWORD', error: errs.SIGNUP_WEAK_PASSWORD, sign_in: false });
      assert.equal(dom.find('[role="alert"]')?.textContent, errs.SIGNUP_WEAK_PASSWORD);
      assert.equal(dom.find('[data-testid="signup-sign-in"]'), null);
    } finally { restoreFetch(); }
  });
});

// ── 2A: the `signup` analytics event ───────────────────────────────────────────────────────
// Fired once, only after the route says ok, with NO props (nothing about who signed up).
test('form: a created account fires one `signup` event with no props; a refusal fires none', async () => {
  globalThis.__analyticsCalls = [];
  try {
    await withDom(async (dom) => {
      try {
        globalThis.__analyticsCalls.length = 0;
        await signupWith(dom, 'alice@example.com', { ok: false, code: 'SIGNUP_WEAK_PASSWORD', error: errs.SIGNUP_WEAK_PASSWORD });
        assert.deepEqual(globalThis.__analyticsCalls, [], 'no event for a refused signup');
      } finally { restoreFetch(); }
    });
    await withDom(async (dom) => {
      try {
        globalThis.__analyticsCalls.length = 0;
        process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY = 'test-site-key';
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, needs_confirmation: true }) });
        await dom.mount(React.createElement(Form, { initialMode: 'signup' }));
        await typeInto(dom, dom.find('input[type="email"]'), 'alice@example.com');
        await typeInto(dom, dom.find('input[autocomplete="new-password"]'), 'correcthorse1battery');
        await dom.act(async () => { dom.find('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
        await dom.act(() => new Promise((r) => setTimeout(r, 0)));
        assert.deepEqual(globalThis.__analyticsCalls, [['signup', {}]]);
        assert.doesNotMatch(JSON.stringify(globalThis.__analyticsCalls), /alice|example/, 'no address in the event');
      } finally { restoreFetch(); }
    });
  } finally { delete globalThis.__analyticsCalls; }
});
