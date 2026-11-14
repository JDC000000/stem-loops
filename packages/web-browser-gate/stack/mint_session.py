"""Create (or reuse) a test user in the stack's LOCAL DB and print a session for the fake GoTrue.
usage: python3 mint_session.py <email> [--json]
  - inserts auth.users (the on_auth_user_created trigger seeds public.users, exactly as on Supabase)
  - mints an HS256 session signed with $STACK_STATE/gotrue_secret (fake_gotrue.py verifies it)
  - prints `sb-127-auth-token=base64-...` (chunked .0/.1 like @supabase/ssr when > 3180 chars)
Connects with STACK_PG_DB_ADMIN_URL (a superuser on the journeys DB); it must be loopback.
"""
import base64, json, os, sys, uuid
from urllib.parse import urlsplit
import psycopg

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fake_gotrue  # noqa: E402  (reads GOTRUE_SECRET_FILE at import)

url = os.environ["STACK_PG_DB_ADMIN_URL"]
if urlsplit(url).hostname not in ("127.0.0.1", "localhost", "::1"):
    sys.exit("ABORT: STACK_PG_DB_ADMIN_URL is not loopback")
email = sys.argv[1].lower()
with psycopg.connect(url) as c:
    row = c.execute("SELECT id FROM auth.users WHERE email=%s", (email,)).fetchone()
    uid = str(row[0]) if row else str(uuid.uuid4())
    if not row:
        c.execute("INSERT INTO auth.users (id, email, aud, role, email_confirmed_at) VALUES (%s,%s,'authenticated','authenticated',now())", (uid, email))
    if not c.execute("SELECT id FROM public.users WHERE id=%s", (uid,)).fetchone():
        raise SystemExit("public.users row was not seeded by the auth trigger")
    c.commit()
sess = fake_gotrue.session_for({"sub": uid, "email": email, "aud": "authenticated", "role": "authenticated"})
val = "base64-" + base64.urlsafe_b64encode(json.dumps(sess, separators=(",", ":")).encode()).decode().rstrip("=")
name = "sb-127-auth-token"
if len(val) <= 3180:
    cookie = f"{name}={val}"
else:
    parts = [val[i:i + 3180] for i in range(0, len(val), 3180)]
    cookie = "; ".join(f"{name}.{i}={p}" for i, p in enumerate(parts))
if "--json" in sys.argv:
    print(json.dumps({"user_id": uid, "email": email, "cookie": cookie, "access_token": sess["access_token"]}))
else:
    print(cookie)
