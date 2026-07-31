"""Hardening H7: an error code must exist everywhere, or the user sees generic copy.

UPLOAD_INVALID / UPLOAD_TOO_LARGE were raised on the live upload path but were in
neither models.ERROR_CODES nor the frontend's copy map, so a user who uploaded an
unsupported file got "something went wrong" instead of the specific, already-written
guidance. These tests close the loop across the raise site, the type contract and
the user-facing copy so the next code added can't drift the same way.
"""

import os
import re

import pytest

from worker.errors import ALL_ERROR_CODES
from worker.models import ERROR_CODES

# apps/worker/tests/ -> apps/web/src/lib/error-copy.ts
ERROR_COPY_TS = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "web", "src", "lib", "error-copy.ts")
)


def _copy_codes() -> set[str]:
    with open(ERROR_COPY_TS) as f:
        body = f.read()
    return set(re.findall(r"^\s{2}([A-Z_]+):\s*\{", body, re.MULTILINE))


def test_every_raisable_error_is_in_the_type_contract():
    missing = ALL_ERROR_CODES - ERROR_CODES
    assert not missing, f"raised by errors.py but absent from models.ERROR_CODES: {missing}"


def test_upload_validation_codes_are_present():
    """Explicit guard for the two codes H7 found missing."""
    assert {"UPLOAD_INVALID", "UPLOAD_TOO_LARGE"} <= ERROR_CODES


@pytest.mark.skipif(not os.path.exists(ERROR_COPY_TS), reason="web app not checked out")
def test_every_contract_error_has_user_facing_copy():
    missing = ERROR_CODES - _copy_codes()
    assert not missing, f"no entry in apps/web/src/lib/error-copy.ts for: {missing}"


@pytest.mark.skipif(not os.path.exists(ERROR_COPY_TS), reason="web app not checked out")
def test_no_orphan_copy_entries():
    """Copy for a code nothing can emit is dead weight and a sign of drift."""
    orphans = _copy_codes() - ERROR_CODES
    assert not orphans, f"error-copy.ts has entries for unknown codes: {orphans}"
