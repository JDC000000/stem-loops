"""Security review 2026-10-03: worker Sentry must not trace or ship cookies, IPs, locals or job ids."""

import pathlib
import re

from worker.sentry_config import scrub_event, sentry_options

JOB = "3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b"


def test_options_tracing_off_and_no_pii(monkeypatch):
    monkeypatch.setenv("SENTRY_DSN", "https://public@o0.ingest.sentry.io/0")
    o = sentry_options()
    assert "traces_sample_rate" not in o or not o["traces_sample_rate"]
    assert o["traces_sampler"]({"parent_sampled": True}) == 0
    assert o["send_default_pii"] is False
    assert o["include_local_variables"] is False
    assert callable(o["before_send"]) and callable(o["before_send_transaction"])


def test_transaction_scrubbed():
    ev = {
        "type": "transaction",
        "transaction": f"/jobs/{JOB}",
        "request": {
            "url": f"https://w.example/api/jobs/{JOB}?x=1",
            "query_string": "x=1",
            "cookies": {"sl-history": "b64.sig"},
            "headers": {
                "Cookie": "sl-history=b64.sig",
                "Fly-Client-IP": "1.2.3.4",
                "User-Agent": "UA",
            },
        },
        "user": {"ip_address": "1.2.3.4"},
    }
    s = str(scrub_event(ev))
    for bad in ("b64.sig", "1.2.3.4", JOB, "x=1"):
        assert bad not in s
    assert ev["request"]["headers"] == {"User-Agent": "UA"}


def test_main_uses_sentry_options_only():
    src = (pathlib.Path(__file__).parents[1] / "src/worker/main.py").read_text()
    assert "sentry_sdk.init(**sentry_options())" in src
    assert not re.search(r"traces_sample_rate\s*=\s*0?\.[1-9]", src)
