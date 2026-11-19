"""The daily audit's sample QUERY, run against a real Postgres (CI only; PR #306 review M-4).

`test_artifact_audit.py` checks SAMPLE_SQL as text, so a flipped comparison (the review's
surviving mutant: `RETAINED_UNTIL_SQL > now()` -> `< now()`) still passed there while the
audit sampled EXPIRED rows and checked nothing useful. This file seeds one row per case and
runs the real `sample_retained_jobs` over the real schema:

  included: a retained Free job (3 h old, done); a retained demo made after the cutoff; a
            demo made BEFORE the 2026-11-11 cutoff (review M-2: demos are always audited);
  excluded: an expired Free job (30 h old); a job too young to sample (10 min); a failed
            job; an anonymised shell; an anonymised demo shell; a non-demo job made before
            the cutoff even though it is still retained.

and checks every demo row comes before every non-demo row.

DATABASE: needs DATABASE_URL (skipped locally without one, FAILED under CI=true so the gate
cannot silently not run) and refuses a non-local one (tests/db_guard.py). The seeded rows are
committed so the audit's own connection sees them, and deleted by id in teardown.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

import psycopg
import pytest

from tests.db_guard import refuse_unless_local, skip_or_fail
from worker import artifact_audit as audit
from worker import cleanup

DB = os.environ.get("DATABASE_URL")


def _insert(
    c,
    tag: str,
    *,
    created: str,
    status: str = "done",
    expires: str | None = None,
    demo: bool = False,
    purged: bool = False,
    klangio: str | None = None,
) -> str:
    """One job. `created` / `expires` are SQL timestamptz expressions; expires defaults to the
    INSERT default's shape, created_at + 24 h."""
    jid = str(uuid.uuid4())
    ip = cleanup.PURGED_MARKER if purged else f"audit-db-{tag}"
    exp = expires or f"({created}) + interval '24 hours'"
    c.execute(
        "INSERT INTO public.jobs (id, youtube_url, status, client_ip_hash, client_fingerprint, "
        "loop_length_bars, klangio_job_id, created_at, expires_at) "
        f"VALUES (%s, %s, %s, %s, '', 4, %s, {created}, {exp})",
        (jid, f"https://audit-db.invalid/{tag}", status, ip, klangio),
    )
    if demo:
        # A separate UPDATE, the way the operator's named write sets it (migration 040).
        c.execute("UPDATE public.jobs SET is_demo = true WHERE id = %s", (jid,))
    return jid


@pytest.fixture
def seeded() -> Iterator[dict[str, str]]:
    if not DB:
        skip_or_fail("DATABASE_URL is not set, so the audit's sample query cannot run")
    refuse_unless_local(("DATABASE_URL", DB))
    rows: dict[str, str] = {}
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        rows["free_retained"] = _insert(
            c, "free_retained", created="now() - interval '3 hours'", klangio="kl-1"
        )
        rows["demo_recent"] = _insert(
            c,
            "demo_recent",
            created="now() - interval '2 hours'",
            expires="now() - interval '2 hours'",  # demos are retained whatever expires_at says
            demo=True,
        )
        rows["demo_pre_cutoff"] = _insert(
            c, "demo_pre_cutoff", created="'2026-11-01T12:00:00Z'::timestamptz", demo=True
        )
        rows["free_expired"] = _insert(c, "free_expired", created="now() - interval '30 hours'")
        rows["too_young"] = _insert(c, "too_young", created="now() - interval '10 minutes'")
        rows["failed"] = _insert(c, "failed", created="now() - interval '3 hours'", status="failed")
        rows["purged_shell"] = _insert(
            c, "purged_shell", created="now() - interval '3 hours'", purged=True
        )
        rows["purged_demo"] = _insert(
            c, "purged_demo", created="now() - interval '3 hours'", demo=True, purged=True
        )
        rows["pre_cutoff_retained"] = _insert(
            c,
            "pre_cutoff_retained",
            created="'2026-11-01T12:00:00Z'::timestamptz",
            expires="now() + interval '300 days'",
        )
        c.commit()
    try:
        yield rows
    finally:
        with psycopg.connect(DB) as c:  # type: ignore[arg-type]
            c.execute("DELETE FROM public.jobs WHERE id = ANY(%s::uuid[])", (list(rows.values()),))
            c.commit()


def test_the_sample_query_selects_exactly_the_retained_auditable_rows(seeded):
    # A limit far above anything else in the shared CI database, so LIMIT/random() cannot
    # drop one of this test's rows.
    got = audit.sample_retained_jobs(DB, limit=1_000_000)  # type: ignore[arg-type]
    ids = [r[0] for r in got]
    mine = {name: jid for name, jid in seeded.items() if jid in ids}

    assert set(mine) == {"free_retained", "demo_recent", "demo_pre_cutoff"}, (
        "included: retained Free, both demos (one predates the cutoff); excluded: expired, "
        f"too young, failed, shells, pre-cutoff non-demo. Got {sorted(mine)}"
    )
    by_id = {r[0]: r for r in got}
    assert by_id[seeded["free_retained"]][1:] == (False, "kl-1"), "(id, is_demo, klangio_job_id)"
    assert by_id[seeded["demo_pre_cutoff"]][1] is True

    # Demos first: every is_demo row precedes every other row in the whole result.
    flags = [r[1] for r in got]
    assert flags == sorted(flags, reverse=True), "ORDER BY is_demo DESC"
