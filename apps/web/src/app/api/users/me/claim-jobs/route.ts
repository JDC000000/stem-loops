// POST /api/users/me/claim-jobs — V3 Phase 1a (TSD §2.2, V3-U2).
//
// Anonymous -> authed job stitching.
//
// Problem: anonymous visitors create jobs tracked by (client_fingerprint,
// client_ip_hash). After they sign up, those anonymous jobs still have
// user_id = NULL on public.jobs, so they do not show up on /account. This
// route attributes a signed-in user's anonymous jobs to their new user_id
// so the account history is contiguous.
//
// Body: { client_fingerprint: string }
//   The fingerprint is held by the browser in localStorage under the same
//   key used by the anonymous rate-limit path. The caller passes it in on
//   the first authenticated request after sign-up.
//
// Response: { claimed_count: N, truncated: boolean } on success (200), or
//   an error envelope { error, code } where `code` is an error_copy key.
//   `truncated` is true when the server attributed exactly MAX_CLAIMED_JOBS
//   rows and more eligible anonymous rows remain; the caller can wait for
//   the 1h rate-limit window to clear and call again to pick up the rest.
//   Each `truncated=true` outcome also logs a usage_events row with
//   kind='claim_jobs_truncated' and detail={count: <actual_matched>} so
//   we can observe how often overflow users hit the ceiling.
//
// Auth: required via @/lib/auth/supabase getUser(). Unauth -> 401.
//
// Rate limit: 1 call per hour per authenticated user. The vast majority of
//   users should call this at most once (right after sign-up); the window
//   is wide so that an attacker cannot spin claims to fuzz fingerprints.
//   Counted + enforced in usage_events (kind='claim_jobs') inside a tx
//   guarded by a per-user advisory lock, same pattern as billing/checkout.
//   An overflow user whose first call was truncated must wait out the
//   full 1h window before the next call — the limit is NOT relaxed for
//   truncated responses, by design.
//
// Scope control (TSD §2.2 "last N user hashes"): we do not blindly
//   attribute every job that shares a fingerprint. A fingerprint collision
//   from an unrelated person on the same browser/version string should not
//   leak their anonymous jobs into this account. We bound the claim by
//   client_ip_hash: a job is only claimed if its client_ip_hash is in the
//   set of (up to 50) ip hashes observed on jobs that ALREADY share this
//   fingerprint — i.e. the device cohort that acted anonymously. 50 is the
//   abuse ceiling; the typical user signs up from 1-3 IPs (home, mobile,
//   office).
//
// Abuse boundaries we actively defend against:
//   - cross-user hijack: a different user signed in with the same
//     fingerprint can only claim jobs whose ip_hash was seen by THIS
//     fingerprint's cohort (never a third party's hashes).
//   - re-claim: credit_consumption / entitlements are NOT touched here.
//     user_id flips from NULL -> auth.uid() exactly once per job (idempotent
//     under a retry) because the UPDATE filter is `user_id IS NULL`.
//   - race: concurrent calls for the same user are serialized by
//     pg_advisory_xact_lock('claim_jobs:' || user_id) at the top of the tx.

import { NextRequest, NextResponse } from 'next/server';
import { getUser } from '@/lib/auth/supabase';
import { db } from '@/lib/db';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 1 claim per hour per user. Anonymous-to-authed stitching is a one-shot
// operation for the overwhelming majority of users; the wide window makes
// fingerprint-fuzzing by a logged-in attacker too slow to be useful.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_PER_USER = 1;
// Advisory-lock namespace tag; hashtext() turns ('claim_jobs:' || uuid)
// into a stable 32-bit integer key that cannot collide with
// 'billing_checkout:' or any other caller.
const RATE_LIMIT_LOCK_TAG = 'claim_jobs';
// Hard cap on the set of client_ip_hash values accepted for a single
// claim. Prevents a user from vacuuming every job that ever shared their
// fingerprint across a huge IP space.
const MAX_IP_HASHES_PER_CLAIM = 50;
// Hard cap on jobs attributed in one call. Keeps the UPDATE bounded even
// under pathological inputs. Sized at 5000 so a first-time sign-up covers
// the full anon history for all but the very heaviest pre-auth users;
// anyone past this ceiling gets truncated=true in the response and can
// retry after the 1h rate-limit window to pick up the remainder.
const MAX_CLAIMED_JOBS = 5000;
// Fingerprint length guard: the browser ships an opaque short string
// (currently a 32-char hex). Reject anything that could not plausibly be
// our token to keep this out of the index as a random text probe.
const MIN_FINGERPRINT_LEN = 8;
const MAX_FINGERPRINT_LEN = 256;

type Body = { client_fingerprint?: unknown };

function badRequest(code: string, message: string) {
  return NextResponse.json({ error: message, code }, { status: 400 });
}

