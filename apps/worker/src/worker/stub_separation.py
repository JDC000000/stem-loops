"""Stub separation: returns fake 24-bit stem WAV paths for Phase 1 development.

Lets the full UI -> queue -> worker -> DB -> UI loop run end-to-end without
Replicate. Replaced by the real Replicate htdemucs_6s client in Phase 2 (T12).
"""

import os
import shutil
import tempfile
from contextlib import contextmanager

import numpy as np
import soundfile as sf

STEMS = ["drums", "bass", "vocals", "guitar", "keys", "other"]


@contextmanager
def stub_separate(job_id: str):
    """Yield {stem: path} for 8s silent 24-bit WAVs, then delete them.

    A context manager rather than a plain return (H11): the caller can't clean up a
    temp directory it was never told about, and six full-length-shaped WAVs per call
    add up fast on an always-on worker.

        with stub_separate(job_id) as stem_paths:
            process_stems(job_id, stem_paths, ...)
    """
    tmpdir = tempfile.mkdtemp(prefix=f"stub_{job_id}_")
    try:
        sr = 44100
        silence = np.zeros(sr * 8, dtype=np.float32)  # 8 seconds (4 bars @ 120 BPM)
        stem_paths: dict[str, str] = {}
        for stem in STEMS:
            path = os.path.join(tmpdir, f"{stem}.wav")
            sf.write(path, silence, sr, subtype="PCM_24")
            stem_paths[stem] = path
        yield stem_paths
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
