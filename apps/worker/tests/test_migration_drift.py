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
        drift_mod, "fetch_applied", lambda _u: (_ for _ in ()).throw(RuntimeError("boom"))
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
# Review finding D4: the discovery test above asserts a hard-coded list and
# never consults the runner, while the script's docstring says "if the runner's
# discovery ever changes, this check must change with it". Nothing enforced
# that. The glob now exists in three places (migrate.py, this gate, and the CI
# job); these tests go red when they stop agreeing.
# --------------------------------------------------------------------------

_MIGRATE_PY = _REPO_ROOT / "apps" / "worker" / "src" / "worker" / "migrate.py"


def _load_runner():
    """Import the real runner module, stubbing psycopg if it is not installed.

    Round-2 review N1: the previous version of these tests recomputed the
    runner's path from the runner's *filename* and compared the gate against a
    *copy* of the glob written in the test. Both were tautologies — a reviewer
    repointed MIGRATIONS_DIR and they stayed green. Import the module and read
    its real values.
    """
    import types

    if "psycopg" not in sys.modules:
        stub = types.ModuleType("psycopg")
        stub.connect = lambda *a, **k: None
        stub.OperationalError = type("OperationalError", (Exception,), {})
        sys.modules["psycopg"] = stub
    src = str(_REPO_ROOT / "apps" / "worker" / "src")
    if src not in sys.path:
        sys.path.insert(0, src)
    import worker.migrate as runner

    return runner


def _strip_py_comments(source: str) -> str:
    """Remove comments so a 'the code still says X' check cannot be satisfied
    by X appearing in a comment. Review N1 defeated the old check exactly that
    way: rewrite the glob to rglob, leave the old expression in a comment."""
    import io
    import tokenize

    out = []
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type == tokenize.COMMENT:
            continue
        out.append(tok)
    return tokenize.untokenize(out)


def test_gate_and_runner_point_at_the_same_directory():
    """Reads worker.migrate.MIGRATIONS_DIR itself — not a recomputation."""
    runner = _load_runner()
    assert (
        Path(runner.MIGRATIONS_DIR).resolve() == drift_mod.DEFAULT_MIGRATIONS_DIR.resolve()
    ), "the gate and the runner are looking at different directories"


def test_runner_discovery_is_still_a_top_level_sql_glob_in_real_code():
    """Pin the runner's expression, ignoring comments.

    If migrate.py's discovery changes, this goes red and whoever changed it
    must change the gate and the CI count with it. Comments are stripped so the
    pin cannot be satisfied by a leftover comment.
    """
    code = _strip_py_comments(_MIGRATE_PY.read_text())
    assert 'glob.glob(os.path.join(MIGRATIONS_DIR, "*.sql"))' in code, (
        "migrate.py's discovery changed; scripts/check_migration_drift.py and "
        "the CI job's migration count must change with it"
    )
    assert (
        "rglob" not in code and "recursive=True" not in code
    ), "the runner went recursive; the gate would then miss down/"


def test_gate_discovery_equals_the_runners_own_directory_listing():
    import glob as _glob
    import os as _os

    runner = _load_runner()
    runner_files = sorted(
        _os.path.basename(x) for x in _glob.glob(_os.path.join(runner.MIGRATIONS_DIR, "*.sql"))
    )
    assert drift_mod.discover_repo_migrations(Path(runner.MIGRATIONS_DIR)) == runner_files


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


def test_only_a_connection_failure_is_forgiven_by_the_flag(monkeypatch):
    fake = type("FakeOperationalError", (Exception,), {})
    monkeypatch.setattr(drift_mod, "_connection_error_types", lambda: (fake,))
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/x")

    def _raise(_u):
        raise fake("connection refused")

    monkeypatch.setattr(drift_mod, "fetch_applied", _raise)
    assert drift_mod.main([]) == drift_mod.EXIT_UNKNOWN
    assert drift_mod.main(["--allow-unreachable"]) == drift_mod.EXIT_OK


def test_reachable_but_unreadable_ledger_is_never_forgiven(monkeypatch):
    """Round-2 review N2: the broad `except Exception` classified a reachable
    database with an unreadable ledger as 'unreachable', so --allow-unreachable
    returned 0 — a green tick over a gate that checked nothing. This repo uses
    narrow-grant *_RO credentials for jobs like this, so it is a live shape."""
    fake = type("FakeOperationalError", (Exception,), {})
    monkeypatch.setattr(drift_mod, "_connection_error_types", lambda: (fake,))
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/x")

    def _raise(_u):
        raise PermissionError("permission denied for table _migrations")

    monkeypatch.setattr(drift_mod, "fetch_applied", _raise)
    assert drift_mod.main([]) == drift_mod.EXIT_UNKNOWN
    assert (
        drift_mod.main(["--allow-unreachable"]) == drift_mod.EXIT_UNKNOWN
    ), "the database answered; no flag may bless an unread ledger"


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
