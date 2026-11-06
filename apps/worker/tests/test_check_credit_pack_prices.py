"""Unit tests for scripts/check_credit_pack_prices.py (audit M5 CI gate)."""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest import mock

import pytest

_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "check_credit_pack_prices.py"
_spec = importlib.util.spec_from_file_location("check_credit_pack_prices", _SCRIPT)
cpp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cpp)

DB = {"credits_20": 500, "credits_60": 1200, "credits_180": 3000}
MATCH = {"price_20": 500, "price_60": 1200, "price_180": 3000}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    monkeypatch.setenv("STRIPE_PRICE_CREDITS_20", "price_20")
    monkeypatch.setenv("STRIPE_PRICE_CREDITS_60", "price_60")
    monkeypatch.setenv("STRIPE_PRICE_CREDITS_180", "price_180")
    monkeypatch.delenv("DATABASE_URL", raising=False)


@pytest.fixture(autouse=True)
def _fake_stripe(monkeypatch):
    """The worker image does not ship stripe; stub the module so the patch target exists."""
    fake = types.ModuleType("stripe")
    fake.Price = types.SimpleNamespace(retrieve=None)
    fake.api_key = None
    monkeypatch.setitem(sys.modules, "stripe", fake)


def _stripe(amounts, currency="cad"):
    def retrieve(pid):
        return {"unit_amount": amounts[pid], "currency": currency}

    return mock.patch("stripe.Price.retrieve", side_effect=retrieve)


def test_migration_seed_parses():
    assert cpp.prices_from_migration() == DB


def test_match_exits_zero(capsys):
    with _stripe(MATCH):
        assert cpp.main([]) == 0
    assert "OK" in capsys.readouterr().out


def test_mismatch_exits_one_with_diff(capsys):
    with _stripe({**MATCH, "price_60": 1500}):
        assert cpp.main([]) == 1
    cap = capsys.readouterr()
    line = [ln for ln in cap.out.splitlines() if ln.startswith("credits_60")][0]
    assert "1200" in line and "1500" in line and "MISMATCH" in line
    assert "FAIL" in cap.err


def test_wrong_currency_fails():
    with _stripe(MATCH, "usd"):
        assert cpp.main([]) == 1


