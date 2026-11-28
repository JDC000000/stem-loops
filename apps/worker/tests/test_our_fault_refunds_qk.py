"""QK-2 / QK-4 (QA-worker 2026-11-26): our own failures must be OUR-fault codes.

QK-2: a job whose stem retention saved no playable stem used to end ``done`` with 0/6 stems
(credit / monthly song kept). It now fails UPLOAD_FAILED (in OUR_FAULT_CODES), reported to
Sentry. #490 (Jon E2 = a): so does a PARTIAL set (1-5 of the six htdemucs_6s stems playable),
and the stem objects that did upload are deleted so a failed job leaves no orphaned WAV / Opus.
A drain-abandoned report keeps today's behaviour (the job is requeued, not failed).

QK-4: the kill switch, a failed blocklist read and a worker with ALLOW_YOUTUBE_INPUT off were
DOWNLOAD_BLOCKED (user fault: no song back, no Sentry). They are now INTERNAL_ERROR
subclasses: the song comes back and Sentry hears of it. A real YouTube block stays
DOWNLOAD_BLOCKED, not refunded and not reported.

No database: every I/O edge of ``_run_pipeline`` is stubbed and the failure call recorded.
The refund / restore itself (decided from the stored code, idempotent) is pinned against
Postgres in test_failed_job_credit_refund.py and test_allowance_restore.py.
"""

from __future__ import annotations

import asyncio

import pytest

from worker import downloader, pipeline, replicate_client
from worker.downloader import fetch_gates
from worker.errors import (
    BlocklistUnavailableError,
    DownloadBlockedError,
    FetchPausedError,
    InternalError,
    UploadFailedError,
    YoutubeInputDisabledError,
)
from worker.job_failure import OUR_FAULT_CODES

JOB = "00000000-0000-4000-8000-00000000c024"
SIX = ("vocals", "drums", "bass", "other", "guitar", "keys")
URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

OURS = (FetchPausedError, BlocklistUnavailableError, YoutubeInputDisabledError)


# ------------------------------------------------------------------ the taxonomy (QK-4)


@pytest.mark.parametrize("cls", OURS)
def test_each_of_our_link_refusals_is_an_our_fault_code(cls):
    err = cls("x")
    assert err.error_code == "INTERNAL_ERROR"
    assert err.error_code in OUR_FAULT_CODES
    assert isinstance(err, InternalError)
    assert not isinstance(err, DownloadBlockedError), "would be caught/classed as a user block"
    assert err.failure_reason  # a low-cardinality Sentry tag


def test_the_failure_reasons_are_distinct():
    assert {c.failure_reason for c in OURS} == {
        "fetch_paused",
        "blocklist_read_failed",
        "youtube_input_disabled",
    }


def test_a_real_youtube_block_is_still_the_users():
    err = DownloadBlockedError("bot wall")
    assert err.error_code == "DOWNLOAD_BLOCKED"
    assert err.error_code not in OUR_FAULT_CODES


def test_the_kill_switch_message_still_points_at_drop_a_file():
    assert "Upload the audio file" in FetchPausedError("x").user_message


# ------------------------------------------------------------------ the blocklist gate (QK-4)


def test_a_failed_blocklist_read_fails_closed_with_our_code(monkeypatch):
    def broken():
        raise OSError("connection refused")

    monkeypatch.setattr(fetch_gates, "_connect", broken)
    with pytest.raises(BlocklistUnavailableError) as ei:
        fetch_gates.is_blocklisted("dQw4w9WgXcQ")
    assert ei.value.error_code == "INTERNAL_ERROR"
    assert isinstance(ei.value.__cause__, OSError)


