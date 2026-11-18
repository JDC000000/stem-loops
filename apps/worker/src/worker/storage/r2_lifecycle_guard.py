"""Alert when the R2 bucket carries an object-EXPIRATION lifecycle rule (QA-57 / QA-59).

WHY THIS EXISTS. Retention is enforced by the worker's sweep (cleanup.py), which keeps a
Pro/Studio song for as long as the subscription is effective plus 30 days. An R2 lifecycle
rule with an ``Expiration`` deletes objects by AGE, behind the sweep's back: R2 filters
lifecycle rules by key prefix only, and job objects are keyed by job id, not by plan, so
no expiration rule can tell a Free song from a paid one. The old whole-bucket
``expire-ephemeral-job-io`` rule (configure_r2_lifecycle.py before PR #279) did exactly
that: a Studio user's library lost its play-along audio and chord file after ~1 day while
the DB row still said "kept".

Nothing reported it, because a missing object throws no error anywhere: the stems route
lists nothing and answers "unavailable", the chord GET 404s, and both are legitimate
answers for other jobs. PR #279 stopped the script from SETTING the rule, but a rule that
was already applied stays live until someone re-runs the script. This guard reads the
bucket's live lifecycle configuration and makes that state loud.

WHAT IT DOES. ``check_r2_lifecycle()`` reads the configuration once. Any rule that is
``Enabled`` and has an ``Expiration`` (Days, Date or ExpiredObjectDeleteMarker -- any
form is an age-based delete the sweep did not decide) is logged as
``r2_lifecycle_expiration_present`` at ERROR and sent to Sentry at error level, under one
fixed fingerprint so a daily recurrence raises one issue's counter. Disabled rules and
``AbortIncompleteMultipartUpload`` (never user content) are fine. No configuration at
all (``NoSuchLifecycleConfiguration``) is fine.

WHAT IT MUST NEVER DO: crash the worker or delay the queue. Every failure of the read
(credentials without the lifecycle permission, network, a bucket that does not exist) is a
WARN and nothing more, and ``start_r2_lifecycle_check()`` runs the read on a daemon thread
so even a hung R2 call cannot hold up startup or the poll loop. It changes nothing on the
bucket: retention rules themselves are configure_r2_lifecycle.py's job.
"""

from __future__ import annotations

import contextlib
import os
import threading
from typing import Any

import sentry_sdk

from ..logger import log_structured

EVENT = "r2_lifecycle_expiration_present"
SENTRY_FINGERPRINT = ["r2-lifecycle", "expiration-present"]


def expiring_rules(config: dict[str, Any]) -> list[dict[str, Any]]:
    """The enabled rules in a GetBucketLifecycleConfiguration response that expire objects.

    Pure. Returns ``[{"id", "prefix", "expiration"}]``, one per offending rule.
    """
    out: list[dict[str, Any]] = []
    for rule in config.get("Rules") or []:
        if not isinstance(rule, dict):
            continue
        if str(rule.get("Status", "")).lower() != "enabled":
            continue
        expiration = rule.get("Expiration")
        if not expiration:
            continue
        filt = rule.get("Filter") if isinstance(rule.get("Filter"), dict) else {}
        prefix = filt.get("Prefix", rule.get("Prefix", ""))
        out.append(
            {
                "id": rule.get("ID") or "(no id)",
                "prefix": prefix if prefix is not None else "",
                # Days / Date / ExpiredObjectDeleteMarker, verbatim (Date -> str).
                "expiration": {k: str(v) for k, v in dict(expiration).items()},
            }
        )
    return out


def _error_code(exc: BaseException) -> str:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        return str((response.get("Error") or {}).get("Code") or "")
    return ""


def check_r2_lifecycle(client: Any = None, bucket: str | None = None) -> list[dict[str, Any]]:
    """Read the bucket's lifecycle rules; alert if any enabled rule expires objects.

    Returns the offending rules (empty when the bucket is safe OR when the read failed).
    Never raises.
    """
    try:
        if bucket is None:
            bucket = os.environ["R2_BUCKET_NAME"]
        if client is None:
            from .r2_uploader import _r2

            client = _r2()
        config = client.get_bucket_lifecycle_configuration(Bucket=bucket)
    except Exception as exc:  # noqa: BLE001 — a guard must never take the worker down
        if _error_code(exc) == "NoSuchLifecycleConfiguration":
            log_structured("INFO", "r2_lifecycle_ok", rules=0)
            return []
        log_structured(
            "WARN",
            "r2_lifecycle_check_failed",
            error_type=type(exc).__name__,
            error_code=_error_code(exc),
            error=str(exc)[:200],
        )
        return []

    try:
        bad = expiring_rules(config if isinstance(config, dict) else {})
    except Exception as exc:  # noqa: BLE001
        log_structured("WARN", "r2_lifecycle_check_failed", error=str(exc)[:200])
        return []

    if not bad:
        log_structured("INFO", "r2_lifecycle_ok", rules=len(config.get("Rules") or []))
        return []

    summary = ", ".join(
        f"{r['id']} (prefix={r['prefix']!r}, "
        + ", ".join(f"{k}={v}" for k, v in r["expiration"].items())
        + ")"
        for r in bad
    )
    log_structured(
        "ERROR",
        EVENT,
        rule_ids=[r["id"] for r in bad],
        rules=bad,
        action=(
            "R2 is deleting objects by age behind the retention sweep; paid libraries lose "
            "their files. Re-run scripts/configure_r2_lifecycle.py and confirm in Cloudflare "
            "(R2 -> bucket -> Settings -> Object lifecycle rules) that no 'Delete objects' "
            "rule exists."
        ),
    )
    with contextlib.suppress(Exception):  # telemetry is never load-bearing
        sentry_sdk.capture_message(
            f"R2 lifecycle expiration rule present: {summary}",
            level="error",
            fingerprint=SENTRY_FINGERPRINT,
        )
    return bad


def start_r2_lifecycle_check() -> threading.Thread | None:
    """Run ``check_r2_lifecycle`` on a daemon thread. Returns at once; never raises.

    A daemon thread, not ``asyncio.to_thread``: the default executor is joined at
    interpreter shutdown and shared with the pipeline, so a hung R2 call there could
    delay both. A daemon thread holds nothing anyone waits on.
    """
    try:
        t = threading.Thread(target=check_r2_lifecycle, name="r2-lifecycle-check", daemon=True)
        t.start()
        return t
    except Exception as exc:  # noqa: BLE001
        log_structured("WARN", "r2_lifecycle_check_failed", error=str(exc)[:200])
        return None
