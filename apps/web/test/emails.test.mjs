// Emails test — V3 Phase 1a (TSD §M1/M2/M3).
//
// Mocks global fetch and asserts:
//   - sendEmail hits POST https://api.resend.com/emails with Bearer auth and
//     a body carrying from/to/subject/html.
//   - On 5xx the client retries exactly once and succeeds on the retry.
//   - On 4xx the client does NOT retry, logs, and returns {ok:false} without
//     throwing.
//   - On a network error (fetch throws) the client retries once and still
//     returns {ok:false} without throwing when both attempts fail.
//   - Template renderers produce deterministic HTML for a fixed input, with
//     a subject that reflects the plan/status (subscription-changed) and
//     amount (receipt).
//
// Uses the same ts-to-data-url pattern as test/sentry-guard.test.mjs so
// `@sentry/nextjs` can be stubbed without pulling in the SDK.

import { test } from 'node:test';
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

const sentryStub = dataUrl(`
  export const captureException = () => {};
`);

async function loadResend() {
  let js = toJs(readFileSync(join(WEB, 'src/lib/emails/resend.ts'), 'utf8'));
  js = js.replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentryStub}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

/** Build a scripted fetch mock. Each call pops one response (or throws). */
function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (!responses.length) throw new Error('mockFetch: ran out of scripted responses');
    const r = responses.shift();
    if (r.throw) throw r.throw;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? '',
    };
  };
  return calls;
}

function setEnv({ key = 'test_api_key', from, sandbox } = {}) {
  process.env.RESEND_API_KEY = key;
  if (from === undefined) delete process.env.RESEND_FROM;
  else process.env.RESEND_FROM = from;
  if (sandbox === undefined) delete process.env.RESEND_SANDBOX;
  else process.env.RESEND_SANDBOX = sandbox;
}

// ── resend.ts ──────────────────────────────────────────────────────────

test('sendEmail: posts to Resend API with Bearer auth and JSON body', async () => {
  setEnv({ key: 're_test_123' });
  const calls = mockFetch([{ status: 200, json: { id: 'em_abc' } }]);
  const { sendEmail } = await loadResend();
  const res = await sendEmail({
    to: 'jon@example.com',
    subject: 'Hi',
    html: '<p>Hello</p>',
    tag: 'welcome',
    idempotencyKey: 'welcome:u-1',
  });
  assert.equal(res.ok, true);
  assert.equal(res.id, 'em_abc');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_123');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.to, 'jon@example.com');
  assert.equal(body.subject, 'Hi');
  assert.equal(body.html, '<p>Hello</p>');
  assert.equal(body.from, 'stem-loops <notifications@stem-loops.com>');
  assert.deepEqual(body.tags, [{ name: 'template', value: 'welcome' }]);
});

// Audit F20: the reply-to comes from EMAIL_REPLY_TO and is omitted when that is unset or
// blank, so no address is ever invented.
test('sendEmail: reply_to comes from EMAIL_REPLY_TO, and is omitted when unset (F20)', async () => {
  const send = async () => {
    const calls = mockFetch([{ status: 200, json: { id: 'em_rt' } }]);
    const { sendEmail } = await loadResend();
    await sendEmail({ to: 'a@b.com', subject: 's', html: 'h', tag: 'welcome', idempotencyKey: 'k' });
    return JSON.parse(calls[0].init.body);
  };
  setEnv();
  try {
    delete process.env.EMAIL_REPLY_TO;
    assert.equal('reply_to' in (await send()), false, 'unset: no reply_to');
    process.env.EMAIL_REPLY_TO = '   ';
    assert.equal('reply_to' in (await send()), false, 'blank: no reply_to');
    process.env.EMAIL_REPLY_TO = ' help@example.com ';
    assert.equal((await send()).reply_to, 'help@example.com');
  } finally {
    delete process.env.EMAIL_REPLY_TO;
  }
});

