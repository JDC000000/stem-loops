"""The house exit-code contract for every CI gate in this repo.

ONE definition, imported by every gate. Not four constants copied into each
script with a test that checks the copies agree -- dev-playbook L39 rule 3: a
duplicated expression is not pinned by a copy of itself, and the strongest fix
is to delete one of them.

    0  CHECKED, no drift. The ONLY success.
    1  CHECKED, drift found. The thing the gate watches for is real.
    2  ATTEMPTED AND FAILED. Something was reached and the check could not be
       finished: unreachable host, auth refused, a missing table or ledger, a
       provider error, a malformed credential, the gate itself crashing.
       NEVER forgivable.
    3  NOT ATTEMPTED. A required input is absent -- no DATABASE_URL, no API
       secret -- so no comparison was made. A configuration state, never
       success. Forgivable ONLY by a caller-side switch, never by a flag on the
       script.

WHY 2 AND 3 ARE SEPARATE, which is the whole point of this file.

A caller cannot implement "tolerate unconfigured, but never tolerate broken"
when unconfigured and broken share one code. That is exactly why the drift
gate grew an in-script `--allow-unreachable` flag, and that flag is where five
consecutive review rounds found false greens: it decided what to forgive by
reading libpq's error messages, which are localized and whose full set is not
knowable. Splitting the codes moves the policy to the caller, where it belongs
and where it is visible in the workflow file.

It is also dev-playbook L40 rule 2 expressed as an exit code: "could not reach
it" and "reached it and could not read it" must not share an outcome.

WHY THIS FILE EXISTS AT ALL. Until 2026-11-07 the two gates disagreed:
`check_migration_drift.py` used 2 for "cannot determine" (its name was
EXIT_UNKNOWN) while `check_credit_pack_prices.py` used 2 for "broken" and 3
for "not checked". So "I could not check" was 2 in one gate and 3 in the
other, in the same repo, both in CI, both read by a person looking at a red
job. Adversarial review of the recon gate recommended standardising on the
four-code scheme and fixing the drift gate before it merged, while doing so
cost no CI churn.

ADDING A GATE. Import these; do not define your own. If a gate needs a
distinction these four cannot express, change this file and both suites --
that is the conversation worth having, and it happens once rather than per
script.
"""

from __future__ import annotations

EXIT_OK = 0
EXIT_DRIFT = 1
EXIT_BROKEN = 2
EXIT_NOT_CHECKED = 3

# A gate reporting a FINDING must never use a code a crash can produce.
# Python exits 1 on an uncaught exception, and 1 here means "drift found", so
# every gate wraps its entry point and returns EXIT_BROKEN on an unexpected
# exception. The drift gate shipped that bug: every crash was reported to its
# caller as drift.
__all__ = ["EXIT_BROKEN", "EXIT_DRIFT", "EXIT_NOT_CHECKED", "EXIT_OK"]