def test_download_audio_refuses_before_any_fetch_when_the_blocklist_is_unreadable(monkeypatch):
    def broken():
        raise OSError("db down")

    fetched: list = []
    monkeypatch.setattr(fetch_gates, "_connect", broken)
    monkeypatch.setattr(fetch_gates, "fetch_paused", lambda: fetched.append("paused?"))
    monkeypatch.setattr(downloader, "_fetch", lambda *a, **k: fetched.append("fetch"))
    with pytest.raises(BlocklistUnavailableError):
        downloader.download_audio(URL, JOB)
    assert fetched == [], "fail closed: no kill-switch read, no fetch"


def test_download_audio_kill_switch_is_our_code_and_fetches_nothing(monkeypatch):
    fetched: list = []
    monkeypatch.setattr(fetch_gates, "is_blocklisted", lambda _v: False)
    monkeypatch.setattr(fetch_gates, "fetch_paused", lambda: "fetch_global")
    monkeypatch.setattr(downloader, "_fetch", lambda *a, **k: fetched.append("fetch"))
    with pytest.raises(FetchPausedError) as ei:
        downloader.download_audio(URL, JOB)
    assert ei.value.error_code == "INTERNAL_ERROR"
    assert fetched == []


# ------------------------------------------------------------------ the pipeline harness


def _async(fn):
    async def run(*a, **k):
        return fn(*a, **k)

    return run


@pytest.fixture
def sentry(monkeypatch):
    sent: list[dict] = []
    monkeypatch.setattr(
        pipeline.sentry_sdk,
        "capture_exception",
        lambda exc=None, **k: sent.append({"exc": exc, **k}),
    )
    monkeypatch.setattr(pipeline, "_reported_once", set())
    return sent


def _drive(monkeypatch, *, kind="upload", download=None, retained=None):
    """Walk the real _run_pipeline with every I/O edge stubbed; record what happened."""
    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.delenv("STEMLOOPS_AUDIO_URL", raising=False)
    monkeypatch.delenv("STEMLOOPS_AUDIO_FILE", raising=False)
    seen: dict = {"status": [], "events": [], "failed": [], "downloads": 0, "deleted": []}
    if kind == "upload":
        row = ("", ["drums"], 4, "upload", "uploads/x", "song.mp3")
    else:
        row = (URL, ["drums"], 4, "youtube", None, None)
    monkeypatch.setattr(pipeline, "_fetch_job", lambda _j: row)
    monkeypatch.setattr(pipeline, "set_status", _async(lambda _j, s: seen["status"].append(s)))
    monkeypatch.setattr(
        pipeline,
        "emit_event",
        _async(
            lambda _j, stage, phase, pct=None, detail=None: seen["events"].append((stage, phase))
        ),
    )
    monkeypatch.setattr(pipeline, "_prepare_upload_source", lambda *a: ("https://audio", None))

    def dl(*a, **k):
        seen["downloads"] += 1
        if download is not None:
            raise download
        return ("https://audio", "cobalt")

    monkeypatch.setattr(pipeline, "download_audio", dl)
    monkeypatch.setattr(pipeline, "_record_title", lambda *a: None, raising=False)
    monkeypatch.setattr(pipeline, "submit_or_reattach", lambda *a: "pred")
    urls = {n: f"https://cdn/{n}.wav" for n in SIX}
    monkeypatch.setattr(pipeline, "poll_until_done", lambda *a: (urls, 0.1))
    monkeypatch.setattr(
        pipeline, "_fetch_stems", lambda stem_urls, *_a: {n: f"/x/{n}.wav" for n in stem_urls}
    )
    monkeypatch.setattr(
        pipeline,
        "extract_and_tag",
        lambda *a, **k: ([], {"bpm": None, "musical_key": "C major"}, {}, {}),
    )
    monkeypatch.setattr(pipeline, "_maybe_run_chord_recognition", lambda *a: None)
    monkeypatch.setattr(pipeline, "record_loops", lambda *a, **k: 0)
    report = retained if retained is not None else {"play": list(SIX), "download": list(SIX)}
    monkeypatch.setattr(pipeline, "retain_stems", lambda _j, _p: report)
    monkeypatch.setattr(pipeline, "delete_objects", lambda keys: seen["deleted"].extend(keys))
    monkeypatch.setattr(pipeline, "_fail", _async(lambda *a: seen["failed"].append(a)))
    monkeypatch.setattr(replicate_client, "_heartbeat", lambda *_: None)
    return seen


