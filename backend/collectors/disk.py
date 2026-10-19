"""Filesystem capacity, inode usage and per-disk I/O throughput.

Only real filesystems are reported: on a snap-heavy Ubuntu install
``disk_partitions`` returns dozens of read-only squashfs loop mounts that are
always 100% full and would drown the card (and permanently pin it critical).
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

import psutil

from ..config import Config
from .base import Collector, Status, register, threshold_status

#: Filesystem types that are never worth a capacity bar.
_PSEUDO_FSTYPES = {
    "autofs",
    "bpf",
    "binfmt_misc",
    "cgroup",
    "cgroup2",
    "configfs",
    "debugfs",
    "devpts",
    "devtmpfs",
    "efivarfs",
    "fuse.gvfsd-fuse",
    "fuse.portal",
    "fusectl",
    "hugetlbfs",
    "mqueue",
    "overlay",
    "proc",
    "pstore",
    "ramfs",
    "securityfs",
    "squashfs",
    "sysfs",
    "tmpfs",
    "tracefs",
}

#: Mount path prefixes that hold package/container images rather than data.
_PSEUDO_PREFIXES = ("/snap/", "/var/lib/docker/", "/var/snap/", "/run/", "/proc", "/sys")

#: Block device name prefixes that are not physical disks.
_VIRTUAL_DISK_PREFIXES = ("loop", "ram", "zram", "fd", "sr")

_SAFE_KEY = re.compile(r"[^a-z0-9]+")


def _history_key(mountpoint: str) -> str:
    """Turn a mountpoint into a history field name.

    History is keyed ``<collector>.<field>``, so dots and slashes in the field
    would make the series key ambiguous: ``/`` becomes ``root`` and
    ``/boot/efi`` becomes ``boot_efi``.
    """
    cleaned = _SAFE_KEY.sub("_", mountpoint.strip("/").lower()).strip("_")
    return cleaned or "root"


def _is_physical_disk(name: str) -> bool:
    if name.startswith(_VIRTUAL_DISK_PREFIXES):
        return False
    # Partitions (sda1) are not listed under /sys/block, only whole disks are.
    return Path("/sys/block", name).exists()


def _inode_usage(mountpoint: str) -> dict[str, Any]:
    """Inode totals via ``statvfs``; psutil does not expose these."""
    try:
        stat = os.statvfs(mountpoint)
    except OSError:
        return {"total": None, "free": None, "used": None, "percent": None}
    total = int(stat.f_files)
    free = int(stat.f_ffree)
    used = total - free
    return {
        "total": total,
        "free": free,
        "used": used,
        "percent": round(used / total * 100, 1) if total else None,
    }


@register
class DiskCollector(Collector):
    name = "disk"
    title = "Disks"
    default_interval = 15.0

    #: smartctl needs root and smartmontools, neither of which this read-only
    #: dashboard has; the field is reported so the UI can say so explicitly.
    SMART_REASON = "smartctl unavailable (smartmontools not installed, needs root)"

    def __init__(self, config: Config) -> None:
        super().__init__(config)
        configured = config.get("disk", "mounts", []) or []
        self._wanted_mounts = {str(mount) for mount in configured}
        self._prev_io: dict[str, Any] = {}
        self._prev_io_at: float | None = None

    async def collect(self) -> dict[str, Any]:
        # statvfs(2) is not a cheap /proc read: on a degraded device, an
        # exhausted thin pool or a stalled network mount it blocks in
        # uninterruptible kernel state. Run on the event loop it would freeze
        # every other collector and the HTTP server with it, and the sampler's
        # timeout could not help -- wait_for only preempts at await points.
        return await self.run_to_thread(self._collect_blocking)

    def _collect_blocking(self) -> dict[str, Any]:
        mounts = self._mounts()
        io = self._io_counters()
        highest = max(
            (m["percent"] for m in mounts if m.get("percent") is not None), default=None
        )

        return {
            "mounts": mounts,
            "max_percent": highest,
            "disks": io,
            "smart_available": False,
            "smart_reason": self.SMART_REASON,
        }

    def _mounts(self) -> list[dict[str, Any]]:
        try:
            partitions = psutil.disk_partitions(all=False)
        except OSError:
            return []

        mounts: list[dict[str, Any]] = []
        seen: set[str] = set()
        for part in partitions:
            if part.mountpoint in seen:
                continue
            if not self._include(part.mountpoint, part.fstype):
                continue
            try:
                usage = psutil.disk_usage(part.mountpoint)
            except OSError:
                continue
            seen.add(part.mountpoint)
            mounts.append(
                {
                    "device": part.device,
                    "mountpoint": part.mountpoint,
                    "fstype": part.fstype,
                    "options": part.opts,
                    "total": int(usage.total),
                    "used": int(usage.used),
                    "free": int(usage.free),
                    "percent": round(float(usage.percent), 1),
                    "inodes": _inode_usage(part.mountpoint),
                    "key": _history_key(part.mountpoint),
                }
            )
        return sorted(mounts, key=lambda m: m["mountpoint"])

    def _include(self, mountpoint: str, fstype: str) -> bool:
        if self._wanted_mounts:
            return mountpoint in self._wanted_mounts
        if fstype.lower() in _PSEUDO_FSTYPES or not fstype:
            return False
        return not mountpoint.startswith(_PSEUDO_PREFIXES)

    def _io_counters(self) -> list[dict[str, Any]]:
        """Per-disk counters with rates derived from the previous sample.

        The kernel exposes monotonic totals, so throughput only exists as a
        delta: the first sample after startup reports ``None`` rates rather
        than a zero that would look like an idle disk.
        """
        now = time.monotonic()
        try:
            counters = psutil.disk_io_counters(perdisk=True) or {}
        except OSError:
            counters = {}

        elapsed = now - self._prev_io_at if self._prev_io_at is not None else None
        disks: list[dict[str, Any]] = []

        for name, current in sorted(counters.items()):
            if not _is_physical_disk(name):
                continue
            previous = self._prev_io.get(name)
            read_rate: float | None = None
            write_rate: float | None = None
            read_iops: float | None = None
            write_iops: float | None = None
            if previous is not None and elapsed and elapsed > 0:
                read_rate = max(0.0, (current.read_bytes - previous.read_bytes) / elapsed)
                write_rate = max(0.0, (current.write_bytes - previous.write_bytes) / elapsed)
                read_iops = max(0.0, (current.read_count - previous.read_count) / elapsed)
                write_iops = max(0.0, (current.write_count - previous.write_count) / elapsed)
            disks.append(
                {
                    "name": name,
                    "read_bytes": int(current.read_bytes),
                    "write_bytes": int(current.write_bytes),
                    "read_count": int(current.read_count),
                    "write_count": int(current.write_count),
                    "read_bytes_per_sec": round(read_rate, 1) if read_rate is not None else None,
                    "write_bytes_per_sec": (
                        round(write_rate, 1) if write_rate is not None else None
                    ),
                    "read_iops": round(read_iops, 1) if read_iops is not None else None,
                    "write_iops": round(write_iops, 1) if write_iops is not None else None,
                    "busy_time_ms": int(getattr(current, "busy_time", 0)),
                }
            )

        self._prev_io = dict(counters)
        self._prev_io_at = now
        return disks

    def status_for(self, data: dict[str, Any]) -> Status:
        return threshold_status(
            data.get("max_percent"),
            self.config.threshold("disk_warn", 80.0),
            self.config.threshold("disk_critical", 90.0),
        )

    def history_fields(self, data: dict[str, Any]) -> dict[str, float]:
        return {
            mount["key"]: float(mount["percent"])
            for mount in data.get("mounts", [])
            if mount.get("percent") is not None
        }

    def meta(self) -> dict[str, Any]:
        return {
            "smart_available": False,
            "smart_reason": self.SMART_REASON,
            "configured_mounts": sorted(self._wanted_mounts),
            "physical_disks": sorted(
                name for name in (psutil.disk_io_counters(perdisk=True) or {})
                if _is_physical_disk(name)
            ),
        }
