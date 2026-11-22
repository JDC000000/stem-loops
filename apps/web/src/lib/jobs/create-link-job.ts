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
//      That includes an EntitlementError thrown by a hook: it is a 500, not a 402.
//   3. No hook runs after the INSERT.
// Lock order: trial_grants → the hook's lock → entitlements.
//
// WHY THIS FILE HAS NO RUNTIME IMPORTS. Every dependency arrives in `deps` (the route passes
// its own imports). The /api/jobs contract tests load route.ts by transpiling it in memory
// and rewriting each import to a per-test stub; an import-free module needs exactly one
// uniform rewrite (test/helpers/create-link-job.mjs, the same shape as the same-origin
// helper) and runs against whatever stubs that test already gives the route. `import type`
// below is erased at compile time.
//
// FUNDING MODE mirror_restore (Phase B, B3: "Try again" on a failed link song, #321). An
// OPTIONAL `funding` input; absent, everything above and below is exactly B0. Present, the
// job is a retry of `funding.parentJobId` and is funded by MIRRORING what the parent's failure
// gave back (migration 042's job_allowance_debits row: allowance_restored → one allowance
// unit, trial_restored → one trial song, free if the trial has since expired; anything else,
// including no row, → free, no debit row). Its order:
//
//   ALLOW_YOUTUBE_INPUT → url / canonicalisation → loop bars → stems → [findExisting]
//   → read the parent's restore (lock-free: picks the gates) → link entitlement (charged only)
//   → checkAdmission → checkBurstLimit (every retry) → checkMonthlyQuota (unit only)
//   → db.tx { consumeTrialInTx (trial song only) → SELECT parent … FOR UPDATE
//             → require owner, failed, link, retried_at IS NULL, retry_depth < RETRY_CAP
//             → SELECT the parent's debit row … FOR UPDATE: the funding is decided HERE; if it
//               differs from the lock-free read, roll back and run the gates again (once)
//             → [beforeInsert] → INSERT (retry_of, retry_depth = parent + 1)
//             → rollPeriodIfStale → bump (unit only) → debit row (charged only)
//             → claim the parent's debit row if still unclaimed (nothing given back)
//             → UPDATE parent SET retried_at = now()   ← only when the INSERT returned a row }
//
// THE LATE-RESTORE RACE (review R1 should-fix 1). The worker can commit a failure in one
// transaction and give the unit back in a second (job_failure.fail_job). A retry that ran in
// between would read "not given back" and be free, and the late restore would then give the
// unit back too: +1 for the user. So the retry locks the parent's job_allowance_debits row
// (restore_job_allowance() claims it with the same FOR UPDATE), decides the funding from that
// locked read, and, when the row is still unclaimed, claims it itself (restored_at = now(),
// nothing restored). A restore that comes later finds it claimed and gives nothing back; a
// restore that came first is seen and the retry is charged for it.
//
// A free retry (nothing was given back) therefore skips the paid entitlement, the quota and
// the trial; admission and the burst limit still apply. Lock order is B0's: trial_grants →
// the parent row (the "hook's lock") → entitlements. A second retry of the same parent waits
// on the parent lock, then finds retried_at set and answers 200 with the first retry's id.

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
  /**
   * B3: fund this job as a retry of `parentJobId` (see "FUNDING MODE mirror_restore" above).
   * Absent → B0's funding, unchanged. The caller (app/api/jobs/[id]/retry) has already checked
   * ownership, the error code and the cooldown; the cap, the owner and `failed` are checked
   * again here under the parent's row lock. `limitMessage` is the 429 copy for a parent that
   * has used its retries (error-copy.ts RETRY_LIMIT_MSG; this file has no runtime imports).
   */
  funding?: MirrorRestoreFunding;
}

export interface MirrorRestoreFunding {
  mode: 'mirror_restore';
  parentJobId: string;
  limitMessage: string;
  /** 402 copy when the trial song given back has been spent since (default: TRIAL_EXHAUSTED's). */
  trialUsedMessage?: string;
}

/** At most this many user retries per original (Jon, D7). jobs.retry_depth's CHECK is 0..2. */
export const RETRY_CAP = 2;

/** The parent's job_allowance_debits restore columns (migration 042), or null for no row. */
export interface ParentRestore {
  restored_at: string | Date | null;
  allowance_restored: boolean | null;
  trial_restored: boolean | null;
}

/**
 * What a retry spends: exactly what the parent's failure gave back. Only an explicit `true`
 * restore counts. No row (an anonymous or pre-042 job, a free retry), an unclaimed row (a
 * user-fault failure such as DOWNLOAD_BLOCKED) and a claimed row that gave nothing back
 * (restored_at set, the period had rolled over) are all free.
 */
