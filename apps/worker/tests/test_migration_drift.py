"""Tests for the code-to-schema drift gate (scripts/check_migration_drift.py).

The gate exists because nothing compared applied migrations against required
ones, which is how production sat 23 migrations behind the code for days
(R-1, L34, seam class 6). These tests pin the two properties that make it
worth having:

  1. it detects the R-1 shape, and
  2. it does NOT report success when it could not actually check.

Property 2 is the one that matters most. A drift gate that silently skips is
worse than no gate: it produces a green tick a reader trusts. `seam-inventory`
Part 4 lists exactly that failure in a sibling script.
"""

from __future__ import annotations

import contextlib
import importlib.util
import os
import sys
import types
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCRIPT = _REPO_ROOT / "scripts" / "check_migration_drift.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("check_migration_drift", _SCRIPT)
    assert spec and spec.loader, f"cannot load {_SCRIPT}"
    mod = importlib.util.module_from_spec(spec)
    sys.modules["check_migration_drift"] = mod
    spec.loader.exec_module(mod)
    return mod


drift_mod = _load_module()


# --------------------------------------------------------------------------
# discovery: ONE definition, owned by migrate.py and called by the gate
# --------------------------------------------------------------------------


def test_discovery_matches_the_runner_and_excludes_down(tmp_path: Path):
    (tmp_path / "down").mkdir()
    for name in ("001_a.sql", "011_c.sql", "009_b.sql"):
        (tmp_path / name).write_text("-- x")
    # down/ must NOT be picked up: the runner's glob is top-level only.
    (tmp_path / "down" / "009_b_down.sql").write_text("-- x")
    # non-.sql must not be picked up either
    (tmp_path / "README.md").write_text("notes")

    found = drift_mod.discover_repo_migrations(tmp_path)
    assert found == ["001_a.sql", "009_b.sql", "011_c.sql"], (
        "discovery must be top-level *.sql, lexically sorted — the same set and "
        "order the migration runner uses"
    )


def test_discovery_sees_the_real_repo_migrations():
    found = drift_mod.discover_repo_migrations(_REPO_ROOT / "apps" / "worker" / "migrations")
    assert found, "no migrations discovered in the real repo"
    assert found[0].startswith("001_"), found[:3]
    assert all(f.endswith(".sql") for f in found)
    assert not any("_down" in f for f in found), "down files must not be included"


# --------------------------------------------------------------------------
# the comparison
# --------------------------------------------------------------------------


def test_no_drift_when_everything_is_applied():
    repo = ["001_a.sql", "002_b.sql"]
    d = drift_mod.diff_migrations(repo, {"001_a.sql", "002_b.sql"})
    assert d.missing == []
    assert d.extra == []
    assert d.has_drift is False


def test_detects_the_r1_shape():
    """Production on 008 while the code requires 031 — the real incident."""
    repo = [f"{i:03d}_m.sql" for i in list(range(1, 10)) + list(range(11, 32))]
    applied = {f"{i:03d}_m.sql" for i in range(1, 9)}  # 001..008
    d = drift_mod.diff_migrations(repo, applied)
    assert d.has_drift is True
    assert len(d.missing) == 22, d.missing
    assert "009_m.sql" in d.missing
    assert "031_m.sql" in d.missing
    assert "010_m.sql" not in d.missing, "there is no 010; it must not be invented"


def test_extra_applied_migration_is_reported_but_not_a_blocker():
    """A ledger row this checkout lacks is worth saying, but does not block."""
    d = drift_mod.diff_migrations(["001_a.sql"], {"001_a.sql", "999_future.sql"})
    assert d.extra == ["999_future.sql"]
    assert d.missing == []
    assert d.has_drift is False, "an extra applied migration does not stop this code from running"


def test_a_gap_in_the_middle_is_caught_not_just_a_short_tail():
    d = drift_mod.diff_migrations(
        ["001_a.sql", "002_b.sql", "003_c.sql"], {"001_a.sql", "003_c.sql"}
    )
    assert d.missing == ["002_b.sql"]
    assert d.has_drift is True


# --------------------------------------------------------------------------
# property 2: never report success without having checked
# --------------------------------------------------------------------------


def test_missing_database_url_does_not_exit_zero(monkeypatch, capsys):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    rc = drift_mod.main([])
    assert rc == drift_mod.EXIT_NOT_CHECKED, (
        "no DATABASE_URL is NOT ATTEMPTED (3), its own code -- distinct from "
        "exit 2's attempted-and-failed, so a caller can tolerate one without "
        "tolerating the other. It must never be success: a gate that skips "
        "silently is worse than no gate (seam-inventory Part 4, item 5)"
    )
    assert rc != drift_mod.EXIT_OK
    assert rc != drift_mod.EXIT_BROKEN, (
        "collapsing 'not configured' into 'broken' is what forced the old "
        "in-script forgiving flag to exist, and that flag is where five review "
        "rounds found false greens"
    )


