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
import contextlib
import os
import resource
import shutil
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import librosa
import psycopg
import sentry_sdk
from psycopg.types.json import Json

from . import tmpdirs
from .chord_source import ChordSubmitUncertain
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
    UploadTooLongError,
)
from .extractor.beat_grid import estimate_beat_grid
from .extractor.loop_extractor import extract_loops
from .logger import log_structured
from .replicate_client import SeparationTimeout, poll_until_done, submit_or_reattach
from .storage.r2_uploader import (
    download_object,
    upload_input,
    upload_loop,
    upload_play_chords,
    upload_stem,
)
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


# Longest upload (seconds) we will separate. ONE knob, read at call time so it can be
# tuned with an env change instead of a deploy. 600 s (10 min):
#   * Klangio chords only work <= 300 s, so a track beyond that already loses the chord
#     overlay; 600 s leaves headroom for ordinary long songs (extended mixes, prog) without
#     opening the door to DJ sets / albums.
#   * Replicate separation is billed per GPU-second ($0.0014/s, replicate_client) and the
#     predict time scales with audio length, so every extra minute is real spend and a
#     longer hold on the single paid GPU path. The web layer only caps BYTES (200 MB,
#     ~3.5 h of 128 kbps mp3), which is no bound on cost.
MAX_UPLOAD_DURATION_SEC_DEFAULT = 600.0
# Wall-clock budget for the ffmpeg normalise step. A pathological/hostile file must not
# hold the worker thread (and its heartbeat-less job) indefinitely.
FFMPEG_DECODE_TIMEOUT_SEC_DEFAULT = 120.0


