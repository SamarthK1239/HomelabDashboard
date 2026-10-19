"""Pending APT updates, read strictly from the locally cached package state.

Refreshing the package cache (``apt update``) requires root. This dashboard is
read-only and runs unprivileged, so it never attempts it -- Ubuntu's own
``apt-daily`` systemd timer is what keeps the cache fresh. The consequence is
that every count here is only as trustworthy as the cache it came from, which
is why this collector measures and surfaces the cache age and refuses to look
healthy when that age is beyond ``[updates] stale_after_hours``.
"""

from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, ClassVar, Sequence

from .base import Collector, Status, register, worst

APT_CHECK = "/usr/lib/update-notifier/apt-check"
REBOOT_REQUIRED = Path("/var/run/reboot-required")
REBOOT_REQUIRED_PKGS = Path("/var/run/reboot-required.pkgs")

#: Candidate sources for "when was the package cache last refreshed", best
#: first. update-success-stamp is only touched on a *successful* refresh, so it
#: is the most honest signal; the lists directory mtimes are a decent proxy.
CACHE_AGE_SOURCES: tuple[tuple[str, Path], ...] = (
    ("/var/lib/apt/periodic/update-success-stamp", Path("/var/lib/apt/periodic/update-success-stamp")),
    ("/var/lib/apt/lists", Path("/var/lib/apt/lists")),
    ("/var/lib/apt/lists/partial", Path("/var/lib/apt/lists/partial")),
)

#: Packages whose upgrade visibly disrupts this machine, grouped by why. The
#: point is to answer "will applying these take my GPU stack or containers
#: down?" without reading 27 package names.
NOTABLE_PATTERNS: tuple[tuple[str, str, str], ...] = (
    (r"^linux-(image|headers|modules|generic|lowlatency|tools)", "kernel", "kernel update; requires a reboot"),
    (r"^(nvidia-|libnvidia-|cuda|nvidia$)", "gpu", "NVIDIA driver/runtime; disrupts GPU workloads"),
    (
        r"^(docker-ce|docker-ce-cli|docker-ce-rootless-extras|docker-buildx-plugin|docker-compose-plugin|containerd)",
        "container-runtime",
        "container runtime; restarts running containers",
    ),
)

_UPGRADABLE_RE = re.compile(
    r"^(?P<name>[^/\s]+)/(?P<suite>\S+)\s+(?P<candidate>\S+)\s+(?P<arch>\S+)\s+"
    r"\[upgradable from:\s*(?P<current>[^\]]+)\]"
)
_INST_RE = re.compile(r"^Inst\s+(?P<name>\S+)\s+\[(?P<current>[^\]]+)\]\s+\((?P<candidate>\S+)\s+(?P<rest>.*)\)")

#: Per-command ceiling. The sampler gives a collector 30s, and this collector
#: runs two apt commands, so each gets a slice of a shared budget rather than
#: the full 20s -- a wedged apt lock must degrade to partial data, not a hang.
COMMAND_TIMEOUT = 20.0
TOTAL_BUDGET = 25.0
MAX_PACKAGES = 100


