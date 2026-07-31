"""Hardening H1: a superseded worker's writes must become no-ops, not corruption.

The reaper re-queues a stale job and bumps jobs.attempts; the original worker may
still be alive (that is the whole race). These tests cover the fencing primitives
in job_state.py without needing a database — the DB-backed proof that a fenced
UPDATE matches 0 rows lives in the SQL itself (WHERE … AND attempts=%s).
"""

from unittest.mock import patch

import pytest

from worker.errors import JobSupersededError
from worker.job_state import Heartbeat, heartbeat


class _FakeCursor:
    def __init__(self, rowcount):
        self.rowcount = rowcount


class _FakeConn:
    def __init__(self, rowcount=1, raises=None):
        self._rowcount = rowcount
        self._raises = raises
        self.statements = []

    def execute(self, sql, params=None):
        if self._raises:
            raise self._raises
        self.statements.append((sql, params))
        return _FakeCursor(self._rowcount)

    def commit(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_heartbeat_is_fenced_on_attempts():
    conn = _FakeConn(rowcount=1)
    with patch("worker.job_state._db", return_value=conn):
        assert heartbeat("job-1", attempt=3) is True
    sql, params = conn.statements[0]
    assert "attempts=%s" in sql and params == ("job-1", 3)


def test_heartbeat_reports_supersession_when_no_row_matches():
    """attempts moved on (reaper re-queued) or the row is gone → we do not own it."""
    with patch("worker.job_state._db", return_value=_FakeConn(rowcount=0)):
        assert heartbeat("job-1", attempt=3) is False


def test_heartbeat_without_attempt_is_unfenced():
    conn = _FakeConn(rowcount=1)
    with patch("worker.job_state._db", return_value=conn):
        assert heartbeat("job-1") is True
    sql, _ = conn.statements[0]
    assert "attempts" not in sql


def test_db_error_does_not_look_like_supersession():
    """A connection blip is not evidence the job was taken away — never abort on it."""
    with patch("worker.job_state._db", side_effect=RuntimeError("connection reset")):
        assert heartbeat("job-1", attempt=3) is True


def test_heartbeat_object_raises_when_superseded():
    hb = Heartbeat("job-1", attempt=3, interval=0)
    with patch("worker.job_state._db", return_value=_FakeConn(rowcount=0)):
        with pytest.raises(JobSupersededError):
            hb.beat()


def test_heartbeat_object_is_throttled():
    """beat() is called per loop/per stem — it must not open a connection each time."""
    conn = _FakeConn(rowcount=1)
    hb = Heartbeat("job-1", attempt=1, interval=3600)
    with patch("worker.job_state._db", return_value=conn):
        for _ in range(50):
            hb.beat()
        assert conn.statements == []  # nothing yet: the interval has not elapsed
        hb.beat(force=True)
    assert len(conn.statements) == 1
