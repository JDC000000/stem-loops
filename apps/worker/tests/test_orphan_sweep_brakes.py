"""The orphan pass's two safety brakes (QA-57 / QA-59). No database, no S3.

THE INCIDENT. Every R2 object older than ~24 h was deleted, including demo songs and paid
libraries the DB retains until 2027, with no lifecycle rule on the bucket. The orphan pass
deletes every aged object whose job id the database does not list as live, so a process
holding the production R2 keys and a different (empty) database deletes everything.

These tests run the REAL `cleanup._sweep_orphaned_objects` over a fake R2 listing and a
fake async connection that answers its two queries, and pin:
  * brake 1, the binding: unset -> the pass does not list or delete anything and says what
    to set (once per process); set but wrong -> ERROR + one Sentry event, nothing deleted;
    the value covers bucket + user + host + port + dbname and never the password;
  * brake 2, the evidence: more than MAX_UNKNOWN_PROCESSED_JOBS processed jobs the DB has
    never heard of aborts the pass before that batch is deleted, cumulatively across
    batches; abandoned uploads (`_input.*` only) and anonymised shells do not count.
"""

from __future__ import annotations

import asyncio
import json
import types
import uuid

import pytest

from worker import cleanup

URL = "postgresql://svc.projref:pw@db.example.test:6543/postgres"


def _id(n: int) -> str:
    return str(uuid.UUID(int=n + 1))


class FakeConn:
    """Answers the orphan pass's two queries from `rows`: id -> is_shell (absent = no row)."""

    def __init__(self, rows: dict[str, bool] | None = None):
        self.rows = rows or {}
        self.queries: list[str] = []

    async def execute(self, sql, params=()):
        self.queries.append(sql)
        ids = list(params[0])
        if "client_ip_hash" in sql:  # the live-set query: shells are not live
            out = [(i,) for i in ids if i in self.rows and not self.rows[i]]
        else:  # the known-ids query: any row at all
            out = [(i,) for i in ids if i in self.rows]

        async def fetchall():
            return out

        return types.SimpleNamespace(fetchall=fetchall)


