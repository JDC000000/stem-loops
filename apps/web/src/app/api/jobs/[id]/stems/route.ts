import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { db } from '@/lib/db';
import { r2 } from '@/lib/r2';
import { checkStemListRate } from '@/lib/admission';
import { mayReadJob } from '@/lib/job-access';
import { clientIpHashOf } from '@/lib/client-ip';
import { mintStemPlayUrl } from '@/lib/stem-urls';
import {
  PLAYABLE_STEMS,
  STEM_PREFIX,
  STEM_SIGNED_URL_TTL_SEC,
  stemNameFromPlayKey,
  stemNameFromDownloadKey,
  stemState,
} from '@/lib/stem-keys';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Verbatim from /api/uploads and /api/jobs. A throttled stems fetch is the same
// event to a user as a throttled upload, so it gets the same words and the same
// { error_code: 'RATE_LIMITED' } 429 body — not a new error contract for the client
// to learn.
const RATE_LIMIT_MSG =
  "You're going a bit fast, or we're at capacity right now. Give it a minute and try again.";

// This response body is a set of bearer credentials: each `signed_url` is a presigned
// R2 GET that anyone holding the string can replay until it expires. Without this
// header a shared proxy or a browser's back/forward cache can retain them, so they
// outlive the tab that asked for them. `private` keeps shared caches out; `no-store`
// stops the local one from writing them to disk at all.
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/** `name: message` only — never the error object. See the 500 handler for why. */
function errLabel(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : 'non-Error thrown';
}

