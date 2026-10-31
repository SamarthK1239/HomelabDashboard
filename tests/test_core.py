"""Contract tests for the collector framework.

These cover the guarantees the rest of the system is built on: that a failing
collector cannot take down its neighbours, that missing data never reads as
healthy, and that history stays bounded.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
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
from backend.collectors.power import PowerCollector, _RaplDomain
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


# --- status event log -------------------------------------------------------


def test_first_sample_is_not_an_event() -> None:
    """A restart must not manufacture an event for every collector it loads."""
    store = Store()
    store.record(CollectorResult(name="t", status=Status.CRITICAL, updated_at=time.time()))
    assert store.events() == []


def test_transitions_are_logged_newest_first() -> None:
    store = Store()
    now = time.time()
    for index, status in enumerate((Status.OK, Status.WARN, Status.CRITICAL, Status.OK)):
        store.record(CollectorResult(name="t", status=status, updated_at=now + index))

    events = store.events()
    assert [(e["from"], e["to"]) for e in events] == [
        ("critical", "ok"),
        ("warn", "critical"),
        ("ok", "warn"),
    ]
    assert events[0]["timestamp"] == now + 3


def test_repeated_status_does_not_log_an_event() -> None:
    store = Store()
    now = time.time()
    for index in range(5):
        store.record(CollectorResult(name="t", status=Status.OK, updated_at=now + index))
    assert store.events() == []


def test_event_log_is_bounded() -> None:
    """The log is a ring buffer; a flapping collector cannot exhaust memory."""
    from backend.store import MAX_EVENTS

    store = Store()
    now = time.time()
    for index in range(MAX_EVENTS + 25):
        status = Status.OK if index % 2 else Status.WARN
        store.record(CollectorResult(name="t", status=status, updated_at=now + index))

    assert len(store.events(limit=10_000)) == MAX_EVENTS


def test_event_limit_returns_the_most_recent() -> None:
    store = Store()
    now = time.time()
    for index in range(10):
        status = Status.OK if index % 2 else Status.WARN
        store.record(CollectorResult(name="t", status=status, updated_at=now + index))

    recent = store.events(limit=2)
    assert len(recent) == 2
    assert recent[0]["timestamp"] == now + 9


def test_event_carries_the_error_that_came_with_it() -> None:
    store = Store()
    now = time.time()
    store.record(CollectorResult(name="t", status=Status.OK, updated_at=now))
    store.record(
        CollectorResult(
            name="t", status=Status.CRITICAL, updated_at=now + 1, error="nvml unavailable"
        )
    )
    assert store.events()[0]["error"] == "nvml unavailable"


# --- HTTP contract ----------------------------------------------------------


@pytest.fixture(scope="module")
def client() -> Any:
    """A client against the real app with the sampler left stopped.

    `TestClient` only runs the lifespan inside a `with` block, so constructing
    it plainly gives the routing and validation layer without starting a
    background sampler that would probe the host running the tests.
    """
    from fastapi.testclient import TestClient

    from backend.app import create_app

    return TestClient(create_app())


def test_history_batch_returns_one_series_per_requested_metric(client: Any) -> None:
    body = client.get("/api/history/batch?metrics=cpu.usage,memory.percent").json()
    assert [s["metric"] for s in body["series"]] == ["cpu.usage", "memory.percent"]
    # Nothing has been sampled, so the series are empty rather than missing:
    # "no points yet" is the normal state, not a client error.
    assert all(s["values"] == [] for s in body["series"])


def test_history_batch_deduplicates_and_preserves_order(client: Any) -> None:
    body = client.get("/api/history/batch?metrics=b.x,a.y,b.x").json()
    assert [s["metric"] for s in body["series"]] == ["b.x", "a.y"]


def test_history_batch_rejects_an_empty_metric_list(client: Any) -> None:
    assert client.get("/api/history/batch?metrics=").status_code == 422
    assert client.get("/api/history/batch?metrics=,,").status_code == 422


def test_history_batch_is_bounded(client: Any) -> None:
    from backend.app import MAX_BATCH_METRICS

    ok = ",".join(f"m{i}.v" for i in range(MAX_BATCH_METRICS))
    assert client.get(f"/api/history/batch?metrics={ok}").status_code == 200

    too_many = ",".join(f"m{i}.v" for i in range(MAX_BATCH_METRICS + 1))
    assert client.get(f"/api/history/batch?metrics={too_many}").status_code == 422


def test_events_endpoint_starts_empty_and_validates_its_limit(client: Any) -> None:
    assert client.get("/api/events").json() == {"events": []}
    assert client.get("/api/events?limit=0").status_code == 422
    assert client.get("/api/events?limit=501").status_code == 422


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
        "power",
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


# --- power accounting --------------------------------------------------------


def _domain(name: str, parent: str | None = None, max_range: int | None = 262_143_328_850):
    domain = _RaplDomain.__new__(_RaplDomain)
    domain.path = Path("/nonexistent")
    domain.name = name
    domain.parent = parent
    domain.max_range = max_range
    domain.error = None
    return domain


def test_energy_delta_becomes_average_watts() -> None:
    # 30 joules over 2 seconds is 15 W, whatever the absolute counter value.
    watts = PowerCollector._watts_between(
        _domain("package-0"), (100.0, 1_000_000), (102.0, 31_000_000)
    )
    assert watts == 15.0


def test_wrapped_energy_counter_is_recovered_not_reported_as_negative() -> None:
    """RAPL counters wrap at max_energy_range_uj; a wrap is not a power drop."""
    domain = _domain("package-0", max_range=1_000_000_000)
    watts = PowerCollector._watts_between(domain, (0.0, 999_000_000), (1.0, 9_000_000))
    assert watts == 10.0


def test_counter_reset_is_discarded_rather_than_spiking() -> None:
    """A suspend or driver reload zeroes the counter mid-range.

    Treated as a wrap, a reset from early in the range implies almost the whole
    range of energy in one interval -- far more than any real hardware draws, so
    the interval is dropped instead.
    """
    domain = _domain("package-0", max_range=1_000_000_000)
    assert PowerCollector._watts_between(domain, (0.0, 100_000_000), (1.0, 10)) is None


def test_wrap_without_a_known_range_is_unmeasurable() -> None:
    domain = _domain("package-0", max_range=None)
    assert PowerCollector._watts_between(domain, (0.0, 500), (1.0, 100)) is None


def test_non_advancing_clock_never_divides_by_zero() -> None:
    assert PowerCollector._watts_between(_domain("dram"), (5.0, 0), (5.0, 1_000)) is None


def test_platform_domain_supersedes_its_packages() -> None:
    """psys already includes the CPU packages, so summing both double-counts."""
    components = [
        {"category": "platform", "watts": 180.0},
        {"category": "cpu", "watts": 95.0},
        {"category": "dram", "watts": 20.0},
    ]
    kept = PowerCollector._deduplicate(components)
    assert [c["category"] for c in kept] == ["platform", "dram"]


def test_package_domains_are_kept_when_there_is_no_platform_domain() -> None:
    components = [{"category": "cpu", "watts": 95.0}, {"category": "dram", "watts": 20.0}]
    assert PowerCollector._deduplicate(components) == components


def test_power_without_any_sensor_is_unknown_not_ok() -> None:
    """A card showing only the configured baseline has measured nothing."""
    collector = PowerCollector(make_config(power={"baseline_watts": 60.0}))
    status = collector.status_for(
        {"total_watts": 60.0, "measured_source_count": 0, "by_category": {"baseline": 60.0}}
    )
    assert status is Status.UNKNOWN


def test_power_thresholds_are_off_until_configured() -> None:
    collector = PowerCollector(make_config())
    assert collector.status_for({"total_watts": 5000.0, "measured_source_count": 2}) is Status.OK


def test_configured_power_thresholds_classify_the_total() -> None:
    config = make_config(thresholds={"power_warn": 400.0, "power_critical": 700.0})
    collector = PowerCollector(config)
    assert collector.status_for({"total_watts": 200.0, "measured_source_count": 2}) is Status.OK
    assert collector.status_for({"total_watts": 450.0, "measured_source_count": 2}) is Status.WARN
    assert (
        collector.status_for({"total_watts": 900.0, "measured_source_count": 2})
        is Status.CRITICAL
    )


def test_implausible_psu_efficiency_falls_back_to_unity() -> None:
    # Otherwise the "at the wall" figure comes out below the parts it sums.
    assert PowerCollector(make_config(power={"psu_efficiency": 0.0})).meta()["psu_efficiency"] == 1.0
    assert PowerCollector(make_config(power={"psu_efficiency": 1.8})).meta()["psu_efficiency"] == 1.0
    assert PowerCollector(make_config(power={"psu_efficiency": 0.9})).meta()["psu_efficiency"] == 0.9
