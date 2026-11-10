"""R2 upload with a deterministic key (T17) — overwrite-safe for idempotent retries.

Endpoint resolves R2_ENDPOINT_URL, else MINIO_ENDPOINT (local dev), else builds the
Cloudflare R2 endpoint from R2_ACCOUNT_ID. The key is fully determined by its inputs,
so a retried job overwrites in place rather than creating duplicates.
"""

import os
from functools import lru_cache

import boto3
from botocore.config import Config

from ..logger import log_structured


def _endpoint() -> str:
    if os.environ.get("R2_ENDPOINT_URL"):
        return os.environ["R2_ENDPOINT_URL"]
    if os.environ.get("MINIO_ENDPOINT"):
        return os.environ["MINIO_ENDPOINT"]
    return f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"


@lru_cache(maxsize=1)
def _r2():
    # Cached, thread-safe client — reused across all uploads in a job (boto3
    # clients are safe to share across threads for independent operations).
    return boto3.client(
        "s3",
        endpoint_url=_endpoint(),
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        # Path-style addressing — required by MinIO (local dev) and supported by R2.
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def upload_loop(job_id: str, stem: str, section: str, idx: int, local_path: str) -> str:
    """Upload a loop WAV and return its deterministic r2_key."""
    r2_key = f"{job_id}/{stem}/{section}_{idx:04d}.wav"
    _r2().upload_file(
        local_path,
        os.environ["R2_BUCKET_NAME"],
        r2_key,
        ExtraArgs={"ContentType": "audio/wav"},
    )
    log_structured("INFO", "loop_uploaded", r2_key=r2_key)
    return r2_key


# V3-J2: the stem key prefix. Deliberately UNDER the `{job_id}/` prefix, because
# cleanup.py's per-job retention delete is `delete_prefix(f"{job_id}/")` and
# `_job_id_of()` reads the FIRST path segment. `upload_play_chords` writes
# `jobs/<id>/...` instead, so its first segment is the literal "jobs" and the
# per-job delete MISSES it entirely — chord artifacts survive until the budget-
# limited orphan sweep happens to catch them. Do not copy that layout here.
# The leading underscore matches `_input.wav`: a non-loop artifact, so it can
# never collide with `{job_id}/{stem}/...` loop keys.
def stem_r2_key(job_id: str, stem: str) -> str:
    """Deterministic key for a retained full-length stem.

    Mirrored in apps/web/src/lib/r2.ts:stemR2Key — drift silently 404s the player,
    which is exactly how the chord overlay's key drift would have failed. A test
    pins both sides.
    """
    return f"{job_id}/_stems/{stem}.wav"


def upload_stem(job_id: str, stem: str, local_path: str) -> str:
    """Upload a full-length separated stem and return its deterministic r2_key.

    Why this exists (V3-J2): htdemucs_6s produces six full-length stems, we cut
    bar-length loops from them, and then THREW THE STEMS AWAY — `job_scope()`
    rmtree'd the scratch dir at job end and nothing had copied them anywhere. The
    play-along product needs per-stem volume faders, which is impossible without
    the full-length audio, so the stems are now retained for the normal 24h window
    alongside the loops they produced.
    """
    r2_key = stem_r2_key(job_id, stem)
    _r2().upload_file(
        local_path,
        os.environ["R2_BUCKET_NAME"],
        r2_key,
        ExtraArgs={"ContentType": "audio/wav"},
    )
    log_structured("INFO", "stem_uploaded", r2_key=r2_key, stem=stem)
    return r2_key


def presign_get(r2_key: str, expires: int = 3600) -> str:
    """Return a presigned GET URL for an object (used to hand input audio to Replicate)."""
    return _r2().generate_presigned_url(
        "get_object",
        Params={"Bucket": os.environ["R2_BUCKET_NAME"], "Key": r2_key},
        ExpiresIn=expires,
    )


def download_object(r2_key: str, local_path: str) -> str:
    """Download an R2 object to a local path (used to fetch an uploaded input file)."""
    _r2().download_file(os.environ["R2_BUCKET_NAME"], r2_key, local_path)
    log_structured("INFO", "object_downloaded", r2_key=r2_key)
    return local_path


def upload_play_chords(job_id: str, body: bytes) -> str:
    """Upload the Y1 ``play.chords.json`` artifact for a job and return its r2_key.

    Deterministic key ``jobs/<job_id>/play.chords.json`` so a retried job
    overwrites in place. Content-Type is ``application/json`` and Cache-Control
    is ``private, max-age=0`` — the artifact is user-scoped (served through a
    short-TTL signed URL) and the browser should re-fetch on every job view so
    a re-run picks up fresh chord data without a stale-cache hit.
    """
    r2_key = f"jobs/{job_id}/play.chords.json"
    _r2().put_object(
        Bucket=os.environ["R2_BUCKET_NAME"],
        Key=r2_key,
        Body=body,
        ContentType="application/json",
        CacheControl="private, max-age=0",
    )
    log_structured(
        "INFO",
        "play_chords_uploaded",
        job_id=job_id,
        r2_key=r2_key,
        bytes=len(body),
    )
    return r2_key


def upload_input(job_id: str, local_path: str) -> str:
    """Upload a source WAV (e.g. an operator-provided file) and return a presigned URL.

    Replicate fetches the audio by URL — it cannot read a local path — so a local
    file is staged to R2 and handed over as a short-lived presigned GET URL.
    """
    r2_key = f"{job_id}/_input.wav"
    _r2().upload_file(
        local_path,
        os.environ["R2_BUCKET_NAME"],
        r2_key,
        ExtraArgs={"ContentType": "audio/wav"},
    )
    url = presign_get(r2_key, expires=3600)
    log_structured("INFO", "input_uploaded", r2_key=r2_key)
    return url


def delete_prefix(prefix: str) -> int:
    """Delete every object under `prefix` (a job's whole R2 footprint). Returns the count.

    Single-object DeleteObject calls (not the batch DeleteObjects) — a job has at most a
    few dozen objects and the batch API's mandatory-checksum behaviour has differed
    between boto3 releases and S3-compatible stores. Raises on any failure so the caller
    keeps the DB row and retries on the next sweep.
    """
    bucket = os.environ["R2_BUCKET_NAME"]
    client = _r2()
    deleted = 0
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            client.delete_object(Bucket=bucket, Key=obj["Key"])
            deleted += 1
    return deleted


def list_objects_older_than(cutoff, limit: int = 2000) -> list[str]:
    """Keys of objects whose LastModified is before `cutoff` (tz-aware datetime), up to `limit`."""
    bucket = os.environ["R2_BUCKET_NAME"]
    keys: list[str] = []
    for page in _r2().get_paginator("list_objects_v2").paginate(Bucket=bucket):
        for obj in page.get("Contents", []):
            if obj["LastModified"] < cutoff:
                keys.append(obj["Key"])
                if len(keys) >= limit:
                    return keys
    return keys


def delete_objects(keys: list[str]) -> int:
    """Delete the given keys one by one. Returns the count deleted."""
    bucket = os.environ["R2_BUCKET_NAME"]
    client = _r2()
    for key in keys:
        client.delete_object(Bucket=bucket, Key=key)
    return len(keys)
