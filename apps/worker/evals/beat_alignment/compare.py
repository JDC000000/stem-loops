"""Before/after markdown table from two run_eval.py result files.

    python compare.py results-before.json results-after.json [--exclude NAME ...]

Tracks named with --exclude are listed but left out of the pooled totals (use it for
tracks whose reference beats are unreliable, e.g. no steady pulse).
"""

from __future__ import annotations

import argparse
import json

import numpy as np


def _index(path: str) -> dict:
    with open(path) as f:
        res = json.load(f)
    return {(c["name"], c["ref_kind"], c["bars"]): c for c in res["cases"]}


def _loops(cases: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    starts = np.array([abs(lp["start_off_ms"]) for c in cases for lp in c["loops"]])
    slips = np.array(
        [
            abs(lp["slip_ms"] / c["bars"])
            for c in cases
            for lp in c["loops"]
            if lp["slip_ms"] is not None
        ]
    )
    return starts, slips


def _cell(cases: list[dict]) -> str:
    starts, slips = _loops(cases)
    if not len(starts):
        return "–"
    return (
        f"{np.median(starts):.0f} / {np.max(starts):.0f} ms, "
        f"{100 * np.mean(starts <= 30):.0f}% ≤30 ms; slip {np.mean(slips):.1f} ms/bar"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("before")
    ap.add_argument("after")
    ap.add_argument("--exclude", nargs="*", default=[])
    args = ap.parse_args()
    before, after = _index(args.before), _index(args.after)
    keys = sorted({(n, r) for n, r, _ in after})

    print(
        "| Track | ref | GT BPM | BPM before → after | tempo err before → after | "
        "loop start |offset| median / max, ≤30 ms; repeat slip — BEFORE | … AFTER |"
    )
    print("|---|---|---|---|---|---|---|")
    pooled = {"before": [], "after": []}
    for name, ref in keys:
        b = [before[k] for k in before if k[:2] == (name, ref)]
        a = [after[k] for k in after if k[:2] == (name, ref)]
        if not a or not b:
            continue
        if name not in args.exclude:
            pooled["before"] += b
            pooled["after"] += a
        flag = " (excluded: unreliable GT)" if name in args.exclude else ""
        print(
            f"| {name}{flag} | {ref} | {a[0]['gt_bpm']:.2f} | {b[0]['bpm']:.2f} → {a[0]['bpm']:.2f} | "
            f"{b[0]['tempo_rel']} {b[0]['tempo_err_pct']:+.2f}% → {a[0]['tempo_rel']} "
            f"{a[0]['tempo_err_pct']:+.2f}% | {_cell(b)} | {_cell(a)} |"
        )
    for label in ("before", "after"):
        starts, slips = _loops(pooled[label])
        if len(starts):
            print(
                f"\n**Pooled {label}** ({len(starts)} loops, 1/2/4-bar): |start offset| median "
                f"{np.median(starts):.1f} ms, p90 {np.percentile(starts, 90):.1f} ms, max "
                f"{np.max(starts):.1f} ms; ≤30 ms {100 * np.mean(starts <= 30):.0f}%, ≤50 ms "
                f"{100 * np.mean(starts <= 50):.0f}%; slip mean {np.mean(slips):.2f} ms/bar, max "
                f"{np.max(slips):.2f} ms/bar"
            )


if __name__ == "__main__":
    main()
