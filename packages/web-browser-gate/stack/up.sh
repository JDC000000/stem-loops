#!/usr/bin/env bash
# Bring up the LOOPBACK stack the browser journeys run against. Idempotent. Everything binds 127.0.0.1.
#   1. Postgres DB $STACK_DB: Supabase-like prelude, then the real migration runner (as migrator)
#   2. generated assets: 40 s stems for the Replicate mock, a throwaway CA + cert for the Klangio mock
#   3. fake GoTrue, moto S3 (+ bucket with CORS), Replicate and Klangio mocks
#   4. the REAL worker (apps/worker) against those mocks
#   5. apps/web: next build (skipped when STACK_SKIP_BUILD=1) and next start on $STACK_WEB_PORT
# Needs: psql, ffmpeg, openssl, curl, moto_server, $STACK_PYTHON with apps/worker's requirements + boto3,
# pnpm deps installed, and a reachable loopback Postgres superuser at $STACK_PG_ADMIN_URL (see config.sh).
# Nothing here talks to a real Supabase, R2, Replicate or Klangio; up.sh aborts if a URL is not loopback.
set -euo pipefail
source "$(dirname "$0")/config.sh"
S=$STACK_STATE
log() { echo "[up $(date +%H:%M:%S)] $*"; }

# ---- 1. database --------------------------------------------------------------------------------
for _ in $(seq 1 30); do psql "$STACK_PG_ADMIN_URL" -tAc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
psql "$STACK_PG_ADMIN_URL" -tAc 'select 1' >/dev/null || { echo "ABORT: Postgres not reachable at the admin URL" >&2; exit 1; }
if [ "$(psql "$STACK_PG_ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname='$STACK_DB'")" != "1" ]; then
  log "creating database $STACK_DB (prelude + migrations)"
  psql "$STACK_PG_ADMIN_URL" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $STACK_DB"
  psql "$STACK_PG_DB_ADMIN_URL" -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/apps/worker/tests/fixtures/supabase_prelude.sql"
  (cd "$REPO_ROOT/apps/worker" && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 NO_PROXY="$NO_PROXY" \
     DATABASE_URL="$STACK_DB_URL" PYTHONPATH=src "$STACK_PYTHON" -m worker.migrate)
fi
log "ledger rows: $(psql "$STACK_PG_DB_ADMIN_URL" -tAc 'select count(*) from public._migrations')"

# ---- 2. assets ----------------------------------------------------------------------------------
A=$S/audio T=$S/tls; mkdir -p "$A" "$T" "$S/echo"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
if [ ! -f "$A/.v1" ]; then
  D=40   # >= 8 bars at 120 BPM (the extractor's minimum) with headroom for several 4-bar loops
  ff -f lavfi -i "aevalsrc=0.6*sin(2*PI*55*t)*(0.5+0.5*sin(2*PI*2*t)):s=44100:d=$D" -ac 2 -c:a pcm_s16le "$A/bass.wav"
  ff -f lavfi -i "aevalsrc=0.9*sin(2*PI*60*t)*exp(-25*mod(t\,0.5))+0.35*(2*random(0)-1)*exp(-90*mod(t+0.25\,0.5)):s=44100:d=$D" -ac 2 -c:a pcm_s16le "$A/drums.wav"
  ff -f lavfi -i "aevalsrc=0.3*sin(2*PI*(440+40*sin(2*PI*0.5*t))*t):s=44100:d=$D" -ac 2 -c:a pcm_s16le "$A/vocals.wav"
  ff -f lavfi -i "aevalsrc=0.2*(sin(2*PI*261.63*t)+sin(2*PI*329.63*t)+sin(2*PI*392*t)):s=44100:d=$D" -ac 2 -c:a pcm_s16le "$A/guitar.wav"
  ff -f lavfi -i "aevalsrc=0.2*(sin(2*PI*196*t)+sin(2*PI*246.94*t)+sin(2*PI*293.66*t)):s=44100:d=$D" -ac 2 -c:a pcm_s16le "$A/piano.wav"
  ff -f lavfi -i "anoisesrc=d=$D:c=pink:r=44100:a=0.05" -ac 2 -c:a pcm_s16le "$A/other.wav"
  touch "$A/.v1"
