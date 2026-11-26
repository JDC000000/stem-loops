"""QK-3: the spend brake reports to Sentry on engage / release, rate-limited per process.

No database: `_read` is replaced, so these run everywhere. The brake DECISION is not touched
(the real-Postgres contract stays in test_spend_gate_restricted_role.py); these check only
that each state change is reported once, that a standing brake does not repeat every poll,
and that a failing Sentry client cannot change the answer.
"""

from __future__ import annotations

import asyncio
import types

import pytest

from worker import spend_gate
from worker.spend_gate import BrakeState

DSN = "postgresql://unused"


@pytest.fixture(autouse=True)
def _fresh():
    spend_gate.reset_log_state()
    yield
    spend_gate.reset_log_state()


@pytest.fixture
def sent(monkeypatch):
    out: list[dict] = []
    scopes: list = []

    class Scope:
        def __init__(self):
            self.tags: dict = {}
            self.fingerprint = None

        def set_tag(self, k, v):
            self.tags[k] = v

        def __enter__(self):
            scopes.append(self)
            return self

        def __exit__(self, *a):
            return False

    def capture_message(msg, level=None):
        out.append({"msg": msg, "level": level, "fp": scopes[-1].fingerprint, **scopes[-1].tags})

    monkeypatch.setattr(
        spend_gate,
        "sentry_sdk",
        types.SimpleNamespace(new_scope=Scope, capture_message=capture_message),
    )
    return out


@pytest.fixture
def clock(monkeypatch):
    t = {"now": 1000.0}
    # Replace only spend_gate's view of `time`: patching time.monotonic itself would freeze
    # the asyncio loop clock too, and wait_for would never fire.
    monkeypatch.setattr(spend_gate, "time", types.SimpleNamespace(monotonic=lambda: t["now"]))
    return t


def _feed(monkeypatch, *states):
    """Make `_read` return (or raise) these in order."""
    items = list(states)

    async def fake(_dsn):
        item = items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    monkeypatch.setattr(spend_gate, "_read", fake)


def _poll():
    return asyncio.run(spend_gate.brake_state(DSN))


ENGAGED = BrakeState(True, "switch_engaged")
ABSENT = BrakeState(True, "row_absent")
RELEASED = BrakeState(False, "released")


@pytest.mark.parametrize(
    ("feed", "reason", "detail"),
    [
        (ENGAGED, "engaged", "switch_engaged"),
        (ABSENT, "missing_row", "row_absent"),
        (OSError("connection refused"), "unreadable", "read_failed"),
    ],
)
def test_engage_sends_one_error_event_with_the_reason(
    monkeypatch, sent, clock, feed, reason, detail
):
    _feed(monkeypatch, feed)
    assert _poll().engaged is True
    assert len(sent) == 1
    ev = sent[0]
    assert ev["level"] == "error"
    assert ev["fp"] == ["spend-brake", reason]
    assert ev["spend_brake"] == reason and ev["spend_brake_detail"] == detail
    assert "ENGAGED" in ev["msg"]


def test_read_timeout_is_unreadable(monkeypatch, sent):
    async def hang(_dsn):
        await asyncio.sleep(10)

    monkeypatch.setattr(spend_gate, "_read", hang)
    monkeypatch.setattr(spend_gate, "WALL_TIMEOUT_S", 0.05)
    assert _poll() == BrakeState(True, "read_timeout")
    assert [(e["spend_brake"], e["spend_brake_detail"]) for e in sent] == [
        ("unreadable", "read_timeout")
    ]


def test_error_text_is_not_sent_only_its_type(monkeypatch, sent, clock):
    _feed(monkeypatch, OSError("host=db.secret.internal password=hunter2"))
    _poll()
    assert sent[0]["spend_brake_error"] == "OSError"
    assert "hunter2" not in repr(sent) and "secret.internal" not in repr(sent)


def test_steady_engaged_does_not_repeat_within_the_hour(monkeypatch, sent, clock):
    _feed(monkeypatch, *[ENGAGED] * 200)
    for _ in range(200):  # ~ 200 polls; the log re-fires every minute, Sentry must not
        _poll()
        clock["now"] += 15
    assert clock["now"] - 1000 < spend_gate.SENTRY_REPEAT_S
    assert len(sent) == 1


def test_standing_brake_repeats_once_per_hour(monkeypatch, sent, clock):
    _feed(monkeypatch, *[ENGAGED] * 4)
    _poll()
    clock["now"] += spend_gate.SENTRY_REPEAT_S - 1
    _poll()
    assert len(sent) == 1
    clock["now"] += 1
    _poll()
    _poll()
    assert len(sent) == 2 and sent[1]["fp"] == ["spend-brake", "engaged"]


def test_release_sends_one_info_event_and_only_once(monkeypatch, sent, clock):
    _feed(monkeypatch, ENGAGED, ENGAGED, RELEASED, RELEASED, RELEASED)
    for _ in range(5):
        _poll()
    assert [e["level"] for e in sent] == ["error", "info"]
    assert sent[1]["fp"] == ["spend-brake", "released"]
    assert "RELEASED" in sent[1]["msg"]


def test_released_from_start_sends_nothing(monkeypatch, sent, clock):
    _feed(monkeypatch, *[RELEASED] * 10)
    for _ in range(10):
        assert _poll().engaged is False
    assert sent == []


def test_reason_change_while_engaged_is_a_new_event(monkeypatch, sent, clock):
    _feed(monkeypatch, ENGAGED, ABSENT, ABSENT, OSError("x"), RuntimeError("y"))
    for _ in range(5):
        _poll()
    # read_failed (OSError, RuntimeError) is one reason: unreadable, sent once.
    assert [e["spend_brake"] for e in sent] == ["engaged", "missing_row", "unreadable"]


def test_flapping_brake_is_rate_limited(monkeypatch, sent, clock):
    _feed(monkeypatch, *[ENGAGED, RELEASED] * 50)
    for _ in range(100):
        _poll()
        clock["now"] += 2
    # first engage + its release; later re-engages of the same reason inside the hour are
    # suppressed, and so is the release that would close them.
    assert [e["level"] for e in sent] == ["error", "info"]


def test_re_engage_after_the_hour_reports_again(monkeypatch, sent, clock):
    _feed(monkeypatch, ENGAGED, RELEASED, ENGAGED, RELEASED)
    _poll()
    _poll()
    clock["now"] += spend_gate.SENTRY_REPEAT_S
    _poll()
    _poll()
    assert [e["level"] for e in sent] == ["error", "info", "error", "info"]


def test_sentry_failure_never_changes_the_decision(monkeypatch, clock):
    def boom(*a, **k):
        raise RuntimeError("sentry down")

    monkeypatch.setattr(
        spend_gate, "sentry_sdk", types.SimpleNamespace(new_scope=boom, capture_message=boom)
    )
    _feed(monkeypatch, ENGAGED, ABSENT, OSError("x"), RELEASED)
    assert [_poll() for _ in range(4)] == [
        ENGAGED,
        ABSENT,
        BrakeState(True, "read_failed"),
        RELEASED,
    ]


def test_warn_log_is_kept(monkeypatch, sent, clock, capsys):
    _feed(monkeypatch, ENGAGED)
    _poll()
    out = capsys.readouterr()
    assert "spend_brake_engaged" in out.out + out.err


def test_every_raw_reason_has_a_sentry_reason():
    raw = {"switch_engaged", "row_absent", "read_failed", "read_timeout"}
    assert set(spend_gate.SENTRY_REASON) == raw
    assert set(spend_gate.SENTRY_REASON.values()) == {"engaged", "missing_row", "unreadable"}
