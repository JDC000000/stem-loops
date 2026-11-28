"""The 4 Schubert Winterreise Dataset (SWD) rows of the chord-eval manifest.

Audio is referenced by a pinned synctoolbox URL + sha256 (never committed); the ChoCo-derived
ground truth is committed under tests/fixtures/swd/. These tests need no network: they check
the manifest loads, each ground_truth_lab parses, and every recorded sha256 matches.
"""

from __future__ import annotations

import hashlib
import json
import re
from contextlib import contextmanager
from pathlib import Path

import pytest

from tests.test_chord_eval import _require_mir_eval
from worker import chord_eval

FIXTURES = Path(__file__).resolve().parent / "fixtures"
VERIFICATION = FIXTURES / "chord_eval_songs.verification.json"
SYNCTOOLBOX = "49b1f128c719883e0b007f5948efde985445199f"
CHOCO = "5fe168fd55be5c84512abcfbc4e6f1b1f8f0092a"
RECORDINGS = ("D911-01_HU33", "D911-01_SC06", "D911-03_HU33", "D911-03_SC06")
_LAB_ROW = re.compile(r"^(\d+\.\d{6})\t(\d+\.\d{6})\t(N|X|[A-G][#b]?(:[^\t/]+)?(/[#b]*\d+)?)$")


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _swd_rows() -> list[dict]:
    return [r for r in chord_eval._load_manifest(chord_eval.MANIFEST_PATH) if _is_swd(r)]


def _is_swd(row: dict) -> bool:
    return row["fma_id_or_jamendo_id"].startswith("swd-")


def _verification() -> dict[str, dict]:
    entries = json.loads(VERIFICATION.read_text(encoding="utf-8"))["entries"]
    return {e["fma_id_or_jamendo_id"]: e for e in entries if _is_swd(e)}


def test_manifest_loads_with_the_four_swd_rows():
    rows = _swd_rows()
    assert [r["fma_id_or_jamendo_id"] for r in rows] == [
        "swd-schubert-" + rec.lower().replace("_", "-") for rec in RECORDINGS
    ]
    for row, rec in zip(rows, RECORDINGS, strict=True):
        assert row["url"] == (
            f"https://raw.githubusercontent.com/meinardmueller/synctoolbox/{SYNCTOOLBOX}"
            f"/data_music/Schubert_{rec}.wav"
        )
        assert re.fullmatch(r"[0-9a-f]{64}", row["audio_sha256"])
        assert row["ground_truth_lab"] == f"tests/fixtures/swd/Schubert_{rec}.lab"
        assert row["genre"] == "classical"
        assert row["duration_sec"] > 0
        assert f"ChoCo @{CHOCO[:7]}" in row["ground_truth_source"]


def test_each_ground_truth_lab_parses_and_fits_the_audio():
    for row in _swd_rows():
        path = chord_eval.resolve_ground_truth(row["ground_truth_lab"])
        assert path.is_file(), path
        lines = path.read_text(encoding="utf-8").splitlines()
        assert len(lines) >= 50
        prev_end = 0.0
        for line in lines:
            m = _LAB_ROW.match(line)
            assert m, line
            start, end = float(m.group(1)), float(m.group(2))
            assert end > start >= prev_end - 1e-9, line
            prev_end = end
        assert prev_end <= row["duration_sec"] + 0.5


def test_each_ground_truth_lab_parses_with_mir_eval():
    _require_mir_eval()
    from mir_eval import chord  # noqa: PLC0415
    from mir_eval.io import load_labeled_intervals  # noqa: PLC0415

    for row in _swd_rows():
        intervals, labels = load_labeled_intervals(
            str(chord_eval.resolve_ground_truth(row["ground_truth_lab"]))
        )
        assert len(intervals) == len(labels) > 0
        for label in labels:
            chord.encode(label)  # raises on a label mir_eval cannot score


