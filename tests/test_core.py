"""Contract tests for the collector framework.

These cover the guarantees the rest of the system is built on: that a failing
collector cannot take down its neighbours, that missing data never reads as
healthy, and that history stays bounded.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from backend.collectors.base import (
    Collector,
    CollectorResult,
    Status,
    build_collectors,
    threshold_status,
    worst,
)
from backend.collectors.gpu import _is_throttled
from backend.collectors.llama import LlamaCollector
from backend.config import Config, load_config
from backend.sampler import Sampler
from backend.store import Store


class Healthy(Collector):
    name = "healthy"
    default_interval = 0.01

    async def collect(self) -> dict[str, Any]:
        return {"value": 42.0}

    def history_fields(self, data: dict[str, Any]) -> dict[str, float]:
        return {"value": data["value"]}


class Exploding(Collector):
    name = "exploding"
    default_interval = 0.01

    async def collect(self) -> dict[str, Any]:
        raise RuntimeError("subsystem unavailable")


class Hanging(Collector):
    name = "hanging"
    default_interval = 0.01

    async def collect(self) -> dict[str, Any]:
        await asyncio.sleep(60)
        return {}


def make_config(**overrides: Any) -> Config:
    data = dict(load_config().data)
    data.update(overrides)
    return Config(data)


# --- status semantics -------------------------------------------------------


def test_missing_data_is_never_healthy() -> None:
    """A value we could not measure must not be reported as OK."""
    assert threshold_status(None, 80, 95) is Status.UNKNOWN


def test_threshold_boundaries_are_inclusive() -> None:
    assert threshold_status(95.0, 80, 95) is Status.CRITICAL
    assert threshold_status(80.0, 80, 95) is Status.WARN
    assert threshold_status(79.9, 80, 95) is Status.OK


def test_worst_prefers_critical_over_unknown() -> None:
    assert worst([Status.OK, Status.UNKNOWN, Status.WARN]) is Status.WARN
    assert worst([Status.WARN, Status.CRITICAL]) is Status.CRITICAL
    assert worst([]) is Status.UNKNOWN


def test_unknown_outranks_ok_but_not_warn() -> None:
    """Unknown is more alarming than fine, less than a breached threshold."""
    assert worst([Status.OK, Status.UNKNOWN]) is Status.UNKNOWN


# --- error isolation --------------------------------------------------------


async def test_failing_collector_does_not_affect_others() -> None:
    store = Store()
    collectors: list[Collector] = [Healthy(make_config()), Exploding(make_config())]
    sampler = Sampler(collectors, store)

    for collector in collectors:
        await sampler.sample_once(collector)

    snapshot = store.snapshot()
    assert snapshot["collectors"]["healthy"]["status"] == "ok"
    assert snapshot["collectors"]["healthy"]["data"] == {"value": 42.0}

    failed = snapshot["collectors"]["exploding"]
    assert failed["status"] == "critical"
    assert "subsystem unavailable" in failed["error"]
    assert snapshot["overall_status"] == "critical"


async def test_hanging_collector_times_out_instead_of_wedging() -> None:
    import backend.sampler as sampler_module

    original = sampler_module.COLLECT_TIMEOUT
    sampler_module.COLLECT_TIMEOUT = 0.05
    try:
        store = Store()
        collector = Hanging(make_config())
        result = await Sampler([collector], store).sample_once(collector)
    finally:
        sampler_module.COLLECT_TIMEOUT = original

    assert result.status is Status.CRITICAL
    assert "timed out" in (result.error or "")


# --- store ------------------------------------------------------------------


def test_history_window_evicts_old_points() -> None:
    store = Store(window_seconds=10)
    now = time.time()
    for age in (30, 20, 5, 0):
        store.record(
            CollectorResult(name="t", status=Status.OK, updated_at=now - age),
            {"value": float(age)},
        )

    series = store.history("t.value", window=3600)
    assert series["values"] == [5.0, 0.0], "points older than the window must be dropped"


def test_history_ignores_none_values() -> None:
    """First-sample deltas are None and must not become fabricated zeros."""
    store = Store()
    store.record(
        CollectorResult(name="t", status=Status.OK, updated_at=time.time()),
        {"rate": None},  # type: ignore[dict-item]
    )
    assert store.history("t.rate")["values"] == []


def test_snapshot_reports_card_age() -> None:
    store = Store()
    store.record(CollectorResult(name="t", status=Status.OK, updated_at=time.time() - 5))
    age = store.snapshot()["collectors"]["t"]["age_seconds"]
    assert age is not None and 4.0 <= age <= 7.0


def test_empty_store_is_unknown_not_ok() -> None:
    assert Store().snapshot()["overall_status"] == "unknown"


# --- registry ---------------------------------------------------------------


def test_registry_discovers_all_builtin_collectors() -> None:
    names = {c.name for c in build_collectors(load_config())}
    assert names == {
        "cpu",
        "memory",
        "disk",
        "uptime",
        "gpu",
        "docker",
        "llama",
        "updates",
    }


def test_disabled_collectors_are_not_built() -> None:
    config = make_config(collectors={"disabled": ["gpu", "docker"]})
    names = {c.name for c in build_collectors(config)}
    assert "gpu" not in names and "docker" not in names
    assert "cpu" in names


def test_config_intervals_override_collector_defaults() -> None:
    config = make_config(intervals={"healthy": 99.0})
    assert Healthy(config).interval == 99.0
    assert Exploding(config).interval == Exploding.default_interval


# --- config -----------------------------------------------------------------


def test_env_overrides_apply(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOMELAB_DASHBOARD_HOST", "10.0.0.1")
    monkeypatch.setenv("HOMELAB_DASHBOARD_PORT", "9999")
    config = load_config()
    assert config.host == "10.0.0.1"
    assert config.port == 9999


def test_defaults_work_without_a_config_file(tmp_path: Any) -> None:
    config = load_config(tmp_path / "does-not-exist.toml")
    assert config.port == 8800
    assert config.interval("cpu", 1.0) == 2.0


# --- gpu throttle classification --------------------------------------------


def test_idle_software_power_cap_is_not_throttling() -> None:
    """An idle RTX 3090 reports SwPowerCap at ~33 W of a 420 W limit.

    The driver attributes the idle downclock to the power-management algorithm,
    so believing the bit unconditionally lights up a throttle warning on a card
    that is simply doing nothing.
    """
    assert _is_throttled(["Software power cap"], 33.4, 420.0) is False


def test_software_power_cap_near_the_limit_is_real_throttling() -> None:
    assert _is_throttled(["Software power cap"], 418.0, 420.0) is True


def test_thermal_and_hardware_slowdowns_always_count() -> None:
    # These are never an artefact of idling, so power draw is irrelevant.
    assert _is_throttled(["Hardware slowdown"], 33.0, 420.0) is True
    assert _is_throttled(["Software thermal slowdown"], 33.0, 420.0) is True
    assert _is_throttled(["Hardware power brake slowdown"], 33.0, 420.0) is True


def test_real_reason_alongside_an_idle_power_cap_still_alarms() -> None:
    reasons = ["Software power cap", "Hardware thermal slowdown"]
    assert _is_throttled(reasons, 33.0, 420.0) is True


def test_power_cap_is_not_believed_without_usable_power_readings() -> None:
    assert _is_throttled(["Software power cap"], None, 420.0) is False
    assert _is_throttled(["Software power cap"], 33.0, None) is False
    # A zero limit must not raise ZeroDivisionError.
    assert _is_throttled(["Software power cap"], 33.0, 0.0) is False


def test_unknown_throttle_reasons_stay_unknown() -> None:
    assert _is_throttled(None, 33.0, 420.0) is None


# --- llama.cpp /slots polling policy ---------------------------------------
#
# Reading /slots wakes a sleeping model: measured on a live server, the first
# poll took VRAM from 363 MiB to 15.8 GiB. These pin down when the collector is
# allowed to touch it.


def _llama(policy: str = "auto") -> LlamaCollector:
    config = Config({"llama": {"slots_policy": policy}})
    return LlamaCollector(config)


def _metrics(busy: float | None) -> dict[str, Any]:
    if busy is None:
        return {"available": True, "values": {}}
    return {"available": True, "values": {"llamacpp:requests_processing": busy}}


def test_slots_skipped_while_the_model_sleeps() -> None:
    allowed, reason = _llama()._slots_decision({"is_sleeping": True}, _metrics(0))
    assert allowed is False
    assert "sleeping" in reason


def test_slots_polled_when_a_request_is_in_flight() -> None:
    # Busy implies already awake, so there is no sleep timer left to disturb.
    allowed, _ = _llama()._slots_decision({"is_sleeping": False}, _metrics(1))
    assert allowed is True


def test_slots_skipped_when_awake_but_idle() -> None:
    # The case that used to pin the model in VRAM forever.
    allowed, reason = _llama()._slots_decision({"is_sleeping": False}, _metrics(0))
    assert allowed is False
    assert "idle" in reason


def test_a_sleeping_model_is_never_woken_even_if_metrics_look_busy() -> None:
    allowed, _ = _llama()._slots_decision({"is_sleeping": True}, _metrics(1))
    assert allowed is False


def test_slots_skipped_when_metrics_are_unavailable() -> None:
    # Without /metrics there is no safe way to tell busy from idle, so the
    # collector must assume idle rather than risk pinning the model.
    allowed, reason = _llama()._slots_decision({}, {"available": False})
    assert allowed is False
    assert "--metrics" in reason


def test_slots_skipped_when_the_busy_gauge_is_missing() -> None:
    allowed, _ = _llama()._slots_decision({}, _metrics(None))
    assert allowed is False


def test_unknown_sleep_state_still_allows_polling_when_busy() -> None:
    # Older builds do not report is_sleeping; the busy gauge alone is enough.
    allowed, _ = _llama()._slots_decision({}, _metrics(2))
    assert allowed is True


def test_always_policy_polls_slots_even_against_a_sleeping_model() -> None:
    allowed, reason = _llama("always")._slots_decision({"is_sleeping": True}, _metrics(0))
    assert allowed is True
    assert "always" in reason


def test_never_policy_skips_slots_even_when_busy() -> None:
    allowed, reason = _llama("never")._slots_decision({"is_sleeping": False}, _metrics(5))
    assert allowed is False
    assert "never" in reason


def test_invalid_policy_falls_back_to_auto() -> None:
    assert _llama("nonsense").slots_policy == "auto"