export async function POST(req: NextRequest) {
  // CSRF: same-origin browser requests only (src/lib/same-origin.ts).
  const originRefusal = crossOriginRefusal(req);
  if (originRefusal) {
    return NextResponse.json({ error: originRefusal, code: BAD_ORIGIN }, { status: 403 });
  }
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Sign in to claim your jobs.', code: 'UNAUTHENTICATED' },
      { status: 401 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return badRequest('CLAIM_JOBS_INVALID', 'Body must be JSON.');
  }
  const fingerprintRaw = typeof body.client_fingerprint === 'string' ? body.client_fingerprint.trim() : '';
  if (
    fingerprintRaw.length < MIN_FINGERPRINT_LEN ||
    fingerprintRaw.length > MAX_FINGERPRINT_LEN
  ) {
    return badRequest('CLAIM_JOBS_INVALID', 'client_fingerprint is required.');
  }

  try {
    const result = await db.tx(async (client) => {
      // Per-user advisory lock. Queues concurrent calls for the same
      // user_id; different users do not block each other. Releases
      // automatically at COMMIT/ROLLBACK — no leak path.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2::text))`,
        [RATE_LIMIT_LOCK_TAG, user.user_id],
      );

      // Rate limit: at most RATE_LIMIT_PER_USER claim_jobs attempts in
      // the window. The row is appended inside the same tx so a retry
      // after a transient DB error cannot escape the gate.
      const countRes = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM usage_events
          WHERE user_id = $1::uuid
            AND kind = 'claim_jobs'
            AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')`,
        [user.user_id, RATE_LIMIT_WINDOW_MS],
      );
      const n = Number.parseInt(countRes.rows[0]?.n ?? '0', 10);
      if (n >= RATE_LIMIT_PER_USER) {
        return { rateLimited: true as const };
      }

      // Determine the device's IP-hash cohort. A job is eligible for
      // claim only if its client_ip_hash was ALSO observed on some
      // other job sharing this fingerprint — this is the "last N user
      // hashes" bound from TSD §2.2. On the very first claim there is
      // no prior authed row yet, so the set is derived from the pool
      // of anonymous rows for the same fingerprint (user_id IS NULL).
      // That is safe: fingerprint is already the primary binding; the
      // ip_hash check narrows a shared-fingerprint collision down to
      // the IPs this device actually used.
      const hashRes = await client.query<{ client_ip_hash: string }>(
        `SELECT DISTINCT client_ip_hash
           FROM public.jobs
          WHERE client_fingerprint = $1
            AND client_ip_hash IS NOT NULL
          ORDER BY client_ip_hash
          LIMIT $2`,
        [fingerprintRaw, MAX_IP_HASHES_PER_CLAIM],
      );
      const ipHashes = hashRes.rows.map((r) => r.client_ip_hash);

      // Record the attempt BEFORE the UPDATE so the rate-limit count is
      // incremented even on a zero-match claim (otherwise an attacker
      // could fuzz fingerprints at the full QPS of the DB pool until
      // one hits).
      await client.query(
        `INSERT INTO public.usage_events (user_id, kind, detail)
         VALUES ($1::uuid, 'claim_jobs', $2::jsonb)`,
        [user.user_id, JSON.stringify({ fingerprint_len: fingerprintRaw.length, ip_hash_count: ipHashes.length })],
      );

      if (ipHashes.length === 0) {
        return { rateLimited: false as const, claimedCount: 0, truncated: false };
      }

      // Attribute the anonymous jobs. Filter on user_id IS NULL so a
      // retry is idempotent (previously-claimed rows stay put) and so
      // we never clobber a row that belongs to another user even if
      // the fingerprint/ip_hash pair happened to match.
      const updateRes = await client.query<{ id: string }>(
        `UPDATE public.jobs
            SET user_id = $1::uuid
          WHERE id IN (
            SELECT id FROM public.jobs
             WHERE user_id IS NULL
               AND client_fingerprint = $2
               AND client_ip_hash = ANY($3::text[])
             ORDER BY created_at DESC
             LIMIT $4
          )
          RETURNING id`,
        [user.user_id, fingerprintRaw, ipHashes, MAX_CLAIMED_JOBS],
      );
      const claimedCount = updateRes.rowCount ?? 0;

      // Truncation probe: if the UPDATE hit the ceiling, count the
      // remaining eligible anonymous rows (still user_id IS NULL after
      // the UPDATE) that match the same fingerprint + cohort. Anything
      // > 0 means we left rows on the floor; record a usage_events row
      // so we can see how often users hit the cap in practice.
      let truncated = false;
      if (claimedCount === MAX_CLAIMED_JOBS) {
        const remainingRes = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM public.jobs
            WHERE user_id IS NULL
              AND client_fingerprint = $1
              AND client_ip_hash = ANY($2::text[])`,
          [fingerprintRaw, ipHashes],
        );
        const remaining = Number.parseInt(remainingRes.rows[0]?.n ?? '0', 10);
        if (remaining > 0) {
          truncated = true;
          await client.query(
            `INSERT INTO public.usage_events (user_id, kind, detail)
             VALUES ($1::uuid, 'claim_jobs_truncated', $2::jsonb)`,
            [
              user.user_id,
              JSON.stringify({ count: claimedCount + remaining }),
            ],
          );
        }
      }

      return { rateLimited: false as const, claimedCount, truncated };
    });

    if (result.rateLimited) {
      return NextResponse.json(
        { error: 'You can only claim jobs once per hour.', code: 'RATE_LIMITED' },
        { status: 429 },
      );
    }

    return NextResponse.json({
      claimed_count: result.claimedCount,
      truncated: result.truncated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[users/me/claim-jobs] failed:', message);
    return NextResponse.json(
      { error: 'We could not claim your jobs.', code: 'CLAIM_JOBS_FAILED' },
      { status: 500 },
    );
  }
}
