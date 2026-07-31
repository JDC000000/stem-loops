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
import resource
import shutil
import subprocess
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import librosa
import psycopg
import sentry_sdk
from psycopg.types.json import Json

from .classifier.energy_classifier import classify_energy
from .classifier.section_labeler import label_sections
from .downloader import download_audio
from .dsp.seamless import apply as seamless_apply
from .encoder.wav_encoder import encode_24bit, waveform_peaks
from .errors import (
    DownloadBlockedError,
    InternalError,
    JobSupersededError,
    SeparationFailedError,
    StemLoopsError,
    UploadInvalidError,
)
from .extractor.loop_extractor import extract_loops
from .job_state import Heartbeat, fail_stage_for
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
            "original_filename, attempts FROM jobs WHERE id=%s",
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


# Tempo/beat reference: drums give the cleanest onsets, so beat tracking is most
# reliable there (verified in the C2 repro: BPM was stable to 0.01 on drums alone).
TEMPO_STEM_PREFERENCE = ("drums", "bass", "other")
# Key reference (hardening review C2): deliberately drums-LAST — i.e. never. An
# isolated drum stem has no key at all, but Krumhansl-Schmuckler correlation always
# returns *some* key, which is how a random key ended up on nearly every job. Order
# runs most-harmonic → least; if none of these stems is present the job's key is
# reported as unknown (null) instead of invented.
KEY_STEM_PREFERENCE = ("other", "keys", "guitar", "vocals", "bass")
# Filename slug for a job whose key could not be determined with confidence.
UNKNOWN_KEY_SLUG = "unknown"


# ----------------------------- audio core (sync) -----------------------------
def extract_and_tag(job_id, stem_paths, requested_stems, bars, sr=44100, hb=None):
    """Load ref stem, detect bpm/key, extract loops, classify energy + label sections.

    `hb` is the stage Heartbeat (H1): extraction is CPU-bound and silent for its
    whole duration, which used to let the reaper mistake a healthy job for a dead
    one. Beats are throttled, so calling per checkpoint costs nothing.
    """
    hb = hb or Heartbeat(job_id)
    sp = {k: v for k, v in stem_paths.items() if k in (requested_stems or stem_paths)}
    if not sp:
        sp = stem_paths
    # Beat/boundary reference: prefer drums (clearest beat), else bass/other, else first.
    # Reorder so the reference is first — extract_loops also keys off the first stem.
    ref_stem = next((s for s in TEMPO_STEM_PREFERENCE if s in sp), next(iter(sp)))
    sp = {ref_stem: sp[ref_stem], **{k: v for k, v in sp.items() if k != ref_stem}}
    y_ref, _ = librosa.load(sp[ref_stem], sr=sr, mono=True)
    # Key reference is a SEPARATE, harmonically-rich stem (C2): drums make a great
    # tempo reference and a meaningless key reference. With no harmonic stem in the
    # job (e.g. drums-only), the key is genuinely unknown and is reported as null.
    key_stem = next((s for s in KEY_STEM_PREFERENCE if s in sp), None)
    if key_stem is None:
        y_key = None
    elif key_stem == ref_stem:
        y_key = y_ref
    else:
        y_key, _ = librosa.load(sp[key_stem], sr=sr, mono=True)
    hb.beat()
    tags = detect_bpm_and_key(y_ref, sr, y_key=y_key)
    log_structured("INFO", "job_tags_detected", job_id=job_id, tempo_stem=ref_stem,
                   key_stem=key_stem, bpm=tags["bpm"], musical_key=tags["musical_key"])

    loops = []
    for loop in extract_loops(sp, tags["bpm"], sr=sr, loop_length_bars=bars):
        loops.append(loop)
        hb.beat()  # one checkpoint per extracted loop; throttled internally
    # Persist tags only once extraction has actually succeeded (H9). Writing them
    # first meant a beatless/silent reference stem left bpm=0.0 and a fabricated key
    # on a job that then failed, with nothing ever clearing them.
    _update_job_tags(job_id, tags)
    segs = sorted({(loop["start_sec"], loop["end_sec"]) for loop in loops})
    energies = classify_energy(y_ref, sr, segs)
    sections = label_sections(segs, energies)
    seg_label = dict(zip(segs, sections))
    seg_energy = dict(zip(segs, energies))
    return loops, tags, seg_label, seg_energy


