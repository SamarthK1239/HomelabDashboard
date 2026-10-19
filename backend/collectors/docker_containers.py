"""Docker container inventory and per-container resource usage.

The module is deliberately *not* called ``docker.py``: that would shadow the
``docker`` PyPI package for every absolute import inside this package.

This collector is strictly read-only. The Docker socket is root-equivalent, so
nothing here lists, inspects or samples beyond what a ``docker ps`` would do --
there are no lifecycle calls (start/stop/restart/exec/pull/rm) anywhere in this
file, by design.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import time
from typing import Any

import docker
from docker.errors import DockerException

from .base import Collector, Status, register

#: Upper bound for a single ``stats(stream=False)`` call. The daemon samples
#: twice (~1-2s normally), but a wedged container can hang indefinitely; the
#: sampler's global 30s budget must not be spent on one bad container.
STATS_TIMEOUT = 8.0

#: Socket timeout for the Docker client, deliberately below STATS_TIMEOUT so a
#: blocked call unwinds its worker thread before the async side gives up on it.
DOCKER_SOCKET_TIMEOUT = 6

#: Docker reports "never happened" timestamps as year 1, not as null.
_ZERO_TIME_PREFIX = "0001-01-01"


def _parse_time(value: Any) -> str | None:
    """Return a Docker RFC3339 timestamp, or ``None`` for an unset one."""
    if not isinstance(value, str) or not value or value.startswith(_ZERO_TIME_PREFIX):
        return None
    return value


def _parse_epoch(value: Any) -> float | None:
    """Return a Docker RFC3339 timestamp as a Unix epoch, or ``None``.

    Docker emits nanosecond precision, which :meth:`datetime.fromisoformat`
    rejects, so the fractional part is truncated to microseconds.
    """
    text = _parse_time(value)
    if text is None:
        return None
    text = text.replace("Z", "+00:00")
    if "." in text:
        head, _, tail = text.partition(".")
        digits = ""
        rest = ""
        for index, char in enumerate(tail):
            if char.isdigit():
                digits += char
            else:
                rest = tail[index:]
                break
        text = f"{head}.{digits[:6]}{rest}"
    try:
        return dt.datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def _format_ports(ports: dict[str, Any] | None) -> list[str]:
    """Render ``NetworkSettings.Ports`` the way ``docker ps`` does.

    A published port usually has both an IPv4 and an IPv6 binding on the same
    host port; collapsing them keeps the card readable without losing
    information.
    """
    if not ports:
        return []
    rendered: list[str] = []
    seen: set[tuple[str, str]] = set()
    for container_port, bindings in sorted(ports.items()):
        if not bindings:
            rendered.append(container_port)
            continue
        for binding in bindings:
            host_ip = binding.get("HostIp") or "0.0.0.0"
            host_port = str(binding.get("HostPort") or "")
            key = (host_port, container_port)
            if key in seen:
                continue
            seen.add(key)
            if ":" in host_ip:
                host_ip = f"[{host_ip}]"
            rendered.append(f"{host_ip}:{host_port}->{container_port}")
    return rendered


def _image_name(attrs: dict[str, Any]) -> str:
    """Prefer the human-readable image reference over the content digest."""
    config_image = attrs.get("Config", {}).get("Image")
    if isinstance(config_image, str) and config_image and not config_image.startswith("sha256:"):
        return config_image
    image = attrs.get("Image")
    return image[:19] if isinstance(image, str) else "unknown"


def _sum_networks(stats: dict[str, Any]) -> tuple[int | None, int | None]:
    networks = stats.get("networks")
    if not isinstance(networks, dict) or not networks:
        return None, None
    rx = sum(int(iface.get("rx_bytes", 0) or 0) for iface in networks.values())
    tx = sum(int(iface.get("tx_bytes", 0) or 0) for iface in networks.values())
    return rx, tx


def _sum_blkio(stats: dict[str, Any]) -> tuple[int | None, int | None]:
    entries = (stats.get("blkio_stats") or {}).get("io_service_bytes_recursive")
    if not entries:
        return None, None
    read = write = 0
    for entry in entries:
        op = str(entry.get("op", "")).lower()
        value = int(entry.get("value", 0) or 0)
        if op == "read":
            read += value
        elif op == "write":
            write += value
    return read, write


def _cpu_percent(stats: dict[str, Any]) -> float | None:
    """Standard Docker CPU percentage from the cpu/precpu delta.

    ``system_cpu_usage`` is missing on the first read of a stream and on some
    cgroup v2 setups; returning ``None`` there is honest, whereas 0.0 would
    look like a genuinely idle container.
    """
    cpu = stats.get("cpu_stats") or {}
    precpu = stats.get("precpu_stats") or {}
    try:
        cpu_delta = cpu["cpu_usage"]["total_usage"] - precpu["cpu_usage"]["total_usage"]
        system_delta = cpu["system_cpu_usage"] - precpu["system_cpu_usage"]
    except (KeyError, TypeError):
        return None
    if not system_delta or system_delta <= 0 or cpu_delta < 0:
        return None

    online = cpu.get("online_cpus")
    if not online:
        percpu = (cpu.get("cpu_usage") or {}).get("percpu_usage") or []
        online = len(percpu)
    if not online:
        return None
    return round((cpu_delta / system_delta) * online * 100.0, 2)


def _memory(stats: dict[str, Any]) -> tuple[int | None, int | None, float | None]:
    """Used/limit/percent, excluding page cache like the Docker CLI does."""
    memory = stats.get("memory_stats") or {}
    usage = memory.get("usage")
    limit = memory.get("limit")
    if usage is None:
        return None, limit, None
    detail = memory.get("stats") or {}
    # The Docker CLI prefers total_inactive_file (cgroup v1, includes child
    # cgroups) and falls back to inactive_file (cgroup v2). Checking them the
    # other way round under-subtracts page cache for any container with child
    # cgroups -- systemd as PID 1, nested containers -- inflating used memory.
    cache = detail.get("total_inactive_file")
    if cache is None:
        cache = detail.get("inactive_file", 0)
    used = max(0, int(usage) - int(cache or 0))
    percent = round(used / limit * 100.0, 2) if limit else None
    return used, limit, percent


@register
class DockerCollector(Collector):
    """Inventory of every container on the host, running or not."""

    name = "docker"
    title = "Docker"
    default_interval = 10.0

    def __init__(self, config: Any) -> None:
        super().__init__(config)
        self._client: docker.DockerClient | None = None
        self._include_stats = bool(self.config.get("docker", "include_stats", True))

    def _ensure_client(self) -> docker.DockerClient:
        """Connect on first use and keep the connection for later samples.

        Reconnecting every interval would re-negotiate the API version with the
        daemon on each sample for no benefit.

        The socket timeout matters more than it looks: ``asyncio.to_thread``
        cannot be cancelled, so a ``wait_for`` timeout abandons the coroutine
        while the worker thread stays blocked until the socket gives up. At
        docker-py's 60s default, a few wedged containers would pin threads in
        the shared executor and stall every other collector. Bounding the
        blocking call below STATS_TIMEOUT keeps the thread recoverable.
        """
        if self._client is None:
            self._client = docker.from_env(timeout=DOCKER_SOCKET_TIMEOUT)
        return self._client

    async def collect(self) -> dict[str, Any]:
        containers, status_lines = await self.run_to_thread(self._list)

        entries = [self._describe(container, status_lines) for container in containers]

        if self._include_stats:
            running = [c for c in containers if c.attrs.get("State", {}).get("Running")]
            # Each stats call costs ~1-2s on the daemon side, so they run
            # together rather than one after another.
            samples = await asyncio.gather(*(self._stats_for(c) for c in running))
            by_id = dict(zip((c.id for c in running), samples))
            for entry, container in zip(entries, containers):
                entry["stats"] = by_id.get(container.id)
        else:
            for entry in entries:
                entry["stats"] = None

        return {"containers": entries, "summary": self._summarise(entries), "stats_enabled": self._include_stats}

    def _list(self) -> tuple[list[Any], dict[str, str]]:
        """Fetch every container plus the ``docker ps`` status line for each.

        ``containers.list`` returns inspect output, which has structured state
        but not the human summary ("Up 11 days (healthy)"); the raw list
        endpoint has the summary, so both are read once per sample.
        """
        client = self._ensure_client()
        containers = client.containers.list(all=True)
        status_lines: dict[str, str] = {}
        try:
            for raw in client.api.containers(all=True):
                container_id = raw.get("Id")
                status = raw.get("Status")
                if isinstance(container_id, str) and isinstance(status, str):
                    status_lines[container_id] = status
        except (DockerException, OSError):
            pass
        return containers, status_lines

    async def _stats_for(self, container: Any) -> dict[str, Any] | None:
        """One-shot stats for a container; ``None`` if it misbehaves.

        Isolated per container so a single hanging or vanishing container
        degrades to a missing stats block instead of failing the whole card.
        """
        try:
            raw = await asyncio.wait_for(
                self.run_to_thread(lambda: container.stats(stream=False)),
                timeout=STATS_TIMEOUT,
            )
        except (asyncio.TimeoutError, DockerException, OSError, ValueError):
            return None
        if not isinstance(raw, dict):
            return None

        used, limit, percent = _memory(raw)
        rx, tx = _sum_networks(raw)
        read, write = _sum_blkio(raw)
        return {
            "cpu_percent": _cpu_percent(raw),
            "memory_used_bytes": used,
            "memory_limit_bytes": limit,
            "memory_percent": percent,
            "network_rx_bytes": rx,
            "network_tx_bytes": tx,
            "block_read_bytes": read,
            "block_write_bytes": write,
        }

    def _describe(self, container: Any, status_lines: dict[str, str]) -> dict[str, Any]:
        attrs = container.attrs or {}
        state = attrs.get("State") or {}
        health = (state.get("Health") or {}).get("Status")
        started_at = _parse_time(state.get("StartedAt"))
        started_epoch = _parse_epoch(state.get("StartedAt"))
        running = bool(state.get("Running"))

        uptime: float | None = None
        if running and started_epoch is not None:
            uptime = max(0.0, round(time.time() - started_epoch, 1))

        exit_code = state.get("ExitCode")
        ports = (attrs.get("NetworkSettings") or {}).get("Ports")

        return {
            "id": container.short_id,
            "name": container.name,
            "image": _image_name(attrs),
            "state": state.get("Status") or container.status,
            "status": status_lines.get(container.id) or state.get("Status") or container.status,
            "health": health,
            "created_at": _parse_time(attrs.get("Created")),
            "started_at": started_at,
            "finished_at": _parse_time(state.get("FinishedAt")),
            "uptime_seconds": uptime,
            "restart_count": int(attrs.get("RestartCount", 0) or 0),
            "exit_code": int(exit_code) if not running and exit_code is not None else None,
            "ports": _format_ports(ports),
        }

    @staticmethod
    def _summarise(entries: list[dict[str, Any]]) -> dict[str, int]:
        return {
            "total": len(entries),
            "running": sum(1 for e in entries if e["state"] == "running"),
            "exited": sum(1 for e in entries if e["state"] == "exited"),
            "unhealthy": sum(1 for e in entries if e["health"] == "unhealthy"),
            "restarting": sum(1 for e in entries if e["state"] == "restarting"),
        }

    def status_for(self, data: dict[str, Any]) -> Status:
        containers = data.get("containers") or []
        if any(c.get("health") == "unhealthy" for c in containers):
            return Status.CRITICAL
        for container in containers:
            if container.get("state") == "restarting":
                return Status.WARN
            # A one-shot container that exited cleanly is a normal end state;
            # only a non-zero exit is worth flagging.
            if container.get("state") == "exited" and (container.get("exit_code") or 0) != 0:
                return Status.WARN
        return Status.OK

    def history_fields(self, data: dict[str, Any]) -> dict[str, float]:
        """Aggregates only -- per-container series would let arbitrary container
        names create unbounded history keys.

        The CPU total is omitted unless every running container actually
        reported a number. Summing what we happen to have would turn "stats
        unavailable" into a confident ``0.0``, drawing a flat idle line for a
        busy machine -- and with ``include_stats = false`` it would do so
        forever.
        """
        measured = 0
        running_containers = 0
        total_cpu = 0.0
        for container in data.get("containers") or []:
            if container.get("state") != "running":
                continue
            running_containers += 1
            stats = container.get("stats") or {}
            cpu = stats.get("cpu_percent")
            if isinstance(cpu, (int, float)):
                total_cpu += float(cpu)
                measured += 1

        summary = data.get("summary") or {}
        fields: dict[str, float] = {"running": float(summary.get("running", 0))}
        if self._include_stats and measured == running_containers:
            fields["cpu_percent"] = round(total_cpu, 2)
        return fields

    def meta(self) -> dict[str, Any]:
        try:
            client = self._ensure_client()
            version = client.version()
            info = client.info()
        except (DockerException, OSError) as exc:
            return {"available": False, "error": str(exc)}
        return {
            "available": True,
            "server_version": version.get("Version"),
            "api_version": version.get("ApiVersion"),
            "images": info.get("Images"),
            "daemon_cpus": info.get("NCPU"),
            "daemon_memory_bytes": info.get("MemTotal"),
            "operating_system": info.get("OperatingSystem"),
        }

    async def aclose(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            await self.run_to_thread(client.close)
