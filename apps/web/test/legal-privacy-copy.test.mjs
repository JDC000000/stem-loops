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
import { assertNoBannedClaims, assertSays, section, PROCESSORS } from './legal-copy-shared.mjs';

const PRIVACY = 'app/(landing)/privacy/page.tsx';

test('privacy: the four banned sentences match nothing in text or metadata', async () => {
  assertNoBannedClaims(assert, await renderPage(PRIVACY), 'privacy');
});

test('privacy: each processor still has an entry in the "Who else handles it" list', async () => {
  const page = await renderPage(PRIVACY);
  // SCOPED TO THE LIST, not to the page. Checking the whole page was a FALSE GREEN for two
  // of these: "Supabase" and "Google" also appear in the "Your account" bullet, so deleting
  // their processor entries left the suite green with the disclosure gone. Only R2 was
  // killed, because it is named nowhere else. Scope is what makes this assertion mean
  // "the entry exists" instead of "the word occurs somewhere".
  const list = section(page, 'Who else handles it', 'We don');
  assert.ok(list.textSpaced.length > 200, 'the processor list section was not found at all');
  for (const [name, why] of PROCESSORS) {
    assertSays(assert, list, name, `privacy processor list [${why}]`);
  }
  // The proxy is deliberately unnamed in the copy ("a proxy provider"), so it is pinned by
  // its sentence rather than by a vendor name.
  assertSays(assert, list, 'proxy provider', 'privacy processor list [downloader/ytdlp_client.py]');
});

test('privacy: the account-rule fragments are still present', async () => {
  const page = await renderPage(PRIVACY);
  assertSays(assert, page, 'You can start a job without an account', 'privacy');
  assertSays(assert, page, 'you need one to open the player', 'privacy');
});

test('privacy: the job-link fragments are the un-overstated ones', async () => {
  const page = await renderPage(PRIVACY);
  // THIS TEST USED TO PIN THE FALSE VERSION. It required the words "and an account", which
  // made a true sentence un-shippable until the gate was changed — the worst shape a gate
  // can take. What is actually true (SEC-1, src/lib/job-access.ts):
  //   - src/app/jobs/[id]/page.tsx redirects a signed-out visitor. That is the PAGE only.
  //   - api/jobs/[id], .../stems and .../play-chords enforce OWNERSHIP: a job with a user_id
  //     is served to that user alone (404 otherwise). A job with user_id NULL (started
  //     without an account) has no owner, so its link is its only credential.
  //   - Presigned file URLs already handed out cannot be recalled, and last up to 24 hours.
  // test/job-access-routes.test.mjs runs the real routes; this test pins what the page SAYS.
  assertSays(assert, page, 'protected only by its link', 'privacy');
  assertSays(assert, page, 'with no account at all', 'privacy');
  assertSays(assert, page, 'can be opened only by your account', 'privacy');
  assertSays(assert, page, 'cannot be recalled once issued', 'privacy');
});

test('privacy: a fragment of each known 24-hour survivor is still present', async () => {
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
  // _anonymise_job does NOT blank klangio_job_id (migration 030) — a pointer into a third
  // party that holds the audio. The copy named only the Replicate reference before.
  assertSays(assert, page, 'including the one held by Klangio', 'privacy');
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
  // usage_events also records refunds (Stripe event + charge ids) and an account-deletion
  // audit row; six INSERTs across five files. None writes a file name, link or audio.
  assertSays(assert, page, 'refunded', 'privacy');
  assertSays(assert, page, 'that an account was deleted', 'privacy');
});

test('privacy: metadata is the privacy metadata, not another page’s', async () => {
  const page = await renderPage(PRIVACY);
  assert.match(page.metaSpaced, /What stem-loops stores, for how long, and who processes it\./);
  assert.match(page.metaSpaced, /\/privacy/);
});
