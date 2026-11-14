"""The link job's money path, driven end to end: real ``_run_pipeline``, real ``download_audio``.

WHY THIS IS A SEPARATE FILE. ``test_link_duration_cap.py`` proves each gate in isolation, and
two of its pipeline tests replace ``download_audio`` wholesale. A reviewer who instead ran the
REAL chain found two routes to the first billed call that every isolated test had missed:
unknown metadata plus an unmeasurable staged file (E), and unknown metadata plus yt-dlp
exhausted plus Cobalt released (F). Only a test that drives the whole chain can see a gap
BETWEEN gates, so this file does, and asserts the ORDER of every costly step.

What is real: ``_run_pipeline``, ``download_audio``, ``fetch_gates`` (blocklist and the
kill-switch table, in Postgres), ``_fetch_job`` / ``set_status`` / ``emit_event`` / ``_fail``
(a seeded ``jobs`` row), ``_trim_link_source`` (real ffmpeg) and ``_probe_duration_sec`` on a real WAV
written frame-by-frame with the stdlib. What is stubbed is the network only: the yt-dlp
metadata probe and byte fetch, Cobalt, the R2 upload and the Replicate submit.

Every step logs its own name into ONE list, so a failure prints the call sequence in the
reviewer's format, e.g. ``probe, ytdlp_fetch, R2_STAGE, REPLICATE_SUBMIT(url)``.

A mutant that made a stage hang would otherwise be a false green with extra steps: the run is
wrapped in a wall-clock timeout and the database connections carry statement/lock timeouts,
and either converts to a NAMED ``pytest.fail``.
"""

from __future__ import annotations

import asyncio
import os
import struct
import uuid
import wave
from pathlib import Path

import psycopg
import pytest

from worker import downloader, pipeline
from worker.errors import (
    DownloadBlockedError,
    DownloadTimeoutError,
    LinkUnmeasurableError,
    SeparationFailedError,
)

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
WALL_CLOCK_S = 60
_PG_TIMEOUTS = "-c statement_timeout=10000 -c lock_timeout=5000"


def _silent_wav(path: Path, secs: int) -> str:
    """A real, readable WAV of exactly ``secs`` seconds (1 kHz mono: small, instant to write)."""
    sr = 1000
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack("<h", 0) * (sr * secs))
    return str(path)


