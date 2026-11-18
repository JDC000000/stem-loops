"""Daily check that retained songs still have their files in R2 (QA-57 / QA-59).

WHY. Every R2 object older than ~24 h was deleted while the database still retained the
jobs (demo songs to 2099, paid libraries to 2027), and nothing reported it for days: a
missing object throws no error. The stems route answers "no play-along audio was kept",
the chord GET 404s, and both are legitimate answers for some other job. This is the
check that asks the question directly.

WHAT. Once a run (startup, then daily, from the consumer loop on a daemon thread):
sample up to SAMPLE_LIMIT retained, done, non-purged jobs created after stem retention
shipped (demos first, then a random sample of the rest), and for each
  * list `<id>/_stems/play/` with MaxKeys=1 (playback stems: every such job has them), and
  * HEAD `jobs/<id>/play.chords.json`, but ONLY for a job that records a real Klangio job
    id. Without one, no chord file is the normal case (chords off, too long, no attempt).
Each missing artifact is a WARN log carrying the full job id (Fly logs already carry job
ids everywhere) and one Sentry warning under a fixed fingerprint per kind. A run that
finds anything missing also logs one ERROR summary.

JOB IDS IN SENTRY. The worker's Sentry scrubber masks every UUID in messages because a job
id is a bearer capability (sentry_config.py, security review 2026-10-03), and it does not
scrub tags, so a full-id tag would ship that capability. The event carries `job_ref`, the
id's first 8 hex digits: enough to find the row (`WHERE id::text LIKE '<ref>%'`) or the
WARN log line with the full id, not enough to read the job.

BOUNDED. At most SAMPLE_LIMIT jobs: one DB query, at most 2 * SAMPLE_LIMIT R2 calls
(Class A list + Class B HEAD), at most 2 * SAMPLE_LIMIT Sentry events, per day.
Never raises: any failure is a WARN and the run ends.
"""

from __future__ import annotations

import contextlib
import os
import threading
from typing import Any

import psycopg
import sentry_sdk

from .cleanup import PURGED_MARKER, RETAINED_UNTIL_SQL
from .logger import log_structured

SAMPLE_LIMIT = 50
# V3-J2 (stem retention, PR #174) merged 2026-11-10T19:13Z; next UTC midnight covers the
# deploy. A done job created before this legitimately has no playback stems.
STEMS_RETAINED_SINCE = "2026-11-11T00:00:00Z"
# Jobs younger than this may still be inside the pipeline's last upload; skip them.
MIN_AGE = "1 hour"
KLANGIO_SENTINEL = "submitting"

SAMPLE_SQL = (
    "SELECT id::text, is_demo, klangio_job_id FROM jobs "
    "WHERE status = 'done' "
    "  AND client_ip_hash <> %s "
    f"  AND created_at >= '{STEMS_RETAINED_SINCE}'::timestamptz "
    f"  AND created_at < now() - interval '{MIN_AGE}' "
    f"  AND {RETAINED_UNTIL_SQL} > now() "
    "ORDER BY is_demo DESC, random() LIMIT %s"
)


def _job_ref(job_id: str) -> str:
    return job_id.replace("-", "")[:8].lower()


def _error_code(exc: BaseException) -> str:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        return str((response.get("Error") or {}).get("Code") or "")
    return ""


def _play_stems_present(client: Any, bucket: str, job_id: str) -> bool:
    res = client.list_objects_v2(Bucket=bucket, Prefix=f"{job_id}/_stems/play/", MaxKeys=1)
    return bool(res.get("KeyCount") or res.get("Contents"))


def _chords_present(client: Any, bucket: str, job_id: str) -> bool:
    from .storage.r2_uploader import play_chords_r2_key

    try:
        client.head_object(Bucket=bucket, Key=play_chords_r2_key(job_id))
        return True
    except Exception as exc:  # noqa: BLE001
        if _error_code(exc) in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def _report(kind: str, job_id: str, is_demo: bool) -> None:
    log_structured("WARN", "retained_song_file_missing", kind=kind, job_id=job_id, is_demo=is_demo)
    # Telemetry is never load-bearing: a Sentry fault must not end the audit.
    with contextlib.suppress(Exception), sentry_sdk.new_scope() as scope:
        scope.set_tag("kind", kind)
        scope.set_tag("job_ref", _job_ref(job_id))
        scope.set_tag("is_demo", str(bool(is_demo)).lower())
        scope.fingerprint = ["missing-artifact", kind]
        sentry_sdk.capture_message(f"retained song file missing ({kind})", level="warning")


def sample_retained_jobs(database_url: str, limit: int = SAMPLE_LIMIT) -> list[tuple]:
    with psycopg.connect(database_url) as conn:
        return conn.execute(SAMPLE_SQL, (PURGED_MARKER, limit)).fetchall()


def audit_retained_artifacts(
    rows: list[tuple] | None = None,
    client: Any = None,
    bucket: str | None = None,
    database_url: str | None = None,
) -> dict[str, int]:
    """Check a sample of retained jobs for their play stems and chord file. Never raises.

    Returns {'checked', 'stems_missing', 'chords_missing', 'errors'}.
    """
    out = {"checked": 0, "stems_missing": 0, "chords_missing": 0, "errors": 0}
    try:
        if rows is None:
            rows = sample_retained_jobs(database_url or os.environ.get("DATABASE_URL", ""))
        if bucket is None:
            bucket = os.environ["R2_BUCKET_NAME"]
        if client is None:
            from .storage.r2_uploader import _r2

            client = _r2()
    except Exception as exc:  # noqa: BLE001 — an audit must never take the worker down
        log_structured("WARN", "artifact_audit_failed", stage="setup", error=str(exc)[:200])
        return out

    for job_id, is_demo, klangio in rows[:SAMPLE_LIMIT]:
        try:
            out["checked"] += 1
            if not _play_stems_present(client, bucket, job_id):
                out["stems_missing"] += 1
                _report("stems_missing", job_id, is_demo)
            expects_chords = isinstance(klangio, str) and klangio not in ("", KLANGIO_SENTINEL)
            if expects_chords and not _chords_present(client, bucket, job_id):
                out["chords_missing"] += 1
                _report("chords_missing", job_id, is_demo)
        except Exception as exc:  # noqa: BLE001 — one bad call must not end the audit
            out["errors"] += 1
            log_structured(
                "WARN", "artifact_audit_failed", stage="check", job_id=job_id, error=str(exc)[:200]
            )
            if out["errors"] >= 5:
                break  # R2 is probably down; do not spend the whole sample on errors

    level = "ERROR" if out["stems_missing"] or out["chords_missing"] else "INFO"
    log_structured(level, "artifact_audit_done", **out)
    return out


def start_artifact_audit() -> threading.Thread | None:
    """Run `audit_retained_artifacts` on a daemon thread. Returns at once; never raises."""
    try:
        t = threading.Thread(target=audit_retained_artifacts, name="artifact-audit", daemon=True)
        t.start()
        return t
    except Exception as exc:  # noqa: BLE001
        log_structured("WARN", "artifact_audit_failed", stage="start", error=str(exc)[:200])
        return None
