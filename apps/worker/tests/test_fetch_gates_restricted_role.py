"""Kill-switch read through a NOSUPERUSER role that is a MEMBER of the production role.

Why this file exists. CI connects as POSTGRES_USER `stemloops`, the container SUPERUSER, which
bypasses both table grants and row-level security. `test_fetch_gates_db.py` therefore cannot
see a missing GRANT or a dropped policy: the read just works. Here the worker reads through
`ks_probe`, a NOSUPERUSER NOBYPASSRLS login role that is a MEMBER of `stemloops_app` (the role
migration 011 grants CRUD to and attaches the `stemloops_app_all` policy to), so the grants and
the policy are in the path. A superuser connection (`admin`) is used only to arrange state.

WHAT MEMBERSHIP DOES AND DOES NOT REPRODUCE. `ks_probe` is not `stemloops_app`: production's
worker logs in AS `stemloops_app` (migration 011 says it exists there as LOGIN; not verified from
here). Membership is faithful for GRANTs and RLS policies, which are inherited. It is NOT
faithful for anything keyed to the LOGIN role's NAME, because `"$user"` in search_path resolves
to the login role: a schema named `stemloops_app` is invisible to `ks_probe`, whose `$user` is
`ks_probe`. That is why the schema-shadowing test names its schema after `ks_probe`.

It also drives `fetch_youtube` through the REAL database read. `test_fetch_chain.py` fakes
`fetch_paused()` and parametrizes the scope name through the fake, so the string "fetch_youtube"
never reaches SQL there: the switch could be disconnected with that suite green.

Local throwaway DB only (the fixtures create a cluster-level role and alter grants/policies).
"""

from __future__ import annotations

import contextlib
import json
import os
import threading
import time
import types

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from worker import downloader
from worker.downloader import fetch_gates
from worker.errors import FetchPausedError, VideoBlocklistedError


def _is_local(dsn: str) -> bool:
    """True only if every host in the DSN is loopback or a unix socket. Parsed, not substring-
    matched: `postgresql://u:localhost@db.example.com/x` contains "localhost" and is remote."""
    hosts = [h for h in (conninfo_to_dict(dsn).get("host") or "").split(",") if h]
    return all(h in ("localhost", "127.0.0.1", "::1") or h.startswith("/") for h in hosts)


DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")
if DB and not _is_local(DB):
    if os.environ.get("CI"):
        # A silent skip here would drop all of these tests the day CI's database hostname stops
        # being loopback. In CI that must be loud: fail collection.
        raise RuntimeError(
            "test_fetch_gates_restricted_role.py: DATABASE_URL is not loopback but CI is set; "
            "these tests alter roles/grants/policies and would be silently skipped. Point CI at "
            "a loopback database or change this guard on purpose."
        )
    pytestmark = pytest.mark.skip(reason="alters roles/grants/policies; local DB only")

ROLE = "ks_probe"
ROLE_PW = "ks_probe_pw"  # throwaway local role; never a real credential
URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
JOB = "11111111-1111-1111-1111-111111111111"


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


def _drop_role(c) -> None:
    """DROP OWNED BY first: a plain DROP ROLE fails with DependentObjectsStillExist while the
    role still holds the CONNECT grant (and owns any schema a shadow test left behind)."""
    if c.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (ROLE,)).fetchone():
        c.execute(f"DROP OWNED BY {ROLE}")
        c.execute(f"DROP ROLE {ROLE}")


@pytest.fixture(scope="module")
def restricted_url():
    """Create the NOSUPERUSER role once and hand back a conninfo string for it."""
    with psycopg.connect(DB, autocommit=True) as c:
        _drop_role(c)  # a leftover from an aborted run still holds a CONNECT grant
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
        _drop_role(c)


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
    """Point the gate at the restricted role: a MEMBER of the role the Fly worker logs in as."""
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
    # A healthy, fast read over the three known scopes is silent: the new diagnostics must not
    # fire here, or they would be noise an operator learns to ignore.
    assert not _named(ev, "kill_switch_unknown_scope")
    assert not _named(ev, "kill_switch_read_slow")
    assert not _named(ev, "kill_switch_read_resumed")


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


