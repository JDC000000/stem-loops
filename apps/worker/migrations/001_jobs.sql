-- Migration 001: jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id                      uuid PRIMARY KEY,
  youtube_url             text NOT NULL,
  video_id                text,
  title                   text,
  requested_stems         text[] NOT NULL DEFAULT '{}',
  loop_length_bars        smallint NOT NULL CHECK (loop_length_bars IN (1,2,4,8)),
  status                  text NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','downloading','separating','extracting','uploading','done','failed')),
  error_code              text,
  error_message_user      text,
  bpm                     numeric,
  musical_key             text,
  replicate_prediction_id text,
  client_ip_hash          text NOT NULL,
  client_fingerprint      text NOT NULL DEFAULT '',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL DEFAULT (now() + INTERVAL '7 days')
);

CREATE INDEX IF NOT EXISTS jobs_status_idx     ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_expires_at_idx ON jobs(expires_at);
CREATE INDEX IF NOT EXISTS jobs_ip_hash_idx    ON jobs(client_ip_hash, created_at);
