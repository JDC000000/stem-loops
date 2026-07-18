"""R2 spike (V2 follow-up to S1/R1) — measures yt-dlp fetch success + latency
THROUGH A RESIDENTIAL/MOBILE PROXY, to test whether routing around IP
reputation (rather than solving the PO-token/bot-challenge problem) restores
success from the level this repo already proved is 0% on datacenter egress
(see s1_ytdlp_results.json / s1_cobalt_results.json — both 0/50, 100%
error.api.youtube.login / BOT_BLOCK).

Deep-research (documents/requirements/stem-loops/youtube-input-v2-research.md)
found PO-token fixes alone do NOT restore success from a datacenter IP, but
did not re-litigate proxy pricing/mechanics (already scoped in
vnext-budget-note.md). This script is the empirical follow-up: same fixture,
same Gate-0 bar (>=95% success, p90<10s), same classify() taxonomy as the
original datacenter_bakeoff.py — only the network path changes (yt-dlp
--proxy instead of direct egress). Cobalt is intentionally NOT re-tested here:
it's a separate self-hosted Fly service and proxying its own outbound egress
is a heavier lift than routing yt-dlp's single subprocess call through
--proxy; if yt-dlp+proxy clears the gate, Cobalt can stay retired as the
primary path (yt-dlp becomes primary) rather than also re-plumbing Cobalt.

Usage:
    PROXY_URL="http://user:pass@geo.iproyal.com:12321" \\
      ./.venv/bin/python spikes/s1_bakeoff/residential_bakeoff.py spikes/fixtures/fixture_urls.txt

PROXY_URL must be a full connection string yt-dlp understands directly via
--proxy (http/https/socks5, credentials embedded). No proxy env var set -> the
script refuses to run (so nobody accidentally re-runs the already-answered
datacenter case under this filename).
"""
import concurrent.futures as cf
import json
import os
import subprocess
import sys
import time


def classify(err: str) -> str:
    e = err.lower()
    if "sign in to confirm" in e or "not a bot" in e or "bot" in e:
        return "BOT_BLOCK"
    if "private" in e:
        return "PRIVATE"
    if "age" in e and "restrict" in e:
        return "AGE_RESTRICTED"
    if "unavailable" in e or "removed" in e:
        return "UNAVAILABLE"
    if "proxy" in e or "tunnel" in e:
        return "PROXY_ERROR"
    if "timed out" in e or "timeout" in e:
        return "TIMEOUT"
    return "OTHER"


def probe(url: str, proxy: str) -> dict:
    t0 = time.time()
    cmd = [
        sys.executable, "-m", "yt_dlp", "--simulate", "--no-warnings",
        "--proxy", proxy,
        "-f", "bestaudio/best", "--print", "%(id)s", url,
    ]
    try:
        # Residential proxies add real latency (extra hop + slower consumer-grade
        # upstream) vs. datacenter-to-datacenter, so this budget is looser than the
        # 25s used for the direct-egress spike. p90 is still measured against the
        # PRD's <10s fetch target for the GATE line below; this is just the
        # subprocess kill-switch, not the pass/fail bar.
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=35)
        ms = int((time.time() - t0) * 1000)
        if p.returncode == 0 and p.stdout.strip():
            return {"url": url, "ok": True, "ms": ms, "cat": "OK"}
        return {"url": url, "ok": False, "ms": ms, "cat": classify(p.stderr)}
    except subprocess.TimeoutExpired:
        return {"url": url, "ok": False, "ms": int((time.time() - t0) * 1000), "cat": "TIMEOUT"}


def pct(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]


def measure(label, proxy, urls, max_workers=4):
    # Modest concurrency: this is a brand-new proxy account/bundle on its first
    # real workload — stay polite to avoid tripping the provider's own abuse
    # detection before we've even measured YouTube's.
    with cf.ThreadPoolExecutor(max_workers=max_workers) as ex:
        res = list(ex.map(lambda u: probe(u, proxy), urls))
    ok = [r for r in res if r["ok"]]
    cats = {}
    for r in res:
        cats[r["cat"]] = cats.get(r["cat"], 0) + 1
    ok_ms = [r["ms"] for r in ok]
    return {
        "path": label,
        "n": len(res),
        "success": len(ok),
        "success_pct": round(100 * len(ok) / len(res), 1) if res else 0,
        "p50_ms_success": pct(ok_ms, 0.5),
        "p90_ms_success": pct(ok_ms, 0.9),
        "categories": cats,
    }


def main():
    proxy = os.environ.get("PROXY_URL")
    if not proxy:
        print("PROXY_URL not set. This script only tests the proxied path — refusing to "
              "silently re-run the already-answered 0%% datacenter case. Set PROXY_URL to "
              "a full yt-dlp --proxy connection string (http://user:pass@host:port).",
              file=sys.stderr)
        sys.exit(1)
    if len(sys.argv) < 2:
        print("Usage: PROXY_URL=... python residential_bakeoff.py <urls_file>", file=sys.stderr)
        sys.exit(1)

    urls = [ln.strip() for ln in open(sys.argv[1]) if ln.strip() and not ln.startswith("#")]
    here = os.path.dirname(__file__)
    result = measure("yt-dlp (residential/mobile proxy)", proxy, urls)
    print(json.dumps(result, indent=2))
    json.dump(result, open(os.path.join(here, "r2_ytdlp_residential_results.json"), "w"), indent=2)

    gate = result["success_pct"] >= 95 and (result["p90_ms_success"] or 9e9) < 10000
    print(f"GATE ytdlp+proxy: {'PASS' if gate else 'FAIL'} "
          f"({result['success_pct']}% success, p90={result['p90_ms_success']}ms)")


if __name__ == "__main__":
    main()
