// Emails v1.2 — every Resend template: shell, subject, lead, plain-text part
// and footer (EM-1, EM-2; emails v1.2 §2 and §3 R2–R7).
//
// Same ts-to-data-url pattern as emails.test.mjs: templates are transpiled and
// imported with ./shared rewired and the type-only billing import erased.

import { test, afterEach } from 'node:test';
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

const sharedUrl = dataUrl(toJs(readFileSync(join(WEB, 'src/lib/emails/templates/shared.ts'), 'utf8')));
const shared = await import(sharedUrl);

async function load(name) {
  let js = toJs(readFileSync(join(WEB, `src/lib/emails/templates/${name}.ts`), 'utf8'));
  js = js
    .replace(/from ['"]@\/lib\/billing\/types['"]/g, `from '${dataUrl('export {};')}'`)
    .replace(/from ['"]\.\/shared['"]/g, `from '${sharedUrl}'`);
  return import(dataUrl(js) + '#' + Math.random());
}

const { renderWelcome } = await load('welcome');
const { renderReceipt } = await load('receipt');
const { renderSubscriptionChanged } = await load('subscription-changed');
const { renderPlanEnding } = await load('plan-ending');
const { renderPlanEnded, endedOn } = await load('plan-ended');
const { renderPaymentFailed } = await load('payment-failed');

afterEach(() => {
  delete process.env.EMAIL_REPLY_TO;
});

const WHY_SERVICE = 'You got this email because you have a stem-loops account.';
const WHY_RECORDS = 'Keep this email for your records.';
const REPLY = 'Reply if something doesn’t work. A person reads it.';

// Every email in this PR, with the lead (first sentence of the body), the CTA,
// and the footer kind. `render` is a thunk so env changes are picked up.
const CASES = [
  {
    name: 'R2 welcome',
    render: () => renderWelcome({ plan_code: 'pro', period_end: '2027-01-15T00:00:00Z', monthly_job_quota: 50 }),
    subject: 'Welcome to stem-loops',
    lead: 'Thanks for subscribing. Your Pro plan is active, covers 50 tracks a month and renews on 15 January 2027.',
    cta: ['Upload a song', 'https://stem-loops.com/'],
    why: WHY_SERVICE,
  },
  {
    name: 'R3 receipt (credit pack)',
    render: () => renderReceipt({ amount_cad_cents: 500, plan_or_pack_label: '20 credits', invoice_url: null, kind: 'credit_pack', paid_on: '2026-11-13T10:00:00Z' }),
    subject: 'Receipt from stem-loops — $5.00 CAD',
    lead: 'We received your payment. Here is the summary.',
    cta: ['Go to your account', 'https://stem-loops.com/account'],
    why: WHY_RECORDS,
  },
  {
    name: 'R3 receipt (invoice)',
    render: () => renderReceipt({ amount_cad_cents: 499, plan_or_pack_label: 'Pro plan', invoice_url: 'https://invoice.stripe.com/i/x', kind: 'subscription', paid_on: '2026-11-13T10:00:00Z' }),
    subject: 'Receipt from stem-loops — $4.99 CAD',
    lead: 'We received your payment. Here is the summary.',
    cta: ['View invoice', 'https://invoice.stripe.com/i/x'],
    why: WHY_RECORDS,
  },
  {
    name: 'R4 active (re-subscriber)',
    render: () => renderSubscriptionChanged({ plan_code: 'pro', status: 'active', period_end: '2027-01-15T00:00:00Z', monthly_job_quota: 50 }),
    subject: 'Your stem-loops Pro plan is active',
    lead: 'Your Pro plan is active. It covers 50 tracks a month and renews on 15 January 2027.',
    cta: ['Manage your plan', 'https://stem-loops.com/account'],
    why: WHY_SERVICE,
  },
  {
    name: 'R4 switched',
    render: () => renderSubscriptionChanged({ plan_code: 'studio', previous_plan_code: 'pro', status: 'active', period_end: '2027-01-15T00:00:00Z', monthly_job_quota: 150 }),
    subject: 'Your stem-loops plan is now Studio',
    lead: 'Your plan changed from Pro to Studio. It covers 150 tracks a month and renews on 15 January 2027.',
    cta: ['Manage your plan', 'https://stem-loops.com/account'],
    why: WHY_SERVICE,
  },
  {
    name: 'R4 paused',
    render: () => renderSubscriptionChanged({ plan_code: 'pro', status: 'paused', period_end: '2027-01-15T00:00:00Z' }),
    subject: 'Your stem-loops Pro plan is paused',
    lead: 'Your Pro plan is paused, so your account uses the Free plan’s allowance until it resumes.',
    cta: ['Manage your plan', 'https://stem-loops.com/account'],
    why: WHY_SERVICE,
  },
  {
    name: 'R4 active again',
    render: () => renderSubscriptionChanged({ plan_code: 'pro', status: 'active', resumed: true, period_end: '2027-01-15T00:00:00Z', monthly_job_quota: 50 }),
    subject: 'Your stem-loops Pro plan is active',
    lead: 'Your Pro plan is active again. It covers 50 tracks a month and renews on 15 January 2027.',
    cta: ['Manage your plan', 'https://stem-loops.com/account'],
    why: WHY_SERVICE,
  },
  {
    name: 'R5 plan ending',
    render: () => renderPlanEnding({ plan_code: 'pro', period_end: '2027-01-15T00:00:00Z' }),
    subject: 'Your Pro plan ends on 15 January 2027',
    lead: 'You cancelled your Pro plan, so it won’t renew.',
    cta: ['Go to your account', 'https://stem-loops.com/account'],
    why: WHY_SERVICE,
  },
  {
    name: 'R6 plan ended',
    render: () => renderPlanEnded({ plan_code: 'studio', period_end: '2027-02-01T00:00:00Z', now: '2027-02-01T00:00:05Z', free_quota: 5 }),
    subject: 'Your stem-loops Studio plan was cancelled',
    lead: 'Your Studio plan has ended, and your account is on the Free plan now.',
    cta: ['Go to your account', 'https://stem-loops.com/account'],
    why: WHY_SERVICE,
  },
  {
    name: 'R7 payment failed',
    render: () => renderPaymentFailed({ plan_code: 'pro', grace_end: '2026-11-20T00:00:00Z', now: '2026-11-14T00:00:00Z', next_attempt: '2026-11-16T00:00:00Z' }),
    subject: 'Payment failed for your Pro plan',
    lead: 'We couldn’t charge your card for your Pro plan renewal.',
    cta: ['Update your card', 'https://stem-loops.com/account'],
    why: WHY_SERVICE,
  },
];

const count = (s, re) => (s.match(re) || []).length;

for (const c of CASES) {
  test(`${c.name}: subject, lead, dark shell, one lime CTA`, () => {
    const out = c.render();
    assert.equal(out.subject, c.subject);
    assert.ok(out.subject.length <= 50, `subject ≤ 50 chars: ${out.subject.length}`);
    const visibleHtml = out.html.replace(/^<!doctype html>/i, '');
    assert.doesNotMatch(out.subject + visibleHtml + out.text, /!/, 'no exclamation marks');
    // The lead is the first paragraph after the headline, in both parts.
    assert.ok(out.html.includes(shared.escapeHtml(c.lead)), 'lead in HTML');
    assert.ok(out.text.startsWith(`stem-loops\n\n${c.lead}\n\n`), 'plain text opens with wordmark then lead');
    // Dark shell (§2.4); old light shell and failing greys gone (E8).
    assert.match(out.html, /<body style="margin:0;padding:0;background:#0d0d0d;"/);
    assert.match(out.html, /<meta name="color-scheme" content="dark">/);
    assert.doesNotMatch(out.html, /#f5f5f5|#888\b|#888888|#666\b|#666666/i);
    // Exactly one lime element, and it is the CTA with this label and URL (A7).
    assert.equal(count(out.html, /bgcolor="#a3e635"/g), 1, 'one lime CTA cell');
    assert.equal(count(out.html, /#a3e635/g), 2, 'lime only on the CTA cell (bgcolor + background)');
    assert.ok(out.html.includes(`href="${shared.escapeHtml(c.cta[1])}"`), 'CTA href');
    assert.ok(out.html.includes(`>${shared.escapeHtml(c.cta[0])}</a>`), 'CTA label');
    // Wordmark: one colour, no lime dash.
    assert.match(out.html, /<p class="wordmark" style="[^"]*color:#ffffff;">stem-loops<\/p>/);
    // Service emails carry no prompt to buy (§2.8).
    assert.doesNotMatch(out.html + out.text, /\/pricing|\bBuy\b|See plans/);
    // Songs over 5 minutes are trimmed, not refused (#270).
    assert.doesNotMatch(out.html + out.text, /up to 5/i);
  });

  test(`${c.name}: plain-text part has the CTA line and the footer`, () => {
    const out = c.render();
    assert.ok(out.text.includes(`\n${c.cta[0]}: ${c.cta[1]}\n`), 'CTA line "<label>: <url>"');
    assert.doesNotMatch(out.text, /<[a-z][^>]*>/i, 'no HTML tags in the text part');
    assert.doesNotMatch(out.text, /&nbsp;|&amp;|&#39;/, 'no HTML entities in the text part');
    assert.ok(out.text.endsWith(`\n—\n${c.why}\nstem-loops.com\n`), 'footer without reply line when EMAIL_REPLY_TO unset');
    assert.ok(out.html.includes(shared.escapeHtml(c.why)), 'why line in HTML footer');
    assert.ok(!out.html.includes(shared.escapeHtml(REPLY)), 'no reply line in HTML when unset');
  });

  test(`${c.name}: reply line only when EMAIL_REPLY_TO is set (E10)`, () => {
    process.env.EMAIL_REPLY_TO = '   ';
    assert.ok(!c.render().text.includes(REPLY), 'blank EMAIL_REPLY_TO: no reply line');
    process.env.EMAIL_REPLY_TO = 'help@example.com';
    const out = c.render();
    assert.ok(out.text.endsWith(`\n—\n${c.why}\n${REPLY}\nstem-loops.com\n`));
    assert.ok(out.html.includes(shared.escapeHtml(REPLY)));
  });

  test(`${c.name}: deterministic for a fixed input`, () => {
    const a = c.render();
    const b = c.render();
    assert.deepEqual(a, b);
  });
}

// ── shared helpers ─────────────────────────────────────────────────────

test('formatDateProse: "15 January 2027", UTC, no leading zero', () => {
  assert.equal(shared.formatDateProse('2027-01-15T00:00:00Z'), '15 January 2027');
  assert.equal(shared.formatDateProse('2026-11-03T23:59:59Z'), '3 November 2026');
  assert.equal(shared.formatDateProse('2026-11-03T23:59:59-08:00'), '4 November 2026', 'UTC, not local');
  assert.equal(shared.formatDateProse(null), '');
  assert.equal(shared.formatDateProse('not a date'), '');
});

test('footerFor: why line by kind; reply line on EMAIL_REPLY_TO only', () => {
  assert.deepEqual(shared.footerFor('service', {}), [WHY_SERVICE]);
  assert.deepEqual(shared.footerFor('records', {}), [WHY_RECORDS]);
  assert.deepEqual(shared.footerFor('service', { EMAIL_REPLY_TO: ' ' }), [WHY_SERVICE]);
  assert.deepEqual(shared.footerFor('records', { EMAIL_REPLY_TO: 'a@b.c' }), [WHY_RECORDS, REPLY]);
});

test('shell escapes subject, preheader and footer; CTA URL goes through safeUrl', () => {
  const html = shared.shell({
    subject: '<s>',
    preheader: '"p"',
    bodyHtml: '',
    cta: { label: 'Go', url: 'javascript:alert(1)' },
    footer: ['<f>'],
  });
  assert.match(html, /<title>&lt;s&gt;<\/title>/);
  assert.match(html, /&quot;p&quot;/);
  assert.match(html, /&lt;f&gt;/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /href="#"/);
});

// ── R2 welcome ─────────────────────────────────────────────────────────

test('R2 welcome: quota per plan, renewal date in prose, one button, no /pricing', () => {
  const studio = renderWelcome({ plan_code: 'studio', period_end: '2027-03-02T00:00:00Z', monthly_job_quota: 150 });
  assert.match(studio.text, /Your Studio plan is active, covers 150 tracks a month and renews on 2 March 2027\./);
  assert.equal(count(studio.html, /<a href=/g), 3, 'CTA + account link + footer site link; no second button');
  // No plan details known: still true, no invented numbers.
  const bare = renderWelcome();
  assert.match(bare.text, /Thanks for subscribing\. Your plan is active\./);
  assert.doesNotMatch(bare.text, /tracks a month|renews on/);
  assert.match(bare.text, /Songs longer than 5 minutes use the first 5 minutes/);
});

// ── R3 receipt ─────────────────────────────────────────────────────────

test('R3 receipt: credits sentence only on the pack branch; date row ISO', () => {
  const pack = renderReceipt({ amount_cad_cents: 500, plan_or_pack_label: '20 credits', invoice_url: null, kind: 'credit_pack', paid_on: '2026-11-13T10:00:00Z' });
  assert.match(pack.text, /Credits never expire\./);
  assert.match(pack.text, /\nItem: 20 credits\nAmount: \$5\.00 CAD\nDate: 2026-11-13\n/);
  const inv = renderReceipt({ amount_cad_cents: 499, plan_or_pack_label: 'Pro plan', invoice_url: 'https://invoice.stripe.com/i/x', kind: 'subscription' });
  assert.doesNotMatch(inv.text + inv.html, /Credits never expire/);
  assert.match(inv.text, /Your invoice is on the Stripe page linked below\./);
  assert.match(inv.text, /Your account: https:\/\/stem-loops\.com\/account/);
  assert.doesNotMatch(inv.text, /\nDate:/, 'no date row without paid_on');
  // The account link on the invoice branch is a text link, not a second button.
  assert.equal(count(inv.html, /bgcolor="#a3e635"/g), 1);
});

// ── R4 ────────────────────────────────────────────────────────────────

test('R4: detail rows; paused has no Renews row', () => {
  const sw = renderSubscriptionChanged({ plan_code: 'studio', previous_plan_code: 'pro', status: 'active', period_end: '2027-01-15T00:00:00Z' });
  assert.match(sw.text, /\nPlan: Studio\nStatus: Active\nRenews: 2027-01-15\n/);
  assert.match(sw.text, /Your plan changed from Pro to Studio\. It renews on 15 January 2027\./, 'no quota: clause dropped, not invented');
  const paused = renderSubscriptionChanged({ plan_code: 'pro', status: 'paused', period_end: '2027-01-15T00:00:00Z' });
  assert.doesNotMatch(paused.text, /Renews/);
  assert.match(paused.text, /Status: Paused/);
});

test('R4: no copy promising retries or "payment problem" remains', () => {
  const src = readFileSync(join(WEB, 'src/lib/emails/templates/subscription-changed.ts'), 'utf8');
  assert.doesNotMatch(src, /retry automatically|Payment problem|keep access until/i);
});

// ── R5 plan ending ─────────────────────────────────────────────────────

test('R5 plan ending: prose date, "won’t renew", no "Renews", no promise to undo by default', () => {
  const out = renderPlanEnding({ plan_code: 'pro', period_end: '2027-01-15T00:00:00Z' });
  assert.match(out.text, /You keep Pro until 15 January 2027\. After that your account moves to the Free plan\./);
  assert.doesNotMatch(out.text + out.html, /Renews|is active/);
  assert.doesNotMatch(out.text, /Keep my plan|change your mind/, 'D4(a) unconfirmed: no undo promise');
  const undo = renderPlanEnding({ plan_code: 'pro', period_end: '2027-01-15T00:00:00Z', undo_available: true });
  assert.match(undo.text, /\nKeep my plan: https:\/\/stem-loops\.com\/account\n/);
  assert.match(undo.text, /If you change your mind before then/);
  const noDate = renderPlanEnding({ plan_code: 'studio', period_end: null });
  assert.equal(noDate.subject, 'Your stem-loops Studio plan won’t renew');
  assert.match(noDate.text, /until the end of the period you paid for/);
});

// ── R6 plan ended (E1) ─────────────────────────────────────────────────

test('R6 plan ended: ended date is never in the future', () => {
  const out = renderPlanEnded({ plan_code: 'pro', period_end: '2027-01-15T00:00:00Z', now: '2026-11-14T12:00:00Z' });
  assert.match(out.text, /\nPlan: Free\nPro ended: 2026-11-14\n/);
  assert.doesNotMatch(out.text + out.html, /2027-01-15|keep access|until/i);
  assert.equal(endedOn(null, '2026-11-14T00:00:00Z'), null);
  const noEnd = renderPlanEnded({ plan_code: 'pro', period_end: null, now: '2026-11-14T00:00:00Z' });
  assert.doesNotMatch(noEnd.text, /ended:/, 'row omitted when period_end is null');
});

test('R6 plan ended: Free quota from plans; no Free claim when another plan still entitles', () => {
  const free = renderPlanEnded({ plan_code: 'pro', period_end: null, now: '2026-11-14T00:00:00Z', free_quota: 5 });
  assert.match(free.text, /The Free plan covers 5 tracks a month\. Any credits you hold stay on your account\./);
  const unknownQuota = renderPlanEnded({ plan_code: 'pro', period_end: null, now: '2026-11-14T00:00:00Z' });
  assert.doesNotMatch(unknownQuota.text, /tracks a month/);
  const other = renderPlanEnded({ plan_code: 'pro', period_end: null, now: '2026-11-14T00:00:00Z', on_free: false });
  assert.doesNotMatch(other.text + other.html, /Free plan/);
  assert.match(other.text, /Your Pro plan has ended\. Your other plan is unchanged\./);
});

// ── R7 payment failed ──────────────────────────────────────────────────

test('R7 payment failed: in grace vs after grace; null next attempt omits the row', () => {
  const inGrace = renderPaymentFailed({ plan_code: 'pro', grace_end: '2026-11-20T00:00:00Z', now: '2026-11-19T23:59:59Z', next_attempt: '2026-11-16T00:00:00Z' });
  assert.match(inGrace.text, /Pro stays on until 20 November 2026\. If the payment still hasn’t gone through by then, your account moves to the Free plan\./);
  assert.match(inGrace.text, /\nNext attempt: 2026-11-16\n/);
  assert.match(inGrace.html, /Pro stays on until 20 November 2026\. Update your card to keep it\./, 'preheader');
  const after = renderPaymentFailed({ plan_code: 'pro', grace_end: '2026-11-20T00:00:00Z', now: '2026-11-20T00:00:00Z', next_attempt: null });
  assert.match(after.text, /Your account is on the Free plan until the payment goes through\./);
  assert.doesNotMatch(after.text, /stays on|Next attempt/);
  assert.match(after.html, /Update your card to get Pro back\./);
  assert.doesNotMatch(inGrace.text + after.text, /retry|automatically/i, 'no promise that depends on Stripe settings');
});
