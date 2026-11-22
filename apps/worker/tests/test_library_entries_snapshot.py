"""Song library keeps every song (Phase B, B1; migration 043): the retention sweep leaves a
METADATA entry (link or file name, title, BPM, key; no job_id) for a signed-in user's song when
it removes the job.

Pinned here:
  * without a database (always runs): the statement ORDER inside one job's transaction --
    snapshot, SAVEPOINT before_delete, DELETE; on ForeignKeyViolation ROLLBACK TO SAVEPOINT
    (never conn.rollback()) and the anonymise UPDATEs, then ONE commit; any other failure rolls
    the whole job back; a database without 043 (42P01) is tolerated; the snapshot filter's
    terms; the per-sweep `library_entry_snapshotted` count.
  * against a REAL local Postgres (skipped without DATABASE_URL, FAILED under CI by
    conftest.py for a non-local one): the real sweep over a fake R2 for AC 1/2/3/7/8 of the
    brief -- DELETE branch, anonymise branch, the five "no entry" cases, one row per URL, the
    cascade and the tombstone trigger, RLS / grants / SECURITY DEFINER.
"""

from __future__ import annotations

import asyncio
import os
import re
import uuid
from pathlib import Path
from typing import Any

import psycopg
import pytest
from psycopg import errors as pg_errors

from tests.db_guard import refuse_unless_local
from worker import cleanup

DB = os.environ.get("DATABASE_URL")
needs_db = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
EMAIL_LIKE = "test-libentry-%@example.com"
PROBE = "libentry-probe"
MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "043_v3_library_entries.sql"


def _norm(s: str) -> str:
    return " ".join(s.split())


# ----------------------------------------------------------------------------- no database


class _Cur:
    def __init__(self, rows=None, rowcount=0):
        self._rows = rows or []
        self.rowcount = rowcount

    async def fetchall(self):
        return self._rows


class FakeConn:
    """Records every statement; scripted failures by statement prefix."""

    def __init__(self, job_ids, fail: dict[str, BaseException] | None = None, snap_rows=1):
        self.job_ids = job_ids
        self.fail = fail or {}
        self.log: list[str] = []
        self.snap_rows = snap_rows

    async def execute(self, sql, params=None):
        s = _norm(sql)
        if s.upper().startswith("SELECT ID::TEXT FROM JOBS"):
            self.log.append("SELECT candidates")
            return _Cur([(j,) for j in self.job_ids])
        key = (
            "SNAPSHOT"
            if s.startswith("INSERT INTO library_entries")
            else s.split(" WHERE ")[0] if s.startswith("DELETE") else s.split(" SET ")[0]
        )
        self.log.append(key)
        for prefix, exc in list(self.fail.items()):
            if key.startswith(prefix):
                raise exc
        return _Cur(rowcount=self.snap_rows if key == "SNAPSHOT" else 1)

    async def commit(self):
        self.log.append("COMMIT")

    async def rollback(self):
        self.log.append("ROLLBACK")


@pytest.fixture
def no_r2(monkeypatch):
    monkeypatch.setattr(cleanup, "delete_prefix", lambda prefix: 0)
    cleanup._failed.clear()
    yield
    cleanup._failed.clear()


def _run(conn):
    return asyncio.run(cleanup._sweep_expired_jobs(conn, deadline=float("inf")))


def test_delete_branch_is_one_transaction_snapshot_first(no_r2):
    conn = FakeConn(["j1"])
    assert _run(conn) == (1, 0, 0)
    assert conn.log == [
        "SELECT candidates",
        "SAVEPOINT library_snapshot",
        "SNAPSHOT",
        "RELEASE SAVEPOINT library_snapshot",
        "SAVEPOINT before_delete",
        "DELETE FROM jobs",
        "COMMIT",
    ]


def test_fk_branch_rolls_back_to_the_savepoint_and_anonymises_in_the_same_tx(no_r2):
    conn = FakeConn(["j1"], fail={"DELETE FROM jobs": pg_errors.ForeignKeyViolation("ledger")})
    assert _run(conn) == (0, 0, 1)
    assert conn.log == [
        "SELECT candidates",
        "SAVEPOINT library_snapshot",
        "SNAPSHOT",
        "RELEASE SAVEPOINT library_snapshot",
        "SAVEPOINT before_delete",
        "DELETE FROM jobs",
        "ROLLBACK TO SAVEPOINT before_delete",
        "DELETE FROM loops",
        "UPDATE jobs",
        "COMMIT",
    ]
    assert "ROLLBACK" not in conn.log, "conn.rollback() would undo the snapshot"


