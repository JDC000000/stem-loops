// Privacy copy gate.
//
// The reason this PR exists: the previous privacy notice named Replicate, R2, Fly, Vercel,
// Supabase, Sentry and a proxy — and omitted every processor added since. Audio was being
// sent to Klangio with no disclosure at all. A gate that lets a processor be dropped again
// silently is worth nothing, so the processor list is asserted name by name, with the file
// that proves each one receives something.
//
// Asserted on RENDERED OUTPUT in both normalisations, plus `metadata`. See
// test/helpers/render-landing-page.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from './helpers/render-landing-page.mjs';
import { assertNoBannedClaims, assertSays } from './legal-copy-shared.mjs';

const PRIVACY = 'app/(landing)/privacy/page.tsx';

test('privacy: the old false claims cannot come back, in text or in metadata', async () => {
  assertNoBannedClaims(assert, await renderPage(PRIVACY), 'privacy');
});

test('privacy: every processor that receives audio is named', async () => {
  const page = await renderPage(PRIVACY);
  // apps/worker/src/worker/replicate_client.py:44 — POSTs to api.replicate.com, htdemucs_6s.
  assertSays(assert, page, 'Replicate', 'privacy');
  // apps/worker/src/worker/chord_providers/klangio.py:12,574 — POST /chord-recognition,
  // multipart, file field `file`. THE GAP THIS PR CLOSES: the old page named no chord
  // processor at all while the audio was already going there.
  assertSays(assert, page, 'Klangio', 'privacy');
});

test('privacy: every processor that touches the account is named', async () => {
  const page = await renderPage(PRIVACY);
  // src/lib/hcaptcha.ts + src/app/api/auth/signup/route.ts:15,37 — verifyHcaptchaToken is
  // awaited on the signup path; src/middleware.ts:110-111 already allows hcaptcha.com in CSP.
  assertSays(assert, page, 'hCaptcha', 'privacy');
  // src/components/LoginForm.tsx:135-136 — signInWithOAuth({ provider: 'google' }).
  assertSays(assert, page, 'Google', 'privacy');
  // src/lib/billing/providers/stripe.ts + app/api/billing/{checkout,portal,webhook}. Stripe
  // receives the email address. Added in review: naming Klangio, hCaptcha and Google while
  // omitting Stripe would have left the same disclosure gap half-closed.
  assertSays(assert, page, 'Stripe', 'privacy');
});

test('privacy: states the account rule the code actually implements', async () => {
  const page = await renderPage(PRIVACY);
  assertSays(assert, page, 'You can start a job without an account', 'privacy');
  assertSays(assert, page, 'you need one to open the player', 'privacy');
});

test('privacy: the job-link sentence matches what the gate really gates', async () => {
  const page = await renderPage(PRIVACY);
  // Established against the code, not assumed: a job is NOT owner-scoped.
  //   - src/app/api/jobs/[id]/route.ts:24-28 selects `WHERE id = $1 AND expires_at > now()`
  //     with no user_id filter and no getUser() call;
  //   - src/lib/db.ts:20-26 connects as stemloops_app over a plain pg Pool, and `jobs` is
  //     marked rls-backend-only with a single FOR ALL USING (true) policy and no auth.uid()
  //     policy (apps/worker/migrations/009_rls_catchup.sql:22-24, 011_role_catchup.sql), so
  //     RLS cannot scope these reads;
  //   - JobView.tsx performs no owner check.
  // So the gate on /jobs/[id] is "an account", not "your account", and anonymous jobs behave
  // identically (user_id stays NULL and is never read on the open path). The sentence says
  // "and an account" for exactly that reason.
  assertSays(assert, page, 'Anyone with a job’s link and an account can open it', 'privacy');
});

test('privacy: discloses the retention exception, and scopes it the way the sweep does', async () => {
  const page = await renderPage(PRIVACY);
  assertSays(assert, page, 'deleted after 24 hours', 'privacy');
  // See the matching terms assertion for the full derivation. The short version:
  // cleanup.py:_sweep_expired_jobs DELETEs the row and only anonymises when a foreign key
  // refuses — credit_consumption (ON DELETE RESTRICT) or chord_edits (no ON DELETE clause).
  assertSays(assert, page, 'charged a credit', 'privacy');
  assertSays(assert, page, 'Every other job is deleted outright', 'privacy');
  // _anonymise_job's own docstring lists what SURVIVES: id, status, timestamps,
  // requested_stems, user_id, the Replicate prediction id and job_events. An earlier draft
  // listed only id/status/timestamps/account, which read as an exhaustive inventory while
  // omitting three kept fields — under-inclusive in a notice is the same defect as false.
  assertSays(assert, page, 'the stems and loop length you chose', 'privacy');
});

test('privacy: metadata is the privacy metadata, not another page’s', async () => {
  const page = await renderPage(PRIVACY);
  assert.match(page.metaSpaced, /What stem-loops stores, for how long, and who processes it\./);
  assert.match(page.metaSpaced, /\/privacy/);
});
