#!/usr/bin/env python3
"""Quick Modal cost estimator for Y1 chord-model training.

Prints an estimate for a given GPU type, run duration, and run count. Numbers
come from the Modal pricing page fetched 2026-11-04; the authoritative copy
lives in `apps/training/MODAL_BILLING.md`. Re-run that doc's refresh
procedure before trusting this calculator for a new wave.

Example:
    $ python scripts/modal_cost_estimate.py --gpu l4 --hours 4 --runs 10
    Modal cost estimate (prices fetched 2026-11-04)
      GPU:              L4 @ $0.80/h
      Duration/run:     4.00 h
      Runs:             10
      ---
      Compute:          $32.00
      Egress (est):     $0.08  (10 × 200 MB checkpoint pulls @ $0.04/GiB)
      Storage (est):    $0.00  (<50 GiB fits inside 1 TiB/mo free band)
      ---
      Total:            $32.08
      After $30 Starter credit: $2.08
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass

PRICING_FETCHED = "2026-11-04"

# $/hour, derived from the per-second rates on Modal's pricing page
# (2026-11-04). L4 $0.000222/s × 3600 = $0.80/h, etc. Rounded to four
# significant figures to match how the page itself quotes per-hour rates.
GPU_PRICE_PER_HOUR: dict[str, float] = {
    "l4": 0.80,
    "a10": 1.10,
    "a100-40": 2.10,
    "a100-80": 2.50,
}

GPU_DISPLAY: dict[str, str] = {
    "l4": "L4",
    "a10": "A10",
    "a100-40": "A100-40GB",
    "a100-80": "A100-80GB",
}

# Other pricing rails (2026-11-04).
EGRESS_PRICE_PER_GIB = 0.04
VOLUME_PRICE_PER_GIB_MO = 0.09
VOLUME_FREE_GIB_MO = 1024.0  # 1 TiB
STARTER_FREE_CREDIT_USD = 30.0

# Project assumptions — adjust as the training script firms up.
DEFAULT_CHECKPOINT_PULL_MB = 200.0  # one "best" checkpoint pulled per run
PROJECTED_VOLUME_FOOTPRINT_GIB = 50.0


@dataclass
class Estimate:
    gpu_key: str
    hours_per_run: float
    runs: int
    checkpoint_pull_mb: float

    @property
    def gpu_rate(self) -> float:
        return GPU_PRICE_PER_HOUR[self.gpu_key]

    @property
    def compute_usd(self) -> float:
        return self.gpu_rate * self.hours_per_run * self.runs

    @property
    def egress_gib(self) -> float:
        return (self.checkpoint_pull_mb / 1024.0) * self.runs

    @property
    def egress_usd(self) -> float:
        return self.egress_gib * EGRESS_PRICE_PER_GIB

    @property
    def storage_usd(self) -> float:
        billable = max(0.0, PROJECTED_VOLUME_FOOTPRINT_GIB - VOLUME_FREE_GIB_MO)
        return billable * VOLUME_PRICE_PER_GIB_MO

    @property
    def total_usd(self) -> float:
        return self.compute_usd + self.egress_usd + self.storage_usd

    @property
    def net_after_credit_usd(self) -> float:
        return max(0.0, self.total_usd - STARTER_FREE_CREDIT_USD)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument(
        "--gpu",
        default="l4",
        choices=sorted(GPU_PRICE_PER_HOUR),
        help="GPU shorthand (default: l4)",
    )
    p.add_argument(
        "--hours",
        type=float,
        default=2.0,
        help="Wall-clock hours per run (default: 2.0)",
    )
    p.add_argument(
        "--runs",
        type=int,
        default=1,
        help="Number of runs in the wave (default: 1)",
    )
    p.add_argument(
        "--checkpoint-mb",
        type=float,
        default=DEFAULT_CHECKPOINT_PULL_MB,
        help=f"Checkpoint size in MB pulled per run (default: {DEFAULT_CHECKPOINT_PULL_MB})",
    )
    return p.parse_args(argv)


def render(est: Estimate) -> str:
    gpu_display = GPU_DISPLAY[est.gpu_key]
    lines = [
        f"Modal cost estimate (prices fetched {PRICING_FETCHED})",
        f"  GPU:              {gpu_display} @ ${est.gpu_rate:.2f}/h",
        f"  Duration/run:     {est.hours_per_run:.2f} h",
        f"  Runs:             {est.runs}",
        "  ---",
        f"  Compute:          ${est.compute_usd:.2f}",
        (
            f"  Egress (est):     ${est.egress_usd:.2f}  "
            f"({est.runs} × {est.checkpoint_pull_mb:.0f} MB checkpoint pulls "
            f"@ ${EGRESS_PRICE_PER_GIB:.2f}/GiB)"
        ),
        (
            f"  Storage (est):    ${est.storage_usd:.2f}  "
            f"(<{PROJECTED_VOLUME_FOOTPRINT_GIB:.0f} GiB fits inside "
            f"{VOLUME_FREE_GIB_MO / 1024:.0f} TiB/mo free band)"
        ),
        "  ---",
        f"  Total:            ${est.total_usd:.2f}",
        f"  After ${STARTER_FREE_CREDIT_USD:.0f} Starter credit: ${est.net_after_credit_usd:.2f}",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    est = Estimate(
        gpu_key=args.gpu,
        hours_per_run=args.hours,
        runs=args.runs,
        checkpoint_pull_mb=args.checkpoint_mb,
    )
    print(render(est))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
