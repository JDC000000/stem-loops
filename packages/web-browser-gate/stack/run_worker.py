"""Browser-journey stack worker launcher — runs the REAL worker consumer against loopback mocks.
No repo edit: imports worker.replicate_client, points its API at the Replicate mock, asserts every
configured endpoint is loopback, then runs consumer.poll_loop(). STUB_MODE must be unset.
Run with PYTHONPATH=apps/worker/src (stack.sh does this).
"""
import asyncio, ipaddress, os, socket, sys
from urllib.parse import urlsplit

REPLICATE_MOCK = os.environ.get("REPLICATE_MOCK_URL", "http://127.0.0.1:54323/v1")  # must be loopback

def _is_loopback_url(u: str) -> bool:
    host = urlsplit(u).hostname
    if not host:
        return False
    try:
        return all(ipaddress.ip_address(ai[4][0]).is_loopback for ai in socket.getaddrinfo(host, None))
    except Exception:
        return False

def preflight() -> None:
    bad = []
    if os.environ.get("STUB_MODE"):
        bad.append(f"STUB_MODE is set ({os.environ['STUB_MODE']!r}); must be UNSET so the real pipeline runs")
    urlish = [k for k in os.environ if k.endswith(("_URL", "_URL_POOLED", "_ENDPOINT", "_ENDPOINT_URL", "_API_BASE", "_BASE"))]
    for k in sorted(urlish):
        v = os.environ[k]
        if k in ("HTTPS_PROXY", "HTTP_PROXY") or not v.strip():
            continue
        if not _is_loopback_url(v):
            bad.append(f"{k} is non-loopback: {urlsplit(v).hostname}")
    for k in ("DATABASE_URL", "R2_ENDPOINT_URL", "KLANGIO_API_BASE"):
        if not os.environ.get(k):
            bad.append(f"{k} unset")
    for k in ("COBALT_URL", "PROXY_URL", "SENTRY_DSN", "R2_ACCOUNT_ID"):
        if os.environ.get(k):
            bad.append(f"{k} must be unset for the local stack")
    if os.environ.get("ALLOW_YOUTUBE_INPUT", "").lower() == "true":
        bad.append("ALLOW_YOUTUBE_INPUT=true would allow real outbound downloads")
    np = os.environ.get("NO_PROXY", "") + "," + os.environ.get("no_proxy", "")
    if "127.0.0.1" not in np:
        bad.append("NO_PROXY must include 127.0.0.1")
    if bad:
        print("ABORT (loopback preflight):\n  " + "\n  ".join(bad), file=sys.stderr)
        sys.exit(2)

preflight()
if not _is_loopback_url(REPLICATE_MOCK):
    print(f"ABORT: REPLICATE_MOCK_URL {REPLICATE_MOCK} not loopback", file=sys.stderr); sys.exit(2)

from worker import replicate_client  # noqa: E402
replicate_client.API = REPLICATE_MOCK
from worker.chord_providers import klangio  # noqa: E402
from worker import consumer  # noqa: E402

for name, val in (("replicate_client.API", replicate_client.API), ("klangio.API_BASE", klangio.API_BASE)):
    if not _is_loopback_url(val):
        print(f"ABORT: {name} = {val} is not loopback", file=sys.stderr)
        sys.exit(2)
print(f"run_worker: preflight OK; replicate={replicate_client.API} klangio={klangio.API_BASE} "
      f"db={urlsplit(os.environ['DATABASE_URL']).path} r2={os.environ['R2_ENDPOINT_URL']} "
      f"bucket={os.environ['R2_BUCKET_NAME']} worker_src={replicate_client.__file__}", flush=True)
asyncio.run(consumer.poll_loop())
