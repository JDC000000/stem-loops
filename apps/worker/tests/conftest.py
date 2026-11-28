"""Shared worker-test fixtures."""

from __future__ import annotations

import functools
import os
import sys
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


@pytest.fixture(autouse=True)
def _reset_klangio_breaker(monkeypatch: pytest.MonkeyPatch):
    """K-2: the Klangio submit circuit breaker is process-wide state. Start every test
    closed with the default thresholds, so one test's unanswered POSTs cannot make a later
    test's submit "paused". Only touches the module if something already imported it."""
    monkeypatch.delenv("KLANGIO_BREAKER_FAILURES", raising=False)
    monkeypatch.delenv("KLANGIO_BREAKER_PAUSE_SEC", raising=False)
    mod = sys.modules.get("worker.chord_providers.klangio")
    if mod is not None:
        mod._BREAKER.reset()
    yield
    mod = sys.modules.get("worker.chord_providers.klangio")
    if mod is not None:
        mod._BREAKER.reset()


@pytest.fixture(autouse=True)
def _quiet_fetch_alerting(monkeypatch: pytest.MonkeyPatch) -> None:
    """QA-61 fetch alerting is process-global state; give every test a clean slate.

    * The fetch canary is OFF unless a test turns it on: a test that drives
      ``consumer.poll_loop`` must never start a thread running real yt-dlp through whatever
      ``PROXY_URL`` the shell exports.
    * The burst detector's streak and the once-per-cause proxy reports are reset, so a test
      that fails three downloads cannot make a later test's first failure "the fourth".
    """
    from worker import fetch_alerts, fetch_canary

    monkeypatch.setenv("FETCH_CANARY_INTERVAL_SECONDS", "0")
    monkeypatch.delenv("FETCH_CANARY_PROXY_ALERT_AFTER", raising=False)
    fetch_alerts.rearm_proxy_failure_reports()
    fetch_alerts.burst_detector.record_success()
    fetch_canary.reset_state()


@pytest.fixture(autouse=True)
def _fresh_ytdlp_attempt_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """#513: ``ytdlp_client._attempt`` is process-wide (thread-local) per-attempt state.

    ``download_audio()`` arms ``stall_cut=True`` (and ``set_declared_duration``) before a
    non-final attempt; the real ``fetch_audio_file`` consumes it at once, but a test that
    fakes ``fetch_audio_file`` (test_fetch_chain, test_link_duration_cap, ...) leaves it
    armed, so a later direct ``fetch_audio_file`` call got a 15 s stall cut it never asked
    for. Give every test a fresh, unarmed attempt; monkeypatch restores the original after.
    """
    import threading

    from worker.downloader import ytdlp_client

    monkeypatch.setattr(ytdlp_client, "_attempt", threading.local())


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
