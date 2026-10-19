"""Physical memory, swap and per-NUMA-node usage.

The two memory controllers on this box are independent: one NUMA node can be
under pressure while the other has headroom, which shows up as swapping long
before the system-wide percentage looks alarming. Node figures are therefore
parsed from sysfs alongside the usual totals.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import psutil

from ..config import Config
from .base import Collector, Status, register, threshold_status, worst

_NODE_SYS_ROOT = Path("/sys/devices/system/node")


def _parse_node_meminfo(path: Path) -> dict[str, int]:
    """Parse ``/sys/devices/system/node/nodeN/meminfo`` into bytes.

    Lines look like ``Node 0 MemTotal:       32772840 kB``; anything that does
    not match that shape is skipped rather than failing the whole read.
    """
    values: dict[str, int] = {}
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) < 4 or not parts[2].endswith(":"):
            continue
        key = parts[2].rstrip(":")
        try:
            amount = int(parts[3])
        except ValueError:
            continue
        values[key] = amount * 1024 if parts[-1] == "kB" else amount
    return values


def _numa_nodes() -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    try:
        node_dirs = sorted(
            (p for p in _NODE_SYS_ROOT.glob("node[0-9]*") if p.is_dir()),
            key=lambda p: int(p.name[4:]),
        )
    except (OSError, ValueError):
        return nodes

    for node_dir in node_dirs:
        try:
            info = _parse_node_meminfo(node_dir / "meminfo")
        except OSError:
            continue
        total = info.get("MemTotal")
        if not total:
            continue
        used = info.get("MemUsed")
        free = info.get("MemFree")
        if used is None and free is not None:
            used = total - free
        cached = info.get("FilePages")
        # ``MemUsed`` counts reclaimable page cache, so a node routinely reads
        # ~99% while the machine as a whole is nearly idle. Report the
        # cache-excluded figure alongside it so the card is not misleading.
        anon = used - cached if used is not None and cached is not None else None
        nodes.append(
            {
                "id": int(node_dir.name[4:]),
                "total": total,
                "used": used,
                "free": free,
                "cached": cached,
                "used_excluding_cache": max(anon, 0) if anon is not None else None,
                "percent": round(used / total * 100, 1) if used is not None else None,
                "percent_excluding_cache": (
                    round(max(anon, 0) / total * 100, 1) if anon is not None else None
                ),
            }
        )
    return nodes


@register
class MemoryCollector(Collector):
    name = "memory"
    title = "Memory"
    default_interval = 2.0

    def __init__(self, config: Config) -> None:
        super().__init__(config)
        self._total = psutil.virtual_memory().total

    async def collect(self) -> dict[str, Any]:
        vm = psutil.virtual_memory()
        swap = psutil.swap_memory()

        return {
            "total": int(vm.total),
            "used": int(vm.used),
            "available": int(vm.available),
            "free": int(vm.free),
            "cached": int(getattr(vm, "cached", 0)),
            "buffers": int(getattr(vm, "buffers", 0)),
            "shared": int(getattr(vm, "shared", 0)),
            "percent": round(float(vm.percent), 1),
            "swap": {
                "total": int(swap.total),
                "used": int(swap.used),
                "free": int(swap.free),
                "percent": round(float(swap.percent), 1),
            },
            "numa_nodes": _numa_nodes(),
        }

    def status_for(self, data: dict[str, Any]) -> Status:
        memory = threshold_status(
            data.get("percent"),
            self.config.threshold("memory_warn", 80.0),
            self.config.threshold("memory_critical", 92.0),
        )
        swap_data = data.get("swap") or {}
        statuses = [memory]
        # Swapping only matters when swap exists; a zero-size swap device
        # always reads 0% and would otherwise look artificially healthy.
        if swap_data.get("total"):
            statuses.append(
                threshold_status(
                    swap_data.get("percent"),
                    self.config.threshold("swap_warn", 25.0),
                    self.config.threshold("swap_critical", 50.0),
                )
            )
        return worst(statuses)

    def history_fields(self, data: dict[str, Any]) -> dict[str, float]:
        fields: dict[str, float] = {}
        if data.get("percent") is not None:
            fields["percent"] = float(data["percent"])
        swap_percent = (data.get("swap") or {}).get("percent")
        if swap_percent is not None:
            fields["swap_percent"] = float(swap_percent)
        return fields

    def meta(self) -> dict[str, Any]:
        nodes = _numa_nodes()
        return {
            "total_bytes": int(self._total),
            "swap_total_bytes": int(psutil.swap_memory().total),
            "numa_nodes": len(nodes),
            "numa_node_total_bytes": {str(node["id"]): node["total"] for node in nodes},
        }
