#!/usr/bin/env python3
"""Run the mutation manifest: apply each mutant to a PRIVATE COPY of the tree and see whether its
named tests kill it by a clean assertion failure.

    cd apps/worker
    PYTHONPATH=src:. python -m tests.mutation.run_mutants --admin-url postgresql://u:p@localhost:5432/postgres

    --ids a,b        only these mutants (default: all, then the expected survivors)
    --suite worker|web|all
    --jobs N         parallel workers (default 2; each gets its own database)
    --sentinel       run the five retention test files per mutant instead of just the killers,
                     and report every clean failure (about 45 s per mutant)
    --list           print the manifest and exit

WHAT THE RULES ARE (each one exists because a past round got it wrong):
  * the anchor must occur EXACTLY ONCE in the pristine file, else the entry is stale (exit 2);
  * the mutant must compile, and the number of test cases run must equal the pristine run's for
    the same tests (a mutant must not change what is collected);
  * ONLY A CLEAN ASSERTION FAILURE IS A KILL. A killer that errors in setup, or fails with an
    ImportError / connection error / anything that is not an assertion, is reported CRASH and
    counts as a SURVIVOR. (Round 3's S1 was "13 failed", of which 12 were crashes and one was
    an assertion.) The classification is in `classify_junit` and is itself tested.
  * the pristine tree is never modified: mutants are applied to a copy in a temp directory, a
    fresh Postgres database is cloned for every mutant, and the runner hashes `src/`, `tests/`
    (and `apps/web/src`, `apps/web/test`) before and after and fails if anything changed.
  * the pristine killers must PASS before any mutant is judged, or a kill proves nothing.
  * the admin database must be LOCAL, by the same check the tests use (`database_url_problem`).

Exit status: 0 all mutants killed and all expected survivors survived; 1 otherwise; 2 stale
manifest (an anchor does not occur exactly once, or a mutant does not compile).
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import contextlib
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

WORKER = Path(__file__).resolve().parents[2]
WEB = WORKER.parent / "web"
FIVE_FILES = (
    "tests/test_retention_real_r2.py",
    "tests/test_consumer_sweep_wiring.py",
    "tests/test_real_r2_harness.py",
    "tests/test_cleanup.py",
    "tests/test_consumer.py",
)
CLEAN_PREFIXES = ("assert", "AssertionError", "Failed:")


def root_of(suite: str) -> Path:
    return WEB if suite == "web" else WORKER


def tree_hash(*roots: Path) -> str:
    """sha256 over every file under the given directories (path + content), pycache excluded."""
    h = hashlib.sha256()
    for root in roots:
        for p in sorted(root.rglob("*")):
            if p.is_file() and "__pycache__" not in p.parts and "node_modules" not in p.parts:
                h.update(str(p).encode())
                h.update(hashlib.sha256(p.read_bytes()).digest())
    return h.hexdigest()


def pristine_hash() -> str:
    return tree_hash(WORKER / "src", WORKER / "tests", WEB / "src", WEB / "test")


# ------------------------------------------------------------------ classifying a result


def classify_junit(xml_text: str) -> dict[str, str]:
    """{test id (classname::name): 'pass' | 'skip' | 'clean' | 'crash'} from a junit report.

    'clean' is a test BODY that failed on an assertion (an `assert`, an `AssertionError`, or
    `pytest.fail`/`Failed:`). 'crash' is everything else that went red: an error in setup or
    teardown, or a failure whose exception is not an assertion (OperationalError, ImportError,
    a timeout...). Only 'clean' counts as a kill.
    """
    out: dict[str, str] = {}
    for tc in ET.fromstring(xml_text).iter("testcase"):
        key = f"{tc.get('classname', '')}::{tc.get('name', '')}"
        failure, error, skipped = tc.find("failure"), tc.find("error"), tc.find("skipped")
        if error is not None:
            out[key] = "crash"
        elif failure is not None:
            msg = (failure.get("message") or "").lstrip()
            out[key] = "clean" if msg.startswith(CLEAN_PREFIXES) else "crash"
        elif skipped is not None:
            out[key] = "skip"
        else:
            out[key] = "pass"
    return out


def node_matches(node: str, key: str) -> bool:
    """Does a junit key ('tests.test_x.Class::name') belong to a node id ('tests/test_x.py::name')?"""
    path, _, name = node.partition("::")
    mod = (path[:-3] if path.endswith(".py") else path.rstrip("/")).replace("/", ".")
    kmod, _, kname = key.partition("::")
    base = kname.split("[", 1)[0]
    return kmod.startswith(mod) and (name == "" or base == name)


def verdict(killers: tuple[str, ...], results: dict[str, str]) -> str:
    """KILLED | CRASH | SURVIVED | MISSING for one mutant, given its junit classification."""
    seen = {k: r for k, r in results.items() if any(node_matches(n, k) for n in killers)}
    if not seen:
        return "MISSING"
    if any(r == "clean" for r in seen.values()):
        return "KILLED"
    if any(r == "crash" for r in seen.values()):
        return "CRASH"
    return "SURVIVED"


# ------------------------------------------------------------------------------ database


class Databases:
    def __init__(self, admin_url: str, tag: str):
        import psycopg

        self.psycopg = psycopg
        self.admin_url = admin_url
        self.tag = tag
        self.template = f"mut_tpl_{tag}"

    def _admin(self):
        return self.psycopg.connect(self.admin_url, autocommit=True)

    def url_for(self, name: str) -> str:
        info = self.psycopg.conninfo.conninfo_to_dict(self.admin_url)
        info["dbname"] = name
        return self.psycopg.conninfo.make_conninfo(**info)

    def build_template(self) -> None:
        with self._admin() as c:
            c.execute(f'DROP DATABASE IF EXISTS "{self.template}"')
            c.execute(f"CREATE DATABASE \"{self.template}\" TEMPLATE template0 ENCODING 'UTF8'")
        env = dict(
            os.environ, DATABASE_URL=self.url_for(self.template), PYTHONPATH=str(WORKER / "src")
        )
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        done = subprocess.run(
            [sys.executable, "-B", "-m", "worker.migrate"],
            cwd=WORKER,
            env=env,
            capture_output=True,
            text=True,
        )
        if done.returncode:
            raise SystemExit(
                f"migrating the template database failed:\n{done.stdout[-800:]}{done.stderr[-800:]}"
            )

    def clone(self, name: str) -> str:
        with self._admin() as c:
            c.execute(f'DROP DATABASE IF EXISTS "{name}"')
            c.execute(f'CREATE DATABASE "{name}" TEMPLATE "{self.template}"')
        return self.url_for(name)

    def drop(self, name: str) -> None:
        with self._admin() as c:
            c.execute(f'DROP DATABASE IF EXISTS "{name}"')


# ------------------------------------------------------------------------------ running


def mirror_worker(dest: Path) -> Path:
    """A private copy of apps/worker (src + tests) that mutants are applied to.

    Some tests reach the repository root (`parents[3]`: scripts/, fixtures/, .github/), so the
    copy sits at `<dest>/apps/worker` with every other top-level entry of the repository
    SYMLINKED beside it. Only `src/` and `tests/` are copies, and only those are ever mutated.
    """
    repo = WORKER.parents[1]
    for entry in repo.iterdir():
        if entry.name not in ("apps", ".git"):
            os.symlink(entry, dest / entry.name)
    (dest / "apps").mkdir(exist_ok=True)
    for entry in (repo / "apps").iterdir():
        if entry.name != "worker":
            os.symlink(entry, dest / "apps" / entry.name)
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc")
    mirror = dest / "apps" / "worker"
    shutil.copytree(WORKER / "src", mirror / "src", ignore=ignore)
    shutil.copytree(WORKER / "tests", mirror / "tests", ignore=ignore)
    for entry in WORKER.iterdir():
        if entry.name not in ("src", "tests", "__pycache__") and not (mirror / entry.name).exists():
            os.symlink(entry, mirror / entry.name)
    return mirror


def mirror_web(dest: Path) -> Path:
    mirror = dest / "web"
    ignore = shutil.ignore_patterns("node_modules", ".next")
    shutil.copytree(WEB / "src", mirror / "src", ignore=ignore)
    shutil.copytree(WEB / "test", mirror / "test", ignore=ignore)
    for name in ("package.json", "tsconfig.json"):
        if (WEB / name).exists():
            shutil.copy(WEB / name, mirror / name)
    os.symlink(WEB / "node_modules", mirror / "node_modules")
    return mirror


def child_env(db_url: str | None, extra: dict | None = None) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in ("CI", "DATABASE_URL", "PYTHONPATH")}
    env.update(
        STUB_MODE="true",
        R2_ACCESS_KEY_ID="test",
        R2_SECRET_ACCESS_KEY="test",
        R2_ENDPOINT="http://localhost:9000",
        R2_BUCKET_NAME="test-bucket",
        PYTHONDONTWRITEBYTECODE="1",
    )
    if db_url:
        env["DATABASE_URL"] = db_url
    env.update(extra or {})
    return env


def run_pytest(
    mirror: Path, nodes: list[str], db_url: str, timeout: int = 900, extra_env: dict | None = None
) -> dict[str, str]:
    xml = mirror / "junit.xml"
    cmd = [
        sys.executable,
        "-B",
        "-m",
        "pytest",
        "-q",
        "-p",
        "no:cacheprovider",
        f"--junitxml={xml}",
        *nodes,
    ]
    if "tests/" in nodes:
        # The manifest test reads the (mutated) mirror, finds the anchor gone, and fails by design.
        cmd.append("--ignore=tests/test_mutation_manifest.py")
    subprocess.run(
        cmd,
        cwd=mirror,
        env=child_env(db_url, extra_env),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if not xml.exists():
        return {}
    return classify_junit(xml.read_text())


def run_web(mirror: Path, test_file: str) -> dict[str, str]:
    done = subprocess.run(
        ["node", "--experimental-strip-types", "--test", "--test-reporter=junit", test_file],
        cwd=mirror,
        env=child_env(None),
        capture_output=True,
        text=True,
        timeout=300,
    )
    out: dict[str, str] = {}
    try:
        root = ET.fromstring(done.stdout)
    except ET.ParseError:
        return out
    for tc in root.iter("testcase"):
        key = f"{test_file}::{tc.get('name')}"
        failure = tc.find("failure")
        if failure is None:
            out[key] = "skip" if tc.find("skipped") is not None else "pass"
        else:
            # node:test marks an assert failure with code ERR_ASSERTION in the failure text.
            text = (failure.get("message") or "") + (failure.text or "")
            out[key] = "clean" if ("ERR_ASSERTION" in text or "AssertionError" in text) else "crash"
    return out


def web_verdict(killers: tuple[str, ...], results: dict[str, str]) -> str:
    seen = {k: r for k, r in results.items() if any(k.startswith(n) or n in k for n in killers)}
    if not seen:
        return "MISSING"
    if any(r == "clean" for r in seen.values()):
        return "KILLED"
    return "CRASH" if any(r == "crash" for r in seen.values()) else "SURVIVED"


def apply(spec, mirror: Path) -> str | None:
    """Apply a mutant to the mirror. Returns an error string if the entry is stale."""
    real = root_of(spec.suite) / spec.file
    text = real.read_text()
    n = text.count(spec.anchor)
    if n != 1:
        return f"anchor occurs {n} times in {spec.file}, not exactly once"
    if spec.replacement == spec.anchor:
        return "replacement equals anchor"
    mutated = text.replace(spec.anchor, spec.replacement)
    if spec.file.endswith(".py"):
        try:
            compile(mutated, spec.file, "exec")
        except SyntaxError as e:
            return f"the mutant does not compile: {e}"
    (mirror / spec.file).write_text(mutated)
    return None


def one(spec, expect_survive: bool, args, dbs: Databases | None, baseline: dict) -> dict:
    res = {"id": spec.id, "suite": spec.suite, "expect": "SURVIVE" if expect_survive else "KILL"}
    work = Path(tempfile.mkdtemp(prefix=f"mut-{spec.id[:30]}-"))
    dbname = None
    try:
        mirror = mirror_web(work) if spec.suite == "web" else mirror_worker(work)
        err = apply(spec, mirror)
        if err:
            res.update(status="STALE", detail=err)
            return res
        killers = tuple(getattr(spec, "killers", ())) or tuple(getattr(spec, "tests", ()))
        t0 = time.time()
        if spec.suite == "web":
            results = run_web(mirror, killers[0].split("::", 1)[0])
            v = web_verdict(killers, results)
            base = baseline.get(("web", killers[0].split("::", 1)[0]), {})
        else:
            dbname = f"mut_{dbs.tag}_{spec.id[:40]}".lower()
            url = dbs.clone(dbname)
            nodes = (
                ["tests/"] if args.full else list(FIVE_FILES) if args.sentinel else list(killers)
            )
            results = run_pytest(mirror, nodes, url, extra_env=getattr(spec, "env", None))
            v = verdict(killers, results)
            base = {
                k: r
                for k, r in baseline["worker"].items()
                if any(node_matches(n, k) for n in nodes)
            }
        res["seconds"] = round(time.time() - t0)
        res["verdict"] = v
        res["clean_failures"] = sorted(k for k, r in results.items() if r == "clean")
        res["crashes"] = sorted(k for k, r in results.items() if r == "crash")
        # The mutant must not change WHAT IS COLLECTED.
        if base and set(base) != set(results):
            res["collection_changed"] = sorted(set(base) ^ set(results))
        ok = (v == "SURVIVED") if expect_survive else (v == "KILLED")
        if res.get("collection_changed"):
            ok = False
        res["status"] = "OK" if ok else "FAIL"
    except Exception as e:  # noqa: BLE001
        res.update(status="FAIL", detail=f"runner error: {e!r}")
    finally:
        if dbname and dbs:
            with contextlib.suppress(Exception):
                dbs.drop(dbname)
        shutil.rmtree(work, ignore_errors=True)
    return res


def main(argv=None) -> int:
    from tests.mutation.manifest import MUTANTS, SURVIVORS

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--admin-url", default=os.environ.get("MUTANT_ADMIN_URL") or os.environ.get("DATABASE_URL")
    )
    ap.add_argument("--ids")
    ap.add_argument("--suite", default="all", choices=["worker", "web", "all"])
    ap.add_argument("--jobs", type=int, default=2)
    ap.add_argument("--sentinel", action="store_true")
    ap.add_argument(
        "--full", action="store_true", help="run the whole worker suite (tests/) per mutant"
    )
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--json", help="write the results here")
    args = ap.parse_args(argv)

    entries = [(m, False) for m in MUTANTS] + [(s, True) for s in SURVIVORS]
    if args.suite != "all":
        entries = [(m, e) for m, e in entries if m.suite == args.suite]
    if args.ids:
        want = set(args.ids.split(","))
        entries = [(m, e) for m, e in entries if m.id in want]
    if args.list:
        for m, e in entries:
            print(f"{'SURVIVE' if e else 'KILL   '} {m.suite:6} {m.id}")
        return 0
    if not entries:
        print("nothing selected")
        return 2

    before = pristine_hash()
    needs_db = any(m.suite == "worker" for m, _ in entries)
    dbs = None
    if needs_db:
        from tests.real_r2 import database_url_problem

        if not args.admin_url:
            raise SystemExit("--admin-url (or MUTANT_ADMIN_URL / DATABASE_URL) is required")
        problem = database_url_problem(args.admin_url)
        if problem:
            raise SystemExit(
                f"refusing to create and drop databases on {args.admin_url!r}: {problem}"
            )
        dbs = Databases(args.admin_url, f"{os.getpid()}")
        dbs.build_template()

    try:
        # The pristine killers must pass, or a kill proves nothing. One run per suite.
        baseline: dict = {}
        with tempfile.TemporaryDirectory(prefix="mut-base-") as tmp:
            worker_nodes = sorted(
                {
                    n
                    for m, _ in entries
                    if m.suite == "worker"
                    for n in (tuple(getattr(m, "killers", ())) or m.tests)
                }
            )
            if args.sentinel:
                worker_nodes = list(FIVE_FILES)
            if args.full:
                worker_nodes = ["tests/"]
            if worker_nodes:
                mirror = mirror_worker(Path(tmp))
                name = f"mut_{dbs.tag}_base"
                results = run_pytest(mirror, worker_nodes, dbs.clone(name))
                dbs.drop(name)
                shutil.rmtree(mirror, ignore_errors=True)
                bad = {k: r for k, r in results.items() if r in ("clean", "crash")}
                if bad or not results:
                    print(f"PRISTINE RUN IS NOT GREEN: {bad or 'no results'}")
                    return 1
                baseline["worker"] = results
            for tf in sorted(
                {
                    (tuple(getattr(m, "killers", ())) or m.tests)[0].split("::", 1)[0]
                    for m, _ in entries
                    if m.suite == "web"
                }
            ):
                mirror = mirror_web(Path(tmp))
                results = run_web(mirror, tf)
                shutil.rmtree(mirror, ignore_errors=True)
                bad = {k: r for k, r in results.items() if r in ("clean", "crash")}
                if bad or not results:
                    print(f"PRISTINE WEB RUN IS NOT GREEN for {tf}: {bad or 'no results'}")
                    return 1
                baseline[("web", tf)] = results

        outcomes = []
        with cf.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            futs = [pool.submit(one, m, e, args, dbs, baseline) for m, e in entries]
            for f in cf.as_completed(futs):
                r = f.result()
                outcomes.append(r)
                print(
                    f"{r['status']:5} {r['expect']:7} {r['suite']:6} {r['id']:48} "
                    f"{r.get('verdict', r.get('detail', '')):9} {r.get('seconds', '')}s",
                    flush=True,
                )
                if r["status"] != "OK":
                    for k in ("detail", "collection_changed"):
                        if r.get(k):
                            print("      ", k, r[k])
                    if r.get("crashes"):
                        print("       crashed (does not count as a kill):", r["crashes"][:3])
    finally:
        if dbs:
            with contextlib.suppress(Exception):
                dbs.drop(dbs.template)

    after = pristine_hash()
    if before != after:
        print("THE PRISTINE TREE CHANGED while the mutants ran (runner bug)")
        return 1
    if args.json:
        import json

        Path(args.json).write_text(json.dumps(sorted(outcomes, key=lambda r: r["id"]), indent=1))
    stale = [o for o in outcomes if o["status"] == "STALE"]
    bad = [o for o in outcomes if o["status"] == "FAIL"]
    print(
        f"\n{len(outcomes)} entries: {sum(o['status']=='OK' for o in outcomes)} ok, "
        f"{len(bad)} failed, {len(stale)} stale; pristine tree unchanged "
        f"({before[:12]})"
    )
    return 2 if stale else (1 if bad else 0)


if __name__ == "__main__":
    sys.exit(main())