export function mirrorRestoreCharge(r: ParentRestore | null): { unit: boolean; trialSong: boolean } {
  if (!r || r.restored_at === null || r.restored_at === undefined) return { unit: false, trialSong: false };
  return { unit: r.allowance_restored === true, trialSong: r.trial_restored === true };
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

  // B3: a retry is funded by mirroring its parent's restore. Absent → B0, unchanged below.
  if (input.funding && input.funding.mode === 'mirror_restore') {
    return runMirrorRestore(input, input.funding, deps, ctx, bars);
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

// ── B3: funding mode mirror_restore ─────────────────────────────────────────────────────────

// Thrown inside the retry tx to roll it back and answer a refusal (404 / 429).
class MirrorRefusal {
  constructor(readonly result: LinkJobResult) {}
}

const NOT_FOUND_BODY = { error_code: 'NOT_FOUND', message: 'Job not found' };

// The parent's restore, read lock-free to decide which gates a retry passes. The row is
// written once, in the transaction that marks the parent failed (migration 042), so it does
// not change under a failed parent. A database without 042 (42P01) has no restore: free.
const PARENT_RESTORE_SQL = `SELECT d.restored_at, d.allowance_restored, d.trial_restored
             FROM public.job_allowance_debits d WHERE d.job_id = $1::uuid`;

// The cap's lock (brief B3 step 1). Every retry of one parent serialises here.
const LOCK_PARENT_SQL = `SELECT id, user_id, status, input_kind, retry_depth, retried_at
             FROM jobs WHERE id = $1::uuid FOR UPDATE`;

const RETRY_CHILD_SQL = `SELECT id FROM jobs WHERE retry_of = $1::uuid ORDER BY created_at DESC LIMIT 1`;

// B0's INSERT plus retry_of / retry_depth; the same per-IP WHERE.
const RETRY_INSERT_SQL = `INSERT INTO jobs (id, youtube_url, requested_stems, loop_length_bars, status, client_ip_hash, client_fingerprint, user_id, retry_of, retry_depth)
             SELECT $1, $2, $3, $4, 'queued', $5, '', $8::uuid, $9::uuid, $10::smallint
             WHERE (SELECT COUNT(*) FROM jobs WHERE client_ip_hash = $5
                    AND created_at >= NOW() - ($6::int * INTERVAL '1 millisecond')) < $7
             RETURNING id`;

const MARK_RETRIED_SQL = `UPDATE jobs SET retried_at = now() WHERE id = $1::uuid`;

// The parent's restore, read under the same row lock restore_job_allowance() takes (042).
const LOCK_RESTORE_SQL = `SELECT restored_at, allowance_restored, trial_restored
             FROM public.job_allowance_debits WHERE job_id = $1::uuid FOR UPDATE`;

// A still-unclaimed debit row is claimed by the retry: nothing was given back, and a later
// restore must not give it back either (the retry stands in for it).
const CLAIM_RESTORE_SQL = `UPDATE public.job_allowance_debits
             SET restored_at = now(), allowance_restored = false, trial_restored = false
             WHERE job_id = $1::uuid AND restored_at IS NULL`;

/** The locked restore row: undefined = no row, null = no table (042 not applied). */
async function lockParentRestore(client: LinkJobTxClient, parentJobId: string): Promise<ParentRestore | undefined | null> {
  await client.query('SAVEPOINT parent_restore');
  try {
    const r = await client.query(LOCK_RESTORE_SQL, [parentJobId]);
    await client.query('RELEASE SAVEPOINT parent_restore');
    return (r.rows[0] as ParentRestore | undefined) ?? undefined;
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '42P01') {
      await client.query('ROLLBACK TO SAVEPOINT parent_restore');
      return null;
    }
    throw err;
  }
}

// The funding read under the lock differs from the lock-free one: roll back, run the gates again.
class FundingChanged {}

// A trial song with no allowance unit (the parent's unit was not given back, e.g. the month
// rolled over): recordAllowanceDebit always copies the current period, so this row is written
// here with allowance_period_start NULL ("no allowance unit was spent", migration 042). Same
// SAVEPOINT + 42P01 tolerance as recordAllowanceDebit.
const TRIAL_ONLY_DEBIT_SQL = `INSERT INTO public.job_allowance_debits (job_id, user_id, allowance_period_start, trial_song)
             VALUES ($1::uuid, $2::uuid, NULL, true)
             ON CONFLICT (job_id) DO NOTHING`;

async function recordTrialOnlyDebit(client: LinkJobTxClient, userId: string, jobId: string): Promise<boolean> {
  await client.query('SAVEPOINT job_allowance_debit');
  try {
    await client.query(TRIAL_ONLY_DEBIT_SQL, [jobId, userId]);
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '42P01') {
      await client.query('ROLLBACK TO SAVEPOINT job_allowance_debit');
      return false;
    }
    throw err;
  }
  await client.query('RELEASE SAVEPOINT job_allowance_debit');
  return true;
}

