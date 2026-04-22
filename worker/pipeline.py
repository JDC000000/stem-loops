#!/usr/bin/env python3
"""
Stem-Loops worker pipeline — ported from drum_loop_pipeline.py.

Key differences from the single-stem version:
  - Processes N selected stems per job (drums, bass, vocals, guitar, keys)
  - Configurable bars (1, 2, 4, 8)
  - Uploads results to S3/R2 and reports back via callback
  - Designed to be invoked from a queue consumer, not a CLI

Dependencies: librosa, soundfile, numpy, demucs, yt-dlp, boto3
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, List, Optional

import librosa
import numpy as np
import soundfile as sf


# --------------------------------------------------------------------------- #
# Types                                                                        #
# --------------------------------------------------------------------------- #

StemKind = str  # "drums" | "bass" | "vocals" | "guitar" | "keys"

ALL_STEMS: List[StemKind] = ["drums", "bass", "vocals", "guitar", "keys"]


@dataclass
class LoopResult:
    stem: StemKind
    index: int
    filename: str
    local_path: str
    start_sec: float
    end_sec: float
    duration_sec: float
    bpm: int
    energy_label: str
    rms: float


@dataclass
class JobOutput:
    title: str
    bpm: int
    loops: List[LoopResult]


ProgressCallback = Callable[[str, int, str], None]
# (stage, progress_pct, human_message)


# --------------------------------------------------------------------------- #
# Tool discovery                                                               #
# --------------------------------------------------------------------------- #

def _find_bin(name: str) -> Optional[str]:
    import shutil
    p = shutil.which(name)
    if p:
        return p
    for prefix in ("/opt/homebrew/bin", "/usr/local/bin"):
        cand = os.path.join(prefix, name)
        if os.path.isfile(cand):
            return cand
    return None


# --------------------------------------------------------------------------- #
# Torchaudio save patch (macOS backend bug)                                    #
# --------------------------------------------------------------------------- #

def _patch_torchaudio() -> None:
    try:
        import torchaudio  # type: ignore

        _orig = torchaudio.save

        def _patched(uri, src, sample_rate, **kw):  # type: ignore[no-untyped-def]
            try:
                _orig(uri, src, sample_rate, **kw)
            except RuntimeError:
                os.makedirs(os.path.dirname(str(uri)), exist_ok=True)
                audio = src.cpu().numpy().T
                sf.write(str(uri), audio, sample_rate, subtype="PCM_24")

        torchaudio.save = _patched  # type: ignore[assignment]
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# Step 1: Download                                                             #
# --------------------------------------------------------------------------- #

def download_youtube(url: str, work_dir: str) -> tuple[str, str]:
    """Returns (title, wav_path)."""
    ytdlp = _find_bin("yt-dlp")
    if not ytdlp:
        raise RuntimeError("yt-dlp not found on PATH")

    # Datacenter IPs (Railway, most clouds) often get flagged by YouTube.
    # These flags help: pretend to be a real Safari, use the most permissive
    # extractor, and retry on transient failures. Bot-challenge errors will
    # still propagate — we surface the real stderr so the caller can diagnose.
    common_args = [
        "--user-agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        "--extractor-args", "youtube:player_client=web_safari,mweb",
        "--retries", "3",
        "--fragment-retries", "3",
    ]

    try:
        title = subprocess.check_output(
            [ytdlp, "--print", "title", *common_args, url],
            stderr=subprocess.PIPE,
            timeout=60,
        ).decode().strip()
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or b"").decode(errors="replace")[-800:]
        raise RuntimeError(f"yt-dlp title fetch failed: {stderr}") from e
    except subprocess.TimeoutExpired:
        raise RuntimeError("yt-dlp title fetch timed out after 60s")

    safe = "".join(c if c.isalnum() or c in " -_" else "" for c in title).strip()
    safe = safe.replace(" ", "_")
    out_tmpl = os.path.join(work_dir, f"{safe}.%(ext)s")

    try:
        subprocess.check_call(
            [ytdlp, "-x", "--audio-format", "wav", "-o", out_tmpl, *common_args, url],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=600,
        )
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or b"").decode(errors="replace")[-800:]
        raise RuntimeError(f"yt-dlp download failed: {stderr}") from e
    except subprocess.TimeoutExpired:
        raise RuntimeError("yt-dlp download timed out after 10 min")

    import glob
    candidates = glob.glob(os.path.join(work_dir, f"{safe}.wav"))
    if not candidates:
        raise FileNotFoundError(f"yt-dlp did not produce {safe}.wav")
    return title, candidates[0]


# --------------------------------------------------------------------------- #
# Step 2: Demucs — separate ALL stems in one pass                              #
# --------------------------------------------------------------------------- #

def separate_all_stems(wav_path: str, work_dir: str) -> dict[StemKind, str]:
    """
    Runs htdemucs (6-stem variant `htdemucs_6s`) to get drums, bass, vocals,
    guitar, other, piano. Maps to stem-loops's stem kinds.
    """
    _patch_torchaudio()

    sep_dir = os.path.join(work_dir, "separated")
    env = os.environ.copy()
    env["DYLD_LIBRARY_PATH"] = "/opt/homebrew/lib:" + env.get("DYLD_LIBRARY_PATH", "")
    env["PATH"] = "/opt/homebrew/bin:" + env.get("PATH", "")

    # htdemucs_6s gives us drums, bass, vocals, guitar, other, piano
    subprocess.check_call(
        [
            sys.executable, "-m", "demucs",
            "-n", "htdemucs_6s",
            "-o", sep_dir,
            wav_path,
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    stem_name = Path(wav_path).stem
    base = os.path.join(sep_dir, "htdemucs_6s", stem_name)

    # Map demucs stems → stem-loops names
    # htdemucs_6s outputs: drums, bass, vocals, other, guitar, piano
    mapping = {
        "drums": "drums.wav",
        "bass": "bass.wav",
        "vocals": "vocals.wav",
        "guitar": "guitar.wav",
        "keys": "piano.wav",  # we call piano "keys" in the UI
    }

    result: dict[StemKind, str] = {}
    for our_name, fname in mapping.items():
        path = os.path.join(base, fname)
        if os.path.isfile(path):
            result[our_name] = path
    return result


# --------------------------------------------------------------------------- #
# Step 3: Loop extraction                                                      #
# --------------------------------------------------------------------------- #

def _character(seg: np.ndarray, sr: int) -> str:
    S = np.abs(librosa.stft(seg, n_fft=2048, hop_length=512))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    total = float(np.sum(S))
    if total == 0:
        return "silent"
    kr = float(np.sum(S[(freqs >= 20) & (freqs <= 200)])) / total
    sr_ = float(np.sum(S[(freqs >= 200) & (freqs <= 5000)])) / total
    hr = float(np.sum(S[(freqs >= 5000) & (freqs <= 15000)])) / total
    rms = float(np.sqrt(np.mean(seg ** 2)))
    parts: List[str] = []
    if kr > 0.3:
        parts.append("kick-heavy")
    elif kr > 0.2:
        parts.append("solid kick")
    if sr_ > 0.5:
        parts.append("mid-dominant")
    elif sr_ > 0.3:
        parts.append("punchy mids")
    if hr > 0.15:
        parts.append("bright highs")
    elif hr > 0.08:
        parts.append("moderate highs")
    if rms > 0.1:
        parts.append("driving")
    elif rms > 0.05:
        parts.append("steady")
    elif rms > 0.02:
        parts.append("laid-back")
    else:
        parts.append("sparse")
    return ", ".join(parts) or "balanced"


def extract_loops_for_stem(
    stem_path: str,
    stem: StemKind,
    output_dir: str,
    title_clean: str,
    num_loops: int = 5,
    num_bars: int = 4,
    bpm_override: Optional[int] = None,
) -> list[LoopResult]:
    y, sr = librosa.load(stem_path, sr=None, mono=False)
    if y.ndim == 1:
        y = np.expand_dims(y, 0)
    y_mono = librosa.to_mono(y)
    total_samples = y.shape[1]

    if bpm_override:
        bpm = int(bpm_override)
    else:
        tempo, _ = librosa.beat.beat_track(y=y_mono, sr=sr)
        bpm = int(round(float(tempo[0]) if hasattr(tempo, "__len__") else float(tempo)))

    beat_dur = 60.0 / bpm
    bar_dur = beat_dur * 4
    loop_dur = bar_dur * num_bars
    bar_samples = int(bar_dur * sr)
    loop_samples = int(loop_dur * sr)

    _, beat_frames = librosa.beat.beat_track(y=y_mono, sr=sr)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=512)
    first_beat = int(beat_times[0] * sr) if len(beat_times) > 0 else 0

    hop = 512
    rms_arr = librosa.feature.rms(y=y_mono, hop_length=hop)[0]

    positions: list[dict] = []
    start = first_beat
    while start + loop_samples <= total_samples:
        f0 = int(start / hop)
        f1 = min(int((start + loop_samples) / hop), len(rms_arr))
        if f0 < f1:
            avg = float(np.mean(rms_arr[f0:f1]))
            if avg > 0.005:
                positions.append({"s": int(start), "rms": avg})
        start += bar_samples

    if not positions:
        return []

    positions.sort(key=lambda x: x["rms"])
    n = len(positions)
    tier_size = max(1, n // 5)
    tier_labels = [
        "Quiet/Intro",
        "Low Energy",
        "Medium Energy",
        "High Energy",
        "Peak Energy",
    ]
    tiers = []
    for i in range(5):
        lo = i * tier_size
        hi = n if i == 4 else (i + 1) * tier_size
        tiers.append(positions[lo:hi])

    per_tier = max(1, num_loops // 5)
    selected: list[dict] = []
    min_gap = 4 * bar_samples
    rng = np.random.default_rng(42)

    def no_overlap(c: dict) -> bool:
        return all(abs(c["s"] - s["s"]) >= min_gap for s in selected)

    for ti, tier in enumerate(tiers):
        indices = rng.permutation(len(tier))
        count = 0
        for idx in indices:
            if count >= per_tier:
                break
            c = tier[idx].copy()
            c["label"] = tier_labels[ti]
            if no_overlap(c):
                selected.append(c)
                count += 1

    for p in reversed(positions):
        if len(selected) >= num_loops:
            break
        c = p.copy()
        c["label"] = "Bonus"
        if no_overlap(c):
            selected.append(c)

    selected.sort(key=lambda x: x["s"])
    selected = selected[:num_loops]

    os.makedirs(output_dir, exist_ok=True)
    results: list[LoopResult] = []
    for i, lp in enumerate(selected, 1):
        s0 = lp["s"]
        s1 = s0 + loop_samples
        if s1 > total_samples:
            continue
        chunk = y[:, s0:s1]
        fname = f"{title_clean}_{stem}_{bpm}bpm_loop_{i:02d}.wav"
        fpath = os.path.join(output_dir, fname)
        sf.write(fpath, chunk.T, sr, subtype="PCM_24")

        t0, t1 = s0 / sr, s1 / sr
        results.append(
            LoopResult(
                stem=stem,
                index=i,
                filename=fname,
                local_path=fpath,
                start_sec=t0,
                end_sec=t1,
                duration_sec=loop_dur,
                bpm=bpm,
                energy_label=lp["label"],
                rms=lp["rms"],
            )
        )
    return results


# --------------------------------------------------------------------------- #
# Main entry point                                                             #
# --------------------------------------------------------------------------- #

def run_job(
    url: str,
    stems: Iterable[StemKind],
    num_bars: int,
    num_loops: int = 5,
    progress: Optional[ProgressCallback] = None,
) -> JobOutput:
    """
    End-to-end: download → separate → extract loops for each requested stem.
    Returns a JobOutput with local file paths. The caller is responsible for
    uploading results to R2/S3 and emitting status updates.
    """

    def _report(stage: str, pct: int, msg: str) -> None:
        if progress:
            progress(stage, pct, msg)

    work_dir = tempfile.mkdtemp(prefix="stem_loops_job_")

    _report("downloading", 10, "Downloading audio from YouTube")
    title, wav_path = download_youtube(url, work_dir)

    _report("separating", 30, "Separating stems with Demucs (this takes 2-3 min)")
    stem_paths = separate_all_stems(wav_path, work_dir)

    _report("extracting", 80, "Extracting bar-aligned loops")
    output_dir = os.path.join(work_dir, "loops")
    os.makedirs(output_dir, exist_ok=True)

    title_clean = "".join(
        c if c.isalnum() or c in " -_" else "" for c in title
    ).strip().replace(" ", "_")

    all_loops: list[LoopResult] = []
    detected_bpm = 0
    for stem in stems:
        if stem not in stem_paths:
            continue
        loops = extract_loops_for_stem(
            stem_paths[stem],
            stem,
            output_dir,
            title_clean,
            num_loops=num_loops,
            num_bars=num_bars,
        )
        if loops and not detected_bpm:
            detected_bpm = loops[0].bpm
        all_loops.extend(loops)

    _report("done", 100, "Complete")

    return JobOutput(title=title, bpm=detected_bpm, loops=all_loops)
