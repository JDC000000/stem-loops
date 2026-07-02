-- Migration 005: per-IP rate-limit log for the presigned-upload endpoint.
-- Security review BLOCKER #2: POST /api/uploads mints a 200MB R2 PUT credential and
-- previously had NO throttle. Uploads happen before any `jobs` row exists, so they
-- can't be counted by the jobs-based admission gate — this lightweight append-only
-- log lets the web layer count recent presign requests per client_ip_hash and refuse
-- a flood (see admission.checkUploadRate). The web layer only inserts when under the
-- cap, so the table stays bounded. T33 retention cleanup should also sweep it.

CREATE TABLE IF NOT EXISTS upload_rate_events (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_ip_hash text        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS upload_rate_events_ip_time_idx
    ON upload_rate_events (client_ip_hash, created_at DESC);
