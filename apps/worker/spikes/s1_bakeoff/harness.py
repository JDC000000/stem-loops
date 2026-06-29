"""S1 bake-off harness: run N URLs through Cobalt and yt-dlp, record results.

Usage:
    python harness.py [urls_file] [out_file]

Computes per-path success rate and p90 latency so the operator can pick the
production primary path (Gate 0, P0-7). Run from the s1_bakeoff directory.
"""

import concurrent.futures
import csv
import sys

from cobalt_client import fetch_audio_cobalt
from ytdlp_client import fetch_audio_ytdlp


def _p90(values: list[int]) -> int:
    if not values:
        return 0
    s = sorted(values)
    idx = min(len(s) - 1, int(round(0.9 * (len(s) - 1))))
    return s[idx]


def run(urls_file: str, out_file: str = "s1_results.csv") -> None:
    with open(urls_file) as f:
        urls = [line.strip() for line in f if line.strip() and not line.startswith("#")]
    if len(urls) != 50:
        print(f"WARNING: expected 50 URLs, got {len(urls)} — results are not the full bake-off")

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        cobalt_futs = {ex.submit(fetch_audio_cobalt, u): u for u in urls}
        ytdlp_futs = {ex.submit(fetch_audio_ytdlp, u): u for u in urls}
        cobalt_res = {
            cobalt_futs[f]: f.result() for f in concurrent.futures.as_completed(cobalt_futs)
        }
        ytdlp_res = {ytdlp_futs[f]: f.result() for f in concurrent.futures.as_completed(ytdlp_futs)}

    with open(out_file, "w", newline="") as csvf:
        w = csv.writer(csvf)
        w.writerow(
            ["url", "cobalt_ok", "cobalt_ms", "cobalt_err", "ytdlp_ok", "ytdlp_ms", "ytdlp_err"]
        )
        for u in urls:
            c, y = cobalt_res[u], ytdlp_res[u]
            w.writerow(
                [
                    u,
                    c["success"],
                    c["latency_ms"],
                    c["error"],
                    y["success"],
                    y["latency_ms"],
                    y["error"],
                ]
            )

    n = len(urls)
    cobalt_ok = sum(1 for u in urls if cobalt_res[u]["success"])
    ytdlp_ok = sum(1 for u in urls if ytdlp_res[u]["success"])
    cobalt_p90 = _p90([cobalt_res[u]["latency_ms"] for u in urls if cobalt_res[u]["success"]])
    ytdlp_p90 = _p90([ytdlp_res[u]["latency_ms"] for u in urls if ytdlp_res[u]["success"]])

    def pct(ok: int) -> str:
        return f"{(ok / n * 100):.0f}%" if n else "n/a"

    print(f"Cobalt: {cobalt_ok}/{n} ({pct(cobalt_ok)})  p90={cobalt_p90}ms")
    print(f"yt-dlp: {ytdlp_ok}/{n} ({pct(ytdlp_ok)})  p90={ytdlp_p90}ms")
    print(f"Results written to {out_file}")


if __name__ == "__main__":
    urls_path = sys.argv[1] if len(sys.argv) > 1 else "../fixtures/fixture_urls.txt"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "s1_results.csv"
    run(urls_path, out_path)
