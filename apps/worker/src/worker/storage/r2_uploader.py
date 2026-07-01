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
