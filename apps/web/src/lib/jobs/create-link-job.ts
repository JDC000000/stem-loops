// The authed link-job path of POST /api/jobs (Phase B, B0; PHASE-B-BRIEF r4.2, D-e).
//
// One function carries every gate a signed-in link job passes, in the order the route has
// always run them (this file was extracted from app/api/jobs/route.ts with no behaviour
// change):
//
//   ALLOW_YOUTUBE_INPUT → url / canonicalisation → loop bars → stems
//   → [findExisting] → link entitlement (paid refusals are final) → checkAdmission
//   → trial branch:     db.tx { consumeTrialInTx → [beforeInsert] → INSERT → bumpJobsUsed
//                                → recordAllowanceDebit }
//   → non-trial branch: checkBurstLimit (writes outside the tx) → checkMonthlyQuota
//                       → db.tx { [beforeInsert] → INSERT → rollPeriodIfStale
//                                → bumpJobsUsed / bumpJobsUsedWithinQuota → recordAllowanceDebit }
//
// Hook contract (D-e). Both hooks are optional; with neither, the path is byte-for-byte the
// old route code.
//   1. findExisting(db, ctx): read-only and lock-free. Runs after ALLOW_YOUTUBE_INPUT and
//      canonicalisation and BEFORE the paid entitlement, checkAdmission, the trial branch,
//      checkBurstLimit and checkMonthlyQuota. A hit returns 200 { id } at once: no burst,
//      quota, trial or debit write.
//   2. beforeInsert(client, ctx): the race-safe re-check inside the transaction, immediately
//      before the INSERT in both branches (trial: after consumeTrialInTx; non-trial: the first
//      statement of the tx). A hit ROLLS THE TRANSACTION BACK (undoing a trial consume) and
//      returns 200 { id } at once. It never falls through to the non-trial path the way
//      consumed:false does. A hook that throws rolls the tx back and the error propagates
//      (the route answers its normal 500); it never falls through to burst/quota either.
//   3. No hook runs after the INSERT.
// Lock order: trial_grants → the hook's lock → entitlements.
//
// WHY THIS FILE HAS NO RUNTIME IMPORTS. Every dependency arrives in `deps` (the route passes
// its own imports). The /api/jobs contract tests load route.ts by transpiling it in memory
// and rewriting each import to a per-test stub; an import-free module needs exactly one
// uniform rewrite (test/helpers/create-link-job.mjs, the same shape as the same-origin
// helper) and runs against whatever stubs that test already gives the route. `import type`
// below is erased at compile time.

import type { db as Db } from '@/lib/db';
import type { checkAdmission as CheckAdmission } from '@/lib/admission';
import type { canonicalizeYoutubeUrl as Canonicalize } from '@/lib/youtube-url';
import type {
  checkBurstLimit as CheckBurstLimit,
  checkMonthlyQuota as CheckMonthlyQuota,
  bumpJobsUsed as BumpJobsUsed,
  bumpJobsUsedWithinQuota as BumpJobsUsedWithinQuota,
  recordAllowanceDebit as RecordAllowanceDebit,
  rollPeriodIfStale as RollPeriodIfStale,
} from '@/lib/billing/rate-limit';
import type {
  getEntitlementSnapshot as GetEntitlementSnapshot,
  enforceEntitlement as EnforceEntitlement,
  EntitlementError as EntitlementErrorClass,
} from '@/lib/billing/entitlements';
import type { entitlementMessage as EntitlementMessage } from '@/lib/error-copy';
import type { consumeTrialInTx as ConsumeTrialInTx } from '@/lib/trial';

export type LinkJobDb = typeof Db;
export type LinkJobTxClient = Parameters<Parameters<LinkJobDb['tx']>[0]>[0];

export const LINK_VALID_BARS: ReadonlySet<number> = new Set([1, 2, 4, 8]);
export const LINK_DEFAULT_STEMS: readonly string[] = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'];
const LINK_VALID_STEMS: ReadonlySet<string> = new Set(LINK_DEFAULT_STEMS);

/** Everything the path touches outside itself. The route passes its own imports. */
export interface LinkJobDeps {
  db: LinkJobDb;
  randomUUID: () => string;
  canonicalizeYoutubeUrl: typeof Canonicalize;
  checkAdmission: typeof CheckAdmission;
  RATE_LIMIT: number;
  RATE_WINDOW_MS: number;
  checkBurstLimit: typeof CheckBurstLimit;
  checkMonthlyQuota: typeof CheckMonthlyQuota;
  bumpJobsUsed: typeof BumpJobsUsed;
  bumpJobsUsedWithinQuota: typeof BumpJobsUsedWithinQuota;
  recordAllowanceDebit: typeof RecordAllowanceDebit;
  rollPeriodIfStale: typeof RollPeriodIfStale;
  getEntitlementSnapshot: typeof GetEntitlementSnapshot;
  enforceEntitlement: typeof EnforceEntitlement;
  EntitlementError: typeof EntitlementErrorClass;
  FREE_QUOTA_EXHAUSTED_MESSAGE: string;
  LINK_CAP_CREDITS_DETAIL: string;
  RATE_LIMIT_MSG: string;
  entitlementMessage: typeof EntitlementMessage;
  consumeTrialInTx: typeof ConsumeTrialInTx;
  captureException: (err: unknown) => unknown;
  /** QA-64: called with recordAllowanceDebit()'s result (false = migration 042 missing). */
  noteAllowanceDebitRecorded: (recorded: boolean) => void;
}

