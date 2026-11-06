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


def test_auto_falls_back_to_migration_when_db_down(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    with mock.patch.object(cpp, "prices_from_db", side_effect=OSError("down")), _stripe(MATCH):
        assert cpp.main(["--source", "auto"]) == 0


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


def test_ci_switch_defaults_to_not_forgiving():
    assert 'RECON_ALLOW_UNCONFIGURED: "0"' in _CI.read_text()
    assert "STRICT_RECON" not in _CI.read_text()


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
