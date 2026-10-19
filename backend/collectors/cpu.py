"""CPU utilisation, per-socket rollups, frequency and package temperatures.

This box is dual-socket with a high logical core count, so a single "CPU %"
number hides more than it shows: a saturated socket next to an idle one looks
identical to both being half busy. Topology is therefore discovered from sysfs
at construction time and every reading is also reported per socket and per
logical core.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import psutil

from ..config import Config
from .base import Collector, Status, register, threshold_status, worst

_CPU_SYS_ROOT = Path("/sys/devices/system/cpu")
_PACKAGE_LABEL = re.compile(r"package id\s*(\d+)", re.IGNORECASE)


def _read_int(path: Path) -> int | None:
    """Read a single integer out of sysfs, tolerating absence or garbage."""
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


def _discover_topology() -> dict[int, list[int]]:
    """Map socket id -> logical CPU ids using sysfs topology.

    Falls back to pinning everything to socket 0 so the collector still works
    on kernels or containers that do not expose ``physical_package_id``.
    """
    sockets: dict[int, list[int]] = {}
    try:
        cpu_dirs = [p for p in _CPU_SYS_ROOT.glob("cpu[0-9]*") if p.is_dir()]
    except OSError:
        cpu_dirs = []

    for cpu_dir in cpu_dirs:
        try:
            index = int(cpu_dir.name[3:])
        except ValueError:
            continue
        package = _read_int(cpu_dir / "topology" / "physical_package_id")
        if package is None:
            continue
        sockets.setdefault(package, []).append(index)

    if not sockets:
        logical = psutil.cpu_count(logical=True) or 1
        sockets = {0: list(range(logical))}
    return {key: sorted(value) for key, value in sorted(sockets.items())}


def _physical_cores_per_socket(sockets: dict[int, list[int]]) -> dict[int, int]:
    """Count distinct physical cores per socket (SMT siblings share a core_id)."""
    counts: dict[int, int] = {}
    for socket_id, cpus in sockets.items():
        core_ids: set[int] = set()
        for cpu in cpus:
            core_id = _read_int(_CPU_SYS_ROOT / f"cpu{cpu}" / "topology" / "core_id")
            if core_id is not None:
                core_ids.add(core_id)
        counts[socket_id] = len(core_ids) or len(cpus)
    return counts


def _cpu_model() -> str | None:
    try:
        with open("/proc/cpuinfo", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return None


def _package_temperatures() -> dict[int, float]:
    """Return socket id -> package temperature from coretemp-style sensors.

    ``sensors_temperatures`` reports one ``Package id N`` entry per physical
    package, which lines up with the sysfs socket ids used elsewhere here.
    """
    temps: dict[int, float] = {}
    try:
        readings = psutil.sensors_temperatures()
    except (AttributeError, OSError):
        return temps

    for entries in readings.values():
        for entry in entries:
            match = _PACKAGE_LABEL.search(entry.label or "")
            if match and entry.current is not None:
                temps[int(match.group(1))] = round(float(entry.current), 1)
    return temps


def _average(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


@register
class CpuCollector(Collector):
    name = "cpu"
    title = "CPU"
    default_interval = 2.0

    def __init__(self, config: Config) -> None:
        super().__init__(config)
        self._sockets = _discover_topology()
        self._physical_per_socket = _physical_cores_per_socket(self._sockets)
        self._logical_count = psutil.cpu_count(logical=True) or 1
        self._physical_count = psutil.cpu_count(logical=False)
        self._model = _cpu_model()
        #: ``cpu_percent`` is a delta since the previous call, so the first
        #: reading after construction would describe all of uptime. Report
        #: ``None`` instead of inventing a number.
        self._primed = False

    async def collect(self) -> dict[str, Any]:
        per_core_raw = psutil.cpu_percent(percpu=True, interval=None)
        primed = self._primed
        self._primed = True

        per_core: list[float] | None = (
            [round(float(value), 1) for value in per_core_raw] if primed else None
        )
        overall = _average(per_core) if per_core else None

        freqs = self._per_core_frequencies()
        temps = _package_temperatures()

        sockets: list[dict[str, Any]] = []
        for socket_id, cpus in self._sockets.items():
            socket_percents = (
                [per_core[cpu] for cpu in cpus if cpu < len(per_core)] if per_core else []
            )
            socket_freqs = [freqs[cpu] for cpu in cpus if cpu < len(freqs)]
            sockets.append(
                {
                    "id": socket_id,
                    "logical_cores": len(cpus),
                    "physical_cores": self._physical_per_socket.get(socket_id, len(cpus)),
                    "percent": _average(socket_percents),
                    "frequency_mhz": _average(socket_freqs),
                    "temperature_c": temps.get(socket_id),
                }
            )

        load1, load5, load15 = os.getloadavg()
        hottest = max(temps.values()) if temps else None

        return {
            "percent": overall,
            "per_core": per_core,
            "logical_cores": self._logical_count,
            "physical_cores": self._physical_count,
            "socket_count": len(self._sockets),
            "sockets": sockets,
            "load_average": {
                "1m": round(load1, 2),
                "5m": round(load5, 2),
                "15m": round(load15, 2),
            },
            # Raw load is unreadable at 88 threads: a load of 10 is either
            # alarming or trivial depending on core count, so also express it
            # as the percentage of total CPU capacity it implies.
            "load_percent": {
                "1m": round(load1 / self._logical_count * 100, 2),
                "5m": round(load5 / self._logical_count * 100, 2),
                "15m": round(load15 / self._logical_count * 100, 2),
            },
            "frequency_mhz": self._overall_frequency(),
            "temperatures_c": {str(key): value for key, value in sorted(temps.items())},
            "package_temp_max_c": hottest,
            "model": self._model,
            "priming": not primed,
        }

    def _per_core_frequencies(self) -> list[float]:
        try:
            return [float(freq.current) for freq in psutil.cpu_freq(percpu=True)]
        except (OSError, RuntimeError, AttributeError):
            return []

    def _overall_frequency(self) -> dict[str, float | None]:
        try:
            freq = psutil.cpu_freq()
        except (OSError, RuntimeError, AttributeError):
            freq = None
        if freq is None:
            return {"current": None, "min": None, "max": None}
        return {
            "current": round(float(freq.current), 2),
            "min": round(float(freq.min), 2) if freq.min else None,
            "max": round(float(freq.max), 2) if freq.max else None,
        }

    def status_for(self, data: dict[str, Any]) -> Status:
        statuses = [
            threshold_status(
                data.get("percent"),
                self.config.threshold("cpu_warn", 80.0),
                self.config.threshold("cpu_critical", 95.0),
            )
        ]
        # Only fold temperature in when a sensor actually reported: an absent
        # sensor would otherwise permanently pin the card to UNKNOWN.
        if data.get("package_temp_max_c") is not None:
            statuses.append(
                threshold_status(
                    data["package_temp_max_c"],
                    self.config.threshold("cpu_temp_warn", 80.0),
                    self.config.threshold("cpu_temp_critical", 90.0),
                )
            )
        return worst(statuses)

    def history_fields(self, data: dict[str, Any]) -> dict[str, float]:
        fields: dict[str, float] = {}
        if data.get("percent") is not None:
            fields["usage"] = float(data["percent"])
        for socket in data.get("sockets", []):
            if socket.get("percent") is not None:
                fields[f"socket{socket['id']}"] = float(socket["percent"])
        return fields

    def meta(self) -> dict[str, Any]:
        return {
            "model": self._model,
            "logical_cores": self._logical_count,
            "physical_cores": self._physical_count,
            "sockets": len(self._sockets),
            "cores_per_socket": {
                str(socket_id): {
                    "logical": len(cpus),
                    "physical": self._physical_per_socket.get(socket_id, len(cpus)),
                }
                for socket_id, cpus in self._sockets.items()
            },
            "frequency_mhz": self._overall_frequency(),
        }