def _env_positive_float(name: str, default: float) -> float:
    """Positive finite float from the environment; invalid/zero/negative -> ``default``."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if not value > 0 or value == float("inf"):
        log_structured("WARN", "env_float_invalid", name=name, using=default)
        return default
    return value


def _max_upload_duration_sec() -> float:
    return _env_positive_float("MAX_UPLOAD_DURATION_SEC", MAX_UPLOAD_DURATION_SEC_DEFAULT)


def _ffmpeg_decode_timeout_sec() -> float:
    return _env_positive_float("FFMPEG_DECODE_TIMEOUT_SEC", FFMPEG_DECODE_TIMEOUT_SEC_DEFAULT)


def _prepare_upload_source(job_id: str, upload_r2_key: str) -> str:
    """Upload-input path: pull the uploaded file from R2, ffmpeg-normalize ANY
    audio/video container to a 44.1k stereo WAV, re-stage it, and return a
    presigned URL for Replicate. Uniform decoding means every accepted format
    (mp3/m4a/flac/ogg/mp4/mov/…) reaches separation identically.

    Enforces the duration cap (``MAX_UPLOAD_DURATION_SEC``) HERE, before the returned URL
    is ever handed to Replicate: a header probe rejects an over-length file before decoding
    it, the decode itself is bounded (``-t cap+1`` so a lying/missing header cannot expand
    into a multi-GB WAV, plus a wall-clock timeout), and the decoded WAV is re-measured.
    """
    max_sec = _max_upload_duration_sec()
    tmpdir = tmpdirs.mkdtemp(prefix="sl_upload_")
    raw = os.path.join(tmpdir, "raw_input")
    wav = os.path.join(tmpdir, "input.wav")
    download_object(upload_r2_key, raw)

    def _too_long(seconds: float | None) -> UploadTooLongError:
        log_structured(
            "INFO",
            "upload_rejected_too_long",
            job_id=job_id,
            duration_sec=None if seconds is None else round(seconds, 1),
            max_sec=max_sec,
        )
        return UploadTooLongError(
            f"upload duration {seconds}s exceeds MAX_UPLOAD_DURATION_SEC={max_sec:g}",
            max_seconds=max_sec,
        )

    declared = _probe_duration_sec(raw)
    if declared is not None and declared > max_sec:
        raise _too_long(declared)

    try:
        proc = subprocess.run(
            [
                _ffmpeg_bin(),
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                raw,
                "-ac",
                "2",
                "-ar",
                "44100",
                "-c:a",
                "pcm_s16le",
                # Output cap: one second past the limit is enough to prove "too long".
                "-t",
                f"{max_sec + 1:.3f}",
                wav,
            ],
            capture_output=True,
            text=True,
            timeout=_ffmpeg_decode_timeout_sec(),
        )
    except subprocess.TimeoutExpired as exc:
        raise UploadInvalidError(
            f"ffmpeg decode exceeded {_ffmpeg_decode_timeout_sec():g}s timeout"
        ) from exc
    if proc.returncode != 0 or not os.path.exists(wav) or os.path.getsize(wav) == 0:
        # A file that ffmpeg can't decode is a bad/unsupported upload, not our fault.
        raise UploadInvalidError(f"ffmpeg decode failed: {proc.stderr[:200]}")
    decoded = _probe_duration_sec(wav)
    if decoded is not None and decoded > max_sec:
        raise _too_long(decoded)
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
    # One beat grid (fitted tempo + first-beat anchor) drives the reported BPM, the loop
    # length and where loops start, so all three agree.
    grid = estimate_beat_grid(y_ref, sr)
    tags = detect_bpm_and_key(y_ref, sr, grid=grid)
    _update_job_tags(job_id, tags)

    loops = list(extract_loops(sp, tags["bpm"], sr=sr, loop_length_bars=bars, grid=grid))
    segs = sorted({(loop["start_sec"], loop["end_sec"]) for loop in loops})
    energies = classify_energy(y_ref, sr, segs)
    sections = label_sections(segs, energies)
    seg_label = dict(zip(segs, sections, strict=False))
    seg_energy = dict(zip(segs, energies, strict=False))
    return loops, tags, seg_label, seg_energy


def encode_and_upload(
    job_id, loops, tags, seg_label, seg_energy, bars, sr=44100, title=None
) -> int:
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
    tmpdir = tmpdirs.mkdtemp(prefix="sl_loops_")

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
                loop.get("start_bar", int(loop["start_sec"] / bar)),
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


# The canonical htdemucs_6s stem set. ALL SIX are retained for the mixer,
# independently of `requested_stems`, which only governs which loops get cut.
ALL_STEMS = ("vocals", "drums", "bass", "other", "guitar", "keys")

# Opus bitrate for the playback artifact. TSD 12.2 requires Opus and 3.1 assumes
# "4-5 MB per stem": 128 kbps x 300 s = 4.8 MB, so 128k lands on that figure for a
# 5-minute track. 48 kHz because the browser AudioContext runs at 48 kHz and a
# resample on decode is wasted work on a phone.
STEM_OPUS_BITRATE = os.environ.get("STEM_OPUS_BITRATE", "128k")
STEM_OPUS_RATE = "48000"


def _encode_stem_opus(src_wav: str, out_dir: str, stem: str, job_id: str = "") -> str | None:
    """Encode one stem WAV to Opus for playback. None on any failure.

    Diagnosability is the point of the error handling here, not tidiness. The first
    version logged ``str(exc)[:200]``, which for a CalledProcessError is the COMMAND
    LINE — truncated before the exit status — and threw ffmpeg's stderr away. A
    reviewer showed that a total encode failure then looked identical to "this job
    predates V3-J2": no job id, no reason, no Sentry event. So this logs the exit
    code and the tail of ffmpeg's stderr, which is where "Unknown encoder 'libopus'"
    appears, and carries the job id.
    """
    out = os.path.join(out_dir, f"{stem}.opus")
    try:
        # _ffmpeg_bin() raises InternalError when no ffmpeg exists anywhere, and it
        # belongs INSIDE the try: outside it, that exception escaped retain_stems and
        # failed a job whose loops had already uploaded — the exact opposite of this
        # function's documented posture.
        cmd = [
            _ffmpeg_bin(),
            "-nostdin",
            "-y",
            "-i",
            src_wav,
            "-c:a",
            "libopus",
            "-b:a",
            STEM_OPUS_BITRATE,
            "-ar",
            STEM_OPUS_RATE,
            "-vn",
            out,
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=300, check=False)
        if proc.returncode != 0:
            stderr = (proc.stderr or b"").decode("utf-8", "replace").strip()
            log_structured(
                "ERROR",
                "stem_opus_encode_failed",
                job_id=job_id,
                stem=stem,
                returncode=proc.returncode,
                # the TAIL, not the head: ffmpeg's banner is at the top and the
                # actual reason is on the last line.
                stderr_tail=stderr[-500:],
            )
            return None
        if not os.path.exists(out) or os.path.getsize(out) == 0:
            log_structured(
                "ERROR", "stem_opus_encode_empty", job_id=job_id, stem=stem, returncode=0
            )
            return None
        return out
    except Exception as exc:  # noqa: BLE001 — caller degrades this stem, not the job
        log_structured(
            "ERROR",
            "stem_opus_encode_error",
            job_id=job_id,
            stem=stem,
            error_type=type(exc).__name__,
            error=str(exc)[:300],
        )
        return None


# V3-J2 — retain the full-length stems.
#
# htdemucs_6s produces six full-length stems, `extract_and_tag` cuts bar-length
# loops out of them, and `job_scope()` then rmtree's the scratch dir: the stems
# themselves were never persisted. The play-along mixer needs per-stem faders over
# the whole song, which loops cannot provide.
#
# TWO artifacts per stem, per TSD 12.2:
#   * Opus, for playback. The engine streams these; WAV at 40-60 MB/stem would be
#     240-360 MB per song into the browser, ~12x the measured Variant D budget.
#   * WAV, for download. Opus is the right streaming codec and the wrong hand-off
#     to a DAW.
#
# Failure posture: per-stem try/except, because failing the job would discard a
# completed separation and the loops that already uploaded. But "degrade" must not
# mean "degrade silently" — a reviewer demonstrated that a TOTAL encode failure was
# indistinguishable from a pre-V3-J2 job, so a short playback set now emits an ERROR
# log AND a Sentry event, and the route reports a state rather than just a count.
def retain_stems(job_id, stem_paths) -> dict:
    """Upload Opus (playback) + WAV (download) per stem. Returns a per-kind report."""
    enc_dir = tmpdirs.mkdtemp(prefix="sl_stemopus_")
    played: list[str] = []
    downloadable: list[str] = []
    for name, path in sorted(stem_paths.items()):
        if name not in ALL_STEMS or not path or not os.path.exists(path):
            continue
        opus = _encode_stem_opus(path, enc_dir, name, job_id=job_id)
        if opus:
            try:
                upload_stem(job_id, name, opus, "play")
                played.append(name)
            except Exception as exc:  # noqa: BLE001
                log_structured(
                    "ERROR",
                    "stem_retain_failed",
                    job_id=job_id,
                    stem=name,
                    kind="play",
                    error_type=type(exc).__name__,
                    error=str(exc)[:300],
                )
        try:
            upload_stem(job_id, name, path, "download")
            downloadable.append(name)
        except Exception as exc:  # noqa: BLE001
            log_structured(
                "ERROR",
                "stem_retain_failed",
                job_id=job_id,
                stem=name,
                kind="download",
                error_type=type(exc).__name__,
                error=str(exc)[:300],
            )
    report = {
        "play": played,
        "download": downloadable,
        "expected": list(ALL_STEMS),
        "complete": len(played) == len(ALL_STEMS),
    }
    log_structured("INFO", "stems_retained", job_id=job_id, **report)
    # A short playback set means the mixer cannot present this song properly. Make it
    # visible where someone actually looks, not only in a log line nobody greps.
    # The WAV count distinguishes the two causes: six WAVs with zero Opus is an
    # ENCODER problem (libopus missing, ffmpeg broken); zero of both is an upload or
    # R2 problem.
    if len(played) != len(ALL_STEMS):
        # A reviewer caught this labelling a PARTIAL encoder failure (say 3 playable,
        # 6 downloadable) as "upload_or_r2". The distinguishing fact is not "zero
        # playable" — it is that FEWER stems encoded than uploaded, which can only be
        # the encoder. Only when nothing uploaded either is it an upload/R2 problem.
        cause = "encoder" if len(downloadable) > len(played) else "upload_or_r2"
        log_structured(
            "ERROR",
            "stems_retained_incomplete",
            job_id=job_id,
            playable=len(played),
            downloadable=len(downloadable),
            expected=len(ALL_STEMS),
            likely_cause=cause,
        )
        # Bare capture_message with the facts in the string, matching how the rest of
        # this module reports to Sentry. Wrapped because a Sentry outage must not take
        # a job down over an optional artifact.
        with contextlib.suppress(Exception):  # telemetry is never load-bearing
            sentry_sdk.capture_message(
                f"V3-J2 stem retention incomplete: {len(played)}/{len(ALL_STEMS)} "
                f"playable, {len(downloadable)}/{len(ALL_STEMS)} downloadable, "
                f"likely_cause={cause}, job_id={job_id}",
                level="error",
            )
    return report


def process_stems(job_id, stem_paths, requested_stems, bars, sr=44100) -> int:
    """Full audio core: extract+tag then encode+upload. Returns loops created."""
    loops, tags, seg_label, seg_energy = extract_and_tag(
        job_id, stem_paths, requested_stems, bars, sr
    )
    return encode_and_upload(job_id, loops, tags, seg_label, seg_energy, bars, sr)


# --------------------------- Y1.1: chord recognition ----------------------------
# Real stem set emitted by htdemucs_6s (see replicate_client.STEM_RENAME: piano -> keys):
#   vocals, drums, bass, other, guitar, keys.
# There is NO 'instrumental' stem. In a 6-stem split, 'other' is the residue left AFTER
# guitar and keys were extracted, so it is the harmonically thinnest non-vocal stem.
# Real songs spread harmony across instruments, so by default we sum the harmonic stems
# into one temporary file ("harmonic_mix") and hand that to the provider.
HARMONIC_MIX = "harmonic_mix"
# Stems that carry harmony, in single-stem fallback order (harmony-richest first). 'other'
# is LAST on purpose: under a 6-stem split it is the leftover residue.
_HARMONIC_STEMS = ("keys", "guitar", "other")
# Added to the mix (never used alone): bass supplies chord roots/inversions.
_MIX_EXTRA_STEMS = ("bass",)
# Legacy / alias values of CHORDS_STEM that mean "the harmonic mix". 'instrumental' was a
# 4-stem-era assumption; existing deployments still set CHORDS_STEM=instrumental. Any other
# unknown value (including 'vocals' / 'drums') also resolves to the mix: those two are never
# selectable because only _HARMONIC_STEMS are ever candidates.
CHORDS_DEFAULT_STEM = os.environ.get("CHORDS_STEM", HARMONIC_MIX)


def _mix_stems_to_wav(stem_paths: list[str]) -> str | None:
    """Sum stems into one 44.1k stereo WAV in a job-scoped tmpdir. None on any failure."""
    try:
        out = os.path.join(tmpdirs.mkdtemp(prefix="sl_chordmix_"), "harmonic_mix.wav")
        cmd = [_ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y"]
        for p in stem_paths:
            cmd += ["-i", p]
        cmd += [
            "-filter_complex",
            f"amix=inputs={len(stem_paths)}:normalize=0:duration=longest,alimiter=limit=0.95",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
            out,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
            log_structured("WARN", "chords_mix_failed", error=proc.stderr[:200])
            return None
        return out
    except Exception as exc:  # noqa: BLE001 — caller falls back to a single stem
        log_structured("WARN", "chords_mix_failed", error=str(exc)[:200])
        return None


def _choose_chord_input(stem_paths: dict, preferred: str = HARMONIC_MIX) -> tuple[str, str] | None:
    """Pick the audio handed to the (billable) chord provider, or ``None`` to skip.

    Returns ``(label, local_path)``. ``label`` is ``'harmonic_mix'`` for a synthesised mix or
    the stem name (``keys`` / ``guitar`` / ``other``) for an explicitly requested single stem.

    * ``preferred`` is a real harmonic stem name (keys/guitar/other) and present -> that stem.
      This is an explicit operator override (``CHORDS_STEM``), honoured as asked.
    * Otherwise (``harmonic_mix``, legacy ``instrumental``, anything unknown) -> mix the
      harmonic stems (keys + guitar + other, plus bass for roots) but ONLY when 2+ harmonic
      stems exist. In a 6-stem split ``other`` is the residue left after guitar and keys were
      extracted, so ``other`` alone (what survives when a user deselects guitar/keys and the
      stems were never fetched) is plausible-looking but wrong, and Klangio would bill for it.
      With fewer than two harmonic stems we return ``None``: skip WITHOUT spending.
    * If the mix itself fails there is deliberately NO single-stem fallback: the old
      keys -> guitar -> other fallback sent a possibly near-silent ``keys`` stem to a paid API.
    * ``vocals`` / ``drums`` are never selected, even if requested. Bass alone is not usable
      harmony.
    """
    harmonic = [n for n in _HARMONIC_STEMS if stem_paths.get(n)]
    if preferred in _HARMONIC_STEMS and stem_paths.get(preferred):
        return preferred, stem_paths[preferred]
    if len(harmonic) < 2:
        return None
    names = harmonic + [n for n in _MIX_EXTRA_STEMS if stem_paths.get(n)]
    mixed = _mix_stems_to_wav([stem_paths[n] for n in names])
    if mixed:
        return HARMONIC_MIX, mixed
    return None


def _existing_play_chords(job_id: str) -> bool:
    """True if a VALID ``jobs/<job_id>/play.chords.json`` already exists in R2.

    Makes chord recognition idempotent per job: a reaper requeue (OOM in extract/upload)
    re-runs the whole pipeline, and Klangio has no idempotency key, so without this every
    rerun is another billed request. ``put_object`` is atomic on R2, so a half-written
    object cannot occur; but a zero-byte / non-JSON / segment-less object must not
    permanently suppress chords, so a bare existence (HEAD) check is NOT enough. We GET the
    (small) object and require a JSON object with a ``segments`` LIST. An empty list is a
    valid, complete result: a silent or atonal track legitimately yields ``[]``, and the
    request for it was already paid for, so it must suppress reruns. A tombstone
    (``{"status": "unavailable", ...}``) has no ``segments`` and still counts as absent.
    Anything else is treated as absent and regenerated (overwrites in place; bounded by the
    reaper's attempt cap; a recorded Klangio job id makes the regeneration free). A missing key is the normal first-run case. Any other R2 error fails
    OPEN (returns False, logged): a transient R2 blip then costs at most one request,
    whereas failing closed would silently drop chords.
    """
    import json as _json  # noqa: PLC0415

    from .storage import r2_uploader  # noqa: PLC0415

    key = f"jobs/{job_id}/play.chords.json"
    try:
        obj = r2_uploader._r2().get_object(Bucket=os.environ["R2_BUCKET_NAME"], Key=key)
        raw = obj["Body"].read()
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
        if code not in ("NoSuchKey", "404", "NotFound"):
            log_structured("WARN", "chords_reuse_check_failed", job_id=job_id, error=str(exc)[:200])
        return False
    try:
        payload = _json.loads(raw)
        segments = payload.get("segments") if isinstance(payload, dict) else None
        valid = isinstance(segments, list)
    except (ValueError, TypeError):
        valid = False
    if not valid:
        log_structured(
            "WARN",
            "chords_existing_artifact_invalid",
            job_id=job_id,
            r2_key=key,
            bytes=len(raw) if isinstance(raw, (bytes, bytearray)) else -1,
        )
    return valid


CHORDS_MAX_AUDIO_SEC_DEFAULT = 300.0


def _chords_max_audio_sec() -> float:
    """Longest track (seconds) we will send to the chord provider. Read at call time.

    Mirrors Klangio's 300 s limit on every tier below Enterprise (see
    ``KLANGIO_MAX_AUDIO_SEC``, which the provider still enforces independently). Invalid or
    non-positive values fall back to the default rather than silently disabling the guard.
    """
    raw = os.environ.get("CHORDS_MAX_AUDIO_SEC", "").strip()
    if not raw:
        return CHORDS_MAX_AUDIO_SEC_DEFAULT
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if not value > 0 or value == float("inf"):
        log_structured("WARN", "chords_max_audio_sec_invalid", using=CHORDS_MAX_AUDIO_SEC_DEFAULT)
        return CHORDS_MAX_AUDIO_SEC_DEFAULT
    return value


def _probe_duration_sec(path: str) -> float | None:
    """Local duration probe (soundfile, then ffprobe). None if it cannot be measured."""
    try:
        import soundfile as sf  # noqa: PLC0415 — heavy native dep, keep import lazy

        return float(sf.info(path).duration)
    except Exception:  # noqa: BLE001 — fall through to ffprobe
        pass
    try:
        exe = shutil.which("ffprobe")
        if not exe:
            return None
        proc = subprocess.run(
            [exe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return float(proc.stdout.strip()) if proc.returncode == 0 else None
    except Exception:  # noqa: BLE001
        return None


def _write_chords_tombstone(job_id: str, reason: str, **detail) -> None:
    """Record WHY a job has no chords at ``jobs/<job_id>/play.chords.json``.

    Shape ``{"status": "unavailable", "reason": <reason>}`` is what the web loader
    (``play-chords-loader.ts``) already understands. It has no ``segments``, so
    ``_existing_play_chords`` treats it as absent and a reaper rerun still retries. Never
    raises: this is a best-effort UX hint on an optional feature.
    """
    import json as _json  # noqa: PLC0415

    try:
        upload_play_chords(
            job_id, _json.dumps({"status": "unavailable", "reason": reason, **detail}).encode()
        )
    except Exception as exc:  # noqa: BLE001
        log_structured(
            "WARN", "chords_tombstone_failed", job_id=job_id, reason=reason, error=str(exc)[:200]
        )


class _KlangioJobLedger:
    """``jobs.klangio_job_id`` as the durable at-most-once record of a Klangio spend.

    The Klangio analogue of ``replicate_prediction_id`` / ``submit_or_reattach``:
      NULL -> never submitted;  ``SENTINEL`` -> a POST began but its id was not recorded
      (cannot reattach, must not re-POST);  anything else -> the Klangio job id (reattach).
    Every transition is one conditional UPDATE, so two workers cannot both claim a job.
    Migration 030 adds the column and must be applied before this code ships.
    """

    SENTINEL = "submitting"

    def __init__(self, job_id: str) -> None:
        self.job_id = job_id

    def existing(self) -> str | None:
        with _db() as c:
            row = c.execute(
                "SELECT klangio_job_id FROM jobs WHERE id=%s", (self.job_id,)
            ).fetchone()
        value = row[0] if row else None
        if value is None:
            return None
        if value == self.SENTINEL:
            raise ChordSubmitUncertain(
                "a Klangio submit began for this job but its id was never recorded; "
                "not submitting again (possible double bill)"
            )
        return str(value)

    def claim(self) -> None:
        with _db() as c:
            cur = c.execute(
                "UPDATE jobs SET klangio_job_id=%s WHERE id=%s AND klangio_job_id IS NULL",
                (self.SENTINEL, self.job_id),
            )
            claimed = cur.rowcount == 1
            c.commit()
        if not claimed:
            raise ChordSubmitUncertain("another worker already holds or recorded a Klangio submit")

    def record(self, provider_job_id: str) -> None:
        with _db() as c:
            cur = c.execute(
                "UPDATE jobs SET klangio_job_id=%s WHERE id=%s AND klangio_job_id=%s",
                (provider_job_id, self.job_id, self.SENTINEL),
            )
            recorded = cur.rowcount == 1
            c.commit()
        if not recorded:
            raise InternalError("klangio_job_id claim missing when recording the job id")

    def release(self) -> None:
        with _db() as c:
            c.execute(
                "UPDATE jobs SET klangio_job_id=NULL WHERE id=%s AND klangio_job_id=%s",
                (self.job_id, self.SENTINEL),
            )
            c.commit()


def _maybe_run_chord_recognition(job_id: str, stem_paths: dict, requested_stems) -> None:
    """Y1.1 feature-flag entry point. Uploads ``play.chords.json`` to R2 or no-ops.

    Guard: ``CHORDS_PROVIDER`` empty string (explicit disable) short-circuits
    without importing the provider — important for Gate-2 fixture runs that
    must not hit Klangio. Any provider-side error (missing API key, quota,
    network) is logged and swallowed; the pipeline MUST NOT fail here.

    The JSON artifact lands at ``jobs/<job_id>/play.chords.json`` in R2 (not on
    the worker's local disk — Fly machines are ephemeral). The web loader reads
    it via a short-TTL signed URL; the key is kept private.
    """
    provider_name = os.environ.get("CHORDS_PROVIDER", "klangio")
    if not provider_name:
        log_structured("INFO", "chords_skipped_disabled", job_id=job_id)
        return
    # Idempotency gate: BEFORE stem selection (which may run an ffmpeg mix) and before the
    # provider, whose recognize() is where the Klangio quota is reserved. Returning here means
    # no ffmpeg, no quota increment, no billed request on a reaper rerun.
    if _existing_play_chords(job_id):
        log_structured(
            "INFO",
            "chords_reused_existing_artifact",
            job_id=job_id,
            r2_key=f"jobs/{job_id}/play.chords.json",
        )
        return
    # Duration gate: BEFORE stem selection so an over-length track also skips the ffmpeg
    # harmonic mix. The track is still accepted (stems/loops are the product); only the
    # optional chord overlay is skipped, with a specific reason for the UI.
    probe_path = next(
        (stem_paths[n] for n in (*_HARMONIC_STEMS, *_MIX_EXTRA_STEMS) if stem_paths.get(n)),
        next((p for p in stem_paths.values() if p), None),
    )
    duration = _probe_duration_sec(probe_path) if probe_path else None
    max_sec = _chords_max_audio_sec()
    if duration is not None and duration > max_sec:
        log_structured(
            "INFO",
            "chords_skipped_too_long",
            job_id=job_id,
            duration_sec=round(duration, 1),
            max_sec=max_sec,
        )
        _write_chords_tombstone(job_id, "too_long", duration_sec=round(duration, 1))
        return
    chosen = _choose_chord_input(stem_paths, preferred=CHORDS_DEFAULT_STEM)
    if not chosen:
        log_structured(
            "WARN",
            "chords_skipped_no_harmonic_stem",
            job_id=job_id,
            harmonic_available=sum(1 for n in _HARMONIC_STEMS if stem_paths.get(n)),
            stems=sorted(stem_paths.keys()),
            preferred=CHORDS_DEFAULT_STEM,
        )
        _write_chords_tombstone(job_id, "not_attempted")
        return
    stem_name, audio_path = chosen
    log_structured(
        "INFO",
        "chords_input_selected",
        job_id=job_id,
        chord_input=stem_name,
        preferred=CHORDS_DEFAULT_STEM,
        available_stems=sorted(stem_paths.keys()),
    )

    try:
        # Import locally — a missing chord_providers package would otherwise
        # crash workers that haven't opted in.
        from dataclasses import asdict as _asdict  # noqa: PLC0415
        from pathlib import Path as _Path  # noqa: PLC0415

        from .chord_source import get_chord_source  # noqa: PLC0415

        # The ledger makes the billable POST at-most-once per job: a recorded Klangio job id
        # is reattached (free GETs) after a reaper requeue / deploy / failed R2 upload.
        result = get_chord_source(provider_name).recognize(
            _Path(audio_path), stem=stem_name, ledger=_KlangioJobLedger(job_id)
        )

        import json as _json  # noqa: PLC0415

        body = _json.dumps(_asdict(result)).encode("utf-8")
        try:
            r2_key = upload_play_chords(job_id, body)
        except Exception as upload_exc:  # noqa: BLE001 — chords are optional
            # Upload failure is NON-FATAL: chord recognition itself succeeded,
            # so we logged the result below. A missing object just means the
            # web overlay degrades to the live tab-capture path (Y1 UX only).
            log_structured(
                "WARN",
                "play_chords_upload_failed",
                job_id=job_id,
                provider=provider_name,
                error=str(upload_exc)[:200],
            )
            sentry_sdk.capture_exception(upload_exc)
            r2_key = None

        log_structured(
            "INFO",
            "chords_complete",
            job_id=job_id,
            provider=result.provider,
            provider_version=result.provider_version,
            segments=len(result.segments),
            model_ms=result.model_ms,
            key=result.key,
            stem=stem_name,
            r2_key=r2_key,
        )
    except ChordSubmitUncertain as exc:
        # A previous run may already have paid for this job but lost the id: skip rather than
        # risk a second $0.20. Tombstone reason stays one the web loader maps.
        log_structured(
            "WARN", "chords_skipped_submit_uncertain", job_id=job_id, error=str(exc)[:200]
        )
        sentry_sdk.capture_exception(exc)
        _write_chords_tombstone(job_id, "provider_failed")
    except Exception as exc:  # noqa: BLE001 — chords are optional
        log_structured(
            "WARN",
            "chords_failed",
            job_id=job_id,
            provider=provider_name,
            error=str(exc)[:200],
        )
        # Also tell Sentry so the Y1 bridge visibility doesn't die silently.
        sentry_sdk.capture_exception(exc)
        # We tried and it failed: tell the user that, not the generic text.
        _write_chords_tombstone(job_id, "provider_failed")


@contextlib.asynccontextmanager
async def _stage_heartbeat(job_id: str):
    """Bump ``jobs.updated_at`` every HEARTBEAT_SECONDS while a long stage runs.

    Any stage that can run longer than the reaper's STALE_SECONDS (300s) without
    emitting an event MUST hold this, or a second machine's reaper re-queues a LIVE
    job and the rerun pays for a second separation. The chord stage needed it for
    Klangio polling; stem retention needs it because six Opus encodes plus ~300 MB
    of uploads is easily minutes with nothing else bumping updated_at.
    """
    from .replicate_client import HEARTBEAT_SECONDS, _heartbeat  # noqa: PLC0415

    async def _beat() -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            await asyncio.to_thread(_heartbeat, job_id)  # best-effort; never raises

    task = asyncio.create_task(_beat())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


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


def _chords_enabled() -> bool:
    """Same switch the hook uses: ``CHORDS_PROVIDER=''`` disables chords entirely."""
    return bool(os.environ.get("CHORDS_PROVIDER", "klangio"))


def _fetch_stems(stem_urls: dict, requested_stems, also: tuple[str, ...] = ()) -> dict:
    """Download the user's requested stems plus any ``also`` stems the pipeline needs itself.

    ``also`` is for stems that are not loop output but are inputs to another stage (the
    chord harmonic mix). They are fetched regardless of what the user toggled, so the chord
    input never silently degrades to the post-extraction ``other`` residue. Loop extraction
    still honours ``requested_stems`` (``extract_and_tag`` filters), so no unrequested loops.
    """
    tmpdir = tmpdirs.mkdtemp(prefix="sl_stems_")
    wanted = [
        (name, url)
        for name, url in stem_urls.items()
        if not requested_stems or name in requested_stems or name in also
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
                log_structured(
                    "WARN", "stem_fetch_retry", stem=name, attempt=attempt, error=str(exc)[:160]
                )
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
        path = os.path.join(tmpdirs.mkdtemp(prefix="stub_ph_"), "silent.wav")
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
                    except (
                        Exception
                    ) as exc:  # noqa: BLE001 — no R2 (pure-DB test): skip, don't crash
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
                    (
                        str(uuid.uuid4()),
                        job_id,
                        stem,
                        section,
                        "mid",
                        start,
                        end,
                        int(start / bar_sec),
                        bars,
                        bpm,
                        key,
                        r2_key,
                        f"{job_id}_{stem}_{i:04d}.wav",
                        int(bars * bar_sec * 1000),
                        Json([0.1, 0.5, 0.3, 0.6, 0.2]),
                    ),
                )
                n += 1
        c.commit()
    return n


async def _run_stub(job_id: str, requested_stems, bars: int) -> None:
    """Walk the §6.3 state machine emitting events, then write fake loops + done."""
    for stage, p0, p1 in (
        ("downloading", 0, 100),
        ("separating", 15, 100),
        ("extracting", 70, 100),
        ("uploading", 90, 100),
    ):
        await set_status(job_id, stage)
        await emit_event(job_id, stage, "started", pct=p0)
        await emit_event(job_id, stage, "completed", pct=p1)
    await asyncio.to_thread(_insert_stub_loops, job_id, requested_stems, bars)
    await set_status(job_id, "done")


async def run_pipeline(job_id: str) -> None:
    """Run the pipeline; every scratch dir it creates is removed when it ends (retention)."""
    with tmpdirs.job_scope():
        await _run_pipeline(job_id)


async def _run_pipeline(job_id: str) -> None:
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
            dl_result, _source = await asyncio.to_thread(download_audio, url, job_id)
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
                log_structured(
                    "WARN",
                    "separation_timeout_retry",
                    job_id=job_id,
                    attempt=attempt,
                    pred_id=pred_id,
                )
        # Chord recognition needs the harmonic stems whether or not the user toggled them as
        # loop output (deselecting guitar/keys must not leave only the `other` residue).
        # V3-J2: fetch ALL SIX stems, not just the requested ones plus the chord
        # stage's harmonic set. `_fetch_stems` filters on `requested_stems`, so a job
        # that asked for only vocals previously retained vocals/keys/guitar/other/bass
        # and NO DRUMS — and the mixer would then play a drumless song with no error
        # at all. `requested_stems` governs which LOOPS get cut (extract_and_tag
        # filters independently); it must not govern which stems the mixer can fade.
        stem_paths = await asyncio.to_thread(_fetch_stems, stem_urls, requested_stems, ALL_STEMS)
        # Persist the Replicate cost so the admission spend-ceiling (which sums
        # job_events.detail->>'cost_usd' over 24h) actually enforces (P4).
        await emit_event(job_id, "separating", "completed", pct=100, detail={"cost_usd": sep_cost})

        await set_status(job_id, "extracting")
        await emit_event(job_id, "extracting", "started", pct=70)
        loops, tags, seg_label, seg_energy = await asyncio.to_thread(
            extract_and_tag, job_id, stem_paths, requested_stems, bars
        )
        # Y1.1: Chord recognition (feature-flagged). Runs AFTER extract_and_tag succeeds: a
        # beatless / too-short track fails the job there, and must do so BEFORE the $0.20
        # Klangio request is made, not after. Default provider
        # per the Y1 decision record is 'klangio'. Set CHORDS_PROVIDER='' to
        # DISABLE — useful for fixture / Gate-2 runs that must not call the
        # provider. Failures here NEVER fail the pipeline: chords are an optional
        # overlay feature; a missing play.chords.json degrades Y1 UI only.
        # Klangio polling can run 600s+ (POLL_DEADLINE_SEC) against a 300s reaper stale
        # window and nothing else bumps updated_at here, so heartbeat for the duration.
        # Otherwise a second machine's reaper (deploy overlap) requeues a LIVE job and
        # the rerun submits a second billed request before the first artifact exists.
        async with _stage_heartbeat(job_id):
            await asyncio.to_thread(
                _maybe_run_chord_recognition, job_id, stem_paths, requested_stems
            )

        await emit_event(job_id, "extracting", "completed", pct=100)

        await set_status(job_id, "uploading")
        await emit_event(job_id, "uploading", "started", pct=90)
        count = await asyncio.to_thread(
            encode_and_upload,
            job_id,
            loops,
            tags,
            seg_label,
            seg_energy,
            bars,
            title=_title_slug(original_filename, job_id),
        )
        # V3-J2: retain the full-length stems for the play-along faders. After the
        # loops, so a stem-upload problem can never cost us the loops.
        async with _stage_heartbeat(job_id):
            stem_report = await asyncio.to_thread(retain_stems, job_id, stem_paths)
        await emit_event(job_id, "uploading", "completed", pct=100, detail={"stems": stem_report})

        await set_status(job_id, "done")
        # Peak worker RSS (kernel high-water mark) — real evidence for sizing the Option-B
        # Fly VM. On Fly each deploy is a fresh machine, so ru_maxrss here IS this job's peak
        # memory, letting us downsize 4GB→2GB on data not a guess. (ru_maxrss is KB on Linux.)
        log_structured(
            "INFO",
            "pipeline_done",
            job_id=job_id,
            loops=count,
            peak_rss_mb=round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        )

    except StemLoopsError as exc:
        # Deliberately NOT sent to Sentry: these are the designed, typed error paths
        # (DOWNLOAD_BLOCKED, DOWNLOAD_TIMEOUT, etc.) working exactly as intended —
        # reporting every one would just be noise the sentry-triage job has to filter.
        await _fail(job_id, exc.error_code, exc.user_message)
        raise
    except Exception as exc:  # noqa: BLE001 — surface as typed INTERNAL_ERROR
        # This IS worth reporting — an exception that fell through every typed error
        # class is by definition something nobody anticipated. No-op if SENTRY_DSN
        # isn't configured (main.py only calls sentry_sdk.init when it's set).
        sentry_sdk.capture_exception(exc)
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
