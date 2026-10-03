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
"""

from __future__ import annotations

import os
import re
from typing import Any

_JOB_ID = re.compile(
    r"/(api/)?jobs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I
)
_DROP_HEADER = re.compile(
    r"^(cookie|set-cookie|authorization|proxy-authorization|x-forwarded-for|x-real-ip|"
    r"forwarded|fly-client-ip|cf-connecting-ip|true-client-ip)$",
    re.I,
)


def _mask(s: str) -> str:
    return _JOB_ID.sub(lambda m: f"/{m.group(1) or ''}jobs/[id]", s)


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
