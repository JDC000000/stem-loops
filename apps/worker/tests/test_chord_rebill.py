"""A Klangio request is $0.20 and has no idempotency key: one pipeline job may pay AT MOST ONCE.

Covers the three re-bill paths (failed R2 upload, zero-segment result, SIGTERM/deploy during the
up-to-600 s poll), the pre-POST marker, chord-input selection against the real htdemucs_6s stem
set, and the chord stage's position in the pipeline. The billable unit is the Klangio POST, so
the tests drive the REAL ``KlangioChordSource`` through ``httpx.MockTransport`` and count POSTs;
``recognize`` itself may legitimately run twice (the second call reattaches with free GETs).

Every ledger test runs against an in-memory ledger AND the real ``jobs.klangio_job_id`` column
(the latter skipped without a local DATABASE_URL).
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from tests.test_pipeline_chord_hook import REAL_6S_STEMS, _FakeR2, _make_stems
from worker import pipeline
from worker.chord_providers import klangio as kg
from worker.chord_source import ChordJobLedger, ChordSubmitUncertain

JOB = "817a59d1-0000-4000-8000-000000000000"  # Klangio's job id
RESULT = [[0.0, 2.0, "C:maj"], [2.0, 4.0, "G:7"]]
DB = os.environ.get("DATABASE_URL")
# jobs.id is a uuid column. Fixed (not random) so a failure names its scenario. Anything that
# reaches a real DB statement (CI sets DATABASE_URL) rejects a non-uuid id like "job-ok".
JOB_BEATLESS = "00000000-0000-4000-8000-0000000b0001"  # beatless track: extract fails
JOB_OK = "00000000-0000-4000-8000-0000000b0002"  # chords run after extract
JOB_OFF = "00000000-0000-4000-8000-0000000b0003"  # CHORDS_PROVIDER unset
_DB_OK = bool(DB) and any(h in (DB or "") for h in ("127.0.0.1", "localhost"))


class _Killed(BaseException):
    """SIGTERM / OOM stand-in: BaseException so no `except Exception` in the hook eats it."""


class FakeKlangioServer:
    """Counts POSTs (the only billable call) and can 'kill the process' at a chosen point."""

    def __init__(self, result: object = RESULT) -> None:
        self.requests: list[httpx.Request] = []
        self.result = result
        self.kill_on: str | None = None  # "post" | "status"
        self.on_status = None  # optional callback, runs when a status GET arrives

    @property
    def posts(self) -> int:
        return sum(1 for r in self.requests if r.method == "POST")

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.method == "POST" and path == "/chord-recognition":
            if self.kill_on == "post":
                self.kill_on = None
                raise _Killed  # request was sent (and billed); we die before reading the reply
            return httpx.Response(200, json={"job_id": JOB})
        if request.method == "GET" and path == f"/job/{JOB}/status":
            if self.on_status:
                self.on_status()
            if self.kill_on == "status":
                self.kill_on = None
                raise _Killed
            return httpx.Response(200, json={"status": "COMPLETED"})
        if request.method == "GET" and path == f"/job/{JOB}/json":
            return httpx.Response(200, json=self.result)
        return httpx.Response(404, json={})

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        real_client = httpx.Client
        transport = httpx.MockTransport(self.handler)
        monkeypatch.setattr(
            kg.httpx,
            "Client",
            lambda *a, **k: real_client(*a, transport=transport, **k),
        )


class MemoryLedger:
    """Same contract as pipeline._KlangioJobLedger, held in a dict (one row per job)."""

    SENTINEL = pipeline._KlangioJobLedger.SENTINEL
    rows: dict[str, str | None] = {}

    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        self.rows.setdefault(job_id, None)

    def existing(self) -> str | None:
        v = self.rows[self.job_id]
        if v == self.SENTINEL:
            raise ChordSubmitUncertain("sentinel")
        return v

    def claim(self) -> None:
        if self.rows[self.job_id] is not None:
            raise ChordSubmitUncertain("held")
        self.rows[self.job_id] = self.SENTINEL

    def record(self, provider_job_id: str) -> None:
        assert self.rows[self.job_id] == self.SENTINEL
        self.rows[self.job_id] = provider_job_id

    def release(self) -> None:
        if self.rows[self.job_id] == self.SENTINEL:
            self.rows[self.job_id] = None


def _make_job_row() -> str:
    import psycopg

    job_id = str(uuid.uuid4())
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute(
            "INSERT INTO public.jobs (id, youtube_url, status, client_ip_hash, loop_length_bars) "
            "VALUES (%s, 'https://youtu.be/x', 'extracting', 'test-rebill', 4)",
            (job_id,),
        )
        c.commit()
    return job_id


@pytest.fixture(
    params=[
        "memory",
        pytest.param(
            "postgres", marks=pytest.mark.skipif(not _DB_OK, reason="needs local DATABASE_URL")
        ),
    ]
)
def job_id(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch):
    if request.param == "memory":
        MemoryLedger.rows = {}
        monkeypatch.setattr(pipeline, "_KlangioJobLedger", MemoryLedger)
        yield f"job-{uuid.uuid4()}"
        return
    monkeypatch.setattr(pipeline, "DATABASE_URL", DB)
    jid = _make_job_row()
    yield jid
    import psycopg

    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        c.execute("DELETE FROM public.jobs WHERE id=%s", (jid,))
        c.commit()


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> FakeKlangioServer:
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    monkeypatch.setenv("KLANGIO_API_KEY", "kl-test")
    monkeypatch.setattr(pipeline, "CHORDS_DEFAULT_STEM", pipeline.HARMONIC_MIX)
    monkeypatch.setattr(kg, "MIN_REQUEST_INTERVAL_SEC", 0.0)
    monkeypatch.setattr(kg, "POLL_INTERVAL_SEC", 0.0)
    monkeypatch.setattr(kg, "MIN_AUDIO_SEC", 0.0)  # fixture WAVs are 0.2 s
    server = FakeKlangioServer()
    server.install(monkeypatch)
    return server


@pytest.fixture
def stems(tmp_path: Path) -> dict[str, str]:
    return _make_stems(tmp_path)


def _hook(job: str, stem_paths: dict, r2) -> MagicMock:
    """Run the hook against the real Klangio source; return a spy on recognize()."""
    spy = MagicMock()
    real = kg.KlangioChordSource.recognize

    def counted(self, *a, **k):
        spy()
        return real(self, *a, **k)

    with (
        patch.object(kg.KlangioChordSource, "recognize", counted),
        patch("worker.storage.r2_uploader._r2", return_value=r2),
    ):
        pipeline._maybe_run_chord_recognition(job, stem_paths, list(stem_paths))
    return spy


def _artifact(r2: _FakeR2, job: str) -> dict:
    return json.loads(r2.objects[f"jobs/{job}/play.chords.json"])


# ------------------------- path (a): failed R2 upload -------------------------
def test_failed_upload_then_rerun_does_not_pay_twice(
    job_id: str, stems: dict[str, str], env: FakeKlangioServer
) -> None:
    r2 = _FakeR2()
    r2.put_object = MagicMock(side_effect=RuntimeError("R2 outage"))  # type: ignore[method-assign]
    _hook(job_id, stems, r2)  # paid result is produced, upload fails (swallowed)
    assert env.posts == 1
    assert f"jobs/{job_id}/play.chords.json" not in r2.objects

    healthy = _FakeR2()
    _hook(job_id, stems, healthy)  # reaper requeue after the outage
    assert env.posts == 1, "rerun must reattach (free GETs), not POST again"
    assert [s["label"] for s in _artifact(healthy, job_id)["segments"]] == ["C:maj", "G:7"]


# ------------------------- path (b): zero segments -------------------------
def test_zero_segments_is_a_complete_result_not_a_reason_to_rebill(
    job_id: str, stems: dict[str, str], env: FakeKlangioServer
) -> None:
    env.result = []  # silent / atonal track
    r2 = _FakeR2()
    first = _hook(job_id, stems, r2)
    assert _artifact(r2, job_id)["segments"] == []
    second = _hook(job_id, stems, r2)  # reaper requeue
    assert env.posts == 1
    assert first.call_count + second.call_count == 1, "recognize() must run once in total"
    assert r2.put_object.call_count == 1


def test_empty_segments_artifact_counts_as_done_but_tombstone_does_not(_chord_env=None) -> None:
    r2 = _FakeR2(
        {
            "jobs/z/play.chords.json": b'{"segments": []}',
            "jobs/t/play.chords.json": b'{"status":"unavailable","reason":"provider_failed"}',
        }
    )
    with (
        patch("worker.storage.r2_uploader._r2", return_value=r2),
        patch.dict(os.environ, {"R2_BUCKET_NAME": "b"}),
    ):
        assert pipeline._existing_play_chords("z") is True
        assert pipeline._existing_play_chords("t") is False


# ------------------------- path (c): SIGTERM during the poll -------------------------
def test_sigterm_during_poll_then_requeue_reattaches(
    job_id: str, stems: dict[str, str], env: FakeKlangioServer
) -> None:
    env.kill_on = "status"
    r2 = _FakeR2()
    with pytest.raises(_Killed):
        _hook(job_id, stems, r2)  # deploy kills the worker mid-poll; POST already sent
    assert env.posts == 1 and not r2.objects

    _hook(job_id, stems, r2)  # reaper requeue on the new machine
    assert env.posts == 1, "requeue must reattach to the recorded Klangio job"
    assert [s["label"] for s in _artifact(r2, job_id)["segments"]] == ["C:maj", "G:7"]


def test_death_between_post_and_recording_the_id_never_posts_again(
    job_id: str, stems: dict[str, str], env: FakeKlangioServer
) -> None:
    """The marker is written BEFORE the POST. Dying in the window leaves it behind, so the
    rerun refuses to POST (at-most-once) and tells the user chords are unavailable."""
    env.kill_on = "post"
    r2 = _FakeR2()
    with pytest.raises(_Killed):
        _hook(job_id, stems, r2)
    assert env.posts == 1

    _hook(job_id, stems, r2)
    assert env.posts == 1
    assert json.loads(r2.objects[f"jobs/{job_id}/play.chords.json"]) == {
        "status": "unavailable",
        "reason": "provider_failed",
    }


def test_job_id_is_recorded_before_polling_starts(
    job_id: str, stems: dict[str, str], env: FakeKlangioServer
) -> None:
    seen: list[str | None] = []
    env.on_status = lambda: seen.append(pipeline._KlangioJobLedger(job_id).existing())
    _hook(job_id, stems, _FakeR2())
    assert seen and all(v == JOB for v in seen)


def test_quota_refusal_releases_the_claim(
    job_id: str, env: FakeKlangioServer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KLANGIO_MONTHLY_CAP", "0")
    wav = _make_stems(tmp_path, ("keys",))["keys"]
    ledger = pipeline._KlangioJobLedger(job_id)
    with pytest.raises(Exception, match="cap"):
        kg.KlangioChordSource().recognize(Path(wav), ledger=ledger)
    assert env.requests == []
    assert ledger.existing() is None  # nothing sent -> nothing owed -> retryable later


def test_second_claim_is_refused(job_id: str) -> None:
    ledger: ChordJobLedger = pipeline._KlangioJobLedger(job_id)
    ledger.claim()
    with pytest.raises(ChordSubmitUncertain):
        pipeline._KlangioJobLedger(job_id).claim()
    ledger.record("abc")
    assert pipeline._KlangioJobLedger(job_id).existing() == "abc"


# ------------------------- chord input vs the real stem set -------------------------
def test_real_6s_stem_set_yields_the_harmonic_mix(stems: dict[str, str]) -> None:
    assert set(stems) == set(REAL_6S_STEMS)
    chosen = pipeline._choose_chord_input(stems)
    assert chosen is not None and chosen[0] == pipeline.HARMONIC_MIX


@pytest.mark.parametrize(
    "present",
    [
        ("drums", "bass", "vocals", "other"),  # user deselected guitar AND keys
        ("vocals", "drums", "bass", "other", "guitar"),  # only keys deselected
        ("vocals", "drums", "bass", "other", "keys"),  # only guitar deselected
    ],
    ids=["no-guitar-no-keys", "no-keys", "no-guitar"],
)
def test_deselected_subset_never_degrades_to_bare_other(
    tmp_path: Path, present: tuple[str, ...]
) -> None:
    sub = _make_stems(tmp_path, present)
    chosen = pipeline._choose_chord_input(sub)
    if len([n for n in ("keys", "guitar", "other") if n in present]) < 2:
        assert chosen is None  # skip without spending; NOT ('other', ...)
    else:
        assert chosen is not None and chosen[0] == pipeline.HARMONIC_MIX


def test_single_harmonic_stem_spends_nothing(
    tmp_path: Path, env: FakeKlangioServer, job_id: str
) -> None:
    sub = _make_stems(tmp_path, ("drums", "bass", "vocals", "other"))
    r2 = _FakeR2()
    spy = _hook(job_id, sub, r2)
    assert spy.call_count == 0 and env.requests == []
    assert json.loads(r2.objects[f"jobs/{job_id}/play.chords.json"])["reason"] == "not_attempted"


def test_fetch_stems_includes_chord_stems_the_user_did_not_toggle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    urls = {n: f"https://cdn/{n}.wav" for n in REAL_6S_STEMS}
    fetched: list[str] = []

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def raise_for_status(self):
            pass

        def iter_bytes(self, _n):
            yield b"RIFF"

    def fake_stream(method, url, **kw):
        fetched.append(url.rsplit("/", 1)[1][:-4])
        return _Resp()

    monkeypatch.setattr(pipeline.httpx, "stream", fake_stream)
    requested = ["drums", "bass", "vocals", "other"]
    paths = pipeline._fetch_stems(urls, requested, ("keys", "guitar", "bass"))
    assert set(paths) == {"drums", "bass", "vocals", "other", "keys", "guitar"}
    fetched.clear()
    paths = pipeline._fetch_stems(urls, requested)
    assert set(paths) == set(requested)  # nothing extra when chords are off


# ------------------------- ordering: chords only after extract_and_tag -------------------------
def _orchestrate(monkeypatch: pytest.MonkeyPatch, *, extract_raises: Exception | None):
    import asyncio

    from worker import replicate_client

    # CI sets STUB_MODE=true for the whole worker suite. _run_pipeline then short-circuits into
    # _run_stub (real INSERT/UPDATE against Postgres) and never reaches the ordering under test.
    monkeypatch.delenv("STUB_MODE", raising=False)
    calls: list[str] = []
    row = ("", ["drums", "bass", "vocals", "other"], 4, "upload", "uploads/x", "song.mp3")
    monkeypatch.setattr(pipeline, "_fetch_job", lambda _j: row)
    monkeypatch.setattr(pipeline, "set_status", _async(lambda *a, **k: None))
    monkeypatch.setattr(pipeline, "emit_event", _async(lambda *a, **k: None))
    monkeypatch.setattr(pipeline, "_prepare_upload_source", lambda *a: "https://audio")
    monkeypatch.setattr(pipeline, "submit_or_reattach", lambda *a: "pred")
    urls = {n: f"https://cdn/{n}.wav" for n in REAL_6S_STEMS}
    monkeypatch.setattr(pipeline, "poll_until_done", lambda *a: (urls, 0.1))
    got: dict = {}

    def fetch(stem_urls, requested, also=()):
        got["also"] = also
        calls.append("fetch")
        return {n: f"/x/{n}.wav" for n in stem_urls if n in requested or n in also}

    monkeypatch.setattr(pipeline, "_fetch_stems", fetch)

    def extract(*a, **k):
        calls.append("extract")
        if extract_raises:
            raise extract_raises
        return [], {"bpm": 120.0, "musical_key": "C major"}, {}, {}

    monkeypatch.setattr(pipeline, "extract_and_tag", extract)

    def chords(job_id, stem_paths, requested):
        calls.append("chords")
        got["chord_stems"] = set(stem_paths)

    monkeypatch.setattr(pipeline, "_maybe_run_chord_recognition", chords)
    monkeypatch.setattr(pipeline, "encode_and_upload", lambda *a, **k: 0)
    failed: list[tuple] = []
    monkeypatch.setattr(pipeline, "_fail", _async(lambda *a: failed.append(a)))
    monkeypatch.setattr(replicate_client, "_heartbeat", lambda *_: None)
    return calls, got, failed, asyncio


def _async(fn):
    async def run(*a, **k):
        return fn(*a, **k)

    return run


def test_beatless_track_fails_before_any_chord_request(monkeypatch: pytest.MonkeyPatch) -> None:
    from worker.errors import ExtractionFailedError

    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    calls, _, failed, asyncio = _orchestrate(monkeypatch, extract_raises=ExtractionFailedError("x"))
    with pytest.raises(ExtractionFailedError):
        asyncio.run(pipeline._run_pipeline(JOB_BEATLESS))
    assert calls == [
        "fetch",
        "extract",
    ], "chord stage must not run (or bill) after a failed extract"
    assert failed and failed[0][1] == "EXTRACTION_FAILED"


def test_chords_run_after_extract_with_the_harmonic_stems_the_user_deselected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    calls, got, _, asyncio = _orchestrate(monkeypatch, extract_raises=None)
    asyncio.run(pipeline._run_pipeline(JOB_OK))
    assert calls == ["fetch", "extract", "chords"]
    assert {"keys", "guitar", "other", "bass"} <= got["chord_stems"]
    assert pipeline._choose_chord_input({n: _tmp_wav(n) for n in got["chord_stems"]}) is not None


def test_chords_disabled_still_fetches_all_six_stems_for_the_mixer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """V3-J2 changed this contract deliberately; the old assertion was `also == ()`.

    Before V3-J2 the only reason to fetch a stem the user had not requested was the
    chord harmonic mix, so with ``CHORDS_PROVIDER=''`` there was nothing extra to
    pull and the optimisation was free. The play-along mixer changed that: it needs
    a fader per instrument over the whole song, so ALL SIX stems are retained
    regardless of ``requested_stems`` AND regardless of whether chords run.

    The defect this replaces was silent. A job requesting only ``vocals`` with
    chords ON retained vocals/keys/guitar/other/bass and NO DRUMS, and the mixer
    then played a drumless song with no error of any kind.

    Fetching six stems that Replicate has ALREADY produced costs CDN bandwidth, not
    another GPU-second: the separation is billed once and emits all six either way.
    So widening `also` does not widen the bill, which is why this change is safe to
    make in a file about rebilling.

    This test deliberately does NOT assert "no chord stage ran". `_orchestrate`
    monkeypatches `_maybe_run_chord_recognition` wholesale, so the harness records
    that hook as called regardless of `CHORDS_PROVIDER` — the real function's
    `_chords_enabled()` early return is stubbed out. An assertion on `calls` here
    would be testing the stub. (I tried it; it failed, correctly.) The no-spend
    guarantees live in this file's own `test_single_harmonic_stem_spends_nothing`
    and `test_beatless_track_fails_before_any_chord_request`.
    """
    monkeypatch.setenv("CHORDS_PROVIDER", "")
    _, got, _, asyncio = _orchestrate(monkeypatch, extract_raises=None)
    asyncio.run(pipeline._run_pipeline(JOB_OFF))
    assert set(got["also"]) == set(pipeline.ALL_STEMS)
    assert len(pipeline.ALL_STEMS) == 6


_TMP: dict[str, str] = {}


def _tmp_wav(name: str) -> str:
    if name not in _TMP or not os.path.exists(_TMP[name]):
        import tempfile

        d = tempfile.mkdtemp()
        _TMP.update(_make_stems(Path(d), REAL_6S_STEMS))
    return _TMP[name]
