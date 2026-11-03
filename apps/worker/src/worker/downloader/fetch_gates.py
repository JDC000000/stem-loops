"""SL21 Phase 0 fetch gates (BUILD-R s2.2 / s7): blocklist, kill switches, attempt log.

All state lives in Postgres (migration 008) so an operator can flip a switch or add a
takedown with no redeploy. Kill switches are cached for KILL_SWITCH_TTL_S (<= 30 s per
BUILD-R s7). `kill_switches.enabled = TRUE` means ENGAGED, i.e. the capability is stopped.

Failure policy (decided here, stated once):
  * fetch_global / fetch_youtube: a DB read error with no cached value FAILS OPEN (the pipeline
    needs the same DB anyway; an outage of the switch table must not take every link job down).
  * fetch_cobalt: FAILS CLOSED, and a missing row counts as engaged (Cobalt is opt-in).
  * blocklist: FAILS CLOSED (a takedown must not be bypassed by a transient DB error).
  * attempt logging never raises.
"""

from __future__ import annotations

import hashlib
import os
import re
import threading
import time
from importlib import metadata

import psycopg

from ..errors import DownloadBlockedError
from ..logger import log_structured

KILL_SWITCH_TTL_S = 30.0
SCOPE_FETCH_GLOBAL = "fetch_global"
SCOPE_FETCH_YOUTUBE = "fetch_youtube"
SCOPE_FETCH_COBALT = "fetch_cobalt"
# Scopes that are opt-in: no row (or an unreadable table) means "engaged".
_DEFAULT_ENGAGED = frozenset({SCOPE_FETCH_COBALT})

_VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
_WATCH_PATH = re.compile(r"^/(?:shorts|embed|live|v|e)/([A-Za-z0-9_-]{11})(?:[/?#]|$)")

_lock = threading.Lock()
_cache: dict[str, bool] = {}
_cache_at: float | None = None


def _connect():
    return psycopg.connect(os.environ["DATABASE_URL"], connect_timeout=3)


def video_id_from_url(url: str) -> str | None:
    """11-char YouTube video id from an allowlisted URL, or None if it cannot be read."""
    from urllib.parse import parse_qs, urlsplit

    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    if host.endswith("youtu.be"):
        m = re.match(r"^/([A-Za-z0-9_-]{11})(?:[/?#]|$)", parts.path)
        return m.group(1) if m else None
    v = parse_qs(parts.query).get("v", [""])[0]
    if parts.path.rstrip("/") == "/watch" and _VIDEO_ID.fullmatch(v):
        return v
    m = _WATCH_PATH.match(parts.path)
    return m.group(1) if m else None


def canonical_watch_url(video_id: str) -> str:
    """SL-B24 #1: the ONLY URL shape every fetcher should see.

    Rebuilt from the 11-char video_id so a crafted raw URL like
    `watch?%76=A&v=B` (gate parses v=A, yt-dlp might fetch v=B) cannot make
    the kill-switch/blocklist check one id while a fetcher pulls a different
    one. Call this with the id returned by video_id_from_url and pass the
    result to ytdlp_client / cobalt_client.
    """
    return f"https://www.youtube.com/watch?v={video_id}"


def video_hash(video_id: str | None) -> str | None:
    return hashlib.sha256(video_id.encode()).hexdigest()[:16] if video_id else None


def reset_cache() -> None:
    global _cache_at
    with _lock:
        _cache.clear()
        _cache_at = None


def _refresh_if_stale() -> None:
    global _cache_at
    now = time.monotonic()
    if _cache_at is not None and now - _cache_at < KILL_SWITCH_TTL_S:
        return
    try:
        with _connect() as conn:
            rows = conn.execute("SELECT scope, enabled FROM kill_switches").fetchall()
        _cache.clear()
        _cache.update({scope: bool(enabled) for scope, enabled in rows})
        _cache_at = now
    except Exception as exc:  # noqa: BLE001 — keep serving the last known state
        log_structured("WARN", "kill_switch_read_failed", error=str(exc)[:120])
        # Do not stamp _cache_at on a failure with no data, so the next call retries; with a
        # stale copy we keep it and also retry on the next call (cheap: 3 s connect timeout).


def is_engaged(scope: str) -> bool:
    """True if the switch for `scope` is engaged (capability stopped)."""
    with _lock:
        _refresh_if_stale()
        if scope in _cache:
            return _cache[scope]
        return scope in _DEFAULT_ENGAGED


def fetch_paused() -> str | None:
    """Return the engaged YouTube-fetch scope (global first) or None."""
    for scope in (SCOPE_FETCH_GLOBAL, SCOPE_FETCH_YOUTUBE):
        if is_engaged(scope):
            return scope
    return None


def cobalt_allowed() -> bool:
    return not is_engaged(SCOPE_FETCH_COBALT)


def is_blocklisted(video_id: str) -> bool:
    try:
        with _connect() as conn:
            return (
                conn.execute("SELECT 1 FROM blocklist WHERE video_id=%s", (video_id,)).fetchone()
                is not None
            )
    except Exception as exc:  # noqa: BLE001
        log_structured("ERROR", "blocklist_read_failed", error=str(exc)[:120])
        raise DownloadBlockedError("blocklist check unavailable") from exc


_ytdlp_version: str | None | bool = False  # False = not looked up yet


def ytdlp_version() -> str | None:
    global _ytdlp_version
    if _ytdlp_version is False:
        try:
            _ytdlp_version = metadata.version("yt-dlp")
        except metadata.PackageNotFoundError:
            _ytdlp_version = None
    return _ytdlp_version  # type: ignore[return-value]


def log_attempt(
    *,
    job_id: str | None,
    attempt: int,
    path: str,
    outcome_class: str,
    ms_total: int,
    video_id: str | None,
    exit_session_hash: str | None = None,
    nbytes: int | None = None,
    ms_first_byte: int | None = None,
    ytdlp_ver: str | None = None,
) -> None:
    """Insert one fetch_attempts row. Never raises."""
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO fetch_attempts (job_id, attempt, path, exit_session_hash, "
                "outcome_class, ms_first_byte, ms_total, bytes, ytdlp_version, video_hash) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    job_id,
                    attempt,
                    path,
                    exit_session_hash,
                    outcome_class,
                    ms_first_byte,
                    ms_total,
                    nbytes,
                    ytdlp_ver,
                    video_hash(video_id),
                ),
            )
            conn.commit()
    except Exception as exc:  # noqa: BLE001
        log_structured("WARN", "fetch_attempt_log_failed", error=str(exc)[:120])
