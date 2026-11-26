// QW-6 + QW-7 on the REAL LoginForm (static render for first paint; happy-dom + real React
// events for the mount effects and clicks).
//
// QW-6: an email link that cannot finish in this browser now says so, opens the email options,
//       prefills the address remembered in this browser, and says what happened to a waiting
//       song link. A /login?code= that yields no session (one-time link opened elsewhere) no
//       longer leaves a blank form.
// QW-7: a password sign-in refused as "email not confirmed" offers "Resend confirmation email",
//       behind hCaptcha, through POST /api/auth/resend-confirmation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDom } from './helpers/dom.mjs';
import { loadLoginForm, loadLoginFormComponent } from './helpers/render-login-form.mjs';
import {
  LOGIN_ERROR_COPY, LINK_FAILED_LINK_KEPT, LINK_FAILED_REPASTE,
  RESEND_CONFIRMATION_LABEL, RESEND_CONFIRMATION_SENT, AUTH_NOT_CONFIRMED,
} from '../src/lib/auth/login-errors.ts';
import { REMEMBERED_EMAIL_KEY, rememberEmail, recallEmail, forgetEmail, REMEMBER_TTL_MS } from '../src/lib/auth/remembered-email.ts';

const render = await loadLoginForm();
const { React, Form } = await loadLoginFormComponent();

const NONCE = 'c'.repeat(32);
const PENDING_DEST = `/?resume=link&n=${NONCE}`;
const alertText = (html) => html.match(/<p role="alert"[^>]*>(.*?)<\/p>/)?.[1];
const alerts = (dom) => dom.findAll('[role="alert"]').map((n) => n.textContent);
const tick = () => new Promise((r) => setTimeout(r, 0));
function typeInto(input, value) {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
  set.call(input, value);
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
}
async function submit(dom) {
  await dom.act(async () => {
    const form = dom.find('form');
    form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
  });
}
async function settle(dom) {
  for (let i = 0; i < 4; i++) await dom.act(async () => { await tick(); });
}

// ─── copy on the error codes (first paint) ─────────────────────────────────────────────────

test('QW-6 ?error=auth_link_other_browser: says it was opened in a different browser and to sign in with email and password here', () => {
  const alert = alertText(render({ initialError: 'auth_link_other_browser' }));
  assert.equal(alert, LOGIN_ERROR_COPY.auth_link_other_browser);
  assert.match(alert, /^This link was opened in a different browser\. Sign in with your email and password here\./);
});

test('QW-6 ?error=auth_link_other_browser: the email form is open on first paint (password field visible)', () => {
  const html = render({ initialError: 'auth_link_other_browser' });
  assert.match(html, /aria-expanded="true"/);
  assert.doesNotMatch(html, /id="login-email" hidden/);
});

test('QW-6 auth_signin_link_failed copy names the different browser and the ways to sign in here', () => {
  assert.match(LOGIN_ERROR_COPY.auth_signin_link_failed, /different browser/);
  assert.match(LOGIN_ERROR_COPY.auth_signin_link_failed, /email and password here/);
});

test('QW-6 the existing auth_signup_link_failed copy is unchanged (#461)', () => {
  assert.equal(alertText(render({ initialError: 'auth_signup_link_failed' })), LOGIN_ERROR_COPY.auth_signup_link_failed);
});

// ─── /login?code= with no session ──────────────────────────────────────────────────────────

test('QW-6 /login?code=... and no session: shows the different-browser copy, opens email options, drops code, keeps return_to', async () => {
  globalThis.__loginStub = { session: async () => null };
  try {
    await withDom(async (dom) => {
      await dom.mount(React.createElement(Form, { returnTo: '/jobs/abc' }));
      await settle(dom);
      assert.deepEqual(alerts(dom), [LOGIN_ERROR_COPY.auth_signin_link_failed]);
      assert.equal(dom.find('[data-testid="login-email-toggle"]').getAttribute('aria-expanded'), 'true');
      const u = new URL(dom.window.location.href);
      assert.equal(u.searchParams.has('code'), false, 'the dead code is gone from the address bar');
      assert.equal(u.searchParams.get('return_to'), '/jobs/abc');
    }, { url: 'http://localhost:3000/login?return_to=%2Fjobs%2Fabc&code=deadbeef' });
  } finally {
    delete globalThis.__loginStub;
  }
});