export interface LinkJobHookContext {
  userId: string;
  canonicalUrl: string;
}

export interface CreateAuthedLinkJobInput {
  user: { user_id: string };
  /** The raw body fields, validated here exactly as the route always did. */
  url: unknown;
  stems?: unknown;
  loopLengthBars?: unknown;
  /**
   * The client IP hash. A thunk so it is computed where the route always computed it (just
   * before checkAdmission): clientIpHashOf() reads IP_HASH_KEY, which throws in production
   * when unset, and must not turn an earlier 403/400 refusal into a 500.
   */
  clientIpHash: () => string;
  /** Hook 1: read-only, lock-free. Returns an existing job id to reuse, or null. */
  findExisting?: (db: LinkJobDb, ctx: LinkJobHookContext) => Promise<string | null>;
  /** Hook 2: inside the tx, immediately before the INSERT. Returns an existing id, or null. */
  beforeInsert?: (client: LinkJobTxClient, ctx: LinkJobHookContext) => Promise<string | null>;
}

/**
 * A framework-free response. `raw` marks the one response the route has always built with
 * `new NextResponse(JSON.stringify(body), …)` (the burst 429) instead of NextResponse.json.
 */
export interface LinkJobResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  raw?: true;
}

// Thrown inside a tx to roll it back and answer 200 with an existing job id.
class ExistingJobHit {
  constructor(readonly id: string) {}
}
// Wraps an error thrown by beforeInsert so the trial branch's non-fatal catch cannot swallow
// it and fall through to burst/quota (hook contract 2). Unwrapped before it leaves this file.
class HookFailure {
  constructor(readonly err: unknown) {}
}

const json = (status: number, body: Record<string, unknown>, headers?: Record<string, string>): LinkJobResult =>
  headers ? { status, body, headers } : { status, body };

export async function createAuthedLinkJob(
  input: CreateAuthedLinkJobInput,
  deps: LinkJobDeps,
): Promise<LinkJobResult> {
  try {
    return await run(input, deps);
  } catch (err) {
    if (err instanceof HookFailure) throw err.err;
    throw err;
  }
}

async function runBeforeInsert(
  input: CreateAuthedLinkJobInput,
  client: LinkJobTxClient,
  ctx: LinkJobHookContext,
): Promise<void> {
  if (!input.beforeInsert) return;
  let hit: string | null;
  try {
    hit = await input.beforeInsert(client, ctx);
  } catch (err) {
    throw new HookFailure(err);
  }
  if (hit) throw new ExistingJobHit(hit);
}