def test_sha256_values_match_files_and_verification_record():
    ver = _verification()
    assert len(ver) == 4
    for row in _swd_rows():
        lab = chord_eval.resolve_ground_truth(row["ground_truth_lab"])
        entry = ver[row["fma_id_or_jamendo_id"]]
        assert _sha(lab) == row["ground_truth_sha256"] == entry["ground_truth_lab"]["sha256"]
        assert entry["ground_truth_lab"]["path"] == "apps/worker/" + row["ground_truth_lab"]
        assert entry["audio_source"]["sha256"] == row["audio_sha256"]
        assert entry["audio_source"]["commit"] == SYNCTOOLBOX
        assert entry["ground_truth_source"]["commit"] == CHOCO
        assert entry["url"] == row["url"]
        cached = chord_eval.DEFAULT_CACHE_DIR / f"{row['fma_id_or_jamendo_id']}.audio"
        if cached.exists():  # only on a box that fetched it; never fetched here
            assert _sha(cached) == row["audio_sha256"]


def test_relative_ground_truth_resolves_under_apps_worker(tmp_path):
    rel = chord_eval.resolve_ground_truth("tests/fixtures/swd/x.lab")
    assert rel == chord_eval._REPO_WORKER_ROOT / "tests/fixtures/swd/x.lab"
    assert chord_eval.resolve_ground_truth(str(tmp_path / "a.lab")) == tmp_path / "a.lab"


class _FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def raise_for_status(self):
        return None

    def iter_bytes(self, _n):
        yield self._body


def _fake_stream(body: bytes):
    @contextmanager
    def stream(*_a, **_k):
        yield _FakeResponse(body)

    return stream


@pytest.mark.parametrize("matches", [True, False])
def test_download_checks_audio_sha256(tmp_path, monkeypatch, matches):
    import httpx  # noqa: PLC0415

    body = b"RIFF-not-really-audio"
    monkeypatch.setenv("CHORD_EVAL_FETCH", "1")
    monkeypatch.setattr(httpx, "stream", _fake_stream(body))
    digest = hashlib.sha256(body).hexdigest() if matches else "0" * 64
    row = {"fma_id_or_jamendo_id": "swd-x", "url": "https://example.invalid/x.wav"}
    row["audio_sha256"] = digest
    target = tmp_path / "swd-x.audio"
    if matches:
        assert chord_eval._download_if_missing(row, tmp_path) == target
        assert target.read_bytes() == body
    else:
        with pytest.raises(ValueError, match="audio_sha256 mismatch"):
            chord_eval._download_if_missing(row, tmp_path)
        assert not target.exists()
        assert not (tmp_path / "swd-x.part").exists()


def test_run_eval_resolves_a_relative_ground_truth_lab(tmp_path, monkeypatch):
    """run_eval must use resolve_ground_truth: a relative lab is found from any cwd."""
    _require_mir_eval()
    from types import SimpleNamespace  # noqa: PLC0415

    monkeypatch.delenv("CHORD_EVAL_FETCH", raising=False)
    monkeypatch.chdir(tmp_path)  # NOT apps/worker
    row = _swd_rows()[3]
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "song.audio").write_bytes(b"")
    lab = chord_eval.resolve_ground_truth(row["ground_truth_lab"])
    segs = [ln.split("\t") for ln in lab.read_text(encoding="utf-8").splitlines()]

    class _Echo:
        def recognize(self, _path, *, stem="mix"):  # noqa: ARG002
            return SimpleNamespace(
                provider="stub",
                provider_version="0",
                key=None,
                segments=[
                    SimpleNamespace(start_sec=float(a), end_sec=float(b), label=c)
                    for a, b, c in segs
                ],
            )

    manifest = tmp_path / "m.json"
    manifest.write_text(
        json.dumps(
            {
                "songs": [
                    {
                        "fma_id_or_jamendo_id": "song",
                        "url": "https://example.invalid/x.wav",
                        "ground_truth_lab": row["ground_truth_lab"],
                    }
                ]
            }
        )
    )
    report = chord_eval.run_eval(_Echo(), manifest, cache)
    assert report.rows[0].mir_eval.get("majmin") == pytest.approx(1.0)
