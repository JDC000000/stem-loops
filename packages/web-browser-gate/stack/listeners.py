"""Print the stack's listening TCP sockets from /proc/net/tcp{,6}; exit 1 if any is not loopback.
Postgres is not checked: in CI it is a service container whose published port the runner owns."""
import os, socket, struct, sys

E = os.environ
PORTS = {int(E["STACK_GOTRUE_PORT"]): "fake-gotrue",
         int(E["STACK_S3_PORT"]): "moto-s3", int(E["STACK_REPLICATE_PORT"]): "replicate-mock",
         int(E["STACK_KLANGIO_PORT"]): "klangio-mock(tls)", int(E["STACK_WEB_PORT"]): "web"}
bad = 0
for fn, fam in (("/proc/net/tcp", 4), ("/proc/net/tcp6", 6)):
    if not os.path.exists(fn):
        continue
    for ln in open(fn).readlines()[1:]:
        f = ln.split(); addr, port = f[1].split(":")
        if f[3] != "0A":
            continue
        port = int(port, 16)
        if port not in PORTS:
            continue
        if fam == 4:
            ip = socket.inet_ntoa(struct.pack("<I", int(addr, 16)))
        else:
            b = bytes.fromhex(addr); ip = socket.inet_ntop(socket.AF_INET6, b"".join(b[i:i + 4][::-1] for i in range(0, 16, 4)))
        lo = ip.startswith("127.") or ip in ("::1", "::ffff:127.0.0.1")
        bad += not lo
        print(f"  {'ok ' if lo else 'BAD'} {ip}:{port}  {PORTS[port]}")
sys.exit(1 if bad else 0)
