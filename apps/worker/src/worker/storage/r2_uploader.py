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


# Loop keys.
#
# ⚠️ DATA-LOSS BUG THIS FIXES. Until 2026-11-11 the key was
#     f"{job_id}/{stem}/{section}_{idx:04d}.wav"
# with NO BAR COUNT in it. `loops` has UNIQUE (job_id, r2_key) and the insert is
# ON CONFLICT DO NOTHING, so the moment anything cut a SECOND bar length for one
# job, the 4-bar and the 8-bar loop of the same stem/section/index produced the
# SAME key: the R2 object was silently overwritten and the row silently dropped.
# Nothing hit it while every job was cut at exactly one bar length. On-demand
# cutting makes the key an upsert target (see pipeline.record_loops), so the key
# must now name everything that distinguishes the bytes it points at.
#
# The bar count goes in the FILENAME segment, not as a new path level, and that
# is deliberate:
#   * Segment 1 stays the job id. cleanup.py's per-job delete is
#     `delete_prefix(f"{job_id}/")` and its `_job_id_of()` reads the FIRST path
#     segment, so retention still sweeps these.
#   * Segment 2 stays the stem, so the key shape is unchanged for anything that
#     reads it positionally.
#   * It cannot be mistaken for a stem artifact: `stem_name_from_*` /
#     `stemNameFrom` require the full `/_stems/play/` or `/_stems/dl/` marker
#     and reject a remainder containing `/`.
#
# EXISTING PRODUCTION ROWS ARE NOT TOUCHED AND MUST NOT BE. A row's `r2_key` is
# stored, and both the worker and `GET /api/jobs/:id` sign the STORED value --
# neither reconstructs a key from parts at read time. So a pre-033 row keeps its
# old key, its object still sits at that old key, and the signed URL still
# resolves. Rewriting old rows to the new scheme is what WOULD orphan their
# objects, which is why this is a write-path change only.
def loop_r2_key(job_id: str, stem: str, bars: int, section: str, idx: int) -> str:
    """The deterministic key for one loop. Pure: no network, no R2 client.

    Split out from `upload_loop` because the eager pass now records a loop row
    BEFORE any byte exists, and needs to name where the object will live.
    """
    return f"{job_id}/{stem}/{bars}bar_{section}_{idx:04d}.wav"


def upload_loop_to_key(r2_key: str, local_path: str) -> str:
    """Upload a loop WAV to a key that already exists in a `loops` row.

    The on-demand cutter's path: the row was written first (with its key) and the
    bytes arrive later, so the key is read from the row rather than rebuilt. That
    also makes a retried request an overwrite-in-place instead of a duplicate.
    """
    _r2().upload_file(
        local_path,
        os.environ["R2_BUCKET_NAME"],
        r2_key,
        ExtraArgs={"ContentType": "audio/wav"},
    )
    log_structured("INFO", "loop_uploaded", r2_key=r2_key)
    return r2_key


def upload_loop(job_id: str, stem: str, bars: int, section: str, idx: int, local_path: str) -> str:
    """Upload a loop WAV and return its deterministic r2_key."""
    return upload_loop_to_key(loop_r2_key(job_id, stem, bars, section, idx), local_path)


# V3-J2 stem keys. Two artifacts per stem, in SEPARATE sub-prefixes:
#
#   <job_id>/_stems/play/<stem>.opus   playback  (TSD 12.2: Opus, 4-5 MB)
#   <job_id>/_stems/dl/<stem>.wav      download  (TSD 12.2 + Jon: .wav)
#
# Separate sub-prefixes rather than two extensions in one directory, because the
# reader lists the prefix and parses the stem name out of the key: with both
# artifacts side by side, `vocals.opus` and `vocals.wav` would parse to the same
# name and surface as a duplicate or an arbitrary winner.
#
# Both sit UNDER `<job_id>/`, and that is a correctness property, not a style
# choice: it is the prefix the bulk of the retention sweep is built around. The
# chord artifact does NOT (`upload_play_chords` writes `jobs/<id>/...`), and for
# months that meant the per-job retention delete — `delete_prefix(f"{job_id}/")`
# alone — MISSED it on every single job, leaving it to the budget-capped orphan
# sweep. `job_object_prefixes()` below is now the single list of prefixes the
# sweep walks, so the leak is closed; a NEW top-level prefix must be added there
# or it will leak the same way. Keeping stems under `<job_id>/` is still the
# right default, and they are far larger.
STEM_PLAY_EXT = "opus"
STEM_DOWNLOAD_EXT = "wav"


