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
# Per-statement cap on the gate read. connect_timeout is 3 s; 2 s keeps connect+query under
# ~5 s worst case while a read of a handful of rows takes milliseconds. Without it a lock
# on the table blocks the read indefinitely (8.0 s measured by QA).
KILL_SWITCH_STATEMENT_TIMEOUT_MS = 2000
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


def _read_switches() -> list[tuple[str, bool]]:
    """One bounded read of the table. Runs WITHOUT `_lock` held (see is_engaged)."""
    with _connect() as conn:
        # SET LOCAL (not a startup `options=` parameter, which a transaction-mode pooler
        # such as Supavisor/pgbouncer can reject): it applies to this transaction only.
        conn.execute(f"SET LOCAL statement_timeout = {int(KILL_SWITCH_STATEMENT_TIMEOUT_MS)}")
        return conn.execute("SELECT scope, enabled FROM kill_switches").fetchall()


def _needs_refresh(now: float) -> bool:
    return _cache_at is None or now - _cache_at >= KILL_SWITCH_TTL_S


def _refresh_if_stale() -> None:
    """Refresh the cache if older than the TTL. Must be called WITHOUT `_lock` held: the
    database call is made unlocked so a slow read cannot serialise every caller."""
    global _cache_at
    now = time.monotonic()
    with _lock:
        if not _needs_refresh(now):
            return
    try:
        rows = _read_switches()
    except Exception as exc:  # noqa: BLE001 — a timeout (QueryCanceled) lands here too
        log_structured("WARN", "kill_switch_read_failed", error=str(exc)[:120])
        # KNOWN WEAKNESS - deliberately NOT fixed here: after a failed read we keep serving the
        # cached value INDEFINITELY, so a role that has lost SELECT freezes the switches at
        # whatever they last were. Bounding the cache's age does NOT fix that. is_engaged()
        # falls back to `scope in _DEFAULT_ENGAGED`, so dropping the cache turns
        # fetch_global/fetch_youtube into "not engaged": a stale NOT-engaged value is
        # unchanged, and a stale ENGAGED value (a brake an operator pulled on purpose) would be
        # RELEASED. The real fix is for a missing/unreadable row to count as ENGAGED for these
        # scopes (fail closed). That needs a migration seeding the rows and carries a
        # deploy-ordering hazard: the migration must land BEFORE the worker deploys or every
        # link job stops (this project already had a ~2 h outage from exactly that coupling).
        # (fetch_cobalt is the one scope where expiry would only ever TIGHTEN: a stale released
        # cobalt would revert to engaged. Not worth a scope-specific ceiling on its own.)
        # Out of scope for this change; see kill_switch_table_empty below for the diagnostic.
        return
    if not rows:
        # A successful read of ZERO rows. Production's table has a fetch_cobalt row, so
        # this is not the normal state: it can mean the table was emptied, OR that this
        # role cannot see the rows (a missing grant under RLS, a dropped policy, or a
        # shadowing schema), in which case a real engaged switch is invisible.
        log_structured(
            "ERROR",
            "kill_switch_table_empty",
            detail="kill_switches returned 0 rows; may be empty OR unreadable by this "
            "role (permissions/RLS/search_path) - engaged switches may be invisible",
        )
    with _lock:
        _cache.clear()
        _cache.update({scope: bool(enabled) for scope, enabled in rows})
        _cache_at = now


def _decide(scope: str) -> bool:
    """The switch's state from the cache alone (no I/O)."""
    with _lock:
        if scope in _cache:
            return _cache[scope]
        return scope in _DEFAULT_ENGAGED


def is_engaged(scope: str) -> bool:
    """True if the switch for `scope` is engaged (capability stopped)."""
    _refresh_if_stale()
    return _decide(scope)


def fetch_paused() -> str | None:
    """Return the engaged YouTube-fetch scope (global first) or None."""
    # One refresh for the whole call, not one per scope: while reads are failing nothing is
    # stamped, so a per-scope refresh would pay the failing read (up to the statement timeout)
    # twice per call.
    _refresh_if_stale()
    for scope in (SCOPE_FETCH_GLOBAL, SCOPE_FETCH_YOUTUBE):
        if _decide(scope):
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
