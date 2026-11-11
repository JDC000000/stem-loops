// Terms copy gate.
//
// This page replaced one that made claims the code did not support, so every assertion below
// is tied to the file that makes it true. If a claim here stops being true, the named file is
// where it broke — and if that file changes, this gate is the thing that should go red.
//
// Asserted on RENDERED OUTPUT, never on source text: a source-text assertion is satisfied by
// a comment, a string literal, a template or a regex, and this repo has been bitten by each.
// See test/helpers/render-landing-page.mjs for the full argument and for the three rendering
// channels that remain uncovered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from './helpers/render-landing-page.mjs';
import { assertNoBannedClaims, assertSays } from './legal-copy-shared.mjs';

const TERMS = 'app/(landing)/terms/page.tsx';

test('terms: the old false claims cannot come back, in text or in metadata', async () => {
  assertNoBannedClaims(assert, await renderPage(TERMS), 'terms');
});

test('terms: states the account rule the code actually implements', async () => {
  const page = await renderPage(TERMS);
  // TRUE: src/app/api/jobs/route.ts has ZERO 401s and an anonymous INSERT branch that omits
  // user_id (:183-190); src/app/api/uploads/route.ts never calls getUser(); and
  // src/components/landing/ToolForm.tsx has no client-side auth gate.
  assertSays(assert, page, 'You can start a job without an account', 'terms');
  // TRUE: src/app/jobs/[id]/page.tsx:32-33 — getUser() then redirect('/login?return_to=…').
  assertSays(assert, page, 'You need an account to open the player', 'terms');
});

test('terms: states the 5-minute cap AND that it bites at submit', async () => {
  const page = await renderPage(TERMS);
  // Both halves are now true, and they became true at different times — which is why they
  // are asserted separately rather than as one sentence.
  //
  // The NUMBER: src/lib/play/types.ts:62 MAX_TRACK_SEC = 300, and the worker's
  // MAX_UPLOAD_DURATION_SEC_DEFAULT = 300.0 (apps/worker/src/worker/pipeline.py:134).
  assertSays(assert, page, 'Tracks up to 5 minutes', 'terms');
  // WHERE IT BITES: refusal at SUBMIT is what PR #202 added (merged 2026-11-11 17:21:34Z,
  // 0167553) — src/lib/upload-duration.ts probes the duration in the browser before the
  // bytes are uploaded. Before #202 the default was 600.0 and the only refusal happened in
  // the worker, after submission; this sentence was false and was held back for it.
  assertSays(assert, page, 'Longer tracks are refused when you submit them', 'terms');
});

test('terms: discloses the retention exception, and scopes it the way the sweep does', async () => {
  const page = await renderPage(TERMS);
  assertSays(assert, page, 'deleted after 24 hours', 'terms');
  // apps/worker/src/worker/cleanup.py:_sweep_expired_jobs tries `DELETE FROM jobs` FIRST and
  // only falls through to `_anonymise_job` on a ForeignKeyViolation. Exactly two foreign keys
  // can raise it: credit_consumption.job_id ON DELETE RESTRICT (migration 013:246) and
  // chord_edits.job_id with no ON DELETE clause (migration 025:39). Every other job row is
  // deleted outright, so the exception is SCOPED, not universal — an earlier draft said "each
  // job" and was wrong in the alarming direction.
  assertSays(assert, page, 'charged a credit', 'terms');
  assertSays(assert, page, 'Every other job is deleted outright', 'terms');
});

test('terms: metadata is the terms metadata, not another page’s', async () => {
  const page = await renderPage(TERMS);
  // The ban list already runs over metadata. This pins the positive side: a page whose
  // metadata was copied from elsewhere would pass every ban and still mis-describe itself in
  // the one place search results read.
  assert.match(page.metaSpaced, /The short terms for using stem-loops\./);
  assert.match(page.metaSpaced, /\/terms/);
});
