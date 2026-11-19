"""The daily retained-song audit reports missing files (QA-57 / QA-59). No database.

Every R2 object older than ~24 h was deleted while the DB still retained the jobs, and
nothing said so for days. These tests run `audit_retained_artifacts` over supplied job
rows and a fake boto3 client, and pin: missing play stems and (for a job with a real
Klangio id) a missing chord file are each a WARN with the full job id plus one Sentry
warning tagged kind + job_ref and never the full id; present files and jobs that never
had chords are quiet; the sample is bounded; and nothing raises. The sample QUERY is
checked as text (the gates it must carry) here; tests/test_artifact_audit_db.py runs it
against a real database (CI only).
"""

from __future__ import annotations

import json
import threading
import types

import pytest
from botocore.exceptions import ClientError

from worker import artifact_audit as audit
from worker import cleanup

BUCKET = "stem-loops-audio"
A = "11111111-2222-4333-8444-555555555555"
B = "aaaaaaaa-2222-4333-8444-555555555555"


class FakeR2:
    def __init__(self, keys=(), fail=False):
        self.keys = set(keys)
        self.fail = fail
        self.calls: list[tuple] = []

    def list_objects_v2(self, **kw):
        self.calls.append(("list", kw))
        if self.fail:
            raise ConnectionError("r2 down")
        hits = sorted(k for k in self.keys if k.startswith(kw["Prefix"]))[: kw["MaxKeys"]]
        return {"KeyCount": len(hits), "Contents": [{"Key": k} for k in hits]}

    def head_object(self, **kw):
        self.calls.append(("head", kw))
        if kw["Key"] not in self.keys:
            raise ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
        return {}


def footprint(job_id, chords=True):
    keys = {f"{job_id}/_stems/play/drums.opus", f"{job_id}/_stems/dl/drums.wav"}
    if chords:
        keys.add(f"jobs/{job_id}/play.chords.json")
    return keys


@pytest.fixture
def rec(monkeypatch, capsys):
    sent: list[dict] = []

    class Scope:
        def __init__(self):
            self.tags, self.fingerprint = {}, None

        def set_tag(self, k, v):
            self.tags[k] = v

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    current: list[Scope] = []

    def new_scope():
        current.append(Scope())
        return current[-1]

    def capture_message(msg, level=None):
        s = current[-1]
        sent.append({"msg": msg, "level": level, "tags": s.tags, "fingerprint": s.fingerprint})

    monkeypatch.setattr(audit.sentry_sdk, "new_scope", new_scope)
    monkeypatch.setattr(audit.sentry_sdk, "capture_message", capture_message)

    def logs():
        out = []
        for line in capsys.readouterr().err.splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            r["detail"] = json.loads(r["detail"])
            out.append(r)
        return out

    return types.SimpleNamespace(sent=sent, logs=logs)


def test_a_job_with_everything_present_is_quiet(rec):
    r2 = FakeR2(footprint(A))
    res = audit.audit_retained_artifacts([(A, False, "kl_1")], r2, BUCKET)
    assert res == {"checked": 1, "stems_missing": 0, "chords_missing": 0, "errors": 0}
    assert rec.sent == []
    assert [r["level"] for r in rec.logs()] == ["INFO"]
    assert ("list", {"Bucket": BUCKET, "Prefix": f"{A}/_stems/play/", "MaxKeys": 1}) in r2.calls


def test_the_incident_every_file_gone_is_reported_per_kind_with_job_ref_not_the_id(rec):
    rows = [(A, True, "kl_1"), (B, False, "kl_2")]
    res = audit.audit_retained_artifacts(rows, FakeR2(), BUCKET)
    assert res["stems_missing"] == 2 and res["chords_missing"] == 2
    assert len(rec.sent) == 4
    for e in rec.sent:
        assert e["level"] == "warning"
        assert e["fingerprint"] == ["missing-artifact", e["tags"]["kind"]]
    assert {(e["tags"]["kind"], e["tags"]["job_ref"]) for e in rec.sent} == {
        ("stems_missing", "11111111"),
        ("chords_missing", "11111111"),
        ("stems_missing", "aaaaaaaa"),
        ("chords_missing", "aaaaaaaa"),
    }
    assert not any(A in json.dumps(e) or B in json.dumps(e) for e in rec.sent), "full id sent"
    logs = rec.logs()
    warns = [r for r in logs if r["event"] == "retained_song_file_missing"]
    assert {(w["detail"]["kind"], w["detail"]["job_id"]) for w in warns} == {
        ("stems_missing", A),
        ("chords_missing", A),
        ("stems_missing", B),
        ("chords_missing", B),
    }, "the full id goes to the log, where an operator can act on it"
    (summary,) = [r for r in logs if r["event"] == "artifact_audit_done"]
    assert summary["level"] == "ERROR"


