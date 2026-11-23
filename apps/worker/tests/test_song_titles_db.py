"""N-1 (PR #290 review round 2), against a REAL local Postgres: the pipeline's title write must
never repopulate a row the cleanup has blanked or is entitled to blank.

Skipped without DATABASE_URL; refused for a non-local one by conftest.py. Uses only rows it
creates (client_ip_hash / fingerprint tagged), and removes them afterwards.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import timedelta

import psycopg
import pytest

from worker import cleanup, pipeline

DB = os.environ.get("DATABASE_URL")
needs_db = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
TAG = "n1-title-probe"


@pytest.fixture
def conn(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(pipeline, "DATABASE_URL", DB)
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute("DELETE FROM public.jobs WHERE client_fingerprint = %s", (TAG,))
        c.commit()
        yield c
        c.rollback()
        c.execute("DELETE FROM public.jobs WHERE client_fingerprint = %s", (TAG,))
        c.commit()


def _job(c, age: timedelta = timedelta(0), *, killed: bool = False) -> str:
    """An anonymous upload job `age` old; expires_at is the 24 h default, or created_at if killed."""
    jid = str(uuid.uuid4())
    c.execute(
        "INSERT INTO public.jobs (id, input_kind, upload_r2_key, status, requested_stems, "
        "loop_length_bars, client_ip_hash, client_fingerprint, created_at, expires_at) "
        "VALUES (%s, 'upload', 'k', 'downloading', '{vocals}', 4, 'h', %s, now() - %s, "
        "now() - %s + %s)",
        (jid, TAG, age, age, timedelta(0) if killed else timedelta(hours=24)),
    )
    c.commit()
    return jid


def _title(c, jid: str):
    return c.execute("SELECT title FROM public.jobs WHERE id = %s", (jid,)).fetchone()[0]


@needs_db
def test_a_live_job_gets_its_title_once(conn):
    jid = _job(conn)
    pipeline._record_title(jid, "Lucky Ticket")
    pipeline._record_title(jid, "second")
    assert _title(conn, jid) == "Lucky Ticket"


@needs_db
def test_an_anonymised_shell_is_never_given_a_title_back(conn):
    # The exact sequence the reviewer named: the job outlives retention + grace while in flight,
    # the sweep anonymises it, then a reaper re-run reaches the title write.
    jid = _job(conn, age=timedelta(hours=30))

    async def anonymise():
        aconn = await psycopg.AsyncConnection.connect(DB)  # type: ignore[arg-type]
        try:
            await cleanup._anonymise_job(aconn, jid)
            await aconn.commit()  # _anonymise_job leaves the commit to its caller (B1)
        finally:
            await aconn.close()

    asyncio.run(anonymise())
    row = conn.execute(
        "SELECT title, client_ip_hash FROM public.jobs WHERE id = %s", (jid,)
    ).fetchone()
    assert row == (None, cleanup.PURGED_MARKER)
    pipeline._record_title(jid, "Resurrected")
    assert _title(conn, jid) is None


@needs_db
def test_a_shell_is_refused_even_if_its_expiry_were_in_the_future(conn):
    """The marker alone is enough: the guard does not lean on the clock for a shell."""
    jid = _job(conn)
    conn.execute(
        "UPDATE public.jobs SET client_ip_hash = %s WHERE id = %s", (cleanup.PURGED_MARKER, jid)
    )
    conn.commit()
    pipeline._record_title(jid, "Resurrected")
    assert _title(conn, jid) is None


@needs_db
def test_a_job_past_retention_is_refused(conn):
    jid = _job(conn, age=timedelta(hours=25))  # expired, not yet swept
    pipeline._record_title(jid, "Too late")
    assert _title(conn, jid) is None


@needs_db
def test_a_job_whose_owner_deleted_the_account_is_refused(conn):
    jid = _job(conn, killed=True)  # account deletion sets expires_at = created_at
    pipeline._record_title(jid, "Gone")
    assert _title(conn, jid) is None
