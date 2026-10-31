"""Whole-system power draw, assembled from every sensor the box exposes.

No single sensor on a commodity server reports "total watts", so this collector
adds up the ones that exist:

* **Intel RAPL** (``/sys/class/powercap``) for CPU package and DRAM power. RAPL
  exposes monotonically increasing *energy* counters in microjoules, so power is
  the delta between two reads divided by the elapsed time -- the first sample
  therefore takes two reads a fraction of a second apart.
* **NVML** for per-GPU board power, which on an inference box is usually the
  largest single term.
* A configurable **baseline** for everything with no sensor at all (drives,
  fans, NIC, chipset, board regulators). Guessed rather than measured, so it is
  reported as its own component and defaults to zero.

The sum is a *component* figure: it is what the parts draw, not what the wall
socket delivers. ``[power] psu_efficiency`` converts it to an estimated wall
figure. A real answer needs a metered PDU or IPMI DCMI; this is the best that
can be done from sysfs and NVML alone.

Reading RAPL counters requires root on modern kernels (CVE-2020-8694 made
``energy_uj`` mode 0400), so the CPU terms degrade to "unavailable" for the
unprivileged user the dashboard runs as. That is reported explicitly rather
than silently folded into a smaller total -- see ``unavailable`` in the payload
and the note in ``config.example.toml`` about the udev rule that grants read
access if you want those numbers.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any, Callable

from ..config import Config
from .base import Collector, Status, register, threshold_status

_POWERCAP_ROOT = Path("/sys/class/powercap")

#: How long to wait before retrying NVML after a failure, matching the GPU
#: collector: driver reloads and module loads are the usual causes and neither
#: resolves within a sample interval.
NVML_RETRY_SECONDS = 60.0

#: Delay between the two energy reads used to prime the very first sample.
#: Long enough for the counters to advance measurably, short enough that the
#: first collection still finishes promptly.
_PRIMING_SECONDS = 0.3

#: RAPL energy counters wrap at ``max_energy_range_uj``. A delta larger than
#: this fraction of the range is far more likely to be a counter reset (suspend,
#: driver reload) than a genuine wrap, and is discarded instead of reported as a
#: nonsensical spike.
_MAX_PLAUSIBLE_WRAP_FRACTION = 0.5

#: Ceiling for a single domain's computed power. Anything above this came from
#: a counter discontinuity, not from silicon.
_MAX_PLAUSIBLE_WATTS = 10_000.0


def _try(call: Callable[[], Any]) -> Any:
    """Return ``call()`` or ``None`` if it raises.

    Every optional sensor read goes through this: a missing sysfs file, a
    permission denial and an unsupported NVML query are all normal on some
    hardware and none of them should fail the whole collector.
    """
    try:
        return call()
    except Exception:
        return None


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _read_int(path: Path) -> int | None:
    value = _read_text(path)
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


class _RaplDomain:
    """One powercap domain and the running state needed to differentiate it."""

    def __init__(self, path: Path, name: str, parent: str | None) -> None:
        self.path = path
        self.name = name
        self.parent = parent
        self.max_range = _read_int(path / "max_energy_range_uj")
        #: Set once the first read fails, so a permission denial is reported
        #: as such instead of as a missing sensor.
        self.error: str | None = None

    @property
    def key(self) -> str:
        """Stable identifier, unique even when two sockets share a domain name."""
        return f"{self.parent}:{self.name}" if self.parent else self.name

    @property
    def label(self) -> str:
        return self.key.replace(":", " · ")

    @property
    def is_package(self) -> bool:
        return self.parent is None and self.name.startswith("package")

    @property
    def is_platform(self) -> bool:
        """``psys`` measures the whole SoC platform, superseding its packages."""
        return self.name == "psys"

    @property
    def is_dram(self) -> bool:
        return self.name == "dram"

    def read_energy(self) -> int | None:
        value = _read_int(self.path / "energy_uj")
        if value is None and self.error is None:
            # Distinguish "root-only counter" from "no such domain": only the
            # former is fixable by the operator.
            try:
                (self.path / "energy_uj").read_text()
            except PermissionError:
                self.error = "permission denied (energy_uj is root-only)"
            except OSError as exc:
                self.error = f"{type(exc).__name__}: {exc}"
        elif value is not None:
            self.error = None
        return value


def _discover_rapl() -> list[_RaplDomain]:
    """Enumerate powercap domains: top-level packages and their subdomains.

    Subdomains are nested directories (``intel-rapl:0:0``), so the parent is
    recorded to keep ``dram`` on socket 0 distinct from ``dram`` on socket 1.
    """
    domains: list[_RaplDomain] = []
    try:
        # `intel-rapl:0:0` also matches `intel-rapl:[0-9]*`, so subdomains have
        # to be excluded by colon count or every one of them is enumerated
        # twice -- once correctly, once as a bogus top-level domain whose key
        # collides with its namesake on the other socket.
        tops = sorted(
            p
            for p in _POWERCAP_ROOT.glob("intel-rapl:[0-9]*")
            if p.is_dir() and p.name.count(":") == 1
        )
    except OSError:
        return domains

    for top in tops:
        name = _read_text(top / "name")
        if not name:
            continue
        domains.append(_RaplDomain(top, name, None))
        try:
            subs = sorted(
                p
                for p in top.glob(f"{top.name}:[0-9]*")
                if p.is_dir() and p.name.count(":") == 2
            )
        except OSError:
            subs = []
        for sub in subs:
            sub_name = _read_text(sub / "name")
            if sub_name:
                domains.append(_RaplDomain(sub, sub_name, name))
    return domains


@register
class PowerCollector(Collector):
    name = "power"
    title = "Power"
    default_interval = 5.0

    def __init__(self, config: Config) -> None:
        super().__init__(config)
        self._domains = _discover_rapl()
        self._previous: dict[str, tuple[float, int]] = {}

        section = config.section("power")
        self._baseline_watts = max(0.0, float(section.get("baseline_watts", 0.0) or 0.0))
        efficiency = float(section.get("psu_efficiency", 1.0) or 1.0)
        # An efficiency outside (0, 1] would make the wall estimate smaller than
        # the components it is derived from, which is physically backwards.
        self._psu_efficiency = efficiency if 0.0 < efficiency <= 1.0 else 1.0
        cost = section.get("cost_per_kwh")
        self._cost_per_kwh = float(cost) if cost is not None else None
        self._currency = str(section.get("currency", "$") or "$")

        self._nvml: Any = None
        self._handles: list[Any] = []
        self._nvml_failed = False
        self._nvml_retry_after = 0.0
        self._nvml_error: str | None = None

    # -------------------------------------------------------------------- NVML

    def _init_nvml(self) -> bool:
        """Initialise NVML once and cache the device handles.

        Mirrors the GPU collector deliberately: both are independent consumers
        of a refcounted library, so each owns its own init/shutdown pair.
        """
        if self._nvml is not None:
            return True
        if self._nvml_failed and time.monotonic() < self._nvml_retry_after:
            return False
        try:
            import pynvml

            pynvml.nvmlInit()
            try:
                count = pynvml.nvmlDeviceGetCount()
                self._handles = [
                    pynvml.nvmlDeviceGetHandleByIndex(i) for i in range(count)
                ]
            except Exception:
                _try(lambda: pynvml.nvmlShutdown())
                raise
            self._nvml = pynvml
            self._nvml_error = None
            self._nvml_failed = False
            return True
        except Exception as exc:
            self._nvml_error = f"{type(exc).__name__}: {exc}"
            self._nvml_failed = True
            self._nvml_retry_after = time.monotonic() + NVML_RETRY_SECONDS
            self._nvml = None
            self._handles = []
            return False

    def _gpu_components(self) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        """Per-GPU board power, or an explanation of why there is none."""
        if not self._init_nvml():
            reason = self._nvml_error or "NVML unavailable"
            return [], [{"source": "nvml", "component": "gpu", "reason": reason}]

        pynvml = self._nvml
        components: list[dict[str, Any]] = []
        unavailable: list[dict[str, str]] = []
        for index, handle in enumerate(self._handles):
            milliwatts = _try(lambda h=handle: pynvml.nvmlDeviceGetPowerUsage(h))
            name = _try(lambda h=handle: pynvml.nvmlDeviceGetName(h))
            if isinstance(name, bytes):
                name = name.decode("utf-8", "replace")
            label = f"GPU {index} · {name}" if name else f"GPU {index}"
            if milliwatts is None:
                unavailable.append(
                    {
                        "source": "nvml",
                        "component": f"gpu{index}",
                        "reason": "power readings not supported by this device",
                    }
                )
                continue
            components.append(
                {
                    "key": f"gpu{index}",
                    "label": label,
                    "category": "gpu",
                    "source": "nvml",
                    "watts": round(milliwatts / 1000.0, 2),
                }
            )
        return components, unavailable

    # -------------------------------------------------------------------- RAPL

    def _read_rapl(self) -> dict[str, tuple[float, int]]:
        """Snapshot every readable domain's energy counter with its timestamp.

        Each domain is timestamped individually: reading a dozen sysfs files is
        not instantaneous, and pairing a counter with a timestamp taken before
        or after some other read would bias that domain's power.
        """
        readings: dict[str, tuple[float, int]] = {}
        for domain in self._domains:
            energy = domain.read_energy()
            if energy is not None:
                readings[domain.key] = (time.monotonic(), energy)
        return readings

    def _rapl_components(
        self, readings: dict[str, tuple[float, int]]
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        components: list[dict[str, Any]] = []
        unavailable: list[dict[str, str]] = []

        for domain in self._domains:
            current = readings.get(domain.key)
            if current is None:
                unavailable.append(
                    {
                        "source": "rapl",
                        "component": domain.key,
                        "reason": domain.error or "counter unreadable",
                    }
                )
                continue

            previous = self._previous.get(domain.key)
            if previous is None:
                continue

            watts = self._watts_between(domain, previous, current)
            if watts is None:
                continue

            if domain.is_platform:
                category = "platform"
            elif domain.is_package:
                category = "cpu"
            elif domain.is_dram:
                category = "dram"
            else:
                category = "other"

            components.append(
                {
                    "key": domain.key,
                    "label": domain.label,
                    "category": category,
                    "source": "rapl",
                    "watts": watts,
                }
            )
        return components, unavailable

    @staticmethod
    def _watts_between(
        domain: _RaplDomain,
        previous: tuple[float, int],
        current: tuple[float, int],
    ) -> float | None:
        """Average power over the interval, or ``None`` if it is not trustworthy."""
        previous_time, previous_energy = previous
        current_time, current_energy = current
        elapsed = current_time - previous_time
        if elapsed <= 0:
            return None

        delta = current_energy - previous_energy
        if delta < 0:
            # The counter wrapped. Recover the real delta from the range, but
            # only if the domain actually advertises one.
            if not domain.max_range:
                return None
            delta += domain.max_range
            if delta > domain.max_range * _MAX_PLAUSIBLE_WRAP_FRACTION:
                # Too large to be one wrap at any plausible power: this is a
                # counter reset, so the interval is simply unmeasurable.
                return None

        watts = delta / 1_000_000.0 / elapsed
        if watts > _MAX_PLAUSIBLE_WATTS:
            return None
        return round(watts, 2)

    # ---------------------------------------------------------------- sampling

    async def collect(self) -> dict[str, Any]:
        readings = await self.run_to_thread(self._read_rapl)
        if self._domains and not self._previous and readings:
            # Energy counters only yield power as a difference, so the first
            # collection primes itself rather than returning an empty card.
            self._previous = readings
            await asyncio.sleep(_PRIMING_SECONDS)
            readings = await self.run_to_thread(self._read_rapl)

        rapl_components, rapl_missing = self._rapl_components(readings)
        self._previous = readings

        gpu_components, gpu_missing = await self.run_to_thread(self._gpu_components)

        components = [*self._deduplicate(rapl_components), *gpu_components]
        if self._baseline_watts > 0:
            components.append(
                {
                    "key": "baseline",
                    "label": "Baseline (configured)",
                    "category": "baseline",
                    "source": "config",
                    "watts": round(self._baseline_watts, 2),
                }
            )

        by_category: dict[str, float] = {}
        for component in components:
            by_category[component["category"]] = round(
                by_category.get(component["category"], 0.0) + component["watts"], 2
            )

        measured = [c for c in components if c["source"] != "config"]
        total = round(sum(c["watts"] for c in components), 2) if components else None
        wall = (
            round(total / self._psu_efficiency, 2)
            if total is not None and self._psu_efficiency > 0
            else None
        )

        data: dict[str, Any] = {
            "total_watts": total,
            "wall_watts": wall,
            "cpu_watts": (
                by_category["cpu"] if "cpu" in by_category else by_category.get("platform")
            ),
            "dram_watts": by_category.get("dram"),
            "gpu_watts": by_category.get("gpu"),
            "baseline_watts": by_category.get("baseline"),
            "by_category": by_category,
            "components": sorted(components, key=lambda c: -c["watts"]),
            "unavailable": [*rapl_missing, *gpu_missing],
            "measured_source_count": len(measured),
            "psu_efficiency": self._psu_efficiency,
            # The sum omits anything without a sensor, so an operator reading
            # the card knows whether to trust it as a total or as a floor.
            "is_estimate": True,
            "kwh_per_day": round(total * 24 / 1000.0, 3) if total is not None else None,
        }

        if self._cost_per_kwh is not None and total is not None:
            daily = total * 24 / 1000.0 * self._cost_per_kwh
            data["cost_per_kwh"] = self._cost_per_kwh
            data["currency"] = self._currency
            data["cost_per_day"] = round(daily, 2)
            data["cost_per_month"] = round(daily * 30, 2)

        return data

    @staticmethod
    def _deduplicate(components: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Drop per-package terms when a platform-wide ``psys`` domain exists.

        ``psys`` already accounts for the packages it contains, so summing both
        would double-count the CPUs.
        """
        if any(component["category"] == "platform" for component in components):
            return [component for component in components if component["category"] != "cpu"]
        return components

    def status_for(self, data: dict[str, Any]) -> Status:
        total = data.get("total_watts")
        if total is None or data.get("measured_source_count", 0) == 0:
            # No sensor answered, so the reported total is the baseline guess
            # at best. Missing data must not render as healthy.
            return Status.UNKNOWN
        warn = self.config.threshold("power_warn", 0.0)
        critical = self.config.threshold("power_critical", 0.0)
        if critical <= 0 and warn <= 0:
            return Status.OK
        return threshold_status(total, warn or critical, critical or warn)

    def history_fields(self, data: dict[str, Any]) -> dict[str, float]:
        fields: dict[str, float] = {}
        for key in ("total_watts", "cpu_watts", "gpu_watts", "wall_watts"):
            value = data.get(key)
            if value is not None:
                fields[key] = float(value)
        return fields

    def meta(self) -> dict[str, Any]:
        return {
            "rapl_domains": [domain.key for domain in self._domains],
            "baseline_watts": self._baseline_watts,
            "psu_efficiency": self._psu_efficiency,
            "cost_per_kwh": self._cost_per_kwh,
            "currency": self._currency,
        }

    async def aclose(self) -> None:
        pynvml, self._nvml = self._nvml, None
        self._handles = []
        if pynvml is not None:
            _try(lambda: pynvml.nvmlShutdown())
