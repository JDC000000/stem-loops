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
from .errors import InternalError, StemLoopsError
from .extractor.loop_extractor import extract_loops
from .logger import log_structured
from .replicate_client import poll_until_done, submit_or_reattach
from .storage.r2_uploader import upload_input, upload_loop
from .tagger.bpm_key import detect_bpm_and_key

DATABASE_URL = os.environ.get("DATABASE_URL", "")


# --- small sync DB helpers (the core is sync; run them in a thread from async) ---
def _db():
    return psycopg.connect(DATABASE_URL)


def _fetch_job(job_id: str):
    with _db() as c:
        return c.execute(
            "SELECT youtube_url, requested_stems, loop_length_bars FROM jobs WHERE id=%s",
            (job_id,),
        ).fetchone()


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


def encode_and_upload(job_id, loops, tags, seg_label, seg_energy, bars, sr=44100) -> int:
    """Per loop: seamless seam → 24-bit encode → R2 upload → loops row. Returns count."""
    bar = 4 * 60.0 / tags["bpm"]
    duration_ms = int(bars * bar * 1000)
    # Loops inherit the job-level BPM/key (computed once from the reference stem).
    # Re-detecting per loop is both slow and musically wrong — an isolated drum
    # loop has no key, and every loop from one song shares its key/tempo.
    bpm = tags["bpm"]
    key = tags["musical_key"]
    key_slug = key.replace(" ", "_")
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
        fname = f"{job_id}_{loop['stem']}_{bpm}bpm_{key_slug}_{section}_{idx:04d}.wav"
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
    with ThreadPoolExecutor(max_workers=8) as ex:
        return sum(ex.map(_one, enumerate(loops)))


def process_stems(job_id, stem_paths, requested_stems, bars, sr=44100) -> int:
    """Full audio core: extract+tag then encode+upload. Returns loops created."""
    loops, tags, seg_label, seg_energy = extract_and_tag(
        job_id, stem_paths, requested_stems, bars, sr
    )
    return encode_and_upload(job_id, loops, tags, seg_label, seg_energy, bars, sr)


# --------------------------- async orchestrator ----------------------------
async def emit_event(job_id: str, stage: str, phase: str, pct: int | None = None) -> None:
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        await conn.execute(
            "INSERT INTO job_events(job_id, stage, phase, pct) VALUES(%s,%s,%s,%s)",
            (job_id, stage, phase, pct),
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
        with open(path, "wb") as f:
            f.write(httpx.get(url, timeout=60).content)
        return name, path

    # Download stems concurrently — each is a full-length WAV.
    with ThreadPoolExecutor(max_workers=6) as ex:
        return dict(ex.map(_get, wanted))


async def run_pipeline(job_id: str) -> None:
    """Real pipeline. download_audio + Replicate are gated (S1 bake-off / P2-12+);
    the audio core runs against the produced stems. Typed errors set status=failed."""
    try:
        row = await asyncio.to_thread(_fetch_job, job_id)
        url, requested_stems, bars = row
        log_structured("INFO", "pipeline_start", job_id=job_id)

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
        else:
            audio_src, _source = await asyncio.to_thread(download_audio, url)
        await emit_event(job_id, "downloading", "completed", pct=100)

        await set_status(job_id, "separating")
        await emit_event(job_id, "separating", "started", pct=15)
        pred_id = await asyncio.to_thread(submit_or_reattach, job_id, audio_src)
        stem_urls = await asyncio.to_thread(poll_until_done, job_id, pred_id)
        stem_paths = await asyncio.to_thread(_fetch_stems, stem_urls, requested_stems)
        await emit_event(job_id, "separating", "completed", pct=100)

        await set_status(job_id, "extracting")
        await emit_event(job_id, "extracting", "started", pct=70)
        loops, tags, seg_label, seg_energy = await asyncio.to_thread(
            extract_and_tag, job_id, stem_paths, requested_stems, bars
        )
        await emit_event(job_id, "extracting", "completed", pct=100)

        await set_status(job_id, "uploading")
        await emit_event(job_id, "uploading", "started", pct=90)
        count = await asyncio.to_thread(
            encode_and_upload, job_id, loops, tags, seg_label, seg_energy, bars
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
