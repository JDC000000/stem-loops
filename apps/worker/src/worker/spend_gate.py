"""The `spend_global` brake: checked by `consumer.claim_and_run` BEFORE a job is claimed.

WHY HERE AND NOT IN `fetch_gates`. `fetch_gates` guards the LINK path only (the one place
`kill_switches` was ever consulted) and fails OPEN. This brake guards the spend itself, which
both input paths and both paid providers (Replicate, Klangio) reach only through a claimed job,
and it fails CLOSED. Different failure policy, different module, so a change to one cannot
flip the other.

DECISION RULE (one place, stated once). The brake is RELEASED only when this process read
exactly one `spend_global` row and its `enabled` is FALSE. EVERYTHING else is ENGAGED:

    row enabled = true                       -> engaged  (reason: switch_engaged)
    no row                                   -> engaged  (reason: row_absent)
        covers: migration 034 not applied yet, RLS policy dropped on the table
        (the read succeeds and returns zero rows), row deleted by hand
    any error reading it                     -> engaged  (reason: read_failed)
        covers: REVOKE SELECT, statement_timeout, lock_timeout, connect failure
    the read did not finish in WALL_TIMEOUT_S -> engaged  (reason: read_timeout)

NO CACHE, ON PURPOSE. The previous gate cached its last answer for 30 s and, on a failed
read, kept serving the cached "not engaged" forever (measured: still fetching at +1, +10, +60
and +1440 minutes after SELECT was revoked). Here every claim attempt reads the row afresh
(one primary-key lookup per poll, every POLL_INTERVAL = 2 s while idle), so there is nothing
to latch. The bound on "the database stopped showing us the switch" is therefore ONE claim
attempt: the next call to `claim_and_run` after the loss refuses, i.e. within one poll interval
(2 s) plus the remaining run time of any job already in flight on that worker, plus at most
WALL_TIMEOUT_S for the read to give up.

THE READ ITSELF IS BOUNDED so a held lock cannot hang the poll loop (the reaper and the
retention sweep run in the same loop): connect_timeout, a server-side statement_timeout and
lock_timeout inside the read's own transaction, and an outer asyncio wall-clock bound.

PRE-MIGRATION WINDOW. If the worker is deployed before migration 034, the row is absent, so
the brake reads ENGAGED: the consumer does not crash, spends nothing, and claims nothing until
the migration is applied (jobs stay `queued`). That is deliberate and is why the deploy order
is migration first. It is indistinguishable, from here, from "RLS hid the row", and that
second case is exactly what fail-closed must catch.

IN-FLIGHT JOBS. The brake stops NEW claims. A job already claimed runs to completion: at most
one paid Replicate prediction and one Klangio request per worker are already committed to by
then, and cancelling them mid-flight would strand a paid prediction. `cli.py test-job`
(operator-run, bypasses the queue) is not gated either.

The query is schema-qualified (`public.kill_switches`) and runs with `search_path = pg_catalog`,
so a same-named table in another schema (including one named after the login role, which
`"$user"` would resolve first) cannot be read in its place.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import psycopg

from .logger import log_structured

SCOPE_SPEND_GLOBAL = "spend_global"

CONNECT_TIMEOUT_S = 3
# Server-side bound on the read (applied with SET LOCAL, so it cannot leak to other statements).
READ_TIMEOUT_MS = 2000
# Outer bound if the server-side ones do not fire (network black hole after connect).
WALL_TIMEOUT_S = 5.0
# An engaged brake logs on every state change and then at most this often.
LOG_EVERY_S = 60.0


@dataclass(frozen=True)
class BrakeState:
    engaged: bool
    reason: str  # released | switch_engaged | row_absent | read_failed | read_timeout


_last_engaged: bool | None = None
_last_logged_at: float | None = None
_last_reason: str | None = None


def reset_log_state() -> None:
    """Test hook: forget the last logged state."""
    global _last_engaged, _last_logged_at, _last_reason
    _last_engaged = _last_logged_at = _last_reason = None


async def _read(dsn: str) -> BrakeState:
    async with (
        await psycopg.AsyncConnection.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S) as conn,
        conn.transaction(),
    ):
        await conn.execute(
            "SELECT set_config('statement_timeout', %s, true),"
            " set_config('lock_timeout', %s, true),"
            " set_config('search_path', 'pg_catalog', true)",
            (str(READ_TIMEOUT_MS), str(READ_TIMEOUT_MS)),
        )
        cur = await conn.execute(
            "SELECT enabled FROM public.kill_switches WHERE scope = %s",
            (SCOPE_SPEND_GLOBAL,),
        )
        rows = await cur.fetchall()
    if not rows:
        return BrakeState(True, "row_absent")
    return (
        BrakeState(True, "switch_engaged")
        if rows[0][0] is not False
        else BrakeState(False, "released")
    )


def _note(state: BrakeState, error: str | None) -> None:
    """Log engaged-ness changes, and re-log a standing engaged brake at most once a minute."""
    global _last_engaged, _last_logged_at, _last_reason
    now = time.monotonic()
    changed = state.engaged != _last_engaged or state.reason != _last_reason
    due = _last_logged_at is None or now - _last_logged_at >= LOG_EVERY_S
    if state.engaged and (changed or due):
        extra = {"error": error[:160]} if error else {}
        log_structured("WARN", "spend_brake_engaged", reason=state.reason, **extra)
        _last_logged_at = now
    elif not state.engaged and _last_engaged:
        log_structured("INFO", "spend_brake_released")
        _last_logged_at = now
    _last_engaged, _last_reason = state.engaged, state.reason


async def brake_state(dsn: str) -> BrakeState:
    """Current brake state. Never raises: any failure is ENGAGED."""
    error: str | None = None
    try:
        state = await asyncio.wait_for(_read(dsn), timeout=WALL_TIMEOUT_S)
    except TimeoutError:
        state, error = BrakeState(True, "read_timeout"), f"no answer in {WALL_TIMEOUT_S}s"
    except Exception as exc:  # noqa: BLE001 — every failure to read is "engaged"
        state, error = BrakeState(True, "read_failed"), f"{type(exc).__name__}: {exc}"
    _note(state, error)
    return state