# ------------------------------------------------------------------ QK-2 through the pipeline


def test_zero_playable_stems_fails_upload_failed_not_done(monkeypatch, sentry):
    seen = _drive(monkeypatch, retained={"play": [], "download": [], "complete": False})
    with pytest.raises(UploadFailedError):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert [f[1] for f in seen["failed"]] == ["UPLOAD_FAILED"]
    assert "UPLOAD_FAILED" in OUR_FAULT_CODES, "so the credit / song is returned"
    assert "done" not in seen["status"]
    assert ("uploading", "completed") not in seen["events"]
    assert len(sentry) == 1
    assert sentry[0]["tags"] == {
        "error_code": "UPLOAD_FAILED",
        "failure_reason": "no_playable_stems",
    }


def test_six_wavs_but_no_playable_opus_still_fails(monkeypatch, sentry):
    # The mixer streams the Opus artifact only: downloadable WAVs do not make it playable.
    seen = _drive(monkeypatch, retained={"play": [], "download": list(SIX), "complete": False})
    with pytest.raises(UploadFailedError):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert [f[1] for f in seen["failed"]] == ["UPLOAD_FAILED"]


def _keys(played, downloadable):
    return sorted(
        [f"{JOB}/_stems/play/{n}.opus" for n in played]
        + [f"{JOB}/_stems/dl/{n}.wav" for n in downloadable]
    )


@pytest.mark.parametrize(
    "played", [["drums"], ["drums", "bass", "vocals"], [n for n in SIX if n != "keys"]]
)
def test_a_partial_set_fails_upload_failed_and_is_refunded(monkeypatch, sentry, played):
    # #490, Jon E2 = (a): fewer than the six stems htdemucs_6s produces is not 'done'.
    seen = _drive(monkeypatch, retained={"play": played, "download": list(SIX)})
    with pytest.raises(UploadFailedError) as ei:
        asyncio.run(pipeline._run_pipeline(JOB))
    assert [f[1] for f in seen["failed"]] == ["UPLOAD_FAILED"]
    assert "done" not in seen["status"]
    assert ("uploading", "completed") not in seen["events"]
    assert ei.value.failure_reason == "partial_stem_set"
    assert f"{len(played)}/6 playable" in str(ei.value)
    assert [s["tags"] for s in sentry] == [
        {"error_code": "UPLOAD_FAILED", "failure_reason": "partial_stem_set"}
    ]


def test_a_full_set_still_finishes_done_and_deletes_nothing(monkeypatch, sentry):
    seen = _drive(monkeypatch, retained={"play": list(SIX), "download": list(SIX)})
    asyncio.run(pipeline._run_pipeline(JOB))
    assert seen["failed"] == []
    assert seen["status"][-1] == "done"
    assert seen["deleted"] == []
    assert sentry == []


def test_a_full_playable_set_with_a_missing_wav_still_finishes_done(monkeypatch, sentry):
    # The threshold counts PLAYABLE (Opus) stems, the artifact the mixer streams (#490 text:
    # "partial stem sets (1-5 Opus)"); a missing WAV keeps retain_stems' own Sentry error.
    seen = _drive(monkeypatch, retained={"play": list(SIX), "download": list(SIX[:5])})
    asyncio.run(pipeline._run_pipeline(JOB))
    assert seen["failed"] == []
    assert seen["status"][-1] == "done"


def test_duplicate_or_unknown_names_cannot_make_a_partial_set_look_full():
    report = {"play": ["drums"] * 6, "download": []}
    with pytest.raises(UploadFailedError):
        pipeline._require_a_full_stem_set(report)
    report = {"play": ["drums", "bass", "vocals", "other", "guitar", "piano"], "download": []}
    with pytest.raises(UploadFailedError):
        pipeline._require_a_full_stem_set(report)