def test_one_failed_read_is_retried_by_the_next_call(as_worker, capsys):
    """A failed read must not be stamped as a refresh. If it were, ONE blip would keep an
    engaged brake off for a whole TTL (30 s) after the table became readable again."""
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_global', true)")
    as_worker.execute("REVOKE SELECT ON kill_switches FROM stemloops_app")
    fetch_gates.reset_cache()
    capsys.readouterr()

    assert fetch_gates.fetch_paused() is None  # the blip: cold cache, read fails, fails open
    # ONE failing read for the whole call (not one per scope), and it was logged.
    assert len(_named(_events(capsys), "kill_switch_read_failed")) == 1

    as_worker.execute("GRANT SELECT ON kill_switches TO stemloops_app")  # the database recovers
    # No time advances. The very next call must read again and see the engaged row.
    assert fetch_gates.fetch_paused() == "fetch_global"


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
# The gate read and what bounds it. This gate fails OPEN for fetch_global/fetch_youtube, so a read
# that gives up converts a locked table into a released brake. WHICH TEST COVERS WHAT, and what
# nothing covers:
#
#   test_the_gate_read_runs_with_no_server_side_timer   covers ONE property: the server-side
#       GUCs statement_timeout, lock_timeout and idle_in_transaction_session_timeout (plus
#       transaction_timeout on PostgreSQL 17+, which this box cannot run) are 0 in the read's OWN
#       transaction at the moment of the SELECT, whether the code or the role/database default
#       tried to set them. It asks the server (current_setting), so a comment or string cannot
#       satisfy it. It also proves the reset is transaction-scoped (SET LOCAL, not SET).
#       It does NOT observe a CLIENT-SIDE bound.
#   test_a_locked_table_delays_an_engaged_global_brake_it_does_not_release_it   covers the
#       END-TO-END BEHAVIOUR only below BLOCKED_FOR_S: a blocked reader is still waiting after
#       3.5 s and answers 'fetch_global' once the lock clears. It is a wall-clock test.
#
#   NOT COVERED BY ANY TEST: a client-side bound longer than BLOCKED_FOR_S (3.5 s). Measured at
#       39a6d7d, PostgreSQL 16.15, NOSUPERUSER NOBYPASSRLS member of stemloops_app, fetch_global
#       engaged, cold cache, ACCESS EXCLUSIVE held 6 s (temporary patch of _read_switches, not
#       committed): a client-side cancel at 4.0 s around the SELECT (a daemon thread waiting on an
#       Event, then conn.cancel()) left all 40 tests in this file passing, and fetch_paused()
#       returned None (fetch allowed) after 4.014, 4.020 and 4.013 s in three runs. The form of
#       the patch matters: the same bound written as threading.Timer(4.0, conn.cancel) fails 7
#       tests in this file, but only incidentally (fake connections with no .cancel, tests that
#       replace threading.Timer), not because any of them observes a client-side bound. An
#       earlier note here recorded 4.016 s "reported by the reviewer" and 4.012 s "reproduced" at
#       a round-4 head; neither was re-observed, and the figures above replace them. The GUC
#       probe cannot see a client-side bound (the server is never asked for a timer) and the
#       wall-clock test stops watching at 3.5 s. This file does not close that and does not
#       pretend to; a longer wall-clock wait would be another timer to tune, not a proof of
#       "unbounded".
BLOCKED_FOR_S = 3.5  # longer than the 2 s cap an earlier revision of this PR put on the read
# (a client-side bound of 4 s or more passes everything below: see the section comment above)


