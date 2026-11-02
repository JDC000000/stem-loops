"""SL21 migration 008 + fetch_gates against a real Postgres (skips without DATABASE_URL)."""

import os
import pathlib
import time

import psycopg
import pytest

from worker.downloader import fetch_gates
from worker.errors import DownloadBlockedError

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
# Destructive fixture: only ever run against a local throwaway database.
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(reason="gate DB tests wipe blocklist/fetch_attempts; local DB only")
DOWN = (
    pathlib.Path(__file__).resolve().parents[1] / "migrations" / "down" / "008_fetch_gates_down.sql"
)


@pytest.fixture
def conn():
    with psycopg.connect(DB) as c:
        c.execute("DELETE FROM kill_switches WHERE scope <> 'fetch_cobalt'")
        c.execute(
            "INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_cobalt', true) "
            "ON CONFLICT (scope) DO UPDATE SET enabled=true"
        )
        c.execute("DELETE FROM blocklist")
        c.execute("DELETE FROM fetch_attempts")
        c.commit()
        fetch_gates.reset_cache()
        yield c


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", DB or "")


def test_cobalt_seeded_engaged_so_off_by_default(conn):
    assert fetch_gates.is_engaged("fetch_cobalt") is True
    assert fetch_gates.cobalt_allowed() is False


def test_cobalt_missing_row_counts_as_engaged(conn):
    conn.execute("DELETE FROM kill_switches WHERE scope='fetch_cobalt'")
    conn.commit()
    fetch_gates.reset_cache()
    assert fetch_gates.cobalt_allowed() is False


def test_release_cobalt_and_engage_global_visible_after_ttl(conn, monkeypatch):
    assert fetch_gates.fetch_paused() is None
    conn.execute("UPDATE kill_switches SET enabled=false WHERE scope='fetch_cobalt'")
    conn.execute(
        "INSERT INTO kill_switches(scope, enabled, reason) VALUES ('fetch_global', true, 't')"
    )
    conn.commit()
    # still cached (<= 30 s)
    assert fetch_gates.fetch_paused() is None
    real = time.monotonic
    monkeypatch.setattr(fetch_gates.time, "monotonic", lambda: real() + 31)
    assert fetch_gates.fetch_paused() == "fetch_global"
    assert fetch_gates.cobalt_allowed() is True


def test_unreadable_table_fails_open_for_global_closed_for_cobalt(monkeypatch):
    fetch_gates.reset_cache()
    monkeypatch.setenv("DATABASE_URL", "postgresql://nobody:x@127.0.0.1:1/none")
    assert fetch_gates.fetch_paused() is None
    assert fetch_gates.cobalt_allowed() is False


def test_blocklist_lookup(conn):
    conn.execute(
        "INSERT INTO blocklist(video_id, reason, notice_ref) VALUES ('dQw4w9WgXcQ','takedown','n-1')"
    )
    conn.commit()
    assert fetch_gates.is_blocklisted("dQw4w9WgXcQ") is True
    assert fetch_gates.is_blocklisted("aaaaaaaaaaa") is False
    assert fetch_gates.is_blocklisted("DQW4W9WGXCQ") is False  # YouTube ids are case-sensitive; exact match only


def test_download_audio_refuses_blocklisted_id_with_real_tables(conn, monkeypatch):
    from worker import downloader
    from worker.errors import VideoBlocklistedError

    conn.execute("INSERT INTO blocklist(video_id, reason) VALUES ('dQw4w9WgXcQ','takedown')")
    conn.commit()

    def _must_not_fetch(url):
        pytest.fail("fetch_audio_file called for a blocklisted video")

    monkeypatch.setattr(downloader.ytdlp_client, "fetch_audio_file", _must_not_fetch)
    with pytest.raises(VideoBlocklistedError):
        downloader.download_audio("https://youtu.be/dQw4w9WgXcQ?si=x")


def test_blocklist_rejects_unknown_reason(conn):
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO blocklist(video_id, reason) VALUES ('x','because')")
    conn.rollback()


def test_blocklist_fails_closed_when_db_unreachable(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://nobody:x@127.0.0.1:1/none")
    with pytest.raises(DownloadBlockedError):
        fetch_gates.is_blocklisted("dQw4w9WgXcQ")


def test_log_attempt_writes_one_row_and_never_raises(conn, monkeypatch):
    fetch_gates.log_attempt(
        job_id="22222222-2222-2222-2222-222222222222",
        attempt=1,
        path="ytdlp_proxy",
        outcome_class="ok",
        ms_total=1234,
        video_id="dQw4w9WgXcQ",
        exit_session_hash="abcd",
        nbytes=99,
        ytdlp_ver="2026.8.19",
    )
    rows = conn.execute(
        "SELECT attempt, path, outcome_class, ms_total, bytes, video_hash FROM fetch_attempts"
    ).fetchall()
    assert rows == [(1, "ytdlp_proxy", "ok", 1234, 99, fetch_gates.video_hash("dQw4w9WgXcQ"))]
    monkeypatch.setenv("DATABASE_URL", "postgresql://nobody:x@127.0.0.1:1/none")
    fetch_gates.log_attempt(
        job_id=None, attempt=1, path="cobalt", outcome_class="ok", ms_total=1, video_id=None
    )


def test_down_migration_drops_exactly_the_008_tables_and_is_rolled_back_here(conn):
    conn.execute(DOWN.read_text())
    gone = conn.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name IN "
        "('kill_switches','blocklist','fetch_attempts')"
    ).fetchone()[0]
    keep = conn.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('jobs','job_events','loops')"
    ).fetchone()[0]
    conn.rollback()
    assert gone == 0 and keep == 3
