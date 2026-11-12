"""A REAL S3 server for the tests that must execute `r2_uploader`'s real deleters.

WHY THIS EXISTS. `test_cleanup.py` replaces ALL THREE R2 helpers the retention sweep
calls (`delete_prefix`, `list_objects_older_than`, `delete_objects`) with an in-memory
`FakeR2`. So the code that actually deletes a user's audio in production -- the boto3
calls in `r2_uploader.py` -- was executed by no test at all. Three mutants measured
against `7d3f8eec` left the worker suite at 842 passed / 1 skipped / 1 xfailed:

  * `delete_prefix` deletes nothing
  * the sweep deletes only `<id>/_input*`
  * `_safe_sweep` returns before sweeping

This module gives a test a bucket on a `moto` S3 server reachable over HTTP, with the
env the real `r2_uploader._r2()` reads pointed at it, so `cleanup.sweep_expired()` runs
the genuine helpers against genuine S3 semantics (listing, pagination, delete).

NOTHING HERE CAN REACH CLOUDFLARE. The endpoint is a loopback port moto bound itself,
the credentials are the literal string "testing", and `RealR2.__enter__` refuses to
continue unless the boto3 client the product code will use reports a 127.0.0.1 endpoint.

THE ONE THING MOTO CANNOT DO OVER HTTP is back-date an object's LastModified (S3 has no
API for it), and the orphan sweep's age cutoff is the thing under test. `RealR2.put`
therefore edits moto's in-process backend -- and then READS THE AGE BACK THROUGH THE REAL
LIST CALL and fails loudly if it did not take, so a future moto that moves its internals
turns the tests red instead of silently seeding every object as brand new.
"""

from __future__ import annotations

import os
import threading
import urllib.request
from datetime import UTC, datetime, timedelta

import pytest

from worker.storage import r2_uploader

# moto lives in requirements-dev.txt, not the production image. When it is missing:
#   * under CI (GitHub Actions sets CI=true) the test FAILS, loudly: a silent skip is the
#     failure mode this file exists to remove;
#   * anywhere else it SKIPS with a reason that says what to install.
MOTO_MISSING = (
    "moto is not installed, so the retention tests that run r2_uploader's REAL deleters "
    "cannot run. Install it: cd apps/worker && pip install -r requirements.txt "
    "-r requirements-dev.txt -c constraints-prod.txt"
)


def _require_moto():
    try:
        from moto.server import ThreadedMotoServer
    except ImportError:
        skip_or_fail(MOTO_MISSING)
    return ThreadedMotoServer


BUCKET = "retention-real-r2-test"

_PROXY_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy")


SERVER_START_DEADLINE_SEC = 30.0


def start_bounded(server, deadline_sec: float = SERVER_START_DEADLINE_SEC) -> None:
    """`server.start()`, but a failure to bind FAILS the test instead of hanging forever.

    moto's `ThreadedMotoServer.start()` binds inside a worker thread and then waits on an
    event that only the success path sets. If the bind raises (port taken, address
    refused), the thread dies, nothing sets the event, and `start()` waits for ever: with
    no pytest-timeout and no `timeout-minutes` on the CI job, that is a stuck run, not a
    red one. Measured on moto 5.2.5 against a port already in use.
    """
    t = threading.Thread(target=server.start, daemon=True, name="moto-start")
    t.start()
    t.join(deadline_sec)
    if t.is_alive():
        pytest.fail(
            f"the moto S3 server did not come up within {deadline_sec:.0f}s (its bind most "
            "likely failed inside moto's worker thread, which then waits for ever).",
            pytrace=False,
        )


def skip_or_fail(reason: str) -> None:
    """A precondition is missing: SKIP locally, FAIL under CI.

    Under GitHub Actions (`CI=true`) a skipped test is a gate that silently did not run,
    which is the failure mode these tests exist to remove. Locally a developer without a
    database or without moto still gets a clean skip with the reason.
    """
    if os.environ.get("CI"):
        pytest.fail("CI=true but " + reason, pytrace=False)
    pytest.skip(reason)