async function readParentRestore(db: LinkJobDb, parentJobId: string): Promise<ParentRestore | null> {
  try {
    const r = await db.query(PARENT_RESTORE_SQL, [parentJobId]);
    return (r.rows[0] as ParentRestore | undefined) ?? null;
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '42P01') return null;
    throw err;
  }
}

type LockedParent = {
  id: string;
  user_id: string | null;
  status: string;
  input_kind: string | null;
  retry_depth: number | null;
  retried_at: string | Date | null;
};

async function runMirrorRestore(
  input: CreateAuthedLinkJobInput,
  funding: MirrorRestoreFunding,
  deps: LinkJobDeps,
  ctx: LinkJobHookContext,
  bars: number,
  attempt = 0,
): Promise<LinkJobResult> {
  const { user, stems } = input;
  const { db, EntitlementError } = deps;
  const parentJobId = funding.parentJobId;
  const limit = (): LinkJobResult => json(429, { error_code: 'RETRY_LIMIT', message: funding.limitMessage });

  const charge = mirrorRestoreCharge(await readParentRestore(db, parentJobId));
  const charged = charge.unit || charge.trialSong;

  // A charged retry passes B0's paid entitlement exactly as a new link does; a free retry
  // spends nothing, so it is not asked about the plan's allowance.
  if (charged) {
    try {
      await deps.enforceEntitlement('start_job_youtube', user.user_id);
    } catch (err) {
      if (err instanceof EntitlementError) {
        let paid = false;
        try {
          const s = await deps.getEntitlementSnapshot(user.user_id);
          paid = s.plan_code === 'pro' || s.plan_code === 'studio';
        } catch {
          // not provably paid: the gates below decide
        }
        if (paid) {
          return json(err.status, { error_code: err.code, message: deps.entitlementMessage(err.code, err.message) });
        }
      } else {
        deps.captureException(err);
      }
    }
  }

  // Admission on every retry, before anything is consumed (B0's order).
  const clientIpHash = input.clientIpHash();
  const adm = await deps.checkAdmission(clientIpHash);
  if (!adm.allowed) {
    if (adm.error_code === 'AT_CAPACITY') {
      return json(
        503,
        { error_code: adm.error_code, message: adm.message },
        { 'Retry-After': String(adm.retry_after_s) },
      );
    }
    return json(429, { error_code: adm.error_code, message: adm.message });
  }

  let linkPaid = false;
  let linkQuota = 0;
  let linkCreditHolder = false;
  if (charge.unit) {
    try {
      const snap = await deps.getEntitlementSnapshot(user.user_id);
      linkPaid = snap.plan_code === 'pro' || snap.plan_code === 'studio';
      linkQuota = snap.jobs_quota;
      linkCreditHolder = !linkPaid && snap.credits_remaining > 0;
    } catch {
      // Fail restrictive, as B0: not paid, quota 0 → bumpJobsUsedWithinQuota refuses.
    }
  }

  // The burst limit applies to every retry, free or charged (the button must not hammer).
  const burst = await deps.checkBurstLimit(user.user_id);
  if (burst) {
    return {
      status: 429,
      body: { error: 'too many requests', code: 'rate_limit_burst', retry_after_s: burst.retry_after_s },
      headers: { 'content-type': 'application/json', 'Retry-After': String(burst.retry_after_s) },
      raw: true,
    };
  }
  // Only a retry that spends an allowance unit is quota-checked.
  if (charge.unit) {
    const quota = await deps.checkMonthlyQuota(user.user_id);
    if (quota) {
      return json(402, { error: 'monthly quota reached', code: 'quota_exceeded', resets_at: quota.resets_at });
    }
  }

  const id = deps.randomUUID();
  const requestedStems = Array.isArray(stems) && stems.length ? stems : LINK_DEFAULT_STEMS;
  const RATE_SENTINEL = Symbol('rate_limited');

  let inserted: boolean;
  try {
    inserted = await db.tx(async (client) => {
      // 1. The trial song first (lock order: trial_grants → parent row → entitlements).
      let trialCharged = false;
      if (charge.trialSong) {
        const consume = await deps.consumeTrialInTx(client, user.user_id);
        if (consume.ok) {
          trialCharged = true;
        } else if (consume.reason === 'exhausted') {
          // The song given back has been spent since: refused, with retry copy (credit packs
          // never fund a link, so the generic trial line's "buy a credit pack" would be wrong).
          throw new MirrorRefusal(json(402, {
            error_code: 'TRIAL_EXHAUSTED',
            message: funding.trialUsedMessage ?? deps.entitlementMessage('TRIAL_EXHAUSTED'),
          }));
        }
        // 'expired' / 'no_grant': there is no trial left to spend into, so this part is free.
      }

      // 2. The cap, under the parent's row lock.
      const p = (await client.query(LOCK_PARENT_SQL, [parentJobId])).rows[0] as LockedParent | undefined;
      if (!p || p.user_id !== user.user_id || p.status !== 'failed' || p.input_kind !== 'youtube') {
        throw new MirrorRefusal(json(404, NOT_FOUND_BODY));
      }
      if (p.retried_at !== null && p.retried_at !== undefined) {
        // Already retried (a double tap, or a second tab): the same answer as a hook hit.
        const child = (await client.query(RETRY_CHILD_SQL, [parentJobId])).rows[0] as { id: string } | undefined;
        if (child) throw new ExistingJobHit(child.id);
        throw new MirrorRefusal(limit());
      }
      const depth = Number(p.retry_depth ?? 0);
      if (!(depth < RETRY_CAP)) throw new MirrorRefusal(limit());

      // 2b. The funding, decided under the debit row's lock (see THE LATE-RESTORE RACE).
      const lockedRestore = await lockParentRestore(client, parentJobId);
      const lockedCharge = mirrorRestoreCharge(lockedRestore ?? null);
      if (lockedCharge.unit !== charge.unit || lockedCharge.trialSong !== charge.trialSong) throw new FundingChanged();

      await runBeforeInsert(input, client, ctx);

      // 3. The retry row.
      const r = await client.query(RETRY_INSERT_SQL, [
        id, ctx.canonicalUrl, requestedStems, bars, clientIpHash, deps.RATE_WINDOW_MS, deps.RATE_LIMIT, user.user_id,
        parentJobId, depth + 1,
      ]);
      if (!r.rowCount) {
        // Per-IP limit. A consumed trial song must come back (roll back); otherwise nothing
        // was written and the tx commits as B0's non-trial branch does — retried_at stays NULL.
        if (trialCharged) throw RATE_SENTINEL;
        return false;
      }

      await deps.rollPeriodIfStale(client, user.user_id);
      if (charge.unit) {
        if (linkPaid) {
          await deps.bumpJobsUsed(client, user.user_id);
        } else if (!(await deps.bumpJobsUsedWithinQuota(client, user.user_id, linkQuota))) {
          throw linkCreditHolder
            ? new EntitlementError('FREE_MONTHLY_QUOTA_EXHAUSTED', deps.LINK_CAP_CREDITS_DETAIL)
            : new EntitlementError('FREE_MONTHLY_QUOTA_EXHAUSTED', deps.FREE_QUOTA_EXHAUSTED_MESSAGE);
        }
        deps.noteAllowanceDebitRecorded(
          await deps.recordAllowanceDebit(client, user.user_id, id, { trialSong: trialCharged }),
        );
      } else if (trialCharged) {
        deps.noteAllowanceDebitRecorded(await recordTrialOnlyDebit(client, user.user_id, id));
      }

      // 4. Only now, with the row inserted: claim an unclaimed restore, and mark the parent.
      if (lockedRestore) await client.query(CLAIM_RESTORE_SQL, [parentJobId]);
      await client.query(MARK_RETRIED_SQL, [parentJobId]);
      return true;
    });
  } catch (err) {
    if (err === RATE_SENTINEL) return json(429, { error_code: 'RATE_LIMITED', message: deps.RATE_LIMIT_MSG });
    if (err instanceof ExistingJobHit) return json(200, { id: err.id });
    if (err instanceof MirrorRefusal) return err.result;
    if (err instanceof FundingChanged) {
      // A restore landed between the lock-free read and the lock: decide again, once.
      if (attempt < 1) return runMirrorRestore(input, funding, deps, ctx, bars, attempt + 1);
      return json(409, { error_code: 'RETRY_CONFLICT', message: 'Something changed while starting this. Try again.' });
    }
    if (err instanceof EntitlementError) {
      return json(err.status, { error_code: err.code, message: deps.entitlementMessage(err.code, err.message) });
    }
    throw err;
  }
  if (!inserted) return json(429, { error_code: 'RATE_LIMITED', message: deps.RATE_LIMIT_MSG });
  return json(201, { id, status: 'queued' });
}