def test_any_other_failure_rolls_the_whole_job_back_and_records_it(no_r2):
    conn = FakeConn(["j1"], fail={"DELETE FROM jobs": RuntimeError("disk full")})
    assert _run(conn) == (0, 0, 0)
    assert conn.log[-1] == "ROLLBACK" and "COMMIT" not in conn.log
    assert cleanup._failed["j1"][0] == 1


def test_an_anonymise_failure_rolls_back_the_snapshot_too(no_r2):
    conn = FakeConn(
        ["j1"],
        fail={
            "DELETE FROM jobs": pg_errors.ForeignKeyViolation("ledger"),
            "UPDATE jobs": RuntimeError("boom"),
        },
    )
    assert _run(conn) == (0, 0, 0)
    assert conn.log[-1] == "ROLLBACK" and "COMMIT" not in conn.log
    assert cleanup._failed["j1"][0] == 1


def test_a_snapshot_failure_keeps_the_job(no_r2):
    conn = FakeConn(["j1"], fail={"SNAPSHOT": RuntimeError("constraint")})
    assert _run(conn) == (0, 0, 0)
    assert "DELETE FROM jobs" not in conn.log and conn.log[-1] == "ROLLBACK"


def test_unmigrated_database_42p01_is_tolerated(no_r2, monkeypatch):
    monkeypatch.setattr(cleanup, "_library_unmigrated_reported", False)
    conn = FakeConn(["j1", "j2"], fail={"SNAPSHOT": pg_errors.UndefinedTable("no 043")})
    assert _run(conn) == (2, 0, 0)
    assert conn.log[1:7] == [
        "SAVEPOINT library_snapshot",
        "SNAPSHOT",
        "ROLLBACK TO SAVEPOINT library_snapshot",
        "SAVEPOINT before_delete",
        "DELETE FROM jobs",
        "COMMIT",
    ]


def test_snapshot_count_is_logged_once_per_sweep(no_r2, monkeypatch):
    seen: list[tuple[str, dict]] = []
    monkeypatch.setattr(cleanup, "log_structured", lambda lvl, ev, **kw: seen.append((ev, kw)))
    _run(FakeConn(["j1", "j2", "j3"]))
    assert [kw for ev, kw in seen if ev == "library_entry_snapshotted"] == [{"count": 3}]
    seen.clear()
    _run(FakeConn(["j1"], fail={"DELETE FROM jobs": RuntimeError("x")}))
    assert [kw for ev, kw in seen if ev == "library_entry_snapshotted"] == [{"count": 0}]


def test_snapshot_filter_terms():
    sql = _norm(cleanup.LIBRARY_SNAPSHOT_SQL)
    for term in (
        "WHERE jobs.id = %s",
        "jobs.user_id IS NOT NULL",
        "jobs.status = 'done'",
        "jobs.is_demo = false",
        "jobs.client_ip_hash <> %s",
        "EXISTS (SELECT 1 FROM users u WHERE u.id = jobs.user_id AND u.deleted_at IS NULL)",
        "ON CONFLICT (user_id, youtube_url) WHERE youtube_url IS NOT NULL DO UPDATE",
    ):
        assert term in sql, term
    assert "job_id" not in sql, "an entry holds no job_id (D-a)"


def test_migration_header_and_shape():
    src = MIGRATION.read_text()
    assert "-- rls-backend-only: library_entries" in src
    assert "APPLYING IT to staging or production needs Jon" in src
    assert "Jon applies 043 -> merge -> deploy worker" in src
    body = re.sub(r"--[^\n]*", "", src)
    table = body.split("CREATE TABLE IF NOT EXISTS public.library_entries (")[1].split(");")[0]
    assert "job_id" not in table, "no job_id column (D-a)"
    assert re.search(
        r"user_id\s+uuid\s+NOT NULL REFERENCES public\.users\(id\) ON DELETE CASCADE", body
    )
    assert "SECURITY DEFINER" in body and "SET search_path = public, pg_temp" in body
    assert (
        "REVOKE ALL ON FUNCTION public.delete_library_entries_for_tombstoned_user() FROM PUBLIC"
        in body
    )
    assert (MIGRATION.parent / "down" / "043_v3_library_entries_down.sql").exists()


# ----------------------------------------------------------------------------- real database


class FakeR2:
    def delete_prefix(self, prefix):
        return 0

    def list_older(self, cutoff, limit=2000, start_after=""):
        return []

    def delete_objects(self, keys):
        return len(keys)