// GET /api/jobs/:id/stems — the Opus playback stems for the play-along mixer (V3-J2).
//
// Returns one signed GET per retained stem, in mixer channel order. The browser
// fetches the audio direct from R2, exactly as it does for loops and the chord
// artifact: a stem must not be streamed through a Vercel function.
//
// Playback is Opus, not WAV, per TSD §12.2 — six WAV stems would be 240-360 MB into
// the browser against a measured Variant D budget of 287 MB. Opus is ~4-5 MB/stem.
// The WAV download artifact is a SEPARATE object and is not served here.
//
// Shape: { stems: [{ stem, signed_url }], expected, complete, state, expires_in_sec }
//
// `state` exists because `complete: false` alone hid a real failure. An adversarial
// review demonstrated that if Opus encoding fails for EVERY stem, the job still
// reports `done`, six WAVs upload, and this route returned `{stems: [], complete:
// false}` — which the previous version's own comment defined as "a job that predates
// V3-J2, not an error". Broken and legacy were indistinguishable. The two are told
// apart by whether the DOWNLOAD artifacts exist:
//   'unavailable'   no stems of either kind -> pre-V3-J2 job; fall back to loops
//   'ready'         all six playable
//   'partial'       some playable -> a mix with an instrument missing; do not autoplay
//   'encode_failed' downloads exist, nothing playable -> the ENCODER failed; alertable
//
//   404 when the job is missing, expired, or not yet complete.
//   502 STEM_LIST_FAILED when R2 cannot be listed. Deliberately loud: this is the
//     web tier's first real network call to R2 (everything else only presigns, which
//     is offline), so a credential could lack ListBucket in an environment where
//     every offline test passes. A silent empty 200 would look exactly like "no
//     stems". (Confirmed working in production 2026-11-10: a live done job returned
//     200 with an empty list rather than an error.) This path is the one fault in
//     this route that reaches Sentry — see the list-failure catch for where it
//     surfaces and why its fingerprint is fixed.
//
// OWNERSHIP (lib/job-access.ts): a job with a user_id is served to that user only; an
// anonymous job (user_id NULL, started without an account) is served to anyone holding
// its id. A denied caller gets the 404 a missing job gets. Anonymous playback stays
// open because starting a job needs no account; the stem DOWNLOAD requires one (V3-J9).
//
// ⚠️ RESIDUE REQUIRING JON'S RECORDED ACCEPTANCE (M-11): as with every other job
// route, the job UUID is the only credential, and the privacy notice says so. But
// six full-length stems reconstruct the WHOLE track where a 4-bar loop does not.
// That is a larger exposure behind the same existing door, and a code comment is not
// acceptance.
//
// RATE LIMIT (M-11 owner decision OD-B, now wired): per-IP, 60 requests/minute, via
// checkStemListRate in lib/admission.ts — the same atomic check-and-record statement
// /api/uploads uses, on a namespaced counter so playback and uploads do not share a
// budget. It runs FIRST, before the job lookup and before the R2 list, because the
// thing worth protecting is the billable Class A ListObjectsV2 and the connection
// pool, and both sit behind it. See lib/admission.ts for why the number is 60 and not
// the upload route's 10.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
  }
  try {
    // ORDER MATTERS, and this is as early as a limiter can go. Above it is only the
    // UUID shape test, which is free and does no I/O; below it are the two costs worth
    // bounding — the job SELECT and the R2 ListObjectsV2, which is a BILLABLE Class A
    // operation that nothing caches. Unthrottled, one leaked done-job UUID made both
    // unbounded for whoever held it.
    //
    // HONEST LIMIT OF THIS GATE: the limiter is ITSELF a DB round trip, so an
    // anonymous flood still reaches the connection pool — it just reaches it once per
    // request instead of twice plus an R2 call, and a refused request costs no R2
    // spend and never touches `jobs`. The reviewer's separate finding (a cheap gate
    // before the DB query) is therefore blunted, not closed; closing it needs a
    // non-DB-backed limiter, which is a different change than this one.
    //
    // Fails CLOSED by construction: a DB fault in here throws to the 500 handler
    // below rather than returning "allowed".
    const rate = await checkStemListRate(clientIpHashOf(request));
    if (!rate.allowed) {
      return NextResponse.json(
        { error_code: rate.error_code, message: RATE_LIMIT_MSG },
        { status: 429, headers: NO_STORE },
      );
    }

    // Same gate as GET /api/jobs/:id and the play-chords route.
    const jobRes = await db.query(
      `SELECT id::text AS id, user_id, status, expires_at FROM jobs WHERE id = $1 AND expires_at > now()`,
      [params.id]
    );
    if (jobRes.rowCount === 0) {
      return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
    }
    const job = jobRes.rows[0];
    // Ownership BEFORE the status check, so a non-owner cannot learn a job's state.
    if (!(await mayReadJob(job.user_id))) {
      return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
    }
    if (job.status !== 'done') {
      return NextResponse.json({ error_code: 'NOT_READY', message: 'Job not yet complete' }, { status: 404 });
    }

    // Use the DB row's id, NOT params.id, to build the R2 prefix. UUID_RE is
    // case-insensitive, so an uppercase UUID passes the lookup (Postgres `uuid`
    // comparison is case-insensitive) and would then list a prefix that does not
    // exist, returning a silent empty list. Postgres renders uuid as lowercase.
    const jobId: string = job.id;

    // Clamp the TTL from the RAW remaining lifetime, not via presignTtlSec.
    //
    // presignTtlSec floors at MIN_PRESIGN_SEC (60s). That floor is correct for the
    // loop route — a 24h-capped URL for a job seconds from expiry is harmless there,
    // the objects go when the job does — but here it made this route's own "a signed
    // URL never outlives expires_at" claim FALSE by up to 59s: a job with 1 second
    // left yielded a 60-second URL, so the signature stayed valid after the retention
    // sweep's window opened. Floor at 1s instead: always valid-but-short, and never a
    // zero or negative expiresIn, which the presigner rejects outright.
    //
    // Both properties still hold: never longer than 15 min (TSD §12.2 "short-TTL
    // signed GETs"), never past the job's own expiry. The 24h RETENTION_SEC cap
    // presignTtlSec also applied is subsumed by the 900s one.
    const remainingMs = new Date(job.expires_at).getTime() - Date.now();
    // The SQL gate already proved `expires_at > now()` in Postgres, so a non-finite
    // value here is a driver/serialisation quirk rather than an expired job — but it
    // still FAILS CLOSED, at 1s rather than the 900s ceiling. This number is the
    // lifetime of a bearer credential, and the one thing known about an unparseable
    // `expires_at` is that the expiry it was supposed to bound is unknown; the safe
    // direction for an unknown bound is the shortest signable URL, not the longest
    // one. Not reachable today (`expires_at` is non-null and passed the gate), which
    // is exactly why the default should not be the permissive one.
    const remainingSec = Number.isFinite(remainingMs) ? Math.floor(remainingMs / 1000) : 1;
    const expiresIn = Math.min(STEM_SIGNED_URL_TTL_SEC, Math.max(1, remainingSec));

    // ONE list over the shared `_stems/` parent covers both artifact kinds, which is
    // what makes `encode_failed` distinguishable from `unavailable`.
    let listed;
    try {
      listed = await r2.send(
        new ListObjectsV2Command({
          Bucket: process.env.R2_BUCKET_NAME!,
          Prefix: `${jobId}/${STEM_PREFIX}`,
          MaxKeys: 100, // at most 12 objects live here; cannot under-report
        })
      );
    } catch (listErr) {
      // WHERE THIS FAULT IS MEANT TO SURFACE: Sentry, as ONE issue group with the
      // fixed fingerprint ['stems-route', 'STEM_LIST_FAILED']. That group is the
      // thing to alert and write a runbook against; the Vercel function log line
      // below is the per-request detail, not the signal.
      //
      // The amplification concern is real and is not answered by deleting this
      // capture. The route is UNAUTHENTICATED, there is no capture-side sampling,
      // rate limit or dedupe in sentry.server.config.ts / sentry-options.ts, and the
      // realistic trigger is a backend fault rather than a one-off: a prod credential
      // lacking ListBucket makes EVERY request for ANY valid done job throw, so the
      // event rate is the request rate. The FINGERPRINT is what bounds the cost — an
      // outage collapses into a single issue whose event counter rises, instead of a
      // new issue per request burying the real alert. Dropping the capture bounds the
      // Sentry cost to zero and the alerting coverage with it, which is the worse
      // trade here: this is the web tier's first real network call to R2 (everything
      // else only presigns, which is offline), so a missing ListBucket grant passes
      // every offline test, breaks playback for every user at once, and would
      // otherwise reach only console.error in Vercel logs that nothing drains.
      // Both sibling unauthenticated job routes capture on their failure paths
      // (jobs/[id], play-chords); this one is not special enough to be silent.
      //
      // captureMessage, not captureException: the thrown object is the R2 SDK's and
      // carries $metadata / bucket names, for the reason the 500 handler gives, so
      // only errLabel() travels.
      Sentry.captureMessage('stems route: R2 list failed (STEM_LIST_FAILED)', {
        level: 'error',
        fingerprint: ['stems-route', 'STEM_LIST_FAILED'],
        extra: { cause: errLabel(listErr) },
      });
      console.error('GET /api/jobs/[id]/stems: R2 list failed:', errLabel(listErr));
      return NextResponse.json(
        { error_code: 'STEM_LIST_FAILED', message: 'Could not list stems' },
        { status: 502 }
      );
    }

    const playable = new Set<string>();
    const downloadable = new Set<string>();
    for (const obj of listed.Contents ?? []) {
      if (!obj.Key) continue;
      const play = stemNameFromPlayKey(obj.Key);
      if (play) {
        playable.add(play);
        continue;
      }
      const dl = stemNameFromDownloadKey(obj.Key);
      if (dl) downloadable.add(dl);
    }

    const state = stemState(playable.size, downloadable.size);
    // NOTE: this route deliberately does NOT report `encode_failed` to Sentry.
    // An earlier version did, and a reviewer pointed out the consequence: the route
    // is unauthenticated, so anyone holding a job UUID could fire an unbounded
    // number of Sentry events just by refetching a broken job. The worker already
    // reports the same condition ONCE per job, at the moment it happens, with a
    // likely_cause — which is strictly better telemetry and cannot be amplified.

    // Mixer channel order, not R2's lexical order.
    const stems = await Promise.all(
      PLAYABLE_STEMS.filter((s) => playable.has(s)).map(async (stem) => ({
        stem,
        signed_url: await mintStemPlayUrl(jobId, stem, expiresIn),
      }))
    );

    return NextResponse.json(
      {
        stems,
        expected: PLAYABLE_STEMS,
        complete: state === 'ready',
        state,
        expires_in_sec: expiresIn,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    // NOT reported to Sentry — unlike the 502 list-failure path above — and dropping
    // it was chosen over throttling it. The difference is reach: the list-failure path
    // needs a VALID, done job to be touched at all, so a fixed fingerprint bounds it;
    // this handler does not.
    //
    // A throttle would have had to be an in-process, once-per-N-minutes guard with a
    // fixed fingerprint, and on Vercel "in-process" means per lambda instance: the
    // guard multiplies by the instance count under exactly the load it exists to
    // bound, so it is a weaker bound than it looks while being strictly more code.
    // What makes dropping safe is that the amplification vector here needs no valid
    // job at all — the DB query runs before any job-existence check, so a flood of
    // random UUIDs reaches it, and pool exhaustion is itself the fault that would be
    // captured, one event per request. A fingerprint would collapse the ISSUE count
    // but not the EVENT count, and with no job gate in front of it the event count is
    // whatever an anonymous caller chooses. The 500 status and this log line remain,
    // and the DB-side fault surfaces in Supabase and Vercel telemetry regardless.
    //
    // NOT FIXED HERE, deliberately (scope): ordering a cheap existence check before
    // the DB query would blunt that pool-exhaustion vector at its source. Noted for
    // the owner; it is a change to the route's gate order, not a security fix to this
    // PR's diff.
    //
    // `errLabel`, not `err`: an AWS SDK error carries `$metadata` (request ids,
    // attempt counts), NoSuchBucket carries the bucket name, and a DNS failure
    // embeds `<account>.r2.cloudflarestorage.com`. Logs only, never the caller.
    console.error(`GET /api/jobs/${params.id}/stems error:`, errLabel(err));
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500 });
  }
}
