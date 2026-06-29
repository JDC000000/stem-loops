"""Snap phrase-boundary times to the nearest bar grid (T13)."""


def snap_to_bars(boundaries: list[float], bpm: float, duration: float) -> list[tuple[float, float]]:
    if bpm <= 0:
        raise ValueError(f"Bad BPM: {bpm}")
    bar = 4 * 60.0 / bpm

    def nearest(t: float) -> float:
        return round(t / bar) * bar

    snapped = sorted({nearest(b) for b in boundaries})
    if not snapped or snapped[0] > bar:
        snapped = [0.0] + snapped
    snapped.append(duration)
    return [
        (snapped[i], snapped[i + 1])
        for i in range(len(snapped) - 1)
        if snapped[i + 1] - snapped[i] >= bar * 0.5
    ]
