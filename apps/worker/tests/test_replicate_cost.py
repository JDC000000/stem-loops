"""SL-B15: the Replicate cost rate is a named, config-overridable value (was a hard-coded 0.0005)."""

import importlib

import pytest

from worker import replicate_client


def test_default_rate_is_the_published_a100_list_price():
    # https://replicate.com/pricing gpu-a100-large $0.001400/sec, fetched 2026-11-02
    assert replicate_client.DEFAULT_REPLICATE_USD_PER_SECOND == 0.0014


def test_cost_uses_the_named_rate(monkeypatch):
    monkeypatch.setattr(replicate_client, "REPLICATE_USD_PER_SECOND", 0.002)
    assert replicate_client.prediction_cost_usd(10) == pytest.approx(0.02)


def test_default_cost_is_2_8x_the_old_hardcoded_rate():
    assert replicate_client.prediction_cost_usd(27) == pytest.approx(27 * 0.0014)
    assert pytest.approx(2.8) == 0.0014 / 0.0005


@pytest.mark.parametrize(
    "env,expected",
    [("0.0021", 0.0021), ("", 0.0014), ("abc", 0.0014), ("-1", 0.0014), ("0", 0.0014)],
)
def test_env_override_and_invalid_fallback(monkeypatch, env, expected):
    monkeypatch.setenv("REPLICATE_USD_PER_SECOND", env)
    try:
        mod = importlib.reload(replicate_client)
        assert pytest.approx(expected) == mod.REPLICATE_USD_PER_SECOND
    finally:
        monkeypatch.delenv("REPLICATE_USD_PER_SECOND", raising=False)
        importlib.reload(replicate_client)


def test_poll_until_done_logs_cost_from_the_rate(monkeypatch):
    class R:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "status": "succeeded",
                "output": {"drums": "u"},
                "metrics": {"predict_time": 10},
            }

    monkeypatch.setattr(replicate_client.httpx, "get", lambda *a, **k: R())
    monkeypatch.setattr(replicate_client, "_headers", lambda: {})
    monkeypatch.setattr(replicate_client, "REPLICATE_USD_PER_SECOND", 0.0014)
    stems, cost = replicate_client.poll_until_done("j", "p")
    assert stems == {"drums": "u"} and cost == 0.014
