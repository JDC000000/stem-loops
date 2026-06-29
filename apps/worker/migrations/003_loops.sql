-- Migration 003: loops table
CREATE TABLE IF NOT EXISTS loops (
  id             uuid PRIMARY KEY,
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stem           text NOT NULL
                 CHECK (stem IN ('drums','bass','vocals','guitar','keys','other')),
  section_label  text NOT NULL
                 CHECK (section_label IN ('intro','verse','chorus','bridge','outro')),
  energy_class   text NOT NULL
                 CHECK (energy_class IN ('low','mid','high')),
  start_sec      numeric NOT NULL,
  end_sec        numeric NOT NULL,
  start_bar      integer NOT NULL,
  bar_count      integer NOT NULL CHECK (bar_count IN (1,2,4,8)),
  bpm            numeric,
  musical_key    text,
  r2_key         text NOT NULL,
  filename       text NOT NULL,
  duration_ms    integer,
  waveform_peaks jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, r2_key)
);

CREATE INDEX IF NOT EXISTS loops_job_stem_idx ON loops(job_id, stem);
