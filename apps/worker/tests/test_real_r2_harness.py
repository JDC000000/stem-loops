"""The real-R2 harness must fail, not hang, when its server cannot come up.

`ThreadedMotoServer.start()` binds in a worker thread and waits on an event that only the
success path sets. If the bind raises, `start()` waits for ever. The suite has no
pytest-timeout, so without `start_bounded` that is a stuck run rather than a red one: the
Tests job now has `timeout-minutes: 30` (added in this PR), which bounds it at half an hour
and then CANCELS the run with no test named, whereas `start_bounded` fails the one test
within 30 s. Round 1 of this harness found a free port, CLOSED it, and only then handed it to
moto, so any process that took the port in between produced exactly that hang (forced
during review: `RealR2.__enter__` did not return or raise within 20 s).
"""

from __future__ import annotations

import socket
import time

import pytest

from tests.real_r2 import (
    CHORDS_SHAPE,
    FIX_PROBE,
    _require_moto,
    assert_chords_gone_or_xfail,
    per_job_delete_covers_the_chords_namespace,
    start_bounded,
)
from worker.storage import r2_uploader


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_a_server_that_cannot_bind_fails_the_start_within_the_deadline():
    # moto's worker thread dies with OSError(EADDRINUSE); pytest reports that as a warning.
    ThreadedMotoServer = _require_moto()
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen(1)
        port = taken.getsockname()[1]
        server = ThreadedMotoServer(ip_address="127.0.0.1", port=port, verbose=False)

        t0 = time.monotonic()
        with pytest.raises(pytest.fail.Exception, match="did not come up"):
            start_bounded(server, deadline_sec=3.0)
        elapsed = time.monotonic() - t0

    assert elapsed < 10, f"the bounded start took {elapsed:.1f}s to give up"


def test_port_zero_gets_a_real_loopback_port_chosen_by_the_kernel():
    ThreadedMotoServer = _require_moto()
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    start_bounded(server)
    try:
        host, port = server.get_host_and_port()
        assert host == "127.0.0.1"
        assert port > 0
    finally:
        server.stop()


# ---------------------------------------------- the chords xfail cannot be a permanent hatch


class _BucketWithChords:
    """Just enough of `RealR2` for `assert_chords_gone_or_xfail`, which only lists keys.

    A stand-in is correct here: the property under test is the helper's branch on the
    capability probe, not S3. It is the only stub in this section.
    """

    def __init__(self, keys):
        self._keys = set(keys)

    def all_keys(self):
        return set(self._keys)


_SHAPES = {CHORDS_SHAPE: "11111111-1111-4111-8111-111111111111/play.chords.json"}


def test_a_surviving_chords_object_may_xfail_only_while_the_fix_is_absent(monkeypatch):
    monkeypatch.delattr(r2_uploader, FIX_PROBE, raising=False)
    assert not per_job_delete_covers_the_chords_namespace()
    with pytest.raises(pytest.xfail.Exception, match=FIX_PROBE):
        assert_chords_gone_or_xfail(_BucketWithChords(_SHAPES.values()), _SHAPES)


def test_a_surviving_chords_object_FAILS_once_the_fix_is_present(monkeypatch):
    """With #214's capability in the code under test, the xfail must not be available."""
    monkeypatch.setattr(r2_uploader, FIX_PROBE, lambda job_id: (f"{job_id}/",), raising=False)
    assert per_job_delete_covers_the_chords_namespace()
    with pytest.raises(pytest.fail.Exception, match="REGRESSED"):
        assert_chords_gone_or_xfail(_BucketWithChords(_SHAPES.values()), _SHAPES)


@pytest.mark.parametrize("fix_present", [False, True])
def test_a_deleted_chords_object_passes_either_way(monkeypatch, fix_present):
    if fix_present:
        monkeypatch.setattr(r2_uploader, FIX_PROBE, lambda job_id: (), raising=False)
    else:
        monkeypatch.delattr(r2_uploader, FIX_PROBE, raising=False)
    assert_chords_gone_or_xfail(_BucketWithChords([]), _SHAPES)