def encode_and_upload(
    job_id, loops, tags, seg_label, seg_energy, bars, sr=44100, title=None, hb=None
) -> int:
    """Per loop: seamless seam → 24-bit encode → R2 upload → loops row. Returns count."""
    hb = hb or Heartbeat(job_id)
    bar = 4 * 60.0 / tags["bpm"]
    duration_ms = int(bars * bar * 1000)
    # Loops inherit the job-level BPM/key (computed once from the reference stem).
    # Re-detecting per loop is both slow and musically wrong — an isolated drum
    # loop has no key, and every loop from one song shares its key/tempo.
    bpm = tags["bpm"]
    key = tags["musical_key"]  # None when no key passed the confidence floor (C2)
    key_slug = key.replace(" ", "_") if key else UNKNOWN_KEY_SLUG
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
        # Liveness for the upload stage (H1) — the previous code went silent from
        # "uploading" until the whole stage finished.
        hb.beat()
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
# Fencing (H1): `attempt` is the jobs.attempts value this worker started with. The
# reaper increments it when it re-queues a job, so scoping state writes to that
# value makes a superseded worker's writes affect 0 rows instead of overwriting
# whatever the worker that took the job over has since written. `attempt=None`
# means unfenced — used only by callers that own the job unconditionally (tests,
# the CLI's one-shot path).
async def emit_event(
    job_id: str,
    stage: str,
    phase: str,
    pct: int | None = None,
    detail: dict | None = None,
    attempt: int | None = None,
) -> bool:
    """Append a stage-trace row. Returns False if fenced out (write skipped)."""
    args = [job_id, stage, phase, pct, Json(detail) if detail is not None else None]
    if attempt is None:
        sql = "INSERT INTO job_events(job_id, stage, phase, pct, detail) VALUES(%s,%s,%s,%s,%s)"
    else:
        # Conditional insert: only if we still own the job.
        sql = (
            "INSERT INTO job_events(job_id, stage, phase, pct, detail) "
            "SELECT %s,%s,%s,%s,%s FROM jobs WHERE id=%s AND attempts=%s"
        )
        args += [job_id, attempt]
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        cur = await conn.execute(sql, args)
        await conn.commit()
        return cur.rowcount > 0


async def set_status(job_id: str, status: str, attempt: int | None = None) -> bool:
    """Move the job to `status`. Returns False if fenced out (write skipped)."""
    sql = "UPDATE jobs SET status=%s, updated_at=now() WHERE id=%s"
    args = [status, job_id]
    if attempt is not None:
        # Never resurrect a terminal state either: the reaper can fail a job
        # outright (attempts exhausted) without moving `attempts`.
        sql += " AND attempts=%s AND status NOT IN ('done','failed')"
        args.append(attempt)
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        cur = await conn.execute(sql, args)
        await conn.commit()
        return cur.rowcount > 0


async def _set_status_or_abort(job_id: str, status: str, attempt: int | None) -> None:
    """Status transitions are the pipeline's checkpoints: if one is fenced out this
    worker has been superseded, so stop rather than keep spending Replicate/R2/CPU
    on a job someone else now owns."""
    if not await set_status(job_id, status, attempt):
        raise JobSupersededError(f"job {job_id} superseded before status={status}")


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


async def _run_stub(
    job_id: str, requested_stems, bars: int, run_attempt: int | None = None
) -> None:
    """Walk the §6.3 state machine emitting events, then write fake loops + done."""
    for stage, p0, p1 in (("downloading", 0, 100), ("separating", 15, 100),
                          ("extracting", 70, 100), ("uploading", 90, 100)):
        await _set_status_or_abort(job_id, stage, run_attempt)
        await emit_event(job_id, stage, "started", pct=p0, attempt=run_attempt)
        await emit_event(job_id, stage, "completed", pct=p1, attempt=run_attempt)
    await asyncio.to_thread(_insert_stub_loops, job_id, requested_stems, bars)
    await _set_status_or_abort(job_id, "done", run_attempt)


