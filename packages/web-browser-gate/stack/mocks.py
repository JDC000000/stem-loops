"""Fault-injectable Replicate and Klangio mocks for the browser-journey stack. LOOPBACK ONLY.
  python mocks.py replicate  -> http://127.0.0.1:$MOCK_PORT (up.sh: 54323)
  python mocks.py klangio    -> https://127.0.0.1:$MOCK_PORT (up.sh: 54324; TLS with the stack's throwaway CA)
Runtime control (no restart):  POST /__ctl  {"key": value, ...}   GET /__ctl -> current modes
Replicate modes:
  status: succeeded | failed | processing_forever
  output: fixed (the stack's generated 40 s 120 BPM stems) | echo (serve the job's OWN normalized input as every
          stem, so the extractor sees the user's real audio) | five (echo minus 'other') |
          missing404 (stem URLs that 404)
Klangio modes:
  submit_http: 200 | 503 (every submit POST answers this status)
  status: COMPLETED | FAILED | IN_PROGRESS_FOREVER
  payload: default | empty_list | empty_body | junk
"""
import json, os, ssl, sys, time, uuid, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

STEMS = ["drums", "bass", "vocals", "guitar", "piano", "other"]
AUDIO_DIR = os.environ.get("MOCK_AUDIO_DIR", "")
ECHO_DIR = os.environ["MOCK_ECHO_DIR"]
os.makedirs(ECHO_DIR, exist_ok=True)
PREDS: dict = {}
CTL = {"status": "succeeded", "output": "fixed", "submit_http": 200, "kstatus": "COMPLETED", "payload": "default"}
NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def now_iso(): return time.strftime("%Y-%m-%dT%H:%M:%S.000000Z", time.gmtime())

class Base(BaseHTTPRequestHandler):
    tag = "mock"
    def log_message(self, fmt, *a):
        sys.stderr.write(f"{time.strftime('%H:%M:%S')} {self.tag} {self.command} {self.path[:120]} -> {a[1] if len(a)>1 else ''}\n"); sys.stderr.flush()
    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def _raw(self, code, b, ct="application/json"):
        self.send_response(code); self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""
    def _ctl(self):
        if self.command == "POST":
            CTL.update(json.loads(self._body() or b"{}"))
            sys.stderr.write(f"{time.strftime('%H:%M:%S')} {self.tag} CTL now {CTL}\n")
        return self._json(200, CTL)

class Replicate(Base):
    tag = "replicate-mock"
    def _pred(self, pid):
        p = PREDS[pid]
        mode = p["_mode"]
        age = time.time() - p["_t"]
        if p["status"] == "canceled":
            st = "canceled"
        elif age < 2 or mode["status"] == "processing_forever":
            st = "processing"
        else:
            st = mode["status"]
        out = {k: v for k, v in p.items() if not k.startswith("_")}
        out["status"] = st
        out["started_at"] = p["created_at"]
        if st == "succeeded":
            host = f"http://127.0.0.1:{self.server.server_port}"
            o = mode["output"]
            if o == "fixed":
                out["output"] = {s: f"{host}/files/{s}.wav" for s in STEMS}
            elif o == "echo":
                out["output"] = {s: f"{host}/echo/{pid}/{s}.wav" for s in STEMS}
            elif o == "five":
                out["output"] = {s: f"{host}/echo/{pid}/{s}.wav" for s in STEMS if s != "other"}
            elif o == "missing404":
                out["output"] = {s: f"{host}/files/gone-{s}.wav" for s in STEMS}
            out["metrics"] = {"predict_time": 3.21}
            out["completed_at"] = now_iso()
        elif st == "failed":
            out["error"] = "mock failure"; out["completed_at"] = now_iso()
            out["metrics"] = {"predict_time": 1.0}
        return out
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/__ctl": return self._ctl()
        if path.startswith("/files/"):
            fp = os.path.join(AUDIO_DIR, os.path.basename(path))
            if not os.path.isfile(fp): return self._json(404, {"detail": "no such file"})
            return self._raw(200, open(fp, "rb").read(), "audio/wav")
        if path.startswith("/echo/"):
            pid = path.split("/")[2]
            fp = os.path.join(ECHO_DIR, pid + ".bin")
            if not os.path.isfile(fp): return self._json(404, {"detail": "no echo"})
            return self._raw(200, open(fp, "rb").read(), "audio/wav")
        if not self.headers.get("Authorization", "").startswith("Token "):
            return self._json(401, {"detail": "Unauthenticated"})
        if path.startswith("/v1/predictions/"):
            pid = path.rsplit("/", 1)[1]
            if pid not in PREDS: return self._json(404, {"detail": "Not found."})
            return self._json(200, self._pred(pid))
        if path == "/v1/predictions":
            return self._json(200, {"results": [self._pred(k) for k in PREDS], "next": None})
        self._json(404, {"detail": "not implemented"})
    def do_POST(self):
        path = urlsplit(self.path).path
        if path == "/__ctl": return self._ctl()
        body = self._body()
        if not self.headers.get("Authorization", "").startswith("Token "):
            return self._json(401, {"detail": "Unauthenticated"})
        if path == "/v1/predictions":
            req = json.loads(body or b"{}")
            pid = "mock" + uuid.uuid4().hex[:18]
            audio = req.get("input", {}).get("audio", "")
            mode = dict(CTL)
            PREDS[pid] = {"id": pid, "version": req.get("version"), "input": req.get("input", {}),
                          "status": "starting", "created_at": now_iso(), "_t": time.time(), "_mode": mode, "urls": {}}
            nbytes = -1
            if mode["output"] in ("echo", "five") and audio.startswith("http://127.0.0.1"):
                try:
                    data = NOPROXY.open(audio, timeout=60).read(); nbytes = len(data)
                    open(os.path.join(ECHO_DIR, pid + ".bin"), "wb").write(data)
                except Exception as e:
                    sys.stderr.write(f"replicate-mock echo fetch failed {e!r}\n")
            sys.stderr.write(f"{time.strftime('%H:%M:%S')} replicate-mock created {pid} mode={mode['status']}/{mode['output']} echo_bytes={nbytes} audio={audio[:80]}\n")
            return self._json(201, self._pred(pid) | {"status": "starting"})
        if path.startswith("/v1/predictions/") and path.endswith("/cancel"):
            pid = path.split("/")[3]
            if pid in PREDS:
                PREDS[pid]["status"] = "canceled"
                sys.stderr.write(f"{time.strftime('%H:%M:%S')} replicate-mock canceled {pid}\n")
                return self._json(200, self._pred(pid))
            return self._json(404, {"detail": "Not found."})
        self._json(404, {"detail": "not implemented"})