def _wait_until_a_reader_is_blocked_on_the_lock(admin, timeout_s: float = 10.0) -> None:
    """Block until a backend is waiting on a heavyweight lock in a kill_switches query, so the
    test knows the gate's read has really reached the lock (not failed to connect)."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        row = admin.execute(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
            "AND query ILIKE '%kill_switches%' AND pid <> pg_backend_pid()"
        ).fetchone()
        if row:
            return
        time.sleep(0.05)
    pytest.fail("the gate's read never blocked on the table lock")


@contextlib.contextmanager
def _inherited(admin, setting):
    """Give every NEW session of ks_probe a server-side timer it did not ask for.

    `setting` is None or (level, guc, value), level ROLE or DATABASE: exactly what an operator, or
    the platform's own global default, does with ALTER ROLE / ALTER DATABASE ... SET."""
    if setting is None:
        yield
        return
    level, guc, value = setting
    target = f'DATABASE "{admin.info.dbname}"' if level == "DATABASE" else f"ROLE {ROLE}"
    admin.execute(f"ALTER {target} SET {guc} = '{value}'")
    try:
        yield
    finally:
        admin.execute(f"ALTER {target} RESET {guc}")


# The server-side timers the gate read must run without. transaction_timeout exists only on
# PostgreSQL 17+ (naming it earlier is an error), so it is observed only where it exists.
_TIMER_GUCS = ("statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout")
_PG17 = 170000


def _timer_gucs(server_version: int) -> tuple:
    return _TIMER_GUCS + (("transaction_timeout",) if server_version >= _PG17 else ())


def _timers_sql(server_version: int) -> str:
    return "SELECT " + ", ".join(f"current_setting('{g}')" for g in _timer_gucs(server_version))


# (level, guc, value) or None. Each inherited case is verified to be in force before it is used.
INHERITED = [
    pytest.param(None, id="nothing-inherited"),
    pytest.param(("ROLE", "statement_timeout", "2s"), id="role-statement_timeout-2s"),
    pytest.param(("ROLE", "lock_timeout", "2s"), id="role-lock_timeout-2s"),
    pytest.param(("DATABASE", "statement_timeout", "2s"), id="database-statement_timeout-2s"),
    pytest.param(("DATABASE", "lock_timeout", "2s"), id="database-lock_timeout-2s"),
    # '1h', not a few ms: this test checks what the SESSION INHERITS at the SELECT, and an
    # idle timer small enough to fire would kill the test's own connections between statements.
    pytest.param(
        ("ROLE", "idle_in_transaction_session_timeout", "1h"), id="role-idle_in_transaction-1h"
    ),
    pytest.param(
        ("DATABASE", "idle_in_transaction_session_timeout", "1h"),
        id="database-idle_in_transaction-1h",
    ),
]


@pytest.mark.parametrize("setting", INHERITED)
def test_the_gate_read_runs_with_no_server_side_timer(
    as_worker, restricted_url, monkeypatch, setting
):
    """Behavioural, not a source grep: route the gate's OWN `_connect()` through a
    psycopg.Connection subclass that, immediately before the kill_switches SELECT, asks THAT
    transaction for its server-side timers (statement_timeout, lock_timeout,
    idle_in_transaction_session_timeout, and transaction_timeout where the server has it). A
    comment or a string containing `SET LOCAL` cannot satisfy this; a server-side timer of any
    size, written into the code or inherited from the role or database, cannot pass it.

    SCOPE: these GUCs and nothing else. A CLIENT-SIDE bound (a Timer calling conn.cancel(), a
    socket timeout) never reaches the server as a setting, so this test cannot see one."""
    seen: dict = {"in_read": [], "after": []}

    class Probe(psycopg.Connection):
        def _timers(self) -> tuple:
            sql = _timers_sql(self.info.server_version)
            return tuple(psycopg.Connection.execute(self, sql).fetchone())

        def execute(self, query, params=None, **kw):
            if "kill_switches" in str(query):
                seen["in_read"].append(self._timers())
                self._was_a_gate_read = True
            return super().execute(query, params, **kw)

        def close(self):
            if not self.closed and getattr(self, "_was_a_gate_read", False):
                seen["after"].append(self._timers())  # after commit: has the reset leaked?
            super().close()

    with _inherited(as_worker, setting):
        with psycopg.connect(restricted_url) as plain:  # positive control: the timer IS inherited
            version = plain.info.server_version
            gucs = _timer_gucs(version)
            inherited = tuple(plain.execute(_timers_sql(version)).fetchone())
        zeros = ("0",) * len(gucs)
        assert (inherited == zeros) == (setting is None), inherited
        if setting is not None:
            assert inherited[gucs.index(setting[1])] == setting[2], inherited

        monkeypatch.setattr(fetch_gates, "psycopg", types.SimpleNamespace(connect=Probe.connect))
        fetch_gates.reset_cache()
        fetch_gates.fetch_paused()

    assert seen["in_read"] == [zeros], (
        f"the gate read ran under a server-side timer {gucs}: {seen['in_read']}; "
        f"this session inherits {inherited}"
    )
    # SET LOCAL, not SET: once the read is done the connection is back to what it inherited, so
    # nothing leaks into a pooled connection's next user.
    assert seen["after"] == [inherited], f"the timer reset leaked past the transaction: {seen}"


