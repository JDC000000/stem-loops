#!/usr/bin/env bash
# Run the browser journeys against the stack up.sh started. Args = journey id prefixes (none = all).
# Evidence (screenshots, result.json, summary.md) goes to packages/web-browser-gate/.evidence/.
set -euo pipefail
source "$(dirname "$0")/config.sh"
export JOURNEY_BASE_URL=http://127.0.0.1:$STACK_WEB_PORT
export JOURNEY_DB_URL=$STACK_DB_URL
export JOURNEY_MINT_CMD=$STACK_DIR/mint.sh
export JOURNEY_STACK_CMD=$STACK_DIR/stack.sh
export JOURNEY_EVIDENCE_DIR=${JOURNEY_EVIDENCE_DIR:-$PKG_DIR/.evidence}
# axe-core drives j8's four accessibility scans. It is a devDependency of this package, so
# resolve it by default rather than leaving it to the caller: j8 FAILS when JOURNEY_AXE is
# unset or names a missing file, because a scan that silently does not run is the one failure
# this gate cannot afford. Override JOURNEY_AXE to point at a different build.
if [ -z "${JOURNEY_AXE:-}" ]; then
  JOURNEY_AXE=$(cd "$PKG_DIR" && node -p "require.resolve('axe-core/axe.min.js')" 2>/dev/null) || {
    echo "ABORT: cannot resolve axe-core/axe.min.js from $PKG_DIR -- run pnpm install" >&2; exit 1; }
fi
export JOURNEY_AXE
cd "$PKG_DIR" && exec node journeys/run.mjs "$@"
