"""Kill-switch read as the role production actually uses: NOSUPERUSER, subject to grants + RLS.

Why this file exists. CI connects as POSTGRES_USER `stemloops`, the container SUPERUSER, which
bypasses both table grants and row-level security. `test_fetch_gates_db.py` therefore cannot
see a missing GRANT or a dropped policy: the read just works. Here the worker reads through
`ks_probe`, a NOSUPERUSER NOBYPASSRLS login role that is a member of `stemloops_app` (the role
migration 011 grants CRUD to and attaches the `stemloops_app_all` policy to), so the grants and
the policy are in the path. A superuser connection (`admin`) is used only to arrange state.

It also drives `fetch_youtube` through the REAL database read. `test_fetch_chain.py` fakes
`fetch_paused()` and parametrizes the scope name through the fake, so the string "fetch_youtube"
never reaches SQL there: the switch could be disconnected with that suite green.

Local throwaway DB only (the fixtures create a cluster-level role and alter grants/policies).
"""

from __future__ import annotations

import json
import os
import threading
import time

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from worker import downloader
from worker.downloader import fetch_gates
from worker.errors import FetchPausedError

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not any(h in DB for h in ("127.0.0.1", "localhost")):
    pytestmark = pytest.mark.skip(reason="alters roles/grants/policies; local DB only")

ROLE = "ks_probe"
ROLE_PW = "ks_probe_pw"  # throwaway local role; never a real credential
URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
JOB = "11111111-1111-1111-1111-111111111111"
# The cap the gate read is meant to have. Pinned HERE as a literal (not imported) so that a
# missing/renamed constant fails an assertion instead of crashing the test with AttributeError.
TIMEOUT_S = 2.0


def _events(capsys) -> list[dict]:
    """Structured log lines written to stderr since the last read."""
    out = []
    for line in capsys.readouterr().err.splitlines():
        line = line.strip()
        if line.startswith("{"):
            rec = json.loads(line)
            rec["detail"] = json.loads(rec["detail"]) if rec.get("detail") else {}
            out.append(rec)
    return out


def _named(events: list[dict], name: str) -> list[dict]:
    return [e for e in events if e["event"] == name]


@pytest.fixture(scope="module")
def restricted_url():
    """Create the NOSUPERUSER role once and hand back a conninfo string for it."""
    with psycopg.connect(DB, autocommit=True) as c:
        c.execute(f"DROP ROLE IF EXISTS {ROLE}")  # a leftover from an aborted run
        c.execute(
            f"CREATE ROLE {ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE "
            f"PASSWORD '{ROLE_PW}'"
        )
        c.execute(f"GRANT stemloops_app TO {ROLE}")
        db = c.info.dbname
        c.execute(f'GRANT CONNECT ON DATABASE "{db}" TO {ROLE}')
    url = make_conninfo(DB, user=ROLE, password=ROLE_PW)
    # Fail loudly if the role is not what we claim: the whole file rests on it.
    with psycopg.connect(url) as r:
        assert r.execute(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
        ).fetchone() == (False, False)
    yield url
    with psycopg.connect(DB, autocommit=True) as c:
        c.execute(f"DROP OWNED BY {ROLE}")
        c.execute(f"DROP ROLE {ROLE}")


@pytest.fixture
def admin():
    """Superuser connection (autocommit) with a known starting state, ACLs restored after."""
    with psycopg.connect(DB, autocommit=True) as c:
        c.execute("DELETE FROM kill_switches WHERE scope <> 'fetch_cobalt'")
        c.execute(
            "INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_cobalt', true) "
            "ON CONFLICT (scope) DO UPDATE SET enabled=true"
        )
        fetch_gates.reset_cache()
        try:
            yield c
        finally:
            # Put back exactly what migration 011 installs, whatever the test did.
            c.execute("ALTER TABLE kill_switches ENABLE ROW LEVEL SECURITY")
            c.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON kill_switches TO stemloops_app")
            c.execute("DROP POLICY IF EXISTS stemloops_app_all ON kill_switches")
            c.execute(
                "CREATE POLICY stemloops_app_all ON kill_switches FOR ALL TO stemloops_app "
                "USING (true) WITH CHECK (true)"
            )
            fetch_gates.reset_cache()


@pytest.fixture
def as_worker(restricted_url, admin, monkeypatch):
    """Point the gate at the restricted role (what the Fly worker's DATABASE_URL is)."""
    monkeypatch.setenv("DATABASE_URL", restricted_url)
    fetch_gates.reset_cache()
    return admin