@pytest.fixture
def env(monkeypatch, capsys):
    """Bind the pass, fake R2, record Sentry, parse logs. Returns a namespace."""
    monkeypatch.setenv("R2_BUCKET_NAME", "stem-loops-audio")
    monkeypatch.setattr(cleanup, "DATABASE_URL", URL)
    monkeypatch.setenv(cleanup.ORPHAN_SWEEP_BINDING_ENV, cleanup.orphan_sweep_binding())
    monkeypatch.setattr(cleanup, "_binding_warned", False)
    ns = types.SimpleNamespace(objects=[], deleted=[], listed=0, sent=[])

    def list_older(_cutoff, limit=2000, start_after=""):
        ns.listed += 1
        return [k for k in sorted(ns.objects) if k > start_after][:limit]

    def delete_objects(keys):
        ns.deleted.extend(keys)
        for k in keys:
            ns.objects.remove(k)
        return len(keys)

    monkeypatch.setattr(cleanup, "list_objects_older_than", list_older)
    monkeypatch.setattr(cleanup, "delete_objects", delete_objects)
    monkeypatch.setattr(
        cleanup.sentry_sdk, "capture_message", lambda m, **kw: ns.sent.append((m, kw))
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

    ns.logs = logs
    return ns


def _run(conn) -> int:
    return asyncio.run(cleanup._sweep_orphaned_objects(conn, deadline=float("inf")))


def _processed(n0: int, n: int) -> list[str]:
    """`n` processed jobs' footprints (stems, a loop, a chord file) with ids from n0."""
    keys = []
    for i in range(n0, n0 + n):
        j = _id(i)
        keys += [f"{j}/_input.wav", f"{j}/_stems/play/drums.opus", f"jobs/{j}/play.chords.json"]
    return keys


# ---------------------------------------------------------------- brake 1: the binding


def test_binding_covers_bucket_and_db_identity_but_not_the_password():
    b = cleanup.orphan_sweep_binding
    base = b(URL, "stem-loops-audio")
    assert len(base) == 16
    assert b(URL.replace(":pw@", ":rotated@"), "stem-loops-audio") == base, "password rotation"
    for other in (
        b(URL, "stem-loops-staging"),
        b(URL.replace("svc.projref", "svc.otherref"), "stem-loops-audio"),
        b(URL.replace("db.example.test", "db2.example.test"), "stem-loops-audio"),
        b(URL.replace(":6543/", ":5432/"), "stem-loops-audio"),
        b(URL.replace("/postgres", "/staging"), "stem-loops-audio"),
        b("", "stem-loops-audio"),
    ):
        assert other != base
    assert "pw" not in base and "db.example" not in base


def test_unbound_pass_lists_and_deletes_nothing_and_says_what_to_set_once(env, monkeypatch):
    monkeypatch.delenv(cleanup.ORPHAN_SWEEP_BINDING_ENV)
    env.objects = _processed(0, 2) + [f"{_id(50)}/_input.mp3"]
    assert _run(FakeConn()) == 0
    assert _run(FakeConn()) == 0
    assert env.listed == 0 and env.deleted == []
    warns = [r for r in env.logs() if r["event"] == "retention_orphan_sweep_unbound"]
    assert len(warns) == 1, "warn once per process, not every 15 minutes"
    assert warns[0]["level"] == "WARN"
    assert cleanup.orphan_sweep_binding() in warns[0]["detail"]["action"]
    assert env.sent == [], "an unbound pass is configuration, not an incident"


def test_a_binding_for_another_database_is_refused_loudly(env, monkeypatch):
    other = cleanup.orphan_sweep_binding(URL.replace("svc.projref", "svc.staging"))
    monkeypatch.setenv(cleanup.ORPHAN_SWEEP_BINDING_ENV, other)
    env.objects = _processed(0, 1)
    assert _run(FakeConn()) == 0
    assert env.listed == 0 and env.deleted == []
    (err,) = [r for r in env.logs() if r["event"] == "retention_orphan_sweep_binding_mismatch"]
    assert err["level"] == "ERROR"
    assert len(env.sent) == 1 and env.sent[0][1]["level"] == "error"


# ---------------------------------------------------------------- brake 2: the evidence


def test_an_empty_database_facing_a_full_bucket_aborts_before_deleting_anything(env):
    """The incident, from inside: every aged object belongs to a processed job the
    database has never heard of."""
    env.objects = _processed(0, cleanup.MAX_UNKNOWN_PROCESSED_JOBS + 1)
    before = list(env.objects)
    assert _run(FakeConn({})) == 0
    assert env.deleted == [] and env.objects == before
    (err,) = [r for r in env.logs() if r["event"] == "retention_orphan_sweep_braked"]
    assert err["level"] == "ERROR"
    assert err["detail"]["unknown_processed_jobs"] == cleanup.MAX_UNKNOWN_PROCESSED_JOBS + 1
    assert len(env.sent) == 1
    msg, kw = env.sent[0]
    assert kw["level"] == "error" and kw["fingerprint"] == cleanup.ORPHAN_BRAKE_FINGERPRINT
    assert _id(0) not in msg, "no job id in the Sentry message"


def test_at_the_limit_the_pass_still_runs(env):
    env.objects = _processed(0, cleanup.MAX_UNKNOWN_PROCESSED_JOBS)
    assert _run(FakeConn({})) == 3 * cleanup.MAX_UNKNOWN_PROCESSED_JOBS
    assert env.sent == []


def test_the_limit_is_cumulative_across_batches(env, monkeypatch):
    """A pass must not escape the brake by meeting the unknown jobs a few per batch."""
    monkeypatch.setattr(cleanup, "ORPHAN_LIST_BATCH", 9)  # three processed jobs per batch
    monkeypatch.setattr(cleanup, "MAX_UNKNOWN_PROCESSED_JOBS", 4)
    env.objects = _processed(0, 9)
    deleted = _run(FakeConn({}))
    assert deleted == 9, "the first batch (3 jobs) is under the limit and goes"
    assert len(env.objects) == 18, "the batch that crossed the limit was not deleted"
    assert len(env.sent) == 1


def test_abandoned_uploads_are_normal_orphans_and_never_brake(env):
    env.objects = [f"{_id(i)}/_input.mp3" for i in range(40)]
    assert _run(FakeConn({})) == 40
    assert env.sent == []


def test_shells_are_known_and_do_not_count_toward_the_brake(env):
    """An anonymised shell's stragglers are garbage the DB knows about (see
    test_purged_shell_stragglers_are_reaped_not_kept_for_ever)."""
    n = cleanup.MAX_UNKNOWN_PROCESSED_JOBS + 3
    env.objects = _processed(0, n)
    shells = {_id(i): True for i in range(n)}
    assert _run(FakeConn(shells)) == 3 * n
    assert env.sent == []


def test_live_jobs_are_kept_and_do_not_count(env):
    n = cleanup.MAX_UNKNOWN_PROCESSED_JOBS + 3
    env.objects = _processed(0, n) + [f"{_id(99)}/_input.mp3"]
    live = {_id(i): False for i in range(n)}
    assert _run(FakeConn(live)) == 1
    assert env.deleted == [f"{_id(99)}/_input.mp3"]
    assert env.sent == []


@pytest.mark.parametrize(
    ("key", "processed"),
    [
        ("00000000-0000-0000-0000-000000000001/_input.wav", False),
        ("00000000-0000-0000-0000-000000000001/_input.mp3", False),
        ("00000000-0000-0000-0000-000000000001/_stems/play/drums.opus", True),
        ("00000000-0000-0000-0000-000000000001/_stems/dl/bass.wav", True),
        ("00000000-0000-0000-0000-000000000001/drums/4bar_verse_0001.wav", True),
        ("jobs/00000000-0000-0000-0000-000000000001/play.chords.json", True),
    ],
)
def test_processed_key_classification(key, processed):
    assert cleanup._is_processed_key(key) is processed
