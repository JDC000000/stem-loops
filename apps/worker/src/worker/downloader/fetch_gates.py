"""SL21 Phase 0 fetch gates (BUILD-R s2.2 / s7): blocklist, kill switches, attempt log.

All state lives in Postgres (migration 008) so an operator can flip a switch or add a
takedown with no redeploy. Kill switches are cached for KILL_SWITCH_TTL_S (<= 30 s per
BUILD-R s7). `kill_switches.enabled = TRUE` means ENGAGED, i.e. the capability is stopped.

Failure policy (decided here, stated once):
  * fetch_global / fetch_youtube: a DB read error with no cached value FAILS OPEN (the pipeline
    needs the same DB anyway; an outage of the switch table must not take every link job down).
  * fetch_cobalt: FAILS CLOSED, and a missing row counts as engaged (Cobalt is opt-in).
  * blocklist: FAILS CLOSED (a takedown must not be bypassed by a transient DB error).
  * the kill-switch read clears the four server-side timers it could inherit (see _read_switches):
    a locked table stalls the worker and then answers correctly, rather than giving up and
    releasing a pulled brake. What is NOT bounded either way is stated there.
  * every table is named `public.<table>`: the first search_path entry is "$user", the LOGIN role.
  * attempt logging never raises.
"""

from __future__ import annotations

