"""The worker alerts when the R2 bucket carries an object-expiration lifecycle rule (QA-57/59).

A whole-bucket expiration rule deleted a Studio user's play-along audio and chord file
after ~1 day while the DB row still said "kept", and nothing reported it. These tests run
the guard against a FAKE boto3 client (no network) and pin: an enabled Expiration rule is
an ERROR log + one Sentry error; safe configurations and "no configuration" are quiet; a
failing read is a WARN and never raises; and the poll loop starts the check at startup and
then once a day.
"""

from __future__ import annotations

import asyncio
import json
import threading
import types

import pytest
from botocore.exceptions import ClientError

from worker import consumer
from worker.storage import r2_lifecycle_guard as guard

BUCKET = "stem-loops-audio"

OLD_RULE = {
    "ID": "expire-ephemeral-job-io",
    "Status": "Enabled",
    "Filter": {"Prefix": ""},
    "Expiration": {"Days": 2},
}
MULTIPART = {
    "ID": "abort-incomplete-multipart",
    "Status": "Enabled",
    "Filter": {"Prefix": ""},
    "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1},
}


class FakeClient:
    def __init__(self, *, rules=None, exc: BaseException | None = None):
        self.rules = rules
        self.exc = exc
        self.calls: list[dict] = []

    def get_bucket_lifecycle_configuration(self, **kw):
        self.calls.append(kw)
        if self.exc is not None:
            raise self.exc
        return {"Rules": self.rules or []}


def _client_error(code: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": code}}, "GetBucketLifecycleConfiguration"
    )


@pytest.fixture
def captured(monkeypatch, capsys):
    """Record Sentry messages and parse structured log lines."""
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        guard.sentry_sdk, "capture_message", lambda msg, **kw: sent.append((msg, kw))
    )

    def logs():
        out = []
        for line in capsys.readouterr().err.splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            rec["detail"] = json.loads(rec["detail"])
            out.append(rec)
        return out

    return types.SimpleNamespace(sent=sent, logs=logs)


def test_old_whole_bucket_expiration_rule_is_an_error_and_a_sentry_event(captured):
    client = FakeClient(rules=[MULTIPART, OLD_RULE])
    bad = guard.check_r2_lifecycle(client, BUCKET)

    assert client.calls == [{"Bucket": BUCKET}]
    assert [r["id"] for r in bad] == ["expire-ephemeral-job-io"]
    assert bad[0]["expiration"] == {"Days": "2"}

    (rec,) = [r for r in captured.logs() if r["event"] == guard.EVENT]
    assert rec["level"] == "ERROR"
    assert rec["detail"]["rule_ids"] == ["expire-ephemeral-job-io"]
    assert rec["detail"]["rules"][0]["expiration"] == {"Days": "2"}

    assert len(captured.sent) == 1, "exactly one Sentry event per check"
    msg, kw = captured.sent[0]
    assert kw["level"] == "error"
    assert kw["fingerprint"] == guard.SENTRY_FINGERPRINT
    assert "expire-ephemeral-job-io" in msg and "Days=2" in msg


def test_every_expiring_rule_is_named_including_a_prefixed_or_dated_one(captured):
    rules = [
        OLD_RULE,
        {
            "ID": "dated",
            "Status": "Enabled",
            "Prefix": "jobs/",
            "Expiration": {"Date": "2026-12-01"},
        },
    ]
    bad = guard.check_r2_lifecycle(FakeClient(rules=rules), BUCKET)
    assert [(r["id"], r["prefix"]) for r in bad] == [
        ("expire-ephemeral-job-io", ""),
        ("dated", "jobs/"),
    ]
    assert len(captured.sent) == 1, "one event naming both rules, not one per rule"
    assert "dated" in captured.sent[0][0]


def test_only_the_multipart_cleanup_rule_is_quiet(captured):
    assert guard.check_r2_lifecycle(FakeClient(rules=[MULTIPART]), BUCKET) == []
    assert captured.sent == []
    assert not [r for r in captured.logs() if r["level"] in ("ERROR", "WARN")]


def test_a_disabled_expiration_rule_is_quiet(captured):
    disabled = {**OLD_RULE, "Status": "Disabled"}
    assert guard.check_r2_lifecycle(FakeClient(rules=[disabled]), BUCKET) == []
    assert captured.sent == []


def test_no_lifecycle_configuration_at_all_is_fine(captured):
    client = FakeClient(exc=_client_error("NoSuchLifecycleConfiguration"))
    assert guard.check_r2_lifecycle(client, BUCKET) == []
    assert captured.sent == []
    assert not [r for r in captured.logs() if r["level"] in ("ERROR", "WARN")]


@pytest.mark.parametrize(
    "exc",
    [
        _client_error("AccessDenied"),
        ConnectionError("endpoint unreachable"),
        RuntimeError("anything else"),
    ],
)
def test_a_failing_read_is_a_warn_and_never_raises(captured, exc):
    assert guard.check_r2_lifecycle(FakeClient(exc=exc), BUCKET) == []
    assert captured.sent == [], "a read failure is not evidence of an expiration rule"
    warns = [r for r in captured.logs() if r["event"] == "r2_lifecycle_check_failed"]
    assert len(warns) == 1 and warns[0]["level"] == "WARN"


