#!/usr/bin/env bash
# JOURNEY_MINT_CMD: mint a signed-in user for <email> in the stack DB; prints {cookie,user_id,...} JSON.
set -euo pipefail
source "$(dirname "$0")/config.sh"
exec env -i PATH="$PATH" HOME="$HOME" NO_PROXY="$NO_PROXY" no_proxy="$no_proxy" \
  STACK_PG_DB_ADMIN_URL="$STACK_PG_DB_ADMIN_URL" GOTRUE_SECRET_FILE="$GOTRUE_SECRET_FILE" \
  "$STACK_PYTHON" "$STACK_DIR/mint_session.py" "$1" --json
