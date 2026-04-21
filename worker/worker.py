#!/usr/bin/env python3
"""
Stemloop queue consumer.

Pulls jobs from Redis (BullMQ-compatible), runs the pipeline, uploads results
to S3/R2, and posts status updates back to the Next.js API.

Env vars required:
  REDIS_URL            redis://default:pass@host:port
  S3_ENDPOINT          https://<account>.r2.cloudflarestorage.com
  S3_BUCKET            stemloop-loops
  S3_ACCESS_KEY_ID     ...
  S3_SECRET_ACCESS_KEY ...
  API_BASE_URL         https://stem-loops.com (for status callbacks)
  WORKER_SECRET        shared secret for callback auth
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import boto3
import redis
import requests

from pipeline import JobOutput, LoopResult, run_job


# --------------------------------------------------------------------------- #
# Config                                                                       #
# --------------------------------------------------------------------------- #

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
QUEUE_NAME = os.environ.get("QUEUE_NAME", "stemloop:jobs")

S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "")
S3_BUCKET = os.environ.get("S3_BUCKET", "stemloop-loops")
S3_ACCESS_KEY_ID = os.environ.get("S3_ACCESS_KEY_ID", "")
S3_SECRET_ACCESS_KEY = os.environ.get("S3_SECRET_ACCESS_KEY", "")

API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:3000")
WORKER_SECRET = os.environ.get("WORKER_SECRET", "dev-secret")

# 24-hour signed URL expiry — matches the stated download lifetime
SIGNED_URL_EXPIRY = 24 * 60 * 60


# --------------------------------------------------------------------------- #
# Clients                                                                      #
# --------------------------------------------------------------------------- #

def make_redis() -> redis.Redis:
    return redis.from_url(REDIS_URL, decode_responses=True)


def make_s3():
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY_ID,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY,
        region_name="auto",
    )


# --------------------------------------------------------------------------- #
# Status callbacks                                                             #
# --------------------------------------------------------------------------- #

def post_status(job_id: str, patch: dict) -> None:
    """Notify the Next.js API of a status change so the frontend can poll it."""
    try:
        requests.post(
            f"{API_BASE_URL}/api/worker/jobs/{job_id}",
            json=patch,
            headers={"x-worker-secret": WORKER_SECRET},
            timeout=10,
        )
    except Exception as exc:
        print(f"[worker] status post failed for {job_id}: {exc}", file=sys.stderr)


# --------------------------------------------------------------------------- #
# Upload                                                                       #
# --------------------------------------------------------------------------- #

def upload_loop(s3, job_id: str, loop: LoopResult) -> str:
    key = f"jobs/{job_id}/{loop.filename}"
    with open(loop.local_path, "rb") as fh:
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=fh.read(),
            ContentType="audio/wav",
        )
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": key},
        ExpiresIn=SIGNED_URL_EXPIRY,
    )
    return url


# --------------------------------------------------------------------------- #
# Job processor                                                                #
# --------------------------------------------------------------------------- #

def process_job(s3, job_id: str, payload: dict) -> None:
    url = payload["url"]
    stems = payload["stems"]
    bars = int(payload["bars"])

    def progress(stage: str, pct: int, msg: str) -> None:
        post_status(job_id, {"status": stage, "progress": pct, "stage": msg})

    try:
        output: JobOutput = run_job(url, stems, num_bars=bars, progress=progress)

        # Upload + collect signed URLs
        stem_results: dict[str, list[dict]] = {}
        for loop in output.loops:
            signed_url = upload_loop(s3, job_id, loop)
            stem_results.setdefault(loop.stem, []).append(
                {
                    "index": loop.index,
                    "filename": loop.filename,
                    "downloadUrl": signed_url,
                    "durationSec": loop.duration_sec,
                    "bpm": loop.bpm,
                    "energyLabel": loop.energy_label,
                    "startSec": loop.start_sec,
                    "endSec": loop.end_sec,
                }
            )

        post_status(
            job_id,
            {
                "status": "done",
                "progress": 100,
                "stage": "Complete",
                "title": output.title,
                "bpm": output.bpm,
                "results": [
                    {"stem": k, "loops": v} for k, v in stem_results.items()
                ],
                "expiresAt": (
                    datetime.now(timezone.utc) + timedelta(seconds=SIGNED_URL_EXPIRY)
                ).isoformat(),
            },
        )
    except Exception as exc:
        print(f"[worker] job {job_id} failed: {exc}", file=sys.stderr)
        post_status(
            job_id,
            {"status": "error", "stage": "Failed", "error": str(exc)},
        )


# --------------------------------------------------------------------------- #
# Main loop                                                                    #
# --------------------------------------------------------------------------- #

_running = True


def _shutdown(_signum, _frame):  # type: ignore[no-untyped-def]
    global _running
    print("[worker] shutdown requested")
    _running = False


def main() -> int:
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    r = make_redis()
    s3 = make_s3()

    print(f"[worker] listening on {QUEUE_NAME} @ {REDIS_URL}")

    while _running:
        raw: Optional[tuple[str, str]] = r.blpop([QUEUE_NAME], timeout=5)  # type: ignore[assignment]
        if raw is None:
            continue
        _, message = raw
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            print(f"[worker] bad message: {message[:200]}", file=sys.stderr)
            continue

        job_id = payload.get("id")
        if not job_id:
            print("[worker] message missing id", file=sys.stderr)
            continue

        print(f"[worker] processing job {job_id}")
        start = time.time()
        process_job(s3, job_id, payload)
        print(f"[worker] finished {job_id} in {time.time() - start:.1f}s")

    return 0


if __name__ == "__main__":
    sys.exit(main())