// E9 (emails v1.2 §2.5): the plain-text part goes out as Resend `text`, and
// is omitted (not sent empty) when a caller has none.
test('sendEmail: passes the plain-text part as `text`, omitted when absent (E9)', async () => {
  setEnv();
  let calls = mockFetch([{ status: 200, json: { id: 'em_t' } }]);
  let { sendEmail } = await loadResend();
  await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>', text: 'stem-loops\n\nh', tag: 'welcome', idempotencyKey: 'k' });
  assert.equal(JSON.parse(calls[0].init.body).text, 'stem-loops\n\nh');
  calls = mockFetch([{ status: 200, json: { id: 'em_t2' } }]);
  ({ sendEmail } = await loadResend());
  await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>', tag: 'welcome', idempotencyKey: 'k' });
  assert.equal('text' in JSON.parse(calls[0].init.body), false);
});

// PR #38 Lens A follow-up: every send carries an Idempotency-Key header so
// a retried-after-timeout send cannot double-deliver.
test('sendEmail: sets Idempotency-Key header from idempotencyKey (PR #38 Lens A)', async () => {
  setEnv();
  const calls = mockFetch([{ status: 200, json: { id: 'em_idem' } }]);
  const { sendEmail } = await loadResend();
  const res = await sendEmail({
    to: 'a@b.com',
    subject: 's',
    html: 'h',
    tag: 'receipt',
    idempotencyKey: 'receipt-sub:in_123',
  });
  assert.equal(res.ok, true);
  assert.equal(
    calls[0].init.headers['Idempotency-Key'],
    'receipt-sub:in_123',
    'Idempotency-Key header must carry the caller-supplied key verbatim',
  );
});

test('sendEmail: Idempotency-Key is preserved across the retry on 5xx', async () => {
  setEnv();
  const calls = mockFetch([
    { status: 502, text: 'bad gateway' },
    { status: 200, json: { id: 'em_retry_ok' } },
  ]);
  const { sendEmail } = await loadResend();
  const res = await sendEmail({
    to: 'a@b.com',
    subject: 's',
    html: 'h',
    tag: 'welcome',
    idempotencyKey: 'welcome:u-7',
  });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2, 'should have retried once');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'welcome:u-7');
  assert.equal(
    calls[1].init.headers['Idempotency-Key'],
    'welcome:u-7',
    'the retry MUST reuse the same key so Resend dedupes it to the original',
  );
});

test('sendEmail: retries exactly once on 5xx and succeeds on retry', async () => {
  setEnv();
  const calls = mockFetch([
    { status: 502, text: 'bad gateway' },
    { status: 200, json: { id: 'em_retry_ok' } },
  ]);
  const { sendEmail } = await loadResend();
  const res = await sendEmail({
    to: 'a@b.com', subject: 's', html: 'h', tag: 'welcome', idempotencyKey: 'k',
  });
  assert.equal(res.ok, true);
  assert.equal(res.id, 'em_retry_ok');
  assert.equal(calls.length, 2, 'should have retried once');
});

