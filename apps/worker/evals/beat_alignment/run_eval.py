"""Loop-alignment evaluation: run the worker's real extract+tag path and grade loop starts.

    python run_eval.py --worker-src PATH/TO/apps/worker/src --data DATA_DIR \
        --label after --out results-after.json [--bars 1 2 4]

DATA_DIR layout (all outside the repo — see README.md):
    synth/<name>.wav + <name>.gt.json            exact ground truth (synth.py)
    audio/<name>.{mp3,wav} + <name>.beatthis.json reference beats (ground_truth.py beats)
    stems/<name>.drums.wav                       htdemucs drum stem (ground_truth.py drums)

Real tracks are evaluated twice: with the drum stem as reference (what production does —
pipeline.extract_and_tag prefers drums) and with the full mix. Runs whatever version of
`worker.pipeline.extract_and_tag` is at --worker-src, so the same script grades before/after.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time

import numpy as np

DOWNBEAT_TOL_S = 0.07


# ------------------------------- ground truth --------------------------------
def dequantize(beats: np.ndarray, half_window: int = 6) -> np.ndarray:
    """Local linear fit of beat time vs index, within runs of consistent beat spacing.

    Beat This! emits 20 ms frames; a ±6-beat local fit averages that quantization out
    while still following tempo changes. Runs are split where an inter-beat interval
    deviates >15 % from the median (missed/extra beats), so indices stay meaningful.
    """
    if len(beats) < 4:
        return beats
    ibi = np.diff(beats)
    med = np.median(ibi)
    breaks = np.where(np.abs(ibi / med - 1) > 0.15)[0]
    out = beats.astype(float).copy()
    start = 0
    for end in list(breaks + 1) + [len(beats)]:
        seg = beats[start:end]
        for i in range(len(seg)):
            lo, hi = max(0, i - half_window), min(len(seg), i + half_window + 1)
            if hi - lo >= 4:
                k = np.arange(lo, hi)
                a, b = np.polyfit(k, seg[lo:hi], 1)
                out[start + i] = a * i + b
        start = end
    return out


def gt_tempo(beats: np.ndarray) -> float:
    """Tempo from a linear fit over the longest run of consistently spaced beats."""
    ibi = np.diff(beats)
    med = np.median(ibi)
    ok = np.abs(ibi / med - 1) <= 0.15
    best, cur, best_rng, s = 0, 0, (0, 1), 0
    for i, v in enumerate(ok):
        if v:
            cur += 1
            if cur > best:
                best, best_rng = cur, (s, i + 1)
        else:
            cur, s = 0, i + 1
    seg = beats[best_rng[0] : best_rng[1] + 1]
    slope = np.polyfit(np.arange(len(seg)), seg, 1)[0]
    return 60.0 / slope


def load_gt(path: str) -> dict:
    with open(path) as f:
        gt = json.load(f)
    beats = np.array(gt["beats"], dtype=float)
    downbeats = np.array(gt["downbeats"], dtype=float)
    if gt["source"] != "synthetic":
        beats = dequantize(beats)
        if len(downbeats):  # move each downbeat onto its de-quantized beat
            idx = np.abs(beats[None, :] - downbeats[:, None]).argmin(axis=1)
            downbeats = beats[idx]
    bpm = gt.get("bpm") or gt_tempo(beats)
    # Extrapolate the grid 8 beats past both ends (local spacing) so loops that start in a
    # pickup/intro before the first annotated beat are graded against the implied grid.
    if len(beats) >= 2:
        head = beats[0] - np.arange(8, 0, -1) * (beats[1] - beats[0])
        tail = beats[-1] + np.arange(1, 9) * (beats[-1] - beats[-2])
        beats = np.concatenate([head, beats, tail])
    return {"beats": beats, "downbeats": downbeats, "bpm": float(bpm), "source": gt["source"]}


# --------------------------------- metrics -----------------------------------
def grade_loop(start: float, loop_dur: float, gt: dict) -> dict:
    b = gt["beats"]
    j = int(np.argmin(np.abs(b - start)))
    start_off = start - b[j]
    lo, hi = max(0, j - 2), min(len(b) - 1, j + 18)
    local_ibi = float(np.median(np.diff(b[lo : hi + 1]))) if hi > lo else 60.0 / gt["bpm"]
    n = int(round(loop_dur / local_ibi))
    slip = loop_dur - (b[j + n] - b[j]) if j + n < len(b) else float("nan")
    end = start + loop_dur
    end_off = end - b[int(np.argmin(np.abs(b - end)))]
    db = gt["downbeats"]
    on_db = bool(len(db) and np.min(np.abs(db - start)) <= DOWNBEAT_TOL_S)
    return {
        "start_off_ms": round(1000 * start_off, 1),
        "end_off_ms": round(1000 * end_off, 1),
        "slip_ms": round(1000 * slip, 1) if np.isfinite(slip) else None,
        "start_off_beats": round(start_off / local_ibi, 3),
        "on_downbeat": on_db,
    }


def summarize(loops: list[dict]) -> dict:
    so = np.abs([lp["start_off_ms"] for lp in loops])
    sl = np.abs([lp["slip_ms"] for lp in loops if lp["slip_ms"] is not None])
    return {
        "n": len(loops),
        "start_abs_med_ms": round(float(np.median(so)), 1),
        "start_abs_max_ms": round(float(np.max(so)), 1),
        "within_30ms_pct": round(100 * float(np.mean(so <= 30)), 0),
        "within_50ms_pct": round(100 * float(np.mean(so <= 50)), 0),
        "slip_abs_mean_ms": round(float(np.mean(sl)), 1) if len(sl) else None,
        "slip_abs_max_ms": round(float(np.max(sl)), 1) if len(sl) else None,
        "on_downbeat_pct": round(100 * float(np.mean([lp["on_downbeat"] for lp in loops])), 0),
    }


def octave_relation(bpm: float, gt_bpm: float) -> tuple[str, float]:
    """('1x'|'2x'|'0.5x'|..., % error vs the nearest metrical level)."""
    best = min((2.0**k for k in (-1, 0, 1)), key=lambda r: abs(bpm / gt_bpm - r))
    for r, lbl in ((0.5, "0.5x"), (1.0, "1x"), (2.0, "2x"), (1.5, "1.5x"), (2 / 3, "0.67x")):
        if abs(bpm / gt_bpm / r - 1) < 0.03:
            return lbl, round(100 * (bpm / (gt_bpm * best) - 1), 3)
    return "other", round(100 * (bpm / (gt_bpm * best) - 1), 3)


# --------------------------------- runner ------------------------------------
def discover(data: str) -> list[dict]:
    cases = []
    for wav in sorted(glob.glob(os.path.join(data, "synth", "*.wav"))):
        name = os.path.basename(wav)[:-4]
        cases.append({"name": name, "ref": wav, "ref_kind": "synth", "gt": wav[:-4] + ".gt.json"})
    for gtp in sorted(glob.glob(os.path.join(data, "audio", "*.beatthis.json"))):
        name = os.path.basename(gtp)[: -len(".beatthis.json")]
        mix = next(
            iter(
                glob.glob(os.path.join(data, "audio", name + ".mp3"))
                + glob.glob(os.path.join(data, "audio", name + ".wav"))
            ),
            None,
        )
        drums = os.path.join(data, "stems", f"{name}.drums.wav")
        if os.path.exists(drums):
            cases.append({"name": name, "ref": drums, "ref_kind": "drums", "gt": gtp})
        if mix:
            cases.append({"name": name, "ref": mix, "ref_kind": "mix", "gt": gtp})
    return cases


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker-src", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--bars", type=int, nargs="+", default=[1, 2, 4])
    ap.add_argument("--only", nargs="*", help="substring filter on track names")
    args = ap.parse_args()

    sys.path.insert(0, os.path.abspath(args.worker_src))
    from worker import pipeline

    pipeline._update_job_tags = lambda *a, **k: None  # no DB in the harness

    results = {"label": args.label, "cases": []}
    for case in discover(args.data):
        if args.only and not any(s in case["name"] for s in args.only):
            continue
        gt = load_gt(case["gt"])
        for bars in args.bars:
            t0 = time.perf_counter()
            loops, tags, seg_label, _ = pipeline.extract_and_tag(
                "eval", {"drums": case["ref"]}, ["drums"], bars
            )
            elapsed = time.perf_counter() - t0
            bpm = float(tags["bpm"])
            loop_dur = bars * 4 * 60.0 / bpm
            graded = []
            for lp in loops:
                g = grade_loop(lp["start_sec"], loop_dur, gt)
                g["start_sec"] = round(lp["start_sec"], 4)
                g["section"] = seg_label.get((lp["start_sec"], lp["end_sec"]))
                g["samples"] = int(lp["audio"].shape[-1])
                graded.append(g)
            rel, err = octave_relation(bpm, gt["bpm"])
            row = {
                **case,
                "bars": bars,
                "bpm": bpm,
                "key": tags["musical_key"],
                "gt_bpm": round(gt["bpm"], 3),
                "gt_source": gt["source"],
                "tempo_rel": rel,
                "tempo_err_pct": err,
                "seconds": round(elapsed, 2),
                "summary": summarize(graded) if graded else None,
                "loops": graded,
            }
            results["cases"].append(row)
            s = row["summary"] or {}
            print(
                f"{case['name']:28s} {case['ref_kind']:5s} {bars}bar bpm={bpm:7.2f} "
                f"gt={gt['bpm']:7.2f} {rel:4s} err={err:+.2f}% n={s.get('n')} "
                f"|start| med={s.get('start_abs_med_ms')} max={s.get('start_abs_max_ms')} "
                f"<=30ms={s.get('within_30ms_pct')}% slip={s.get('slip_abs_mean_ms')} "
                f"db={s.get('on_downbeat_pct')}% t={elapsed:.1f}s",
                flush=True,
            )
    with open(args.out, "w") as f:
        json.dump(results, f, indent=1)


if __name__ == "__main__":
    main()
