"""Stub separation: returns fake 24-bit stem WAV paths for Phase 1 development.

Lets the full UI -> queue -> worker -> DB -> UI loop run end-to-end without
Replicate. Replaced by the real Replicate htdemucs_6s client in Phase 2 (T12).
"""

import os
import tempfile

import numpy as np
import soundfile as sf

STEMS = ["drums", "bass", "vocals", "guitar", "keys", "other"]


def stub_separate(job_id: str) -> dict[str, str]:
    """Generate an 8s silent 24-bit WAV per stem; return {stem: path}."""
    tmpdir = tempfile.mkdtemp(prefix=f"stub_{job_id}_")
    sr = 44100
    silence = np.zeros(sr * 8, dtype=np.float32)  # 8 seconds (4 bars @ 120 BPM)
    stem_paths: dict[str, str] = {}
    for stem in STEMS:
        path = os.path.join(tmpdir, f"{stem}.wav")
        sf.write(path, silence, sr, subtype="PCM_24")
        stem_paths[stem] = path
    return stem_paths
