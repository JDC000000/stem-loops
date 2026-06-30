"""S1 datacenter bake-off (yt-dlp path). Measures extraction success + latency
from the current (datacenter) IP with NO cookies — the exact step YouTube
bot-gates. Cobalt path runs separately once COBALT_URL is set.
Usage: python datacenter_bakeoff.py <urls_file>
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

def pct(vals, q):
    if not vals: return None
    s = sorted(vals); return s[min(len(s)-1, int(round(q*(len(s)-1))))]

def main():
    urls = [l.strip() for l in open(sys.argv[1]) if l.strip() and not l.startswith("#")]
    res = []
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        res = list(ex.map(probe, urls))
    ok = [r for r in res if r["ok"]]
    cats = {}
    for r in res: cats[r["cat"]] = cats.get(r["cat"], 0) + 1
    ok_ms = [r["ms"] for r in ok]
    out = {
        "path": "yt-dlp (datacenter IP, no cookies)",
        "n": len(res), "success": len(ok),
        "success_pct": round(100*len(ok)/len(res), 1) if res else 0,
        "p50_ms_success": pct(ok_ms, 0.5), "p90_ms_success": pct(ok_ms, 0.9),
        "categories": cats,
    }
    print(json.dumps(out, indent=2))
    json.dump(out, open(os.path.join(os.path.dirname(__file__), "s1_ytdlp_results.json"), "w"), indent=2)

if __name__ == "__main__":
    main()