async def run_pipeline(job_id: str) -> None:
    """Real pipeline. download_audio + Replicate are gated (S1 bake-off / P2-12+);
    the audio core runs against the produced stems. Typed errors set status=failed."""
    run_attempt = None  # bound before the try so the failure paths can always fence
    try:
        row = await asyncio.to_thread(_fetch_job, job_id)
        url, requested_stems, bars, input_kind, upload_r2_key, original_filename, run_attempt = row
        # Fencing token (H1): every state write below is scoped to this attempts value,
        # so if the reaper re-queues the job underneath us those writes become no-ops.
        hb = Heartbeat(job_id, run_attempt)
        log_structured("INFO", "pipeline_start", job_id=job_id, input_kind=input_kind,
                       attempt=run_attempt)

        # T10 STUB short-circuit: full UI→queue→worker→DB loop with fake loops and
        # no YouTube/Replicate. The real pipeline below is unchanged and stays gated
        # on the S1 bake-off (T12).
        if os.environ.get("STUB_MODE", "").lower() == "true":
            await _run_stub(job_id, requested_stems, bars, run_attempt)
            log_structured("INFO", "pipeline_done", job_id=job_id, stub=True)
            return

        await _set_status_or_abort(job_id, "downloading", run_attempt)
        await emit_event(job_id, "downloading", "started", pct=0, attempt=run_attempt)
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
            dl_result, _source = await asyncio.to_thread(download_audio, url)
            # R2 fix (found in staging E2E test — T12 was never actually run before):
            # Cobalt's success path returns an already-public stream URL (Replicate can
            # fetch it directly), but yt-dlp's success path returns a LOCAL file path
            # (same shape as override_file/upload) — Replicate's API 422'd on it because
            # it can't read a local path (r2_uploader.upload_input's own docstring: "it
            # cannot read a local path"). Stage local results to R2 exactly like the
            # override_file/upload paths already do; leave an already-a-URL result alone.
            if _source == "ytdlp":
                audio_src = await asyncio.to_thread(upload_input, job_id, dl_result)
            else:
                audio_src = dl_result
        await emit_event(job_id, "downloading", "completed", pct=100, attempt=run_attempt)

        await _set_status_or_abort(job_id, "separating", run_attempt)
        await emit_event(job_id, "separating", "started", pct=15, attempt=run_attempt)
        pred_id = await asyncio.to_thread(submit_or_reattach, job_id, audio_src)
        # Retry-on-deadline (QA P1): a slow-but-fine separation must not permanently fail.
        # On a poll timeout the prediction is still running server-side, so re-poll the
        # SAME prediction (re-attach — no new prediction, no double charge) up to N times
        # before giving up terminally. Distinct from the reaper (restart-orphan recovery).
        for poll_attempt in range(1, SEPARATION_MAX_ATTEMPTS + 1):
            try:
                stem_urls, sep_cost = await asyncio.to_thread(poll_until_done, job_id, pred_id)
                break
            except SeparationTimeout as exc:
                if poll_attempt >= SEPARATION_MAX_ATTEMPTS:
                    raise SeparationFailedError(
                        f"separation exceeded its time budget after {poll_attempt} attempts"
                    ) from exc
                log_structured("WARN", "separation_timeout_retry", job_id=job_id,
                               attempt=poll_attempt, pred_id=pred_id)
        stem_paths = await asyncio.to_thread(_fetch_stems, stem_urls, requested_stems)
        # Persist the Replicate cost so the admission spend-ceiling (which sums
        # job_events.detail->>'cost_usd' over 24h) actually enforces (P4).
        await emit_event(job_id, "separating", "completed", pct=100,
                         detail={"cost_usd": sep_cost}, attempt=run_attempt)

        await _set_status_or_abort(job_id, "extracting", run_attempt)
        await emit_event(job_id, "extracting", "started", pct=70, attempt=run_attempt)
        loops, tags, seg_label, seg_energy = await asyncio.to_thread(
            extract_and_tag, job_id, stem_paths, requested_stems, bars, 44100, hb
        )
        await emit_event(job_id, "extracting", "completed", pct=100, attempt=run_attempt)

        await _set_status_or_abort(job_id, "uploading", run_attempt)
        await emit_event(job_id, "uploading", "started", pct=90, attempt=run_attempt)
        count = await asyncio.to_thread(
            encode_and_upload, job_id, loops, tags, seg_label, seg_energy, bars,
            title=_title_slug(original_filename, job_id), hb=hb,
        )
        await emit_event(job_id, "uploading", "completed", pct=100, attempt=run_attempt)

        await _set_status_or_abort(job_id, "done", run_attempt)
        # Peak worker RSS (kernel high-water mark) — real evidence for sizing the Option-B
        # Fly VM. On Fly each deploy is a fresh machine, so ru_maxrss here IS this job's peak
        # memory, letting us downsize 4GB→2GB on data not a guess. (ru_maxrss is KB on Linux.)
        log_structured("INFO", "pipeline_done", job_id=job_id, loops=count,
                       peak_rss_mb=round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1))

    except JobSupersededError as exc:
        # The reaper re-queued this job and another worker owns it now (H1). Our
        # writes are already fenced out; stop quietly rather than failing a job that
        # is very likely running fine elsewhere. Not a user-facing error.
        log_structured("WARN", "job_superseded", job_id=job_id, detail=str(exc)[:160])
        return
    except StemLoopsError as exc:
        # Deliberately NOT sent to Sentry: these are the designed, typed error paths
        # (DOWNLOAD_BLOCKED, DOWNLOAD_TIMEOUT, etc.) working exactly as intended —
        # reporting every one would just be noise the sentry-triage job has to filter.
        await _fail(job_id, exc.error_code, exc.user_message, run_attempt)
        raise
    except Exception as exc:  # noqa: BLE001 — surface as typed INTERNAL_ERROR
        # This IS worth reporting — an exception that fell through every typed error
        # class is by definition something nobody anticipated. No-op if SENTRY_DSN
        # isn't configured (main.py only calls sentry_sdk.init when it's set).
        sentry_sdk.capture_exception(exc)
        err = InternalError(str(exc)[:200])
        await _fail(job_id, err.error_code, err.user_message, run_attempt)
        raise


