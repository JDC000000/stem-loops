#!/usr/bin/env python3
"""Regenerate tests/fixtures/btc/reference_logits.json from the ORIGINAL PyTorch BTC code.

Dev-only (needs torch + a checkout of github.com/jayg996/BTC-ISMIR19 at 2682317; neither is a
worker dependency). Seeded random weights of the real shapes are loaded into the reference
``BTC_model`` (large vocabulary) and run on a seeded random 2-window input; the fixture keeps
the argmax per frame and the first 8 logits per frame. ``test_chord_btc.py`` feeds the SAME
seeded weights/input to the NumPy port and compares, so the port is checked against torch in
CI without torch or the real weights.

    python scripts/btc_reference_fixture.py /path/to/BTC-ISMIR19 tests/fixtures/btc/reference_logits.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from btc_reference_params import random_params, random_windows  # noqa: E402


def main(repo: str, out: str) -> None:
    np.float = float  # the BTC repo uses the removed alias
    sys.path.insert(0, repo)
    import torch  # noqa: PLC0415
    import yaml  # noqa: PLC0415
    from btc_model import BTC_model  # noqa: PLC0415

    cfg = yaml.safe_load((Path(repo) / "run_config.yaml").read_text())["model"]
    cfg["num_chords"] = 170
    model = BTC_model(config=cfg).eval()
    params = random_params()
    state = model.state_dict()
    for name in state:
        if name in params:
            state[name] = torch.tensor(params[name])
    model.load_state_dict(state)
    x = torch.tensor(random_windows())
    with torch.no_grad():
        h, _ = model.self_attn_layers(x)
        logits = model.output_layer.output_projection(h).numpy()
    Path(out).write_text(
        json.dumps(
            {
                "source": "BTC-ISMIR19@2682317 btc_model.BTC_model (torch), seeded params",
                "argmax": logits.argmax(-1).tolist(),
                "logits_first8": np.round(logits[..., :8], 5).tolist(),
            }
        )
    )


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