class _FakeConn:
    """Records the statements the gate sends. NOT a database: it pins which statements are SENT
    for a given server_version. That a real PostgreSQL 17 accepts and honours
    `SET LOCAL transaction_timeout = 0` is NOT tested anywhere (only 16 was available)."""

    def __init__(self, server_version: int, sent: list):
        self.info = types.SimpleNamespace(server_version=server_version)
        self._sent = sent

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, query, params=None):
        self._sent.append(query)
        return types.SimpleNamespace(fetchall=lambda: [("fetch_global", True)])


@pytest.mark.parametrize(
    "version, sends_it",
    [(160015, False), (169999, False), (170000, True), (170004, True)],
)
def test_transaction_timeout_is_cleared_only_where_the_server_has_it(
    monkeypatch, version, sends_it
):
    """Naming transaction_timeout on PostgreSQL 16 is an ERROR, and an error in the gate read
    fails OPEN. So it must be sent at 170000 and above and never below. On this box the 16 side
    is also covered by the probe test above against a real server (ungating it would error there
    and release the brake); the 17 side is covered ONLY by this recording fake."""
    sent: list = []
    monkeypatch.setattr(fetch_gates, "_connect", lambda: _FakeConn(version, sent))
    assert fetch_gates._read_switches() == [("fetch_global", True)]
    assert ("SET LOCAL transaction_timeout = 0" in sent) is sends_it, sent
    for always in (
        "SET LOCAL statement_timeout = 0",
        "SET LOCAL lock_timeout = 0",
        "SET LOCAL idle_in_transaction_session_timeout = 0",
    ):
        assert always in sent, sent
    assert "kill_switches" in sent[-1], sent  # every reset precedes the SELECT
    # The idle timer fires BETWEEN statements and is inherited from BEGIN until this SET LOCAL
    # runs, so every statement sent before it is another idle gap it can fire in (see the
    # RESIDUAL note in _read_switches). It must therefore be the first statement sent.
    assert sent[0] == "SET LOCAL idle_in_transaction_session_timeout = 0", sent


