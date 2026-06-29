-- Migration 002: job_events table (structured per-stage trace)
CREATE TABLE IF NOT EXISTS job_events (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage       text NOT NULL
              CHECK (stage IN ('downloading','separating','extracting','uploading')),
  phase       text NOT NULL
              CHECK (phase IN ('started','completed','failed')),
  pct         smallint CHECK (pct BETWEEN 0 AND 100),
  duration_ms integer,
  detail      jsonb,   -- redacted + truncated; server-side only, NEVER in API responses
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_events_job_id_idx ON job_events(job_id, created_at);