def test_db_source_detects_edited_price(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    edited = {**DB, "credits_20": 300}
    with mock.patch.object(cpp, "prices_from_db", return_value=edited), _stripe(MATCH):
        assert cpp.main(["--source", "db"]) == 1
    assert "300" in capsys.readouterr().out


@pytest.mark.parametrize(
    "exc",
    [
        OSError("connection refused"),
        ImportError("No module named 'psycopg'"),
        RuntimeError('relation "public.credit_packs" does not exist'),
        RuntimeError("permission denied for table credit_packs"),
    ],
    ids=["unreachable", "driver-missing", "table-absent", "permission-denied"],
)
def test_auto_with_database_url_and_db_failing_is_broken_not_green(monkeypatch, capsys, exc):
    """DATABASE_URL set + DB unusable for ANY reason -> exit 2, never the seed.

    The previous test here (test_auto_falls_back_to_migration_when_db_down)
    asserted == 0 and so pinned a FALSE GREEN: a bare `except Exception` fell
    back to the migration seed, compared that to Stripe and printed OK. That
    same green covered auth failure, permission denied, a missing driver and
    `relation credit_packs does not exist` (production's state until 020 ships).
    "Could not read the DB" must not share an outcome with "checked".
    """
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    with mock.patch.object(cpp, "prices_from_db", side_effect=exc), _stripe(MATCH):
        assert cpp.main(["--source", "auto"]) == cpp.EXIT_BROKEN == 2
    cap = capsys.readouterr()
    assert "LOOKUP ERROR" in cap.err
    assert "OK" not in cap.out and "migration" not in cap.out  # no seed comparison ran


def test_auto_without_database_url_uses_seed(capsys):
    # The seed is the intended source only when no DATABASE_URL was supplied.
    with mock.patch.object(cpp, "prices_from_db") as from_db, _stripe(MATCH):
        assert cpp.main(["--source", "auto"]) == 0
    from_db.assert_not_called()
    assert "migration 020 seed" in capsys.readouterr().out


def test_auto_consults_db_when_database_url_set(monkeypatch, capsys):
    # M5 on CI's default path: auto must read the live table, not the seed.
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    edited = {**DB, "credits_20": 300}
    with mock.patch.object(cpp, "prices_from_db", return_value=edited) as from_db, _stripe(MATCH):
        assert cpp.main(["--source", "auto"]) == 1
    from_db.assert_called_once_with("postgresql://x")
    assert "credit_packs table" in capsys.readouterr().out


def test_db_source_failure_exits_two(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    with mock.patch.object(cpp, "prices_from_db", side_effect=OSError("down")), _stripe(MATCH):
        assert cpp.main(["--source", "db"]) == 2
    assert "LOOKUP ERROR" in capsys.readouterr().err


def test_db_source_without_database_url_is_config_error(capsys):
    with _stripe(MATCH):
        assert cpp.main(["--source", "db"]) == 2
    assert "CONFIG ERROR" in capsys.readouterr().err


def test_pack_missing_from_expected_source_is_config_error(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    partial = {k: v for k, v in DB.items() if k != "credits_180"}
    with mock.patch.object(cpp, "prices_from_db", return_value=partial), _stripe(MATCH):
        assert cpp.main(["--source", "db"]) == 2
    err = capsys.readouterr().err
    assert "CONFIG ERROR" in err and "credits_180" in err


def test_missing_migration_file_is_config_error_not_lookup_error(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(cpp, "MIGRATION", tmp_path / "020_moved.sql")
    with _stripe(MATCH):
        assert cpp.main(["--source", "migration"]) == 2
    err = capsys.readouterr().err
    assert "CONFIG ERROR" in err and "LOOKUP ERROR" not in err


def test_migration_without_seed_insert_is_config_error(monkeypatch, tmp_path, capsys):
    sql = tmp_path / "020.sql"
    sql.write_text("CREATE TABLE public.credit_packs (pack_code text);\n")
    monkeypatch.setattr(cpp, "MIGRATION", sql)
    with _stripe(MATCH):
        assert cpp.main(["--source", "migration"]) == 2
    assert "CONFIG ERROR" in capsys.readouterr().err


def test_none_unit_amount_is_mismatch_exit_one(capsys):
    # A tiered / decimal-amount Stripe price has unit_amount None: drift, not a crash.
    with mock.patch(
        "stripe.Price.retrieve",
        side_effect=lambda pid: {
            "unit_amount": None if pid == "price_60" else MATCH[pid],
            "currency": "cad",
        },
    ):
        assert cpp.main([]) == 1
    line = [ln for ln in capsys.readouterr().out.splitlines() if ln.startswith("credits_60")][0]
    assert "None" in line and "MISMATCH" in line


_SECRETS = (
    "STRIPE_SECRET_KEY",
    "STRIPE_PRICE_CREDITS_20",
    "STRIPE_PRICE_CREDITS_60",
    "STRIPE_PRICE_CREDITS_180",
)


@pytest.mark.parametrize("var", _SECRETS)
@pytest.mark.parametrize("strict_env", [None, "0", "1"])
def test_missing_secret_is_not_checked_exit_three(monkeypatch, capsys, var, strict_env):
    # "Secret absent, so I checked nothing" must never look like success (0),
    # nor like drift (1) or a broken lookup (2). STRICT_RECON is gone; setting
    # it in any state must change nothing.
    monkeypatch.delenv(var)
    if strict_env is not None:
        monkeypatch.setenv("STRICT_RECON", strict_env)
    with mock.patch("stripe.Price.retrieve") as retrieve:
        assert cpp.main([]) == cpp.EXIT_NOT_CHECKED == 3
        retrieve.assert_not_called()  # nothing was compared
    err = capsys.readouterr().err
    assert "NOT CHECKED" in err and var in err


def test_empty_secret_counts_as_missing(monkeypatch):
    # GitHub Actions expands an unconfigured secret to "", not to unset.
    for var in _SECRETS:
        monkeypatch.setenv(var, "")
    assert cpp.main([]) == 3


def test_strict_flag_no_longer_exists():
    with pytest.raises(SystemExit) as e:
        cpp.main(["--strict"])
    assert e.value.code == 2  # argparse usage error, not a silent no-op


def test_exit_codes_are_pairwise_distinct():
    codes = (cpp.EXIT_OK, cpp.EXIT_DRIFT, cpp.EXIT_BROKEN, cpp.EXIT_NOT_CHECKED)
    assert len(set(codes)) == 4


def test_not_checked_is_not_masked_by_a_present_db(monkeypatch):
    # Secrets absent but a DB reachable: still nothing compared against Stripe.
    monkeypatch.delenv("STRIPE_SECRET_KEY")
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    with mock.patch.object(cpp, "prices_from_db", return_value=DB):
        assert cpp.main(["--source", "db"]) == 3


# --- the CI job's policy switch: what it does NOT forgive ---------------------

_CI = Path(__file__).resolve().parents[3] / ".github" / "workflows" / "ci.yml"


def _recon_step_script() -> str:
    lines = _CI.read_text().splitlines()
    start = next(i for i, ln in enumerate(lines) if "name: Reconcile credit_packs" in ln)
    run = next(i for i in range(start, len(lines)) if lines[i].strip() == "run: |")
    body = []
    for ln in lines[run + 1 :]:
        if ln.strip() and not ln.startswith(" " * 10):
            break
        body.append(ln[10:])
    return "\n".join(body)


def _run_step(tmp_path, script_exit: int, allow: str) -> int:
    import subprocess

    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "check_credit_pack_prices.py").write_text(
        f"import sys; sys.exit({script_exit})\n"
    )
    shell = _recon_step_script().replace("python ", f"{sys.executable} ")
    res = subprocess.run(
        ["bash", "-e", "-c", shell],
        cwd=tmp_path,
        env={"PATH": "/usr/bin:/bin", "RECON_ALLOW_UNCONFIGURED": allow},
        capture_output=True,
        text=True,
    )
    return res.returncode


def _strip_yaml_comment(line: str) -> str:
    """Drop a trailing `# ...` comment (a `#` at line start or after whitespace, outside quotes)."""
    quote = None
    for i, ch in enumerate(line):
        if quote:
            quote = None if ch == quote else quote
        elif ch in "\"'":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1].isspace()):
            return line[:i].rstrip()
    return line.rstrip()


def _ci_code() -> str:
    """ci.yml with comments removed, so a comment can neither satisfy nor trip an assertion."""
    return "\n".join(_strip_yaml_comment(ln) for ln in _CI.read_text().splitlines())


def _declared_switch_values() -> list[str]:
    vals = []
    for ln in _ci_code().splitlines():
        key, sep, val = ln.strip().partition(":")
        if sep and key == "RECON_ALLOW_UNCONFIGURED":
            vals.append(val.strip().strip("\"'"))
    return vals


def test_ci_switch_declared_once_and_defaults_to_not_forgiving(tmp_path):
    # Assert on the parsed declaration (comments stripped), then on behaviour:
    # with the switch exactly as shipped, a script exit of 3 must still fail the job.
    declared = _declared_switch_values()
    assert declared == ["0"]
    assert _run_step(tmp_path, 3, declared[0]) == 3


def test_ci_has_no_strict_recon_and_step_reads_only_the_one_switch():
    import re

    assert "STRICT_RECON" not in _ci_code()
    # A renamed reintroduction would have to be read by the step script itself.
    read = set(re.findall(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)", _recon_step_script()))
    assert read == {"rc", "RECON_ALLOW_UNCONFIGURED"}


@pytest.mark.parametrize("code", [0, 1, 2, 3])
def test_ci_switch_off_passes_script_exit_through(tmp_path, code):
    assert _run_step(tmp_path, code, "0") == code


@pytest.mark.parametrize("code,expected", [(3, 0), (0, 0), (1, 1), (2, 2)])
def test_ci_switch_on_forgives_only_not_checked(tmp_path, code, expected):
    # Exit 3 (nothing compared) is the ONLY code the switch rewrites.
    # Drift (1) and broken lookup (2) must still fail the job.
    assert _run_step(tmp_path, code, "1") == expected


def test_stripe_error_exits_two():
    with mock.patch("stripe.Price.retrieve", side_effect=RuntimeError("boom")):
        assert cpp.main([]) == 2


def test_auto_with_empty_database_url_is_config_error_not_seed(monkeypatch, capsys):
    """Review round 2, defect A -- the state CI actually reaches, pinned by
    nothing until now.

    `ci.yml` used to map DATABASE_URL to a secret unconditionally, and GitHub
    expands a secret that does not exist to "". So the variable was NEVER unset
    in CI and the seed path was reached ONLY through this state -- meaning a
    renamed, rotated, environment-scoped or deleted secret would silently
    degrade the job to seed-vs-Stripe, green, with one stdout line as the only
    trace.

    The mutant that motivated this test is `if url:` -> `if url is not None:`,
    which the whole 44-test suite passed.
    """
    for empty in ("", "   "):
        monkeypatch.setenv("DATABASE_URL", empty)
        with mock.patch.object(cpp, "prices_from_db") as from_db, _stripe(MATCH):
            rc = cpp.main(["--source", "auto"])
        assert rc == cpp.EXIT_BROKEN, (empty, rc)
        # It must not reach the live table OR the seed -- it must refuse.
        from_db.assert_not_called()
        out = capsys.readouterr()
        assert "set but empty" in (out.err + out.out).lower(), repr(empty)
        assert "migration 020 seed" not in out.out, repr(empty)
        # And not forgivable by the CI switch, which forgives exit 3 only.
        assert rc != cpp.EXIT_NOT_CHECKED


def test_ci_does_not_map_a_database_url_secret():
    """The other half of defect A. If someone re-adds the mapping before the
    secret exists, every PR goes red at exit 2 -- correct, but a surprise. This
    fails loudly at that moment and points the reader at the comment block
    explaining the two preconditions. Uses the comment-stripped view, so the
    documentation of how to re-enable it does not trip the assertion."""
    assert "secrets.DATABASE_URL_CREDIT_PACKS_RO" not in _ci_code(), (
        "ci.yml maps DATABASE_URL_CREDIT_PACKS_RO again. That is correct ONLY "
        "if the secret exists AND migration 020 has reached the database it "
        "names -- see the comment block at that line. If both hold, delete "
        "this test."
    )
