# Sourced by every stack script. One place for the loopback stack's ports, paths and URLs.
# Everything binds 127.0.0.1. Override any variable from the environment.
STACK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PKG_DIR=$(cd "$STACK_DIR/.." && pwd)
REPO_ROOT=$(cd "$PKG_DIR/../.." && pwd)
export STACK_DIR PKG_DIR REPO_ROOT
export STACK_STATE=${STACK_STATE:-$PKG_DIR/.stack-state}
export STACK_PYTHON=${STACK_PYTHON:-python3}
# Postgres: the CI job's service container (superuser stemloops) on 55432. Locally, start your own
# throwaway cluster on that port, or point STACK_PG_ADMIN_URL at one. Never a remote database.
export STACK_PG_ADMIN_URL=${STACK_PG_ADMIN_URL:-postgresql://stemloops:stemloops@127.0.0.1:55432/stemloops}
export STACK_DB=${STACK_DB:-journeys}
_pg_base=${STACK_PG_ADMIN_URL%/*}
export STACK_PG_DB_ADMIN_URL=${STACK_PG_DB_ADMIN_URL:-$_pg_base/$STACK_DB}
_pg_hostport=${_pg_base##*@}
export STACK_DB_URL=${STACK_DB_URL:-postgresql://migrator:migrator@$_pg_hostport/$STACK_DB}
export STACK_BUCKET=${STACK_BUCKET:-stem-loops-journeys}
export STACK_WEB_PORT=${STACK_WEB_PORT:-3104}
export STACK_GOTRUE_PORT=54321 STACK_S3_PORT=54322 STACK_REPLICATE_PORT=54323 STACK_KLANGIO_PORT=54324
# The web app to serve. Default: this checkout's apps/web, built by up.sh.
export STACK_WEB_DIR=${STACK_WEB_DIR:-$REPO_ROOT/apps/web}
export GOTRUE_SECRET_FILE=$STACK_STATE/gotrue_secret
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
mkdir -p "$STACK_STATE/logs" "$STACK_STATE/pids"

stack_listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
stack_wait_port() { for _ in $(seq 1 "${2:-60}"); do stack_listening "$1" && return 0; sleep 1; done; echo "port $1 never came up" >&2; return 1; }
stack_start_bg() { # name cmd...   (own process group, so stop can kill the whole tree)
  local name=$1; shift
  setsid nohup "$@" >>"$STACK_STATE/logs/$name.log" 2>&1 </dev/null & echo $! >"$STACK_STATE/pids/$name.pid"
}
stack_stop() { # name
  local pf=$STACK_STATE/pids/$1.pid
  [ -f "$pf" ] || return 0
  local p; p=$(cat "$pf")
  if kill -0 "$p" 2>/dev/null; then kill -TERM -- -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; sleep 2; fi
  rm -f "$pf"
}
stack_assert_loopback_url() { # name url
  case "$2" in
    http://127.0.0.1:*|https://127.0.0.1:*|postgresql://*@127.0.0.1:*|postgresql://*@localhost:*) ;;
    *) echo "ABORT: $1 is not loopback" >&2; exit 1;;
  esac
}
stack_assert_loopback_url STACK_PG_ADMIN_URL "$STACK_PG_ADMIN_URL"
stack_assert_loopback_url STACK_DB_URL "$STACK_DB_URL"