@pytest.mark.parametrize(
    "played,downloadable",
    [([], []), ([], list(SIX)), (["drums"], ["drums", "bass"]), (list(SIX[:5]), list(SIX))],
)
def test_a_failed_stem_set_deletes_every_object_it_uploaded(
    monkeypatch, sentry, played, downloadable
):
    # #490: the WAVs (and Opus) of a failed job used to stay in R2 until the retention sweep.
    seen = _drive(monkeypatch, retained={"play": played, "download": downloadable})
    with pytest.raises(UploadFailedError):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert sorted(seen["deleted"]) == _keys(played, downloadable)


def test_the_stems_are_deleted_before_the_job_is_failed(monkeypatch, sentry):
    order: list[str] = []
    seen = _drive(monkeypatch, retained={"play": ["drums"], "download": ["drums"]})
    monkeypatch.setattr(pipeline, "delete_objects", lambda keys: order.append("delete"))
    monkeypatch.setattr(pipeline, "_fail", _async(lambda *a: order.append("fail")))
    with pytest.raises(UploadFailedError):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert order == ["delete", "delete", "fail"]
    assert seen["failed"] == []


def test_a_delete_error_never_masks_the_failure_or_skips_other_keys(monkeypatch, sentry):
    seen = _drive(monkeypatch, retained={"play": ["drums", "bass"], "download": []})
    tried: list = []

    def flaky(keys):
        tried.extend(keys)
        if keys == [f"{JOB}/_stems/play/bass.opus"]:
            raise RuntimeError("R2 500")

    monkeypatch.setattr(pipeline, "delete_objects", flaky)
    with pytest.raises(UploadFailedError):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert [f[1] for f in seen["failed"]] == ["UPLOAD_FAILED"]
    assert sorted(tried) == _keys(["drums", "bass"], [])


def test_a_drain_abandoned_report_is_not_failed(monkeypatch, sentry):
    # QA-63: the job is back in the queue and the rerun uploads all six; never fail it here,
    # and never delete what it uploaded (the rerun overwrites the same deterministic keys).
    seen = _drive(
        monkeypatch,
        retained={"play": ["drums"], "download": ["drums"], "complete": False, "abandoned": True},
    )
    asyncio.run(pipeline._run_pipeline(JOB))
    assert seen["failed"] == []
    assert seen["deleted"] == []


def test_require_a_full_stem_set_reads_the_real_report_shape():
    pipeline._require_a_full_stem_set({"play": list(SIX), "download": []})
    pipeline._require_a_full_stem_set({"play": [], "abandoned": True})
    with pytest.raises(UploadFailedError) as ei:
        pipeline._require_a_full_stem_set({"play": [], "download": ["drums", "bass"]})
    assert ei.value.failure_reason == "no_playable_stems"
    assert "2 downloadable" in str(ei.value)
    with pytest.raises(UploadFailedError) as ei:
        pipeline._require_a_full_stem_set({"play": list(SIX[:5]), "download": []})
    assert ei.value.failure_reason == "partial_stem_set"


def test_the_threshold_is_the_models_stem_count():
    assert pipeline.ALL_STEMS == SIX, "htdemucs_6s: six stems; N follows ALL_STEMS"


