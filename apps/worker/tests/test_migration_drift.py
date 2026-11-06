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
import sys
from pathlib import Path

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
