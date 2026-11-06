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

import importlib.util
import os
import sys
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
# discovery must mirror migrate.py exactly
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
    assert rc == drift_mod.EXIT_UNKNOWN, (
        "no DATABASE_URL must NOT be success — a gate that skips silently is "
        "worse than no gate (seam-inventory Part 4, item 5)"
    )
    assert rc != drift_mod.EXIT_OK


def test_blank_database_url_is_treated_as_absent(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "   ")
    assert drift_mod.main([]) == drift_mod.EXIT_UNKNOWN


def test_allow_unreachable_is_an_explicit_opt_in_and_warns(monkeypatch, capsys):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    rc = drift_mod.main(["--allow-unreachable"])
    assert rc == drift_mod.EXIT_OK
    err = capsys.readouterr().err
    assert (
        "WITHOUT having checked" in err
    ), "the skip path must say plainly that nothing was verified"


def test_unreadable_ledger_is_unknown_not_success(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://nope/nope")
    monkeypatch.setattr(
        drift_mod,
        "fetch_applied",
        lambda _u: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    assert drift_mod.main([]) == drift_mod.EXIT_UNKNOWN


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
# reintroduces a second copy in the gate. The CI job deliberately keeps its own
# independent count (`find -maxdepth 1`) in "Assert the whole chain landed" —
# an independent check is worth more than a shared one there, and it is what
# would catch a runner that stopped calling the function.
# --------------------------------------------------------------------------

_MIGRATE_PY = _REPO_ROOT / "apps" / "worker" / "src" / "worker" / "migrate.py"


def _load_runner():
    """Import the real runner, stubbing psycopg only if it is NOT INSTALLABLE.

    Review round 3 (new defect 1): the previous condition was
    `"psycopg" not in sys.modules`, so running a pin test before anything had
    imported psycopg installed a stub for the REST OF THE SESSION and the
    real-database tests then died with
    `TypeError: 'NoneType' object does not support the context manager
    protocol`. CI only escaped it by accident of collection order. Key on
    importability, never on what happens to be in sys.modules.
    """
    import types

    src = str(_REPO_ROOT / "apps" / "worker" / "src")
    if src not in sys.path:
        sys.path.insert(0, src)
    try:
        import psycopg  # noqa: F401
    except ImportError:
        stub = types.ModuleType("psycopg")
        stub.connect = lambda *a, **k: None
        stub.OperationalError = type("OperationalError", (Exception,), {})
        sys.modules.setdefault("psycopg", stub)
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
# D5: --allow-unreachable must not forgive a reachable database with no ledger
# --------------------------------------------------------------------------


def test_missing_ledger_is_never_forgiven_even_with_allow_unreachable(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/x")

    def _raise(_u):
        raise drift_mod.LedgerMissing("public._migrations does not exist")

    monkeypatch.setattr(drift_mod, "fetch_applied", _raise)
    assert drift_mod.main([]) == drift_mod.EXIT_UNKNOWN
    assert (
        drift_mod.main(["--allow-unreachable"]) == drift_mod.EXIT_UNKNOWN
    ), "staging's exact shape: tables present, no ledger. No flag may bless it"


def test_only_a_connect_phase_failure_is_forgiven_by_the_flag(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/x")

    def _raise(_u):
        raise drift_mod.Unreachable("connection refused")

    monkeypatch.setattr(drift_mod, "fetch_applied", _raise)
    assert drift_mod.main([]) == drift_mod.EXIT_UNKNOWN
    assert drift_mod.main(["--allow-unreachable"]) == drift_mod.EXIT_OK


def test_reachable_but_unreadable_ledger_is_never_forgiven(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/x")

    def _raise(_u):
        raise PermissionError("permission denied for table _migrations")

    monkeypatch.setattr(drift_mod, "fetch_applied", _raise)
    assert drift_mod.main([]) == drift_mod.EXIT_UNKNOWN
    assert drift_mod.main(["--allow-unreachable"]) == drift_mod.EXIT_UNKNOWN


def test_a_query_time_operational_error_is_not_forgiven(monkeypatch):
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
    assert drift_mod.main([]) == drift_mod.EXIT_UNKNOWN
    assert (
        drift_mod.main(["--allow-unreachable"]) == drift_mod.EXIT_UNKNOWN
    ), "a query cancelled mid-read is not an unreachable database"


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
    assert drift_mod.main(["--expect", str(len(real) - 1)]) == drift_mod.EXIT_UNKNOWN


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


def test_fetch_applied_raises_ledger_missing_on_a_database_without_one():
    """The to_regclass branch, exercised against a real ledger-less database."""
    url = _pg_url_or_skip()  # skips before importing psycopg if there is no DB
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
    url = _pg_url_or_skip()
    applied = drift_mod.fetch_applied(url)
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
    url = _pg_url_or_skip()
    import psycopg
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    with psycopg.connect(url, autocommit=True) as c:
        c.execute(
            "CREATE TABLE IF NOT EXISTS public._migrations "
            "(filename text PRIMARY KEY, applied_at timestamptz DEFAULT now())"
        )

    slow = make_conninfo(**{**conninfo_to_dict(url), "options": "-c lock_timeout=300"})
    blocker = psycopg.connect(url)
    try:
        blocker.execute("LOCK TABLE public._migrations IN ACCESS EXCLUSIVE MODE")
        with pytest.raises(Exception) as caught:
            drift_mod.fetch_applied(slow)
        assert not isinstance(caught.value, drift_mod.Unreachable), (
            "a query cancelled after a successful connect is not an unreachable "
            "database; classifying it as one lets --allow-unreachable return 0"
        )
        # monkeypatch, NOT os.environ: an unrestored DATABASE_URL carrying
        # lock_timeout leaks into every later test in the session.
        monkeypatch.setenv("DATABASE_URL", slow)
        assert drift_mod.main([]) == drift_mod.EXIT_UNKNOWN
        assert drift_mod.main(["--allow-unreachable"]) == drift_mod.EXIT_UNKNOWN
    finally:
        blocker.rollback()
        blocker.close()


def test_malformed_conninfo_is_never_forgiven(monkeypatch):
    """Round 4, D-B: psycopg raises conninfo errors from connect(), so a typo'd
    DATABASE_URL was classed as 'unreachable' and returned 0 under the flag.
    Parsing now happens before the connect and raises BadConfiguration.

    Only strings that do not PARSE are config errors. Writing this test is what
    showed the line has to sit there: "postgresql://host:notaport/db" parses
    fine and then fails at getaddrinfo, which is the same failure a genuinely
    down or firewalled database gives. Forgiving that is the whole point of the
    flag, so it stays Unreachable -- see test below.
    """
    pytest.importorskip("psycopg")
    monkeypatch.setenv("DATABASE_URL", "garbage")
    with pytest.raises(drift_mod.BadConfiguration):
        drift_mod.fetch_applied("garbage")
    assert drift_mod.main([]) == drift_mod.EXIT_UNKNOWN
    assert drift_mod.main(["--allow-unreachable"]) == drift_mod.EXIT_UNKNOWN


def test_unresolvable_host_stays_forgivable(monkeypatch):
    """The other side of the line above. This is NOT a config error we can tell
    apart from a down database, so --allow-unreachable forgives it. Asserted so
    nobody 'tightens' BadConfiguration into the connect phase and makes every
    CI job that runs without a database go red."""
    pytest.importorskip("psycopg")
    monkeypatch.setenv(
        "DATABASE_URL", "postgresql://u@no-such-host.invalid:5432/d?connect_timeout=1"
    )
    assert drift_mod.main([]) == drift_mod.EXIT_UNKNOWN
    assert drift_mod.main(["--allow-unreachable"]) == drift_mod.EXIT_OK