test('QW-6 /login?code=... that DID sign in shows no error', async () => {
  globalThis.__loginStub = { session: async () => ({ user: { id: 'u1' } }) };
  try {
    await withDom(async (dom) => {
      await dom.mount(React.createElement(Form, {}));
      await settle(dom);
      assert.deepEqual(alerts(dom), []);
    }, { url: 'http://localhost:3000/login?code=good' });
  } finally {
    delete globalThis.__loginStub;
  }
});

test('QW-6 /login without ?code= never asks for a session and shows no error', async () => {
  let asked = 0;
  globalThis.__loginStub = { session: async () => { asked += 1; return null; } };
  try {
    await withDom(async (dom) => {
      await dom.mount(React.createElement(Form, {}));
      await settle(dom);
      assert.equal(asked, 0);
      assert.deepEqual(alerts(dom), []);
    }, { url: 'http://localhost:3000/login' });
  } finally {
    delete globalThis.__loginStub;
  }
});

// ─── prefill + pending link ────────────────────────────────────────────────────────────────

test('QW-6 a failed link prefills the address remembered in this browser', async () => {
  await withDom(async (dom) => {
    rememberEmail(dom.window.localStorage, 'jon@example.com');
    await dom.mount(React.createElement(Form, { initialError: 'auth_link_other_browser' }));
    await settle(dom);
    assert.equal(dom.find('input[type="email"]').value, 'jon@example.com');
  });
});

test('QW-6 no error code: the remembered address is NOT prefilled', async () => {
  await withDom(async (dom) => {
    rememberEmail(dom.window.localStorage, 'jon@example.com');
    await dom.mount(React.createElement(Form, {}));
    await settle(dom);
    assert.equal(dom.find('input[type="email"]').value, '');
  });
});

test('QW-6 waiting song link still in this browser: says it is kept, and the entry is NOT consumed', async () => {
  await withDom(async (dom) => {
    const entry = JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', at: Date.now(), nonce: NONCE });
    dom.window.localStorage.setItem('sl.pendingLink', entry);
    await dom.mount(React.createElement(Form, { initialError: 'auth_link_other_browser', returnTo: PENDING_DEST }));
    await settle(dom);
    assert.equal(dom.find('[data-testid="login-link-note"]')?.textContent, LINK_FAILED_LINK_KEPT);
    assert.equal(dom.window.localStorage.getItem('sl.pendingLink'), entry);
  });
});

test('QW-6 waiting song link held by the OTHER browser: says to paste it again after signing in', async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(Form, { initialError: 'auth_signup_link_failed', returnTo: PENDING_DEST }));
    await settle(dom);
    assert.equal(dom.find('[data-testid="login-link-note"]')?.textContent, LINK_FAILED_REPASTE);
  });
});

test('QW-6 no waiting song: no song note', async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(Form, { initialError: 'auth_link_other_browser', returnTo: '/account' }));
    await settle(dom);
    assert.equal(dom.find('[data-testid="login-link-note"]'), null);
  });
});

test('QW-6 a non-link error (auth_link_expired) gets no song note and no prefill', async () => {
  await withDom(async (dom) => {
    rememberEmail(dom.window.localStorage, 'jon@example.com');
    await dom.mount(React.createElement(Form, { initialError: 'auth_link_expired', returnTo: PENDING_DEST }));
    await settle(dom);
    assert.equal(dom.find('[data-testid="login-link-note"]'), null);
    assert.equal(dom.find('input[type="email"]').value, '');
  });
});

test('QW-6 remembered-email: TTL, blocked storage, forget', () => {
  const m = new Map();
  const store = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  rememberEmail(store, ' a@b.co ', 1000);
  assert.equal(recallEmail(store, 1000 + REMEMBER_TTL_MS), 'a@b.co');
  assert.equal(recallEmail(store, 1001 + REMEMBER_TTL_MS), null);
  assert.equal(m.has(REMEMBERED_EMAIL_KEY), false, 'a stale entry is removed');
  rememberEmail(store, 'a@b.co', 1000);
  forgetEmail(store);
  assert.equal(recallEmail(store, 1000), null);
  const blocked = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  rememberEmail(blocked, 'a@b.co');
  assert.equal(recallEmail(blocked), null);
});

