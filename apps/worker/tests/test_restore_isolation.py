"""QA-66 (#308 review L-1): an allowance-restore error is isolated. Offline, no database.

restore_allowance_if_owed runs in its own SAVEPOINT; a non-42883 error used to propagate,
rolling back the reaper's per-job savepoint (the failure AND the credit refund) and fail_job's
second transaction (the credit refund, logged as the misleading ``credit_refund_failed``).
restore_allowance_isolated catches it. The real-database behaviour is pinned in CI by
test_refund_reaped_jobs.py and test_allowance_restore.py; these pin the wiring with fakes.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from worker import job_failure, reaper


class Boom(Exception):
    pass


@pytest.fixture
def captured(monkeypatch):
    sent: list[BaseException] = []
    monkeypatch.setattr(job_failure.sentry_sdk, "capture_exception", sent.append)
    return sent


def _events(capsys) -> list[dict]:
    return [json.loads(line) for line in capsys.readouterr().err.splitlines() if line]


def test_isolated_restore_swallows_logs_and_reports(monkeypatch, captured, capsys):
    async def broken(conn, job_id):
        raise Boom("permission denied for function restore_job_allowance")

    monkeypatch.setattr(job_failure, "restore_allowance_if_owed", broken)
    got = asyncio.run(job_failure.restore_allowance_isolated(None, "j1", stage="reaper"))
    assert got is None
    assert len(captured) == 1 and isinstance(captured[0], Boom)
    (ev,) = _events(capsys)
    assert ev["level"] == "ERROR" and ev["event"] == "allowance_restore_failed"
    detail = json.loads(ev["detail"])
    assert detail["stage"] == "reaper" and detail["job_id"] == "j1"


def test_isolated_restore_passes_the_result_through(monkeypatch, captured):
    async def ok(conn, job_id):
        return "allowance"

    monkeypatch.setattr(job_failure, "restore_allowance_if_owed", ok)
    assert asyncio.run(job_failure.restore_allowance_isolated(None, "j", stage="x")) == "allowance"
    assert captured == []


class _Cur:
    def __init__(self, row):
        self.row = row

    async def fetchone(self):
        return self.row


class _Conn:
    def __init__(self, log):
        self.log = log

    async def execute(self, sql, params=None):
        self.log.append("fail_sql")
        return _Cur(("id",))

    async def commit(self):
        self.log.append("commit")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def test_fail_job_keeps_the_refund_when_the_restore_breaks(monkeypatch, captured, capsys):
    log: list[str] = []

    async def connect(url):
        return _Conn(log)

    async def refund(conn, job_id):
        log.append("refund")
        return True

    async def broken(conn, job_id):
        log.append("restore")
        raise Boom("x")

    monkeypatch.setattr(job_failure.psycopg.AsyncConnection, "connect", connect)
    monkeypatch.setattr(job_failure, "refund_if_owed", refund)
    monkeypatch.setattr(job_failure, "restore_allowance_if_owed", broken)
    assert asyncio.run(job_failure.fail_job("db", "j", "INTERNAL_ERROR", "m")) is True
    # 1st tx: fail, restore (broken), COMMIT. 2nd tx: refund, restore (broken), COMMIT.
    assert log == ["fail_sql", "restore", "commit", "refund", "restore", "commit"]
    events = [(e["event"], json.loads(e["detail"]).get("stage")) for e in _events(capsys)]
    assert ("allowance_restore_failed", "fail_job") in events
    assert ("allowance_restore_failed", "fail_job_retry") in events
    assert all(name != "credit_refund_failed" for name, _ in events)


def test_fail_job_still_names_a_real_refund_error_credit_refund_failed(
    monkeypatch, captured, capsys
):
    log: list[str] = []

    async def connect(url):
        return _Conn(log)

    async def refund(conn, job_id):
        raise Boom("refund broke")

    async def ok(conn, job_id):
        return None

    monkeypatch.setattr(job_failure.psycopg.AsyncConnection, "connect", connect)
    monkeypatch.setattr(job_failure, "refund_if_owed", refund)
    monkeypatch.setattr(job_failure, "restore_allowance_if_owed", ok)
    asyncio.run(job_failure.fail_job("db", "j", "INTERNAL_ERROR", "m"))
    assert [e["event"] for e in _events(capsys)] == ["credit_refund_failed"]


def test_the_reaper_uses_the_isolated_restore():
    import inspect

    src = inspect.getsource(reaper._fail_and_refund_each)
    assert "restore_allowance_isolated(" in src
    assert "restore_allowance_if_owed(" not in src
