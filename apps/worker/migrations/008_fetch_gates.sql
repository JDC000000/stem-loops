-- Migration 008 (SL21 Phase 0, BUILD-R s2.2 / s7): fetch gates. Additive only.
--   kill_switches  - DB-backed switches the worker reads (<= 30 s cache); replaces redeploys.
--                    enabled = TRUE means the switch is ENGAGED, i.e. the capability is STOPPED.
--                    scope is free text (no enum/check): documented scopes are fetch_global,
--                    fetch_youtube, fetch_spotify, serve_mix_first, payments_r (BUILD-R s7) and
--                    fetch_cobalt (SL21). fetch_cobalt is seeded ENGAGED = Cobalt OFF by default.
--   blocklist      - per-video (or ISRC) takedown list, checked before any outbound fetch.
--   fetch_attempts - one row per fetch attempt; 90-day retention (sweep not part of this migration).
-- Down migration: migrations/down/008_fetch_gates_down.sql (NOT picked up by the runner glob).

CREATE TABLE IF NOT EXISTS kill_switches (
    scope   text        PRIMARY KEY,
    enabled boolean     NOT NULL DEFAULT false,
    reason  text,
    set_by  text,
    set_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO kill_switches (scope, enabled, reason, set_by)
VALUES ('fetch_cobalt', true,
        'default OFF: Cobalt stays out of the fetch chain unless T-F1 shows it adds >= 2 points',
        'migration 008')
ON CONFLICT (scope) DO NOTHING;

CREATE TABLE IF NOT EXISTS blocklist (
    video_id   text        PRIMARY KEY,
    reason     text        NOT NULL CHECK (reason IN ('takedown', 'rightsholder', 'manual')),
    notice_ref text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- No FK to jobs on purpose: jobs rows are swept at 24 h, fetch_attempts is kept 90 days.
CREATE TABLE IF NOT EXISTS fetch_attempts (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id            uuid,
    attempt           smallint    NOT NULL,
    path              text        NOT NULL,   -- ytdlp_proxy | ytdlp_direct | cobalt | capture
    exit_session_hash text,                   -- sha256(proxy session id)[:16]; never the id itself
    outcome_class     text        NOT NULL,   -- ok | <error_code> | other_error
    ms_first_byte     integer,
    ms_total          integer,
    bytes             bigint,
    ytdlp_version     text,
    video_hash        text,                   -- sha256(video_id)[:16] for the D1 repeat-rate log
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fetch_attempts_created_idx ON fetch_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS fetch_attempts_job_idx ON fetch_attempts (job_id);
