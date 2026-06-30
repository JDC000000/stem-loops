"""S1 bake-off. Measures fetch success + latency for BOTH download paths from
the current (datacenter) IP — the exact step YouTube bot-gates:
  - yt-dlp (always): extraction with NO cookies.
  - Cobalt (only if COBALT_URL is set): resolve audio via the Cobalt v10 API.
Usage: python datacenter_bakeoff.py <urls_file>
       COBALT_URL=https://...fly.dev python datacenter_bakeoff.py <urls_file>
"""
import concurrent.futures as cf, subprocess, sys, time, json, os

def classify(err: str) -> str:
    e = err.lower()
    if "sign in to confirm" in e or "not a bot" in e or "bot" in e: return "BOT_BLOCK"
    if "private" in e: return "PRIVATE"
    if "age" in e and "restrict" in e: return "AGE_RESTRICTED"
    if "unavailable" in e or "removed" in e: return "UNAVAILABLE"
    if "timed out" in e or "timeout" in e: return "TIMEOUT"
    return "OTHER"

def probe(url: str) -> dict:
    t0 = time.time()
    try:
        p = subprocess.run([sys.executable, "-m", "yt_dlp", "--simulate", "--no-warnings",
                            "-f", "bestaudio/best", "--print", "%(id)s", url],
                           capture_output=True, text=True, timeout=25)
        ms = int((time.time()-t0)*1000)
        if p.returncode == 0 and p.stdout.strip():
            return {"url": url, "ok": True, "ms": ms, "cat": "OK"}
        return {"url": url, "ok": False, "ms": ms, "cat": classify(p.stderr)}
    except subprocess.TimeoutExpired:
        return {"url": url, "ok": False, "ms": int((time.time()-t0)*1000), "cat": "TIMEOUT"}

def probe_cobalt(url: str) -> dict:
    from cobalt_client import fetch_audio_cobalt
    r = fetch_audio_cobalt(url)
    return {"url": url, "ok": bool(r.get("success")), "ms": r.get("latency_ms", 0),
            "cat": "OK" if r.get("success") else (r.get("error") or "ERR")[:40]}

def pct(vals, q):
    if not vals: return None
    s = sorted(vals); return s[min(len(s)-1, int(round(q*(len(s)-1))))]

def measure(label, fn, urls):
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        res = list(ex.map(fn, urls))
    ok = [r for r in res if r["ok"]]
    cats = {}
    for r in res: cats[r["cat"]] = cats.get(r["cat"], 0) + 1
    ok_ms = [r["ms"] for r in ok]
    return {
        "path": label, "n": len(res), "success": len(ok),
        "success_pct": round(100 * len(ok) / len(res), 1) if res else 0,
        "p50_ms_success": pct(ok_ms, 0.5), "p90_ms_success": pct(ok_ms, 0.9),
        "categories": cats,
    }

def main():
    urls = [l.strip() for l in open(sys.argv[1]) if l.strip() and not l.startswith("#")]
    here = os.path.dirname(__file__)
    results = {"ytdlp": measure("yt-dlp (datacenter IP, no cookies)", probe, urls)}
    if os.environ.get("COBALT_URL"):
        results["cobalt"] = measure(f"Cobalt v10 ({os.environ['COBALT_URL']})", probe_cobalt, urls)
    print(json.dumps(results, indent=2))
    json.dump(results["ytdlp"], open(os.path.join(here, "s1_ytdlp_results.json"), "w"), indent=2)
    if "cobalt" in results:
        json.dump(results["cobalt"], open(os.path.join(here, "s1_cobalt_results.json"), "w"), indent=2)
    # gate check
    for k, r in results.items():
        gate = r["success_pct"] >= 95 and (r["p90_ms_success"] or 9e9) < 10000
        print(f"GATE {k}: {'PASS' if gate else 'FAIL'} "
              f"({r['success_pct']}% success, p90={r['p90_ms_success']}ms)")

if __name__ == "__main__":
    main()