DEFAULT_CHORDS = [[0.0, 2.0, "C:maj"], [2.0, 4.0, "G:maj"], [4.0, 6.0, "A:min"], [6.0, 8.0, "F:maj"],
                  [8.0, 10.0, "C:maj"], [10.0, 12.0, "G:maj"]]
KJOBS: dict = {}

class Klangio(Base):
    tag = "klangio-mock"
    def _auth(self):
        if not self.headers.get("kl-api-key"):
            self._json(401, {"detail": "missing kl-api-key"}); return False
        return True
    def do_POST(self):
        path = urlsplit(self.path).path
        if path == "/__ctl": return self._ctl()
        body = self._body()
        if not self._auth(): return
        if path == "/chord-recognition":
            code = int(CTL.get("submit_http", 200))
            if code != 200:
                sys.stderr.write(f"{time.strftime('%H:%M:%S')} klangio-mock submit -> injected {code} bytes={len(body)}\n")
                return self._json(code, {"detail": "injected upstream error"})
            jid = "kl_" + uuid.uuid4().hex[:16]
            KJOBS[jid] = (time.time(), dict(CTL))
            sys.stderr.write(f"{time.strftime('%H:%M:%S')} klangio-mock submit {jid} bytes={len(body)}\n")
            return self._json(200, {"job_id": jid, "status": "IN_QUEUE"})
        self._json(404, {"detail": "not implemented"})
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health": return self._json(200, {"ok": True})
        if path == "/__ctl": return self._ctl()
        if not self._auth(): return
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "job" and parts[1] in KJOBS:
            t0, mode = KJOBS[parts[1]]
            if parts[2] == "status":
                ks = mode.get("kstatus", "COMPLETED")
                if ks == "IN_PROGRESS_FOREVER" or time.time() - t0 < 1:
                    return self._json(200, {"status": "IN_PROGRESS"})
                if ks == "FAILED": return self._json(200, {"status": "FAILED", "error": "mock failure"})
                return self._json(200, {"status": "COMPLETED"})
            if parts[2] == "json":
                pl = mode.get("payload", "default")
                if pl == "empty_list": return self._json(200, [])
                if pl == "empty_body": return self._raw(200, b"")
                if pl == "junk": return self._json(200, {"unexpected": True})
                return self._json(200, DEFAULT_CHORDS)
        self._json(404, {"detail": "not found"})

if __name__ == "__main__":
    which = sys.argv[1]
    if which == "replicate":
        srv = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("MOCK_PORT", "54323"))), Replicate)
        print(f"replicate-mock mock on http://127.0.0.1:{srv.server_port}", flush=True)
    elif which == "klangio":
        srv = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("MOCK_PORT", "54324"))), Klangio)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(os.environ["KLANGIO_TLS_CERT"], os.environ["KLANGIO_TLS_KEY"])
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        print(f"klangio-mock mock on https://127.0.0.1:{srv.server_port}", flush=True)
    else:
        sys.exit("usage: mocks.py replicate|klangio")
    srv.serve_forever()