test('sendEmail: returns {ok:false} on 4xx without retry, no throw', async () => {
  setEnv();
  const calls = mockFetch([{ status: 422, text: 'from domain not verified' }]);
  const { sendEmail } = await loadResend();
  const res = await sendEmail({
    to: 'bad', subject: 's', html: 'h', tag: 'receipt', idempotencyKey: 'k',
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 422);
  assert.match(res.error, /422/);
  assert.equal(calls.length, 1, 'must not retry on 4xx');
});

test('sendEmail: survives fetch throwing (network error) and retries once', async () => {
  setEnv();
  const calls = mockFetch([
    { throw: new Error('ECONNRESET') },
    { throw: new Error('ECONNRESET again') },
  ]);
  const { sendEmail } = await loadResend();
  const res = await sendEmail({
    to: 'a@b.com', subject: 's', html: 'h', tag: 'welcome', idempotencyKey: 'k',
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /ECONNRESET/);
  assert.equal(calls.length, 2);
});

test('sendEmail: skips gracefully when RESEND_API_KEY is unset (no throw, no fetch)', async () => {
  delete process.env.RESEND_API_KEY;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error('should not be called');
  };
  const { sendEmail } = await loadResend();
  const res = await sendEmail({
    to: 'a@b.com', subject: 's', html: 'h', tag: 'welcome', idempotencyKey: 'k',
  });
  assert.equal(res.ok, false);
  assert.equal(fetched, false);
  assert.match(res.error ?? '', /RESEND_API_KEY/);
});

test('sendEmail: honors RESEND_SANDBOX=1 fallback sender', async () => {
  setEnv({ sandbox: '1' });
  const calls = mockFetch([{ status: 200, json: { id: 'em_1' } }]);
  const { sendEmail } = await loadResend();
  await sendEmail({
    to: 'a@b.com', subject: 's', html: 'h', tag: 'welcome', idempotencyKey: 'k',
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.from, 'onboarding@resend.dev');
});

// ── templates ──────────────────────────────────────────────────────────

async function loadTemplate(name) {
  const src = readFileSync(join(WEB, `src/lib/emails/templates/${name}.ts`), 'utf8');
  let js = toJs(src);
  // welcome & receipt only import ./shared; subscription-changed imports
  // @/lib/billing/types for the plan/status types, which are erased at
  // transpile time — but the import source stays in the emitted JS, so we
  // rewrite it to an empty stub.
  js = js.replace(
    /from ['"]@\/lib\/billing\/types['"]/g,
    `from '${dataUrl('export {};')}'`,
  );
  js = js.replace(/from ['"]\.\/shared['"]/g, `from '${sharedUrl}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}
const sharedUrl = dataUrl(
  toJs(readFileSync(join(WEB, 'src/lib/emails/templates/shared.ts'), 'utf8')),
);

// D3 (emails v1.2 R2): the subscriber welcome is a service email, so the
// "/pricing" link is gone. The /account pin holds.
test('welcome template is deterministic, links to /account and not to /pricing (D3)', async () => {
  const { renderWelcome } = await loadTemplate('welcome');
  const a = renderWelcome();
  const b = renderWelcome();
  assert.equal(a.subject, b.subject);
  assert.equal(a.html, b.html);
  assert.equal(a.subject, 'Welcome to stem-loops');
  assert.match(a.html, /https:\/\/stem-loops\.com\/account/);
  assert.doesNotMatch(a.html, /\/pricing/);
});

test('subscription-changed: subject reflects plan and status', async () => {
  const { renderSubscriptionChanged } = await loadTemplate('subscription-changed');
  const active = renderSubscriptionChanged({
    plan_code: 'pro',
    status: 'active',
    period_end: '2027-01-15T00:00:00Z',
  });
  assert.match(active.subject, /Pro plan is active/i);
  assert.match(active.html, /2027-01-15/);

});

// The cancelled pins moved with the copy: R6 (plan ended) is its own template
// now (emails v1.2 R6). `now` is injected and after period_end, so the ended
// date is period_end and the /2027-02-01/ pin holds.
test('plan-ended: subject reflects plan, ended date is pinned (was subscription-changed canceled)', async () => {
  const { renderPlanEnded } = await loadTemplate('plan-ended');
  const canceled = renderPlanEnded({
    plan_code: 'studio',
    period_end: new Date('2027-02-01T00:00:00Z'),
    now: new Date('2027-02-02T00:00:00Z'),
  });
  assert.match(canceled.subject, /Studio plan was cancelled/i);
  assert.match(canceled.html, /2027-02-01/);
  // E1: an ended plan must never promise continued access.
  assert.doesNotMatch(canceled.html, /keep access until/i);
  assert.doesNotMatch(canceled.text, /keep access until/i);
});

test('subscription-changed: output is deterministic for a fixed input', async () => {
  const { renderSubscriptionChanged } = await loadTemplate('subscription-changed');
  // past_due has no R4 copy any more (R7 owns it); paused is the stand-in.
  const input = { plan_code: 'pro', status: 'paused', period_end: '2027-03-01T00:00:00Z' };
  const a = renderSubscriptionChanged(input);
  const b = renderSubscriptionChanged(input);
  assert.equal(a.html, b.html);
  assert.equal(a.subject, b.subject);
});

test('receipt: renders CAD amount, label, and hosted invoice URL', async () => {
  const { renderReceipt } = await loadTemplate('receipt');
  const out = renderReceipt({
    amount_cad_cents: 1299,
    plan_or_pack_label: '20 credits (credits_20)',
    invoice_url: 'https://invoice.stripe.com/i/acct_X/live_Y',
  });
  assert.match(out.subject, /\$12\.99 CAD/);
  assert.match(out.html, /\$12\.99 CAD/);
  assert.match(out.html, /20 credits \(credits_20\)/);
  assert.match(out.html, /https:\/\/invoice\.stripe\.com\/i\/acct_X\/live_Y/);
});

test('receipt: falls back gracefully when invoice_url is null', async () => {
  const { renderReceipt } = await loadTemplate('receipt');
  const out = renderReceipt({
    amount_cad_cents: 500,
    plan_or_pack_label: 'pro plan renewal',
    invoice_url: null,
  });
  assert.match(out.html, /\$5\.00 CAD/);
  assert.doesNotMatch(out.html, /View invoice/);
});

test('receipt: rejects javascript: URLs in invoice_url (escapes to #)', async () => {
  const { renderReceipt } = await loadTemplate('receipt');
  const out = renderReceipt({
    amount_cad_cents: 100,
    plan_or_pack_label: 'x',
    // eslint-disable-next-line no-script-url
    invoice_url: 'javascript:alert(1)',
  });
  assert.doesNotMatch(out.html, /javascript:/i);
});

// PR #38 Lens B follow-up: an invoice URL that contains a double-quote (or
// angle brackets, after safeUrl accepted it) must be attribute-escaped so it
// cannot break out of the href="" and inject markup.
test('receipt: escapes double-quotes in invoice_url attribute (PR #38 Lens B)', async () => {
  const { renderReceipt } = await loadTemplate('receipt');
  const out = renderReceipt({
    amount_cad_cents: 500,
    plan_or_pack_label: 'test',
    invoice_url: 'https://invoice.stripe.com/live?x="onmouseover=alert(1)&y=1',
  });
  // Raw quote must not appear unescaped inside the href attribute: a simple
  // `" onmouseover` substring would prove the escape failed.
  assert.doesNotMatch(
    out.html,
    /x="onmouseover/,
    'raw double-quote injection must not reach the href attribute',
  );
  // The quote must land as the escaped form instead.
  assert.match(
    out.html,
    /x=&quot;onmouseover/,
    'double-quote in URL must be rendered as &quot; in the href attribute',
  );
});

test('receipt: escapes angle-bracket injection attempt in invoice_url', async () => {
  const { renderReceipt } = await loadTemplate('receipt');
  const out = renderReceipt({
    amount_cad_cents: 100,
    plan_or_pack_label: 'x',
    invoice_url: 'https://invoice.stripe.com/live</a><script>alert(1)</script>',
  });
  assert.doesNotMatch(out.html, /<script>alert\(1\)/, 'unescaped <script> must not appear');
  assert.match(out.html, /&lt;script&gt;alert\(1\)/, 'script tag must be rendered as text');
});

test('shared escapeHtml and formatCadCents', async () => {
  const mod = await import(dataUrl(toJs(readFileSync(join(WEB, 'src/lib/emails/templates/shared.ts'), 'utf8'))) + '#' + Math.random());
  assert.equal(mod.escapeHtml('<script>&"\'</script>'), '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
  assert.equal(mod.formatCadCents(1999), '$19.99 CAD');
  assert.equal(mod.formatCadCents(0), '$0.00 CAD');
  assert.equal(mod.formatCadCents(100.6), '$1.01 CAD'); // rounds
  assert.equal(mod.formatDateUtc('2026-11-03T20:00:00Z'), '2026-11-03');
  assert.equal(mod.safeUrl('https://x.com'), 'https://x.com');
  assert.equal(mod.safeUrl('javascript:alert(1)'), '#');
  assert.equal(mod.safeUrl(null), '#');
});