def test_blank_database_url_is_a_misconfiguration_not_an_absence(monkeypatch):
    """Renamed in round 6: "treated as absent" is what the bug WAS. A set-but-
    empty DATABASE_URL means a secret was wired and did not arrive."""
    monkeypatch.setenv("DATABASE_URL", "   ")
    assert drift_mod.main([]) == drift_mod.EXIT_BROKEN


def test_no_flag_on_this_script_turns_any_failure_into_success(monkeypatch, capsys):
    """Replaces test_allow_no_database_is_an_explicit_opt_in_and_warns.

    That flag is gone. Tolerating an unconfigured gate is a CALLER's policy and
    belongs in the workflow file, where a person reviewing CI can see it -- not
    in an argparse option, which is the one place nobody looks. Five rounds of
    review found a false green inside that option, every time by a different
    route, which is the argument for not having it at all.
    """
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert drift_mod.main([]) == drift_mod.EXIT_NOT_CHECKED
    err = capsys.readouterr().err
    assert "NOT CHECKED" in err, "the unattempted path must say so plainly"

    # No argparse option may map a failure to 0. If someone adds one, this
    # fails and they have to read the paragraph above.
    import argparse

    parser_actions = []

    real_add = argparse.ArgumentParser.add_argument

    def record(self, *a, **k):
        parser_actions.extend(x for x in a if isinstance(x, str) and x.startswith("--"))
        return real_add(self, *a, **k)

    monkeypatch.setattr(argparse.ArgumentParser, "add_argument", record)
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@127.0.0.1:5499/d")
    drift_mod.main([])
    forgiving = [f for f in parser_actions if "allow" in f or "ignore" in f or "skip" in f]
    assert not forgiving, (
        f"this script has grown a forgiving flag again: {forgiving}. Tolerance "
        f"is the caller's policy -- see scripts/_gate_exit.py."
    )