// ─── QW-7: resend confirmation ─────────────────────────────────────────────────────────────

const NOT_CONFIRMED = { name: 'AuthApiError', code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' };

async function signInUnconfirmed(dom) {
  await dom.mount(React.createElement(Form, { returnTo: '/jobs/abc' }));
  await dom.act(async () => { dom.find('[data-testid="login-email-toggle"]').click(); });
  await dom.act(async () => { typeInto(dom.find('input[type="email"]'), 'new@example.com'); });
  await dom.act(async () => { typeInto(dom.find('input[type="password"]'), 'whatever-1'); });
  await submit(dom);
}

test('QW-7 "email not confirmed" shows the resend control; a wrong password does not', async () => {
  for (const [err, expect] of [[NOT_CONFIRMED, true], [{ name: 'AuthApiError', code: 'invalid_credentials', status: 400 }, false]]) {
    globalThis.__loginStub = { password: async () => ({ data: null, error: err }) };
    process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY = 'site';
    try {
      await withDom(async (dom) => {
        await signInUnconfirmed(dom);
        if (expect) assert.deepEqual(alerts(dom), [AUTH_NOT_CONFIRMED]);
        const btn = dom.findAll('button').find((b) => b.textContent === RESEND_CONFIRMATION_LABEL);
        assert.equal(!!btn, expect, err.code);
        if (expect) assert.equal(btn.disabled, true, 'disabled until the bot check passes');
      });
    } finally {
      delete globalThis.__loginStub;
      delete process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;
    }
  }
});

test('QW-7 resend posts email + token + return_to to the route and shows the no-enumeration notice', async () => {
  globalThis.__loginStub = { password: async () => ({ data: null, error: NOT_CONFIRMED }) };
  process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY = 'site';
  const widgets = [];
  globalThis.__hcaptchaStub = (p) => widgets.push(p);
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  try {
    await withDom(async (dom) => {
      await signInUnconfirmed(dom);
      await dom.act(async () => { widgets.at(-1).onVerify('tok-1'); });
      const btn = dom.findAll('button').find((b) => b.textContent === RESEND_CONFIRMATION_LABEL);
      assert.equal(btn.disabled, false);
      await dom.act(async () => { btn.click(); await tick(); });
      await settle(dom);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, '/api/auth/resend-confirmation');
      assert.equal(calls[0].init.method, 'POST');
      assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'new@example.com', hcaptcha_token: 'tok-1', return_to: '/jobs/abc' });
      assert.ok(dom.findAll('[role="status"]').some((n) => n.textContent === RESEND_CONFIRMATION_SENT));
      assert.equal(dom.find('[data-testid="login-resend"]'), null, 'the control goes once sent');
    });
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.__loginStub;
    delete globalThis.__hcaptchaStub;
    delete process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;
  }
});

test('QW-7 a 429 from the route shows its own line and keeps the control', async () => {
  globalThis.__loginStub = { password: async () => ({ data: null, error: NOT_CONFIRMED }) };
  process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY = 'site';
  const widgets = [];
  globalThis.__hcaptchaStub = (p) => widgets.push(p);
  const realFetch = globalThis.fetch;
  const LINE = 'Too many tries. Wait a few minutes and try again.';
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error_code: 'RATE_LIMITED', message: LINE }) });
  try {
    await withDom(async (dom) => {
      await signInUnconfirmed(dom);
      await dom.act(async () => { widgets.at(-1).onVerify('tok-1'); });
      const btn = dom.findAll('button').find((b) => b.textContent === RESEND_CONFIRMATION_LABEL);
      await dom.act(async () => { btn.click(); await tick(); });
      await settle(dom);
      assert.deepEqual(alerts(dom), [LINE]);
      const again = dom.findAll('button').find((b) => b.textContent === RESEND_CONFIRMATION_LABEL);
      assert.ok(again, 'still offered');
      assert.equal(again.disabled, true, 'a fresh bot check is needed');
    });
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.__loginStub;
    delete globalThis.__hcaptchaStub;
    delete process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;
  }
});
