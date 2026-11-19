"""The orphan pass's two safety brakes (QA-57 / QA-59). No database, no S3.

THE INCIDENT. Every R2 object older than ~24 h was deleted, including demo songs and paid
libraries the DB retains until 2027, with no lifecycle rule on the bucket. The orphan pass
deletes every aged object whose job id the database does not list as live, so a process
holding the production R2 keys and a different (empty) database deletes everything.

These tests run the REAL `cleanup._sweep_orphaned_objects` over a fake R2 listing and a
fake async connection that answers its two queries, and pin:
  * brake 1, the binding: unset -> the pass does not list or delete anything, and says so
    once per process (WARN + one Sentry warning, never the value; the operator reads it
    with --print-binding); set but wrong -> ERROR + one Sentry event, nothing deleted;
    the value covers bucket + user + host + port + dbname and never the password;
  * brake 2, the evidence: more than MAX_UNKNOWN_PROCESSED_JOBS processed jobs the DB has
    never heard of aborts the pass before that batch is deleted, counted across batches AND
    passes, and then LATCHES the pass off for the life of the process (one ERROR + one
    Sentry event, nothing more deleted); chord-file-only jobs count; abandoned uploads
    (`_input.*` only) and anonymised shells do not.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import types
import uuid
from collections.abc import Iterator

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
def env(monkeypatch, capsys) -> Iterator[types.SimpleNamespace]:
    """Bind the pass, fake R2, record Sentry, parse logs. Returns a namespace."""
    monkeypatch.setenv("R2_BUCKET_NAME", "stem-loops-audio")
    monkeypatch.setattr(cleanup, "DATABASE_URL", URL)
    monkeypatch.setenv(cleanup.ORPHAN_SWEEP_BINDING_ENV, cleanup.orphan_sweep_binding())
    cleanup._reset_orphan_brake()  # process-lifetime latch + one-time warnings
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
    yield ns
    cleanup._reset_orphan_brake()


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


def test_unbound_pass_lists_and_deletes_nothing_and_says_so_once(env, monkeypatch):
    monkeypatch.delenv(cleanup.ORPHAN_SWEEP_BINDING_ENV)
    env.objects = _processed(0, 2) + [f"{_id(50)}/_input.mp3"]
    assert _run(FakeConn()) == 0
    assert _run(FakeConn()) == 0
    assert env.listed == 0 and env.deleted == []
    warns = [r for r in env.logs() if r["event"] == "retention_orphan_sweep_unbound"]
    assert len(warns) == 1, "warn once per process, not every 15 minutes"
    assert warns[0]["level"] == "WARN"
    action = warns[0]["detail"]["action"]
    # The container runs the worker as the `src.worker` package (Dockerfile: WORKDIR /app,
    # `python -m src.worker.main`), so the command must name that module (review N-1).
    assert "`python -m src.worker.cleanup --print-binding`" in action
    # Review L-2: the value is NOT printed (on a foreign stack it says how to re-arm).
    assert cleanup.orphan_sweep_binding() not in json.dumps(warns[0])
    # Review M-1: one Sentry WARNING per process, without the value.
    assert len(env.sent) == 1, "one Sentry event per process, not per pass"
    msg, kw = env.sent[0]
    assert kw["level"] == "warning"
    assert kw["fingerprint"] == ["retention", "orphan-sweep-unbound"]
    assert cleanup.orphan_sweep_binding() not in msg


def test_a_binding_for_another_database_is_refused_loudly(env, monkeypatch):
    other = cleanup.orphan_sweep_binding(URL.replace("svc.projref", "svc.staging"))
    monkeypatch.setenv(cleanup.ORPHAN_SWEEP_BINDING_ENV, other)
    env.objects = _processed(0, 1)
    assert _run(FakeConn()) == 0
    assert env.listed == 0 and env.deleted == []
    (err,) = [r for r in env.logs() if r["event"] == "retention_orphan_sweep_binding_mismatch"]
    assert err["level"] == "ERROR"
    assert len(env.sent) == 1 and env.sent[0][1]["level"] == "error"
    # A stack that copied the env lands here: never tell it its own value (review L-2).
    here = cleanup.orphan_sweep_binding()
    assert here not in json.dumps(err) and here not in env.sent[0][0]


def test_print_binding_command_prints_only_this_machines_value(tmp_path):
    """The operator's way to read the value (review L-2): `python -m worker.cleanup
    --print-binding` prints the 16-hex binding for its own env and nothing else."""
    src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": src,
        "DATABASE_URL": URL,
        "R2_BUCKET_NAME": "stem-loops-audio",
    }
    out = subprocess.run(
        [sys.executable, "-m", "worker.cleanup", "--print-binding"],
        env=env,
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == cleanup.orphan_sweep_binding(URL, "stem-loops-audio")
    assert "pw" not in out.stdout


def test_print_binding_refuses_without_both_inputs(monkeypatch, capsys):
    monkeypatch.setattr(cleanup, "DATABASE_URL", "")
    assert cleanup._main(["--print-binding"]) == 1
    assert capsys.readouterr().out == ""
    assert cleanup._main([]) == 2


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


def _stems_only(n0: int, n: int) -> list[str]:
    """`n` processed jobs with ONE aged key each, so a listing batch of k keys is k jobs."""
    return [f"{_id(i)}/_stems/play/drums.opus" for i in range(n0, n0 + n)]


def test_the_limit_is_cumulative_across_batches(env, monkeypatch):
    """A pass must not escape the brake by meeting the unknown jobs a few per batch.

    Every batch holds 3 unknown jobs, UNDER the limit of 4 on its own; only the running
    total crosses it, in batch 2. A per-batch count would delete all 9 (review M-4)."""
    monkeypatch.setattr(cleanup, "ORPHAN_LIST_BATCH", 3)
    monkeypatch.setattr(cleanup, "MAX_UNKNOWN_PROCESSED_JOBS", 4)
    env.objects = _stems_only(0, 9)
    deleted = _run(FakeConn({}))
    assert deleted == 3, "the first batch (3 jobs, under the limit) goes"
    assert env.objects == _stems_only(3, 6), "the batch that crossed the limit was kept"
    assert len(env.sent) == 1


def test_a_chord_file_only_job_counts_toward_the_brake(env):
    """`jobs/<id>/play.chords.json` alone is a processed job (review M-4): only the
    pipeline writes it. An empty DB facing nothing but chord files must brake too."""
    n = cleanup.MAX_UNKNOWN_PROCESSED_JOBS + 1
    env.objects = [f"jobs/{_id(i)}/play.chords.json" for i in range(n)]
    before = list(env.objects)
    assert _run(FakeConn({})) == 0
    assert env.deleted == [] and env.objects == before
    (err,) = [r for r in env.logs() if r["event"] == "retention_orphan_sweep_braked"]
    assert err["detail"]["unknown_processed_jobs"] == n


def test_once_tripped_the_brake_stays_on_for_the_life_of_the_process(env, monkeypatch):
    """Review B-2, the slow drain. Against an empty DB with 30 processed jobs, ten passes
    must delete no more than the limit in TOTAL, alert once, and list nothing after the
    trip. A per-pass count deleted 18 jobs and sent 10 events here."""
    monkeypatch.setattr(cleanup, "ORPHAN_LIST_BATCH", 3)
    env.objects = _stems_only(0, 30)
    total = sum(_run(FakeConn({})) for _ in range(10))
    assert total <= cleanup.MAX_UNKNOWN_PROCESSED_JOBS
    assert len(env.objects) == 30 - total
    assert len(env.sent) == 1, "one Sentry error at the trip, not one per pass"
    logs = env.logs()
    assert len([r for r in logs if r["event"] == "retention_orphan_sweep_braked"]) == 1
    assert len([r for r in logs if r["event"] == "retention_orphan_sweep_latched_off"]) == 9
    listed_at_trip = env.listed
    assert _run(FakeConn({})) == 0
    assert env.listed == listed_at_trip, "a latched pass does not even list"


def test_the_count_spans_passes_so_capped_passes_cannot_drain_slowly(env, monkeypatch):
    """Each pass here stops at the deletion cap (2) before it sees more than the limit, so a
    count that restarted every pass would never trip and would delete 2 jobs every 15
    minutes. Counted over the process, the total stays within the limit."""
    monkeypatch.setattr(cleanup, "ORPHAN_LIST_BATCH", 2)
    monkeypatch.setattr(cleanup, "MAX_ORPHANS_PER_SWEEP", 2)
    env.objects = _stems_only(0, 30)
    total = sum(_run(FakeConn({})) for _ in range(10))
    assert total <= cleanup.MAX_UNKNOWN_PROCESSED_JOBS
    assert len(env.sent) == 1


def test_a_live_database_never_latches_the_pass(env):
    """The latch only ever closes on evidence: passes over live jobs plus abandoned uploads
    keep running and keep reaping the uploads."""
    live = {_id(i): False for i in range(10)}
    for n in range(3):
        env.objects = _processed(0, 10) + [f"{_id(100 + n)}/_input.mp3"]
        assert _run(FakeConn(live)) == 1
    assert env.sent == []
    assert not cleanup._orphan_brake_tripped


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
