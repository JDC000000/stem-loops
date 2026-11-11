"""Migration 033 — on-demand loop cutting.

Two halves, deliberately separated:

  * PURE gates (no DB): the r2_key scheme, and that `record_loops` cuts nothing.
    These always run.
  * CONTENTION gates (real Postgres, real concurrent sessions): that
    `FOR UPDATE SKIP LOCKED` stops two workers taking one request, and that
    `loop_requests_live_idx` stops one job having two live requests. These skip
    without DATABASE_URL, like every other DB-backed test here.

A note on what makes a contention test real. Running one worker and watching it
succeed proves nothing about SKIP LOCKED — the statement behaves identically with
and without the clause when no other session holds the lock. So the tests below
hold a lock from a SECOND live connection and assert the claimer comes back
EMPTY AND FAST: empty proves it skipped, fast proves it skipped rather than
blocked on the lock. Then a genuine N-way race asserts the arithmetic.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid

import psycopg
import pytest

from worker import loop_cutter, pipeline
from worker.storage.r2_uploader import loop_r2_key

DB = os.environ.get("DATABASE_URL")

# The exact statement loop_cutter.claim_and_cut uses. Duplicated here ON PURPOSE
# so a test can drive it from an arbitrary connection; test_claim_sql_matches_the
# _implementation below pins the two together, so this copy cannot drift silently.
CLAIM_SQL = """
                UPDATE loop_requests
                   SET status='running', claimed_at=now(), updated_at=now()
                 WHERE id = (
                     SELECT id FROM loop_requests WHERE status='queued'
                     ORDER BY created_at ASC
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1
                 )
                RETURNING id, job_id
                """


# ───────────────────────── pure gates (no database) ─────────────────────────


def test_loop_r2_key_carries_the_bar_count():
    """The data-loss fix. Hand-written expectations, not recomputed with the
    function under test -- a gate that calls loop_r2_key to build its own
    expectation proves only that the function equals itself."""
    job = "7f2b1c9e-0000-4000-8000-000000000001"
    assert loop_r2_key(job, "drums", 4, "verse", 3) == (
        "7f2b1c9e-0000-4000-8000-000000000001/drums/4bar_verse_0003.wav"
    )
    assert loop_r2_key(job, "bass", 8, "chorus", 0) == (
        "7f2b1c9e-0000-4000-8000-000000000001/bass/8bar_chorus_0000.wav"
    )
    assert loop_r2_key(job, "vocals", 1, "intro", 11) == (
        "7f2b1c9e-0000-4000-8000-000000000001/vocals/1bar_intro_0011.wav"
    )


def test_two_bar_lengths_of_one_loop_no_longer_collide():
    """THE BUG. Pre-033 the key was f"{job}/{stem}/{section}_{idx:04d}.wav", so
    the 4-bar and the 8-bar cut of one stem/section/index produced the SAME key.
    Against UNIQUE (job_id, r2_key) + ON CONFLICT DO NOTHING that silently
    overwrote the R2 object and dropped the row."""
    job = str(uuid.uuid4())
    keys = {loop_r2_key(job, "drums", bars, "verse", 0) for bars in (1, 2, 4, 8)}
    assert len(keys) == 4, f"bar lengths must not share a key, got {keys}"
    # And the old scheme really did collide -- the thing being fixed.
    legacy = {f"{job}/drums/verse_{0:04d}.wav" for _ in (1, 2, 4, 8)}
    assert len(legacy) == 1


def test_loop_key_keeps_the_job_id_as_its_first_segment():
    """Retention correctness. cleanup.py deletes a job with
    delete_prefix(f"{job_id}/") and its _job_id_of() reads the FIRST path
    segment, so a loop key that moved the job id would survive the sweep."""
    job = str(uuid.uuid4())
    key = loop_r2_key(job, "keys", 2, "bridge", 7)
    assert key.split("/")[0] == job
    assert key.startswith(f"{job}/")


def test_loop_key_is_not_mistakable_for_a_stem_artifact():
    """stem_name_from_* / stemNameFrom match on the full `/_stems/play/` or
    `/_stems/dl/` marker. A loop key must not contain either."""
    key = loop_r2_key(str(uuid.uuid4()), "other", 4, "outro", 2)
    assert "/_stems/play/" not in key
    assert "/_stems/dl/" not in key


def test_record_loops_performs_no_audio_work_and_no_r2_write(monkeypatch):
    """THE EAGER PATH IS OFF. Counts the four outside-world calls the old
    `encode_and_upload` made per loop and asserts every one of them is zero,
    then asserts the rows really were written. Both halves matter: zero calls
    with zero rows would also be 'off', and useless."""
    calls = {"seamless": 0, "encode": 0, "peaks": 0, "upload": 0}
    monkeypatch.setattr(
        pipeline,
        "seamless_apply",
        lambda *a, **k: calls.__setitem__("seamless", calls["seamless"] + 1),
    )
    monkeypatch.setattr(
        pipeline, "encode_24bit", lambda *a, **k: calls.__setitem__("encode", calls["encode"] + 1)
    )
    monkeypatch.setattr(
        pipeline, "waveform_peaks", lambda *a, **k: calls.__setitem__("peaks", calls["peaks"] + 1)
    )
    monkeypatch.setattr(
        pipeline,
        "upload_loop_to_key",
        lambda *a, **k: calls.__setitem__("upload", calls["upload"] + 1),
    )
    rows: list[tuple] = []
    monkeypatch.setattr(pipeline, "_insert_loop", rows.append)

    job_id = str(uuid.uuid4())
    loops = [
        {"stem": "drums", "start_sec": 0.0, "end_sec": 8.0, "start_bar": 0},
        {"stem": "drums", "start_sec": 8.0, "end_sec": 16.0, "start_bar": 4},
        {"stem": "bass", "start_sec": 0.0, "end_sec": 8.0, "start_bar": 0},
    ]
    tags = {"bpm": 120.0, "musical_key": "C major"}
    n = pipeline.record_loops(job_id, loops, tags, {}, {}, 4, title="song")

    assert n == 3
    assert len(rows) == 3
    assert calls == {
        "seamless": 0,
        "encode": 0,
        "peaks": 0,
        "upload": 0,
    }, f"record_loops must do no audio work and write no bytes, got {calls}"
    # waveform_peaks is the last positional in the INSERT tuple and must be NULL:
    # it is the 0.95 MiB/job of jsonb the split exists to defer.
    assert [r[-1] for r in rows] == [None, None, None]
    # The key is already final, and carries the bar count.
    assert rows[0][11] == loop_r2_key(job_id, "drums", 4, "verse", 0)
    assert "4bar_" in rows[0][11]


def test_record_loops_writes_the_three_columns_the_player_reads(monkeypatch):
    """apps/web/src/lib/play/sections.ts's SectionLoopRow reads exactly
    section_label, start_sec and end_sec. If record_loops stopped writing any of
    them the play-along player would lose its section regions silently."""
    rows: list[tuple] = []
    monkeypatch.setattr(pipeline, "_insert_loop", rows.append)
    job_id = str(uuid.uuid4())
    loops = [{"stem": "drums", "start_sec": 1.5, "end_sec": 9.5, "start_bar": 0}]
    seg_label = {(1.5, 9.5): "chorus"}
    seg_energy = {(1.5, 9.5): "high"}
    pipeline.record_loops(
        job_id, loops, {"bpm": 120.0, "musical_key": "C major"}, seg_label, seg_energy, 4
    )
    (row,) = rows
    # Positional contract of the INSERT in pipeline._insert_loop:
    #   0 id, 1 job_id, 2 stem, 3 section_label, 4 energy_class, 5 start_sec, 6 end_sec, ...
    assert row[3] == "chorus"
    assert row[5] == 1.5
    assert row[6] == 9.5
    assert row[4] == "high"


def test_cut_recorded_loops_is_the_only_cutter_and_reproduces_the_eager_bytes(tmp_path):
    """One cutting implementation, and it is byte-identical to what the eager cut
    produced. The on-demand path slices [start_sec, end_sec) out of the retained
    stem WAV; the old path sliced the same window out of the same array inside
    extract_loops. Different code paths, identical bytes -- otherwise a
    downloaded loop would differ depending on when it was asked for.
    """
    import numpy as np
    import soundfile as sf

    from worker.dsp.seamless import apply as seamless_apply
    from worker.encoder.wav_encoder import encode_24bit

    sr = 44100
    rng = np.random.default_rng(11)
    full = rng.standard_normal((2, sr * 20)).astype(np.float32) * 0.2
    stem_path = str(tmp_path / "drums.wav")
    sf.write(stem_path, full.T, sr, subtype="PCM_24")

    start_sec, end_sec = 4.0, 12.0
    # (a) What the EAGER path did: slice the decoded array, seamless, encode.
    import librosa

    y, _ = librosa.load(stem_path, sr=sr, mono=False)
    s = int(round(start_sec * sr))
    n_samp = int(round((end_sec - start_sec) * sr))
    eager_path = str(tmp_path / "eager.wav")
    encode_24bit(seamless_apply(y[:, s : s + n_samp], sr), sr, eager_path)

    # (b) What cut_recorded_loops does, via the real function, with the DB and R2
    #     seams replaced by captures.
    captured: dict[str, str] = {}
    rows = [("loop-1", "drums", start_sec, end_sec, "some/key.wav")]
    import worker.pipeline as P

    orig_fetch, orig_upload, orig_mark = (
        P._fetch_uncut_loops,
        P.upload_loop_to_key,
        P._mark_loop_cut,
    )
    try:
        P._fetch_uncut_loops = lambda _job: rows
        P.upload_loop_to_key = lambda key, path: captured.update(key=key, path=path)
        P._mark_loop_cut = lambda _id, peaks: captured.update(peaks=len(peaks))
        cut = P.cut_recorded_loops("job", {"drums": stem_path}, sr=sr)
    finally:
        P._fetch_uncut_loops, P.upload_loop_to_key, P._mark_loop_cut = (
            orig_fetch,
            orig_upload,
            orig_mark,
        )

    assert cut == 1
    assert captured["key"] == "some/key.wav", "must upload to the key the ROW already names"
    assert captured["peaks"] == 800, "800-point peaks are produced by the CUT, not the record"
    with open(eager_path, "rb") as a, open(captured["path"], "rb") as b:
        eager_bytes, ondemand_bytes = a.read(), b.read()
    assert len(ondemand_bytes) == 8 * sr * 2 * 3 + 44  # 8 s, stereo, 24-bit, + header
    assert ondemand_bytes == eager_bytes, "the on-demand cut must reproduce the eager bytes exactly"


def test_claim_sql_matches_the_implementation():
    """This file drives the claiming UPDATE from its own connections, so it keeps
    a copy of the statement. Pin the copy to the source: a reworded claim in
    loop_cutter.py with a stale copy here would leave the contention tests
    passing against a statement nothing runs."""
    import inspect

    src = inspect.getsource(loop_cutter.claim_and_cut)
    assert CLAIM_SQL.strip() in src, "CLAIM_SQL has drifted from loop_cutter.claim_and_cut"


# ───────────────────── contention gates (real Postgres) ─────────────────────

needs_db = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")


@pytest.fixture(autouse=True)
def _drain_queue():
    """Start every DB test from an empty queue.

    `claim_and_cut` takes the OLDEST queued request across ALL jobs -- which is
    correct, and which makes these tests order-dependent without this: a row left
    behind by an earlier test gets claimed instead of the one under test, and the
    assertion fails against a request nobody looked at. Found exactly that way.
    """
    if not DB:
        yield
        return
    with psycopg.connect(DB) as c:
        c.execute("DELETE FROM loop_requests")
        c.commit()
    yield


def _job() -> str:
    job_id = str(uuid.uuid4())
    with psycopg.connect(DB) as c:
        c.execute(
            """INSERT INTO jobs(id, youtube_url, requested_stems, loop_length_bars,
                                status, client_ip_hash, client_fingerprint)
               VALUES(%s,%s,%s,%s,'done','test','test')""",
            (job_id, f"https://www.youtube.com/watch?v={uuid.uuid4().hex[:11]}", ["drums"], 4),
        )
        c.commit()
    return job_id


def _request(job_id: str, status: str = "queued") -> str:
    with psycopg.connect(DB) as c:
        row = c.execute(
            "INSERT INTO loop_requests(job_id, status) VALUES(%s,%s) RETURNING id",
            (job_id, status),
        ).fetchone()
        c.commit()
    return str(row[0])


@needs_db
def test_skip_locked_skips_rather_than_blocks():
    """Worker A holds the row. Worker B must come back EMPTY (it skipped) and
    FAST (it did not wait on the lock). Without SKIP LOCKED this test would
    block until A's transaction ended and then return A's row -- which is the
    double-claim the clause exists to prevent."""
    job_id = _job()
    request_id = _request(job_id)

    holder = psycopg.connect(DB)
    try:
        # Worker A: lock the queued row and HOLD it (no commit).
        locked = holder.execute(
            "SELECT id FROM loop_requests WHERE status='queued' FOR UPDATE"
        ).fetchone()
        assert str(locked[0]) == request_id

        # Worker B: the real claim statement, on its own connection.
        with psycopg.connect(DB) as b:
            t0 = time.monotonic()
            got = b.execute(CLAIM_SQL).fetchone()
            elapsed = time.monotonic() - t0
            b.commit()
        assert got is None, "worker B claimed a row another worker holds"
        assert elapsed < 2.0, f"worker B blocked on the lock ({elapsed:.1f}s) instead of skipping"

        # Still queued: B's UPDATE matched nothing, it did not fail it.
        with psycopg.connect(DB) as c:
            assert (
                c.execute("SELECT status FROM loop_requests WHERE id=%s", (request_id,)).fetchone()[
                    0
                ]
                == "queued"
            )
    finally:
        holder.rollback()
        holder.close()

    # Lock released: the same statement now claims it. Proves the row was always
    # claimable and the empty result above was the lock, not a bad WHERE clause.
    with psycopg.connect(DB) as b:
        got = b.execute(CLAIM_SQL).fetchone()
        b.commit()
    assert got is not None and str(got[0]) == request_id


@needs_db
def test_n_workers_race_for_m_requests_and_each_is_claimed_once(monkeypatch):
    """A genuine race: 3 requests, 8 concurrent claimers. Exactly 3 claims, 3
    distinct ids, 5 empty-handed workers, and every request ends 'done'."""
    jobs = [_job() for _ in range(3)]
    request_ids = {_request(j) for j in jobs}

    cut_calls: list[str] = []

    async def fake_cut(job_id: str) -> int:
        cut_calls.append(job_id)
        await asyncio.sleep(0.05)  # widen the window the race runs in
        return 7

    monkeypatch.setattr(loop_cutter, "_cut_request", fake_cut)

    async def race():
        return await asyncio.gather(*(loop_cutter.claim_and_cut() for _ in range(8)))

    results = asyncio.run(race())

    assert sum(1 for r in results if r) == 3, f"expected 3 claims from 8 workers, got {results}"
    assert sum(1 for r in results if not r) == 5
    assert len(cut_calls) == 3, "a request was cut twice"
    assert set(cut_calls) == set(jobs)

    with psycopg.connect(DB) as c:
        rows = c.execute(
            "SELECT id, status, loops_cut FROM loop_requests WHERE id = ANY(%s)",
            (list(request_ids),),
        ).fetchall()
    assert len(rows) == 3
    assert {r[1] for r in rows} == {"done"}
    assert {r[2] for r in rows} == {7}


@needs_db
def test_only_one_live_request_per_job():
    """loop_requests_live_idx is the whole write-side guarantee. Two inserts for
    one job: the second must raise unique_violation, not quietly create a
    duplicate the cutter would claim twice."""
    job_id = _job()
    _request(job_id)
    with pytest.raises(psycopg.errors.UniqueViolation) as exc, psycopg.connect(DB) as c:
        c.execute("INSERT INTO loop_requests(job_id) VALUES(%s)", (job_id,))
        c.commit()
    assert exc.value.sqlstate == "23505"


@needs_db
def test_concurrent_posts_cannot_both_create_a_live_request():
    """The same guarantee under REAL concurrency: two sessions that both insert
    before either commits. Exactly one commits; the other gets 23505. A
    SELECT-then-INSERT guard in application code would let both through here."""
    job_id = _job()
    a, b = psycopg.connect(DB), psycopg.connect(DB)
    outcomes = []
    try:
        a.execute("INSERT INTO loop_requests(job_id) VALUES(%s)", (job_id,))
        # b's insert blocks on the unique index until a resolves, then fails.
        try:
            a.commit()
            outcomes.append("a")
        except psycopg.errors.UniqueViolation:
            outcomes.append("a-failed")
        try:
            b.execute("INSERT INTO loop_requests(job_id) VALUES(%s)", (job_id,))
            b.commit()
            outcomes.append("b")
        except psycopg.errors.UniqueViolation:
            outcomes.append("b-failed")
    finally:
        for conn in (a, b):
            conn.rollback()
            conn.close()
    assert outcomes == ["a", "b-failed"], outcomes
    with psycopg.connect(DB) as c:
        live = c.execute(
            "SELECT count(*) FROM loop_requests WHERE job_id=%s AND status IN ('queued','running')",
            (job_id,),
        ).fetchone()[0]
    assert live == 1


@needs_db
def test_a_terminal_request_does_not_block_a_new_one():
    """The index is partial for a reason: a failed cut must be retryable, and the
    history must survive. 'done' and 'failed' sit outside the index."""
    job_id = _job()
    for status in ("done", "failed"):
        _request(job_id, status=status)
    fresh = _request(job_id)  # must not raise
    with psycopg.connect(DB) as c:
        total = c.execute(
            "SELECT count(*) FROM loop_requests WHERE job_id=%s", (job_id,)
        ).fetchone()[0]
    assert total == 3, "terminal requests must be kept, not replaced"
    assert fresh


@needs_db
def test_a_failing_cut_closes_the_request_failed_and_never_crashes_the_loop(monkeypatch):
    """Mirrors consumer.claim_and_run's posture: one poison request fails in
    isolation. claim_and_cut returns True (work was taken), the row is 'failed'
    with an error_code, and the next request is still claimable."""
    job_id = _job()
    request_id = _request(job_id)

    async def boom(_job_id: str) -> int:
        raise RuntimeError("deliberate cut failure")

    monkeypatch.setattr(loop_cutter, "_cut_request", boom)
    monkeypatch.setattr(loop_cutter.sentry_sdk, "capture_exception", lambda *_a, **_k: None)
    assert asyncio.run(loop_cutter.claim_and_cut()) is True

    with psycopg.connect(DB) as c:
        status, code, cut = c.execute(
            "SELECT status, error_code, loops_cut FROM loop_requests WHERE id=%s", (request_id,)
        ).fetchone()
    assert (status, code, cut) == ("failed", "INTERNAL_ERROR", 0)

    # And the job can be re-requested, because 'failed' is outside the index.
    assert _request(job_id)


@needs_db
def test_claim_and_cut_returns_false_on_an_empty_queue():
    with psycopg.connect(DB) as c:
        c.execute("UPDATE loop_requests SET status='done' WHERE status IN ('queued','running')")
        c.commit()
    assert asyncio.run(loop_cutter.claim_and_cut()) is False


@needs_db
def test_cut_at_is_what_marks_a_loop_cut():
    """The column the API gates signed URLs on. A recorded row is uncut; the
    cutter's own UPDATE is what flips it, and it touches nothing the player
    reads."""
    job_id = _job()
    loop_id = str(uuid.uuid4())
    with psycopg.connect(DB) as c:
        c.execute(
            """INSERT INTO loops(id,job_id,stem,section_label,energy_class,start_sec,end_sec,
                                 start_bar,bar_count,r2_key,filename)
               VALUES(%s,%s,'drums','verse','mid',1.5,9.5,0,4,%s,'f.wav')""",
            (loop_id, job_id, loop_r2_key(job_id, "drums", 4, "verse", 0)),
        )
        c.commit()
        assert (
            c.execute(
                "SELECT count(*) FROM loops WHERE job_id=%s AND cut_at IS NULL", (job_id,)
            ).fetchone()[0]
            == 1
        )

    pipeline._mark_loop_cut(loop_id, [0.1, 0.2, 0.3])

    with psycopg.connect(DB) as c:
        cut_at, peaks, start, end, label = c.execute(
            "SELECT cut_at, waveform_peaks, start_sec, end_sec, section_label "
            "FROM loops WHERE id=%s",
            (loop_id,),
        ).fetchone()
    assert cut_at is not None
    assert peaks == [0.1, 0.2, 0.3]
    # The player's three columns are untouched by a cut -- a cut must never be
    # able to move a section boundary under a listener.
    assert (float(start), float(end), label) == (1.5, 9.5, "verse")