def _purge(c: Any) -> None:
    c.rollback()
    c.execute("RESET ROLE")
    like = "(SELECT id FROM public.users WHERE email LIKE %s)"
    c.execute(f"DELETE FROM public.chord_edits WHERE user_id IN {like}", (EMAIL_LIKE,))
    c.execute("DELETE FROM public.jobs WHERE client_ip_hash = %s", (PROBE,))
    c.execute(f"DELETE FROM public.jobs WHERE user_id IN {like}", (EMAIL_LIKE,))
    c.execute(f"DELETE FROM public.library_entries WHERE user_id IN {like}", (EMAIL_LIKE,))
    c.execute("DELETE FROM public.users WHERE email LIKE %s", (EMAIL_LIKE,))
    c.execute("DELETE FROM auth.users WHERE email LIKE %s", (EMAIL_LIKE,))
    c.commit()


@pytest.fixture
def conn(monkeypatch):
    refuse_unless_local(("DATABASE_URL", DB))
    fake = FakeR2()
    monkeypatch.setattr(cleanup, "DATABASE_URL", DB)
    monkeypatch.setattr(cleanup, "delete_prefix", fake.delete_prefix)
    monkeypatch.setattr(cleanup, "list_objects_older_than", fake.list_older)
    monkeypatch.setattr(cleanup, "delete_objects", fake.delete_objects)
    cleanup._failed.clear()
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        _purge(c)
        yield c
        _purge(c)
    cleanup._failed.clear()


def _user(c: Any, tag: str) -> uuid.UUID:
    uid = uuid.uuid4()
    c.execute(
        "INSERT INTO auth.users (id, email, aud, role, encrypted_password, "
        "email_confirmed_at, created_at, updated_at) "
        "VALUES (%s, %s, 'authenticated', 'authenticated', 'x', now(), now(), now())",
        (uid, f"test-libentry-{tag}-{uid.hex[:8]}@example.com"),
    )
    c.commit()
    return uid


def _job(
    c: Any,
    user: uuid.UUID | None,
    *,
    url: str | None = None,
    status: str = "done",
    age_h: float = 25,
    title: str | None = "Song",
    bpm: float | None = 120.0,
    key: str | None = "A minor",
    demo: bool = False,
    filename: str | None = None,
) -> str:
    jid = str(uuid.uuid4())
    upload = url is None
    c.execute(
        "INSERT INTO public.jobs (id, input_kind, youtube_url, upload_r2_key, original_filename, "
        "  status, client_ip_hash, client_fingerprint, user_id, loop_length_bars, title, video_id, "
        "  bpm, musical_key, created_at, expires_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, '', %s, 4, %s, %s, %s, %s, "
        "  now() - (%s * interval '1 hour'), now() - (%s * interval '1 hour') + interval '24 hours')",
        (
            jid,
            "upload" if upload else "youtube",
            url,
            f"{jid}/_input.mp3" if upload else None,
            filename if upload else None,
            status,
            PROBE,
            user,
            title,
            None if upload else "dQw4w9WgXcQ",
            bpm,
            key,
            age_h,
            age_h,
        ),
    )
    if demo:
        c.execute("UPDATE public.jobs SET is_demo = true WHERE id = %s", (jid,))
    c.commit()
    return jid


def _sweep() -> None:
    for _ in range(20):
        res = asyncio.run(cleanup.sweep_expired())
        if res["jobs"] == 0 and res["anonymised"] == 0:
            return
    raise AssertionError("the sweep never went quiet")


def _entries(c: Any, user: uuid.UUID) -> list[tuple]:
    return c.execute(
        "SELECT input_kind, youtube_url, original_filename, title, video_id, bpm, musical_key "
        "FROM public.library_entries WHERE user_id = %s ORDER BY first_created_at",
        (user,),
    ).fetchall()


def _exists(c: Any, jid: str) -> bool:
    return c.execute("SELECT 1 FROM public.jobs WHERE id = %s", (jid,)).fetchone() is not None


@needs_db
def test_ac1_swept_free_link_job_leaves_one_entry(conn):
    u = _user(conn, "free")
    j = _job(
        conn,
        u,
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title="Never",
        bpm=113.5,
        key="A major",
    )
    _sweep()
    assert not _exists(conn, j)
    assert _entries(conn, u) == [
        (
            "youtube",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            None,
            "Never",
            "dQw4w9WgXcQ",
            113.5,
            "A major",
        )
    ]


@needs_db
def test_upload_entry_keeps_file_name_and_title_only(conn):
    u = _user(conn, "upload")
    _job(conn, u, url=None, filename="demo take.wav", title="demo take", bpm=None, key=None)
    _sweep()
    assert _entries(conn, u) == [("upload", None, "demo take.wav", "demo take", None, None, None)]


