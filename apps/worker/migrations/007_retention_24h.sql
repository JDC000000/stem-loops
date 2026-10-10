-- Migration 007: retention 7 days -> 24 hours.
-- New jobs expire 24h after creation (the worker's retention sweep deletes the job row
-- AND its R2 objects once expires_at passes). Migration 001 is not edited.
ALTER TABLE jobs ALTER COLUMN expires_at SET DEFAULT (now() + INTERVAL '24 hours');

-- Also shorten rows that already exist so the on-site promise ("Files are deleted after
-- 24 hours") is true for them too. Only ever shortens (the WHERE excludes shorter rows).
-- Rows older than 24h become immediately eligible and are swept (R2 + DB) in batches.
UPDATE jobs
   SET expires_at = created_at + INTERVAL '24 hours'
 WHERE expires_at > created_at + INTERVAL '24 hours';
