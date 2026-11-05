"""Linear-chain CRF decoder for ChordNet 2E1D (PR-Y1.5c).

Thin wrapper around `torchcrf.CRF` (`pytorch-crf >= 0.7.2`, MIT) that gives us
a stable, repo-owned API surface (`.forward`, `.decode`, `.transitions`) so
future call-sites don't need to depend on the upstream package's naming.

## Why a CRF here

`claude/phase-2-y1-chord-model-decision.md` v1.3 §Architecture called for a
"linear CRF or HMM smoothing + JS-side Viterbi fallback (H-3); beat-
synchronous via existing beat tracker." PR #77 shipped ChordNet 2E1D
with a simple per-frame linear classifier (argmax at decode time). PR #79
added a browser-side Viterbi fallback. This module adds the CRF **training
objective** so the per-frame logits head learns transition-aware emissions,
and exposes the learned (num_tags, num_tags) transition matrix so the
browser-side Viterbi can smooth decoding with the trained prior.

## Pre-mortem H-3 strategy (`claude/phase-2-y1-chord-model-premortem.md`)

The #1 failure mode flagged was "CRF ONNX export fails". The forward-backward
algorithm (used only at training time) is intricate and does not need to
export to ONNX. The Viterbi decode (used at inference time) is the ONLY
piece a browser needs, and PR #79 already ships a hand-rolled JS Viterbi.
So we train with the CRF objective, then export:

    1. Per-frame emissions (flat-170 logits collapsed to 62) → ONNX (PR #77).
    2. Transition matrix (62, 62)                              → JSON (this PR).

The browser loads both and runs Viterbi. The CRF layer itself never leaves
Python.

## License

`pytorch-crf` is distributed under the MIT License (see the dist-info
`LICENSE.txt`; the project's PyPI metadata also declares MIT). Adding it is
license-compatible with this repo. The PR-Y1.5c spec mis-cited this as
Apache-2.0; the dependency we actually add is MIT — strictly less
restrictive. The attribution lives in ``apps/training/DATA-PROVENANCE.md``.
"""

from __future__ import annotations

import torch
import torch.nn as nn
from torchcrf import CRF


class CRFLayer(nn.Module):
    """Linear-chain Conditional Random Field over a fixed tag alphabet.

    Args:
        num_tags: Number of output tags (62 for the Y1 chord alphabet).
        batch_first: If True, inputs are ``(batch, seq_len, num_tags)``.

    Attributes:
        transitions: ``(num_tags, num_tags)`` learnable transition matrix.
            ``transitions[i, j]`` is the unnormalised score for transitioning
            from tag ``i`` to tag ``j`` in log-prob units.
        start_transitions: ``(num_tags,)`` learnable start-of-sequence scores.
        end_transitions: ``(num_tags,)`` learnable end-of-sequence scores.
    """

    def __init__(self, num_tags: int, batch_first: bool = True) -> None:
        super().__init__()
        if num_tags < 2:
            raise ValueError(f"num_tags must be >= 2, got {num_tags}")
        self.num_tags = num_tags
        self.batch_first = batch_first
        self._crf = CRF(num_tags=num_tags, batch_first=batch_first)

    # Expose the inner CRF's parameters as attributes so call-sites can
    # read / regularise them without reaching into `_crf`.
    @property
    def transitions(self) -> nn.Parameter:
        """Learned transition matrix ``(num_tags, num_tags)``."""
        return self._crf.transitions

    @property
    def start_transitions(self) -> nn.Parameter:
        """Learned start-of-sequence scores ``(num_tags,)``."""
        return self._crf.start_transitions

    @property
    def end_transitions(self) -> nn.Parameter:
        """Learned end-of-sequence scores ``(num_tags,)``."""
        return self._crf.end_transitions

    # ------------------------------------------------------------------
    # Log-likelihood (training-time)
    # ------------------------------------------------------------------

    def log_likelihood(
        self,
        emissions: torch.Tensor,
        tags: torch.Tensor,
        mask: torch.Tensor | None = None,
        reduction: str = "token_mean",
    ) -> torch.Tensor:
        """Compute the log-likelihood of ``tags`` under the CRF.

        Args:
            emissions: ``(batch, seq_len, num_tags)`` (if ``batch_first``) of
                per-frame emission scores (log-probs or raw logits — the CRF
                is invariant to an additive constant per-frame).
            tags: ``(batch, seq_len)`` integer tag indices in ``[0, num_tags)``.
            mask: ``(batch, seq_len)`` bool tensor; True for real frames,
                False for padding. If None, all frames are considered real.
            reduction: one of ``"sum"``, ``"mean"``, ``"token_mean"``, ``"none"``.
                Default ``"token_mean"`` averages over unmasked tokens so the
                scale is comparable to a per-frame cross-entropy.

        Returns:
            Scalar log-likelihood (or ``(batch,)`` if ``reduction="none"``).
            Negate it to get a loss.
        """
        if emissions.dim() != 3:
            raise ValueError(
                f"emissions must be 3D (batch, seq, num_tags); got shape {tuple(emissions.shape)}"
            )
        if emissions.shape[-1] != self.num_tags:
            raise ValueError(
                f"emissions last dim must be {self.num_tags}; got {emissions.shape[-1]}"
            )

        # torchcrf accepts uint8 or bool masks — coerce bool → uint8 for the
        # inner API compatibility across torchcrf versions.
        if mask is not None and mask.dtype != torch.bool:
            mask = mask.bool()

        return self._crf(emissions, tags, mask=mask, reduction=reduction)

    # Convenience alias matching the spec's "forward produces log-likelihood".
    def forward(
        self,
        emissions: torch.Tensor,
        tags: torch.Tensor,
        mask: torch.Tensor | None = None,
        reduction: str = "token_mean",
    ) -> torch.Tensor:
        return self.log_likelihood(emissions, tags, mask=mask, reduction=reduction)

    # ------------------------------------------------------------------
    # Viterbi decode (inference-time)
    # ------------------------------------------------------------------

    def decode(
        self,
        emissions: torch.Tensor,
        mask: torch.Tensor | None = None,
    ) -> list[list[int]]:
        """Run Viterbi and return the best tag sequence per batch element.

        Args:
            emissions: ``(batch, seq_len, num_tags)`` emissions.
            mask: ``(batch, seq_len)`` bool mask (optional).

        Returns:
            List of ``batch`` lists, each of length = that sequence's
            unmasked length. Values are integer tag indices in ``[0, num_tags)``.
        """
        if emissions.dim() != 3:
            raise ValueError(
                f"emissions must be 3D (batch, seq, num_tags); got shape {tuple(emissions.shape)}"
            )
        if emissions.shape[-1] != self.num_tags:
            raise ValueError(
                f"emissions last dim must be {self.num_tags}; got {emissions.shape[-1]}"
            )
        if mask is not None and mask.dtype != torch.bool:
            mask = mask.bool()
        return self._crf.decode(emissions, mask=mask)


__all__ = ["CRFLayer"]
