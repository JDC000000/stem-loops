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


def test_missing_env_skips_cleanly_by_default(monkeypatch):
    # Default (non-strict) behavior: no STRIPE_SECRET_KEY → exit 0 with SKIPPED
    # notice. This prevents the CI job from red-flagging every downstream PR
    # before Jon adds the repo secrets (M-1 would otherwise refuse all merges).
    monkeypatch.delenv("STRIPE_SECRET_KEY")
    monkeypatch.delenv("STRICT_RECON", raising=False)
    assert cpp.main([]) == 0


def test_missing_env_exits_two_with_strict_flag(monkeypatch):
    # Opt-in enforcement: --strict re-enables fail-on-missing-secrets so once
    # the secrets are configured we can't silently regress back to SKIPPED.
    monkeypatch.delenv("STRIPE_SECRET_KEY")
    assert cpp.main(["--strict"]) == 2


def test_missing_env_exits_two_with_strict_env(monkeypatch):
    # STRICT_RECON=1 env is the recommended CI toggle once secrets are in.
    monkeypatch.delenv("STRIPE_SECRET_KEY")
    monkeypatch.setenv("STRICT_RECON", "1")
    assert cpp.main([]) == 2


def test_stripe_error_exits_two():
    with mock.patch("stripe.Price.retrieve", side_effect=RuntimeError("boom")):
        assert cpp.main([]) == 2
