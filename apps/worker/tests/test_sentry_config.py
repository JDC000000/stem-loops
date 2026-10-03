"""Security review 2026-10-03: worker Sentry must not trace or ship cookies, IPs, locals or job ids."""

import json
import logging
import pathlib
import re

import sentry_sdk
from sentry_sdk.transport import Transport

from worker.sentry_config import scrub_event, sentry_options

JOB = "3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b"
PROXY = "http://sluser:pr0xyp4ss@gate.example.com:7000"
SIGNED = (
    f"https://acct.r2.cloudflarestorage.com/stem-loops/{JOB}/loop_1.wav"
    "?X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=deadbeefsig"
)
SECRETS = (JOB, "pr0xyp4ss", "sluser", "AKIAEXAMPLE", "deadbeefsig", "X-Amz-", "token=abc")


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


def _assert_clean(obj):
    s = json.dumps(obj)
    for bad in SECRETS:
        assert bad not in s, f"kept {bad}"


def test_exception_messages_and_breadcrumbs_scrubbed():
    ev = {
        "exception": {
            "values": [
                {"type": "ProxyError", "value": f"Cannot connect to proxy {PROXY} (timeout)"},
                {"type": "InternalError", "value": f"download failed for job {JOB}"},
                {"type": "ClientError", "value": f"GET '{SIGNED}' -> 403"},
            ]
        },
        "logentry": {"message": "fetch %s failed", "params": [SIGNED, 3]},
        "breadcrumbs": {
            "values": [
                {"category": "httpx", "message": f'HTTP Request: GET {SIGNED} "HTTP/1.1 403"'},
                {
                    "category": "httplib",
                    "data": {
                        "url": f"https://api.example/v1/jobs/{JOB}",
                        "http.query": "token=abc",
                        "method": "GET",
                    },
                },
                {
                    "category": "log",
                    "message": "proxy sluser:pr0xyp4ss@gate.example.com:7000 refused",
                },
            ]
        },
    }
    out = scrub_event(ev)
    _assert_clean(out)
    values = [v["value"] for v in out["exception"]["values"]]
    assert values == [
        "Cannot connect to proxy http://[redacted]@gate.example.com:7000 (timeout)",
        "download failed for job [id]",
        "GET 'https://acct.r2.cloudflarestorage.com/[presigned]' -> 403",
    ]
    assert [v["type"] for v in out["exception"]["values"]] == [
        "ProxyError",
        "InternalError",
        "ClientError",
    ]
    assert out["logentry"]["params"][1] == 3
    assert out["breadcrumbs"]["values"][1]["data"] == {
        "url": "https://api.example/v1/jobs/[id]",
        "method": "GET",
    }


class _Capture(Transport):
    def __init__(self, options=None):
        super().__init__(options)
        self.events = []

    def capture_envelope(self, envelope):
        self.events += [i.payload.json for i in envelope.items if i.type == "event"]


def test_real_sdk_error_event_is_scrubbed(monkeypatch):
    """End to end through sentry-sdk: exception value, chained cause and log breadcrumbs."""
    monkeypatch.setenv("SENTRY_DSN", "https://public@o0.ingest.sentry.io/0")
    transport = _Capture()
    sentry_sdk.init(**sentry_options(), transport=transport)
    try:
        logging.getLogger("httpx").warning("HTTP Request: GET %s", SIGNED)
        try:
            try:
                raise ConnectionError(f"Cannot connect to proxy {PROXY}")
            except ConnectionError as cause:
                raise RuntimeError(f"stem download failed for job {JOB}") from cause
        except RuntimeError as e:
            sentry_sdk.capture_exception(e)
        sentry_sdk.flush()
    finally:
        sentry_sdk.get_client().close()
        sentry_sdk.init()
    (event,) = transport.events
    _assert_clean(event)
    assert {v["value"] for v in event["exception"]["values"]} == {
        "Cannot connect to proxy http://[redacted]@gate.example.com:7000",
        "stem download failed for job [id]",
    }
    assert any("[presigned]" in (b.get("message") or "") for b in event["breadcrumbs"]["values"])


def test_scrub_text_relative_urls_and_bare_userinfo():
    from worker.sentry_config import scrub_text

    rel = f"/stem-loops/{JOB}/x.wav?X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=deadbeefsig"
    assert scrub_text(f"url: {rel} status=403") == "url: /[presigned] status=403"
    assert scrub_text(f"GET /api/jobs/{JOB}?token=abc#f done") == "GET /api/jobs/[id] done"
    assert (
        scrub_text("key=k&X-Amz-Signature=deadbeefsig&x=1")
        == "key=k&X-Amz-Signature=[redacted]&x=1"
    )
    # Proxy credentials without a scheme: dotted host or host:port.
    assert (
        scrub_text("via sluser:pr0xyp4ss@gate.example.com:7000")
        == "via [redacted]@gate.example.com:7000"
    )
    assert scrub_text("via sluser:pr0xyp4ss@localhost:8080") == "via [redacted]@localhost:8080"
    # Not credentials: left alone.
    for s in ("meet 12:30@noon", "ratio 1:2@x", "a/b c /health"):
        assert scrub_text(s) == s