def test_missing_r2_env_is_a_warn_and_never_raises(monkeypatch, captured):
    """With no client passed, the guard builds the worker's `_r2()` client; missing env
    (as in a dev box with no R2) must not escape."""
    monkeypatch.delenv("R2_BUCKET_NAME", raising=False)
    assert guard.check_r2_lifecycle() == []
    assert [r["level"] for r in captured.logs()] == ["WARN"]


def test_a_sentry_failure_does_not_escape(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("sentry down")

    monkeypatch.setattr(guard.sentry_sdk, "capture_message", boom)
    assert len(guard.check_r2_lifecycle(FakeClient(rules=[OLD_RULE]), BUCKET)) == 1


def test_start_runs_the_check_on_a_daemon_thread_and_returns_at_once(monkeypatch):
    release = threading.Event()
    ran = threading.Event()

    def slow_check():
        ran.set()
        release.wait(5)  # models a hung R2 call

    monkeypatch.setattr(guard, "check_r2_lifecycle", slow_check)
    t = guard.start_r2_lifecycle_check()
    try:
        assert t is not None and t.daemon
        assert ran.wait(2), "the check never ran"
        assert t.is_alive(), "start must return while the check is still in flight"
    finally:
        release.set()
        t.join(2)


# ---------- wiring: the poll loop really calls it, at startup and daily ----------


class _Stop(BaseException):
    pass


def _drive(monkeypatch, run_for: float, check, audit=lambda _now: None):
    clock = types.SimpleNamespace(now=0.0)
    monkeypatch.setattr(consumer, "time", types.SimpleNamespace(monotonic=lambda: clock.now))
    monkeypatch.setattr(consumer.tmpdirs, "sweep_stale", lambda: 0)

    async def zero():
        return 0

    async def nothing():
        return False

    async def no_sweep():
        return {}

    async def fake_sleep(seconds):
        clock.now += seconds
        if clock.now >= run_for:
            raise _Stop

    monkeypatch.setattr(consumer, "reap_stale_jobs", zero)
    monkeypatch.setattr(consumer, "reap_stale_requests", zero)
    monkeypatch.setattr(consumer, "sweep_expired", no_sweep)
    monkeypatch.setattr(consumer, "claim_and_run", nothing)
    monkeypatch.setattr(consumer, "claim_and_cut", nothing)
    monkeypatch.setattr(consumer.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(consumer, "start_r2_lifecycle_check", lambda: check(clock.now))
    monkeypatch.setattr(consumer, "start_artifact_audit", lambda: audit(clock.now))
    with pytest.raises(_Stop):
        asyncio.run(consumer.poll_loop())


def test_poll_loop_runs_both_storage_checks_at_startup_then_once_a_day(monkeypatch):
    at: list[float] = []
    audits: list[float] = []
    day = 86400  # literal: the promise is "once a day", not "whatever the constant says"
    _drive(monkeypatch, 2 * day + 10, at.append, audits.append)
    for name, calls in (("lifecycle", at), ("artifact audit", audits)):
        assert len(calls) == 3, f"{name}: expected startup + 2 daily runs, got {calls}"
        assert calls[0] == 0.0
        assert day <= calls[1] < day + 30 and 2 * day <= calls[2] < 2 * day + 30


def test_a_failing_lifecycle_start_does_not_skip_the_artifact_audit(monkeypatch):
    audits: list[float] = []

    def boom(_now):
        raise RuntimeError("could not start thread")

    _drive(monkeypatch, 100, boom, audits.append)
    assert audits == [0.0]


def test_a_check_that_raises_does_not_stop_the_poll_loop(monkeypatch):
    def boom(_now):
        raise RuntimeError("could not start thread")

    # Runs to the stop condition: the loop survived the failing check at startup.
    _drive(monkeypatch, 100, boom)


# ---------- against moto's S3 (a real boto3 client, real wire responses) ----------


def test_against_moto_the_real_error_code_and_response_shape(captured):
    """The fake client above encodes two assumptions about boto3: that a bucket with no
    rules raises ClientError code `NoSuchLifecycleConfiguration`, and the response shape.
    moto's S3 checks both with a real client and real XML on the wire."""
    moto = pytest.importorskip("moto")
    import boto3

    with moto.mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        assert guard.check_r2_lifecycle(s3, BUCKET) == []

        s3.put_bucket_lifecycle_configuration(
            Bucket=BUCKET, LifecycleConfiguration={"Rules": [MULTIPART, OLD_RULE]}
        )
        bad = guard.check_r2_lifecycle(s3, BUCKET)
        assert [r["id"] for r in bad] == ["expire-ephemeral-job-io"]

        s3.put_bucket_lifecycle_configuration(
            Bucket=BUCKET, LifecycleConfiguration={"Rules": [MULTIPART]}
        )
        assert guard.check_r2_lifecycle(s3, BUCKET) == []
    assert len(captured.sent) == 1
    assert not [r for r in captured.logs() if r["level"] == "WARN"]
