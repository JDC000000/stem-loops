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
# axe-core is optional (j8 runs its manual checks without it); set JOURNEY_AXE to an axe.min.js to enable.
cd "$PKG_DIR" && exec node journeys/run.mjs "$@"