async function run(input: CreateAuthedLinkJobInput, deps: LinkJobDeps): Promise<LinkJobResult> {
  const { user, url, stems, loopLengthBars } = input;
  const { db, EntitlementError } = deps;

  // ── YouTube / link-ingest job ──
  // SECURITY / A1 scope (review #7): the worker would actually run Cobalt/yt-dlp for a
  // youtube job (STUB_MODE isn't set in prod env), so gate the parked path at the door
  // — it can't be reached from the UI, but this blocks a direct API call too.
  if (process.env.ALLOW_YOUTUBE_INPUT !== 'true') {
    return json(403, {
      error_code: 'DOWNLOAD_INVALID_URL',
      message: 'YouTube links are paused right now. Upload the audio file instead.',
    });
  }

  if (!url || typeof url !== 'string') {
    return json(400, { error_code: 'DOWNLOAD_INVALID_URL', message: 'url is required' });
  }
  // QA fix (P2/UX #3 + P3 #5): canonicalize + require an actual video id, and accept
  // Shorts/Music/live/embed links, not just /watch and bare youtu.be/. Persisting the
  // canonicalized form (not the raw pasted url) also strips tracking params before the row
  // ever exists.
  const canonicalUrl = deps.canonicalizeYoutubeUrl(url);
  if (!canonicalUrl) {
    return json(400, {
      error_code: 'DOWNLOAD_INVALID_URL',
      message: 'That doesn’t look like a YouTube video link. Paste a full youtube.com or youtu.be link.',
    });
  }
  const bars = (loopLengthBars as number | undefined) ?? 4;
  if (!LINK_VALID_BARS.has(bars)) {
    return json(400, { error_code: 'DOWNLOAD_INVALID_URL', message: 'loop_length_bars must be 1, 2, 4, or 8' });
  }
  // QA fix (P2 #2): validate `stems` against the supported set, exactly as uploads do.
  if (
    stems !== undefined &&
    (!Array.isArray(stems) || stems.length === 0 || !stems.every((s: unknown) => LINK_VALID_STEMS.has(s as string)))
  ) {
    return json(400, { error_code: 'DOWNLOAD_INVALID_URL', message: 'stems must be a non-empty list of supported stems.' });
  }

  const ctx: LinkJobHookContext = { userId: user.user_id, canonicalUrl };

  // Hook 1 (D-e): before ANY gate that writes or locks.
  if (input.findExisting) {
    const hit = await input.findExisting(db, ctx);
    if (hit) return json(200, { id: hit });
  }

  // Link-ingest entitlement (TSD-V3-DELTA §1.2a REVERSED by Jon, 2026-11-16: Pro and Studio
  // may paste links; a paid link job is metered exactly like a paid upload). Runs BEFORE
  // admission / trial / quota so a refused paid request spends nothing.
  //   • Pro / Studio: every EntitlementError is returned as-is. A paid account NEVER falls
  //     through to the trial or free-allowance paths below.
  //   • Free / trial / no-plan: the outcome is ignored and the gates below decide.
  try {
    await deps.enforceEntitlement('start_job_youtube', user.user_id);
  } catch (err) {
    if (err instanceof EntitlementError) {
      let paid = false;
      try {
        const s = await deps.getEntitlementSnapshot(user.user_id);
        paid = s.plan_code === 'pro' || s.plan_code === 'studio';
      } catch {
        // Snapshot unreadable: not provably paid, so the free-tier gates below decide.
      }
      if (paid) {
        return json(err.status, { error_code: err.code, message: deps.entitlementMessage(err.code, err.message) });
      }
      // Free / trial outcomes are handled by the existing gates below.
    } else {
      // Snapshot/DB failure: fail open to the existing gates, but report it.
      deps.captureException(err);
    }
  }

  // §1.2a admission-before-consume (round-2 FIX #2): per-IP admission BEFORE the trial
  // consume, so a rate-limited request never spends a trial song.
  const clientIpHash = input.clientIpHash();
  const adm = await deps.checkAdmission(clientIpHash);
  if (!adm.allowed) {
    // B8: global capacity is NOT the client's fault — 503 + Retry-After and its own copy.
    if (adm.error_code === 'AT_CAPACITY') {
      return json(
        503,
        { error_code: adm.error_code, message: adm.message },
        { 'Retry-After': String(adm.retry_after_s) },
      );
    }
    return json(429, { error_code: adm.error_code, message: adm.message });
  }

  const id = deps.randomUUID();
  const requestedStems = Array.isArray(stems) && stems.length ? stems : LINK_DEFAULT_STEMS;

  const AUTHED_INSERT_SQL = `INSERT INTO jobs (id, youtube_url, requested_stems, loop_length_bars, status, client_ip_hash, client_fingerprint, user_id)
             SELECT $1, $2, $3, $4, 'queued', $5, '', $8::uuid
             WHERE (SELECT COUNT(*) FROM jobs WHERE client_ip_hash = $5
                    AND created_at >= NOW() - ($6::int * INTERVAL '1 millisecond')) < $7
             RETURNING id`;
  const insertParams = () => [
    id, canonicalUrl, requestedStems, bars, clientIpHash, deps.RATE_WINDOW_MS, deps.RATE_LIMIT, user.user_id,
  ];

  // How the non-trial link job is funded: a paid plan meters it with bumpJobsUsed() exactly
  // as a paid upload; everyone else spends one unit of the FREE monthly allowance, capped
  // under the quota lock (bumpJobsUsedWithinQuota). Credits are never spent on a link (the
  // credit_consumption trigger accepts upload jobs only, migration 013) and never waive the
  // allowance for one.
  let linkPaid = false;
  let linkQuota = 0;
  let linkCreditHolder = false;
  let subscribed = false;
  try {
    const snap = await deps.getEntitlementSnapshot(user.user_id);
    subscribed = snap.plan_code === 'pro' || snap.plan_code === 'studio';
    linkPaid = subscribed;
    linkQuota = snap.jobs_quota;
    linkCreditHolder = !subscribed && snap.credits_remaining > 0;
  } catch {
    // Fail restrictive: treat as not-subscribed and let the existing gates decide.
  }

  if (!subscribed) {
    // Try (consume trial + insert jobs) atomically. Outcomes:
    //   consumed:true          → tx committed, 201
    //   consumed:false         → tx committed, nothing changed; fall through to burst/quota
    //   throw RATE_SENTINEL    → tx rolled back (trial not burned), 429
    //   beforeInsert hit       → tx rolled back (trial not burned), 200 { id }
    const RATE_SENTINEL = Symbol('rate_limited');
    try {
      const outcome = await db.tx(async (client) => {
        const consume = await deps.consumeTrialInTx(client, user.user_id);
        if (!consume.ok) return { consumed: false as const };
        await runBeforeInsert(input, client, ctx);
        const r = await client.query(AUTHED_INSERT_SQL, insertParams());
        if (!r.rowCount) {
          // Rate-limited AFTER a successful trial consume: roll back, the song is NOT burned.
          throw RATE_SENTINEL;
        }
        await deps.bumpJobsUsed(client, user.user_id);
        // QA-64: this job spent a trial song AND an allowance unit; record both so an
        // our-fault failure gives exactly those back (worker job_failure.py).
        deps.noteAllowanceDebitRecorded(
          await deps.recordAllowanceDebit(client, user.user_id, id, { trialSong: true }),
        );
        return { consumed: true as const };
      });
      if (outcome.consumed) {
        return json(201, { id, status: 'queued' });
      }
      // consumed:false → fall through to burst/quota + plain INSERT.
    } catch (err) {
      if (err === RATE_SENTINEL) {
        return json(429, { error_code: 'RATE_LIMITED', message: deps.RATE_LIMIT_MSG });
      }
      if (err instanceof ExistingJobHit) return json(200, { id: err.id });
      if (err instanceof HookFailure) throw err;
      // Trial read/consume unexpected failure is non-fatal — log and fall through.
      deps.captureException(err);
    }
  }

  // Non-trial path: subscribed, or trial exhausted/missing.
  const burst = await deps.checkBurstLimit(user.user_id);
  if (burst) {
    return {
      status: 429,
      body: { error: 'too many requests', code: 'rate_limit_burst', retry_after_s: burst.retry_after_s },
      headers: { 'content-type': 'application/json', 'Retry-After': String(burst.retry_after_s) },
      raw: true,
    };
  }
  const quota = await deps.checkMonthlyQuota(user.user_id);
  if (quota) {
    return json(402, { error: 'monthly quota reached', code: 'quota_exceeded', resets_at: quota.resets_at });
  }

  // V3-C4 (TSD §1.4): tx + jobs_used bump so the counter is consistent with the real insert.
  // One job, one debit (2026-11-16):
  //   • Pro / Studio: bumpJobsUsed(), the same uncapped-in-tx metering a paid upload gets.
  //   • Free (incl. a free account holding credits): one unit of the free allowance, capped
  //     HERE under the quota lock (checkMonthlyQuota waives the quota for a credit holder).
  let inserted;
  try {
    inserted = await db.tx(async (client) => {
      await runBeforeInsert(input, client, ctx);
      const r = await client.query(AUTHED_INSERT_SQL, insertParams());
      if (r.rowCount) {
        // Period bookkeeping first, on EVERY authed link job whatever funds it.
        await deps.rollPeriodIfStale(client, user.user_id);
        if (linkPaid) {
          await deps.bumpJobsUsed(client, user.user_id);
        } else if (!(await deps.bumpJobsUsedWithinQuota(client, user.user_id, linkQuota))) {
          // Jon, 2026-11-16 ("Cap at 5/month"): a free account holding credits is capped at
          // the free allowance for links too; tell it its credits still work on uploads.
          throw linkCreditHolder
            ? new EntitlementError('FREE_MONTHLY_QUOTA_EXHAUSTED', deps.LINK_CAP_CREDITS_DETAIL)
            : new EntitlementError('FREE_MONTHLY_QUOTA_EXHAUSTED', deps.FREE_QUOTA_EXHAUSTED_MESSAGE);
        }
        // QA-64: one allowance unit spent (paid or free); record it so an our-fault failure
        // gives it back once, in the period it was spent in.
        deps.noteAllowanceDebitRecorded(
          await deps.recordAllowanceDebit(client, user.user_id, id, { trialSong: false }),
        );
      }
      return r;
    });
  } catch (err) {
    if (err instanceof ExistingJobHit) return json(200, { id: err.id });
    // Allowance spent under the lock: the tx rolled back, no job row exists.
    if (err instanceof EntitlementError) {
      return json(err.status, { error_code: err.code, message: deps.entitlementMessage(err.code, err.message) });
    }
    throw err;
  }
  if (!inserted.rowCount) {
    return json(429, { error_code: 'RATE_LIMITED', message: deps.RATE_LIMIT_MSG });
  }
  return json(201, { id, status: 'queued' });
}
