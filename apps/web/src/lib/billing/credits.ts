// Credit consumption — V3 Phase 1b (TSD §1.9; credit-ledger review B1 + M3).
//
// consumeCreditInTx runs INSIDE the caller's db.tx(), AFTER the `jobs` row
// has been INSERTed. Order matters: the check_credit_decrement trigger
// (migration 013) looks the job up and requires input_kind='upload', so the
// jobs row must already exist in the tx. If the caller later throws, the
// whole tx (jobs row + consumption row) rolls back and no credit is burned.
//
// Double-spend defence (M3): the balance check does NOT use the 30 s
// entitlement cache. It is a conditional INSERT evaluated in the DB under a
// per-user pg_advisory_xact_lock, so N concurrent uploads for a user with
// 1 credit serialise and exactly one INSERT sees credits_remaining > 0.
// Same shape as consumeTrialInTx in lib/trial.ts.

import { EntitlementError } from '@/lib/billing/entitlements';

export const CREDIT_CONSUME_LOCK_TAG = 'credit_consume';

type TxClient = {
  query<R extends { [k: string]: unknown } = { [k: string]: unknown }>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
};

/**
 * Charge one credit for `jobId`. Throws EntitlementError
 * ('CREDIT_BALANCE_INSUFFICIENT') when the user has no credits left.
 * Idempotent per job via credit_consumption UNIQUE(job_id): a duplicate
 * job_id raises a unique-violation (propagated; the tx rolls back).
 */
export async function consumeCreditInTx(
  client: TxClient,
  userId: string,
  jobId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2::text))`,
    [CREDIT_CONSUME_LOCK_TAG, userId],
  );
  const res = await client.query<{ id: string }>(
    `INSERT INTO credit_consumption (user_id, job_id)
     SELECT $1::uuid, $2::uuid
      WHERE (SELECT credits_remaining FROM v_credit_balance WHERE user_id = $1::uuid) > 0
     RETURNING id`,
    [userId, jobId],
  );
  if (!res.rowCount) {
    throw new EntitlementError('CREDIT_BALANCE_INSUFFICIENT');
  }
}