fi
if [ ! -s "$T/bundle.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj "/CN=stem-loops journeys throwaway CA" \
    -keyout "$T/ca.key" -out "$T/ca.pem" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout "$T/server.key" -out "$T/server.csr" 2>/dev/null
  printf "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" > "$T/ext.cnf"
  openssl x509 -req -in "$T/server.csr" -CA "$T/ca.pem" -CAkey "$T/ca.key" -CAcreateserial -days 3 -extfile "$T/ext.cnf" -out "$T/server.pem" 2>/dev/null
  SYS=/etc/ssl/certs/ca-certificates.crt
  cat "$SYS" "$T/ca.pem" > "$T/bundle.pem"
  chmod 600 "$T/ca.key" "$T/server.key"
fi
[ -s "$GOTRUE_SECRET_FILE" ] || { openssl rand -hex 32 > "$GOTRUE_SECRET_FILE"; chmod 600 "$GOTRUE_SECRET_FILE"; }

# ---- 3. shared services -------------------------------------------------------------------------
"$STACK_DIR/stack.sh" mocks
# TLS sanity: the throwaway CA must verify the Klangio mock, and the system bundle alone must NOT.
curl -sf --noproxy '*' --cacert "$T/bundle.pem" "https://127.0.0.1:$STACK_KLANGIO_PORT/health" >/dev/null || { echo "ABORT: klangio mock TLS not verifiable with the stack bundle" >&2; exit 1; }
if curl -sf --noproxy '*' --cacert /etc/ssl/certs/ca-certificates.crt "https://127.0.0.1:$STACK_KLANGIO_PORT/health" >/dev/null 2>&1; then
  echo "ABORT: klangio mock verifies WITHOUT the throwaway CA (verification not real)" >&2; exit 1
fi
env -i PATH="$PATH" HOME="$HOME" NO_PROXY="$NO_PROXY" no_proxy="$no_proxy" STACK_S3_PORT="$STACK_S3_PORT" STACK_BUCKET="$STACK_BUCKET" "$STACK_PYTHON" - <<'PY'
import os, boto3
s3 = boto3.client("s3", endpoint_url=f"http://127.0.0.1:{os.environ['STACK_S3_PORT']}", aws_access_key_id="test",
                  aws_secret_access_key="test", region_name="us-east-1")
b = os.environ["STACK_BUCKET"]
if b not in [x["Name"] for x in s3.list_buckets().get("Buckets", [])]:
    s3.create_bucket(Bucket=b)
s3.put_bucket_cors(Bucket=b, CORSConfiguration={"CORSRules": [{"AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedOrigins": ["*"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"]}]})
print("[up] bucket", b, "ready")
PY

# ---- 4. worker ----------------------------------------------------------------------------------
if [ -f "$S/pids/worker.pid" ] && kill -0 "$(cat "$S/pids/worker.pid")" 2>/dev/null; then log "worker already running"
else "$STACK_DIR/stack.sh" worker; fi

# ---- 5. web -------------------------------------------------------------------------------------
WEB_ENV=(PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 NO_PROXY="$NO_PROXY" no_proxy="$no_proxy"
  NEXT_TELEMETRY_DISABLED=1
  NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:$STACK_GOTRUE_PORT"
  NEXT_PUBLIC_SUPABASE_ANON_KEY=local-dummy-anon-key SUPABASE_SERVICE_ROLE_KEY=local-dummy-service-key
  DATABASE_URL="$STACK_DB_URL"
  MINIO_ENDPOINT="http://127.0.0.1:$STACK_S3_PORT"
  R2_ACCESS_KEY_ID=test R2_SECRET_ACCESS_KEY=test R2_BUCKET_NAME="$STACK_BUCKET" R2_ACCOUNT_ID=local
  IP_HASH_KEY=local-ip-hash-key-0123456789abcdef HISTORY_COOKIE_KEY=local-history-cookie-key-0123456789
  # The link box, as in production (j10 drives the link sign-in-first flow; /api/jobs link POSTs
  # are intercepted there, so the server-side ALLOW_YOUTUBE_INPUT stays off in the stack).
  NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT=true
  NEXT_PUBLIC_DEMO_ASSET_BASE=)   # only the web's loopback configuration; nothing from the calling shell
W=$STACK_WEB_DIR
if [ -z "${STACK_SKIP_BUILD:-}" ]; then
  log "next build in $W"
  (cd "$W" && env -i "${WEB_ENV[@]}" ./node_modules/.bin/next build >"$S/logs/next-build.log" 2>&1) || { tail -40 "$S/logs/next-build.log" >&2; exit 1; }
fi
[ -f "$W/.next/BUILD_ID" ] || { echo "ABORT: no next build in $W" >&2; exit 1; }
# The served bundle must carry the loopback auth URL and no real Supabase project ref.
grep -rqs "127.0.0.1:$STACK_GOTRUE_PORT" "$W/.next/server" || { echo "ABORT: loopback Supabase URL not baked into the build" >&2; exit 1; }
if grep -rlqs -e qthrhamfljhifhfwvvwj -e ylzokjwnsraehmpclnkx "$W/.next"; then echo "ABORT: real Supabase project ref found in the build" >&2; exit 1; fi
if stack_listening "$STACK_WEB_PORT"; then
  [ -f "$S/pids/web.pid" ] && kill -0 "$(cat "$S/pids/web.pid")" 2>/dev/null || { echo "ABORT: port $STACK_WEB_PORT busy by another process" >&2; exit 1; }
  log "web already running on $STACK_WEB_PORT"
else
  (cd "$W" && stack_start_bg web env -i "${WEB_ENV[@]}" ./node_modules/.bin/next start -H 127.0.0.1 -p "$STACK_WEB_PORT")
  stack_wait_port "$STACK_WEB_PORT" 90
fi
"$STACK_PYTHON" "$STACK_DIR/listeners.py"
log "stack up: web http://127.0.0.1:$STACK_WEB_PORT  db $STACK_DB  state $S"