def _run(argv: Sequence[str], timeout: float) -> tuple[int, str, str]:
    """Run a command with a hard timeout. Never uses a shell."""
    env = dict(os.environ, LC_ALL="C", LANG="C", DEBIAN_FRONTEND="noninteractive")
    proc = subprocess.run(
        list(argv),
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        check=False,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _human_age(seconds: float | None) -> str:
    if seconds is None:
        return "unknown"
    seconds = max(0.0, seconds)
    if seconds < 90:
        return f"{int(seconds)} seconds"
    minutes = seconds / 60
    if minutes < 90:
        return f"{int(round(minutes))} minutes"
    hours = minutes / 60
    if hours < 48:
        return f"{int(round(hours))} hours"
    return f"{int(round(hours / 24))} days"


def _strip_apt_noise(text: str) -> list[str]:
    """Drop apt's CLI-instability warning and blank/`Listing...` chatter."""
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("WARNING: apt does not have a stable CLI interface"):
            continue
        if stripped.startswith("Listing..."):
            continue
        lines.append(stripped)
    return lines


def _classify_notable(name: str) -> tuple[str | None, str | None]:
    for pattern, kind, reason in NOTABLE_PATTERNS:
        if re.match(pattern, name):
            return kind, reason
    return None, None


@register
class UpdatesCollector(Collector):
    name = "updates"
    title = "System Updates"
    default_interval = 3600.0

    _detection_method: ClassVar[str] = "unknown"

    def __init__(self, config: Any) -> None:
        super().__init__(config)
        self._stale_after_hours = float(self.config.get("updates", "stale_after_hours", 24) or 0)

    async def collect(self) -> dict[str, Any]:
        deadline = time.monotonic() + TOTAL_BUDGET
        errors: list[str] = []

        counts = await self.run_to_thread(self._headline_counts, deadline, errors)
        packages, truncated, pkg_total = await self.run_to_thread(self._upgradable, deadline, errors)
        cache = self._cache_age()
        reboot_required, reboot_pkgs = self._reboot_required()
        timer_state = await self.run_to_thread(self._apt_daily_state, deadline)

        total, security, method = counts
        # apt-check is the headline when available, but if it failed entirely
        # the package listing is still a usable count.
        if total is None and pkg_total is not None:
            total = pkg_total
            security = sum(1 for pkg in packages if pkg["security"])
            method = "apt-list-upgradable"
        UpdatesCollector._detection_method = method

        by_suite: dict[str, int] = {}
        for pkg in packages:
            by_suite[pkg["suite"]] = by_suite.get(pkg["suite"], 0) + 1

        notable = [
            {
                "name": pkg["name"],
                "kind": pkg["notable_kind"],
                "reason": pkg["notable_reason"],
                "security": pkg["security"],
                "current_version": pkg["current_version"],
                "candidate_version": pkg["candidate_version"],
            }
            for pkg in packages
            if pkg["notable_kind"]
        ]
        notable_kinds: dict[str, int] = {}
        for entry in notable:
            kind = str(entry["kind"])
            notable_kinds[kind] = notable_kinds.get(kind, 0) + 1

        reasons: list[str] = []
        if cache["cache_stale"]:
            reasons.append(cache["stale_reason"])
        if security:
            reasons.append(f"{security} pending security update{'s' if security != 1 else ''}")
        if reboot_required:
            reasons.append("reboot required to finish a previous upgrade")

        return {
            "total": total,
            "security": security,
            "regular": (total - security) if total is not None else None,
            "method": method,
            "packages": packages,
            "package_count": pkg_total,
            "truncated": truncated,
            "by_suite": by_suite,
            "notable": notable,
            "notable_count": len(notable),
            "notable_kinds": notable_kinds,
            "reboot_required": reboot_required,
            "reboot_required_packages": reboot_pkgs,
            "apt_daily_timer": timer_state,
            "refresh_note": (
                "Counts come from the local apt cache; refreshing it needs root, "
                "which this read-only dashboard never does. Ubuntu's apt-daily.timer "
                "refreshes the cache on its own schedule."
            ),
            "reasons": reasons,
            "errors": errors,
            "partial": total is None or pkg_total is None,
            **cache,
        }

    # -- headline counts ----------------------------------------------------

    def _headline_counts(self, deadline: float, errors: list[str]) -> tuple[int | None, int, str]:
        """Return ``(total, security, method)`` from the best available source."""
        if Path(APT_CHECK).exists():
            try:
                _, _, stderr = _run([APT_CHECK], self._budget(deadline))
                # apt-check writes "<total>;<security>" to stderr, with no
                # trailing newline, and nothing at all to stdout.
                match = re.search(r"(\d+)\s*;\s*(\d+)", stderr)
                if match:
                    return int(match.group(1)), int(match.group(2)), "apt-check"
                errors.append(f"apt-check output not parsable: {stderr.strip()[:120]!r}")
            except subprocess.TimeoutExpired:
                errors.append("apt-check timed out")
            except OSError as exc:
                errors.append(f"apt-check failed: {exc}")
        else:
            errors.append("apt-check not installed (update-notifier-common); using apt-get simulation")

        try:
            _, stdout, _ = _run(
                ["apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade"], self._budget(deadline)
            )
        except subprocess.TimeoutExpired:
            errors.append("apt-get -s upgrade timed out")
            return None, 0, "unavailable"
        except OSError as exc:
            errors.append(f"apt-get -s upgrade failed: {exc}")
            return None, 0, "unavailable"

        total = 0
        security = 0
        for line in stdout.splitlines():
            match = _INST_RE.match(line.strip())
            if not match:
                continue
            total += 1
            if "-security" in match.group("rest"):
                security += 1
        return total, security, "apt-get-simulate"

    # -- package detail -----------------------------------------------------

    def _upgradable(
        self, deadline: float, errors: list[str]
    ) -> tuple[list[dict[str, Any]], bool, int | None]:
        try:
            _, stdout, _ = _run(["apt", "list", "--upgradable"], self._budget(deadline))
        except subprocess.TimeoutExpired:
            errors.append("apt list --upgradable timed out; package detail unavailable")
            return [], False, None
        except OSError as exc:
            errors.append(f"apt list --upgradable failed: {exc}")
            return [], False, None

        packages: list[dict[str, Any]] = []
        for line in _strip_apt_noise(stdout):
            match = _UPGRADABLE_RE.match(line)
            if not match:
                continue
            suite = match.group("suite")
            kind, reason = _classify_notable(match.group("name"))
            packages.append(
                {
                    "name": match.group("name"),
                    "current_version": match.group("current").strip(),
                    "candidate_version": match.group("candidate"),
                    "architecture": match.group("arch"),
                    "suite": suite,
                    "security": "-security" in suite,
                    "notable_kind": kind,
                    "notable_reason": reason,
                }
            )

        total = len(packages)
        packages.sort(key=lambda pkg: (not pkg["security"], pkg["notable_kind"] is None, pkg["name"]))
        truncated = total > MAX_PACKAGES
        return packages[:MAX_PACKAGES], truncated, total

    # -- cache freshness ----------------------------------------------------

    def _cache_age(self) -> dict[str, Any]:
        """Measure how old the package cache is, and whether that is a problem.

        An unknown age counts as stale: a dashboard that cannot prove its
        update counts are recent must not present them as reassurance.
        """
        age_seconds: float | None = None
        source: str | None = None
        mtime: float | None = None

        for label, path in CACHE_AGE_SOURCES:
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            source = label
            break

        if mtime is None:
            newest = 0.0
            try:
                for entry in Path("/var/lib/apt/lists").glob("*Packages*"):
                    try:
                        newest = max(newest, entry.stat().st_mtime)
                    except OSError:
                        continue
            except OSError:
                newest = 0.0
            if newest:
                mtime = newest
                source = "/var/lib/apt/lists/*Packages*"

        if mtime is not None:
            age_seconds = max(0.0, time.time() - mtime)

        stale_after = self._stale_after_hours
        if age_seconds is None:
            stale = True
            reason = "apt cache age could not be determined; counts may be out of date"
        else:
            stale = age_seconds >= stale_after * 3600.0
            reason = (
                f"apt cache last refreshed {_human_age(age_seconds)} ago; counts may be out of date"
                if stale
                else ""
            )

        return {
            "cache_age_seconds": age_seconds,
            "cache_age_human": _human_age(age_seconds),
            "cache_source": source,
            "cache_updated_at": mtime,
            "cache_stale": stale,
            "stale_after_hours": stale_after,
            "stale_reason": reason,
        }

    # -- misc host state ----------------------------------------------------

    def _reboot_required(self) -> tuple[bool, list[str]]:
        if not REBOOT_REQUIRED.exists():
            return False, []
        packages: list[str] = []
        try:
            packages = [line.strip() for line in REBOOT_REQUIRED_PKGS.read_text().splitlines() if line.strip()]
        except OSError:
            packages = []
        return True, packages

    def _apt_daily_state(self, deadline: float) -> str | None:
        """Whether Ubuntu's own cache refresh timer is running. Best effort."""
        if not shutil.which("systemctl"):
            return None
        try:
            _, stdout, _ = _run(["systemctl", "is-active", "apt-daily.timer"], min(5.0, self._budget(deadline)))
        except (subprocess.TimeoutExpired, OSError):
            return None
        return stdout.strip() or None

    @staticmethod
    def _budget(deadline: float) -> float:
        return max(1.0, min(COMMAND_TIMEOUT, deadline - time.monotonic()))

    # -- status / history / meta -------------------------------------------

    def status_for(self, data: dict[str, Any]) -> Status:
        total = data.get("total")
        security = int(data.get("security") or 0)
        warn_at = self.config.threshold("updates_warn", 20)
        critical_at = self.config.threshold("updates_critical", 50)
        security_critical_at = self.config.threshold("security_updates_critical", 1)

        statuses: list[Status] = []
        if total is None:
            statuses.append(Status.UNKNOWN)
        elif total >= critical_at:
            statuses.append(Status.CRITICAL)
        elif total >= warn_at:
            statuses.append(Status.WARN)
        else:
            statuses.append(Status.OK)

        if security_critical_at > 0 and security >= security_critical_at:
            statuses.append(Status.CRITICAL)
        # A stale cache outranks a low update count: "0 pending" from a cache
        # nobody refreshed in a week is false assurance, not health.
        if data.get("cache_stale"):
            statuses.append(Status.WARN)
        if data.get("reboot_required"):
            statuses.append(Status.WARN)

        return worst(statuses)

    def history_fields(self, data: dict[str, Any]) -> dict[str, float]:
        total = data.get("total")
        if total is None:
            return {}
        return {"total": float(total), "security": float(data.get("security") or 0)}

    def meta(self) -> dict[str, Any]:
        info: dict[str, Any] = {
            "kernel": platform.release(),
            "detection_method": self._detection_method,
            "apt_check_available": Path(APT_CHECK).exists(),
            "privileged_refresh": False,
        }
        try:
            fields: dict[str, str] = {}
            for line in Path("/etc/os-release").read_text().splitlines():
                if "=" not in line:
                    continue
                key, _, value = line.partition("=")
                fields[key.strip()] = value.strip().strip('"')
            info["distro"] = fields.get("NAME")
            info["distro_version"] = fields.get("VERSION_ID")
            info["distro_pretty"] = fields.get("PRETTY_NAME")
            info["codename"] = fields.get("VERSION_CODENAME") or fields.get("UBUNTU_CODENAME")
        except OSError:
            pass
        return info
