#!/usr/bin/env python3
"""
Stem-Loops queue consumer.

Polls the Upstash Redis queue (`stem-loops:jobs`) over REST, processes each
job end-to-end (download → separate → extract → upload), and writes status
updates directly into the `job:<id>` key so the web frontend's polling sees
them.

Env vars required:
  UPSTASH_REDIS_REST_URL     https://<id>.upstash.io
  UPSTASH_REDIS_REST_TOKEN   full-access REST token
  S3_ENDPOINT                https://<account>.r2.cloudflarestorage.com
  S3_BUCKET                  stem-loops-audio
  S3_ACCESS_KEY_ID           R2 access key
  S3_SECRET_ACCESS_KEY       R2 secret

Optional:
  QUEUE_NAME                 defaults to "stem-loops:jobs"
  POLL_INTERVAL_SEC          defaults to 3 (wait when queue is empty)
  SIGNED_URL_EXPIRY_SEC      defaults to 86400 (24 hours)

No callback URL — worker writes Job state directly to Redis. The web layer
polls the same key and surfaces progress to the user.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import boto3
import requests

from pipeline import JobOutput, LoopResult, run_job


# --------------------------------------------------------------------------- #
# Config                                                                       #
# --------------------------------------------------------------------------- #

def _require(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        print(f"[worker] FATAL: missing env var {key}", file=sys.stderr)
        sys.exit(1)
    return v


REDIS_URL = _require("UPSTASH_REDIS_REST_URL").rstrip("/")
REDIS_TOKEN = _require("UPSTASH_REDIS_REST_TOKEN")

S3_ENDPOINT = _require("S3_ENDPOINT")
S3_BUCKET = _require("S3_BUCKET")
S3_ACCESS_KEY_ID = _require("S3_ACCESS_KEY_ID")
S3_SECRET_ACCESS_KEY = _require("S3_SECRET_ACCESS_KEY")

QUEUE_NAME = os.environ.get("QUEUE_NAME", "stem-loops:jobs")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL_SEC", "3"))
SIGNED_URL_EXPIRY = int(os.environ.get("SIGNED_URL_EXPIRY_SEC", str(24 * 60 * 60)))

# Must match web layer in src/lib/redis.ts:TTL.job
JOB_TTL = 60 * 60 * 48  # 48 hours


# --------------------------------------------------------------------------- #
# Upstash Redis (REST API)                                                     #
#                                                                              #
# Upstash accepts commands as JSON arrays: ["CMD", "arg1", "arg2", ...]        #
# Returns {"result": <value>} or {"error": "..."}.                             #
# --------------------------------------------------------------------------- #

_session = requests.Session()
_session.headers.update({
    "Authorization": f"Bearer {REDIS_TOKEN}",
    "Content-Type": "application/json",
})


def redis_cmd(*args: str) -> Any:
    r = _session.post(REDIS_URL, data=json.dumps(list(args)), timeout=15)
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise RuntimeError(f"Upstash error: {body['error']}")
    return body.get("result")


def queue_pop() -> Optional[dict]:
    """LPOP one message off the queue. None if empty."""
    raw = redis_cmd("LPOP", QUEUE_NAME)
    if raw is None:
        return None
    return json.loads(raw)


def job_get(job_id: str) -> Optional[dict]:
    raw = redis_cmd("GET", f"job:{job_id}")
    if raw is None:
        return None
    return json.loads(raw) if isinstance(raw, str) else raw


def job_update(job_id: str, patch: dict) -> None:
    """Merge patch into the stored Job and write back with TTL."""
    current = job_get(job_id)
    if current is None:
        # Shouldn't happen — web creates the job before LPUSHing. But if
        # somehow the job key expired, just write what we have.
        current = {"id": job_id}
    current.update(patch)
    redis_cmd("SET", f"job:{job_id}", json.dumps(current), "EX", str(JOB_TTL))


# --------------------------------------------------------------------------- #
# S3 / R2 client                                                               #
# --------------------------------------------------------------------------- #

def make_s3():
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY_ID,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY,
        region_name="auto",
    )


def upload_loop(s3, job_id: str, loop: LoopResult) -> str:
    """Upload one WAV → R2, return a 24-hour signed GET URL."""
    key = f"jobs/{job_id}/{loop.filename}"
    with open(loop.local_path, "rb") as fh:
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=fh.read(),
            ContentType="audio/wav",
        )
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": key},
        ExpiresIn=SIGNED_URL_EXPIRY,
    )


# --------------------------------------------------------------------------- #
# Per-job processing                                                           #
# --------------------------------------------------------------------------- #

def process_job(s3, payload: dict) -> None:
    job_id = payload["id"]
    url = payload["url"]
    stems = payload["stems"]
    bars = int(payload["bars"])

    def progress(stage: str, pct: int, msg: str) -> None:
        job_update(job_id, {"status": stage, "progress": pct, "stage": msg})

    try:
        output: JobOutput = run_job(url, stems, num_bars=bars, progress=progress)

        # Upload sequentially — plenty fast at soft-launch volume.
        stem_results: dict[str, list[dict]] = {}
        for loop in output.loops:
            signed_url = upload_loop(s3, job_id, loop)
            stem_results.setdefault(loop.stem, []).append({
                "index": loop.index,
                "filename": loop.filename,
                "downloadUrl": signed_url,
                "durationSec": loop.duration_sec,
                "bpm": loop.bpm,
                "energyLabel": loop.energy_label,
                "startSec": loop.start_sec,
                "endSec": loop.end_sec,
            })

        job_update(job_id, {
            "status": "done",
            "progress": 100,
            "stage": "Complete",
            "title": output.title,
            "bpm": output.bpm,
            "results": [
                {"stem": k, "loops": v} for k, v in stem_results.items()
            ],
            "expiresAt": (
                datetime.now(timezone.utc)
                + timedelta(seconds=SIGNED_URL_EXPIRY)
            ).isoformat(),
        })

    except Exception as exc:
        print(f"[worker] job {job_id} failed: {exc}", file=sys.stderr)
        traceback.print_exc()
        job_update(job_id, {
            "status": "error",
            "stage": "Failed",
            "error": str(exc),
        })


# --------------------------------------------------------------------------- #
# Main loop                                                                    #
# --------------------------------------------------------------------------- #

_running = True


def _shutdown(_signum, _frame):  # type: ignore[no-untyped-def]
    global _running
    print("[worker] shutdown signal received — finishing current job")
    _running = False


def main() -> int:
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    s3 = make_s3()
    print(f"[worker] ready — polling {QUEUE_NAME} every {POLL_INTERVAL}s")

    while _running:
        try:
            payload = queue_pop()
        except Exception as exc:
            print(f"[worker] queue poll failed: {exc}", file=sys.stderr)
            time.sleep(POLL_INTERVAL)
            continue

        if payload is None:
            time.sleep(POLL_INTERVAL)
            continue

        job_id = payload.get("id", "<unknown>")
        print(f"[worker] processing job {job_id}")
        t0 = time.time()
        process_job(s3, payload)
        print(f"[worker] finished {job_id} in {time.time() - t0:.1f}s")

    return 0


if __name__ == "__main__":
    sys.exit(main())
