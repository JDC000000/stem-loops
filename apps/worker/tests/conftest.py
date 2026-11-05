"""Shared worker-test fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolate_klangio_quota(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Never let a test touch a real Klangio spend counter.

    ``recognize()`` counts a billable request before it sends one. Without this,
    any test that reaches it writes to ``/tmp/klangio_quota.json`` (or, with
    ``DATABASE_URL`` set, to ``public.klangio_usage``). Pin the file backend at a
    per-test tmp path; tests that exercise the Postgres store opt in explicitly.
    """
    monkeypatch.setenv("KLANGIO_QUOTA_BACKEND", "file")
    monkeypatch.setenv("KLANGIO_QUOTA_FILE", str(tmp_path / "klangio_quota.json"))
