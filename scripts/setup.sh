#!/usr/bin/env bash
# One-time per-clone setup. Idempotent — safe to re-run.
#
# Right now, the only thing this does is point git at the repo-committed
# pre-commit hook path (.githooks/) so R-1 fires on every commit without a
# dev needing to copy anything into .git/hooks/.
#
# Run from the repo root:
#   bash scripts/setup.sh
#
# After this the hook runs automatically on `git commit`. Bypass once with
# SKIP_PRECOMMIT=1 git commit ... (see .githooks/pre-commit for contract).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "setup: configuring git core.hooksPath → .githooks"
git config core.hooksPath .githooks

# Make sure the hook is executable (needed on fresh checkouts on some
# filesystems that don't preserve the x bit — git usually does, but be
# explicit).
chmod +x .githooks/pre-commit

echo "setup: done. R-1 pre-commit guard is active."
echo "setup: bypass once with SKIP_PRECOMMIT=1 git commit ..."