def _advance(monkeypatch, seconds: float) -> None:
    real = time.monotonic
    monkeypatch.setattr(fetch_gates.time, "monotonic", lambda: real() + seconds)


# --------------------------------------------------------------------------------------------
# Positive control: without this, the two "hole" tests below would pass for any broken setup.
# --------------------------------------------------------------------------------------------
def test_control_restricted_role_with_intact_grants_sees_an_engaged_global_brake(as_worker, capsys):
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_global', true)")
    assert fetch_gates.fetch_paused() == "fetch_global"
    ev = _events(capsys)
    assert not _named(ev, "kill_switch_read_failed")
    assert not _named(ev, "kill_switch_table_empty")


# 1 ------------------------------------------------------------------------------------------
def test_revoked_select_with_an_engaged_global_row_fails_open_and_warns(as_worker, capsys):
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_global', true)")
    as_worker.execute("REVOKE SELECT ON kill_switches FROM stemloops_app")
    fetch_gates.reset_cache()
    capsys.readouterr()

    # OBSERVED, and documented policy: the read fails, nothing is cached, global fails open.
    # The row says ENGAGED and the worker does not see it. This test pins that, so a change
    # to the policy is a visible, deliberate change.
    assert fetch_gates.fetch_paused() is None
    assert fetch_gates.cobalt_allowed() is False  # cobalt still fails closed

    warns = _named(_events(capsys), "kill_switch_read_failed")
    assert warns, "a failed gate read must log kill_switch_read_failed"
    assert all(w["level"] == "WARN" for w in warns)
    assert "permission denied" in warns[0]["detail"]["error"]


def test_stale_engaged_cache_keeps_blocking_however_long_reads_keep_failing(
    as_worker, monkeypatch, capsys
):
    """Pins WHY there is no stale-cache ceiling. An operator-pulled brake that was cached
    before reads started failing must stay pulled. Expiring the cache would turn
    fetch_global/fetch_youtube into 'not engaged' (is_engaged falls back to
    `scope in _DEFAULT_ENGAGED`), i.e. release the brake because the database is unwell."""
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_global', true)")
    assert fetch_gates.fetch_paused() == "fetch_global"  # cached while readable
    as_worker.execute("REVOKE SELECT ON kill_switches FROM stemloops_app")
    capsys.readouterr()

    for secs in (31, 301, 10_000, 86_400):  # past the TTL, past any 300 s ceiling, and a day
        _advance(monkeypatch, secs)
        assert fetch_gates.fetch_paused() == "fetch_global", f"brake released after {secs} s"
    assert _named(_events(capsys), "kill_switch_read_failed")  # reads really were failing


# 2 ------------------------------------------------------------------------------------------
def test_dropped_rls_policy_reads_zero_rows_logs_table_empty_and_changes_no_decision(
    as_worker, capsys
):
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_global', true)")
    as_worker.execute("DROP POLICY stemloops_app_all ON kill_switches")
    fetch_gates.reset_cache()
    capsys.readouterr()

    # The read SUCCEEDS and returns []. The engaged global row is invisible, so the decision
    # is the unchanged fail-open one; cobalt's missing-row default (engaged) is unchanged too.
    assert fetch_gates.fetch_paused() is None
    assert fetch_gates.cobalt_allowed() is False

    ev = _events(capsys)
    assert not _named(ev, "kill_switch_read_failed"), "a zero-row read is a success, not a failure"
    empty = _named(ev, "kill_switch_table_empty")
    assert len(empty) == 1
    assert empty[0]["level"] == "ERROR"
    assert "unreadable" in empty[0]["detail"]["detail"]


def test_table_empty_logs_once_per_ttl_not_once_per_call(as_worker, monkeypatch, capsys):
    """Rate: the log rides the refresh, so it is at most once per TTL per process."""
    as_worker.execute("DROP POLICY stemloops_app_all ON kill_switches")
    fetch_gates.reset_cache()
    capsys.readouterr()
    for _ in range(25):
        fetch_gates.fetch_paused()
    assert len(_named(_events(capsys), "kill_switch_table_empty")) == 1
    _advance(monkeypatch, 31)
    fetch_gates.fetch_paused()
    assert len(_named(_events(capsys), "kill_switch_table_empty")) == 1


# 3 ------------------------------------------------------------------------------------------
def test_engaged_fetch_youtube_row_pauses_through_the_real_read(as_worker):
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_youtube', true)")
    assert fetch_gates.fetch_paused() == "fetch_youtube"


