"""The real-R2 harness must fail, not hang, when its server cannot come up.

`ThreadedMotoServer.start()` binds in a worker thread and waits on an event that only the
success path sets. If the bind raises, `start()` waits for ever. The Tests job has no
`timeout-minutes` and the suite has no pytest-timeout, so that is a stuck run rather than
a red one. Round 1 of this harness found a free port, CLOSED it, and only then handed it to
moto, so any process that took the port in between produced exactly that hang (forced
during review: `RealR2.__enter__` did not return or raise within 20 s).
"""

from __future__ import annotations

import socket
import time

import pytest

from tests.real_r2 import _require_moto, start_bounded


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
