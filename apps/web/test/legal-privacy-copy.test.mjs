// Privacy copy gate.
//
// The reason this PR exists: the previous privacy notice named Replicate, R2, Fly, Vercel,
// Supabase, Sentry and a proxy — and omitted every processor added since. Audio was being
// sent to Klangio with no disclosure at all, and the account path reached hCaptcha, Google,
// Stripe and Resend undisclosed. A gate that lets a processor be dropped again silently is
// worth nothing, so EVERY name in PROCESSORS is asserted — see that list for why asserting
// only the new ones was itself an overclaim.
//
// Asserted on RENDERED OUTPUT in both normalisations, plus `metadata`. See
// test/helpers/render-landing-page.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from './helpers/render-landing-page.mjs';
import { assertNoBannedClaims, assertSays, PROCESSORS } from './legal-copy-shared.mjs';

const PRIVACY = 'app/(landing)/privacy/page.tsx';

test('privacy: the old false claims cannot come back, in text or in metadata', async () => {
  assertNoBannedClaims(assert, await renderPage(PRIVACY), 'privacy');
});

test('privacy: EVERY processor is named, one assertion per name', async () => {
  const page = await renderPage(PRIVACY);
  for (const [name, why] of PROCESSORS) {
    assertSays(assert, page, name, `privacy [${why}]`);
  }
  // The proxy has no vendor name in the copy on purpose (it is "a proxy provider"), so it is
  // pinned by its sentence instead of by a name. Deleting it was one of the four silent
  // deletions the reviewer got past the previous version of this file.
  assertSays(assert, page, 'proxy provider', 'privacy [downloader/ytdlp_client.py]');
});

test('privacy: states the account rule the code actually implements', async () => {
  const page = await renderPage(PRIVACY);
  assertSays(assert, page, 'You can start a job without an account', 'privacy');
  assertSays(assert, page, 'you need one to open the player', 'privacy');
});

test('privacy: the job-link sentence does not overstate the gate', async () => {
  const page = await renderPage(PRIVACY);
  // THIS TEST USED TO PIN THE FALSE VERSION. It required the words "and an account", which
  // made a true sentence un-shippable until the gate was changed — the worst shape a gate
  // can take. What is actually true:
  //   - src/app/jobs/[id]/page.tsx:32-33 redirects a signed-out visitor. That is the PAGE.
  //   - src/app/api/jobs/[id]/route.ts, .../stems/route.ts and .../play-chords/route.ts
  //     contain ZERO getUser() calls between them. The stems route returns one presigned R2
  //     URL per stem to anyone holding the UUID, behind an IP rate limit and nothing else,
  //     and its header names a leaked UUID as the threat.
  //   - A job is not owner-scoped either: the SELECT has no user_id filter, the web tier
  //     connects as stemloops_app, and `jobs` carries no auth.uid() policy
  //     (apps/worker/migrations/009_rls_catchup.sql:22-24).
  // So the link IS the credential, and "and an account" is banned above.
  assertSays(assert, page, 'A job\u2019s link is the only thing protecting it', 'privacy');
  assertSays(assert, page, 'with no account at all', 'privacy');
});

test('privacy: discloses every record that outlives the 24 hours', async () => {
  const page = await renderPage(PRIVACY);
  assertSays(assert, page, 'deleted after 24 hours', 'privacy');
  // apps/worker/src/worker/cleanup.py deletes exactly three things: the R2 objects, `loops`,
  // and the `jobs` row (cascading `job_events`) — plus a prune of `upload_rate_events`. It
  // touches NOTHING else. An earlier cut of this page disclosed only the job shell, which is
  // one of three survivors.
  //
  // 1. the shell, when a FK refuses the delete — credit_consumption ON DELETE RESTRICT
  //    (migration 013:246) or chord_edits (migration 025:39, no ON DELETE clause).
  assertSays(assert, page, 'charged a credit', 'privacy');
  assertSays(assert, page, 'the stems and loop length you chose', 'privacy');
  // 2. chord_edits itself, which the retention sweep never touches. Its only erase path is
  //    account deletion (delete_chord_edits_for_user, migration 031). It stores track_hash,
  //    the time range, original_label (what we estimated) and corrected_label — so the
  //    earlier blanket "what we estimated from it is removed" was FALSE for this row.
  assertSays(assert, page, 'Chord corrections you save', 'privacy');
  assertSays(assert, page, 'until you delete your account', 'privacy');
  // 3. usage_events (job_id ON DELETE SET NULL, never swept) and fetch_attempts (never
  //    swept; holds a sha256 of the video id, not the URL). Neither was disclosed at all.
  assertSays(assert, page, 'Counters and diagnostics', 'privacy');
  assertSays(assert, page, 'one-way hash of the video id', 'privacy');
});

test('privacy: metadata is the privacy metadata, not another page’s', async () => {
  const page = await renderPage(PRIVACY);
  assert.match(page.metaSpaced, /What stem-loops stores, for how long, and who processes it\./);
  assert.match(page.metaSpaced, /\/privacy/);
});
