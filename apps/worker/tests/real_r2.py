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

from tests.db_guard import (  # noqa: F401  (re-exported for the tests)
    database_url_problem,
    refuse_unless_local,
    skip_or_fail,
)
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
    refused), the thread dies, nothing sets the event, and `start()` waits for ever. There
    is no pytest-timeout, so this deadline is what turns the hang into a red test at the
    point of failure; the CI Tests job's `timeout-minutes: 30` (added in this PR) is only
    the outer bound, and a 30-minute cancel is a worse failure to read than a named one.
    Measured on moto 5.2.5 against a port already in use.
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


def require_database() -> str:
    """The LOCAL `DATABASE_URL` these tests need, or skip (local) / fail (CI) with the reason.

    THIS IS THE CHOKEPOINT for every DB-backed test in the retention files, and it must stay
    one: those tests run the real destructive sweep SQL (DELETE FROM jobs, anonymising
    charged job shells, DELETE FROM upload_rate_events) against whatever database it
    returns. Only R2 is a fake (moto). Round 3 guarded just the one fixture that inserts
    into `auth.users`, so a developer whose shell exports a production `DATABASE_URL` would
    have run the sweep against production. A non-local URL is therefore REFUSED here:
    skipped locally, failed under CI, never connected to.

    Two values are checked, because the sweep connects with the one `cleanup.py` read at
    import, not with the variable as it is now: `os.environ["DATABASE_URL"]` and
    `cleanup.DATABASE_URL`. CI's `postgresql://stemloops:...@localhost:5432/stemloops` passes.
    """
    url = os.environ.get("DATABASE_URL")
    if not url:
        skip_or_fail("DATABASE_URL is not set, so the DB-backed retention tests cannot run")
    from worker import cleanup

    refuse_unless_local(("DATABASE_URL", url), ("cleanup.DATABASE_URL", cleanup.DATABASE_URL))
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

    Every shape but 1 and 3 is written by CALLING the real `r2_uploader` write function. The
    KEY this function returns for it is what production produced for shapes 4, 5, 6 and 7
    (`upload_loop`, `upload_stem` twice, `upload_play_chords`). It is NOT so for shape 2:
    `upload_input` returns a presigned URL, not the key, so the key tracked for shape 2 is a
    string this test typed (`<id>/_input.wav`). If `upload_input` moved its key, the object
    would land elsewhere and `RealR2.age` would fail on the typed one (a crash, not a
    clean assertion), so the drift is seen, but the key is not "whatever production would have
    produced". (Round 3 of this docstring said it was.) Shape 4 is the on-demand cutter's
    path, `upload_loop`; shape 7 is `upload_play_chords`. Shape 1 is written by the browser
    straight to R2 via a presigned PUT (`api/uploads/route.ts`) and shape 3 is the pre-#211
    loop key that production rows still hold, so neither has a worker function: they are
    literals, copied from the brief's enumeration.

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

# The capability PR #214 adds: the list of prefixes the per-job delete walks
# (`{job_id}/` AND `jobs/{job_id}/`). Its presence is how this module knows the fix is in.
FIX_PROBE = "job_object_prefixes"


def per_job_delete_covers_the_chords_namespace() -> bool:
    """True once the code under test has PR #214's per-job prefix list (a CAPABILITY probe)."""
    return hasattr(r2_uploader, FIX_PROBE)


def assert_chords_gone_or_xfail(r2: RealR2, shapes: dict[str, str]) -> None:
    """Shape 7 must be gone. It may xfail ONLY while the fix that deletes it is absent.

    Call it LAST in a test, after shapes 1-6 have been asserted gone with plain `assert`s,
    so everything else the test claims has already been proven by the time it can xfail.

    THE XFAIL IS KEYED ON A CAPABILITY, not on the outcome. `r2_uploader` either has
    `job_object_prefixes` (PR #214 is in) or it does not:

      * fix absent  -> a surviving chords key is the KNOWN gap: `pytest.xfail`.
      * fix present -> a surviving chords key is a REGRESSION of that fix: `pytest.fail`.
        Round 2 keyed the xfail on the outcome alone, so with #214 applied and then
        regressed (`job_object_prefixes` returning only `(f"{job_id}/",)`) the suite stayed
        green at 18 passed / 2 xfailed, with a message still saying "until PR #214 lands".
        That made the xfail a permanent escape hatch.

    Why imperative `pytest.xfail()` and not a `@pytest.mark.xfail` on the test: the marker
    swallows EVERY failure in the test body, including a broken harness or a sweep that
    deleted nothing, and reports XFAIL for all of them (measured); non-strict, it also
    reports a silent XPASS under a different mutant. This one can only fire when the
    chords key is the sole survivor.

    THE PROBE IS COUPLED TO A NAME, AND A RENAME IS NOT SEEN. If #214 is reworked so that
    `job_object_prefixes` is renamed (a reviewer renamed it to `job_r2_prefixes` AND regressed
    it), this reads "fix absent", the xfail returns, and the suite reports
    `1 failed, 38 passed, 2 xfailed` with a message that falsely says the fix is absent.
    `test_real_r2_harness.py` parametrises on `FIX_PROBE` itself, so it pins both branches of
    THIS helper for the current name and cannot see a rename. (Round 3 of this docstring said
    the pins stop either branch "rotting unseen"; the rename case rots unseen.)

    No in-test detector can fix that: a regressed fix and an absent one are behaviourally
    identical, so the marker has to come from outside the behaviour. THE REMEDY IS A MERGE
    OBLIGATION, NOT CODE: whichever of #214 and this PR lands SECOND deletes this xfail branch
    (the `pytest.xfail(...)` below, `per_job_delete_covers_the_chords_namespace`, `FIX_PROBE`
    and the three harness tests that pin them), leaving a plain assertion that shape 7 is gone.
    """
    key = shapes[CHORDS_SHAPE]
    if key not in r2.all_keys():
        return
    if per_job_delete_covers_the_chords_namespace():
        pytest.fail(
            f"{key!r} survived the per-job delete although r2_uploader.{FIX_PROBE} exists, "
            "i.e. PR #214's fix is in the code under test and it has REGRESSED. Shapes 1-6 "
            "were asserted gone.",
            pytrace=False,
        )
    pytest.xfail(
        f"{key!r} survived the per-job delete: r2_uploader has no `{FIX_PROBE}`, so "
        "`delete_prefix(f'{job_id}/')` does not reach the `jobs/` namespace (PR #214 adds "
        "it). Shapes 1-6 were asserted gone. IF #214 IS ALREADY MERGED, THIS MESSAGE IS "
        f"WRONG: it renamed `{FIX_PROBE}` (this probe cannot see a rename, and the chords "
        "key then survives for a REAL reason), or regressed it. Either way the obligation "
        "stands: whichever of #214 and #224 landed second must delete this xfail branch "
        "(real_r2.assert_chords_gone_or_xfail)."
    )
