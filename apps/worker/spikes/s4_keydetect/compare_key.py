"""S4: librosa key detection (Krumhansl-Schmuckler) + keys->piano mapping note.

librosa is already a worker dependency (BPM detection), so using it for key adds
zero footprint. essentia is measured separately via measure_footprint.sh — it is
NOT imported here because it is a heavyweight optional dependency.

keys->piano note: htdemucs_6s emits a 'piano' stem for what the PRD calls 'keys';
the contract maps piano->keys in the UI/DB.
"""
import json
import os

import librosa
import numpy as np

HERE = os.path.dirname(__file__)
FIXTURES = os.path.normpath(os.path.join(HERE, "..", "fixtures"))
RESULTS = os.path.join(HERE, "s4_results.json")

NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
# Krumhansl-Schmuckler key profiles.
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def detect_key_librosa(path: str) -> str:
    y, sr = librosa.load(path, mono=True)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    best_score, best_key = -1.0, "C major"
    for i in range(12):
        rolled = np.roll(chroma_mean, -i)
        for profile, mode in ((MAJOR, "major"), (MINOR, "minor")):
            score = float(np.corrcoef(rolled, profile)[0, 1])
            if score > best_score:
                best_score, best_key = score, f"{NOTES[i]} {mode}"
    return best_key


def main() -> None:
    results = {}
    for name, fname in [
        ("labeled_song", "labeled_song.wav"),
        ("neosoul_keys", "neosoul_keys.wav"),
    ]:
        path = os.path.join(FIXTURES, fname)
        key_lib = detect_key_librosa(path)
        results[name] = {"librosa_key": key_lib}
        print(f"{name}: librosa={key_lib}")

    results["keys_piano_mapping"] = "htdemucs_6s emits 'piano'; contract maps piano->keys in UI/DB"
    results["essentia"] = "not imported here; footprint measured via measure_footprint.sh"

    with open(RESULTS, "w") as f:
        json.dump(results, f, indent=2)
    print(f"Results written to {RESULTS}")


if __name__ == "__main__":
    main()