@pytest.mark.parametrize("klangio", [None, "", "submitting"])
def test_no_chord_file_is_normal_without_a_real_klangio_id(rec, klangio):
    r2 = FakeR2(footprint(A, chords=False))
    res = audit.audit_retained_artifacts([(A, False, klangio)], r2, BUCKET)
    assert res["chords_missing"] == 0 and rec.sent == []
    assert not [c for c in r2.calls if c[0] == "head"], "no HEAD for a job that never had chords"


def test_missing_chords_only(rec):
    r2 = FakeR2(footprint(A, chords=False))
    res = audit.audit_retained_artifacts([(A, False, "kl_1")], r2, BUCKET)
    assert (res["stems_missing"], res["chords_missing"]) == (0, 1)
    assert [e["tags"]["kind"] for e in rec.sent] == ["chords_missing"]


def test_the_sample_is_bounded(rec):
    rows = [(f"{i:08x}-2222-4333-8444-555555555555", False, None) for i in range(200)]
    res = audit.audit_retained_artifacts(rows, FakeR2(), BUCKET)
    assert res["checked"] == audit.SAMPLE_LIMIT == 50


def test_r2_errors_are_warns_stop_after_five_and_never_raise(rec):
    rows = [(f"{i:08x}-2222-4333-8444-555555555555", False, None) for i in range(20)]
    res = audit.audit_retained_artifacts(rows, FakeR2(fail=True), BUCKET)
    assert res["errors"] == 5 and res["stems_missing"] == 0
    assert rec.sent == [], "an R2 outage is not evidence that files are missing"


def test_a_non_404_head_error_is_an_error_not_a_missing_file(rec):
    class Denied(FakeR2):
        def head_object(self, **kw):
            raise ClientError({"Error": {"Code": "403", "Message": "Forbidden"}}, "HeadObject")

    res = audit.audit_retained_artifacts([(A, False, "kl_1")], Denied(footprint(A)), BUCKET)
    assert res["chords_missing"] == 0 and res["errors"] == 1


def test_setup_failure_is_a_warn_and_never_raises(rec, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("db down")

    monkeypatch.setattr(audit, "sample_retained_jobs", boom)
    assert audit.audit_retained_artifacts()["checked"] == 0
    assert [r["event"] for r in rec.logs()] == ["artifact_audit_failed"]


def test_a_sentry_failure_does_not_escape(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("sentry down")

    monkeypatch.setattr(audit.sentry_sdk, "new_scope", boom)
    res = audit.audit_retained_artifacts([(A, False, None)], FakeR2(), BUCKET)
    assert res["stems_missing"] == 1


def test_the_sample_query_carries_every_gate():
    sql = audit.SAMPLE_SQL
    assert "status = 'done'" in sql
    assert "client_ip_hash <> %s" in sql, "anonymised shells have no files by design"
    assert cleanup.RETAINED_UNTIL_SQL in sql, "the same retention rule the sweep deletes by"
    assert (
        f"(is_demo OR created_at >= '{audit.STEMS_RETAINED_SINCE}'" in sql
    ), "pre-V3-J2 jobs have no stems, but every demo is audited whatever its age (M-2)"
    assert "interval '1 hour'" in sql, "a job still finishing its uploads is not sampled"
    assert "ORDER BY is_demo DESC" in sql, "every demo song is checked first"
    assert sql.rstrip().endswith("LIMIT %s")


def test_start_runs_on_a_daemon_thread_and_returns_at_once(monkeypatch):
    release, ran = threading.Event(), threading.Event()

    def slow():
        ran.set()
        release.wait(5)

    monkeypatch.setattr(audit, "audit_retained_artifacts", slow)
    t = audit.start_artifact_audit()
    try:
        assert t is not None and t.daemon and ran.wait(2) and t.is_alive()
    finally:
        release.set()
        t.join(2)


def test_the_sample_connection_has_a_connect_timeout(monkeypatch):
    """PR #306 review L-3: each daily run starts a new daemon thread, so a connect that can
    hang for ever would park one thread per day. The connect must carry a timeout."""
    seen = {}

    class Conn:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, sql, params):
            return types.SimpleNamespace(fetchall=lambda: [])

    def connect(url, **kw):
        seen.update(url=url, **kw)
        return Conn()

    monkeypatch.setattr(audit.psycopg, "connect", connect)
    assert audit.sample_retained_jobs("postgresql://example.invalid/db") == []
    assert seen["connect_timeout"] == audit.DB_CONNECT_TIMEOUT
    assert 0 < audit.DB_CONNECT_TIMEOUT <= 30
