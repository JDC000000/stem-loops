/* AUTO-GENERATED from apps/worker Pydantic models — DO NOT EDIT. Run: make codegen */

export type ErrorCode = string;
export type Message = string;
export type Bpm = number | null;
export type CreatedAt = string;
export type ErrorCode1 = string | null;
export type ErrorMessageUser = string | null;
export type CreatedAt1 = string;
export type DurationMs = number | null;
export type Id = number;
export type JobId = string;
export type Pct = number | null;
export type Phase = string;
export type Stage = string;
export type Events = JobEvent[];
export type ExpiresAt = string;
export type Id1 = string;
export type BarCount = number;
export type Bpm1 = number | null;
export type CreatedAt2 = string;
export type DurationMs1 = number | null;
export type EndSec = number;
export type EnergyClass = string;
export type Filename = string;
export type Id2 = string;
export type JobId1 = string;
export type MusicalKey = string | null;
export type R2Key = string;
export type SectionLabel = string;
export type SignedUrl = string | null;
export type StartBar = number;
export type StartSec = number;
export type Stem = string;
export type WaveformPeaks = number[] | null;
export type Loops = Loop[];
export type MusicalKey1 = string | null;
export type Status = string;
export type UpdatedAt = string;
export type YoutubeUrl = string;
export type LoopLengthBars = number;
export type RequestedStems = string[];
export type YoutubeUrl1 = string;

export interface StemLoopsContract {
  ErrorEnvelope: ErrorEnvelope;
  Job: Job;
  JobEvent: JobEvent;
  JobRequest: JobRequest;
  JobResponse: JobResponse;
  Loop: Loop;
}
/**
 * Canonical error response — rendered from static code→copy map, never interpolated.
 */
export interface ErrorEnvelope {
  error_code: ErrorCode;
  message: Message;
}
/**
 * Full job state — returned by GET /api/jobs/:id.
 */
export interface Job {
  bpm?: Bpm;
  created_at: CreatedAt;
  error_code?: ErrorCode1;
  error_message_user?: ErrorMessageUser;
  events?: Events;
  expires_at: ExpiresAt;
  id: Id1;
  loops?: Loops;
  musical_key?: MusicalKey1;
  status: Status;
  updated_at: UpdatedAt;
  youtube_url: YoutubeUrl;
}
/**
 * A single stage transition in the job trace.
 */
export interface JobEvent {
  created_at: CreatedAt1;
  duration_ms?: DurationMs;
  id: Id;
  job_id: JobId;
  pct?: Pct;
  phase: Phase;
  stage: Stage;
}
/**
 * A single extracted loop — one stem, one section, bar-aligned.
 */
export interface Loop {
  bar_count: BarCount;
  bpm?: Bpm1;
  created_at: CreatedAt2;
  duration_ms?: DurationMs1;
  end_sec: EndSec;
  energy_class: EnergyClass;
  filename: Filename;
  id: Id2;
  job_id: JobId1;
  musical_key?: MusicalKey;
  r2_key: R2Key;
  section_label: SectionLabel;
  signed_url?: SignedUrl;
  start_bar: StartBar;
  start_sec: StartSec;
  stem: Stem;
  waveform_peaks?: WaveformPeaks;
}
/**
 * POST /api/jobs request body.
 */
export interface JobRequest {
  loop_length_bars: LoopLengthBars;
  requested_stems: RequestedStems;
  youtube_url: YoutubeUrl1;
}
/**
 * POST /api/jobs response — returns job id for redirect.
 */
export interface JobResponse {
  job: Job;
}
