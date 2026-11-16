-- 038_v3_subscriptions_user_id_idx.sql — full index on subscriptions(user_id) for
-- paid-plan library retention (PR #279).
--
-- The retention rule (worker cleanup.RETAINED_UNTIL_SQL == web lib/retention.ts
-- JOB_RETAINED_UNTIL_SQL) runs a correlated subquery over ALL of a job owner's
-- subscription rows, canceled ones included (they carry the 30-day grace). 013's
-- subscriptions_user_active_idx is PARTIAL (status IN trialing/active/past_due), so
-- without this index every evaluated job row seq-scans subscriptions: the sweep,
-- /api/library and every job route. The code is correct without it, only slower.
--
-- Not CONCURRENTLY: the runner applies each file inside one transaction, where
-- CREATE INDEX CONCURRENTLY is not allowed. subscriptions is small (one row per
-- checkout), so the brief SHARE lock is acceptable.
--
-- Idempotent. Down: migrations/down/038_v3_subscriptions_user_id_idx_down.sql.

CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx
  ON public.subscriptions (user_id);