@pytest.mark.parametrize(
    "setting",
    [
        pytest.param(None, id="nothing-inherited"),
        pytest.param(("ROLE", "statement_timeout", "1s"), id="role-statement_timeout-1s"),
        pytest.param(("ROLE", "lock_timeout", "1s"), id="role-lock_timeout-1s"),
    ],
)
def test_a_locked_table_delays_an_engaged_global_brake_it_does_not_release_it(
    as_worker, capsys, setting
):
    """fetch_global is ENGAGED in the table and the cache is cold. An operator holds ACCESS
    EXCLUSIVE on the table. The gate must still be waiting after BLOCKED_FOR_S, and once the
    lock clears it must report the brake. With a 2 s statement timeout it returned None
    (fetch allowed) after ~2 s: a slow table turned into a released brake. Also under a timer
    the role INHERITS (what the previous revision still failed open on)."""
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_global', true)")
    fetch_gates.reset_cache()
    capsys.readouterr()

    with _inherited(as_worker, setting):
        holder = psycopg.connect(DB)
        holder.execute("LOCK TABLE kill_switches IN ACCESS EXCLUSIVE MODE")
        out: dict = {}

        def call() -> None:
            out["result"] = fetch_gates.fetch_paused()

        caller = threading.Thread(target=call)
        try:
            caller.start()
            _wait_until_a_reader_is_blocked_on_the_lock(as_worker)
            time.sleep(BLOCKED_FOR_S)
            still_waiting = caller.is_alive()
        finally:
            holder.rollback()  # always release, so a regression fails instead of hanging
            holder.close()
            caller.join(20)

    assert still_waiting, f"gate gave up on a locked table within {BLOCKED_FOR_S}s: {out}"
    assert not caller.is_alive(), "gate did not return after the lock was released"
    assert out["result"] == "fetch_global"
    assert not _named(_events(capsys), "kill_switch_read_failed")


def test_a_stalled_read_says_so_while_it_waits_and_when_it_resumes(as_worker, monkeypatch, capsys):
    """The read has no timeout, so a locked table silences the worker. The operator must see WHY
    while it is happening (kill_switch_read_slow, logged by a timer that only logs), not only
    afterwards. The timer must not shorten the wait: the brake still answers once the lock clears.
    """
    monkeypatch.setattr(fetch_gates, "KILL_SWITCH_READ_SLOW_S", 0.5)
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_global', true)")
    fetch_gates.reset_cache()
    capsys.readouterr()

    holder = psycopg.connect(DB)
    holder.execute("LOCK TABLE kill_switches IN ACCESS EXCLUSIVE MODE")
    out: dict = {}
    caller = threading.Thread(target=lambda: out.update(result=fetch_gates.fetch_paused()))
    try:
        caller.start()
        _wait_until_a_reader_is_blocked_on_the_lock(as_worker)
        time.sleep(1.5)  # three times the threshold, lock still held
        while_blocked = _events(capsys)
        still_waiting = caller.is_alive()
    finally:
        holder.rollback()
        holder.close()
        caller.join(20)

    assert still_waiting, "the read gave up while the table was locked"
    slow = _named(while_blocked, "kill_switch_read_slow")
    assert len(slow) == 1 and slow[0]["level"] == "WARN", while_blocked  # said so WHILE stalled
    assert not _named(while_blocked, "kill_switch_read_resumed")  # not resumed yet
    assert out["result"] == "fetch_global"
    after = _events(capsys)
    resumed = _named(after, "kill_switch_read_resumed")
    assert len(resumed) == 1 and resumed[0]["detail"]["waited_s"] >= 1.5, after
    assert not _named(after, "kill_switch_read_slow")  # one line per stalled read, not a stream
    assert not _named(after, "kill_switch_read_failed")


def _no_thread(*_a, **_k):
    raise RuntimeError("can't start new thread")  # what CPython raises at a thread/memory limit