@needs_db
def test_ac2_ledger_bound_job_becomes_a_shell_and_still_gets_an_entry(conn):
    u = _user(conn, "ledger")
    j = _job(conn, u, url="https://www.youtube.com/watch?v=ledger00001", title="Kept")
    conn.execute(
        "INSERT INTO public.chord_edits (user_id, job_id, track_hash, provider, "
        "provider_version, start_sec, end_sec, original_label, corrected_label, alphabet_sha) "
        "VALUES (%s,%s,%s,'klangio','v1',0,1,'C','G',%s)",
        (u, j, "b" * 64, "a" * 64),
    )
    conn.commit()
    _sweep()
    row = conn.execute(
        "SELECT title, client_ip_hash FROM public.jobs WHERE id = %s", (j,)
    ).fetchone()
    assert row == (None, cleanup.PURGED_MARKER), "the job is an anonymised shell"
    assert [e[3] for e in _entries(conn, u)] == ["Kept"], "the snapshot survived the FK branch"


@needs_db
def test_ac3_no_entry_for_demo_anonymous_failed_deleted_or_tombstoned(conn):
    owner = _user(conn, "owner")
    _job(conn, owner, url="https://youtu.be/failed00001", status="failed")
    _job(conn, None, url="https://youtu.be/anonymous01")
    _job(conn, owner, url="https://youtu.be/demo0000001", demo=True, age_h=24 * 400)
    gone = _user(conn, "gone")
    gone_job = _job(conn, gone, url="https://youtu.be/deleteduser")
    conn.execute("DELETE FROM auth.users WHERE id = %s", (gone,))  # cascades public.users
    tomb = _user(conn, "tomb")
    _job(conn, tomb, url="https://youtu.be/tombstoned1")
    conn.execute("UPDATE public.users SET deleted_at = now() WHERE id = %s", (tomb,))
    conn.commit()
    _sweep()
    assert not _exists(conn, gone_job)
    assert _entries(conn, owner) == []
    assert _entries(conn, tomb) == []
    assert (
        conn.execute(
            "SELECT count(*) FROM public.library_entries WHERE youtube_url = ANY(%s)",
            (["https://youtu.be/anonymous01", "https://youtu.be/deleteduser"],),
        ).fetchone()[0]
        == 0
    )


@needs_db
def test_ac7_one_entry_per_url_when_the_same_song_is_swept_twice(conn):
    u = _user(conn, "twice")
    url = "https://www.youtube.com/watch?v=twice000001"
    _job(conn, u, url=url, age_h=50, title="Old title", bpm=None)
    _sweep()
    _job(conn, u, url=url, age_h=26, title="New title", bpm=99.0)
    _sweep()
    rows = _entries(conn, u)
    assert len(rows) == 1 and rows[0][3] == "New title" and rows[0][5] == 99.0


@needs_db
def test_ac8_account_deletion_cascades_and_the_tombstone_alone_deletes(conn):
    a = _user(conn, "cascade")
    b = _user(conn, "tombalone")
    for u in (a, b):
        _job(conn, u, url=f"https://youtu.be/{u.hex[:11]}")
    _sweep()
    assert len(_entries(conn, a)) == 1 and len(_entries(conn, b)) == 1
    conn.execute("DELETE FROM auth.users WHERE id = %s", (a,))
    conn.execute("UPDATE public.users SET deleted_at = now() WHERE id = %s", (b,))
    conn.commit()
    assert _entries(conn, a) == []
    assert _entries(conn, b) == [], "the tombstone trigger deletes entries on its own"


@needs_db
def test_rls_grants_and_trigger_function_shape(conn):
    assert conn.execute(
        "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.library_entries'::regclass"
    ).fetchone() == (True,)
    for role in ("anon", "authenticated"):
        if conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,)).fetchone():
            assert conn.execute(
                "SELECT has_table_privilege(%s, 'public.library_entries', 'SELECT')", (role,)
            ).fetchone() == (False,)
            assert conn.execute(
                "SELECT has_function_privilege(%s, "
                "'public.delete_library_entries_for_tombstoned_user()', 'EXECUTE')",
                (role,),
            ).fetchone() == (False,)
    secdef, cfg = conn.execute(
        "SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'delete_library_entries_for_tombstoned_user'"
    ).fetchone()
    assert secdef is True and "search_path=public, pg_temp" in (cfg or [])


@needs_db
def test_the_app_role_reads_and_removes_entries_with_rls_on(conn):
    u = _user(conn, "approle")
    _job(conn, u, url="https://youtu.be/approle0001")
    _sweep()
    conn.execute("SET ROLE stemloops_app")
    try:
        n = conn.execute(
            "SELECT count(*) FROM library_entries WHERE user_id = %s", (u,)
        ).fetchone()[0]
        assert n == 1
        conn.execute("DELETE FROM library_entries WHERE user_id = %s", (u,))
    finally:
        conn.commit()
        conn.execute("RESET ROLE")
    assert _entries(conn, u) == []
