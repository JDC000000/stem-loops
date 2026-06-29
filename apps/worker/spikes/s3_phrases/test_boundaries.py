"""S3: measure boundary accuracy vs labeled-song ground truth.

Pass bar: >=5 distinct boundaries detected AND >=70% of ground-truth section
transitions have a detected boundary within 500ms.

NOTE: fixture is WAV (the dev/CI box has no ffmpeg). Swap for a real labeled
track when the operator judges musical quality at Gate 0.
"""
import json
import os

from boundary_detector import detect_boundaries

HERE = os.path.dirname(__file__)
FIXTURES = os.path.normpath(os.path.join(HERE, "..", "fixtures"))
SONG = os.path.join(FIXTURES, "labeled_song.wav")
GROUND_TRUTH = os.path.join(FIXTURES, "labeled_song_ground_truth.json")
RESULTS = os.path.join(HERE, "s3_results.json")


def main() -> None:
    with open(GROUND_TRUTH) as f:
        gt = json.load(f)

    gt_times = [s["start"] for s in gt["sections"] if s["start"] > 0]
    detected = detect_boundaries(SONG)

    # Each GT transition counts as a hit if a detected boundary is within 500ms.
    hits = sum(1 for t in gt_times if any(abs(t - d) <= 0.5 for d in detected))
    accuracy = hits / len(gt_times) if gt_times else 0.0

    results = {
        "detected": detected,
        "detected_count": len(detected),
        "gt_count": len(gt_times),
        "hits": hits,
        "accuracy": accuracy,
        "pass_5_boundaries": len(detected) >= 5,
        "pass_70pct_accuracy": accuracy >= 0.70,
    }
    with open(RESULTS, "w") as f:
        json.dump(results, f, indent=2)

    print(f"Boundary accuracy: {accuracy:.0%} ({hits}/{len(gt_times)})")
    print(f"Total detected: {len(detected)} — pass >=5: {'YES' if len(detected) >= 5 else 'NO'}")


if __name__ == "__main__":
    main()
