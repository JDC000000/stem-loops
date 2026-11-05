#!/usr/bin/env bash
# Kick off one Y1 chord-model training run on Modal.
#
# Usage:
#   ./scripts/modal_train.sh [--gpu l4|a10|a100-40|a100-80] [--epochs N] [--seed N]
#   ./scripts/modal_train.sh --help
#
# Prereqs:
#   - `pip install modal>=0.65` (see apps/training/pyproject.toml)
#   - `modal setup` once per workstation to authenticate
#
# What it does:
#   Runs apps/training/modal_app.py::train_chordnet on the configured GPU.
#   Checkpoints land on the shared `chordnet-data` Modal Volume at
#   /data/checkpoints/; pull them locally with `modal volume get`.
#
# Expected cost (Modal pricing 2026-11-04 — see apps/training/MODAL_BILLING.md):
#   L4        ~$0.80/h  →  1-4 h/run →  $0.80-$3.20/run  →  5-10 runs $5-$32
#   A10       ~$1.10/h  →  1-4 h/run →  $1.10-$4.40/run  →  5-10 runs $7-$44
#   A100-40   ~$2.10/h  →  1-4 h/run →  $2.10-$8.40/run  →  5-10 runs $14-$84
#
# The $30/mo Starter credit covers a full L4 wave in most months.

set -euo pipefail

usage() {
    sed -n '1,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//;s/^#$//' | head -n -1
    exit "${1:-0}"
}

GPU="l4"
EPOCHS=30
SEED=42
CONFIG="configs/chordnet_2e1d_v1.yaml"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --gpu)
            GPU="${2:-}"
            shift 2
            ;;
        --epochs)
            EPOCHS="${2:-}"
            shift 2
            ;;
        --seed)
            SEED="${2:-}"
            shift 2
            ;;
        --config)
            CONFIG="${2:-}"
            shift 2
            ;;
        -h|--help)
            usage 0
            ;;
        *)
            echo "unknown arg: $1" >&2
            usage 1
            ;;
    esac
done

# Validate GPU shorthand → canonical Modal name.
case "$GPU" in
    l4|L4) MODAL_GPU="L4" ;;
    a10|A10) MODAL_GPU="A10" ;;
    a100-40|A100-40) MODAL_GPU="A100-40GB" ;;
    a100-80|A100-80) MODAL_GPU="A100-80GB" ;;
    *)
        echo "unsupported --gpu value: $GPU (allowed: l4, a10, a100-40, a100-80)" >&2
        exit 2
        ;;
esac

# modal CLI must exist.
if ! command -v modal >/dev/null 2>&1; then
    echo "modal CLI not found on PATH; run \`pip install 'modal>=0.65' && modal setup\`" >&2
    exit 3
fi

# Dispatch. We pass --gpu as a hint through the CLI; the canonical GPU is set
# in modal_app.py's @app.function decorator. Switching GPUs permanently means
# editing that decorator — see apps/training/MODAL_SETUP.md §3.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[modal_train] gpu=$MODAL_GPU epochs=$EPOCHS seed=$SEED config=$CONFIG"
exec modal run apps/training/modal_app.py::train_chordnet \
    --config-path "$CONFIG" \
    --epochs "$EPOCHS" \
    --seed "$SEED"