def test_retain_stems_with_every_put_failing_is_caught(monkeypatch, tmp_path):
    """The real retain_stems against an R2 that refuses every PUT: the report it returns is
    exactly the one the new guard fails."""
    paths = {}
    for n in SIX:
        p = tmp_path / f"{n}.wav"
        p.write_bytes(b"RIFF")
        paths[n] = str(p)

    def refuse(*_a, **_k):
        raise RuntimeError("R2 403")

    monkeypatch.setattr(pipeline, "upload_stem", refuse)
    monkeypatch.setattr(pipeline, "_encode_stem_opus", lambda path, *_a, **_k: path)
    monkeypatch.setattr(pipeline, "_drain_abandoned", lambda: False)
    monkeypatch.setattr(pipeline.sentry_sdk, "capture_message", lambda *a, **k: None)
    report = pipeline.retain_stems(JOB, paths)
    assert report["play"] == [] and report["download"] == []
    with pytest.raises(UploadFailedError):
        pipeline._require_a_full_stem_set(report)


# ------------------------------------------------------------------ QK-4 through the pipeline


def test_worker_flag_off_is_our_fault_and_reported_once_per_process(monkeypatch, sentry):
    monkeypatch.delenv("ALLOW_YOUTUBE_INPUT", raising=False)
    for _ in range(3):
        seen = _drive(monkeypatch, kind="youtube")
        with pytest.raises(YoutubeInputDisabledError):
            asyncio.run(pipeline._run_pipeline(JOB))
        assert [f[1] for f in seen["failed"]] == ["INTERNAL_ERROR"]
        assert seen["downloads"] == 0, "nothing is fetched with the flag off"
    assert len(sentry) == 1, "a standing env split is one event per process, not one per job"
    assert sentry[0]["tags"]["failure_reason"] == "youtube_input_disabled"


def test_kill_switch_through_the_pipeline_is_our_fault_reported_once(monkeypatch, sentry):
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    for _ in range(2):
        seen = _drive(monkeypatch, kind="youtube", download=FetchPausedError("kill switch"))
        with pytest.raises(FetchPausedError):
            asyncio.run(pipeline._run_pipeline(JOB))
        assert [f[1] for f in seen["failed"]] == ["INTERNAL_ERROR"]
        assert "Upload the audio file" in seen["failed"][0][2]
    assert [s["tags"]["failure_reason"] for s in sentry] == ["fetch_paused"]


def test_a_failed_capture_does_not_use_up_the_once_per_process_report(monkeypatch, sentry):
    # #490: the once-per-process flag was set BEFORE the capture call, so a capture that raised
    # (Sentry transport error) silenced the standing state for the life of the process.
    monkeypatch.delenv("ALLOW_YOUTUBE_INPUT", raising=False)
    calls: list = []

    def capture(exc=None, **k):
        calls.append(k["tags"]["failure_reason"])
        if len(calls) == 1:
            raise RuntimeError("sentry transport down")

    monkeypatch.setattr(pipeline.sentry_sdk, "capture_exception", capture)
    for _ in range(3):
        seen = _drive(monkeypatch, kind="youtube")
        with pytest.raises(YoutubeInputDisabledError):
            asyncio.run(pipeline._run_pipeline(JOB))
        assert [f[1] for f in seen["failed"]] == ["INTERNAL_ERROR"]
    assert calls == ["youtube_input_disabled"] * 2, "retried once after the failed capture"


def test_blocklist_unavailable_through_the_pipeline_is_reported_every_time(monkeypatch, sentry):
    # A DB blip is a per-job event, not a standing state: each one is reported.
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    for _ in range(2):
        seen = _drive(monkeypatch, kind="youtube", download=BlocklistUnavailableError("db"))
        with pytest.raises(BlocklistUnavailableError):
            asyncio.run(pipeline._run_pipeline(JOB))
        assert [f[1] for f in seen["failed"]] == ["INTERNAL_ERROR"]
    assert [s["tags"]["failure_reason"] for s in sentry] == ["blocklist_read_failed"] * 2


def test_a_real_youtube_block_stays_user_fault_and_unreported(monkeypatch, sentry):
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    seen = _drive(monkeypatch, kind="youtube", download=DownloadBlockedError("bot wall"))
    with pytest.raises(DownloadBlockedError):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert [f[1] for f in seen["failed"]] == ["DOWNLOAD_BLOCKED"]
    assert sentry == []
