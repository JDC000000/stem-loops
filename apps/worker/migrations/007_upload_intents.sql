-- Migration 007: bind every presigned upload to the one job it was minted for.
--
-- Hardening review C1 (cross-tenant audio exfiltration). POST /api/uploads minted an R2
-- PUT credential for `{jobId}/_input.{ext}` and handed the key to the browser, which
-- passed it back to POST /api/jobs. Nothing on the server bound that key to that job or
-- proved we had minted it at all, and GET /api/jobs/:id (no auth) returned the raw
-- upload_r2_key of any job whose UUID you knew. So: read a stranger's key, submit a new
-- job referencing it, and the worker reprocesses their private audio and hands you the
-- stems. The same key could also be replayed into unlimited jobs, each billing Replicate.
--
-- This table is the server-side record of "we minted this key, for this job, once".
-- /api/jobs claims it with a single UPDATE ... WHERE consumed_at IS NULL inside the job
-- insert transaction, so a key is usable exactly once and only by its own job id.

CREATE TABLE IF NOT EXISTS upload_intents (
    job_id         uuid        PRIMARY KEY,
    r2_key         text        NOT NULL UNIQUE,
    client_ip_hash text        NOT NULL,
    consumed_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- Retention sweep (cleanup.sweep_expired) prunes by age; intents are only useful for the
-- ~15 min presign lifetime.
CREATE INDEX IF NOT EXISTS upload_intents_created_at_idx ON upload_intents (created_at);

-- Defence in depth behind the consumed flag: one uploaded object can back at most one
-- job row. NOTE: if this index fails to build on an existing database, duplicate
-- upload_r2_key values are already present — which is itself evidence of a replayed key
-- and should be investigated before forcing the migration through.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_upload_r2_key_uniq
    ON jobs (upload_r2_key) WHERE upload_r2_key IS NOT NULL;
