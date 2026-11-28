"""READ-ONLY operator backfill: BTC vs the stored Klangio chords, one anonymous line per song.

For every ``done`` job whose ``jobs/<id>/play.chords.json`` is a Klangio result, newest first
and ONE job per normalised source link (a re-pasted link is scored once):

  1. GET the stored chords and re-stamp them with ``klangio._restamp_frame_clock`` (#524/#525).
     Files written before #525 are on the served 10/108 s grid and get the 2048/22050 s
     audio clock; anything else passes through unchanged, so a fixed file is never moved.
  2. GET the stored download stems (``<id>/_stems/dl/<stem>.wav``) and build the SAME input
     the worker sent Klangio with ``pipeline._choose_chord_input`` (harmonic mix + bass).
  3. Run BTC in a child process (``chord_shadow.run_btc_child``).
  4. Score BTC against Klangio (Klangio is the reference): root, MajMin and sevenths, the
     time-weighted mir_eval definitions (``chord_shadow.agreement``; root is added here).

Output (stdout), ordered by MajMin ascending (unscorable last)::

    <rank> <mm:ss> root <r>% majmin <m>% sevenths <s>%
    ...
    summary songs=<n> majmin_mean=<x>% majmin_min=<y>% below_75=<a> below_90=<b> ...

No job id, user, title, link or e-mail is printed or logged, and no traceback: a failure is a
counted category (exception CLASS names only). Column header goes to stderr.

Safety:
  * DB: one connection opened with ``default_transaction_read_only=on`` plus
    ``SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY``, verified with
    ``SHOW transaction_read_only`` before any query; every statement must be a single
    SELECT/SHOW (anything else raises ``ReadOnlyViolation`` before it reaches the server).
  * R2: the client is wrapped so ONLY ``get_object`` is reachable; put/delete/copy/upload
    and everything else raise ``ReadOnlyViolation``. Use a read-only R2 token anyway.
  * Klangio: never called. ``KlangioChordSource`` construction and
    ``get_chord_source('klangio')`` are made to raise for the life of the process,
    ``KLANGIO_API_KEY`` is removed from this process's environment (so the BTC child cannot
    inherit it), and the run asserts zero Klangio constructions at the end.

Env (the worker's names; values are never printed): ``DATABASE_URL``, ``R2_BUCKET_NAME``,
``R2_ACCESS_KEY_ID``, ``R2_SECRET_ACCESS_KEY`` and ``R2_ENDPOINT_URL`` / ``MINIO_ENDPOINT`` /
``R2_ACCOUNT_ID``; ``BTC_WEIGHTS_PATH`` for the BTC child.

Usage::

    python apps/worker/scripts/btc_compare_backfill.py [--limit N] [--since YYYY-MM-DD]
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import os
import re
import shutil
import sys
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from worker import tmpdirs  # noqa: E402
from worker.chord_providers import klangio as _klangio  # noqa: E402
from worker.chord_shadow import (  # noqa: E402
    agreement,
    majmin_agreement,
    run_btc_child,
    sevenths_agreement,
)
from worker.downloader.fetch_gates import video_id_from_url  # noqa: E402
from worker.storage.r2_uploader import play_chords_r2_key, stem_download_r2_key  # noqa: E402

REQUIRED_ENV = ("DATABASE_URL", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
BTC_TIMEOUT_SEC = 180.0  # a 300 s song is ~2.5 s of BTC on 2 cores; this only caps a hang


class ReadOnlyViolation(RuntimeError):
    """Something tried to write (or could have written) to the DB or R2."""


class KlangioForbidden(RuntimeError):
    """This script must never construct a Klangio client."""


class SongSkipped(Exception):
    """The job is not scorable (counted under its message, a fixed category code)."""


# --------------------------------------------------------------------------- root metric
class _EveryQuality(dict):
    """Comparator table that scores EVERY parsed chord by its root (mir_eval ``root``)."""

    def get(self, key, default=None):  # noqa: ANN001, ARG002 — dict.get signature
        return "root"


ROOT_TABLE = _EveryQuality()


def root_agreement(reference, estimate) -> float | None:
    return agreement(reference, estimate, ROOT_TABLE)


# --------------------------------------------------------------------------- Klangio guard
_KLANGIO_CONSTRUCTED = 0


def install_klangio_guard() -> Callable[[], None]:
    """Make any Klangio client construction raise. Returns an undo (for tests)."""
    from worker import chord_source  # noqa: PLC0415

    cls = _klangio.KlangioChordSource
    orig_init = cls.__init__
    orig_factory = chord_source.get_chord_source

    def _refuse_init(self, *a, **k):  # noqa: ANN001, ANN002, ANN003, ARG001
        global _KLANGIO_CONSTRUCTED
        _KLANGIO_CONSTRUCTED += 1
        raise KlangioForbidden("btc_compare_backfill must not construct a Klangio client")

    def _factory(provider: str | None = None):
        if (provider or "klangio") == "klangio":
            raise KlangioForbidden("btc_compare_backfill must not construct a Klangio client")
        return orig_factory(provider)

    cls.__init__ = _refuse_init
    chord_source.get_chord_source = _factory
    os.environ.pop("KLANGIO_API_KEY", None)

    def undo() -> None:
        cls.__init__ = orig_init
        chord_source.get_chord_source = orig_factory

    return undo


def assert_no_klangio() -> None:
    if _KLANGIO_CONSTRUCTED:
        raise KlangioForbidden("a Klangio client construction was attempted")


# --------------------------------------------------------------------------- read-only DB
_SINGLE_READ = re.compile(r"^\s*(SELECT|SHOW)\b[^;]*;?\s*$", re.IGNORECASE | re.DOTALL)
_WRITE_WORD = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|"
    r"CALL|DO|INTO|LOCK|VACUUM|NEXTVAL|SETVAL|PG_ADVISORY\w*|FOR\s+(NO\s+KEY\s+)?UPDATE|"
    r"FOR\s+(KEY\s+)?SHARE)\b",
    re.IGNORECASE,
)


def check_read_only_sql(sql: str) -> None:
    if not _SINGLE_READ.match(sql) or _WRITE_WORD.search(sql):
        raise ReadOnlyViolation("only a single plain SELECT/SHOW is allowed")


class ReadOnlyDb:
    """A psycopg connection reachable only through ``query`` (SELECT/SHOW)."""

    def __init__(self, conn: Any) -> None:
        self._conn = conn

    def query(self, sql: str, params: Sequence | None = None) -> list[tuple]:
        check_read_only_sql(sql)
        return list(self._conn.execute(sql, params).fetchall())

    def close(self) -> None:
        try:
            self._conn.rollback()
        finally:
            self._conn.close()


def connect_read_only(dsn: str, connect: Callable[..., Any] | None = None) -> ReadOnlyDb:
    if connect is None:
        import psycopg  # noqa: PLC0415

        connect = psycopg.connect
    conn = connect(dsn, options="-c default_transaction_read_only=on", connect_timeout=10)
    conn.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
    db = ReadOnlyDb(conn)
    rows = db.query("SHOW transaction_read_only")
    if not rows or str(rows[0][0]).lower() != "on":
        db.close()
        raise ReadOnlyViolation("the DB session is not read-only")
    return db


JOBS_SQL = (
    "SELECT id::text, youtube_url, video_id FROM public.jobs "
    "WHERE status = 'done' AND created_at >= %s ORDER BY created_at DESC, id DESC"
)


# --------------------------------------------------------------------------- read-only R2
class _GetOnlyClient:
    """Proxy over a boto3 S3 client that exposes ``get_object`` and nothing else."""

    _ALLOWED = frozenset({"get_object"})

    def __init__(self, client: Any) -> None:
        object.__setattr__(self, "_client", client)

    def __getattr__(self, name: str) -> Any:
        if name not in self._ALLOWED:
            raise ReadOnlyViolation("R2 access is GET-only")
        return getattr(self._client, name)

    def __setattr__(self, name: str, value: Any) -> None:
        raise ReadOnlyViolation("R2 access is GET-only")


def _is_missing(exc: Exception) -> bool:
    err = getattr(exc, "response", None) or {}
    return str(err.get("Error", {}).get("Code", "")) in ("NoSuchKey", "404", "NotFound")


class ReadOnlyR2:
    def __init__(self, client: Any, bucket: str) -> None:
        self.client = _GetOnlyClient(client)
        self._bucket = bucket

    def _get(self, key: str):
        try:
            return self.client.get_object(Bucket=self._bucket, Key=key)["Body"]
        except Exception as exc:
            if _is_missing(exc):
                return None
            raise

    def get_bytes(self, key: str) -> bytes | None:
        body = self._get(key)
        return None if body is None else body.read()

    def download(self, key: str, path: str) -> bool:
        body = self._get(key)
        if body is None:
            return False
        with open(path, "wb") as fh:
            shutil.copyfileobj(body, fh, 1 << 20)
        return True


def r2_from_env() -> ReadOnlyR2:
    import boto3  # noqa: PLC0415
    from botocore.config import Config  # noqa: PLC0415

    from worker.storage.r2_uploader import _endpoint  # noqa: PLC0415 — same env resolution

    client = boto3.client(
        "s3",
        endpoint_url=_endpoint(),
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )
    return ReadOnlyR2(client, os.environ["R2_BUCKET_NAME"])


# --------------------------------------------------------------------------- selection
def link_key(job_id: str, url: str | None, video_id: str | None) -> str:
    """One key per source: the YouTube video id when there is one, else the normalised URL;
    an upload (no link) is its own key."""
    if video_id:
        return "yt:" + video_id
    if url:
        vid = video_id_from_url(url)
        if vid:
            return "yt:" + vid
        parts = urlsplit(url.strip())
        return "url:" + (parts.hostname or "").lower() + parts.path.rstrip("/") + parts.query
    return "job:" + job_id


def candidate_jobs(rows: Iterable[tuple]) -> list[tuple[str, str]]:
    """``(link_key, job_id)`` newest first, as queried. Dedupe happens while scoring: the
    first job of a key that HAS Klangio chords claims the key."""
    return [(link_key(r[0], r[1], r[2]), r[0]) for r in rows]


def load_klangio_rows(r2: ReadOnlyR2, job_id: str) -> tuple[list[tuple[float, float, str]], str]:
    raw = r2.get_bytes(play_chords_r2_key(job_id))
    if raw is None:
        raise SongSkipped("no_chords_file")
    try:
        doc = json.loads(raw)
    except ValueError:
        raise SongSkipped("chords_file_unreadable") from None
    if not isinstance(doc, dict) or doc.get("provider") != "klangio":
        raise SongSkipped("not_klangio")
    segs = doc.get("segments")
    if not isinstance(segs, list) or not segs:
        raise SongSkipped("not_klangio")  # a tombstone has no segments
    rows = [(float(s["start_sec"]), float(s["end_sec"]), str(s["label"])) for s in segs]
    return _klangio._restamp_frame_clock(rows)


# --------------------------------------------------------------------------- scoring
@dataclass
class SongScore:
    length_sec: float
    root: float | None
    majmin: float | None
    sevenths: float | None


@dataclass
class Deps:
    db: Any
    r2: Any
    btc_runner: Callable[[str, float], dict] = run_btc_child
    chooser: Callable[..., Any] | None = None  # default: pipeline._choose_chord_input
    prober: Callable[[str], float | None] | None = None  # default: pipeline._probe_duration_sec
    preferred: str | None = None  # default: pipeline.CHORDS_DEFAULT_STEM
    extra: dict = field(default_factory=dict)


def _pipeline_defaults(deps: Deps) -> None:
    if deps.chooser and deps.prober and deps.preferred:
        return
    from worker import pipeline  # noqa: PLC0415 — heavy; only for a real run

    deps.chooser = deps.chooser or pipeline._choose_chord_input
    deps.prober = deps.prober or pipeline._probe_duration_sec
    deps.preferred = deps.preferred or pipeline.CHORDS_DEFAULT_STEM
    deps.extra["stems"] = (*pipeline._HARMONIC_STEMS, *pipeline._MIX_EXTRA_STEMS)


def score_song(deps: Deps, job_id: str, ref: list, timeout: float) -> SongScore:
    stems = deps.extra.get("stems") or ("keys", "guitar", "other", "bass")
    with tmpdirs.job_scope():
        tmp = tmpdirs.mkdtemp(prefix="sl_btcbackfill_")
        stem_paths: dict[str, str] = {}
        for name in stems:
            path = os.path.join(tmp, f"{name}.wav")
            if deps.r2.download(stem_download_r2_key(job_id, name), path):
                stem_paths[name] = path
        if not stem_paths:
            raise SongSkipped("stems_missing")
        chosen = deps.chooser(stem_paths, preferred=deps.preferred)
        if not chosen:
            raise SongSkipped("no_chord_input")
        _label, audio = chosen
        length = deps.prober(audio) or max(e for _s, e, _l in ref)
        data = deps.btc_runner(audio, timeout)
    est = [tuple(s[:3]) for s in data["segments"]]
    return SongScore(
        length_sec=float(length),
        root=root_agreement(ref, est),
        majmin=majmin_agreement(ref, est),
        sevenths=sevenths_agreement(ref, est),
    )


# --------------------------------------------------------------------------- output
def _pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100.0 * x:.1f}%"


def _mmss(sec: float) -> str:
    s = int(round(sec))
    return f"{s // 60:02d}:{s % 60:02d}"


def format_report(scores: list[SongScore], errors: Counter, clocks: Counter) -> list[str]:
    ordered = sorted(
        scores, key=lambda s: (s.majmin is None, s.majmin if s.majmin is not None else 0.0)
    )
    lines = [
        f"{i:>4} {_mmss(s.length_sec)} root {_pct(s.root)} majmin {_pct(s.majmin)} "
        f"sevenths {_pct(s.sevenths)}"
        for i, s in enumerate(ordered, 1)
    ]
    mm = [s.majmin for s in scores if s.majmin is not None]
    mean = sum(mm) / len(mm) if mm else None
    err = ",".join(f"{k}:{v}" for k, v in sorted(errors.items())) or "none"
    lines.append(
        f"summary songs={len(scores)} majmin_mean={_pct(mean)} "
        f"majmin_min={_pct(min(mm) if mm else None)} "
        f"below_75={sum(1 for x in mm if x < 0.75)} below_90={sum(1 for x in mm if x < 0.90)} "
        f"restamped={clocks.get(_klangio.CLOCK_RESTAMPED, 0)} "
        f"passthrough={clocks.get(_klangio.CLOCK_PASSTHROUGH, 0)} errors={err}"
    )
    return lines


# --------------------------------------------------------------------------- run
def run(deps: Deps, *, limit: int | None, since: dt.date | None, timeout: float) -> list[str]:
    _pipeline_defaults(deps)
    since_ts = dt.datetime.combine(since or dt.date(1970, 1, 1), dt.time(), tzinfo=dt.UTC)
    rows = deps.db.query(JOBS_SQL, (since_ts,))
    claimed: set[str] = set()
    scores: list[SongScore] = []
    errors: Counter = Counter()
    clocks: Counter = Counter()
    for key, job_id in candidate_jobs(rows):
        if key in claimed:
            continue
        if limit is not None and len(claimed) >= limit:
            break
        try:
            ref, clock = load_klangio_rows(deps.r2, job_id)
        except KlangioForbidden:
            raise  # never a counted error: the run must stop
        except SongSkipped as skip:
            errors[str(skip)] += 1
            continue  # an older job for the same link may still have Klangio chords
        except Exception as exc:  # noqa: BLE001 — class name only, never the message
            errors["chords_" + type(exc).__name__] += 1
            continue
        claimed.add(key)
        clocks[clock] += 1
        try:
            scores.append(score_song(deps, job_id, ref, timeout))
        except KlangioForbidden:
            raise
        except SongSkipped as skip:
            errors[str(skip)] += 1
        except Exception as exc:  # noqa: BLE001
            errors["score_" + type(exc).__name__] += 1
    assert_no_klangio()  # also catches an attempt something below swallowed
    return format_report(scores, errors, clocks)


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--limit", type=int, default=None, help="score at most N distinct songs")
    p.add_argument(
        "--since", type=dt.date.fromisoformat, default=None, help="jobs created on/after (UTC)"
    )
    p.add_argument("--btc-timeout", type=float, default=BTC_TIMEOUT_SEC)
    args = p.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        p.error("--limit must be >= 1")
    return args


def main(argv: list[str] | None = None, deps: Deps | None = None) -> int:
    args = _parse_args(argv)
    install_klangio_guard()
    db = None
    try:
        if deps is None:
            missing = [n for n in REQUIRED_ENV if not os.environ.get(n)]
            if missing:  # names only, never a value
                print("missing env: " + " ".join(missing), file=sys.stderr)
                return 2
            db = connect_read_only(os.environ["DATABASE_URL"])
            deps = Deps(db=db, r2=r2_from_env())
        print("rank mm:ss root majmin sevenths (Klangio = reference)", file=sys.stderr)
        for line in run(deps, limit=args.limit, since=args.since, timeout=args.btc_timeout):
            print(line)
        return 0
    except BaseException as exc:  # noqa: BLE001 — no traceback: it could carry ids or links
        if isinstance(exc, SystemExit):
            raise
        print(f"fatal error_class={type(exc).__name__}", file=sys.stderr)
        return 2
    finally:
        if db is not None:
            with contextlib.suppress(Exception):
                db.close()


if __name__ == "__main__":
    sys.exit(main())
