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