def require_database() -> str:
    """The `DATABASE_URL` these tests need, or skip (local) / fail (CI) with the reason."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        skip_or_fail("DATABASE_URL is not set, so the DB-backed retention tests cannot run")
    return url


class RealR2:
    """Context manager: a moto S3 server + the env `r2_uploader` reads, restored on exit."""

    def __init__(self, monkeypatch):
        self._mp = monkeypatch
        self._server = None
        self.client = None
        self.endpoint = ""

    def __enter__(self) -> RealR2:
        ThreadedMotoServer = _require_moto()
        # port=0: the kernel picks a free port AT BIND TIME, so there is no window between
        # "find a free port" and "bind it" for another process to take it.
        self._server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
        start_bounded(self._server)
        host, port = self._server.get_host_and_port()
        self.endpoint = f"http://{host}:{port}"

        mp = self._mp
        mp.setenv("R2_ENDPOINT_URL", self.endpoint)
        mp.setenv("R2_ACCESS_KEY_ID", "testing")
        mp.setenv("R2_SECRET_ACCESS_KEY", "testing")
        mp.setenv("R2_BUCKET_NAME", BUCKET)
        mp.setenv("AWS_DEFAULT_REGION", "us-east-1")
        # The sandbox routes HTTP(S) through a proxy; a loopback server must bypass it.
        for var in _PROXY_VARS:
            mp.delenv(var, raising=False)
        mp.setenv("NO_PROXY", "*")
        mp.setenv("no_proxy", "*")

        r2_uploader._r2.cache_clear()
        self.client = r2_uploader._r2()
        # The safety interlock: the client the PRODUCT code uses must be our loopback.
        assert self.client.meta.endpoint_url == self.endpoint, (
            f"r2_uploader built a client for {self.client.meta.endpoint_url!r}, "
            f"not the test server {self.endpoint!r}"
        )
        assert self.client.meta.endpoint_url.startswith("http://127.0.0.1:")
        # moto's backend is process-global, so a bucket (and its objects) outlives the
        # server that created it. Start every test from an empty world.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        opener.open(
            urllib.request.Request(f"{self.endpoint}/moto-api/reset", method="POST"), timeout=10
        ).read()
        self.client.create_bucket(Bucket=BUCKET)
        assert self.all_keys() == set(), "the test bucket must start empty"
        return self

    def __exit__(self, *exc) -> None:
        try:
            if self._server is not None:
                self._server.stop()
        finally:
            # Never leave a client cached against a dead port for the next test file.
            r2_uploader._r2.cache_clear()

    # ----------------------------------------------------------------- seeding

    def put(self, key: str, age_hours: float = 0.0, body: bytes = b"x") -> None:
        """Write one object through the S3 API, then back-date its LastModified."""
        self.client.put_object(Bucket=BUCKET, Key=key, Body=body)
        self.age(key, age_hours)

    def age(self, key: str, age_hours: float) -> None:
        """Make an existing object `age_hours` old, and PROVE it through the real list API."""
        self.age_many([key], age_hours)

    def age_many(self, keys: list[str], age_hours: float) -> None:
        """Back-date every key in `keys` at once, then PROVE each through one real listing."""
        if not age_hours or not keys:
            return
        from moto.s3.models import s3_backends

        bucket = None
        for account in s3_backends:
            for partition in s3_backends[account]:
                bucket = s3_backends[account][partition].buckets.get(BUCKET)
                if bucket is not None:
                    break
            if bucket is not None:
                break
        assert bucket is not None, "moto backend has no test bucket; its internals moved"
        # moto stores a naive UTC datetime.
        stamp = datetime.now(UTC).replace(tzinfo=None) - timedelta(hours=age_hours)
        for key in keys:
            bucket.keys[key].last_modified = stamp
        seen = self.listing()
        now = datetime.now(UTC)
        for key in keys:
            got_hours = (now - seen[key]).total_seconds() / 3600
            assert abs(got_hours - age_hours) < 0.05, (
                f"back-dating {key!r} to {age_hours}h did not take: the real list call "
                f"reports {got_hours:.3f}h. Every 'old' object in this test would be seeded "
                "as new."
            )

    # ------------------------------------------------------------------ reading

    def all_keys(self) -> set[str]:
        """Every key in the bucket, listed through the real paginator."""
        out: set[str] = set()
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=BUCKET):
            out.update(o["Key"] for o in page.get("Contents", []))
        return out

    def listing(self) -> dict[str, datetime]:
        """{key: LastModified} for every key, read through the real paginator."""
        out: dict[str, datetime] = {}
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=BUCKET):
            for obj in page.get("Contents", []):
                out[obj["Key"]] = obj["LastModified"]
        return out


def job_footprint(job_id: str, tmp_dir: str) -> dict[str, str]:
    """Write every key shape a job can own, and return {shape name: key}.

    Shapes 2, 4, 5, 6 and 7 are written by CALLING the real `r2_uploader` write
    functions, so the key is whatever production would have produced, not a string this
    test typed. (Shape 4 is the on-demand cutter's path, `upload_loop`; shape 7 is
    `upload_play_chords`.) Shape 1 is written by the browser straight to R2 via a
    presigned PUT (`api/uploads/route.ts`) and shape 3 is the pre-#211 loop key that
    production rows still hold, so neither has a worker function: they are literals,
    copied from the brief's enumeration.

      1  <id>/_input.<ext>                          browser presigned PUT
      2  <id>/_input.wav                            upload_input
      3  <id>/<stem>/<section>_NNNN.wav             pre-#211 upload_loop (what prod holds)
      4  <id>/<stem>/<bars>bar_<section>_NNNN.wav   loop_r2_key / upload_loop
      5  <id>/_stems/play/<stem>.opus               upload_stem(kind="play")
      6  <id>/_stems/dl/<stem>.wav                  upload_stem(kind="download")
      7  jobs/<id>/play.chords.json                 upload_play_chords
    """
    local = os.path.join(tmp_dir, "blob.bin")
    with open(local, "wb") as f:
        f.write(b"RIFFtest")

    client = r2_uploader._r2()
    bucket = os.environ["R2_BUCKET_NAME"]

    shapes: dict[str, str] = {}
    shapes["1 browser PUT   <id>/_input.<ext>"] = f"{job_id}/_input.mp3"
    client.put_object(Bucket=bucket, Key=shapes["1 browser PUT   <id>/_input.<ext>"], Body=b"x")

    r2_uploader.upload_input(job_id, local)
    shapes["2 upload_input  <id>/_input.wav"] = f"{job_id}/_input.wav"

    shapes["3 pre-#211 loop <id>/<stem>/<sec>_NNNN.wav"] = f"{job_id}/bass/intro_0010.wav"
    client.put_object(
        Bucket=bucket, Key=shapes["3 pre-#211 loop <id>/<stem>/<sec>_NNNN.wav"], Body=b"x"
    )

    shapes["4 loop_r2_key   <id>/<stem>/<N>bar_<sec>_NNNN.wav"] = r2_uploader.upload_loop(
        job_id, "bass", 4, "verse", 3, local
    )
    shapes["5 stem play     <id>/_stems/play/<stem>.opus"] = r2_uploader.upload_stem(
        job_id, "bass", local, "play"
    )
    shapes["6 stem download <id>/_stems/dl/<stem>.wav"] = r2_uploader.upload_stem(
        job_id, "bass", local, "download"
    )
    shapes["7 play chords   jobs/<id>/play.chords.json"] = r2_uploader.upload_play_chords(
        job_id, b"{}"
    )
    assert len(set(shapes.values())) == 7, "the seven key shapes must be seven distinct keys"
    return shapes


# Shape 7 is the one main's per-job delete does not reach (PR #214). Everything else is
# deleted by `delete_prefix(f"{job_id}/")`.
CHORDS_SHAPE = "7 play chords   jobs/<id>/play.chords.json"


def assert_chords_gone_or_xfail(r2: RealR2, shapes: dict[str, str]) -> None:
    """The ONE place shape 7 is allowed to be missing, and only until PR #214 lands.

    Call it LAST in a test, after shapes 1-6 have been asserted gone with plain `assert`s,
    so everything else the test claims has already been proven by the time it can xfail.

    Why imperative `pytest.xfail()` and not a `@pytest.mark.xfail` on the test: the marker
    swallows EVERY failure in the test body, including a broken harness or a sweep that
    deleted nothing, and reports XFAIL for all of them (measured); non-strict, it also
    reports a silent XPASS under a different mutant. This one can only fire when the
    chords key is the sole survivor. And it needs no marker to remove: once #214 deletes
    `jobs/<id>/play.chords.json` the test simply passes, asserting shape 7 for real.
    """
    key = shapes[CHORDS_SHAPE]
    if key in r2.all_keys():
        pytest.xfail(
            f"{key!r} survived the per-job delete: `delete_prefix(f'{{job_id}}/')` does not "
            "reach the `jobs/` namespace until PR #214 lands. Shapes 1-6 were asserted gone."
        )
