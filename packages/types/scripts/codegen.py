#!/usr/bin/env python3
"""
Pydantic → JSON Schema → TypeScript codegen.

Reads models from apps/worker/src/models.py and generates TypeScript types
in packages/types/src/generated.ts.

Usage:
    cd packages/types && python scripts/codegen.py
    # or
    make types-generate
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

# Resolve paths relative to this script
SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent.parent
WORKER_SRC = REPO_ROOT / "apps" / "worker" / "src"
OUTPUT_FILE = SCRIPT_DIR.parent / "src" / "generated.ts"
OUTPUT_DIR = OUTPUT_FILE.parent


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Add worker src to path so we can import models
    sys.path.insert(0, str(REPO_ROOT / "apps" / "worker"))

    from src.models import (  # type: ignore
        CreateJobRequest,
        ErrorCode,
        Job,
        JobEvent,
        JobResponse,
        JobStatus,
        Loop,
        StemName,
        EventStage,
        EventType,
    )

    models = {
        "JobStatus": JobStatus,
        "StemName": StemName,
        "EventStage": EventStage,
        "EventType": EventType,
        "ErrorCode": ErrorCode,
        "CreateJobRequest": CreateJobRequest,
        "Loop": Loop,
        "JobEvent": JobEvent,
        "Job": Job,
        "JobResponse": JobResponse,
    }

    # Generate JSON Schema for each model
    schemas: dict[str, dict] = {}
    for name, model in models.items():
        if hasattr(model, "model_json_schema"):
            schemas[name] = model.model_json_schema()
        else:
            # Enum
            import pydantic
            class _Wrapper(pydantic.BaseModel):
                value: model  # type: ignore
            schema = _Wrapper.model_json_schema()
            schemas[name] = schema

    # Write combined schema
    combined_schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": {name: schema for name, schema in schemas.items()},
    }

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(combined_schema, f, indent=2)
        schema_file = f.name

    print(f"Generated JSON schema at {schema_file}")

    # Try to use json-schema-to-typescript if available
    node_modules = SCRIPT_DIR.parent / "node_modules" / ".bin" / "json2ts"
    if node_modules.exists():
        result = subprocess.run(
            [str(node_modules), "--input", schema_file, "--output", str(OUTPUT_FILE)],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            print(f"TypeScript types written to {OUTPUT_FILE}")
            return
        else:
            print(f"json2ts failed: {result.stderr}", file=sys.stderr)

    # Fallback: write manual TypeScript definitions
    print("Falling back to manual TypeScript generation...")
    ts = _generate_ts_manually(schemas)
    OUTPUT_FILE.write_text(ts)
    print(f"TypeScript types written to {OUTPUT_FILE}")


def _generate_ts_manually(schemas: dict[str, dict]) -> str:
    """Generate TypeScript types manually as a fallback."""
    lines = [
        "// AUTO-GENERATED — DO NOT EDIT",
        "// Source of truth: apps/worker/src/models.py",
        "// Regenerate with: make types-generate",
        "",
    ]

    status_values = ["queued", "downloading", "separating", "extracting", "uploading", "done", "failed"]
    lines += [
        "export type JobStatus =",
        "  | " + "\n  | ".join(f'"{v}"' for v in status_values) + ";",
        "",
    ]

    stem_values = ["vocals", "drums", "bass", "other"]
    lines += [
        "export type StemName =",
        "  | " + "\n  | ".join(f'"{v}"' for v in stem_values) + ";",
        "",
    ]

    stage_values = ["downloading", "separating", "extracting", "uploading"]
    lines += [
        "export type EventStage =",
        "  | " + "\n  | ".join(f'"{v}"' for v in stage_values) + ";",
        "",
    ]

    event_type_values = ["started", "completed", "failed"]
    lines += [
        "export type EventType =",
        "  | " + "\n  | ".join(f'"{v}"' for v in event_type_values) + ";",
        "",
    ]

    error_codes = [
        "DOWNLOAD_BLOCKED", "DOWNLOAD_TIMEOUT", "DOWNLOAD_INVALID_URL",
        "DOWNLOAD_AGE_RESTRICTED", "DOWNLOAD_PRIVATE", "SEPARATION_FAILED",
        "EXTRACTION_FAILED", "UPLOAD_FAILED", "INTERNAL_ERROR", "RATE_LIMITED",
    ]
    lines += [
        "export type ErrorCode =",
        "  | " + "\n  | ".join(f'"{v}"' for v in error_codes) + ";",
        "",
    ]

    lines += [
        "export interface Loop {",
        "  id: string;",
        "  job_id: string;",
        "  stem: StemName;",
        "  bar_count: number;",
        "  loop_length_bars: number;",
        "  r2_key: string;",
        "  r2_url: string;",
        "  duration_seconds?: number | null;",
        "  bpm?: number | null;",
        "  created_at: string;",
        "}",
        "",
    ]

    lines += [
        "export interface JobEvent {",
        "  id: string;",
        "  job_id: string;",
        "  stage: EventStage;",
        "  event_type: EventType;",
        "  detail?: string | null;",
        "  created_at: string;",
        "}",
        "",
    ]

    lines += [
        "export interface Job {",
        "  id: string;",
        "  source_url: string;",
        "  stems: StemName[];",
        "  loop_length_bars: number;",
        "  status: JobStatus;",
        "  error_code?: ErrorCode | null;",
        "  error_detail?: string | null;",
        "  client_ip_hash?: string | null;",
        "  created_at: string;",
        "  updated_at: string;",
        "  expires_at?: string | null;",
        "  loops?: Loop[] | null;",
        "  events?: JobEvent[] | null;",
        "}",
        "",
    ]

    lines += [
        "export interface JobResponse extends Job {}",
        "",
        "export interface CreateJobRequest {",
        "  source_url: string;",
        "  stems?: StemName[];",
        "  loop_length_bars?: number;",
        "  client_ip_hash?: string | null;",
        "}",
        "",
    ]

    return "\n".join(lines)


if __name__ == "__main__":
    main()
