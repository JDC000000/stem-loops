"""End-to-end tests for the CRF transition-export CLI (PR-Y1.5c).

Trains a 3-step CRF ChordNet on tiny synthetic data, saves a checkpoint, then
runs ``export_crf_transitions`` and verifies the JSON matches the in-memory
transition matrix.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import torch

from training.export_crf_transitions import (
    export_from_checkpoint,
)
from training.export_crf_transitions import (
    main as export_main,
)
from training.model.alphabet import N_INDEX, NUM_LABELS
from training.model.chordnet_2e1d import CQT_N_BINS, ChordNet2E1D


def _mini_batch(batch: int, seq_len: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    cqt = torch.randn(batch, seq_len, CQT_N_BINS)
    labels = torch.randint(0, NUM_LABELS, (batch, seq_len))
    lengths = torch.full((batch,), seq_len, dtype=torch.long)
    return cqt, labels, lengths


def _save_crf_checkpoint(model: ChordNet2E1D, ckpt_path: Path) -> None:
    torch.save(
        {
            "model_state": model.state_dict(),
            "epoch": 1,
            "output_mode": "flat170",
            "use_crf": True,
            "alphabet_sha": model.alphabet_sha,
            "cqt_plan_version": model.cqt_plan_version,
            "val_metrics": {"majmin": 0.0, "sevenths": 0.0},
        },
        ckpt_path,
    )


# ---------------------------------------------------------------------------
# Train 3 steps → export → compare
# ---------------------------------------------------------------------------


def test_train_3_steps_export_transitions_matches_in_memory(tmp_path: Path) -> None:
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="flat170", use_crf=True)
    optim = torch.optim.AdamW(model.parameters(), lr=1e-3)

    for _step in range(3):
        cqt, labels, lengths = _mini_batch(batch=2, seq_len=12)
        logits = model(cqt)
        emissions = logits["crf_emissions"]
        mask = torch.arange(12).unsqueeze(0) < lengths.unsqueeze(-1)
        loss = -model.crf.log_likelihood(  # type: ignore[union-attr]
            emissions, labels, mask=mask, reduction="token_mean"
        )
        optim.zero_grad()
        loss.backward()
        optim.step()

    ckpt_path = tmp_path / "best.pt"
    _save_crf_checkpoint(model, ckpt_path)

    out_json = tmp_path / "chord-transitions.v1.json"
    payload = export_from_checkpoint(ckpt_path, out_json)
    assert out_json.exists()

    # Re-load JSON from disk → tensor → compare to the trained transitions.
    loaded = json.loads(out_json.read_text())
    exported = torch.tensor(loaded["transitions_log_prob"], dtype=torch.float32)
    assert torch.allclose(exported, model.crf.transitions.detach())  # type: ignore[union-attr]
    # Model hash is reproducible from the same state_dict.
    assert loaded["model_sha"] == payload["model_sha"]
    assert len(loaded["model_sha"]) == 64  # sha256 hex


# ---------------------------------------------------------------------------
# Refuses a non-CRF checkpoint
# ---------------------------------------------------------------------------


def test_export_refuses_non_crf_checkpoint(tmp_path: Path) -> None:
    model = ChordNet2E1D(output_mode="flat170", use_crf=False)
    ckpt_path = tmp_path / "best.pt"
    torch.save(
        {
            "model_state": model.state_dict(),
            "epoch": 1,
            "output_mode": "flat170",
            "use_crf": False,
            "alphabet_sha": model.alphabet_sha,
            "cqt_plan_version": model.cqt_plan_version,
            "val_metrics": {"majmin": 0.0, "sevenths": 0.0},
        },
        ckpt_path,
    )
    with pytest.raises(RuntimeError, match="was not trained with --use-crf"):
        export_from_checkpoint(ckpt_path, tmp_path / "x.json")


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------


def test_cli_exports_json_and_returns_zero(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    torch.manual_seed(0)
    model = ChordNet2E1D(output_mode="flat170", use_crf=True)
    ckpt_path = tmp_path / "best.pt"
    _save_crf_checkpoint(model, ckpt_path)
    out_json = tmp_path / "chord-transitions.v1.json"
    rc = export_main(
        [
            "--checkpoint",
            str(ckpt_path),
            "--out",
            str(out_json),
            "--version",
            "v1",
        ]
    )
    assert rc == 0
    assert out_json.exists()
    stdout = capsys.readouterr().out
    assert "wrote" in stdout
    assert "chord-transitions.v1.json" in stdout
    _ = N_INDEX  # ensure alphabet import stays live (smoke)
