"""One place that decides whether a test may talk to the database `DATABASE_URL` names.

Many worker tests run DESTRUCTIVE SQL against that database (the retention sweep deletes job
rows and anonymises charged shells; others create and drop tables). The owner's shell can have
a production `DATABASE_URL` exported, and `make test-py` inherits it. So a non-local database
is REFUSED: skipped locally, failed under CI (a skipped gate is a gate that did not run), and
never connected to. Used by `conftest.py` (every test in a module that mentions DATABASE_URL),
by `test_cleanup.py`'s fixtures and by `real_r2.require_database`.
"""

from __future__ import annotations

import ipaddress
import os

import pytest
from psycopg.conninfo import conninfo_to_dict


def skip_or_fail(reason: str) -> None:
    """A precondition is missing: SKIP locally, FAIL under CI.

    Under GitHub Actions (`CI=true`) a skipped test is a gate that silently did not run,
    which is the failure mode these tests exist to remove. Locally a developer without a
    database or without moto still gets a clean skip with the reason.
    """
    if os.environ.get("CI"):
        pytest.fail("CI=true but " + reason, pytrace=False)
    pytest.skip(reason)


def _is_local_host(host: str) -> bool:
    """One entry of a libpq host/hostaddr list: loopback, or a unix-socket directory."""
    host = host.strip()
    if host == "":
        return True  # libpq's default: the local unix socket
    if host.startswith("/"):
        return True  # a unix-socket directory
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False  # any other NAME, however much it looks like 127.0.0.1


def database_url_problem(url: str | None, environ=None) -> str | None:
    """Why `url` may reach a database that is not this machine's, or None if it cannot.

    The question is "where will libpq connect", so the URL is PARSED by libpq's own parser
    (`conninfo_to_dict`, which also reads the key=value form) and the HOSTS are compared,
    not the text. A substring test (`"127.0.0.1" in url`) accepts
    `postgres://u@prod.example.com/db?application_name=127.0.0.1`, and a `localhost`
    authority with a `?host=prod.example.com` query (a query `host` overrides the authority).

    Every host in a multi-host list must be local. A URL with no host at all connects to
    whatever `PGHOST` names, so that variable (and `PGHOSTADDR`) is read too. `service=`
    (a pg_service.conf entry) can name any host and cannot be resolved here: refused.
    """
    environ = os.environ if environ is None else environ
    try:
        info = conninfo_to_dict(url or "")
    except Exception as e:  # noqa: BLE001 -- an unparseable URL is not provably local
        return f"it does not parse as a libpq connection string ({type(e).__name__})"
    if info.get("service") or (not info.get("host") and environ.get("PGSERVICE")):
        return "it names a pg_service.conf service, whose host cannot be checked here"
    host = info.get("host") or environ.get("PGHOST") or ""
    hostaddr = info.get("hostaddr") or environ.get("PGHOSTADDR") or ""
    for label, value in (("host", host), ("hostaddr", hostaddr)):
        for entry in value.split(","):
            if not _is_local_host(entry):
                return f"its {label} {entry.strip()!r} is not this machine"
    return None


def refuse_unless_local(*urls: tuple[str, str | None]) -> None:
    """Skip (local) / fail (CI) unless every `(name, url)` is provably local. Never connects."""
    for name, value in urls:
        problem = database_url_problem(value)
        if problem:
            skip_or_fail(
                f"{name} is not provably local ({problem}), and these tests run destructive "
                "SQL against it. Point it at a throwaway local Postgres; it is never connected to"
            )
