// AUTO-GENERATED — DO NOT EDIT
// Source of truth: apps/worker/src/worker/models.py
// Regenerate with: make types-generate

export interface JobRequest {
  youtube_url: string;
  requested_stems: string[];
  loop_length_bars: number;
}

export interface ErrorEnvelope {
  error_code: string;
  message: string;
}

export interface Loop {
  id: string;
  job_id: string;
  stem: string;
  section_label: string;
  energy_class: string;
  start_sec: number;
  end_sec: number;
  start_bar: number;
  bar_count: number;
  bpm?: number | null;
  musical_key?: string | null;
  r2_key: string;
  filename: string;
  duration_ms?: number | null;
  waveform_peaks?: number[] | null;
  signed_url?: string | null;
  created_at: string;
}

export interface JobEvent {
  id: number;
  job_id: string;
  stage: string;
  phase: string;
  pct?: number | null;
  duration_ms?: number | null;
  created_at: string;
}

export interface Job {
  id: string;
  input_kind?: string;
  youtube_url?: string | null;
  upload_r2_key?: string | null;
  original_filename?: string | null;
  status: string;
  error_code?: string | null;
  error_message_user?: string | null;
  bpm?: number | null;
  musical_key?: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  events?: JobEvent[];
  loops?: Loop[];
}

export interface JobResponse {
  job: Job;
}