def test_engaged_fetch_youtube_row_refuses_download_audio_before_any_fetch(as_worker, monkeypatch):
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_youtube', true)")
    as_worker.execute("DELETE FROM blocklist")
    # Real fetch_gates (no fake for fetch_paused / is_blocklisted); only the network edge is armed.
    monkeypatch.setattr(
        downloader.ytdlp_client, "fetch_audio_file", lambda url: pytest.fail("fetched while paused")
    )
    monkeypatch.setattr(
        downloader.cobalt_client,
        "fetch_audio_file",
        lambda url: pytest.fail("cobalt while paused"),
        raising=False,
    )
    with pytest.raises(FetchPausedError):
        downloader.download_audio(URL, JOB)


def test_a_disengaged_fetch_youtube_row_does_not_pause(as_worker):
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_youtube', false)")
    assert fetch_gates.fetch_paused() is None


# 4 ------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "delete_sql",
    [
        pytest.param("DELETE FROM kill_switches WHERE scope = 'fetch_global'", id="one-row"),
        pytest.param("DELETE FROM kill_switches", id="every-row-zero-rows-after"),
    ],
)
def test_deleting_an_engaged_row_releases_the_brake_after_the_ttl(
    as_worker, monkeypatch, delete_sql
):
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_global', true)")
    assert fetch_gates.fetch_paused() == "fetch_global"

    as_worker.execute(delete_sql)
    assert fetch_gates.fetch_paused() == "fetch_global"  # still cached inside the TTL
    _advance(monkeypatch, 31)
    assert fetch_gates.fetch_paused() is None  # row gone -> released
    assert fetch_gates.fetch_paused() is None


# 5 ------------------------------------------------------------------------------------------
def test_statement_timeout_constant_is_two_seconds():
    assert getattr(fetch_gates, "KILL_SWITCH_STATEMENT_TIMEOUT_MS", None) == int(TIMEOUT_S * 1000)


def _hold_exclusive_lock(release_after_s: float):
    """Hold ACCESS EXCLUSIVE on kill_switches from a second connection; a timer releases it so
    that a regression makes the test FAIL on elapsed time instead of hanging."""
    holder = psycopg.connect(DB)
    holder.execute("LOCK TABLE kill_switches IN ACCESS EXCLUSIVE MODE")
    released = threading.Event()

    def release():
        if not released.is_set():
            released.set()
            holder.rollback()
            holder.close()

    timer = threading.Timer(release_after_s, release)
    timer.start()
    return release, timer


def test_gate_read_is_bounded_by_the_statement_timeout_when_the_table_is_locked(as_worker, capsys):
    release, timer = _hold_exclusive_lock(release_after_s=8.0)
    try:
        capsys.readouterr()
        t0 = time.monotonic()
        result = fetch_gates.fetch_paused()
        elapsed = time.monotonic() - t0
    finally:
        timer.cancel()
        release()

    assert result is None  # fail open for global/youtube with nothing cached
    # ONE refresh per fetch_paused() call: ~2.0 s of timeout + connect, never 4 s (two reads).
    assert TIMEOUT_S - 0.2 <= elapsed < TIMEOUT_S + 1.0, f"returned after {elapsed:.2f}s"
    warns = _named(_events(capsys), "kill_switch_read_failed")
    assert warns and "statement timeout" in warns[0]["detail"]["error"]


def test_a_slow_gate_read_does_not_serialise_a_second_caller(as_worker):
    release, timer = _hold_exclusive_lock(release_after_s=8.0)
    done: dict[str, float] = {}

    def call(name: str) -> None:
        fetch_gates.fetch_paused()
        done[name] = time.monotonic() - t0

    try:
        t0 = time.monotonic()
        a = threading.Thread(target=call, args=("a",))
        a.start()
        time.sleep(0.5)  # B arrives while A's read is blocked on the lock
        b = threading.Thread(target=call, args=("b",))
        b.start()
        a.join(15)
        b.join(15)
    finally:
        timer.cancel()
        release()

    assert set(done) == {"a", "b"}, f"threads did not finish: {done}"
    # Parallel: A ends ~2.0 s, B (arrived 0.5 s later) ends ~2.5 s. Serialised behind A's
    # lock, B could not even start its own read until ~2.0 s and would end ~4.0 s.
    assert done["b"] < TIMEOUT_S + 0.5 + 0.7, f"B finished at {done['b']:.2f}s: serialised behind A"
