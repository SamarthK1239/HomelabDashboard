"""Collector base classes and registry.

Every monitored subsystem is a :class:`Collector`. Collectors self-register via
:func:`register`, and the sampler, API payload, history buffers and frontend
card grid are all driven off that registry. Adding a new panel to the dashboard
therefore means adding one file here and importing it in ``__init__`` -- no
changes to the sampling loop, the routes, or the router.

Writing a collector
-------------------

.. code-block:: python

    from .base import Collector, Status, register

    @register
    class FanCollector(Collector):
        name = "fans"
        default_interval = 10.0

        async def collect(self) -> dict:
            return {"rpm": read_fan_rpm()}

        def status_for(self, data: dict) -> Status:
            return Status.CRITICAL if data["rpm"] == 0 else Status.OK

        def history_fields(self, data: dict) -> dict[str, float]:
            return {"rpm": data["rpm"]}

The frontend renders any collector it does not have a bespoke card for using a
generic key/value card, so a new collector is visible immediately.
"""

from __future__ import annotations

import asyncio
import enum
import time
from dataclasses import dataclass, field
from typing import Any, Callable, ClassVar

from ..config import Config


class Status(str, enum.Enum):
    """Health of a single card, rolled up into the overall system status."""

    OK = "ok"
    WARN = "warn"
    CRITICAL = "critical"
    UNKNOWN = "unknown"

    @property
    def severity(self) -> int:
        return {"ok": 0, "unknown": 1, "warn": 2, "critical": 3}[self.value]


def worst(statuses: list[Status]) -> Status:
    """Return the most severe status, for rolling card states into a header."""
    if not statuses:
        return Status.UNKNOWN
    return max(statuses, key=lambda s: s.severity)


def threshold_status(value: float | None, warn: float, critical: float) -> Status:
    """Classify a value against warn/critical ceilings.

    ``None`` maps to :attr:`Status.UNKNOWN` rather than a healthy default --
    missing data should never look like good news.
    """
    if value is None:
        return Status.UNKNOWN
    if value >= critical:
        return Status.CRITICAL
    if value >= warn:
        return Status.WARN
    return Status.OK


@dataclass
class CollectorResult:
    """One collector's most recent sample, successful or not."""

    name: str
    status: Status = Status.UNKNOWN
    data: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    updated_at: float = 0.0
    duration_ms: float | None = None

    def to_dict(self, now: float | None = None) -> dict[str, Any]:
        now = now if now is not None else time.time()
        return {
            "name": self.name,
            "status": self.status.value,
            "data": self.data,
            "error": self.error,
            "updated_at": self.updated_at,
            "age_seconds": max(0.0, now - self.updated_at) if self.updated_at else None,
            "duration_ms": self.duration_ms,
        }


class Collector:
    """Base class for all collectors.

    Subclasses must set :attr:`name` and implement :meth:`collect`. Everything
    else has a sensible default, so the minimum viable collector is small.
    """

    name: ClassVar[str] = ""
    default_interval: ClassVar[float] = 5.0
    #: Human-readable card title; falls back to a title-cased name.
    title: ClassVar[str] = ""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.interval = config.interval(self.name, self.default_interval)

    async def collect(self) -> dict[str, Any]:
        """Return this collector's current reading.

        Raising is acceptable and expected when a subsystem is unavailable: the
        sampler catches it and marks only this card as degraded.
        """
        raise NotImplementedError

    def status_for(self, data: dict[str, Any]) -> Status:
        """Classify a successful reading. Defaults to healthy."""
        return Status.OK

    def history_fields(self, data: dict[str, Any]) -> dict[str, float]:
        """Scalar series to retain for sparklines, keyed ``<collector>.<field>``.

        Return an empty mapping (the default) for collectors with nothing
        meaningful to plot over time.
        """
        return {}

    def meta(self) -> dict[str, Any]:
        """Static facts that do not change between samples (hardware names and
        similar). Collected once at startup for ``/api/meta``."""
        return {}

    async def aclose(self) -> None:
        """Release any long-lived resources held by the collector."""
        return None

    async def run_to_thread(self, func: Callable[..., Any], *args: Any) -> Any:
        """Run a blocking call off the event loop.

        Most of these collectors read ``/proc``, call into NVML, or talk to the
        Docker socket -- all blocking work that must not stall the sampler.
        """
        return await asyncio.to_thread(func, *args)


_REGISTRY: list[type[Collector]] = []


def register(cls: type[Collector]) -> type[Collector]:
    """Class decorator that adds a collector to the global registry."""
    if not cls.name:
        raise ValueError(f"{cls.__name__} must define a non-empty 'name'")
    if any(existing.name == cls.name for existing in _REGISTRY):
        raise ValueError(f"duplicate collector name: {cls.name}")
    _REGISTRY.append(cls)
    return cls


def registered() -> list[type[Collector]]:
    return list(_REGISTRY)


def build_collectors(config: Config) -> list[Collector]:
    """Instantiate every registered collector that is not disabled in config."""
    disabled = config.disabled_collectors
    return [cls(config) for cls in _REGISTRY if cls.name not in disabled]
