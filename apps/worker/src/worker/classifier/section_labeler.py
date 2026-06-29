"""Section labelling (T16): map segment position + energy → intro/verse/chorus/bridge/outro.

Every loop gets a label — no loop ships without one.
"""


def label_sections(segments: list, energy_levels: list[str]) -> list[str]:
    n = len(segments)
    labels: list[str] = []
    for i, energy in enumerate(energy_levels[:n]):
        frac = i / max(n - 1, 1)
        if frac < 0.10:
            lbl = "intro"
        elif frac > 0.90:
            lbl = "outro"
        elif energy == "high":
            lbl = "chorus"
        elif energy == "low":
            lbl = "bridge" if (labels and labels[-1] == "chorus") else "verse"
        else:
            lbl = "verse"
        labels.append(lbl)
    return labels
