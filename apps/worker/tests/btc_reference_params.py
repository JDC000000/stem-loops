"""Seeded random BTC parameters + input shared by test_chord_btc.py and
scripts/btc_reference_fixture.py (the torch-side generator). Keep both in step."""

from __future__ import annotations

import numpy as np

H, F, C, L = 128, 144, 170, 8


def random_params(seed: int = 1234) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)

    def w(*shape: int, scale: float = 0.08) -> np.ndarray:
        return (rng.standard_normal(shape) * scale).astype(np.float32)

    pre = "self_attn_layers."
    p = {pre + "embedding_proj.weight": w(H, F)}
    for i in range(L):
        li = f"{pre}self_attn_layers.{i}."
        for blk in ("attn_block", "backward_attn_block"):
            b = f"{li}{blk}."
            for lin in ("query", "key", "value", "output"):
                p[f"{b}multi_head_attention.{lin}_linear.weight"] = w(H, H)
            for c in (0, 1):
                p[f"{b}positionwise_convolution.layers.{c}.conv.weight"] = w(H, H, 3)
                p[f"{b}positionwise_convolution.layers.{c}.conv.bias"] = w(H)
            for ln in ("layer_norm_mha", "layer_norm_ffn"):
                p[f"{b}{ln}.gamma"] = (1.0 + w(H)).astype(np.float32)
                p[f"{b}{ln}.beta"] = w(H)
        p[li + "linear.weight"] = w(H, 2 * H)
        p[li + "linear.bias"] = w(H)
    p[pre + "layer_norm.gamma"] = (1.0 + w(H)).astype(np.float32)
    p[pre + "layer_norm.beta"] = w(H)
    p["output_layer.output_projection.weight"] = w(C, H, scale=0.3)
    p["output_layer.output_projection.bias"] = w(C)
    return p


def random_windows(seed: int = 99) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.standard_normal((2, 108, F)).astype(np.float32)
