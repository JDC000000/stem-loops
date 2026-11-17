#!/usr/bin/env bash
# JOURNEY_STACK_CMD for the browser journeys, and the process control up.sh uses.
#   stack.sh mocks              start fake GoTrue, moto S3 and the Replicate/Klangio mocks if down
#   stack.sh worker [K=V ...]   (re)start the REAL worker against the mocks, with extra env
#   stack.sh stopworker         stop the worker (journeys use this for the "queued" state)
#   stack.sh ctl '<json>'       set fault-injection modes on both mocks (see mocks.py)
#   stack.sh down               stop everything this stack started (not Postgres)
set -euo pipefail
source "$(dirname "$0")/config.sh"
S=$STACK_STATE
case "${1:-}" in
mocks)
  stack_listening $STACK_GOTRUE_PORT || { stack_start_bg gotrue env GOTRUE_PORT=$STACK_GOTRUE_PORT GOTRUE_SECRET_FILE="$GOTRUE_SECRET_FILE" "$STACK_PYTHON" -u "$STACK_DIR/fake_gotrue.py"; stack_wait_port $STACK_GOTRUE_PORT; }
  stack_listening $STACK_S3_PORT || { stack_start_bg moto moto_server -H 127.0.0.1 -p $STACK_S3_PORT; stack_wait_port $STACK_S3_PORT; }
  stack_listening $STACK_REPLICATE_PORT || { stack_start_bg replicate env -i PATH="$PATH" MOCK_PORT=$STACK_REPLICATE_PORT MOCK_AUDIO_DIR="$S/audio" MOCK_ECHO_DIR="$S/echo" "$STACK_PYTHON" -u "$STACK_DIR/mocks.py" replicate; stack_wait_port $STACK_REPLICATE_PORT; }
  stack_listening $STACK_KLANGIO_PORT || { stack_start_bg klangio env -i PATH="$PATH" MOCK_PORT=$STACK_KLANGIO_PORT MOCK_ECHO_DIR="$S/echo" KLANGIO_TLS_CERT="$S/tls/server.pem" KLANGIO_TLS_KEY="$S/tls/server.key" "$STACK_PYTHON" -u "$STACK_DIR/mocks.py" klangio; stack_wait_port $STACK_KLANGIO_PORT; }
  echo "mocks up: gotrue:$STACK_GOTRUE_PORT s3:$STACK_S3_PORT replicate:$STACK_REPLICATE_PORT klangio(tls):$STACK_KLANGIO_PORT";;
ctl)
  curl -sS --noproxy '*' -X POST -d "$2" "http://127.0.0.1:$STACK_REPLICATE_PORT/__ctl"; echo
  curl -sS --noproxy '*' --cacert "$S/tls/bundle.pem" -X POST -d "$2" "https://127.0.0.1:$STACK_KLANGIO_PORT/__ctl"; echo;;
stopworker)
  stack_stop worker; echo "worker stopped";;
worker)
  shift; stack_stop worker
  mkdir -p "$S/tmp-worker"; WL=$S/logs/worker.log; touch "$WL"; n0=$(wc -l <"$WL")
  # Clean environment: nothing from the calling shell (proxy, real API URLs, keys) reaches the worker.
  # run_worker.py refuses to start if any configured endpoint is not loopback.
  (cd "$REPO_ROOT/apps/worker" && stack_start_bg worker env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 \
     NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
     PYTHONPATH="$REPO_ROOT/apps/worker/src" \
     DATABASE_URL="$STACK_DB_URL" \
     R2_ENDPOINT_URL="http://127.0.0.1:$STACK_S3_PORT" R2_ACCESS_KEY_ID=test R2_SECRET_ACCESS_KEY=test \
     R2_BUCKET_NAME="$STACK_BUCKET" AWS_DEFAULT_REGION=auto \
     REPLICATE_API_TOKEN=dummy-local-replicate-token REPLICATE_MOCK_URL="http://127.0.0.1:$STACK_REPLICATE_PORT/v1" \
     REPLICATE_DEADLINE="${REPLICATE_DEADLINE:-8}" \
     KLANGIO_API_KEY=dummy-local-klangio-key KLANGIO_API_BASE="https://127.0.0.1:$STACK_KLANGIO_PORT" \
     KLANGIO_QUOTA_BACKEND=postgres KLANGIO_MIN_REQUEST_INTERVAL_SEC=0 KLANGIO_POLL_INTERVAL_SEC=1 \
     SSL_CERT_FILE="$S/tls/bundle.pem" REQUESTS_CA_BUNDLE="$S/tls/bundle.pem" \
     WORKER_TMP_ROOT="$S/tmp-worker" \
     "$@" \
     "$STACK_PYTHON" -u "$STACK_DIR/run_worker.py")
  for _ in $(seq 1 20); do tail -n +$((n0 + 1)) "$WL" | grep -q 'preflight OK' && break; sleep 1; done
  kill -0 "$(cat "$S/pids/worker.pid")" 2>/dev/null || { echo "ABORT: worker died" >&2; tail -20 "$WL" >&2; exit 1; }
  tail -n +$((n0 + 1)) "$WL" | grep 'preflight OK' | tail -1;;
down)
  for f in "$S"/pids/*.pid; do [ -e "$f" ] && stack_stop "$(basename "$f" .pid)"; done; echo "stack stopped";;
*) echo "usage: stack.sh mocks|worker [K=V..]|stopworker|ctl <json>|down" >&2; exit 2;;
esac
