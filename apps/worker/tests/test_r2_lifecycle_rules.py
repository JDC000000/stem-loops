"""The R2 lifecycle script must not delete a Pro/Studio library behind the sweep's back.

A whole-bucket "expire after N days" rule cannot tell a Free song from a subscriber's (R2
lifecycle filters by key prefix only; keys are `<job_id>/...` and `jobs/<job_id>/...`), so since
paid-plan retention (2026-11-15) the script sets no expiration unless an operator opts in.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "configure_r2_lifecycle.py"


def _load(monkeypatch, env: str | None):
    if env is None:
        monkeypatch.delenv("R2_LIFECYCLE_EXPIRE_DAYS", raising=False)
    else:
        monkeypatch.setenv("R2_LIFECYCLE_EXPIRE_DAYS", env)
    spec = importlib.util.spec_from_file_location("configure_r2_lifecycle_under_test", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod


def test_default_sets_no_expiration(monkeypatch):
    mod = _load(monkeypatch, None)
    rules = mod.rules()
    assert not [r for r in rules if "Expiration" in r], rules
    assert any("AbortIncompleteMultipartUpload" in r for r in rules)


def test_expiration_only_when_an_operator_asks(monkeypatch):
    mod = _load(monkeypatch, "2")
    (exp,) = [r for r in mod.rules() if "Expiration" in r]
    assert exp["Expiration"] == {"Days": 2}