@pytest.fixture
def rig(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """A seeded link job plus every network edge replaced by a recorder."""
    assert DB is not None
    sep = "&" if "?" in DB else "?"
    url_with_timeouts = f"{DB}{sep}options={_PG_TIMEOUTS.replace(' ', '%20').replace('=', '%3D')}"
    job_id = str(uuid.uuid4())
    with psycopg.connect(url_with_timeouts) as c:
        c.execute(
            "INSERT INTO jobs(id, youtube_url, requested_stems, loop_length_bars, status, "
            "client_ip_hash, client_fingerprint, input_kind) "
            "VALUES(%s,%s,%s,4,'queued','t','t','youtube')",
            (job_id, URL, ["drums"]),
        )
        c.commit()

    monkeypatch.setenv("DATABASE_URL", url_with_timeouts)
    monkeypatch.setattr(pipeline, "DATABASE_URL", url_with_timeouts)
    monkeypatch.setattr(
        downloader.fetch_gates, "_connect", lambda: psycopg.connect(url_with_timeouts)
    )
    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.delenv("STEMLOOPS_AUDIO_URL", raising=False)
    monkeypatch.delenv("STEMLOOPS_AUDIO_FILE", raising=False)
    monkeypatch.delenv("MAX_UPLOAD_DURATION_SEC", raising=False)  # the shipped default, 300 s
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    monkeypatch.setattr(downloader, "YTDLP_RETRY_DELAY_S", 0.0)
    monkeypatch.setattr(downloader.fetch_gates, "ytdlp_version", lambda: "test")

    calls: list[str] = []
    state: dict = {"probe": None, "fetch": [], "cobalt": "https://tunnel.example/a.mp3"}

    def probe(_u):
        calls.append("probe")
        return state["probe"]

    def ytdlp_fetch(_u):
        calls.append("ytdlp_fetch")
        outcome = state["fetch"].pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", probe)
    monkeypatch.setattr(downloader.ytdlp_client, "fetch_audio_file", ytdlp_fetch)
    monkeypatch.setattr(
        downloader.cobalt_client,
        "fetch_audio_url",
        lambda _u: calls.append("cobalt_fetch") or state["cobalt"],
    )
    staged: list[str] = []

    def stage(_j, p):
        calls.append("R2_STAGE")
        staged.append(p)
        return "https://r2.example/in.wav"

    monkeypatch.setattr(pipeline, "upload_input", stage)

    def submit(_j, src):
        calls.append(f"REPLICATE_SUBMIT({src})")
        raise SeparationFailedError("sentinel: reached the first billed call")

    monkeypatch.setattr(pipeline, "submit_or_reattach", submit)

    def release_cobalt(on: bool) -> None:
        with psycopg.connect(url_with_timeouts) as c:
            c.execute("UPDATE kill_switches SET enabled=%s WHERE scope='fetch_cobalt'", (not on,))
            c.commit()
        downloader.fetch_gates.reset_cache()

    downloader.fetch_gates.reset_cache()

    def run() -> BaseException:
        async def go():
            await asyncio.wait_for(pipeline._run_pipeline(job_id), WALL_CLOCK_S)

        try:
            asyncio.run(go())
        except TimeoutError:
            pytest.fail(f"_run_pipeline HUNG past {WALL_CLOCK_S}s; calls so far: {calls}")
        except psycopg.errors.QueryCanceled:
            pytest.fail(f"a database statement was cancelled by its timeout; calls: {calls}")
        except BaseException as exc:  # noqa: BLE001 -- the typed failure IS the result
            return exc
        pytest.fail(f"_run_pipeline returned without raising; calls: {calls}")

    def job_row():
        with psycopg.connect(url_with_timeouts) as c:
            return c.execute(
                "SELECT status, error_code, error_message_user FROM jobs WHERE id=%s", (job_id,)
            ).fetchone()

    def download_completed_detail():
        with psycopg.connect(url_with_timeouts) as c:
            row = c.execute(
                "SELECT detail FROM job_events WHERE job_id=%s AND stage='downloading' "
                "AND phase='completed' ORDER BY created_at DESC LIMIT 1",
                (job_id,),
            ).fetchone()
            return None if row is None else row[0]

    class Rig:
        pass

    r = Rig()
    r.calls, r.state, r.run, r.job_row, r.release_cobalt = (
        calls,
        state,
        run,
        job_row,
        release_cobalt,
    )
    r.tmp = tmp_path
    r.staged = staged
    r.download_completed_detail = download_completed_detail
    yield r
    release_cobalt(False)  # restore the migration's default: Cobalt engaged (off)
    with psycopg.connect(url_with_timeouts) as c:
        c.execute("DELETE FROM jobs WHERE id=%s", (job_id,))
        c.commit()
    downloader.fetch_gates.reset_cache()


def _wav_secs(path: str) -> float:
    with wave.open(path, "rb") as w:
        return w.getnframes() / w.getframerate()


def test_case_c_unknown_metadata_and_a_612s_file_is_trimmed_to_300_before_replicate(rig):
    """C, under the 2026-11-14 requirement: a 10:12 WAV is no longer refused. What is staged
    for Replicate is the first 300 s, and the job event records the trim."""
    rig.state["probe"] = None
    rig.state["fetch"] = [_silent_wav(rig.tmp / "long.wav", 612)]
    exc = rig.run()
    assert isinstance(exc, SeparationFailedError), (type(exc), rig.calls)
    assert rig.calls == [
        "probe",
        "ytdlp_fetch",
        "R2_STAGE",
        "REPLICATE_SUBMIT(https://r2.example/in.wav)",
    ], rig.calls
    assert _wav_secs(rig.staged[0]) <= 300.0 + pipeline.TRIM_TOLERANCE_SEC
    assert rig.download_completed_detail() == {
        "trimmed": True,
        "source_sec": 612.0,
        "used_sec": 300.0,
    }


def test_case_h_long_metadata_yt_dlp_exhausted_cobalt_released_never_reaches_replicate(rig):
    """H (new with the trim): gate 0c no longer raises for a 612 s reading, so the Cobalt arm
    is now REACHABLE with a long video. Cobalt cannot be trimmed; it must be skipped."""
    rig.release_cobalt(True)
    rig.state["probe"] = 612.0
    rig.state["fetch"] = [DownloadBlockedError("b1"), DownloadBlockedError("b2")]
    exc = rig.run()
    assert isinstance(exc, DownloadBlockedError), (type(exc), rig.calls)
    assert rig.calls == ["probe", "ytdlp_fetch", "ytdlp_fetch"], rig.calls
    assert "cobalt_fetch" not in rig.calls


def test_case_e_unknown_metadata_and_an_unmeasurable_file_is_refused_not_billed(rig):
    """E: unknown metadata and a file ffmpeg cannot cut: fails closed, nothing billed."""
    junk = rig.tmp / "junk.wav"
    junk.write_bytes(b"this is not audio")
    rig.state["probe"] = None
    rig.state["fetch"] = [str(junk)]
    exc = rig.run()
    assert isinstance(exc, LinkUnmeasurableError), (type(exc), rig.calls)
    assert rig.calls == ["probe", "ytdlp_fetch"], rig.calls
    assert "R2_STAGE" not in rig.calls
    assert not any(c.startswith("REPLICATE_SUBMIT") for c in rig.calls)
    status, code, _ = rig.job_row()
    assert (status, code) == ("failed", "INTERNAL_ERROR")


def test_case_f_unknown_metadata_yt_dlp_exhausted_cobalt_released_never_reaches_replicate(rig):
    """F: this reached REPLICATE_SUBMIT before the fix (the Cobalt arm had no gate at all)."""
    rig.release_cobalt(True)
    assert downloader.fetch_gates.cobalt_allowed() is True  # the precondition is real
    rig.state["probe"] = None
    rig.state["fetch"] = [DownloadTimeoutError("t1"), DownloadTimeoutError("t2")]
    exc = rig.run()
    assert isinstance(exc, DownloadTimeoutError), (type(exc), rig.calls)
    assert rig.calls == ["probe", "ytdlp_fetch", "ytdlp_fetch"], rig.calls
    assert "cobalt_fetch" not in rig.calls
    status, code, _ = rig.job_row()
    assert (status, code) == ("failed", "DOWNLOAD_TIMEOUT")


def test_case_g_cobalt_with_a_verified_short_length_is_still_served(rig):
    """The gate must close F without killing the leg: a READ 120 s length may use Cobalt."""
    rig.release_cobalt(True)
    rig.state["probe"] = 120.0
    rig.state["fetch"] = [DownloadTimeoutError("t1"), DownloadTimeoutError("t2")]
    exc = rig.run()
    assert isinstance(exc, SeparationFailedError), (type(exc), rig.calls)
    assert rig.calls == [
        "probe",
        "ytdlp_fetch",
        "ytdlp_fetch",
        "cobalt_fetch",
        "REPLICATE_SUBMIT(https://tunnel.example/a.mp3)",
    ], rig.calls


def test_exactly_at_the_cap_is_accepted_through_the_whole_chain(rig):
    """Metadata says 300 and the file measures 300.0 at the 300 s default: nothing is cut."""
    rig.state["probe"] = 300.0
    rig.state["fetch"] = [_silent_wav(rig.tmp / "exact.wav", 300)]
    exc = rig.run()
    assert isinstance(exc, SeparationFailedError), (type(exc), rig.calls)
    assert rig.calls == [
        "probe",
        "ytdlp_fetch",
        "R2_STAGE",
        "REPLICATE_SUBMIT(https://r2.example/in.wav)",
    ], rig.calls
    assert rig.staged == [str(rig.tmp / "exact.wav")]  # staged as fetched
    assert rig.download_completed_detail() is None
