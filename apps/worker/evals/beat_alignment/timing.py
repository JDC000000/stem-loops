"""Wall-clock of the worker's extracting stage (`pipeline.extract_and_tag`), median of N runs.

    python timing.py --worker-src PATH/TO/apps/worker/src --ref DRUMS.wav \
        [--other STEM.wav ...] [--bars 4] [--runs 3]

Run once against the base checkout and once against the branch, on an otherwise idle
machine. Production runs this stage with every requested stem (up to 6); pass the
other stems with --other to match.
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker-src", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--other", nargs="*", default=[])
    ap.add_argument("--bars", type=int, default=4)
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()
    sys.path.insert(0, os.path.abspath(args.worker_src))
    from worker import pipeline

    pipeline._update_job_tags = lambda *a, **k: None
    stems = {"drums": args.ref}
    names = ["bass", "vocals", "guitar", "keys", "other"]
    stems.update({names[i]: p for i, p in enumerate(args.other[:5])})
    times = []
    for _ in range(args.runs):
        t0 = time.perf_counter()
        loops, tags, _, _ = pipeline.extract_and_tag("timing", stems, list(stems), args.bars)
        times.append(time.perf_counter() - t0)
    print(
        f"stems={len(stems)} bars={args.bars} bpm={tags['bpm']} loops={len(loops)} "
        f"median={statistics.median(times):.2f}s runs={[round(t, 2) for t in times]}"
    )


if __name__ == "__main__":
    main()