@pytest.mark.parametrize(
    "fault, log_also_fails",
    [
        pytest.param(_no_thread, False, id="RuntimeError-cant-start-new-thread"),
        pytest.param(MemoryError("out of memory"), False, id="MemoryError"),
        pytest.param(_no_thread, True, id="RuntimeError-and-the-log-line-fails-too"),
    ],
)
def test_a_log_timer_that_cannot_start_does_not_skip_the_read(
    as_worker, monkeypatch, capsys, fault, log_also_fails
):
    """The slow-read log timer is a convenience; the read is the gate. Round 3 started the timer
    INSIDE the read's try, so a thread that could not start was handled as a FAILED READ and the
    table was never queried: fetch_global engaged, database healthy, cold cache, and
    fetch_paused() answered None (fetch allowed) after 0.000 s. The brake was released by the
    mitigation meant to make the stall visible. Must hold: the read still runs and answers."""
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_global', true)")
    fetch_gates.reset_cache()

    # Positive control: the fault is in force, i.e. a Timer really cannot start here.
    def boom(self):
        if isinstance(fault, BaseException):
            raise fault
        fault()

    monkeypatch.setattr(threading.Timer, "start", boom)
    with pytest.raises((RuntimeError, MemoryError)):
        threading.Timer(60, lambda: None).start()

    if log_also_fails:
        real_log = fetch_gates.log_structured

        def log(level, event, **kw):
            if event == "kill_switch_slow_timer_unavailable":
                raise OSError("stderr is gone")
            return real_log(level, event, **kw)

        monkeypatch.setattr(fetch_gates, "log_structured", log)

    reads = {"n": 0}
    real_read = fetch_gates._read_switches

    def counted():
        reads["n"] += 1
        return real_read()

    monkeypatch.setattr(fetch_gates, "_read_switches", counted)
    capsys.readouterr()

    try:
        result = fetch_gates.fetch_paused()
    except Exception as exc:  # noqa: BLE001 — a raise out of the gate is a named failure too
        pytest.fail(f"fetch_paused() raised {exc!r} instead of answering (reads: {reads['n']})")
    assert result == "fetch_global", (
        "a log timer that could not start released an engaged brake "
        f"(table reads performed: {reads['n']})"
    )
    assert reads["n"] == 1, "the table was never queried"
    ev = _events(capsys)
    assert not _named(ev, "kill_switch_read_failed"), "a healthy read was reported as failed"
    if not log_also_fails:
        assert len(_named(ev, "kill_switch_slow_timer_unavailable")) == 1, ev


# Unknown scopes. `scope` is free text with no CHECK (migration 008).
TYPOS = ["Fetch_Global", "fetch_global ", "fetch-global", "global", "fetch_all"]


@pytest.mark.parametrize("scope", TYPOS, ids=[repr(t) for t in TYPOS])
def test_an_engaged_row_under_a_mistyped_scope_pauses_nothing_and_is_named_in_a_warn(
    as_worker, capsys, scope
):
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES (%s, true)", (scope,))
    fetch_gates.reset_cache()
    capsys.readouterr()

    # Pins today's decision: the operator believes the brake is pulled and it is not.
    assert fetch_gates.fetch_paused() is None

    ev = _events(capsys)
    warn = _named(ev, "kill_switch_unknown_scope")
    assert len(warn) == 1 and warn[0]["level"] == "WARN", ev
    assert warn[0]["detail"]["scopes"] == [scope]  # the exact spelling, trailing space and all
    assert not _named(ev, "kill_switch_table_empty")  # the read was non-empty: this is the hole


def test_unknown_scopes_are_all_named_once_per_ttl_and_known_ones_never(
    as_worker, monkeypatch, capsys
):
    for scope in TYPOS:
        as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES (%s, true)", (scope,))
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_youtube', false)")
    fetch_gates.reset_cache()
    capsys.readouterr()

    for _ in range(25):
        assert fetch_gates.fetch_paused() is None
    warn = _named(_events(capsys), "kill_switch_unknown_scope")
    assert len(warn) == 1
    assert warn[0]["detail"]["scopes"] == sorted(TYPOS)  # fetch_youtube / fetch_cobalt not named
    assert warn[0]["detail"]["count"] == len(TYPOS)

    _advance(monkeypatch, 31)
    fetch_gates.fetch_paused()
    assert len(_named(_events(capsys), "kill_switch_unknown_scope")) == 1  # next TTL, next line


