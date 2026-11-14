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

import functools
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from tests.real_r2 import (
    CHORDS_SHAPE,
    FIX_PROBE,
    _require_moto,
    assert_chords_gone_or_xfail,
    database_url_problem,
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
    capability probe, not S3. It is not the only thing replaced in this section: the tests
    below also `setattr` / `delattr` `r2_uploader.FIX_PROBE` (`job_object_prefixes`) through
    `monkeypatch`, which is how they choose a branch. They pin the branches for the CURRENT
    probe name; a rename of the capability is not visible to them (see the docstring of
    `assert_chords_gone_or_xfail`, and its merge obligation).
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


# ------------------------------- the retention tests must refuse a database that is not local
#
# The DB-backed retention tests run the REAL destructive sweep (DELETE FROM jobs, anonymising
# charged job shells) against whatever DATABASE_URL names; only R2 is fake. Until round 4 one
# fixture checked locality (by substring) and only because it inserts into auth.users. The
# guard is `require_database()`, and these tests are what make it a guard rather than a comment.

# Hosts below end in `.invalid` (RFC 6761): a name that can never resolve, so even a broken guard
# cannot reach a real server from these tests; it would fail with a resolver error instead.
LOCAL_URLS = [
    # CI's, verbatim (.github/workflows/ci.yml `Tests` job): the guard must not weaken CI.
    "postgresql://stemloops:stemloops@localhost:5432/stemloops",
    "postgresql://u:p@127.0.0.1:5432/d",
    "postgres://u@LOCALHOST/d",
    "postgresql://u:p@[::1]:5432/d",
    "postgresql://u@127.0.0.1,localhost/d",
    "postgresql:///d",  # no host: the local unix socket
    "postgresql:///d?host=/var/run/postgresql",
    "host=localhost port=5432 dbname=d user=u",
    "host=/var/run/postgresql dbname=d",
]
NON_LOCAL_URLS = {
    "plain remote host": "postgresql://u:p@db.prod.invalid:5432/prod",
    "supabase pooler": "postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres",
    # The #226 reviewer's class of bug: the local-looking text is not the host.
    "127.0.0.1 in a query value": "postgres://u@db.prod.invalid/db?application_name=127.0.0.1",
    "localhost in the password": "postgresql://u:localhost@db.prod.invalid/db",
    "localhost in the database name": "postgresql://u@db.prod.invalid/localhost",
    "localhost as a subdomain": "postgresql://u@localhost.db.prod.invalid/db",
    "127.0.0.1 as a subdomain": "postgresql://u@127.0.0.1.db.prod.invalid/db",
    "localhost as the userinfo, remote as the host": "postgresql://u:p@localhost@db.prod.invalid/db",
    "query host overrides a local authority": "postgresql://localhost/db?host=db.prod.invalid",
    "hostaddr names a remote machine": "postgresql://localhost/db?hostaddr=203.0.113.9",
    "one remote host in a multi-host list": "postgresql://localhost,db.prod.invalid/db",
    "key=value form": "host=db.prod.invalid dbname=d options='-c application_name=localhost'",
    "pg_service.conf service": "postgresql://localhost/db?service=prod",
    "unspecified address": "postgresql://0.0.0.0/db",
    "not a connection string": "x=",
}


@pytest.mark.parametrize("url", LOCAL_URLS)
def test_a_local_database_is_accepted(url):
    assert database_url_problem(url, environ={}) is None


@pytest.mark.parametrize("name", sorted(NON_LOCAL_URLS))
def test_a_database_that_is_not_local_is_refused(name):
    problem = database_url_problem(NON_LOCAL_URLS[name], environ={})
    assert problem, f"{name}: {NON_LOCAL_URLS[name]!r} was accepted as local"


def test_a_url_without_a_host_is_judged_by_the_environment_libpq_will_consult():
    assert database_url_problem("postgresql:///d", environ={"PGHOST": "db.prod.invalid"})
    assert database_url_problem("postgresql:///d", environ={"PGHOSTADDR": "203.0.113.9"})
    assert database_url_problem("postgresql:///d", environ={"PGSERVICE": "prod"})
    assert database_url_problem("postgresql:///d", environ={"PGHOST": "localhost"}) is None


def _pytest(env_overrides: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    """A child pytest over the DB-backed retention tests, with DATABASE_URL overridden."""
    worker = Path(__file__).resolve().parents[1]
    env = {k: v for k, v in os.environ.items() if k not in ("CI", "DATABASE_URL")}
    env.update(env_overrides)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        [sys.executable, "-B", "-m", "pytest", "-q", "-p", "no:cacheprovider", *args],
        cwd=worker,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )


DB_BACKED = (
    "tests/test_retention_real_r2.py",
    "tests/test_consumer_sweep_wiring.py::test_poll_loop_startup_sweep_removes_an_expired_jobs_objects_from_real_r2",
)
# Nothing listens there and the name cannot resolve: if the guard were absent the first
# connection would fail with a resolver error, which is a FAILURE and not a skip.
PROD_LOOKING = "postgresql://u:p@db.prod.invalid:5432/prod?application_name=127.0.0.1"


@functools.cache
def _collected() -> int:
    out = _pytest({"DATABASE_URL": PROD_LOOKING}, "--collect-only", *DB_BACKED).stdout
    m = re.search(r"(\d+) tests? collected", out)
    assert m, out[-500:]
    return int(m.group(1))


def test_every_db_backed_retention_test_skips_locally_on_a_non_local_database():
    """The audit, executed: run EVERY DB-backed test in this PR's files against a database
    that is not local. Not one may pass (a pass is a test that reached the database) or fail
    (a failure is a connection attempt that got as far as a resolver error)."""
    n = _collected()
    assert n >= 15, f"expected the whole retention module and the chain test, got {n}"
    done = _pytest({"DATABASE_URL": PROD_LOOKING}, "-rs", *DB_BACKED)
    summary = done.stdout.strip().splitlines()[-1]
    assert re.fullmatch(rf"{n} skipped in [\d.]+s", summary), done.stdout[-1500:]
    assert "not provably local" in done.stdout


def test_every_db_backed_retention_test_fails_under_ci_on_a_non_local_database():
    """Under CI=true a refusal is a FAILURE, never a silent skip, and still never a connection."""
    n = _collected()
    done = _pytest({"DATABASE_URL": PROD_LOOKING, "CI": "true"}, *DB_BACKED)
    summary = done.stdout.strip().splitlines()[-1]
    counts = {w: int(c) for c, w in re.findall(r"(\d+) (failed|errors?|passed|skipped)", summary)}
    # A fixture that fails is reported as an error, a test body that fails as a failure.
    assert counts.get("failed", 0) + counts.get("error", 0) + counts.get("errors", 0) == n, summary
    assert "passed" not in counts and "skipped" not in counts, summary
    assert "not provably local" in done.stdout
    assert "OperationalError" not in done.stdout and "translate host name" not in done.stdout


def test_the_sweeps_own_database_url_is_checked_too(monkeypatch):
    """`cleanup.DATABASE_URL` is what the sweep connects with; it was read at import and is
    not the environment variable as it is now."""
    from tests.real_r2 import require_database
    from worker import cleanup

    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost:5432/d")
    monkeypatch.setattr(cleanup, "DATABASE_URL", PROD_LOOKING)
    monkeypatch.delenv("CI", raising=False)
    with pytest.raises(pytest.skip.Exception, match="cleanup.DATABASE_URL is not provably local"):
        require_database()


# ------------- the PRE-EXISTING DB-backed tests (not this PR's files) are behind the same guard
# `test_cleanup.py` skipped only when DATABASE_URL was UNSET, so a production URL ran its eight
# `r2`-fixture tests (the real sweep, with R2 faked); about thirty files read the variable.
# `conftest.py` now refuses a non-local one for every test in a module that mentions it.

PRE_EXISTING = (
    "tests/test_cleanup.py",
    "tests/test_claim_jobs.py",
    "tests/test_credit_consume.py",
    "tests/test_013_commercial_schema.py",
)


def _counts(summary: str) -> dict[str, int]:
    return {w: int(c) for c, w in re.findall(r"(\d+) (failed|errors?|passed|skipped)", summary)}


def test_pre_existing_db_tests_skip_on_a_non_local_database():
    done = _pytest({"DATABASE_URL": PROD_LOOKING}, "-rs", *PRE_EXISTING)
    counts = _counts(done.stdout.strip().splitlines()[-1])
    assert set(counts) == {"skipped"}, done.stdout[-1500:]
    assert "not provably local" in done.stdout


def test_pre_existing_db_tests_fail_under_ci_on_a_non_local_database():
    done = _pytest({"DATABASE_URL": PROD_LOOKING, "CI": "true"}, *PRE_EXISTING)
    counts = _counts(done.stdout.strip().splitlines()[-1])
    assert counts and set(counts) <= {"failed", "error", "errors"}, done.stdout[-1500:]
    assert "OperationalError" not in done.stdout and "translate host name" not in done.stdout


def test_pre_existing_db_tests_still_run_on_this_runs_local_database():
    """The ALLOW half: a guard that refused everything would pass the two tests above."""
    url = os.environ.get("DATABASE_URL")
    if not url or database_url_problem(url):
        pytest.skip("this run has no local DATABASE_URL to hand to the child")
    done = _pytest({"DATABASE_URL": url}, "tests/test_cleanup.py")
    counts = _counts(done.stdout.strip().splitlines()[-1])
    assert counts.get("passed", 0) >= 8 and "failed" not in counts, done.stdout[-1500:]
