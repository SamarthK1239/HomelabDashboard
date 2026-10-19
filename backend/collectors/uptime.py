"""Boot time, uptime and pending-reboot state.

Ubuntu drops ``/var/run/reboot-required`` when a package (typically the kernel
or libc) needs a restart to take effect. Surfacing that is the point of this
card: a machine that has been up for months may simply be running known-bad
code rather than being impressively stable.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import psutil

from ..config import Config
from .base import Collector, Status, register

_REBOOT_REQUIRED = Path("/var/run/reboot-required")
_REBOOT_REQUIRED_PKGS = Path("/var/run/reboot-required.pkgs")


def _format_uptime(seconds: float) -> str:
    """Render uptime the way ``uptime(1)`` does: ``11 days, 4:32``."""
    total = int(seconds)
    days, remainder = divmod(total, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes = remainder // 60
    clock = f"{hours}:{minutes:02d}"
    if days:
        return f"{days} day{'s' if days != 1 else ''}, {clock}"
    return clock


def _reboot_packages() -> list[str]:
    try:
        lines = _REBOOT_REQUIRED_PKGS.read_text().splitlines()
    except OSError:
        return []
    return sorted({line.strip() for line in lines if line.strip()})


def _logged_in_users() -> list[str]:
    """Distinct usernames; one person with ten terminals is still one user."""
    try:
        return sorted({user.name for user in psutil.users()})
    except (OSError, RuntimeError):
        return []


@register
class UptimeCollector(Collector):
    name = "uptime"
    title = "Uptime"
    default_interval = 2.0

    def __init__(self, config: Config) -> None:
        super().__init__(config)
        self._boot_time = psutil.boot_time()

    async def collect(self) -> dict[str, Any]:
        uptime_seconds = max(0.0, time.time() - self._boot_time)
        load1, load5, load15 = os.getloadavg()

        try:
            reboot_required = _REBOOT_REQUIRED.exists()
        except OSError:
            reboot_required = False

        users = _logged_in_users()

        return {
            "boot_time": self._boot_time,
            "uptime_seconds": round(uptime_seconds, 1),
            "uptime_human": _format_uptime(uptime_seconds),
            "load_average": {
                "1m": round(load1, 2),
                "5m": round(load5, 2),
                "15m": round(load15, 2),
            },
            "reboot_required": reboot_required,
            "reboot_required_packages": _reboot_packages() if reboot_required else [],
            "users": users,
            "user_count": len(users),
        }

    def status_for(self, data: dict[str, Any]) -> Status:
        return Status.WARN if data.get("reboot_required") else Status.OK

    def history_fields(self, data: dict[str, Any]) -> dict[str, float]:
        # Uptime climbs monotonically and resets to zero; a sparkline of it
        # carries no information the numeric value does not already give.
        return {}

    def meta(self) -> dict[str, Any]:
        return {
            "boot_time": self._boot_time,
            "boot_time_iso": time.strftime(
                "%Y-%m-%dT%H:%M:%S", time.localtime(self._boot_time)
            ),
            "hostname": os.uname().nodename,
            "kernel": os.uname().release,
        }