# 6 ------------------------------------------------------------------------------------------
# Concurrency of the refresh. The consumer runs one job at a time today, so these pin the
# structure rather than a live hazard: ONE read in flight at a time, and a reset wins.
def test_concurrent_cold_callers_share_one_read_and_one_log_line(as_worker, monkeypatch, capsys):
    as_worker.execute("DROP POLICY stemloops_app_all ON kill_switches")  # zero rows -> logs
    fetch_gates.reset_cache()
    capsys.readouterr()

    real = fetch_gates._read_switches
    seen = {"calls": 0, "live": 0, "max_live": 0}
    guard = threading.Lock()

    def spy():
        with guard:
            seen["calls"] += 1
            seen["live"] += 1
            seen["max_live"] = max(seen["max_live"], seen["live"])
        try:
            time.sleep(0.3)  # keep the read open long enough for the others to arrive
            return real()
        finally:
            with guard:
                seen["live"] -= 1

    monkeypatch.setattr(fetch_gates, "_read_switches", spy)
    n = 12
    barrier = threading.Barrier(n)
    results: list = []

    def call() -> None:
        barrier.wait()
        results.append(fetch_gates.fetch_paused())

    threads = [threading.Thread(target=call) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)

    assert results == [None] * n
    assert seen["calls"] == 1, f"{seen['calls']} reads for {n} simultaneous cold callers"
    assert seen["max_live"] == 1
    assert len(_named(_events(capsys), "kill_switch_table_empty")) == 1


def test_a_reset_during_an_in_flight_read_is_not_overwritten_by_it(as_worker, monkeypatch):
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_global', true)")
    fetch_gates.reset_cache()
    real = fetch_gates._read_switches
    snapshot_taken = threading.Event()
    release = threading.Event()

    def slow():
        rows = real()  # the snapshot predates the reset below
        snapshot_taken.set()
        release.wait(10)
        return rows

    monkeypatch.setattr(fetch_gates, "_read_switches", slow)
    reader = threading.Thread(target=fetch_gates.fetch_paused)
    reader.start()
    assert snapshot_taken.wait(10)
    resetter = threading.Thread(target=fetch_gates.reset_cache)
    resetter.start()
    time.sleep(0.3)  # let the reset run if it is going to run now
    release.set()
    reader.join(10)
    resetter.join(10)

    assert (
        fetch_gates._cache_at is None and fetch_gates._cache == {}
    ), "an in-flight read repopulated the cache from its pre-reset snapshot"


# 7 ------------------------------------------------------------------------------------------
# Schema shadowing. `"$user"` in search_path is the LOGIN role, so the shadow is named after
# ks_probe (the login role). A schema named `stemloops_app` would NOT shadow for a member role.
@contextlib.contextmanager
def _shadow_schema(admin, *tables):
    """A schema named after the login role, owned by it, holding EMPTY copies of `tables`. For
    ks_probe an unqualified name now resolves here before public. Needs a privileged actor to
    create (stemloops_app has no CREATE on the database or on public), hence low likelihood."""
    admin.execute(f"CREATE SCHEMA {ROLE} AUTHORIZATION {ROLE}")
    try:
        for t in tables:
            admin.execute(
                f"CREATE TABLE {ROLE}.{t} (LIKE public.{t} INCLUDING DEFAULTS INCLUDING IDENTITY)"
            )
            admin.execute(f"ALTER TABLE {ROLE}.{t} OWNER TO {ROLE}")
        yield
    finally:
        admin.execute(f"DROP SCHEMA IF EXISTS {ROLE} CASCADE")


def test_a_schema_named_after_the_login_role_does_not_shadow_the_gate_table(
    as_worker, restricted_url, capsys
):
    as_worker.execute("INSERT INTO kill_switches(scope, enabled) VALUES ('fetch_global', true)")
    with _shadow_schema(as_worker, "kill_switches"):
        as_worker.execute(
            f"INSERT INTO {ROLE}.kill_switches(scope, enabled) VALUES ('fetch_cobalt', false)"
        )

        # Positive control: an UNQUALIFIED name really does resolve to the shadow for this role,
        # otherwise the assertion below would hold for any broken setup.
        with psycopg.connect(restricted_url) as r:
            assert r.execute("SELECT scope FROM kill_switches").fetchall() == [("fetch_cobalt",)]

        fetch_gates.reset_cache()
        capsys.readouterr()
        assert fetch_gates.fetch_paused() == "fetch_global"
        # The shadow holds a row, so it reads as non-empty: the zero-row diagnostic would not
        # have fired. The `public.` qualification is the only thing that closes this.
        assert not _named(_events(capsys), "kill_switch_table_empty")


