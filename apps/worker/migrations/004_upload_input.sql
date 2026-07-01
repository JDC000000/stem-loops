-- Migration 004: file-upload as a first-class job input (V2 primary input).
-- YouTube-link ingestion is deferred post-launch (off-datacenter-egress work),
-- so youtube_url becomes nullable and jobs gain an explicit input kind.

ALTER TABLE jobs ALTER COLUMN youtube_url DROP NOT NULL;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS input_kind text NOT NULL DEFAULT 'youtube'
      CHECK (input_kind IN ('youtube', 'upload')),
  ADD COLUMN IF NOT EXISTS upload_r2_key text,
  ADD COLUMN IF NOT EXISTS original_filename text;

-- An upload job must carry its uploaded object key; a youtube job must carry a url.
ALTER TABLE jobs
  ADD CONSTRAINT jobs_input_source_chk CHECK (
    (input_kind = 'upload'  AND upload_r2_key IS NOT NULL) OR
    (input_kind = 'youtube' AND youtube_url  IS NOT NULL)
  );
