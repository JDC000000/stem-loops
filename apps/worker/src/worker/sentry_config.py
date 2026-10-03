"""Sentry options for the worker (security review 2026-10-03).

Kept free of heavy imports so it can be unit-tested on its own.

- Tracing off: ``traces_sampler`` always returns 0. A sampler, not a rate, so an
  inbound sampled trace header can't switch it back on.
- ``send_default_pii`` stays False and ``include_local_variables`` is False: an
  unexpected exception must not ship frame locals, which in this worker can hold
  the residential-proxy URL (with credentials), R2 keys or signed URLs.
- ``before_send`` / ``before_send_transaction`` drop request cookies, auth/IP
  headers and query strings, and mask job ids in URLs (a job id is a bearer
  capability for that job's loops).
- Free text is scrubbed too: exception values, log messages and breadcrumbs
  (e.g. ``download failed for job <uuid>``, an httpx log line with a signed URL,
  a proxy URL with ``user:pass@``). URLs lose credentials, query and fragment;
  presigned URLs keep only their origin; job ids are masked. Stack traces are
  untouched, so grouping (stack-based) is unaffected.
"""

from __future__ import annotations

import os
import re
from typing import Any

# A job id is a UUID; it is also the first segment of every R2 key (`<job_id>/...`),
# so any UUID is masked, not only the /jobs/<id> form.
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_URL = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s'\"<>]+", re.I)
_URL_USERINFO = re.compile(r"^([a-z][a-z0-9+.-]*://)[^@/?#]*@", re.I)
_ORIGIN = re.compile(r"^[a-z][a-z0-9+.-]*://[^/?#]*", re.I)
_PRESIGNED = re.compile(r"[?&]X-Amz-(Signature|Credential)=", re.I)
# A relative URL that carries a query or fragment, e.g. urllib3's
# `/bucket/<id>/x.wav?X-Amz-Signature=...` (same pattern as the web scrubber).
_REL_URL_WITH_QUERY = re.compile(r"(^|[\s'\"(=<\[,])(/[^\s'\"<>?#]*[?#][^\s'\"<>]*)")
_AMZ_SECRET_PARAM = re.compile(
    r"(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s'\"<>]+", re.I
)
# Scheme-less `user:pass@host` (e.g. a proxy string echoed by a library). The host
# must look like one (dotted name or name:port), so `12:30@noon` is left alone.
_BARE_USERINFO = re.compile(
    r"(?<![\w/:.@-])[^\s/:@'\"()\[\]]+:[^\s/@'\"()\[\]]+@(?=[\w-]+(?:\.[\w-]+)+|[\w.-]+:\d+)"
)
_DROP_CRUMB_DATA = {"http.query", "http.fragment"}
_DROP_HEADER = re.compile(
    r"^(cookie|set-cookie|authorization|proxy-authorization|x-forwarded-for|x-real-ip|"
    r"forwarded|fly-client-ip|cf-connecting-ip|true-client-ip)$",
    re.I,
)


def _mask(s: str) -> str:
    return _UUID.sub("[id]", s)


def scrub_url(url: str) -> str:
    if _PRESIGNED.search(url):
        m = _ORIGIN.match(url)
        return _URL_USERINFO.sub(r"\1[redacted]@", m.group(0) if m else "") + "/[presigned]"
    return _mask(_URL_USERINFO.sub(r"\1[redacted]@", re.split(r"[?#]", url, maxsplit=1)[0]))


def scrub_text(text: str) -> str:
    text = _URL.sub(lambda m: scrub_url(m.group(0)), text)
    text = _REL_URL_WITH_QUERY.sub(lambda m: m.group(1) + scrub_url(m.group(2)), text)
    text = _AMZ_SECRET_PARAM.sub(r"\1[redacted]", text)
    return _mask(_BARE_USERINFO.sub("[redacted]@", text))


def _scrub_strings(d: dict[str, Any], keys: Any) -> None:
    for k in keys:
        if isinstance(d.get(k), str):
            d[k] = scrub_text(d[k])


def traces_sampler(_ctx: dict[str, Any]) -> float:
    return 0.0


def scrub_event(event: dict[str, Any], _hint: Any = None) -> dict[str, Any]:
    req = event.get("request")
    if isinstance(req, dict):
        req.pop("cookies", None)
        req.pop("query_string", None)
        req.pop("data", None)
        if isinstance(req.get("url"), str):
            req["url"] = _mask(req["url"].split("?")[0])
        headers = req.get("headers")
        if isinstance(headers, dict):
            for k in list(headers):
                if _DROP_HEADER.match(k):
                    del headers[k]
    user = event.get("user")
    if isinstance(user, dict):
        user.pop("ip_address", None)
    if isinstance(event.get("transaction"), str):
        event["transaction"] = _mask(event["transaction"])
    for exc in (event.get("exception") or {}).get("values") or []:
        if isinstance(exc, dict):
            _scrub_strings(exc, ("value",))
    _scrub_strings(event, ("message",))
    logentry = event.get("logentry")
    if isinstance(logentry, dict):
        _scrub_strings(logentry, ("message", "formatted"))
        if isinstance(logentry.get("params"), list):
            logentry["params"] = [
                scrub_text(p) if isinstance(p, str) else p for p in logentry["params"]
            ]
    crumbs = event.get("breadcrumbs")
    for crumb in (crumbs.get("values") if isinstance(crumbs, dict) else crumbs) or []:
        if not isinstance(crumb, dict):
            continue
        _scrub_strings(crumb, ("message",))
        data = crumb.get("data")
        if isinstance(data, dict):
            for k in _DROP_CRUMB_DATA & data.keys():
                del data[k]
            _scrub_strings(data, list(data))
    return event


def sentry_options() -> dict[str, Any]:
    return {
        "dsn": os.environ["SENTRY_DSN"],
        "environment": os.environ.get("FLY_APP_NAME", "production"),
        "traces_sampler": traces_sampler,
        "send_default_pii": False,
        "include_local_variables": False,
        "before_send": scrub_event,
        "before_send_transaction": scrub_event,
    }
