"""CRFLayer unit tests (PR-Y1.5c).

Covers:

- Forward produces a scalar log-likelihood.
- Decode produces a path matching the tag count.
- Gradient flow reaches the transitions parameter.
- Known-answer: trivial 2-tag CRF with hand-set transitions.
"""

from __future__ import annotations

import pytest
import torch

from training.model.crf import CRFLayer

# ---------------------------------------------------------------------------
# Constructor validation
# ---------------------------------------------------------------------------


def test_crf_rejects_num_tags_below_two() -> None:
    with pytest.raises(ValueError, match="num_tags must be >= 2"):
        CRFLayer(num_tags=1)


# ---------------------------------------------------------------------------
# Forward → scalar log-likelihood
# ---------------------------------------------------------------------------


def test_crf_log_likelihood_is_scalar() -> None:
    torch.manual_seed(0)
    crf = CRFLayer(num_tags=5, batch_first=True)
    emissions = torch.randn(3, 10, 5)
    tags = torch.randint(0, 5, (3, 10))
    mask = torch.ones(3, 10, dtype=torch.bool)
    ll = crf(emissions, tags, mask=mask, reduction="token_mean")
    assert ll.dim() == 0
    assert torch.isfinite(ll)


def test_crf_log_likelihood_shape_validation() -> None:
    crf = CRFLayer(num_tags=5)
    with pytest.raises(ValueError, match="must be 3D"):
        crf(torch.randn(10, 5), torch.zeros(10, dtype=torch.long))
    with pytest.raises(ValueError, match="last dim must be 5"):
        crf(torch.randn(1, 4, 9), torch.zeros(1, 4, dtype=torch.long))


def test_crf_log_likelihood_masked_padding_only_counts_real_frames() -> None:
    """Padding frames must not change the log-likelihood (per-sequence sum)."""
    torch.manual_seed(1)
    crf = CRFLayer(num_tags=4)
    emissions = torch.randn(1, 6, 4)
    tags = torch.randint(0, 4, (1, 6))
    # Full-mask log-likelihood on the first 4 frames.
    short_em = emissions[:, :4, :]
    short_tags = tags[:, :4]
    short_mask = torch.ones(1, 4, dtype=torch.bool)
    ll_short = crf(short_em, short_tags, mask=short_mask, reduction="sum")
    # Padded-mask log-likelihood on 6 frames with last 2 masked out.
    padded_mask = torch.zeros(1, 6, dtype=torch.bool)
    padded_mask[:, :4] = True
    ll_padded = crf(emissions, tags, mask=padded_mask, reduction="sum")
    # They must agree: torchcrf excludes masked suffix frames from scoring.
    assert torch.allclose(ll_short, ll_padded, atol=1e-5)


# ---------------------------------------------------------------------------
# Decode → sequence lengths
# ---------------------------------------------------------------------------


def test_crf_decode_returns_path_per_batch_element() -> None:
    torch.manual_seed(0)
    crf = CRFLayer(num_tags=5)
    emissions = torch.randn(2, 8, 5)
    paths = crf.decode(emissions)
    assert len(paths) == 2
    for p in paths:
        assert len(p) == 8
        assert all(0 <= t < 5 for t in p)


def test_crf_decode_respects_mask_length() -> None:
    torch.manual_seed(0)
    crf = CRFLayer(num_tags=4)
    emissions = torch.randn(2, 10, 4)
    mask = torch.zeros(2, 10, dtype=torch.bool)
    mask[0, :7] = True
    mask[1, :10] = True
    paths = crf.decode(emissions, mask=mask)
    assert len(paths[0]) == 7
    assert len(paths[1]) == 10


# ---------------------------------------------------------------------------
# Gradient flow through transitions
# ---------------------------------------------------------------------------


def test_crf_transitions_receive_gradient() -> None:
    torch.manual_seed(0)
    crf = CRFLayer(num_tags=4)
    emissions = torch.randn(2, 8, 4, requires_grad=True)
    tags = torch.randint(0, 4, (2, 8))
    loss = -crf(emissions, tags)
    loss.backward()
    assert crf.transitions.grad is not None
    assert torch.isfinite(crf.transitions.grad).all()
    # Expect non-zero grad on at least one transition entry for random data.
    assert float(crf.transitions.grad.abs().sum().item()) > 0.0
    # Start/end transitions also trained.
    assert crf.start_transitions.grad is not None
    assert crf.end_transitions.grad is not None


def test_crf_training_lowers_loss_on_fixed_data() -> None:
    """Sanity check: a few optimiser steps reduce the NLL on a toy sequence."""
    torch.manual_seed(42)
    crf = CRFLayer(num_tags=3)
    emissions = torch.randn(4, 12, 3, requires_grad=False)
    tags = torch.randint(0, 3, (4, 12))
    optim = torch.optim.Adam(crf.parameters(), lr=0.1)
    losses: list[float] = []
    for _ in range(20):
        optim.zero_grad()
        loss = -crf(emissions, tags, reduction="token_mean")
        loss.backward()
        optim.step()
        losses.append(float(loss.item()))
    assert losses[-1] < losses[0] - 1e-3, f"loss did not fall: {losses[0]:.4f} -> {losses[-1]:.4f}"


# ---------------------------------------------------------------------------
# Known-answer: trivial 2-tag CRF with hand-set transitions
# ---------------------------------------------------------------------------


def test_crf_viterbi_prefers_sticky_tag_with_handset_transitions() -> None:
    """With a strong self-loop transition prior, Viterbi should smooth noise.

    Setup: 2-tag CRF where transitions[0,0] = transitions[1,1] = very large
    (strong self-loop) and transitions[0,1] = transitions[1,0] = very
    negative. Then an emission sequence that *wobbles* between tags
    should decode to the all-majority-tag path (whichever emits more).
    """
    torch.manual_seed(0)
    crf = CRFLayer(num_tags=2)
    with torch.no_grad():
        crf.transitions.copy_(torch.tensor([[10.0, -10.0], [-10.0, 10.0]]))
        crf.start_transitions.zero_()
        crf.end_transitions.zero_()
    # Emissions slightly favour tag 0 in most frames, but with wobble.
    emissions = torch.tensor(
        [
            [
                [+0.5, -0.5],  # prefers 0
                [-0.3, +0.3],  # prefers 1 (noise)
                [+0.5, -0.5],  # prefers 0
                [-0.2, +0.2],  # prefers 1 (noise)
                [+0.5, -0.5],  # prefers 0
                [+0.5, -0.5],  # prefers 0
            ]
        ]
    )
    paths = crf.decode(emissions)
    # With the sticky transitions dominating, the Viterbi path should be
    # the constant "all zeros" (the majority emission).
    assert paths == [[0, 0, 0, 0, 0, 0]]


def test_crf_viterbi_matches_argmax_when_transitions_are_uniform() -> None:
    """With zero (uniform) transitions, Viterbi reduces to per-frame argmax."""
    torch.manual_seed(0)
    crf = CRFLayer(num_tags=3)
    with torch.no_grad():
        crf.transitions.zero_()
        crf.start_transitions.zero_()
        crf.end_transitions.zero_()
    emissions = torch.randn(1, 15, 3) * 5.0  # large margins so argmax is confident
    argmax_path = emissions.argmax(dim=-1).squeeze(0).tolist()
    viterbi_path = crf.decode(emissions)[0]
    assert argmax_path == viterbi_path
