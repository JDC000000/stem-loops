"""Reference beats/downbeats for real tracks + drum stems, using tools the worker does NOT use.

Run in a separate eval-only venv (torch CPU, beat_this, demucs) — never in the worker image:

    python ground_truth.py beats  AUDIO [AUDIO ...]   # -> AUDIO.beatthis.json (Beat This! final0)
    python ground_truth.py drums  OUT_DIR AUDIO [...]  # -> OUT_DIR/<name>.drums.wav (htdemucs)

Beat This! (Foscarin et al., ISMIR 2024) is an independent neural beat/downbeat tracker, so
the worker's onset-envelope method is not graded against itself. Its output is 50 fps
(20 ms frames); run_eval.py de-quantizes it with a local linear fit before measuring.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys


def beats(paths: list[str]) -> None:
    from beat_this.inference import File2Beats

    tracker = File2Beats(checkpoint_path="final0", device="cpu", dbn=False)
    for p in paths:
        b, d = tracker(p)
        out = {
            "source": "beat_this final0",
            "bpm": None,
            "beats": [round(float(x), 4) for x in b],
            "downbeats": [round(float(x), 4) for x in d],
        }
        dest = os.path.splitext(p)[0] + ".beatthis.json"
        with open(dest, "w") as f:
            json.dump(out, f)
        print(f"{os.path.basename(p)}: {len(b)} beats, {len(d)} downbeats -> {dest}")


def drums(out_dir: str, paths: list[str]) -> None:
    os.makedirs(out_dir, exist_ok=True)
    for p in paths:
        name = os.path.splitext(os.path.basename(p))[0]
        subprocess.run(
            [
                sys.executable,
                "-m",
                "demucs",
                "-n",
                "htdemucs",
                "--two-stems",
                "drums",
                "-o",
                out_dir,
                "--filename",
                "{track}.{stem}.{ext}",
                p,
            ],
            check=True,
        )
        src = os.path.join(out_dir, "htdemucs", f"{name}.drums.wav")
        os.replace(src, os.path.join(out_dir, f"{name}.drums.wav"))
        print(f"{name}: drums stem -> {out_dir}/{name}.drums.wav")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "beats":
        beats(sys.argv[2:])
    elif cmd == "drums":
        drums(sys.argv[2], sys.argv[3:])
    else:
        raise SystemExit(__doc__)
