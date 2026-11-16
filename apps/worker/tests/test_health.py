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

import os
from collections.abc import Iterator

import pytest
import sentry_sdk
from fastapi.testclient import TestClient
from sentry_sdk.client import BaseClient, NonRecordingClient

from worker.health import app, sentry_state

# Not a real project: ingest.sentry.io/0 accepts no events. No test here sends one.
FAKE_DSN = "https://publickey000@o0.ingest.sentry.io/0"


@pytest.fixture(autouse=True)
def _no_inherited_sentry_dsn(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never let the shell's SENTRY_DSN decide what these tests assert.

    Bare ``sentry_sdk.init()`` READS ``SENTRY_DSN`` from ``os.environ``. Without
    this, ``test_sentry_off_when_init_ran_without_a_usable_dsn`` — the only test
    that pins the ``transport`` half, i.e. this PR's central claim — passes or
    fails depending on the developer's shell, and builds a live transport aimed
    at whatever DSN is exported, plausibly the production one. Same hazard, and
    the same answer, as ``conftest.py``'s ``DATABASE_URL`` guard: the owner's
    shell may export a production value and ``make test-py`` inherits it.
    """
    monkeypatch.delenv("SENTRY_DSN", raising=False)


def _set_client(client: BaseClient) -> None:
    sentry_sdk.get_global_scope().set_client(client)


@pytest.fixture
def restore_sentry_client() -> Iterator[None]:
    """Hand the global scope back its client, whatever these tests do to it."""
    previous = sentry_sdk.get_client()
    try:
        yield
    finally:
        _set_client(previous)


def test_sentry_off_when_init_never_ran(restore_sentry_client: None) -> None:
    """A process that never called init() holds a NonRecordingClient."""
    _set_client(NonRecordingClient())
    assert sentry_state() == "off"


def test_sentry_off_when_init_ran_without_a_usable_dsn(restore_sentry_client: None) -> None:
    """is_active() is True here and the client still cannot send: transport is None.

    This is the case a bare ``is_active()`` check would report as "on", which is
    exactly the false green the field is supposed to prevent — so this test is the
    one that pins the ``transport`` half of ``sentry_state``.

    ``SENTRY_DSN`` is unset by the autouse fixture above, which is what makes bare
    ``init()`` produce a transport-less client rather than a working one.
    """
    assert "SENTRY_DSN" not in os.environ  # the fixture, asserted, not assumed
    sentry_sdk.init()
    assert sentry_sdk.get_client().is_active() is True
    assert sentry_sdk.get_client().transport is None
    assert sentry_state() == "off"


def test_sentry_on_when_initialised(restore_sentry_client: None) -> None:
    """A DSN passed explicitly, so this does not depend on the environment either."""
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
