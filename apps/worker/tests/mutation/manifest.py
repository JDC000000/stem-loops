"""The mutation manifest: every "this test kills that mutant" claim of the retention PR, as data.

WHY THIS EXISTS. Four rounds of review found every false claim in this PR's docstrings and body
by RUNNING MUTANTS, and none by reading patch lists: a sentence saying a test "kills" something
is prose until a mutant demonstrates it, and prose goes stale the moment the code moves.
This file is the claims, executable. Each entry is

    id            a stable name
    file          the file mutated, relative to apps/worker (or apps/web for suite="web")
    anchor        text that must occur EXACTLY ONCE in that file
    replacement   what it is replaced with (the file must still compile / import)
    killers       test ids; at least one must FAIL BY A CLEAN ASSERTION on the mutant
    claim         the sentence this entry demonstrates, and where it is made

`tests/test_mutation_manifest.py` (fast, runs in the normal suite) fails when an anchor no longer
occurs exactly once, a mutant does not compile, an id repeats, or a named killer test does not
exist. `tests/mutation/run_mutants.py` (about 15-40 s per mutant; NOT in the normal suite) applies
each mutant to a private copy of the tree, runs its killers against a fresh database, and fails
when a mutant SURVIVES. A crash is not a kill: only a clean assertion failure counts, because a
mutant that merely breaks the harness (an ImportError, a connection error) proves nothing about
the test that was meant to catch it. See `run_mutants.py --help`.

SURVIVORS ARE DATA TOO. `SURVIVORS` lists mutants that are EXPECTED to survive, with the reason;
the runner fails if one dies, so an "equivalent in practice" claim is also checked.

MAINTAINING IT. Add an entry with the change that adds the claim. When #214 (or any change to
`cleanup.py` / `r2_uploader.py`) moves an anchor, `test_mutation_manifest.py` goes red and names
the entry; re-anchor it, then run the runner. That is the point.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Mutant:
    id: str
    file: str
    anchor: str
    replacement: str
    killers: tuple[str, ...]
    claim: str
    suite: str = "worker"
    # Extra environment for the killer run (a mutant of a CI-only behaviour, say).
    env: dict = field(default_factory=dict, hash=False, compare=False)


CL = "src/worker/cleanup.py"
R2 = "src/worker/storage/r2_uploader.py"
CO = "src/worker/consumer.py"

_R = "tests/test_retention_real_r2.py::"
_W = "tests/test_consumer_sweep_wiring.py::"
_H = "tests/test_real_r2_harness.py::"

T_EVERY = _R + "test_expired_job_loses_every_prefixed_shape_even_when_its_objects_are_young"
T_CHORDS_YOUNG = _R + "test_expired_job_loses_its_chords_object_even_when_young"
T_CHARGED = _R + "test_credit_charged_job_shell_keeps_none_of_its_objects"
T_ORPHAN = _R + "test_orphan_backstop_uses_the_real_list_and_delete_helpers"
T_PAGES = _R + "test_delete_prefix_pages_through_more_than_one_listing_page"
T_STATUS = _R + "test_failed_jobs_are_swept_and_inflight_jobs_wait_out_their_grace"
T_BLIND = _R + "test_orphan_backstop_is_not_blind_past_the_first_1000_keys_of_the_bucket"
T_LISTMANY = _R + "test_list_objects_older_than_collects_across_pages_and_honours_its_limit"
T_DP_RAISES = _R + "test_delete_prefix_raises_when_one_delete_fails_and_does_not_report_success"
T_RETRY = _R + "test_a_failed_r2_delete_keeps_the_expired_jobs_row_and_is_retried_after_the_backoff"
T_SHELL_FAIL = _R + "test_a_failed_r2_delete_never_anonymises_a_credit_charged_shell"
T_BACKOFF = (
    _R + "test_repeated_failures_back_off_exponentially_then_report_stuck_and_clear_on_success"
)
T_ANON_FORGET = (
    _R + "test_a_credit_charged_shell_that_finally_succeeds_is_forgotten_not_counted_stuck"
)
T_SCRATCH = _R + "test_the_sweep_removes_stale_scratch_dirs_of_user_audio"
T_DO_RAISES = _R + "test_delete_objects_raises_when_one_delete_fails_and_does_not_report_success"
T_ORPHAN_FAIL = (
    _R + "test_a_failed_orphan_delete_is_logged_and_never_counted_then_retried_next_sweep"
)
T_CHAIN = _W + "test_poll_loop_startup_sweep_removes_an_expired_jobs_objects_from_real_r2"
T_STARTUP_SCRATCH = _W + "test_poll_loop_removes_stale_scratch_dirs_at_startup_itself"
T_CADENCE = _W + "test_poll_loop_sweeps_once_at_startup_then_every_cleanup_interval"
T_BUSY = _W + "test_a_worker_that_is_always_busy_still_sweeps_every_interval"
T_DEFAULT_INTERVAL = _W + "test_the_default_sweep_interval_is_fifteen_minutes"
T_CLEANUP_NOT_RESELECTED = (
    "tests/test_cleanup.py::test_anonymised_shell_is_not_reselected_so_it_cannot_starve_the_batch"
)
T_CLEANUP_PRUNE = (
    "tests/test_cleanup.py::test_credit_charged_job_is_anonymised_and_later_jobs_still_swept"
)
T_INTERVAL_ENV = _W + "test_retention_sweep_seconds_overrides_the_default_interval"

_BK = "return min(MAX_BACKOFF_SECONDS, 900 * (2 ** (failures - 1)))"
_PAGINATE = ".paginate(Bucket=bucket, Prefix=prefix)"
_SKIP = "skip = [jid for jid, (_n, until) in _failed.items() if until > now]"

MUTANTS: tuple[Mutant, ...] = (
    # ------------------------------------------------------------------ the per-job delete
    Mutant(
        "delete_prefix_noop",
        R2,
        '            client.delete_object(Bucket=bucket, Key=obj["Key"])\n            deleted += 1',
        "            deleted += 1",
        (T_EVERY, T_CHARGED, T_PAGES),
        "PR body, What: `delete_prefix` deletes nothing (round 1).",
    ),
    Mutant(
        "sweep_deletes_only_input",
        CL,
        'delete_prefix, f"{job_id}/")',
        'delete_prefix, f"{job_id}/_input")',
        (T_EVERY, T_CHARGED),
        "PR body, What: the sweep deletes only `<id>/_input*` (round 1).",
    ),
    *(
        Mutant(
            f"prefix_truncated_{k}",
            R2,
            _PAGINATE,
            f"{_PAGINATE[:-1]}[:{k}])",
            (T_EVERY,),
            "Round 4, 2a: `Prefix=prefix[:k]` deletes another job's audio. The expired and the "
            "live job differ in their last hex digit, so any k from 1 to 35 matches both.",
        )
        for k in (1, 2, 4, 8, 35)
    ),
    Mutant(
        "prefix_empty",
        R2,
        _PAGINATE,
        '.paginate(Bucket=bucket, Prefix="")',
        (T_EVERY,),
        'Round 3 body: `delete_prefix` `Prefix=""` (deletes the bucket; the live control dies).',
    ),
    Mutant(
        "delete_prefix_swallows_errors",
        R2,
        '            client.delete_object(Bucket=bucket, Key=obj["Key"])\n            deleted += 1',
        '            try:\n                client.delete_object(Bucket=bucket, Key=obj["Key"])\n'
        "            except Exception:\n                pass\n            deleted += 1",
        (T_DP_RAISES, T_RETRY),
        "Round 3 body, S2: `delete_prefix` swallows `delete_object` errors.",
    ),
    # ------------------------------------------------------------ the orphan backstop helpers
    Mutant(
        "delete_objects_noop",
        R2,
        "    for key in keys:\n        client.delete_object(Bucket=bucket, Key=key)\n    return len(keys)",
        "    for key in keys:\n        pass\n    return len(keys)",
        (T_ORPHAN,),
        "Round 1: `delete_objects` deletes nothing.",
    ),
    Mutant(
        "delete_objects_swallows_errors",
        R2,
        "    for key in keys:\n        client.delete_object(Bucket=bucket, Key=key)\n    return len(keys)",
        "    for key in keys:\n        try:\n            client.delete_object(Bucket=bucket, Key=key)\n"
        "        except Exception:\n            pass\n    return len(keys)",
        (T_DO_RAISES, T_ORPHAN_FAIL),
        "Round 3 body, S3: `delete_objects` swallows `delete_object` errors.",
    ),
    Mutant(
        "list_older_lists_nothing",
        R2,
        'if obj["LastModified"] < cutoff:',
        "if False:",
        (T_ORPHAN, T_LISTMANY, T_BLIND),
        "`test_orphan_backstop_uses_the_real_list_and_delete_helpers` docstring: "
        "`list_objects_older_than` listing nothing.",
    ),
    Mutant(
        "list_older_ignores_cutoff",
        R2,
        'if obj["LastModified"] < cutoff:',
        "if True:",
        (T_ORPHAN, T_LISTMANY),
        "Same docstring: `list_objects_older_than` ignoring the cutoff.",
    ),
    Mutant(
        "list_older_stops_after_page_one",
        R2,
        "                    return keys\n    return keys\n",
        "                    return keys\n        return keys\n    return keys\n",
        (T_BLIND, T_LISTMANY),
        "PR body, round 1 table: `list_objects_older_than` returns after the first page.",
    ),
    Mutant(
        "list_older_ignores_limit",
        R2,
        "if len(keys) >= limit:",
        "if False:",
        (T_LISTMANY,),
        "`test_list_objects_older_than_collects_across_pages_and_honours_its_limit`.",
    ),
    # --------------------------------------------------------------- the sweep's own queries
    Mutant(
        "failed_status_dropped",
        CL,
        "status IN ('done','failed')",
        "status IN ('done')",
        (T_STATUS,),
        "PR body, round 1 table: dropping 'failed' from the status list.",
    ),
    *(
        Mutant(
            f"inflight_grace_{g}_minutes",
            CL,
            'INFLIGHT_GRACE = "1 hour"',
            f'INFLIGHT_GRACE = "{g} minutes"',
            (T_STATUS,),
            "PR body, round 3: the in-flight grace is bracketed (55 min kept, 65 min swept), "
            "so a grace outside (55, 65) minutes dies.",
        )
        for g in (25, 54, 66, 119)
    ),
    Mutant(
        "sweep_removes_stale_scratch_call",
        CL,
        "    await asyncio.to_thread(tmpdirs.sweep_stale)\n",
        "",
        (T_SCRATCH,),
        "`test_the_sweep_removes_stale_scratch_dirs_of_user_audio`: deleting that call.",
    ),
    Mutant(
        "database_url_env_name",
        CL,
        'DATABASE_URL = os.environ.get("DATABASE_URL", "")',
        'DATABASE_URL = os.environ.get("DATABASE_URI", "")',
        (T_CHAIN,),
        "Round 3 body, S1: `cleanup.DATABASE_URL` reads a different variable. The chain test "
        "dies by assertion.",
    ),
    # --------------------------------------------------------------------- failure and backoff
    Mutant(
        "backoff_inf",
        CL,
        _BK,
        'return float("inf")',
        (T_RETRY, T_BACKOFF),
        "Round 3 body, S2: `_backoff_seconds` returns inf.",
    ),
    Mutant(
        "backoff_zero",
        CL,
        _BK,
        "return 0.0",
        (T_RETRY, T_BACKOFF),
        "Round 3 body, S2: `_backoff_seconds` returns 0.",
    ),
    Mutant(
        "backoff_base_600",
        CL,
        "900 * (2 ** (failures - 1))",
        "600 * (2 ** (failures - 1))",
        (T_RETRY, T_BACKOFF),
        "Round 3 body, S2: 900 -> 600 s.",
    ),
    Mutant(
        "backoff_base_9000",
        CL,
        "900 * (2 ** (failures - 1))",
        "9000 * (2 ** (failures - 1))",
        (T_RETRY, T_BACKOFF),
        "Round 3 body, S2: 900 -> 9000 s.",
    ),
    Mutant(
        "backoff_no_skip",
        CL,
        _SKIP,
        "skip = []",
        (T_RETRY, T_BACKOFF),
        "Round 3 body, S2: backed-off jobs are not skipped.",
    ),
    Mutant(
        "backoff_not_recorded",
        CL,
        "_failed[job_id] = (n, time.monotonic() + _backoff_seconds(n))",
        "pass",
        (T_RETRY, T_BACKOFF, T_SHELL_FAIL),
        "Round 3 body, S2: `_record_failure` records nothing.",
    ),
    Mutant(
        "backoff_cap_1800",
        CL,
        "MAX_BACKOFF_SECONDS = 6 * 3600",
        "MAX_BACKOFF_SECONDS = 1800",
        (T_BACKOFF,),
        "Round 4, 3b: the third interval (3600 s) is pinned; a 1800 s cap dies.",
    ),
    Mutant(
        "backoff_exponent_capped",
        CL,
        _BK,
        "return min(MAX_BACKOFF_SECONDS, 900 * (2 ** min(failures - 1, 1)))",
        (T_BACKOFF,),
        "Round 4, 3b: an exponent capped so the third backoff is 1800 s.",
    ),
    Mutant(
        "backoff_inf_after_third_failure",
        CL,
        _BK,
        'return float("inf") if failures > 3 else min(MAX_BACKOFF_SECONDS, '
        "900 * (2 ** (failures - 1)))",
        (T_BACKOFF,),
        "Round 4, 2b: an R2 outage spanning four attempts skips the job for ever.",
    ),
    Mutant(
        "skip_forever_after_three_failures",
        CL,
        _SKIP,
        "skip = [jid for jid, (_n, until) in _failed.items() if until > now or _n > 3]",
        (T_BACKOFF,),
        "Round 4, 2b: a skip list that permanently includes a job with > 3 failures.",
    ),
    Mutant(
        "failed_pop_removed_on_delete",
        CL,
        "            await conn.commit()\n            _failed.pop(job_id, None)\n            swept += 1",
        "            await conn.commit()\n            swept += 1",
        (T_BACKOFF,),
        "Round 3 body: `_failed.pop` removal on the DELETE path.",
    ),
    Mutant(
        "failed_pop_removed_on_anonymise",
        CL,
        "        _failed.pop(job_id, None)\n        anonymised += 1",
        "        anonymised += 1",
        (T_ANON_FORGET,),
        "Round 4, 3a: `_failed.pop` removal on the ANONYMISE path (the "
        "round 3 body listed only one of the two sites).",
    ),
    # ------------------------------------------------------------------------ the poll loop
    Mutant(
        "consumer_sweep_bound_to_stub",
        CO,
        "from .cleanup import sweep_expired",
        "async def sweep_expired() -> dict:\n    return {}",
        (T_CHAIN,),
        "PR body, the block (round 2): `consumer.py` binds `sweep_expired` to a stub.",
    ),
    Mutant(
        "safe_sweep_never_sweeps",
        CO,
        '        await sweep_expired()\n    except Exception as e:  # noqa: BLE001\n        log_structured("ERROR", "retention_sweep_error"',
        '        return\n    except Exception as e:  # noqa: BLE001\n        log_structured("ERROR", "retention_sweep_error"',
        (T_CHAIN, T_CADENCE),
        "Round 1: `_safe_sweep` returns before sweeping.",
    ),
    Mutant(
        "startup_sweep_removed",
        CO,
        "    await _safe_reap()\n    await _safe_sweep()\n    last_reap",
        "    await _safe_reap()\n    last_reap",
        (T_CADENCE, T_CHAIN),
        "`test_consumer_sweep_wiring.py`: the startup sweep removed.",
    ),
    Mutant(
        "poll_loop_startup_scratch_sweep_removed",
        CO,
        '        await asyncio.to_thread(tmpdirs.sweep_stale)\n    except Exception as e:  # noqa: BLE001\n        log_structured("ERROR", "tmp_sweep_error"',
        '        pass\n    except Exception as e:  # noqa: BLE001\n        log_structured("ERROR", "tmp_sweep_error"',
        (T_STARTUP_SCRATCH,),
        "Round 3 body: deleting the `tmpdirs.sweep_stale` call from " "`poll_loop`'s startup.",
    ),
    Mutant(
        "cleanup_interval_default_7200",
        CO,
        'os.environ.get("RETENTION_SWEEP_SECONDS", "900")',
        'os.environ.get("RETENTION_SWEEP_SECONDS", "7200")',
        (T_DEFAULT_INTERVAL,),
        "PR body, round 1 table: `CLEANUP_INTERVAL` default 900 -> 7200.",
    ),
    Mutant(
        "cleanup_interval_env_renamed",
        CO,
        'os.environ.get("RETENTION_SWEEP_SECONDS", "900")',
        'os.environ.get("RETENTION_SWEEP_SECOND", "900")',
        (T_INTERVAL_ENV,),
        "Round 3 body: `RETENTION_SWEEP_SECONDS` renamed.",
    ),
    Mutant(
        "periodic_sweep_only_when_idle",
        CO,
        "        if time.monotonic() - last_cleanup >= CLEANUP_INTERVAL:",
        "        if not claimed and time.monotonic() - last_cleanup >= CLEANUP_INTERVAL:",
        (T_BUSY,),
        "PR body, round 1 table: the periodic sweep only runs when nothing was claimed.",
    ),
    Mutant(
        "orphan_cutoff_zero",
        CL,
        "timedelta(seconds=RETENTION_SECONDS)",
        "timedelta(seconds=0)",
        (T_ORPHAN,),
        "Round 3 body: orphan cutoff 0.",
    ),
    Mutant(
        "orphan_cutoff_double",
        CL,
        "timedelta(seconds=RETENTION_SECONDS)",
        "timedelta(seconds=RETENTION_SECONDS * 2)",
        (T_ORPHAN,),
        "Round 3 body: orphan cutoff 2x.",
    ),
    Mutant(
        "orphans_inverted",
        CL,
        "orphans = [k for k in keys if _job_id_of(k) not in live]",
        "orphans = [k for k in keys if _job_id_of(k) in live]",
        (T_ORPHAN,),
        "Round 3 body: inverted orphan test.",
    ),
    Mutant(
        "orphan_deadline_guard_off",
        CL,
        "if time.monotonic() < deadline:\n            try:",
        "if False:\n            try:",
        (T_ORPHAN,),
        "Round 3 body: deadline guard `if False`.",
    ),
    Mutant(
        "upload_prune_sign_flipped",
        CL,
        "created_at < now() - (%s * interval '1 second')",
        "created_at > now() - (%s * interval '1 second')",
        (T_CLEANUP_PRUNE,),
        "Round 3 body: upload-event prune sign.",
    ),
    Mutant(
        "purged_shell_filter_removed",
        CL,
        '"  AND client_ip_hash <> %s "',
        '"  AND (client_ip_hash <> %s OR TRUE) "',
        (T_CLEANUP_NOT_RESELECTED,),
        "Round 3 body: purged-shell filter.",
    ),
    Mutant(
        "where_expires_30h_in_future",
        CL,
        '"WHERE expires_at < now() "',
        "\"WHERE expires_at < now() + interval '30 hours' \"",
        (T_EVERY, T_ORPHAN),
        "Round 3 body: `WHERE expires_at < now() + 30 h`.",
    ),
    Mutant(
        "orphan_error_log_removed",
        CL,
        'log_structured("ERROR", "retention_orphan_sweep_failed", error=str(e)[:200])',
        "pass",
        (T_ORPHAN_FAIL,),
        "Round 3 body: orphan error log removed.",
    ),
    Mutant(
        "r2_delete_removed_from_sweep",
        CL,
        'await asyncio.to_thread(delete_prefix, f"{job_id}/")',
        "pass",
        (T_CHAIN,),
        "Round 3 body: R2-first delete removed.",
    ),
    Mutant(
        "list_older_than_inverted",
        R2,
        'if obj["LastModified"] < cutoff:',
        'if obj["LastModified"] > cutoff:',
        (T_ORPHAN, T_LISTMANY),
        "Round 3 body: `list_objects_older_than` `<` -> `>`.",
    ),
    Mutant(
        "r2_bucket_env_name",
        R2,
        '    bucket = os.environ["R2_BUCKET_NAME"]\n    client = _r2()\n    deleted = 0',
        '    bucket = os.environ["R2_BUCKET"]\n    client = _r2()\n    deleted = 0',
        (T_CHARGED, T_RETRY, T_CHAIN),
        "Round 3 body: `R2_BUCKET_NAME` env name.",
    ),
    Mutant(
        "delete_objects_count_plus_one",
        R2,
        "    return len(keys)\n",
        "    return len(keys) + 1\n",
        (T_ORPHAN,),
        "Round 3 body: `delete_objects` count off by one.",
    ),
    Mutant(
        "list_limit_off_by_one",
        R2,
        "if len(keys) >= limit:",
        "if len(keys) >= limit + 1:",
        (T_LISTMANY,),
        "Round 3 body: list limit off by one.",
    ),
    Mutant(
        "last_cleanup_not_reset",
        CO,
        "            await _safe_sweep()\n            last_cleanup = time.monotonic()",
        "            await _safe_sweep()",
        (T_CADENCE,),
        "Round 3 body: `last_cleanup` not reset.",
    ),
    Mutant(
        "sweep_not_awaited",
        CO,
        "        await sweep_expired()",
        "        sweep_expired()",
        (T_CHAIN, T_CADENCE),
        "Round 3 body: `sweep_expired()` not awaited.",
    ),
    # --------------------------------------------------- the database guard (Task 1, round 4)
    Mutant(
        "guard_body_removed",
        "tests/real_r2.py",
        '    refuse_unless_local(("DATABASE_URL", url), ("cleanup.DATABASE_URL", cleanup.DATABASE_URL))\n',
        "    pass\n",
        (_H + "test_the_sweeps_own_database_url_is_checked_too",),
        "Round 4, Task 1: `require_database()` refuses a non-local database. With the call "
        "removed, only the direct test notices: conftest.py is a second layer that would still skip the child run.",
    ),
    Mutant(
        "guard_is_a_substring_test",
        "tests/db_guard.py",
        "    environ = os.environ if environ is None else environ\n    try:",
        '    if any(h in (url or "") for h in ("127.0.0.1", "localhost")):\n        return None\n'
        '    return "substring said no"\n    environ = os.environ if environ is None else environ\n    try:',
        (_H + "test_a_database_that_is_not_local_is_refused",),
        'Round 4, Task 1: the round-3 `ledger_user` test (`"127.0.0.1" in url`) accepts '
        "`postgres://u@prod/db?application_name=127.0.0.1`.",
    ),
    Mutant(
        "guard_ignores_the_sweeps_own_url",
        "tests/real_r2.py",
        '("cleanup.DATABASE_URL", cleanup.DATABASE_URL)',
        '("cleanup.DATABASE_URL", url)',
        (_H + "test_the_sweeps_own_database_url_is_checked_too",),
        "Round 4, Task 1: the sweep connects with `cleanup.DATABASE_URL`, not the variable "
        "as it is now.",
    ),
    Mutant(
        "guard_ignores_pghost",
        "tests/db_guard.py",
        'host = info.get("host") or environ.get("PGHOST") or ""',
        'host = info.get("host") or ""',
        (_H + "test_a_url_without_a_host_is_judged_by_the_environment_libpq_will_consult",),
        "Round 4, Task 1: a URL with no host connects to `PGHOST`.",
    ),
    Mutant(
        "guard_accepts_everything",
        "tests/db_guard.py",
        "    environ = os.environ if environ is None else environ\n    try:",
        "    return None\n    environ = os.environ if environ is None else environ\n    try:",
        (
            _H + "test_a_database_that_is_not_local_is_refused",
            _H + "test_pre_existing_db_tests_skip_on_a_non_local_database",
        ),
        "Round 4, Task 1 (widened): a guard that admits everything fails.",
    ),
    Mutant(
        "guard_refuses_everything",
        "tests/db_guard.py",
        "    environ = os.environ if environ is None else environ\n    try:",
        '    return "refused"\n    environ = os.environ if environ is None else environ\n    try:',
        (
            _H + "test_a_local_database_is_accepted",
            _H + "test_pre_existing_db_tests_still_run_on_this_runs_local_database",
        ),
        "Round 4, Task 1 (widened): a guard that admits nothing fails; CI's URL must still run.",
        env={
            "CI": "true"
        },  # a refuse-everything guard SKIPS locally; under CI it FAILS, which is visible
    ),
    Mutant(
        "conftest_guard_removed",
        "tests/conftest.py",
        "    if url and _module_uses_database(str(request.node.fspath)):",
        "    if False:",
        (
            _H + "test_pre_existing_db_tests_skip_on_a_non_local_database",
            _H + "test_pre_existing_db_tests_fail_under_ci_on_a_non_local_database",
        ),
        "Round 4, Task 1 (widened): without the conftest guard the pre-existing DB tests that "
        "are not in test_cleanup.py connect.",
    ),
    # ------------------------------------------------------------------------------ web
    *(
        Mutant(
            f"web_{name}_expiry_predicate_removed",
            f"src/app/api/jobs/{path}",
            anchor,
            anchor.replace(" AND expires_at > now()", ""),
            (f"test/job-routes-expiry.test.mjs::{test}",),
            f"PR body, `job-routes-expiry.test.mjs`: dropping `AND expires_at > now()` from {name}.",
            suite="web",
        )
        for name, path, anchor, test in (
            (
                "job",
                "[id]/route.ts",
                "FROM jobs WHERE id = $1 AND expires_at > now()`",
                "GET /api/jobs/:id: an EXPIRED job",
            ),
            (
                "stems",
                "[id]/stems/route.ts",
                "FROM jobs WHERE id = $1 AND expires_at > now()`",
                "GET /api/jobs/:id/stems: an EXPIRED",
            ),
            (
                "play_chords",
                "[id]/play-chords/route.ts",
                "FROM jobs WHERE id = $1 AND expires_at > now()`",
                "GET /api/jobs/:id/play-chords: an EXPIRED",
            ),
            (
                "loops",
                "[id]/loops/route.ts",
                "FROM jobs WHERE id = $1 AND expires_at > now()`",
                "GET /api/jobs/:id/loops: an EXPIRED",
            ),
        )
    ),
    Mutant(
        "web_job_ttl_is_the_full_window",
        "src/app/api/jobs/[id]/route.ts",
        "presignTtlSec(job.expires_at)",
        "presignTtlSec(null)",
        (
            "test/job-routes-expiry.test.mjs::GET /api/jobs/:id: a live job is 200 and its signed URL",
        ),
        "web test header: replacing the job route's TTL with the full window.",
        suite="web",
    ),
    Mutant(
        "web_stems_ttl_unclamped",
        "src/app/api/jobs/[id]/stems/route.ts",
        "Math.min(STEM_SIGNED_URL_TTL_SEC, Math.max(1, remainingSec))",
        "STEM_SIGNED_URL_TTL_SEC",
        ("test/job-routes-expiry.test.mjs::GET /api/jobs/:id/stems: a URL never outlives",),
        "web test: the stems TTL is bounded by what the job has left.",
        suite="web",
    ),
    Mutant(
        "web_play_chords_ttl_24h",
        "src/lib/r2.ts",
        "export const PLAY_CHORDS_SIGNED_URL_TTL_SEC = 300;",
        "export const PLAY_CHORDS_SIGNED_URL_TTL_SEC = 86400;",
        ("test/job-routes-expiry.test.mjs::GET /api/jobs/:id/play-chords: a live job gets a URL",),
        "web test: the play-chords URL's real TTL equals the advertised 300 s.",
        suite="web",
    ),
)


@dataclass(frozen=True)
class Survivor:
    """A mutant that is EXPECTED to survive. The runner fails if it dies (the claim is stale)."""

    id: str
    file: str
    anchor: str
    replacement: str
    tests: tuple[str, ...]  # run these; none may fail
    why: str
    suite: str = "worker"


SURVIVORS: tuple[Survivor, ...] = (
    Survivor(
        "prefix_truncated_36",
        R2,
        _PAGINATE,
        _PAGINATE[:-1] + "[:36])",
        (T_EVERY, T_PAGES),
        "EQUIVALENT: `prefix[:36]` is the job id without its trailing slash. No other uuid starts "
        "with these 36 characters, so no neighbour is reachable. The slash itself is not pinned.",
    ),
    Survivor(
        "main_stops_starting_poll_loop",
        "src/worker/main.py",
        "await asyncio.gather(server.serve(), poll_loop())",
        "await asyncio.gather(server.serve())",
        ("tests/",),
        "NOT COVERED, and the PR's chain test cannot see it: it calls `consumer.poll_loop()` "
        "itself, so nothing runs `main.py`. If the worker process stopped starting the poll loop "
        "no retention sweep would ever run and the whole suite stays green. Run with `--full` "
        "(this survives the FULL worker suite, not just the retention files). Closing it needs "
        "a test of `main.py`'s startup, which is outside a tests-only change to retention.",
    ),
    Survivor(
        "inflight_grace_56_minutes",
        CL,
        'INFLIGHT_GRACE = "1 hour"',
        'INFLIGHT_GRACE = "56 minutes"',
        (T_STATUS,),
        "TOLERANCE, by design: the grace is bracketed between 55 and 65 minutes, so 56 survives "
        "(round 3 body). Timing noise is seconds; the bracket is not tightened to the minute.",
    ),
    Survivor(
        "inflight_grace_64_minutes",
        CL,
        'INFLIGHT_GRACE = "1 hour"',
        'INFLIGHT_GRACE = "64 minutes"',
        (T_STATUS,),
        "TOLERANCE, by design: see inflight_grace_56_minutes.",
    ),
)