BLOCKED_ID = "dQw4w9WgXcQ"  # the id in URL


def test_a_shadow_blocklist_does_not_bypass_a_takedown(as_worker, restricted_url, monkeypatch):
    """is_blocklisted is the one FAIL-CLOSED path and it logged nothing when bypassed. Measured at
    39a6d7d, PostgreSQL 16.15, with is_blocklisted temporarily reverted to the unqualified
    `FROM blocklist` (the form at eadcf8e; 05042e8 qualified it): control (no shadow) True; with an
    empty shadow blocklist False, and download_audio went on to call the fetcher with the
    blocklisted id (this test fails on that revert at its first assertion after the shadow is
    created). With the qualified read at 39a6d7d: True, VideoBlocklistedError, fetcher not called.
    """
    as_worker.execute(
        "INSERT INTO public.blocklist(video_id, reason) VALUES (%s, 'takedown') "
        "ON CONFLICT DO NOTHING",
        (BLOCKED_ID,),
    )
    fetched: list = []
    monkeypatch.setattr(
        downloader.ytdlp_client, "fetch_audio_file", lambda url: fetched.append(url) or "/x"
    )
    monkeypatch.setattr(
        downloader.cobalt_client,
        "fetch_audio_file",
        lambda url: fetched.append(url),
        raising=False,
    )
    try:
        assert fetch_gates.is_blocklisted(BLOCKED_ID) is True  # control: no shadow

        with _shadow_schema(as_worker, "blocklist"):
            # Positive control: unqualified, ks_probe really reads the (empty) shadow.
            with psycopg.connect(restricted_url) as r:
                assert (
                    r.execute("SELECT 1 FROM blocklist WHERE video_id=%s", (BLOCKED_ID,)).fetchone()
                    is None
                )

            assert fetch_gates.is_blocklisted(BLOCKED_ID) is True
            with pytest.raises(VideoBlocklistedError):
                downloader.download_audio(URL, JOB)
            assert fetched == [], f"the fetcher ran for a blocklisted id: {fetched}"
    finally:
        as_worker.execute("DELETE FROM public.blocklist WHERE video_id = %s", (BLOCKED_ID,))


def test_a_shadow_fetch_attempts_does_not_divert_the_audit_rows(as_worker, restricted_url):
    """A faithful shadow copy of fetch_attempts would swallow every audit row with no error."""
    kw = dict(job_id=JOB, attempt=1, path="ytdlp_direct", outcome_class="ok", ms_total=5)
    count = "SELECT count(*) FROM {}.fetch_attempts WHERE job_id = %s"
    as_worker.execute("DELETE FROM public.fetch_attempts WHERE job_id = %s", (JOB,))
    try:
        with _shadow_schema(as_worker, "fetch_attempts"):
            # Positive control: an unqualified INSERT as this role lands in the shadow.
            with psycopg.connect(restricted_url) as r:
                r.execute(
                    "INSERT INTO fetch_attempts(job_id, attempt, path, outcome_class) "
                    "VALUES (%s, 9, 'control', 'ok')",
                    (JOB,),
                )
            assert as_worker.execute(count.format(ROLE), (JOB,)).fetchone() == (1,)
            assert as_worker.execute(count.format("public"), (JOB,)).fetchone() == (0,)
            as_worker.execute(f"DELETE FROM {ROLE}.fetch_attempts")

            fetch_gates.log_attempt(video_id=BLOCKED_ID, **kw)

            assert as_worker.execute(count.format("public"), (JOB,)).fetchone() == (1,)
            assert as_worker.execute(count.format(ROLE), (JOB,)).fetchone() == (0,)
    finally:
        as_worker.execute("DELETE FROM public.fetch_attempts WHERE job_id = %s", (JOB,))
