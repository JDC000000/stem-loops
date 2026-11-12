import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { checkAdmission, RATE_LIMIT, RATE_WINDOW_MS } from '@/lib/admission';
import { clientIpHashOf } from '@/lib/client-ip';
import { canonicalizeYoutubeUrl } from '@/lib/youtube-url';
import { isValidUploadKey } from '@/lib/upload';
import { getUser } from '@/lib/auth/supabase';
import {
  checkBurstLimit,
  checkMonthlyQuota,
  incrementJobsUsed,
} from '@/lib/billing/rate-limit';
import {
  getEntitlementSnapshot,
  enforceEntitlement,
  EntitlementError,
  billingEnforced,
} from '@/lib/billing/entitlements';
import { consumeTrialInTx } from '@/lib/trial';
import { consumeCreditInTx } from '@/lib/billing/credits';

const VALID_BARS = new Set([1, 2, 4, 8]);
const DEFAULT_STEMS = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'];
const VALID_STEMS = new Set(DEFAULT_STEMS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_LIMIT_MSG =
  "You're going a bit fast, or we're at capacity right now. Give it a minute and try again.";

// POST /api/jobs — create a job. Two input kinds:
//   • upload  (V2 PRIMARY): body { jobId, uploadKey, filename?, stems?, loop_length_bars? }
//     — file already PUT to R2 by the browser (see POST /api/uploads).
//   • youtube (DEFERRED/parked): body { url, ... }.
// The Python worker claims via FOR UPDATE SKIP LOCKED (Gate 0 S2 / option a).
//
// Round-2 §1.2a: trial consumption is LINK-INGEST ONLY (YouTube / Spotify /
// SoundCloud). Uploads are the credits/paid path and must NOT burn a trial
// song. Also: per-IP admission runs BEFORE consumeTrial() so a rate-limited
// request cannot leak a trial song (the trial UPDATE commits in its own tx;
// if we then rejected for admission we would have already spent a song).
export async function POST(request: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // Malformed JSON is a client error, not ours (QA P2 — was surfacing as a 500).
      return NextResponse.json(
        { error_code: 'INVALID_REQUEST', message: 'Request body must be valid JSON.' },
        { status: 400 }
      );
    }
    const bodyObj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

    const user = await getUser();

    // ── Upload job ──────────────────────────────────────────────────────────
    if (bodyObj.uploadKey) {
      const jobId = bodyObj.jobId;
      const uploadKey = bodyObj.uploadKey;
      const filename = bodyObj.filename;
      const stems = bodyObj.stems;
      const loop_length_bars = bodyObj.loop_length_bars;
      // The key must be EXACTLY what POST /api/uploads issues (`{jobId}/_input.{ext}`): the
      // retention sweep deletes a job's objects by the `{jobId}/` prefix, so any other key
      // would never be reaped with the job (and could point the worker at someone's object).
      if (
        typeof jobId !== 'string' ||
        !UUID_RE.test(jobId) ||
        typeof uploadKey !== 'string' ||
        !isValidUploadKey(jobId, uploadKey)
      ) {
        return NextResponse.json(
          { error_code: 'UPLOAD_INVALID', message: 'Missing or invalid upload reference.' },
          { status: 400 }
        );
      }
      const ubars = (loop_length_bars as number | undefined) ?? 4;
      if (!VALID_BARS.has(ubars)) {
        return NextResponse.json(
          { error_code: 'UPLOAD_INVALID', message: 'loop_length_bars must be 1, 2, 4, or 8' },
          { status: 400 }
        );
      }
      // Reject an explicitly-provided but empty/invalid stems list instead of silently
      // defaulting (QA P2 — a direct-API caller should get a clear 400, not a surprise set).
      if (
        stems !== undefined &&
        (!Array.isArray(stems) ||
          stems.length === 0 ||
          !stems.every((s: unknown) => VALID_STEMS.has(s as string)))
      ) {
        return NextResponse.json(
          { error_code: 'UPLOAD_INVALID', message: 'stems must be a non-empty list of supported stems.' },
          { status: 400 }
        );
      }
      const uStems = Array.isArray(stems) && stems.length ? stems : DEFAULT_STEMS;
      const filenameTrim = typeof filename === 'string' ? filename.slice(0, 255) : null;

      // §1.2a: upload is NOT the trial path — it's credits/paid. For authed
      // users enforce the upload entitlement (Pro/Studio quota, or credits
      // for free-tier) BEFORE spending Replicate budget.
      let chargeCredit = false;
      if (user) {
        try {
          const { snapshot: entSnap } = await enforceEntitlement('start_job_upload', user.user_id);
          // Pro/Studio are unlimited (quota-metered); everyone else who got
          // past the gate is on the credit path and is charged below.
          //
          // With billing NOT enforced, a free user who got past the gate did so
          // on the monthly-quota path (entitlements.ts) unless they actually
          // hold credits — charging a credit they do not have would throw
          // CREDIT_BALANCE_INSUFFICIENT inside the tx and roll the job back,
          // re-creating the very defect the gate change removes. When
          // BILLING_ENFORCED=true the `||` short-circuits and this is
          // character-for-character the old predicate.
          chargeCredit =
            entSnap.plan_code !== 'pro' &&
            entSnap.plan_code !== 'studio' &&
            (billingEnforced() || entSnap.credits_remaining > 0);
        } catch (err) {
          if (err instanceof EntitlementError) {
            return NextResponse.json(
              { error_code: err.code, message: err.message },
              { status: err.status },
            );
          }
          throw err;
        }
        // Keep burst as a secondary guardrail. Monthly quota is already
        // checked inside enforceEntitlement('start_job_upload') for paid
        // plans; keep the explicit call here so the counter + response
        // shape stay identical to pre-r2 code for the Pro/Studio flow.
        const burst = await checkBurstLimit(user.user_id);
        if (burst) {
          return new NextResponse(
            JSON.stringify({
              error: 'too many requests',
              code: 'rate_limit_burst',
              retry_after_s: burst.retry_after_s,
            }),
            {
              status: 429,
              headers: {
                'content-type': 'application/json',
                'Retry-After': String(burst.retry_after_s),
              },
            },
          );
        }
        const quota = await checkMonthlyQuota(user.user_id);
        if (quota) {
          return NextResponse.json(
            {
              error: 'monthly quota reached',
              code: 'quota_exceeded',
              resets_at: quota.resets_at,
            },
            { status: 402 },
          );
        }
      }

      // R9 / PRD §6.1: admission BEFORE the (Replicate-spending) job exists. Uploads
      // bypass YouTube's gate, so this is the primary abuse/spend surface.
      const clientIpHash = clientIpHashOf(request);
      const adm = await checkAdmission(clientIpHash);
      if (!adm.allowed) {
        return NextResponse.json({ error_code: adm.error_code, message: RATE_LIMIT_MSG }, { status: 429 });
      }

      // Atomic per-IP rate enforcement (QA P0/P1): the count and the insert are ONE
      // statement, so a concurrent burst can't each pass checkAdmission's pre-check and then
      // insert unconditionally (the old TOCTOU). If already at the cap → 0 rows → 429.
      //
      // V3-C4 (TSD §1.4): for authed users we wrap in a tx that also bumps
      // entitlements.jobs_used under a per-(user,period) advisory lock, so
      // the counter is consistent with the real insert. Anon path stays as
      // a single statement — cheaper + the existing shape.
      let inserted;
      try {
      inserted = user
        ? await db.tx(async (client) => {
            const r = await client.query(
              `INSERT INTO jobs (id, input_kind, upload_r2_key, original_filename, requested_stems,
                                 loop_length_bars, status, client_ip_hash, client_fingerprint, user_id)
               SELECT $1, 'upload', $2, $3, $4, $5, 'queued', $6, '', $9::uuid
               WHERE (SELECT COUNT(*) FROM jobs WHERE client_ip_hash = $6
                      AND created_at >= NOW() - ($7::int * INTERVAL '1 millisecond')) < $8
               RETURNING id`,
              [jobId, uploadKey, filenameTrim, uStems, ubars, clientIpHash,
               RATE_WINDOW_MS, RATE_LIMIT, user.user_id],
            );
            if (r.rowCount) {
              // B1/M3: charge the credit in the SAME tx, AFTER the jobs row
              // exists (check_credit_decrement trigger looks it up). DB-level
              // advisory lock + conditional INSERT — not the 30 s cache.
              // Throws CREDIT_BALANCE_INSUFFICIENT -> tx rolls back the job.
              //
              // One job, one debit. A credit-funded job is metered by the
              // credit ledger and must NOT also spend a unit of the monthly
              // allowance: checkMonthlyQuota() waives the quota while credits
              // remain (review M1), so the extra unit was invisible until the
              // credits ran out and the allowance they never touched was gone.
              if (chargeCredit) await consumeCreditInTx(client, user.user_id, jobId);
              else await incrementJobsUsed(client, user.user_id);
            }
            return r;
          })
        : await db.query(
            `INSERT INTO jobs (id, input_kind, upload_r2_key, original_filename, requested_stems,
                               loop_length_bars, status, client_ip_hash, client_fingerprint)
             SELECT $1, 'upload', $2, $3, $4, $5, 'queued', $6, ''
             WHERE (SELECT COUNT(*) FROM jobs WHERE client_ip_hash = $6
                    AND created_at >= NOW() - ($7::int * INTERVAL '1 millisecond')) < $8
             RETURNING id`,
            [jobId, uploadKey, filenameTrim, uStems, ubars, clientIpHash,
             RATE_WINDOW_MS, RATE_LIMIT],
          );
      } catch (err) {
        // Lost the race for the last credit (M3): tx already rolled back.
        if (err instanceof EntitlementError) {
          return NextResponse.json(
            { error_code: err.code, message: err.message },
            { status: err.status },
          );
        }
        throw err;
      }
      if (!inserted.rowCount) {
        return NextResponse.json({ error_code: 'RATE_LIMITED', message: RATE_LIMIT_MSG }, { status: 429 });
      }
      // No external queue: the Python worker claims the job straight off the jobs table
      // (status='queued', FOR UPDATE SKIP LOCKED). pg-boss was vestigial and removed.
      return NextResponse.json({ id: jobId, status: 'queued' }, { status: 201 });
    }

    // ── YouTube / link-ingest job (DEFERRED — kept, unwired at the worker until S1 clears) ──
    // SECURITY / A1 scope (review #7): the worker would actually run Cobalt/yt-dlp for a
    // youtube job (STUB_MODE isn't set in prod env), so gate the parked path at the door
    // — it can't be reached from the UI, but this blocks a direct API call too.
    if (process.env.ALLOW_YOUTUBE_INPUT !== 'true') {
      return NextResponse.json(
        { error_code: 'DOWNLOAD_INVALID_URL', message: 'YouTube input is not available yet.' },
        { status: 403 }
      );
    }

    const url = bodyObj.url;
    const stems = bodyObj.stems;
    const loop_length_bars = bodyObj.loop_length_bars;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error_code: 'DOWNLOAD_INVALID_URL', message: 'url is required' }, { status: 400 });
    }
    // QA fix (P2/UX #3 + P3 #5): canonicalize + require an actual video id, and accept
    // Shorts/Music/live/embed links, not just /watch and bare youtu.be/. The worker's
    // SSRF allowlist (downloader/__init__.py) already accepts any youtube.com/youtu.be
    // path, so this only widens web-layer *validation* — no new server-side attack
    // surface. Persisting the canonicalized form (not the raw pasted url) also strips
    // tracking params before the row ever exists.
    const canonicalUrl = canonicalizeYoutubeUrl(url);
    if (!canonicalUrl) {
      return NextResponse.json(
        { error_code: 'DOWNLOAD_INVALID_URL', message: 'That doesn’t look like a YouTube video link. Paste a full youtube.com or youtu.be URL.' },
        { status: 400 }
      );
    }
    const bars = (loop_length_bars as number | undefined) ?? 4;
    if (!VALID_BARS.has(bars)) {
      return NextResponse.json(
        { error_code: 'DOWNLOAD_INVALID_URL', message: 'loop_length_bars must be 1, 2, 4, or 8' },
        { status: 400 }
      );
    }
    // QA fix (P2 #2): the youtube branch never validated `stems` against VALID_STEMS —
    // {"stems":["piano","banana"]} was persisted and handed to the worker. Mirror the
    // upload branch's check exactly.
    if (
      stems !== undefined &&
      (!Array.isArray(stems) ||
        stems.length === 0 ||
        !stems.every((s: unknown) => VALID_STEMS.has(s as string)))
    ) {
      return NextResponse.json(
        { error_code: 'DOWNLOAD_INVALID_URL', message: 'stems must be a non-empty list of supported stems.' },
        { status: 400 }
      );
    }

    // §1.2a channel separation: Pro/Studio are upload-only. For AUTHENTICATED
    // users, run the link-ingest entitlement guard BEFORE admission / trial /
    // quota so a paid user gets the friendly PAID_LINK_INGEST_DISALLOWED (400)
    // instead of falling through to the admission gate. Only that one code is
    // acted on here: free/trial users keep the existing behaviour (trial
    // consume, then burst/quota + plain INSERT), so TRIAL_EXHAUSTED and
    // ENTITLEMENT_UNAVAILABLE from this call are intentionally ignored.
    // Anonymous users (user === null) skip this and stay on the free-tier path.
    if (user) {
      try {
        await enforceEntitlement('start_job_youtube', user.user_id);
      } catch (err) {
        if (err instanceof EntitlementError) {
          if (err.code === 'PAID_LINK_INGEST_DISALLOWED') {
            return NextResponse.json(
              { error_code: err.code, message: err.message },
              { status: err.status },
            );
          }
          // Other entitlement outcomes are handled by the existing gates below.
        } else {
          // Snapshot/DB failure: fail open to the existing gates (same stance
          // as the getEntitlementSnapshot try/catch below), but report it.
          Sentry.captureException(err);
        }
      }
    }

    // §1.2a admission-before-consume (round-2 FIX #2): run per-IP admission
    // BEFORE consumeTrial(). consumeTrial commits in its own tx, so if a
    // rate-limited request spent a trial song first, the song would already
    // be gone when we returned 429 — a leak. Admission first → the trial
    // decrement only happens on a request that will actually proceed.
    const clientIpHash = clientIpHashOf(request);
    const adm = await checkAdmission(clientIpHash);
    if (!adm.allowed) {
      return NextResponse.json({ error_code: adm.error_code, message: RATE_LIMIT_MSG }, { status: 429 });
    }

    const id = randomUUID();
    const requestedStems = Array.isArray(stems) && stems.length ? stems : DEFAULT_STEMS;

    // Reusable INSERT body. Separate strings so we don't bend a query apart
    // over two branches; the SQL parses once in the pool.
    const AUTHED_INSERT_SQL = `INSERT INTO jobs (id, youtube_url, requested_stems, loop_length_bars, status, client_ip_hash, client_fingerprint, user_id)
             SELECT $1, $2, $3, $4, 'queued', $5, '', $8::uuid
             WHERE (SELECT COUNT(*) FROM jobs WHERE client_ip_hash = $5
                    AND created_at >= NOW() - ($6::int * INTERVAL '1 millisecond')) < $7
             RETURNING id`;
    const ANON_INSERT_SQL = `INSERT INTO jobs (id, youtube_url, requested_stems, loop_length_bars, status, client_ip_hash, client_fingerprint)
           SELECT $1, $2, $3, $4, 'queued', $5, ''
           WHERE (SELECT COUNT(*) FROM jobs WHERE client_ip_hash = $5
                  AND created_at >= NOW() - ($6::int * INTERVAL '1 millisecond')) < $7
           RETURNING id`;

    // §1.2a: trial applies ONLY to the link-ingest branch (this one). For
    // authed non-Pro/Studio users: try consumeTrialInTx() inside the same
    // tx as the jobs INSERT. If the per-IP rate-limit WHERE returns 0 rows,
    // we THROW RATE_LIMITED_SENTINEL so the tx rolls back — the trial song
    // is NOT burned (PR #39 Lens A follow-up). Pro/Studio skip the trial
    // entirely and use burst+quota. Anonymous users have user===null and
    // skip all of this; per-IP admission above is their only gate.
    if (user) {
      let subscribed = false;
      try {
        const snap = await getEntitlementSnapshot(user.user_id);
        subscribed = snap.plan_code === 'pro' || snap.plan_code === 'studio';
      } catch {
        // Fail restrictive: treat as not-subscribed and let the existing
        // gates decide (same stance enforceEntitlement takes on DB error).
      }

      if (!subscribed) {
        // Try (consume trial + insert jobs) atomically. Three outcomes:
        //   consumed:true          → tx committed, return 201
        //   consumed:false         → tx committed, nothing changed; fall
        //                            through to burst/quota + plain INSERT
        //   throw RATE_SENTINEL    → tx rolled back (trial not burned), 429
        const RATE_SENTINEL = Symbol('rate_limited');
        try {
          const outcome = await db.tx(async (client) => {
            const consume = await consumeTrialInTx(client, user.user_id);
            if (!consume.ok) return { consumed: false as const };
            const r = await client.query(
              AUTHED_INSERT_SQL,
              [id, canonicalUrl, requestedStems, bars, clientIpHash, RATE_WINDOW_MS, RATE_LIMIT, user.user_id],
            );
            if (!r.rowCount) {
              // Rate-limited AFTER a successful trial consume. Throw to
              // roll back the whole tx — trial song is NOT burned.
              throw RATE_SENTINEL;
            }
            await incrementJobsUsed(client, user.user_id);
            return { consumed: true as const };
          });
          if (outcome.consumed) {
            return NextResponse.json({ id, status: 'queued' }, { status: 201 });
          }
          // consumed:false → fall through to burst/quota + plain INSERT.
        } catch (err) {
          if (err === RATE_SENTINEL) {
            return NextResponse.json(
              { error_code: 'RATE_LIMITED', message: RATE_LIMIT_MSG },
              { status: 429 },
            );
          }
          // Trial read/consume unexpected failure is non-fatal — log and
          // fall through to the normal free-tier path.
          Sentry.captureException(err);
        }
      }

      // Non-trial path: subscribed, or trial exhausted/missing. Run the
      // paid-plan gates and then do the plain INSERT below.
      const burst = await checkBurstLimit(user.user_id);
      if (burst) {
        return new NextResponse(
          JSON.stringify({
            error: 'too many requests',
            code: 'rate_limit_burst',
            retry_after_s: burst.retry_after_s,
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'Retry-After': String(burst.retry_after_s),
            },
          },
        );
      }
      const quota = await checkMonthlyQuota(user.user_id);
      if (quota) {
        return NextResponse.json(
          {
            error: 'monthly quota reached',
            code: 'quota_exceeded',
            resets_at: quota.resets_at,
          },
          { status: 402 },
        );
      }
    }

    // V3-C4 (TSD §1.4): mirror the upload branch — tx + jobs_used bump for
    // authed users so the counter is consistent with the real insert.
    const inserted = user
      ? await db.tx(async (client) => {
          const r = await client.query(
            AUTHED_INSERT_SQL,
            [id, canonicalUrl, requestedStems, bars, clientIpHash, RATE_WINDOW_MS, RATE_LIMIT, user.user_id],
          );
          if (r.rowCount) await incrementJobsUsed(client, user.user_id);
          return r;
        })
      : await db.query(
          ANON_INSERT_SQL,
          [id, canonicalUrl, requestedStems, bars, clientIpHash, RATE_WINDOW_MS, RATE_LIMIT],
        );
    if (!inserted.rowCount) {
      return NextResponse.json({ error_code: 'RATE_LIMITED', message: RATE_LIMIT_MSG }, { status: 429 });
    }

    return NextResponse.json({ id, status: 'queued' }, { status: 201 });
  } catch (err) {
    // This try/catch swallows the error into a clean 500 JSON response (PRD §6.1 — no
    // stack trace in the response body), which means it never reaches Next.js's own
    // onRequestError hook. Report it to Sentry explicitly, or it just vanishes.
    Sentry.captureException(err);
    console.error('POST /api/jobs error:', err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500 });
  }
}
