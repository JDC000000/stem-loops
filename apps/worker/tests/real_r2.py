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

NOTHING HERE CAN REACH CLOUDFLARE. The endpoint is a loopback port this module opened,
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
import socket
import urllib.request
from datetime import UTC, datetime, timedelta

# A hard import, deliberately: NOT `pytest.importorskip`. A skipped retention test is
# the failure mode this file exists to remove.
from moto.server import ThreadedMotoServer  # noqa: I001

from worker.storage import r2_uploader

BUCKET = "retention-real-r2-test"

_PROXY_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class RealR2:
    """Context manager: a moto S3 server + the env `r2_uploader` reads, restored on exit."""

    def __init__(self, monkeypatch):
        self._mp = monkeypatch
        self._server: ThreadedMotoServer | None = None
        self.client = None
        self.endpoint = ""

    def __enter__(self) -> RealR2:
        port = _free_port()
        self.endpoint = f"http://127.0.0.1:{port}"
        self._server = ThreadedMotoServer(ip_address="127.0.0.1", port=port, verbose=False)
        self._server.start()

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
        if not age_hours:
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
        bucket.keys[key].last_modified = datetime.now(UTC).replace(tzinfo=None) - timedelta(
            hours=age_hours
        )
        seen = self.last_modified(key)
        got_hours = (datetime.now(UTC) - seen).total_seconds() / 3600
        assert abs(got_hours - age_hours) < 0.05, (
            f"back-dating {key!r} to {age_hours}h did not take: the real list call reports "
            f"{got_hours:.3f}h. Every 'old' object in this test would be seeded as new."
        )

    # ------------------------------------------------------------------ reading

    def all_keys(self) -> set[str]:
        """Every key in the bucket, listed through the real paginator."""
        out: set[str] = set()
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=BUCKET):
            out.update(o["Key"] for o in page.get("Contents", []))
        return out

    def last_modified(self, key: str) -> datetime:
        for page in self.client.get_paginator("list_objects_v2").paginate(
            Bucket=BUCKET, Prefix=key
        ):
            for obj in page.get("Contents", []):
                if obj["Key"] == key:
                    return obj["LastModified"]
        raise AssertionError(f"{key!r} is not in the bucket")


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