import contextlib
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
# A gate read still waiting after this long logs one WARN (it does NOT stop waiting; see
# _refresh_if_stale). Short enough that an operator sees why the consumer went quiet.
KILL_SWITCH_READ_SLOW_S = 5.0
SCOPE_FETCH_GLOBAL = "fetch_global"
SCOPE_FETCH_YOUTUBE = "fetch_youtube"
SCOPE_FETCH_COBALT = "fetch_cobalt"
# Scopes that are opt-in: no row (or an unreadable table) means "engaged".
_DEFAULT_ENGAGED = frozenset({SCOPE_FETCH_COBALT})
# The only scopes this worker reads. `scope` is free text (migration 008: no CHECK), so a row
# spelled any other way is never consulted; see the kill_switch_unknown_scope WARN.
_KNOWN_SCOPES = frozenset({SCOPE_FETCH_GLOBAL, SCOPE_FETCH_YOUTUBE, SCOPE_FETCH_COBALT})

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
    """One read of the table, with none of the server-side timers this module knows of.

    This gate fails OPEN for fetch_global/fetch_youtube, so a read that gives up turns "the
    table is locked / the database is slow" into "the brake is released": with fetch_global=true,
    a cold cache and an ACCESS EXCLUSIVE lock held for 3 s, the bounded read of d739cf7 (a 2 s
    SET LOCAL statement_timeout) returned None (fetch allowed) after 2.008 s. The unbounded read
    this module has now waits out the lock and answers 'fetch_global' (figures below).

    "No timeout in the code" is not "no timeout in the session". A role, a database or a
    cluster-wide default can carry statement_timeout / lock_timeout (Supabase documents a global
    default for every role without its own), and a session inherits it. Measured at eadcf8e (the
    round-2 head, before any SET LOCAL existed), one setting at a time, table locked 6 s:
    ALTER ROLE ... SET statement_timeout = '2s' -> None after 2.004 s; ALTER ROLE ... SET
    lock_timeout = '2s' -> None after 2.014 s; ALTER DATABASE ... SET statement_timeout = '2s' ->
    None after 2.009 s. At THIS head, with all three set together and the table locked 6 s, the
    read answered 'fetch_global' after 6.002 s. So the timers are set to 0 here, for THIS
    TRANSACTION ONLY
    (SET LOCAL: it dies with the transaction, so it cannot leak into a pooled connection the way
    a plain SET would; it is also why these are separate statements in the read's own transaction
    and not a connection option). The set is statement_timeout, lock_timeout,
    idle_in_transaction_session_timeout (round 4: a role value of 1 ms released the brake; it
    fires BETWEEN statements, so it is the one timer that can cancel a read that is not
    running) and, on a server that has it (PostgreSQL 17+), transaction_timeout. The last is
    gated on conn.info.server_version because naming a GUC an older server does not know is an
    ERROR, and an error here fails open: on 16 it is never sent.

    UNTESTED WHERE IT RUNS. Production is PostgreSQL 17.6 (tests/fixtures/supabase_prelude.sql),
    so the 17+ branch is the ONLY branch that executes in production, and
    `SET LOCAL transaction_timeout = 0` has never been sent to a real PostgreSQL 17 server. Every
    CI database and the box this was written on are PostgreSQL 16, where that branch cannot run.
    It is pinned only by a fake connection (the statement is issued at 170000 and not at
    169999). If a real 17 rejected the statement, every gate read in production would error and,
    on a cold cache, fail open.

    RESIDUAL, measured, not closed: the idle timer is inherited from BEGIN until the SET LOCAL
    runs, so a role value of the order of a millisecond can still fire in that gap. Measured at
    this head with ALTER ROLE ... SET idle_in_transaction_session_timeout = '1ms' and 200 cold
    reads (cache reset before each, table not locked): 19 returned None (fetch allowed) in one
    run and 17 in another; at 05042e8, before the timer was cleared, 44 of 200. That is why it
    is the FIRST SET LOCAL (the fake-connection test pins the order): each statement before it
    is another idle gap in which it can fire.

    CONSEQUENCE, stated plainly: with these timers off, a locked table stalls the worker for as
    long as the lock lasts, and "the lock" includes queue time: a reader queues behind a pending
    DDL statement that is itself waiting on an idle transaction, and nothing in THIS read bounds
    that (the other session's own timers might). Measured at this head, as a NOSUPERUSER
    NOBYPASSRLS member of stemloops_app, PostgreSQL 16.15, fetch_global=true, cold cache:
    ACCESS EXCLUSIVE held 25 s -> fetch_paused() = 'fetch_global' after 25.002 s, with a second
    thread started 2 s later blocked 23.001 s behind _lock. 25 s is the longest hold run; the
    wait is however long the lock lasts, and nothing longer was tried. Not run on PostgreSQL 17.
    That is the deliberate trade: stall and answer correctly rather than release a pulled brake. The stall is not silent: _refresh_if_stale logs
    kill_switch_read_slow while it waits. A bounded read only becomes safe once a missing or
    unreadable row counts as engaged (the fail-closed change, out of scope here).

    NOT EXHAUSTIVE, AND NOT TRYING TO BE: the policy is fail-open, so ANY read error on a cold
    cache releases the brake for fetch_global/fetch_youtube, whatever its cause. This function
    clears the timers named above and nothing else; closing the class is the fail-closed change
    (out of scope here). Of the two legs, only CONNECT is bounded (connect_timeout=3, which
    pre-dates this PR; its value is neither relied on nor tested here). The READ has no
    client-side bound, so a partition mid-read waits on the OS TCP timeouts. No test observes a
    client-side bound on the read: one above the 3.5 s the wall-clock test waits passes them all.

    `public.` is explicit: an unqualified name resolves through search_path, whose first entry
    "$user" is the LOGIN role's name, so a schema with that name holding its own kill_switches
    would silently replace this table. Measured at d739cf7 (unqualified read), with a schema named
    for the login role holding its own kill_switches that has only a fetch_cobalt row, and
    fetch_global=true in public: fetch_paused() returned None (fetch allowed) and logged nothing.
    At this head the same setup returns 'fetch_global'.
    """
    with _connect() as conn:
        # Same (implicit) transaction as the SELECT below: psycopg opens it on first execute.
        conn.execute("SET LOCAL idle_in_transaction_session_timeout = 0")
        conn.execute("SET LOCAL statement_timeout = 0")
        conn.execute("SET LOCAL lock_timeout = 0")
        if conn.info.server_version >= 170000:  # the GUC does not exist before 17: an error
            conn.execute("SET LOCAL transaction_timeout = 0")
        return conn.execute("SELECT scope, enabled FROM public.kill_switches").fetchall()


