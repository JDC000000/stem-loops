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
  // WHERE IT BITES, stated WITHOUT overclaiming. #202 (merged 2026-11-11 17:21:34Z, 0167553)
  // added a browser probe in src/lib/upload-duration.ts, but that file's own header is blunt
  // that it FAILS OPEN: an unmeasurable container (it names flac and aiff), a header
  // reporting NaN/Infinity, a slow decode, or a direct call to POST /api/uploads with no
  // browser at all — every one of those proceeds and is refused later, by the worker. So
  // "refused when you submit them" was overstated; "not accepted" is true of both paths.
  assertSays(assert, page, 'Longer tracks are not accepted', 'terms');
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
  // The sweep leaves THREE kinds of survivor, not one (see the privacy gate for the
  // derivation). The terms carry the short form and point at the privacy notice for the
  // detail, so both of the other two are named here as well.
  assertSays(assert, page, 'chord corrections you saved', 'terms');
  assertSays(assert, page, 'counters and diagnostics', 'terms');
});

test('terms: metadata is the terms metadata, not another page’s', async () => {
  const page = await renderPage(TERMS);
  // The ban list already runs over metadata. This pins the positive side: a page whose
  // metadata was copied from elsewhere would pass every ban and still mis-describe itself in
  // the one place search results read.
  assert.match(page.metaSpaced, /The short terms for using stem-loops\./);
  assert.match(page.metaSpaced, /\/terms/);
});