def stem_play_r2_key(job_id: str, stem: str) -> str:
    """Key for the Opus playback artifact. Mirrored in apps/web/src/lib/stem-keys.ts."""
    return f"{job_id}/_stems/play/{stem}.{STEM_PLAY_EXT}"


def stem_download_r2_key(job_id: str, stem: str) -> str:
    """Key for the WAV download artifact. Mirrored in apps/web/src/lib/stem-keys.ts."""
    return f"{job_id}/_stems/dl/{stem}.{STEM_DOWNLOAD_EXT}"


def upload_stem(job_id: str, stem: str, local_path: str, kind: str) -> str:
    """Upload one stem artifact and return its deterministic r2_key.

    ``kind`` is "play" (Opus, streamed by the mixer) or "download" (WAV, handed to
    a DAW). Keys are deterministic, so a reaper requeue overwrites in place rather
    than accumulating duplicates.
    """
    if kind == "play":
        r2_key = stem_play_r2_key(job_id, stem)
        content_type = "audio/ogg"
    elif kind == "download":
        r2_key = stem_download_r2_key(job_id, stem)
        content_type = "audio/wav"
    else:
        raise ValueError(f"unknown stem artifact kind: {kind!r}")
    _r2().upload_file(
        local_path,
        os.environ["R2_BUCKET_NAME"],
        r2_key,
        ExtraArgs={"ContentType": content_type},
    )
    log_structured("INFO", "stem_uploaded", r2_key=r2_key, stem=stem, kind=kind)
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


# The ONE named top-level prefix in the bucket. Everything the pipeline writes is
# `<job_id>/...` EXCEPT the Y1 chord artifact, which lives under this prefix.
CHORDS_TOP_PREFIX = "jobs/"


def play_chords_r2_key(job_id: str) -> str:
    """Key for the Y1 chord artifact. Mirrored in apps/web/src/lib/r2.ts:playChordsR2Key."""
    return f"{CHORDS_TOP_PREFIX}{job_id}/play.chords.json"


def job_object_prefixes(job_id: str) -> tuple[str, ...]:
    """EVERY R2 prefix one job's objects can live under.

    cleanup.py's per-job retention delete walks this list, so this is the single
    place that decides what "a job's R2 footprint" means. It deliberately returns
    PREFIXES and not keys: the sweep must delete whatever is actually there, not
    only the objects it can name.

    The second entry is why this function exists. The sweep deleted `{job_id}/`
    and nothing else, so `jobs/<job_id>/play.chords.json` escaped the per-job
    delete on every job and survived until `_sweep_orphaned_objects` — bucket-wide,
    age-based, best-effort and capped at MAX_ORPHANS_PER_SWEEP — happened to reach it.
    """
    return (f"{job_id}/", f"{CHORDS_TOP_PREFIX}{job_id}/")


def upload_play_chords(job_id: str, body: bytes) -> str:
    """Upload the Y1 ``play.chords.json`` artifact for a job and return its r2_key.

    Deterministic key ``jobs/<job_id>/play.chords.json`` (``play_chords_r2_key``)
    so a retried job overwrites in place. The ``jobs/`` top-level prefix is the
    one exception to the ``<job_id>/...`` layout, which is why it must appear in
    ``job_object_prefixes`` for the retention sweep to reach it.
    Content-Type is ``application/json`` and Cache-Control
    is ``private, max-age=0`` — the artifact is user-scoped (served through a
    short-TTL signed URL) and the browser should re-fetch on every job view so
    a re-run picks up fresh chord data without a stale-cache hit.
    """
    r2_key = play_chords_r2_key(job_id)
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
