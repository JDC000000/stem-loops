"""
Canonical Pydantic models — single source of truth for the cross-language type contract.
These models are the INPUT to codegen (scripts/codegen.py → packages/types/src/).
DO NOT edit the generated TypeScript in packages/types/src/generated.ts directly.
Run `make codegen` after changing these models.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, field_validator

# --- Constants (mirrors DB CHECK constraints) ---
STEMS = frozenset({"drums", "bass", "vocals", "guitar", "keys", "other"})
STATUSES = frozenset({"queued", "downloading", "separating", "extracting", "uploading", "done", "failed"})
STAGES = frozenset({"downloading", "separating", "extracting", "uploading"})
PHASES = frozenset({"started", "completed", "failed"})
SECTION_LABELS = frozenset({"intro", "verse", "chorus", "bridge", "outro"})
ENERGY_CLASSES = frozenset({"low", "mid", "high"})
ERROR_CODES = frozenset({
    "DOWNLOAD_BLOCKED", "DOWNLOAD_TIMEOUT", "DOWNLOAD_INVALID_URL",
    "DOWNLOAD_AGE_RESTRICTED", "DOWNLOAD_PRIVATE", "SEPARATION_FAILED",
    "EXTRACTION_FAILED", "UPLOAD_FAILED", "INTERNAL_ERROR", "RATE_LIMITED",
})
LOOP_LENGTH_BARS = frozenset({1, 2, 4, 8})
YOUTUBE_RE = re.compile(r"^https://(www\.youtube\.com/watch\?v=|youtu\.be/)[\w-]{11}")


class JobRequest(BaseModel):
    """POST /api/jobs request body."""
    youtube_url: str
    requested_stems: list[str]
    loop_length_bars: int

    @field_validator("youtube_url")
    @classmethod
    def validate_youtube(cls, v: str) -> str:
        if not YOUTUBE_RE.match(v):
            raise ValueError("Not a valid YouTube URL")
        return v

    @field_validator("requested_stems")
    @classmethod
    def validate_stems(cls, v: list[str]) -> list[str]:
        invalid = set(v) - STEMS
        if invalid:
            raise ValueError(f"Invalid stems: {invalid}")
        if not v:
            raise ValueError("At least one stem required")
        return v

    @field_validator("loop_length_bars")
    @classmethod
    def validate_bars(cls, v: int) -> int:
        if v not in LOOP_LENGTH_BARS:
            raise ValueError("loop_length_bars must be 1, 2, 4, or 8")
        return v


class ErrorEnvelope(BaseModel):
    """Canonical error response — rendered from static code→copy map, never interpolated."""
    error_code: str
    message: str


class Loop(BaseModel):
    """A single extracted loop — one stem, one section, bar-aligned."""
    id: UUID
    job_id: UUID
    stem: str
    section_label: str
    energy_class: str
    start_sec: float
    end_sec: float
    start_bar: int
    bar_count: int
    bpm: Optional[float] = None
    musical_key: Optional[str] = None
    r2_key: str
    filename: str  # canonical: {title}_{stem}_{bpm}bpm_{key}_{section}_{idx}.wav
    duration_ms: Optional[int] = None
    waveform_peaks: Optional[list[float]] = None
    signed_url: Optional[str] = None  # freshly minted on every GET /api/jobs/:id read
    created_at: datetime


class JobEvent(BaseModel):
    """A single stage transition in the job trace."""
    id: int
    job_id: UUID
    stage: str
    phase: str
    pct: Optional[int] = None
    duration_ms: Optional[int] = None
    created_at: datetime


class Job(BaseModel):
    """Full job state — returned by GET /api/jobs/:id."""
    id: UUID
    youtube_url: str
    status: str
    error_code: Optional[str] = None
    error_message_user: Optional[str] = None
    bpm: Optional[float] = None
    musical_key: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    expires_at: datetime
    events: list[JobEvent] = []
    loops: list[Loop] = []


class JobResponse(BaseModel):
    """POST /api/jobs response — returns job id for redirect."""
    job: Job
