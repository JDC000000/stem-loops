// AUTO-GENERATED — DO NOT EDIT
// Source of truth: apps/worker/src/models.py
// Regenerate with: make types-generate

export type JobStatus =
  | "queued"
  | "downloading"
  | "separating"
  | "extracting"
  | "uploading"
  | "done"
  | "failed";

export type StemName =
  | "vocals"
  | "drums"
  | "bass"
  | "other";

export type EventStage =
  | "downloading"
  | "separating"
  | "extracting"
  | "uploading";

export type EventType =
  | "started"
  | "completed"
  | "failed";

export type ErrorCode =
  | "DOWNLOAD_BLOCKED"
  | "DOWNLOAD_TIMEOUT"
  | "DOWNLOAD_INVALID_URL"
  | "DOWNLOAD_AGE_RESTRICTED"
  | "DOWNLOAD_PRIVATE"
  | "SEPARATION_FAILED"
  | "EXTRACTION_FAILED"
  | "UPLOAD_FAILED"
  | "INTERNAL_ERROR"
  | "RATE_LIMITED";

export interface Loop {
  id: string;
  job_id: string;
  stem: StemName;
  bar_count: number;
  loop_length_bars: number;
  r2_key: string;
  r2_url: string;
  duration_seconds?: number | null;
  bpm?: number | null;
  created_at: string;
}

export interface JobEvent {
  id: string;
  job_id: string;
  stage: EventStage;
  event_type: EventType;
  detail?: string | null;
  created_at: string;
}

export interface Job {
  id: string;
  source_url: string;
  stems: StemName[];
  loop_length_bars: number;
  status: JobStatus;
  error_code?: ErrorCode | null;
  error_detail?: string | null;
  client_ip_hash?: string | null;
  created_at: string;
  updated_at: string;
  expires_at?: string | null;
  loops?: Loop[] | null;
  events?: JobEvent[] | null;
}

export interface JobResponse extends Job {}

export interface CreateJobRequest {
  source_url: string;
  stems?: StemName[];
  loop_length_bars?: number;
  client_ip_hash?: string | null;
}