async def _fail(
    job_id: str, error_code: str, user_message: str, attempt: int | None = None
) -> None:
    """Terminal failure: set jobs.status='failed' AND append the matching 'failed'
    job_event, in ONE transaction.

    H6 — TSD §6.3 says every active stage emits `started` then `completed` OR
    `failed`, but no failure path ever wrote the `failed` row, so every failed job
    left an open `started` stage forever and anything reconstructing stage duration
    from job_events silently broke.

    Fenced on `attempt` (H1) so a superseded worker can't stamp 'failed' over the
    state of the worker that took its job over, and on the job not already being
    terminal so the first (most specific) error wins. The SELECT … FOR UPDATE both
    locks the row against a concurrent failer and tells us which stage to attribute
    the event to — the status is about to be overwritten by the same transaction.
    """
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        sql = "SELECT status FROM jobs WHERE id=%s AND status NOT IN ('done','failed')"
        args = [job_id]
        if attempt is not None:
            sql += " AND attempts=%s"
            args.append(attempt)
        row = await (await conn.execute(sql + " FOR UPDATE", args)).fetchone()
        if row is None:
            await conn.commit()
            log_structured("WARN", "fail_write_fenced_out", job_id=job_id,
                           error_code=error_code, attempt=attempt)
            return
        await conn.execute(
            "UPDATE jobs SET status='failed', error_code=%s, error_message_user=%s, "
            "updated_at=now() WHERE id=%s",
            (error_code, user_message, job_id),
        )
        await conn.execute(
            "INSERT INTO job_events(job_id, stage, phase, detail) VALUES(%s,%s,'failed',%s)",
            (job_id, fail_stage_for(row[0]), Json({"error_code": error_code})),
        )
        await conn.commit()
