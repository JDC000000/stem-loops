"""Worker pipeline (T11-T18): download → separate → extract → tag → align →
label → encode → upload.

Structure:
  * The audio CORE (`extract_and_tag` + `encode_and_upload`, composed as
    `process_stems`) is pure/sync and runs against any set of local stem WAVs —
    so it is fixture-testable end-to-end (extract→upload) with no YouTube/Replicate.
  * `run_pipeline` is the async orchestrator. download_audio (Cobalt+yt-dlp, gated
    on the S1 bake-off) and Replicate separation (live in P2-12+) PRODUCE the stem
    WAVs, then hand off to the core. Heavy sync work runs in a thread so the
    co-located /health server stays responsive.

Stem-label rule (LOCKED): piano→keys mapping already happens in replicate_client;
everything here uses the contract names.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import librosa
import psycopg
from psycopg.types.json import Json

from .classifier.energy_classifier import classify_energy
from .classifier.section_labeler import label_sections
from .downloader import download_audio
from .dsp.seamless import apply as seamless_apply
from .encoder.wav_encoder import encode_24bit, waveform_peaks
from .errors import (
    DownloadBlockedError,
    InternalError,
    SeparationFailedError,
    StemLoopsError,
    UploadInvalidError,
)
from .extractor.loop_extractor import extract_loops
from .logger import log_structured
from .replicate_client import SeparationTimeout, poll_until_done, submit_or_reattach
from .storage.r2_uploader import download_object, upload_input, upload_loop
from .tagger.bpm_key import detect_bpm_and_key

DATABASE_URL = os.environ.get("DATABASE_URL", "")
# Retry-on-deadline attempts for a slow-but-fine separation (QA P1). Each attempt
# re-polls the SAME still-running prediction (re-attach), so this extends the effective
# wait to N x HARD_DEADLINE without a second prediction/charge.
SEPARATION_MAX_ATTEMPTS = int(os.environ.get("SEPARATION_MAX_ATTEMPTS", "3"))


# --- small sync DB helpers (the core is sync; run them in a thread from async) ---
def _db():
    return psycopg.connect(DATABASE_URL)


def _fetch_job(job_id: str):
    with _db() as c:
        return c.execute(
            "SELECT youtube_url, requested_stems, loop_length_bars, input_kind, upload_r2_key, "
            "original_filename FROM jobs WHERE id=%s",
            (job_id,),
        ).fetchone()


def _title_slug(original_filename: str | None, job_id: str) -> str:
    """Filesystem-safe title for loop filenames (QA §4.4: use the song title like the
    ZIP does, not the job UUID). Strips the extension and non-alphanumerics; falls back
    to the job id when there's no title (e.g. the deferred YouTube path)."""
    if not original_filename:
        return job_id
    base = os.path.splitext(original_filename)[0]
    slug = "".join(c if (c.isascii() and c.isalnum()) else "_" for c in base).strip("_")
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug[:80] or job_id


def _ffmpeg_bin() -> str:
    """System ffmpeg (present in the worker image) with an imageio-ffmpeg fallback."""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # noqa: BLE001
        raise InternalError(f"ffmpeg unavailable: {exc}") from exc


