"""/health reports whether Sentry initialised — and never any part of the DSN.

Why the field exists: main.py's ``if os.environ.get("SENTRY_DSN"): sentry_sdk.init(...)``
is silent in both directions, so "is Sentry on in the Fly worker?" could only be
answered from the Fly dashboard. One GET answers it now.

The state is read from the SDK, so these tests drive the SDK's real client rather
than the env var. ``sentry_config.py``'s own suite calls ``sentry_sdk.init()`` in
the same pytest process, so every test here installs the client it wants and the
fixture puts the previous one back.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
import sentry_sdk
from fastapi.testclient import TestClient
from sentry_sdk.client import NonRecordingClient

from worker.health import app, sentry_state

# Not a real project: ingest.sentry.io/0 accepts no events. No test here sends one.
FAKE_DSN = "https://publickey000@o0.ingest.sentry.io/0"


@pytest.fixture
def restore_sentry_client() -> Iterator[None]:
    """Hand the global scope back its client, whatever these tests do to it."""
    previous = sentry_sdk.get_client()
    try:
        yield
    finally:
        sentry_sdk.get_global_scope().set_client(previous)


def _set_client(client: object) -> None:
    sentry_sdk.get_global_scope().set_client(client)


def test_sentry_off_when_init_never_ran(restore_sentry_client: None) -> None:
    """A process that never called init() holds a NonRecordingClient."""
    _set_client(NonRecordingClient())
    assert sentry_state() == "off"


def test_sentry_off_when_init_ran_without_a_usable_dsn(restore_sentry_client: None) -> None:
    """is_active() is True here and the client still cannot send: transport is None.

    This is the case a bare ``is_active()`` check would report as "on", which is
    exactly the false green the field is supposed to prevent.
    """
    sentry_sdk.init()
    assert sentry_sdk.get_client().is_active() is True
    assert sentry_state() == "off"


def test_sentry_on_when_initialised(restore_sentry_client: None) -> None:
    sentry_sdk.init(dsn=FAKE_DSN)
    try:
        assert sentry_state() == "on"
    finally:
        sentry_sdk.get_client().close()


def test_health_endpoint_reports_both_states_and_leaks_no_dsn(
    restore_sentry_client: None,
) -> None:
    client = TestClient(app)

    _set_client(NonRecordingClient())
    off = client.get("/health")
    assert off.status_code == 200
    assert off.json() == {"status": "ok", "sentry": "off"}

    sentry_sdk.init(dsn=FAKE_DSN)
    try:
        on = client.get("/health")
    finally:
        sentry_sdk.get_client().close()
    assert on.status_code == 200
    assert on.json() == {"status": "ok", "sentry": "on"}

    # The DSN is a credential. Nothing of it — not the key, not the host, not the
    # project id — may appear anywhere in the response, headers included.
    for response in (off, on):
        body = response.text + str(dict(response.headers))
        for secret in (FAKE_DSN, "publickey000", "o0.ingest.sentry.io"):
            assert secret not in body
