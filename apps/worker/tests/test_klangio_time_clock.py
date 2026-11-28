"""#524: Klangio's served times run on a 10/108 s frame clock; the audio's frames are 2048/22050 s.

Measured on 3 served songs (box evidence BTC-TUNING-2026-11-28 / BTCTUNE-R1): every served
time is an exact multiple of 10/108 s, the frame count equals a contiguous hop-2048 CQT
of our audio at 22.05 kHz, and served_time x 1.00304-1.00314 = audio time (theory:
(2048/22050) / (10/108) = 1.003102). So the chords drift early, ~0.9 s by 300 s.
The fix re-stamps each served time by its frame index: k = served / (10/108),
audio = k * 2048/22050. A response NOT on that grid is passed through unchanged, so a
provider-side fix can never be corrected twice.
"""

from __future__ import annotations

import math

import pytest

from worker.chord_providers import klangio as kg

SERVED_FRAME = 10 / 108  # Klangio's (wrong) frame period, as served
HOP = 2048 / 22050  # the audio's real frame period (hop 2048 at 22.05 kHz)
LABELS = ["E:min7", "A:7", "E:7", "A", "C:maj", "G:7", "D:min", "N"]


def _served_300s_song() -> tuple[list[list[object]], list[int]]:
    """A 300 s song in the served shape: bare [[start, end, harte], ...] on the 10/108 grid.

    Frame count = 1 + len // 2048 at 22.05 kHz, as measured for the served demo songs
    (2303 / 2039 / 2071 frames). Boundaries every 23 frames (~2.1 s, a real chord rate);
    floats built exactly as served (e.g. 15 frames -> 1.3888888888888888).
    """
    n_frames = 1 + (300 * 22050) // 2048  # 3230
    bounds = list(range(0, n_frames, 23)) + [n_frames]
    rows: list[list[object]] = []
    for i in range(len(bounds) - 1):
        rows.append([bounds[i] * 10 / 108, bounds[i + 1] * 10 / 108, LABELS[i % len(LABELS)]])
    return rows, bounds


def test_300s_song_last_chord_lands_on_audio_seconds_within_20ms() -> None:
    rows, bounds = _served_300s_song()
    served_last_start = rows[-1][0]
    assert isinstance(served_last_start, float)
    result = kg._parse_klangio_response(rows, model_ms=0)

    expected_last_start = bounds[-2] * HOP
    expected_end = bounds[-1] * HOP  # 300.0036 s: the audio length rounded up to a frame
    last = result.segments[-1]
    assert abs(last.start_sec - expected_last_start) < 0.020
    assert abs(last.end_sec - expected_end) < 0.020
    assert abs(result.duration_sec - 300.0) < 0.020
    # the served value itself was ~0.93 s early: the test can tell fixed from unfixed
    assert expected_last_start - served_last_start > 0.9


def test_every_boundary_is_frame_index_times_hop() -> None:
    rows, bounds = _served_300s_song()
    segs = kg._parse_klangio_response(rows, model_ms=0).segments
    assert len(segs) == len(rows)
    for seg, k0, k1 in zip(segs, bounds[:-1], bounds[1:], strict=True):
        assert math.isclose(seg.start_sec, k0 * HOP, abs_tol=1e-9)
        assert math.isclose(seg.end_sec, k1 * HOP, abs_tol=1e-9)
    assert [s.label for s in segs] == [r[2] for r in rows]


def test_real_served_prefix_rows() -> None:
    """First rows of a served demo song, verbatim floats (frames 0, 15, 46, 69)."""
    served = [
        [0.0, 1.3888888888888888, "N"],
        [1.3888888888888888, 4.2592592592592595, "A:7"],
        [4.2592592592592595, 6.388888888888889, "E:min7"],
    ]
    segs = kg._parse_klangio_response(served, model_ms=0).segments
    assert [round(s.start_sec / HOP) for s in segs] == [0, 15, 46]
    assert math.isclose(segs[1].start_sec, 15 * HOP, abs_tol=1e-9)
    assert math.isclose(segs[-1].end_sec, 69 * HOP, abs_tol=1e-9)


def test_off_grid_response_passes_through_unchanged() -> None:
    """Times not on the 10/108 grid (e.g. a provider-side fix) are never rescaled."""
    rows = [[0.0, 2.4, "C:maj"], [2.4, 4.8, "F:maj"], [4.8, 7.2, "G:7"]]
    segs = kg._parse_klangio_response(rows, model_ms=0).segments
    assert [(s.start_sec, s.end_sec) for s in segs] == [(0.0, 2.4), (2.4, 4.8), (4.8, 7.2)]


def test_one_off_grid_time_disables_the_correction_for_the_whole_response() -> None:
    rows, _ = _served_300s_song()
    rows = [list(r) for r in rows[:3]]
    rows[2][1] = float(rows[2][1]) + 0.013  # 0.12 frames off the grid
    segs = kg._parse_klangio_response(rows, model_ms=0).segments
    assert [s.end_sec for s in segs] == [r[1] for r in rows]


def test_hop_2048_grid_response_is_not_rescaled() -> None:
    """Already on the audio clock (what a fixed provider would serve): untouched."""
    rows = [[k0 * HOP, k1 * HOP, "C:maj"] for k0, k1 in ((0, 23), (23, 46), (46, 69))]
    segs = kg._parse_klangio_response(rows, model_ms=0).segments
    assert [s.start_sec for s in segs] == [r[0] for r in rows]


def test_clock_is_logged(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    monkeypatch.setattr(kg, "log_structured", lambda lvl, ev, **kw: events.append((ev, kw)))
    kg._parse_klangio_response(_served_300s_song()[0], model_ms=0)
    kg._parse_klangio_response([[0.0, 2.4, "C:maj"]], model_ms=0)
    clocks = [kw["time_clock"] for ev, kw in events if ev == "klangio_parse_summary"]
    assert clocks == ["frame_10_108_restamped", "passthrough"]


@pytest.mark.parametrize(
    ("served", "frame"),
    # verbatim served floats that land just BELOW the integer frame (truncation would be off by 1)
    [(16.296296296296294, 176), (34.07407407407407, 368), (40.55555555555555, 438)],
)
def test_served_floats_below_the_frame_round_to_it(served: float, frame: int) -> None:
    rows = [[0.0, served, "C:maj"], [served, served + 23 * SERVED_FRAME, "G:7"]]
    segs = kg._parse_klangio_response(rows, model_ms=0).segments
    assert segs[0].end_sec == frame * HOP
    assert segs[1].start_sec == frame * HOP


def test_off_grid_start_with_on_grid_end_passes_through() -> None:
    """The grid check covers starts too, not only ends."""
    segs = kg._parse_klangio_response([[0.01, 2.5, "C"]], model_ms=0).segments
    assert [(s.start_sec, s.end_sec) for s in segs] == [(0.01, 2.5)]