def test_unreadable_ledger_is_unknown_not_success(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://nope/nope")
    monkeypatch.setattr(
        drift_mod,
        "fetch_applied",
        lambda _u: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    assert drift_mod.main([]) == drift_mod.EXIT_BROKEN


def test_drift_exits_one(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/x")
    monkeypatch.setattr(drift_mod, "fetch_applied", lambda _u: {"001_jobs.sql"})
    assert drift_mod.main([]) == drift_mod.EXIT_DRIFT


def test_expect_row_count_mismatch_fails(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/x")
    real = drift_mod.discover_repo_migrations(_REPO_ROOT / "apps" / "worker" / "migrations")
    monkeypatch.setattr(drift_mod, "fetch_applied", lambda _u: set(real))
    assert drift_mod.main([]) == drift_mod.EXIT_OK
    assert drift_mod.main(["--expect", str(len(real) + 1)]) == drift_mod.EXIT_DRIFT


# --------------------------------------------------------------------------
# the gate's discovery must track the runner's, not merely resemble it
#
# migrate.py owns discovery; the gate calls it. These tests fail if anyone
# reintroduces a second copy in the gate.
#
# Round 6, defect 10: this comment used to describe a CI step keeping an
# independent `find -maxdepth 1` count. No such step exists on this branch --
# it is on the sibling matrix branch. Exactly the stale-intention comment that
# seam-inventory Part 5 rule 3 forbids, written in the session that wrote the
# rule. If that step lands here, say so then.
# --------------------------------------------------------------------------

_MIGRATE_PY = _REPO_ROOT / "apps" / "worker" / "src" / "worker" / "migrate.py"


def _psycopg_importable() -> bool:
    try:
        import psycopg  # noqa: F401

        return True
    except ImportError:
        return False


@contextlib.contextmanager
def _psycopg_stub_if_missing():
    """Install a psycopg stub for the duration of ONE import, then remove it.

    Review round 3 keyed this on importability rather than on `sys.modules`,
    which fixed half of it. Round 5 found the other half: the stub was
    installed with `sys.modules.setdefault` and never removed, so for the rest
    of the session `pytest.importorskip("psycopg")` FOUND the stub and did not
    skip. Tests then ran against it and failed with
    `No module named 'psycopg.conninfo'; 'psycopg' is not a package` --
    outcome depending on collection order. A stub that outlives its import is
    indistinguishable from the real thing to every later importorskip.
    """
    if _psycopg_importable():
        yield
        return
    stub = types.ModuleType("psycopg")
    stub.connect = lambda *a, **k: None
    stub.OperationalError = type("OperationalError", (Exception,), {})
    sys.modules["psycopg"] = stub
    try:
        yield
    finally:
        # Unconditional: never leave a stub for a later importorskip to find.
        sys.modules.pop("psycopg", None)
        # Round 6, defect 6: popping psycopg was only half of it. `worker.migrate`
        # stays CACHED with the dead stub bound as its `psycopg`, so a later
        # importer gets the stubbed module and results depend on whether
        # _load_runner happened to run first. Evict it too.
        for name in [m for m in sys.modules if m == "worker" or m.startswith("worker.")]:
            sys.modules.pop(name, None)


def _load_runner():
    """Import the real runner, stubbing psycopg only while importing it."""
    src = str(_REPO_ROOT / "apps" / "worker" / "src")
    if src not in sys.path:
        sys.path.insert(0, src)
    with _psycopg_stub_if_missing():
        import worker.migrate as runner

    return runner


def test_gate_and_runner_point_at_the_same_directory():
    runner = _load_runner()
    assert Path(runner.MIGRATIONS_DIR).resolve() == drift_mod.DEFAULT_MIGRATIONS_DIR.resolve()


def test_gate_delegates_discovery_to_the_runner_rather_than_copying_it():
    """The strongest available pin: there is only ONE definition.

    Round 3 defeated the previous "do they agree" test with three mutations
    (append down/, skip a prefix, rewrite to os.walk leaving the old
    expression in a docstring) because the test compared the gate against a
    copy of the glob written in the test, not against what the runner does.
    migrate.py now owns discovery and the gate calls it. This test fails if
    anyone reintroduces a second copy: patch the runner, and the gate's answer
    must change with it.
    """
    runner = _load_runner()
    sentinel = ["/wherever/999_sentinel.sql", "/wherever/001_a.sql"]
    original = runner.discover_migration_paths
    try:
        runner.discover_migration_paths = lambda *a, **k: sentinel
        got = drift_mod.discover_repo_migrations(drift_mod.DEFAULT_MIGRATIONS_DIR)
    finally:
        runner.discover_migration_paths = original
    assert got == ["999_sentinel.sql", "001_a.sql"], (
        "the gate is not calling worker.migrate.discover_migration_paths — "
        "it has its own copy of the discovery logic again"
    )


def test_runner_discovery_is_top_level_only_on_the_real_tree():
    runner = _load_runner()
    names = [Path(x).name for x in runner.discover_migration_paths()]
    assert names, "runner discovered no migrations"
    assert names == sorted(names)
    assert all(n.endswith(".sql") for n in names)
    assert not any("_down" in n for n in names), "down/ leaked into discovery"


# --------------------------------------------------------------------------
# D5: exit 2 must not be forgiven for a reachable database with no ledger
# --------------------------------------------------------------------------


def test_missing_ledger_is_broken_not_unattempted(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/x")

    def _raise(_u):
        raise drift_mod.LedgerMissing("public._migrations does not exist")

    monkeypatch.setattr(drift_mod, "fetch_applied", _raise)
    assert drift_mod.main([]) == drift_mod.EXIT_BROKEN
    assert drift_mod.main([]) == drift_mod.EXIT_BROKEN, (
        "staging's exact shape: tables present, no ledger. This is exit 2 -- "
        "ATTEMPTED AND FAILED, because the database answered and still cannot "
        "say what ran. Not exit 3: something WAS attempted. Nothing forgives it"
    )


def test_a_simulated_connect_failure_is_not_forgiven_by_the_flag(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/x")

    def _raise(_u):
        raise drift_mod.Unreachable("connection refused")

    monkeypatch.setattr(drift_mod, "fetch_applied", _raise)
    assert drift_mod.main([]) == drift_mod.EXIT_BROKEN
    # Round 6: the flag no longer forgives this. A DATABASE_URL was set, so a
    # database was CLAIMED to exist; failing to reach it is a failure, not an
    # absence. Rounds 4-6 each shipped a false green trying to decide which
    # connect failures were benign by reading libpq's message.


def test_reachable_but_unreadable_ledger_is_never_forgiven(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/x")

    def _raise(_u):
        raise PermissionError("permission denied for table _migrations")

    monkeypatch.setattr(drift_mod, "fetch_applied", _raise)
    assert drift_mod.main([]) == drift_mod.EXIT_BROKEN


def test_a_simulated_query_time_failure_is_not_forgiven(monkeypatch):
    """Round 3, N2 again: psycopg.OperationalError has ~92 subclasses and some
    are raised at QUERY time. A lock_timeout cancelling the ledger SELECT was
    reaching the forgiving branch and returning 0 — the database answered and
    we still did not know what was applied. Forgiveness is now keyed on the
    connect PHASE, so a query-time failure cannot reach it however it is
    classed."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/x")

    class LockNotAvailable(Exception):
        """Stands in for psycopg.errors.LockNotAvailable (an OperationalError)."""

    def _raise(_u):
        raise LockNotAvailable("canceling statement due to lock timeout")

    monkeypatch.setattr(drift_mod, "fetch_applied", _raise)
    assert drift_mod.main([]) == drift_mod.EXIT_BROKEN
    assert drift_mod.main([]) == drift_mod.EXIT_BROKEN, (
        "a query cancelled mid-read is not an unreachable database, and under "
        "the four-code contract it is not 'not attempted' either -- it was "
        "attempted and it failed, which is exit 2"
    )


# --------------------------------------------------------------------------
# D6: more rows than expected is not "the database is behind"
# --------------------------------------------------------------------------


def test_expect_fewer_is_drift_but_expect_more_is_unknown(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/x")
    real = drift_mod.discover_repo_migrations(drift_mod.DEFAULT_MIGRATIONS_DIR)
    monkeypatch.setattr(drift_mod, "fetch_applied", lambda _u: set(real))
    # ledger has len(real); asking for more -> genuinely behind -> exit 1
    assert drift_mod.main(["--expect", str(len(real) + 1)]) == drift_mod.EXIT_DRIFT
    # ledger has MORE than expected -> a surprise, not "behind" -> exit 2
    assert drift_mod.main(["--expect", str(len(real) - 1)]) == drift_mod.EXIT_BROKEN


# --------------------------------------------------------------------------
# D7: fetch_applied had no test at all — every DB-touching test above
# monkeypatches it away, so the to_regclass branch and the row-shape
# assumption were exercised by nothing. These run for real when DATABASE_URL
# is set, which CI's `test` job does (it has a postgres service).
# --------------------------------------------------------------------------


def _pg_url_or_skip():
    import pytest

    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        pytest.skip("DATABASE_URL not set; CI's test job provides one")
    pytest.importorskip("psycopg")
    return url


_DISPOSABLE_HOSTS = {"", "localhost", "127.0.0.1", "::1", "/tmp", "/var/run/postgresql"}


def _pg_url_or_skip_ddl():
    """Like `_pg_url_or_skip`, but for tests that WRITE SCHEMA.

    Round 5, defect 3: the tests below run `CREATE DATABASE`, `DROP DATABASE`
    and `CREATE TABLE public._migrations` against whatever `DATABASE_URL`
    names, with no guard. The gate's own docstring says staging is exactly the
    ledger-less shape -- so a developer running pytest with
    `DATABASE_URL=<staging>` silently GIVES staging a ledger, and the gate's
    verdict on it flips from exit 2 ("unknowable") to exit 1 ("missing 30").
    The tests would have quietly destroyed the evidence they describe.

    Self-arming, so CI needs no new variable and cannot be left behind a flag
    nobody sets -- which would be a false green of its own. A local or
    containerised postgres is disposable; anything else must say so explicitly.
    """
    import pytest

    # _pg_url_or_skip() FIRST: it holds the importorskip. Round 6, defect 4 --
    # importing psycopg above this line made the two DDL tests FAIL with
    # ModuleNotFoundError instead of skipping when psycopg is absent.
    url = _pg_url_or_skip()
    if os.environ.get("DRIFT_GATE_TEST_DB_IS_DISPOSABLE") == "1":
        return url  # explicit override, checked before any inference
    from psycopg.conninfo import conninfo_to_dict

    parsed = conninfo_to_dict(url)
    # Round 6, defect 3: three DSN shapes carry no `host` key and were all
    # treated as local -- `hostaddr=<remote>`, a blank host with PGHOST set in
    # the environment (conninfo_to_dict does NOT consult the environment), and
    # `service=` with the host in pg_service.conf. Any of them could have put
    # CREATE/DROP DATABASE on a remote. If we cannot see the host plainly, we
    # do not get to call it disposable.
    # Round 7, defect 1: libpq honours PGHOSTADDR whenever `hostaddr` is absent
    # from the DSN, and PGSERVICE whenever `service` is. Round 6 closed the DSN
    # halves and left the environment halves wide open -- measured: a localhost
    # URL plus PGHOSTADDR=10.255.255.1 was called disposable and libpq went to
    # the remote.
    for env_opaque in ("PGHOSTADDR", "PGSERVICE"):
        if os.environ.get(env_opaque):
            pytest.skip(
                f"{env_opaque}={os.environ[env_opaque]!r} is set, so libpq will "
                f"connect somewhere this guard cannot see. These tests create "
                f"and drop schema. Set DRIFT_GATE_TEST_DB_IS_DISPOSABLE=1 to "
                f"override."
            )
    for opaque in ("hostaddr", "service"):
        if parsed.get(opaque):
            pytest.skip(
                f"DATABASE_URL carries {opaque}={parsed[opaque]!r}, so the real "
                f"target is not visible here. These tests create and drop "
                f"schema. Set DRIFT_GATE_TEST_DB_IS_DISPOSABLE=1 to override."
            )
    if not (parsed.get("host") or "").strip() and os.environ.get("PGHOST"):
        pytest.skip(
            f"DATABASE_URL names no host and PGHOST={os.environ['PGHOST']!r} is "
            f"set, so libpq will connect somewhere this guard cannot see. Set "
            f"DRIFT_GATE_TEST_DB_IS_DISPOSABLE=1 to override."
        )
    host = (parsed.get("host") or "").strip()
    # A comma-separated host list is tried in order, so "/tmp,10.255.255.1" was
    # called disposable on the strength of its first entry while libpq would
    # fall through to the remote. Every entry must be local, not just the first.
    entries = [h.strip() for h in host.split(",")] if host else [host]
    if all(h in _DISPOSABLE_HOSTS or h.startswith("/") for h in entries):
        return url
    if os.environ.get("DRIFT_GATE_TEST_DB_IS_DISPOSABLE") == "1":
        return url
    pytest.skip(
        f"DATABASE_URL points at host {host!r}, which is not local. These tests "
        f"create and drop schema. Set DRIFT_GATE_TEST_DB_IS_DISPOSABLE=1 only "
        f"if that database is genuinely disposable."
    )


def test_fetch_applied_raises_ledger_missing_on_a_database_without_one():
    """The to_regclass branch, exercised against a real ledger-less database."""
    url = _pg_url_or_skip_ddl()  # CREATE/DROP DATABASE below -- must be local
    import psycopg

    name = "drift_gate_probe_db"
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {name}")
        conn.execute(f"CREATE DATABASE {name}")
    try:
        from psycopg.conninfo import conninfo_to_dict, make_conninfo

        # Review N3: a regex rewrite broke on passwords containing "?",
        # path-less URLs and key=value conninfo. Let psycopg parse it.
        probe_url = make_conninfo(**{**conninfo_to_dict(url), "dbname": name})
        with pytest.raises(drift_mod.LedgerMissing):
            drift_mod.fetch_applied(probe_url)
    finally:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(f"DROP DATABASE IF EXISTS {name}")


def test_fetch_applied_returns_filenames_from_a_real_ledger():
    """Round 5, defect 3: this used to fail on a ledger-less database, because
    it depended on a LATER test in the file having created the table. Pass or
    fail by collection order. A ledger-less database is a legitimate state and
    simply not this test's subject, so skip rather than create one -- creating
    it is what defect 3 is about."""
    url = _pg_url_or_skip()
    try:
        applied = drift_mod.fetch_applied(url)
    except drift_mod.LedgerMissing:
        pytest.skip("no public._migrations here; that is this file's OTHER test")
    assert isinstance(applied, set)
    if not applied:
        return  # an empty ledger is a legitimate state
    assert all(isinstance(x, str) and x.endswith(".sql") for x in applied), sorted(applied)[:5]


def test_post_connect_failure_is_not_forgiven_real_database(monkeypatch):
    """Round 4, D-A: the previous test for this monkeypatched `fetch_applied`
    away, so it exercised main()'s dispatch and NOT the connect/query phase
    split. It passed against the buggy round-3 script, and a mutant that
    reintroduced the bug survived the whole suite.

    This drives a real post-connect failure through `fetch_applied`: hold an
    ACCESS EXCLUSIVE lock on the ledger from a second connection and read it
    with a short lock_timeout. The cancellation happens at query time, so it
    must NOT be an Unreachable and must NOT be forgiven by the flag.
    """
    url = _pg_url_or_skip_ddl()  # CREATE TABLE below -- must be disposable
    import psycopg
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    # Round 7, defect 6: this created public._migrations and never dropped it,
    # so on a ledger-less database the gate's verdict flipped from exit 2
    # ("unknowable") to exit 1 ("missing 30") for every later run -- the
    # round-5 hazard, scoped to local hosts rather than removed, and a
    # developer's docker-compose Postgres is local. Create it only if absent,
    # and drop it again if we were the ones who made it.
    with psycopg.connect(url, autocommit=True) as c:
        we_created_it = c.execute("SELECT to_regclass('public._migrations')").fetchone()[0] is None
        c.execute(
            "CREATE TABLE IF NOT EXISTS public._migrations "
            "(filename text PRIMARY KEY, applied_at timestamptz DEFAULT now())"
        )

    # APPEND to any options already in the DSN. make_conninfo with a bare
    # "options" key REPLACES them (verified), which would silently drop e.g. a
    # search_path the URL carried. Harmless with CI's URL today; not harmless
    # the first time someone's URL has options. Round 5, defect 6.
    existing = (conninfo_to_dict(url).get("options") or "").strip()
    opts = f"{existing} -c lock_timeout=300".strip()
    slow = make_conninfo(**{**conninfo_to_dict(url), "options": opts})

    blocker = psycopg.connect(url)
    try:
        # The blocker bounds its OWN wait too. Nothing else holds this lock in
        # CI, but under pytest-xdist two workers would both try, and an
        # unbounded LOCK TABLE hangs the suite instead of failing it.
        blocker.execute("SET lock_timeout = '5s'")
        blocker.execute("LOCK TABLE public._migrations IN ACCESS EXCLUSIVE MODE")

        # Assert the SPECIFIC error. Round 5, defect 6: `pytest.raises(Exception)`
        # plus "not Unreachable" passed for ANY non-Unreachable exception -- a
        # BadConfiguration, a LedgerMissing, even a typo raising NameError --
        # without the lock ever being contended. The point of this test is that
        # a QUERY cancelled after a successful connect is not forgiven, so it
        # must prove that is the error it got.
        with pytest.raises(psycopg.errors.LockNotAvailable) as caught:
            drift_mod.fetch_applied(slow)
        assert not isinstance(caught.value, drift_mod.Unreachable), (
            "a query cancelled after a successful connect is not an unreachable "
            "database; classifying it as one would have let the old flag return 0"
        )
        # monkeypatch, NOT os.environ: an unrestored DATABASE_URL carrying
        # lock_timeout leaks into every later test in the session.
        monkeypatch.setenv("DATABASE_URL", slow)
        assert drift_mod.main([]) == drift_mod.EXIT_BROKEN
    finally:
        blocker.rollback()
        blocker.close()
        if we_created_it:
            with psycopg.connect(url, autocommit=True) as c:
                c.execute("DROP TABLE IF EXISTS public._migrations")


def test_malformed_conninfo_is_never_forgiven(monkeypatch):
    """Round 4, D-B: psycopg raises conninfo errors from connect(), so a typo'd
    DATABASE_URL was classed as 'unreachable' and returned 0 under the flag.
    Parsing now happens before the connect and raises BadConfiguration.

    Round 5 REFUTED the previous version of this docstring, which claimed
    "postgresql://host:notaport/db parses fine and then fails at getaddrinfo".
    It does not: libpq rejects the port VALUE before touching the network
    (`connection is bad: invalid integer value "notaport"`), and the old code
    classified that as Unreachable and FORGAVE it. Value rejections are now
    BadConfiguration too -- see test_client_rejected_dsn_values_are_not_forgiven.
    """
    pytest.importorskip("psycopg")
    monkeypatch.setenv("DATABASE_URL", "garbage")
    with pytest.raises(drift_mod.BadConfiguration):
        drift_mod.fetch_applied("garbage")
    assert drift_mod.main([]) == drift_mod.EXIT_BROKEN


def test_an_unresolvable_host_is_not_forgiven_either(monkeypatch):
    """Round 6 moved this. A host that will not resolve was the archetypal
    "forgivable" case for three rounds, on the reasoning that it cannot be told
    apart from a database that is down. True, and the wrong conclusion: if you
    NAMED a database, not reaching it is a failure. The legitimate
    no-database-in-CI case is covered without any guessing, by DATABASE_URL
    being absent."""
    pytest.importorskip("psycopg")
    # No connect_timeout in the URL: the gate passes connect_timeout=15 as a
    # kwarg, which OVERRIDES the URL's value (verified round 5, defect 7), and
    # psycopg resolves hostnames in Python before libpq anyway, so neither
    # bounds getaddrinfo. Carrying the parameter here implied a bound that does
    # not exist.
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@no-such-host.invalid:5432/d")
    assert drift_mod.main([]) == drift_mod.EXIT_BROKEN


def test_a_server_that_answers_and_refuses_us_is_never_forgiven():
    """Round 5, defect 2 -- the worst false green found in five rounds.

    `connect()` raises when the SERVER answered and rejected us: a wrong
    password, a database or role that does not exist, a pg_hba rule excluding
    this host. The old code classified every connect failure as Unreachable, so
    a CI job with a typo'd password reported exit 0 under the removed forgiving flag.
    The database was plainly reachable -- it replied.

    Driven against a real server, not simulated, because the discriminator is
    libpq's message text and the whole point is that it must match what a real
    PostgreSQL actually sends. If psycopg or libpq rewords this, THIS TEST goes
    red and names the classifier -- which is how the brittleness is paid for.
    """
    url = _pg_url_or_skip()
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    base = conninfo_to_dict(url)
    cases = {
        "no such database": make_conninfo(**{**base, "dbname": "drift_gate_no_such_db"}),
        "no such role": make_conninfo(**{**base, "user": "drift_gate_no_such_role"}),
    }
    # Round 6, defect 8: the headline case -- a WRONG PASSWORD, i.e. a typo'd
    # CI secret -- was not in the suite. CI's postgres:16-alpine uses password
    # auth, so it pins there; additive so a trust-auth server just omits it.
    if base.get("password"):
        cases["wrong password"] = make_conninfo(**{**base, "password": "definitely-not-it"})
    for label, bad in cases.items():
        # Assert the BEHAVIOUR, not the label. Round 7, defect 2: asserting
        # `ServerRejected` and `"FATAL" in ...` pinned libpq's LOCALIZED
        # severity, so a non-English server or a translated libpq turned CI red
        # while every exit code below still passed. The label stopped deciding
        # anything in round 6; pinning it only buys false reds.
        with pytest.raises(Exception) as caught:
            drift_mod.fetch_applied(bad)
        assert not isinstance(caught.value, drift_mod.Unreachable), (label, caught.value)
        os.environ["DATABASE_URL"] = bad
        try:
            assert drift_mod.main([]) == drift_mod.EXIT_BROKEN, label
        finally:
            os.environ["DATABASE_URL"] = url


def test_client_rejected_dsn_values_are_not_forgiven(monkeypatch):
    """The other half of defect 2: the DSN parses, but libpq refuses a VALUE
    before any network I/O. Measured round 5 -- these never leave the process,
    so calling them "unreachable" and forgiving them was wrong."""
    pytest.importorskip("psycopg")
    for bad in (
        "postgresql://u@127.0.0.1:notaport/d",
        "postgresql://u@127.0.0.1:5432/d?sslmode=bogus",
    ):
        monkeypatch.setenv("DATABASE_URL", bad)
        # No assertion on the exception TYPE. Round 7, defect 2: these two
        # inputs are classified from libpq's message, which is localized, so
        # pinning the type bought a red CI on a reword while the exit codes --
        # the actual behaviour -- were unaffected. The exit codes are the
        # contract; assert those.
        assert drift_mod.main([]) == drift_mod.EXIT_BROKEN, bad


def test_a_named_database_that_cannot_be_reached_is_never_forgiven(monkeypatch):
    """Round 6 settled what this flag forgives, after rounds 4, 5 and 6 each
    found a false green in an attempt to classify failures by their message.

    `FATAL:` is the server's LOCALIZED severity -- PG16 ships ВАЖНО,
    치명적오류, KATASTROFALNY -- and libpq translates the client half too, so no
    message match can be correct. Round 6 also measured five English cases the
    regex missed, among them `fe_sendauth: no password supplied`: an unset CI
    secret, forgiven, by the gate that cites "secret present vs. job
    meaningful" as its reason for existing.

    Side benefit over the version this replaces: the assertion no longer
    depends on what happens to be listening on port 5499. A Postgres there, an
    HTTP server, or nothing at all -- every one exits 2."""
    pytest.importorskip("psycopg")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@127.0.0.1:5499/d")
    assert drift_mod.main([]) == drift_mod.EXIT_BROKEN


def test_unset_is_not_attempted_and_empty_is_broken(monkeypatch):
    """The two states that look the same and are not. Renamed from
    test_the_flag_forgives_only_an_absent_url -- there is no flag now, and the
    distinction is carried by the exit code instead."""
    pytest.importorskip("psycopg")
    # UNSET: nobody said where the database is. Exit 3, NOT ATTEMPTED.
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert drift_mod.main([]) == drift_mod.EXIT_NOT_CHECKED

    # SET BUT EMPTY: never forgiven. In GitHub Actions an unset secret expands
    # to "", so `env: DATABASE_URL: ${{ secrets.MISSING }}` lands here. Treating
    # it as "absent" is the "secret present vs. job meaningful" seam this gate
    # cites as its reason for existing -- reintroduced, briefly, inside the fix
    # for it.
    for empty in ("", "   ", "\t"):
        monkeypatch.setenv("DATABASE_URL", empty)
        assert drift_mod.main([]) == drift_mod.EXIT_BROKEN, repr(empty)


def test_the_crash_guard_reports_unknown_not_drift(monkeypatch):
    """Round 5, defect 4: an uncaught exception let Python exit 1, and 1 is
    this gate's code for "the database is BEHIND". Every crash was reported to
    its caller as drift.

    Round 6, defect 7: the second assertion here used
    `--migrations-dir /nonexistent-xyz`, which does NOT crash -- glob on a
    missing directory returns [] and main() takes its handled "no migrations
    found" branch. The assertion was true and proved nothing about the crash
    handler. Both assertions below now drive a real exception, at two different
    stages, so a guard that only covers one of them cannot pass.
    """

    def boom(*a, **k):
        raise RuntimeError("the gate itself broke")

    real_discover = drift_mod.discover_repo_migrations
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@127.0.0.1:5499/d")

    # Stage 1: crash during discovery, before any database work.
    monkeypatch.setattr(drift_mod, "discover_repo_migrations", boom)
    with pytest.raises(RuntimeError):
        drift_mod.main([])  # main() still propagates; _cli is what classifies
    assert drift_mod._cli([]) == drift_mod.EXIT_BROKEN

    # Stage 2: discovery AND the ledger read both succeed; the comparison
    # crashes. This is past main()'s own `except Exception` around the ledger
    # read -- writing this test is what showed stage 1 alone was not enough,
    # because a ValueError from `fetch_applied` is CAUGHT by that handler and
    # returns 2 on its own, never reaching the crash guard at all.
    monkeypatch.setattr(drift_mod, "discover_repo_migrations", real_discover)
    monkeypatch.setattr(drift_mod, "fetch_applied", lambda _u: set())
    monkeypatch.setattr(drift_mod, "diff_migrations", boom)
    with pytest.raises(RuntimeError):
        drift_mod.main([])
    assert drift_mod._cli([]) == drift_mod.EXIT_BROKEN


@pytest.mark.parametrize(
    "env,dsn",
    [
        ({}, "postgresql://u:p@db.example.com:5432/prod"),
        ({}, "postgresql://u:p@/prod?hostaddr=10.255.255.1"),
        ({}, "postgresql://u:p@/prod?service=prodsvc"),
        ({"PGHOSTADDR": "10.255.255.1"}, "postgresql://u:p@localhost:5432/prod"),
        ({"PGSERVICE": "prodsvc"}, "postgresql://u:p@/prod"),
        ({}, "postgresql://u:p@/prod?host=/tmp,10.255.255.1"),
    ],
)
def test_the_ddl_guard_refuses_anything_it_cannot_prove_is_local(monkeypatch, env, dsn):
    """Round 7: deleting the DDL guard's body was GREEN in rounds 6 AND 7.

    That guard is the only thing standing between `pytest` and
    `CREATE DATABASE` / `DROP DATABASE` / `CREATE TABLE` against whatever
    DATABASE_URL names -- and the gate's own docstring says staging is exactly
    the ledger-less shape it describes, so pointing the suite at staging would
    destroy the evidence it reports. A guard with no test is scaffolding that
    nothing would notice the removal of. This pins it.

    Each case below is a shape a previous round found being waved through.
    """
    pytest.importorskip("psycopg")
    monkeypatch.delenv("PGHOSTADDR", raising=False)
    monkeypatch.delenv("PGSERVICE", raising=False)
    monkeypatch.delenv("PGHOST", raising=False)
    monkeypatch.delenv("DRIFT_GATE_TEST_DB_IS_DISPOSABLE", raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("DATABASE_URL", dsn)
    # BaseException, not Exception: pytest.skip raises Skipped, which derives
    # from BaseException. Catching Exception let the Skipped propagate and the
    # TEST skipped instead of asserting -- a guard test that silently does not
    # run, which is the defect class this whole file is about.
    with pytest.raises(BaseException) as caught:
        _pg_url_or_skip_ddl()
    assert "Skipped" in type(caught.value).__name__ or "skip" in str(caught.value).lower(), (
        f"the guard ALLOWED {dsn!r} with env {env!r}; it must refuse anything "
        f"it cannot prove is local"
    )


def test_the_ddl_guard_allows_a_plainly_local_target(monkeypatch):
    """The other side: the guard must NOT skip on CI's own URL, or the DDL
    tests silently stop running and round 5's defect 3 becomes a false green
    instead of a hazard."""
    pytest.importorskip("psycopg")
    for k in ("PGHOSTADDR", "PGSERVICE", "PGHOST", "DRIFT_GATE_TEST_DB_IS_DISPOSABLE"):
        monkeypatch.delenv(k, raising=False)
    for ok in (
        "postgresql://stemloops:stemloops@localhost:5432/stemloops",
        "postgresql://stemloops@127.0.0.1:5432/stemloops",
        "postgresql://u:p@/db?host=/tmp",
    ):
        monkeypatch.setenv("DATABASE_URL", ok)
        assert _pg_url_or_skip_ddl() == ok, ok


def test_the_disposable_override_wins(monkeypatch):
    """The documented escape hatch, asserted so it keeps working -- it is the
    only way to run these tests against a deliberately disposable remote."""
    pytest.importorskip("psycopg")
    monkeypatch.setenv("PGHOSTADDR", "10.255.255.1")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/throwaway")
    monkeypatch.setenv("DRIFT_GATE_TEST_DB_IS_DISPOSABLE", "1")
    assert _pg_url_or_skip_ddl().startswith("postgresql://")


def test_the_exit_codes_come_from_the_shared_module_not_a_copy():
    """D3: there must be ONE definition of the house exit-code contract.

    Until 2026-11-07 the two gates disagreed -- `2` meant "cannot determine"
    here and "broken lookup" in check_credit_pack_prices.py, and "not checked"
    was `2` in one and `3` in the other. Same repo, both in CI, both read by a
    person looking at a red job.

    This is dev-playbook L39 applied: rule 1, import the thing and read its
    value rather than recomputing what it should be; rule 2, strip comments
    before asserting on source text, because a reviewer once defeated three
    pins by leaving the old expression in a comment; rule 3, a duplicated
    expression is not pinned by a copy of itself -- so the assertion below is
    that the copy does not exist, not that two copies agree.
    """
    spec = importlib.util.spec_from_file_location(
        "_gate_exit_under_test", _REPO_ROOT / "scripts" / "_gate_exit.py"
    )
    assert spec and spec.loader
    shared = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shared)

    for name in ("EXIT_OK", "EXIT_DRIFT", "EXIT_BROKEN", "EXIT_NOT_CHECKED"):
        assert getattr(drift_mod, name) == getattr(shared, name), name

    values = [shared.EXIT_OK, shared.EXIT_DRIFT, shared.EXIT_BROKEN, shared.EXIT_NOT_CHECKED]
    assert values == [0, 1, 2, 3], values
    assert len(set(values)) == 4, "the four codes must be pairwise distinct"

    # And the gate must not have re-grown its own copy. Comments stripped via
    # tokenize, so documenting the old values cannot satisfy or trip this.
    import io
    import tokenize

    src = (_REPO_ROOT / "scripts" / "check_migration_drift.py").read_text()
    code = "".join(
        tok.string if tok.type != tokenize.COMMENT else ""
        for tok in tokenize.generate_tokens(io.StringIO(src).readline)
    )
    for name in ("EXIT_OK", "EXIT_DRIFT", "EXIT_BROKEN", "EXIT_NOT_CHECKED"):
        assert f"{name}=" not in code.replace(" ", ""), (
            f"{name} is assigned inside check_migration_drift.py. The contract "
            f"lives in scripts/_gate_exit.py; import it, do not redefine it."
        )
