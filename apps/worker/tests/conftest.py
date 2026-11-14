"""Shared worker-test fixtures."""

from __future__ import annotations

import functools
import os
from pathlib import Path

import pytest

from tests.db_guard import refuse_unless_local


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


# This file only PARSES URLs and hands them to child pytest processes (which have this guard
# themselves); exempting it lets it assert, without being skipped, that the guard ALLOWS a
# local database. It opens no connection.
_EXEMPT = ("test_real_r2_harness.py",)


@functools.cache
def _module_uses_database(path: str) -> bool:
    return Path(path).name not in _EXEMPT and "DATABASE_URL" in Path(path).read_text()


@pytest.fixture(autouse=True)
def _refuse_a_database_that_is_not_local(request: pytest.FixtureRequest) -> None:
    """Never run a DB-backed test against a database that is not this machine's.

    The owner's shell may export a PRODUCTION `DATABASE_URL`, and `make test-py` inherits it;
    about thirty test files read that variable and several run destructive SQL against it
    (the retention sweep, schema tests). Every test in a module that mentions DATABASE_URL
    is skipped (locally) or failed (under CI) unless the variable is provably local. Modules
    that never mention it are untouched. See `tests/db_guard.py` for what "local" means.
    """
    url = os.environ.get("DATABASE_URL")
    if url and _module_uses_database(str(request.node.fspath)):
        refuse_unless_local(("DATABASE_URL", url))