def _refresh_if_stale() -> None:
    """Refresh the cache if older than the TTL.

    `_lock` is held ACROSS the read, as it was before this PR: concurrent cold callers share one
    read (one connection, one log line) instead of each opening their own, a reader cannot write
    an older snapshot over a newer one, and `reset_cache()` waits for an in-flight read instead
    of being overwritten by its pre-reset result. Holding it is safe here because the read is
    the only thing that takes it for long and the worker's consumer runs one job at a time.
    """
    global _cache_at
    with _lock:
        now = time.monotonic()
        if _cache_at is not None and now - _cache_at < KILL_SWITCH_TTL_S:
            return
        # The read has no timeout (see _read_switches), so a locked table silences the worker for
        # as long as the lock lasts. Say so while it is happening, not only afterwards: a timer
        # that only LOGS (it never cancels or bounds the read) and is cancelled in `finally`.
        started = time.monotonic()
        slow = threading.Timer(
            KILL_SWITCH_READ_SLOW_S,
            log_structured,
            args=("WARN", "kill_switch_read_slow"),
            kwargs={
                "waited_at_least_s": KILL_SWITCH_READ_SLOW_S,
                "detail": "still reading kill_switches; the table may be locked. Not giving up: "
                "a read that gives up would release a pulled brake (fail open)",
            },
        )
        slow.daemon = True
        # The log timer is a convenience; the READ is the gate. They are in SEPARATE try blocks on
        # purpose. With `slow.start()` inside the read's own `try`, a thread that cannot start
        # ("can't start new thread" at a thread or memory limit) was handled as a FAILED READ and
        # returned before the table was ever queried: with fetch_global engaged, a healthy
        # database and a cold cache, fetch_paused() answered None (fetch allowed). Measured at 05042e8
        # (before the fix) with Timer.start patched to raise: None after 0.0 s, no query; at this
        # head the same patch returns 'fetch_global'. A failure to start the timer must cost the
        # log line and nothing else.
        try:
            slow.start()
        except Exception as exc:  # noqa: BLE001 — the read below must still run
            with contextlib.suppress(Exception):  # even a dead stderr must not skip the read
                log_structured("WARN", "kill_switch_slow_timer_unavailable", error=str(exc)[:120])
        try:
            rows = _read_switches()
        except Exception as exc:  # noqa: BLE001 — keep serving the last known state
            log_structured("WARN", "kill_switch_read_failed", error=str(exc)[:120])
            # DO NOT stamp _cache_at here. A failed read must be retried by the very next call:
            # stamping it would keep a brake the table now says is engaged OFF for a whole TTL
            # after one blip (pinned by test_one_failed_read_is_retried_by_the_next_call).
            #
            # KNOWN WEAKNESS - deliberately NOT fixed here: after a failed read we keep serving
            # the cached value INDEFINITELY, so a role that has lost SELECT freezes the switches
            # at whatever they last were, and with a COLD cache fetch_global/fetch_youtube fail
            # OPEN. Bounding the cache's age does NOT fix that: is_engaged() falls back to
            # `scope in _DEFAULT_ENGAGED`, so dropping the cache turns them into "not engaged".
            # A stale not-engaged value is unchanged, and a stale ENGAGED value (a brake an
            # operator pulled on purpose) would be RELEASED. The real fix is for a
            # missing/unreadable row to count as ENGAGED for these scopes (fail closed). That
            # needs a migration seeding the rows and carries a deploy-ordering hazard: the
            # migration must land BEFORE the worker deploys or every link job stops (this
            # project already had a ~2 h outage from exactly that coupling).
            return
        finally:
            slow.cancel()
        waited = time.monotonic() - started
        if waited >= KILL_SWITCH_READ_SLOW_S:
            log_structured("WARN", "kill_switch_read_resumed", waited_s=round(waited, 3))
        if not rows:
            # A successful read of ZERO rows. Production's table has a fetch_cobalt row, so
            # this is not the normal state: it can mean the table was emptied, OR that this
            # role cannot see the rows (a missing grant under RLS, or a dropped policy), in
            # which case a real engaged switch is invisible. A shadowing schema is NOT reliably
            # covered by this log: a shadow table that holds any row reads as non-empty and
            # logs nothing. That case is closed by the `public.` qualification in
            # _read_switches, not by this diagnostic.
            log_structured(
                "ERROR",
                "kill_switch_table_empty",
                detail="kill_switches returned 0 rows; may be empty OR unreadable by this "
                "role (permissions/RLS) - engaged switches may be invisible",
            )
        # `scope` is free text with no CHECK, so 'Fetch_Global', 'fetch_global ' (trailing space),
        # 'fetch-global' or 'global' are all accepted by the table, never match a constant above,
        # and make a non-empty read that changes no decision and logs nothing: an operator typo
        # would be silent. Name every scope this worker does not read. It rides the refresh, so
        # it is at most once per TTL. It also names scopes migration 008 documents but this
        # worker does not consume (fetch_spotify, serve_mix_first, payments_r): true for those
        # too, since setting them has no effect here.
        unread = sorted({str(scope) for scope, _ in rows} - _KNOWN_SCOPES)
        if unread:
            log_structured(
                "WARN",
                "kill_switch_unknown_scope",
                scopes=[sc[:64] for sc in unread[:20]],
                count=len(unread),
                detail="kill_switches holds scope(s) this worker never reads (typo? wrong case, "
                "stray space, '-' for '_'?); only "
                + ", ".join(sorted(_KNOWN_SCOPES))
                + " are consulted, so these rows change nothing",
            )
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
    # stamped, so a per-scope refresh would pay the failing read twice per call.
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
                conn.execute(
                    "SELECT 1 FROM public.blocklist WHERE video_id=%s", (video_id,)
                ).fetchone()
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
                "INSERT INTO public.fetch_attempts (job_id, attempt, path, exit_session_hash, "
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