def _prepare_upload_source(job_id: str, upload_r2_key: str) -> str:
    """Upload-input path: pull the uploaded file from R2, ffmpeg-normalize ANY
    audio/video container to a 44.1k stereo WAV, re-stage it, and return a
    presigned URL for Replicate. Uniform decoding means every accepted format
    (mp3/m4a/flac/ogg/mp4/mov/…) reaches separation identically."""
    tmpdir = tempfile.mkdtemp(prefix="sl_upload_")
    raw = os.path.join(tmpdir, "raw_input")
    wav = os.path.join(tmpdir, "input.wav")
    download_object(upload_r2_key, raw)
    proc = subprocess.run(
        [_ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y",
         "-i", raw, "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", wav],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not os.path.exists(wav) or os.path.getsize(wav) == 0:
        # A file that ffmpeg can't decode is a bad/unsupported upload, not our fault.
        raise UploadInvalidError(f"ffmpeg decode failed: {proc.stderr[:200]}")
    return upload_input(job_id, wav)


def _update_job_tags(job_id: str, tags: dict) -> None:
    with _db() as c:
        c.execute(
            "UPDATE jobs SET bpm=%s, musical_key=%s WHERE id=%s",
            (tags["bpm"], tags["musical_key"], job_id),
        )
        c.commit()


def _insert_loop(row: tuple) -> None:
    with _db() as c:
        c.execute(
            """
            INSERT INTO loops(id, job_id, stem, section_label, energy_class, start_sec, end_sec,
                start_bar, bar_count, bpm, musical_key, r2_key, filename, duration_ms, waveform_peaks)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT(job_id, r2_key) DO NOTHING
            """,
            row,
        )
        c.commit()


# ----------------------------- audio core (sync) -----------------------------
def extract_and_tag(job_id, stem_paths, requested_stems, bars, sr=44100):
    """Load ref stem, detect bpm/key, extract loops, classify energy + label sections."""
    sp = {k: v for k, v in stem_paths.items() if k in (requested_stems or stem_paths)}
    if not sp:
        sp = stem_paths
    # Beat/boundary reference: prefer drums (clearest beat), else bass/other, else first.
    # Reorder so the reference is first — extract_loops also keys off the first stem.
    ref_stem = next((s for s in ("drums", "bass", "other") if s in sp), next(iter(sp)))
    sp = {ref_stem: sp[ref_stem], **{k: v for k, v in sp.items() if k != ref_stem}}
    y_ref, _ = librosa.load(sp[ref_stem], sr=sr, mono=True)
    tags = detect_bpm_and_key(y_ref, sr)
    _update_job_tags(job_id, tags)

    loops = list(extract_loops(sp, tags["bpm"], sr=sr, loop_length_bars=bars))
    segs = sorted({(loop["start_sec"], loop["end_sec"]) for loop in loops})
    energies = classify_energy(y_ref, sr, segs)
    sections = label_sections(segs, energies)
    seg_label = dict(zip(segs, sections))
    seg_energy = dict(zip(segs, energies))
    return loops, tags, seg_label, seg_energy


def encode_and_upload(job_id, loops, tags, seg_label, seg_energy, bars, sr=44100, title=None) -> int:
    """Per loop: seamless seam → 24-bit encode → R2 upload → loops row. Returns count."""
    bar = 4 * 60.0 / tags["bpm"]
    duration_ms = int(bars * bar * 1000)
    # Loops inherit the job-level BPM/key (computed once from the reference stem).
    # Re-detecting per loop is both slow and musically wrong — an isolated drum
    # loop has no key, and every loop from one song shares its key/tempo.
    bpm = tags["bpm"]
    key = tags["musical_key"]
    key_slug = key.replace(" ", "_")
    # Song-title prefix (QA §4.4) so a downloaded/zipped loop reads like its track, not a
    # UUID. Falls back to the job id (e.g. the fixture path / YouTube) when there's no title.
    name_base = title or job_id
    tmpdir = tempfile.mkdtemp(prefix="sl_loops_")

    def _one(item) -> int:
        # Runs in a worker thread: seamless → 24-bit encode → R2 upload → DB row.
        # Each call uses its own DB connection; the R2 client is a shared singleton.
        idx, loop = item
        loop_id = str(uuid.uuid4())
        audio = seamless_apply(loop["audio"], sr)
        out_path = os.path.join(tmpdir, f"{loop_id}.wav")
        encode_24bit(audio, sr, out_path)
        peaks = waveform_peaks(audio)
        seg = (loop["start_sec"], loop["end_sec"])
        section = seg_label.get(seg, "verse")
        energy = seg_energy.get(seg, "mid")
        r2_key = upload_loop(job_id, loop["stem"], section, idx, out_path)
        fname = f"{name_base}_{loop['stem']}_{bpm}bpm_{key_slug}_{section}_{idx:04d}.wav"
        _insert_loop(
            (
                loop_id,
                job_id,
                loop["stem"],
                section,
                energy,
                loop["start_sec"],
                loop["end_sec"],
                int(loop["start_sec"] / bar),
                bars,
                bpm,
                key,
                r2_key,
                fname,
                duration_ms,
                Json(peaks),
            )
        )
        return 1

    # Parallelize the network-bound upload work — the dominant cost at scale.
    # Configurable so a small (2-core) Fly VM can cap concurrency: 8 CPU-bound encode
    # threads there give no throughput gain (GIL) and multiply peak memory (a live
    # encode buffer per thread), which contributed to OOM on full-length tracks.
    # Default 8 keeps Option A's behaviour unchanged.
    workers = int(os.environ.get("LOOP_ENCODE_WORKERS", "8"))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return sum(ex.map(_one, enumerate(loops)))


def process_stems(job_id, stem_paths, requested_stems, bars, sr=44100) -> int:
    """Full audio core: extract+tag then encode+upload. Returns loops created."""
    loops, tags, seg_label, seg_energy = extract_and_tag(
        job_id, stem_paths, requested_stems, bars, sr
    )
    return encode_and_upload(job_id, loops, tags, seg_label, seg_energy, bars, sr)


# --------------------------- async orchestrator ----------------------------
async def emit_event(
    job_id: str, stage: str, phase: str, pct: int | None = None, detail: dict | None = None
) -> None:
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        await conn.execute(
            "INSERT INTO job_events(job_id, stage, phase, pct, detail) VALUES(%s,%s,%s,%s,%s)",
            (job_id, stage, phase, pct, Json(detail) if detail is not None else None),
        )
        await conn.commit()


async def set_status(job_id: str, status: str) -> None:
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        await conn.execute(
            "UPDATE jobs SET status=%s, updated_at=now() WHERE id=%s", (status, job_id)
        )
        await conn.commit()


def _fetch_stems(stem_urls: dict, requested_stems) -> dict:
    tmpdir = tempfile.mkdtemp(prefix="sl_stems_")
    wanted = [
        (name, url)
        for name, url in stem_urls.items()
        if not requested_stems or name in requested_stems
    ]

    def _get(item):
        name, url = item
        path = os.path.join(tmpdir, f"{name}.wav")
        # Stream to disk with retries. Replicate's CDN can drop a large stem body
        # mid-download (httpx RemoteProtocolError). Real songs → 40-60MB stems, so
        # chunk-stream + retry instead of buffering .content in one shot.
        last_exc = None
        for attempt in range(4):
            try:
                with httpx.stream("GET", url, timeout=180, follow_redirects=True) as r:
                    r.raise_for_status()
                    with open(path, "wb") as f:
                        for chunk in r.iter_bytes(1 << 20):
                            f.write(chunk)
                return name, path
            except Exception as exc:  # noqa: BLE001 — retry transient CDN drops
                last_exc = exc
                log_structured("WARN", "stem_fetch_retry", stem=name, attempt=attempt,
                               error=str(exc)[:160])
        raise InternalError(f"stem download failed after retries: {last_exc}")

    # Download stems concurrently — each is a full-length WAV.
    with ThreadPoolExecutor(max_workers=6) as ex:
        return dict(ex.map(_get, wanted))


# ------------------------------ T10 stub path -------------------------------
def _stub_placeholder_wav() -> str | None:
    """A tiny silent 24-bit WAV so stub-mode loop downloads RESOLVE (make dev /
    Gate 1 stays fully offline — no Replicate). Returns a temp path, or None if
    audio libs are unavailable."""
    try:
        import numpy as np
        import soundfile as sf

        sr = 44100
        path = os.path.join(tempfile.mkdtemp(prefix="stub_ph_"), "silent.wav")
        sf.write(path, np.zeros(sr, dtype="float32"), sr, subtype="PCM_24")  # 1s mono
        return path
    except Exception as exc:  # noqa: BLE001
        log_structured("WARN", "stub_placeholder_failed", error=str(exc)[:120])
        return None


def _insert_stub_loops(job_id: str, requested_stems, bars: int) -> int:
    """Phase-1 STUB: write fake loops to the DB AND upload a tiny silent 24-bit WAV
    to each loop's r2_key (via upload_loop → same key scheme + audio/wav content-type
    as production), so the full offline loop (upload → stub → DOWNLOAD) actually
    returns real bytes without Replicate. The signed GET must not 404."""
    bpm, key = 120.0, "C major"
    stems = list(requested_stems) if requested_stems else ["drums", "bass", "vocals", "other"]
    sections = ["intro", "verse", "chorus", "bridge", "outro"]
    bar_sec = 4 * 60.0 / bpm
    placeholder = _stub_placeholder_wav()  # tiny silent 24-bit WAV, uploaded per loop
    n = 0
    with _db() as c:
        c.execute("UPDATE jobs SET bpm=%s, musical_key=%s WHERE id=%s", (bpm, key, job_id))
        for stem in stems:
            for i in range(5):  # >=5 loops/stem (PRD §4.3) even in stub
                start = i * bars * bar_sec
                end = start + bars * bar_sec
                section = sections[i % len(sections)]
                # Default to upload_loop's key scheme even if the upload is skipped.
                r2_key = f"{job_id}/{stem}/{section}_{i:04d}.wav"
                if placeholder:
                    try:
                        r2_key = upload_loop(job_id, stem, section, i, placeholder)
                    except Exception as exc:  # noqa: BLE001 — no R2 (pure-DB test): skip, don't crash
                        log_structured("WARN", "stub_upload_skipped", error=str(exc)[:120])
                        placeholder = None  # stop retrying for the rest of the loops
                c.execute(
                    """
                    INSERT INTO loops(id, job_id, stem, section_label, energy_class, start_sec,
                        end_sec, start_bar, bar_count, bpm, musical_key, r2_key, filename,
                        duration_ms, waveform_peaks)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT(job_id, r2_key) DO NOTHING
                    """,
                    (str(uuid.uuid4()), job_id, stem, section, "mid",
                     start, end, int(start / bar_sec), bars, bpm, key, r2_key,
                     f"{job_id}_{stem}_{i:04d}.wav", int(bars * bar_sec * 1000),
                     Json([0.1, 0.5, 0.3, 0.6, 0.2])),
                )
                n += 1
        c.commit()
    return n


async def _run_stub(job_id: str, requested_stems, bars: int) -> None:
    """Walk the §6.3 state machine emitting events, then write fake loops + done."""
    for stage, p0, p1 in (("downloading", 0, 100), ("separating", 15, 100),
                          ("extracting", 70, 100), ("uploading", 90, 100)):
        await set_status(job_id, stage)
        await emit_event(job_id, stage, "started", pct=p0)
        await emit_event(job_id, stage, "completed", pct=p1)
    await asyncio.to_thread(_insert_stub_loops, job_id, requested_stems, bars)
    await set_status(job_id, "done")


async def run_pipeline(job_id: str) -> None:
    """Real pipeline. download_audio + Replicate are gated (S1 bake-off / P2-12+);
    the audio core runs against the produced stems. Typed errors set status=failed."""
    try:
        row = await asyncio.to_thread(_fetch_job, job_id)
        url, requested_stems, bars, input_kind, upload_r2_key, original_filename = row
        log_structured("INFO", "pipeline_start", job_id=job_id, input_kind=input_kind)

        # T10 STUB short-circuit: full UI→queue→worker→DB loop with fake loops and
        # no YouTube/Replicate. The real pipeline below is unchanged and stays gated
        # on the S1 bake-off (T12).
        if os.environ.get("STUB_MODE", "").lower() == "true":
            await _run_stub(job_id, requested_stems, bars)
            log_structured("INFO", "pipeline_done", job_id=job_id, stub=True)
            return

        await set_status(job_id, "downloading")
        await emit_event(job_id, "downloading", "started", pct=0)
        override_url = os.environ.get("STEMLOOPS_AUDIO_URL")
        override_file = os.environ.get("STEMLOOPS_AUDIO_FILE")
        if override_url:
            # Gate 2 / testing escape hatch: a pre-downloaded PUBLIC WAV URL fed
            # straight to Replicate (which fetches the audio itself), skipping Cobalt.
            audio_src, _source = override_url, "override_url"
            log_structured("INFO", "audio_source_override_url", job_id=job_id)
        elif override_file:
            # Option A: a local WAV (e.g. operator upload). Stage it to R2 and hand
            # Replicate a presigned URL — Replicate can't read a local path.
            audio_src = await asyncio.to_thread(upload_input, job_id, override_file)
            _source = "override_file"
            log_structured("INFO", "audio_source_override_file", job_id=job_id)
        elif input_kind == "upload":
            # V2 PRIMARY input: user-uploaded file already in R2. Normalize it to WAV
            # and hand Replicate a presigned URL. No YouTube dependency.
            audio_src = await asyncio.to_thread(_prepare_upload_source, job_id, upload_r2_key)
            _source = "upload"
            log_structured("INFO", "audio_source_upload", job_id=job_id)
        else:
            # YouTube-link path (T12/C4) — DEFERRED post-launch (off-datacenter egress).
            # SECURITY / A1 (review #7): stay fully inert unless explicitly enabled, so a
            # youtube job that slips past the API gate can't trigger the real Cobalt/yt-dlp
            # path (STUB_MODE is not set in prod env). Defense-in-depth behind route.ts.
            if os.environ.get("ALLOW_YOUTUBE_INPUT", "").lower() != "true":
                raise DownloadBlockedError("YouTube ingestion is disabled pre-launch")
            audio_src, _source = await asyncio.to_thread(download_audio, url)
        await emit_event(job_id, "downloading", "completed", pct=100)

        await set_status(job_id, "separating")
        await emit_event(job_id, "separating", "started", pct=15)
        pred_id = await asyncio.to_thread(submit_or_reattach, job_id, audio_src)
        # Retry-on-deadline (QA P1): a slow-but-fine separation must not permanently fail.
        # On a poll timeout the prediction is still running server-side, so re-poll the
        # SAME prediction (re-attach — no new prediction, no double charge) up to N times
        # before giving up terminally. Distinct from the reaper (restart-orphan recovery).
        for attempt in range(1, SEPARATION_MAX_ATTEMPTS + 1):
            try:
                stem_urls, sep_cost = await asyncio.to_thread(poll_until_done, job_id, pred_id)
                break
            except SeparationTimeout as exc:
                if attempt >= SEPARATION_MAX_ATTEMPTS:
                    raise SeparationFailedError(
                        f"separation exceeded its time budget after {attempt} attempts"
                    ) from exc
                log_structured("WARN", "separation_timeout_retry", job_id=job_id,
                               attempt=attempt, pred_id=pred_id)
        stem_paths = await asyncio.to_thread(_fetch_stems, stem_urls, requested_stems)
        # Persist the Replicate cost so the admission spend-ceiling (which sums
        # job_events.detail->>'cost_usd' over 24h) actually enforces (P4).
        await emit_event(job_id, "separating", "completed", pct=100, detail={"cost_usd": sep_cost})

        await set_status(job_id, "extracting")
        await emit_event(job_id, "extracting", "started", pct=70)
        loops, tags, seg_label, seg_energy = await asyncio.to_thread(
            extract_and_tag, job_id, stem_paths, requested_stems, bars
        )
        await emit_event(job_id, "extracting", "completed", pct=100)

        await set_status(job_id, "uploading")
        await emit_event(job_id, "uploading", "started", pct=90)
        count = await asyncio.to_thread(
            encode_and_upload, job_id, loops, tags, seg_label, seg_energy, bars,
            title=_title_slug(original_filename, job_id),
        )
        await emit_event(job_id, "uploading", "completed", pct=100)

        await set_status(job_id, "done")
        log_structured("INFO", "pipeline_done", job_id=job_id, loops=count)

    except StemLoopsError as exc:
        await _fail(job_id, exc.error_code, exc.user_message)
        raise
    except Exception as exc:  # noqa: BLE001 — surface as typed INTERNAL_ERROR
        err = InternalError(str(exc)[:200])
        await _fail(job_id, err.error_code, err.user_message)
        raise


async def _fail(job_id: str, error_code: str, user_message: str) -> None:
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        await conn.execute(
            "UPDATE jobs SET status='failed', error_code=%s, error_message_user=%s, updated_at=now() WHERE id=%s",
            (error_code, user_message, job_id),
        )
        await conn.commit()
