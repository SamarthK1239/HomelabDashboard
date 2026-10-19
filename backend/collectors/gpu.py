"""NVIDIA GPU collector.

NVML is queried in-process via ``pynvml`` rather than by shelling out to
``nvidia-smi``: at a two second cadence, forking a process and re-opening the
driver every sample is pure overhead. NVML is initialised lazily on the first
collect and the device handles are kept for the life of the collector.

``nvidia-smi`` is still used, parsed from CSV, as a fallback for the case where
NVML cannot initialise at all (driver mismatch, missing library, container
without the NVML shim). That path reports a reduced field set, which is why
every sample records the ``source`` it came from.

The GPUs in this machine are deliberately heterogeneous (a 16 GB Tesla V100 and
a 24 GB RTX 3090 sharing one llama.cpp workload via ``--tensor-split``), so
nothing here is ever averaged across devices: every card is reported with its
own limits and classified against the thresholds on its own.
"""

from __future__ import annotations

import re
import subprocess
import time
from typing import Any, Callable, TypeVar

from ..config import Config
from .base import Collector, Status, register, threshold_status, worst

_T = TypeVar("_T")

NVIDIA_SMI = "/usr/bin/nvidia-smi"

#: How long to wait before retrying NVML after a failure. Driver reloads and
#: transient Xid errors are recoverable, so failures back off rather than
#: latching the collector onto the nvidia-smi fallback permanently.
NVML_RETRY_SECONDS = 60.0

#: Cgroup lines name the container by its full 64-hex id, in a handful of
#: layouts: ``/docker/<id>``, ``docker-<id>.scope``, ``cri-containerd-<id>``.
#: Matching the bare id covers all of them.
_CONTAINER_ID_RE = re.compile(r"\b([0-9a-f]{64})\b")

#: NVML renamed the "clocks throttle reasons" API to "clocks event reasons".
#: Both the constants and the getter may appear under either name depending on
#: the pynvml version, so each label is looked up under both spellings.
_THROTTLE_REASONS: list[tuple[str, str]] = [
    ("GpuIdle", "GPU idle"),
    ("ApplicationsClocksSetting", "Application clocks setting"),
    ("SwPowerCap", "Software power cap"),
    ("HwSlowdown", "Hardware slowdown"),
    ("SyncBoost", "Sync boost"),
    ("SwThermalSlowdown", "Software thermal slowdown"),
    ("HwThermalSlowdown", "Hardware thermal slowdown"),
    ("HwPowerBrakeSlowdown", "Hardware power brake slowdown"),
    ("DisplayClockSetting", "Display clock setting"),
    ("BoardLimit", "Board limit"),
    ("Reliability", "Reliability"),
    ("UserDefinedClocks", "User defined clocks"),
]

#: Reasons that do not indicate the card is being held back from doing work.
#: An idle GPU reports "GPU idle" permanently, so treating every non-zero mask
#: as throttling would make the card look perpetually degraded.
_BENIGN_REASONS = {"GPU idle", "Display clock setting", "Application clocks setting"}

_POWER_CAP_REASON = "Software power cap"

#: Fraction of the enforced power limit the card must actually be drawing
#: before "Software power cap" is believed.
_POWER_CAP_MIN_RATIO = 0.85


def _is_throttled(
    reasons: list[str] | None,
    power_draw_w: float | None,
    power_limit_w: float | None,
) -> bool | None:
    """Decide whether the reported reasons mean real work is being held back.

    "Software power cap" needs context. On an idle consumer card the driver
    attributes the idle downclock to the power-management algorithm, so the
    SwPowerCap bit flickers on while the GPU sits at its minimum clock drawing
    a small fraction of its budget -- an RTX 3090 reports it at 33 W of a 420 W
    limit. Alarming on that trains the reader to ignore the throttle warning,
    which matters because the same flag is genuinely important when the card is
    pinned at its limit. It is therefore only believed when the card is drawing
    close enough to the limit for the cap to be what is actually binding.
    """
    if reasons is None:
        return None
    for reason in reasons:
        if reason in _BENIGN_REASONS:
            continue
        if reason == _POWER_CAP_REASON:
            if (
                power_draw_w is None
                or power_limit_w is None
                or power_limit_w <= 0
                or power_draw_w / power_limit_w < _POWER_CAP_MIN_RATIO
            ):
                continue
        return True
    return False


def _try(fn: Callable[[], _T], default: Any = None) -> Any:
    """Evaluate ``fn``, returning ``default`` if it raises.

    Every NVML field is wrapped in this: the V100 has no fan, consumer cards
    lack several power and ECC queries, and each of those raises
    ``NVMLError_NotSupported``. A missing field must yield ``None`` for that
    field alone, never fail the sample.
    """
    try:
        return fn()
    except Exception:
        return default


def _as_str(value: Any) -> str | None:
    """Normalise NVML strings, which are ``bytes`` on older pynvml builds."""
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def _as_float(value: Any) -> float | None:
    """Parse a possibly-absent numeric field (nvidia-smi writes ``[N/A]``)."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.startswith("[") or text.lower() in {"n/a", "unknown"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _as_int(value: Any) -> int | None:
    number = _as_float(value)
    return int(number) if number is not None else None


def _format_cuda(version: Any) -> str | None:
    """Render NVML's packed CUDA version (e.g. ``13000``) as ``13.0``."""
    if not isinstance(version, int) or version <= 0:
        return None
    return f"{version // 1000}.{(version % 1000) // 10}"


def _read_comm(pid: int) -> str | None:
    with open(f"/proc/{pid}/comm", "r", encoding="utf-8") as handle:
        return handle.read().strip() or None


def _percent(used: float | None, total: float | None) -> float | None:
    if used is None or not total:
        return None
    return round(used / total * 100.0, 2)


@register
class GpuCollector(Collector):
    name = "gpu"
    title = "GPUs"
    default_interval = 2.0

    def __init__(self, config: Config) -> None:
        super().__init__(config)
        self._nvml: Any = None
        self._handles: list[Any] = []
        self._nvml_failed = False
        self._nvml_retry_after = 0.0
        self._nvml_error: str | None = None
        self._reason_masks: list[tuple[int, str]] = []
        self._static: dict[str, Any] = {}
        #: Container ids are stable for the life of a container, and resolving
        #: one costs a Docker API round trip, so the id -> name map is cached.
        self._container_names: dict[str, str] = {}
        self._docker_client: Any = None
        self._docker_failed = False

    # ------------------------------------------------------------------ NVML

    def _init_nvml(self) -> bool:
        """Initialise NVML once and cache the device handles.

        A failure backs off rather than latching permanently: driver reloads,
        Xid errors and a device briefly leaving the bus are all recoverable, and
        a permanent latch would strand the collector on the ``nvidia-smi``
        fallback (losing throttle reasons and the CUDA version, and forking two
        processes every two seconds) for the life of the service.
        """
        if self._handles:
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
                # nvmlInit() succeeded, so it owes a shutdown. NVML refcounts
                # init/shutdown pairs; leaking one per retry would accumulate
                # for the life of the service against a flapping driver.
                _try(lambda: pynvml.nvmlShutdown())
                raise
            self._nvml = pynvml
            self._reason_masks = self._build_reason_masks(pynvml)
            self._nvml_error = None
            self._nvml_failed = False
            return True
        except Exception as exc:
            self._mark_nvml_failed(f"{type(exc).__name__}: {exc}")
            return False

    def _mark_nvml_failed(self, error: str) -> None:
        """Record an NVML failure and schedule a retry."""
        self._nvml_error = error
        self._nvml_failed = True
        self._nvml_retry_after = time.monotonic() + NVML_RETRY_SECONDS
        pynvml, self._nvml = self._nvml, None
        if pynvml is not None:
            # Pair the earlier successful nvmlInit() before we retry it.
            _try(lambda: pynvml.nvmlShutdown())
        self._handles = []

    @staticmethod
    def _build_reason_masks(pynvml: Any) -> list[tuple[int, str]]:
        masks: list[tuple[int, str]] = []
        for suffix, label in _THROTTLE_REASONS:
            for prefix in ("nvmlClocksEventReason", "nvmlClocksThrottleReason"):
                mask = getattr(pynvml, prefix + suffix, None)
                if isinstance(mask, int):
                    masks.append((mask, label))
                    break
        return masks

    def _throttle_reasons(self, handle: Any) -> list[str] | None:
        pynvml = self._nvml
        getter = getattr(pynvml, "nvmlDeviceGetCurrentClocksEventReasons", None)
        if getter is None:
            getter = getattr(pynvml, "nvmlDeviceGetCurrentClocksThrottleReasons", None)
        if getter is None:
            return None
        mask = _try(lambda: getter(handle))
        if mask is None:
            return None
        return [label for bit, label in self._reason_masks if mask & bit]

    def _compute_processes(self, handle: Any) -> list[dict[str, Any]]:
        """List compute processes on a device, newest NVML ABI first.

        The ``_v3`` struct is only present on recent drivers; older ones expose
        ``_v2`` or the unversioned call, and calling the wrong one raises
        ``NVMLError_FunctionNotFound``.
        """
        pynvml = self._nvml
        procs: list[Any] = []
        for attr in (
            "nvmlDeviceGetComputeRunningProcesses_v3",
            "nvmlDeviceGetComputeRunningProcesses_v2",
            "nvmlDeviceGetComputeRunningProcesses",
        ):
            getter = getattr(pynvml, attr, None)
            if getter is None:
                continue
            result = _try(lambda g=getter: g(handle))
            if result is not None:
                procs = list(result)
                break

        out: list[dict[str, Any]] = []
        for proc in procs:
            used = getattr(proc, "usedGpuMemory", None)
            # NVML reports a sentinel instead of a size when the process memory
            # is not visible (e.g. another user's container under MIG).
            if used is not None and used >= 2**63:
                used = None
            out.append(self._describe_process(int(proc.pid), used))
        out.sort(key=lambda p: (-(p.get("used_memory_bytes") or 0), p["pid"]))
        return out

    # -------------------------------------------------------------- processes

    def _describe_process(self, pid: int, used: int | None) -> dict[str, Any]:
        """Annotate a GPU process with its command name and Docker container.

        Everything beyond the PID is best-effort: ``/proc/<pid>`` belonging to
        another user, a vanished process, or an unreachable Docker socket must
        degrade to just the PID and its memory usage.
        """
        entry: dict[str, Any] = {
            "pid": pid,
            "used_memory_bytes": int(used) if used is not None else None,
            "name": None,
            "container_id": None,
            "container_name": None,
        }

        try:
            import psutil

            entry["name"] = psutil.Process(pid).name()
        except Exception:
            entry["name"] = _try(lambda: _read_comm(pid))

        container_id = _try(lambda: self._container_id_for(pid))
        if container_id:
            entry["container_id"] = container_id[:12]
            entry["container_name"] = self._container_name(container_id)
        return entry

    @staticmethod
    def _container_id_for(pid: int) -> str | None:
        with open(f"/proc/{pid}/cgroup", "r", encoding="utf-8") as handle:
            for line in handle:
                match = _CONTAINER_ID_RE.search(line)
                if match:
                    return match.group(1)
        return None

    def _container_name(self, container_id: str) -> str | None:
        """Resolve a container id to its friendly name, if Docker is reachable.

        Purely cosmetic, so a missing SDK or a permission-denied socket is
        swallowed and never retried after the first failure.
        """
        cached = self._container_names.get(container_id)
        if cached is not None:
            return cached
        if self._docker_failed:
            return None
        if self._docker_client is None:
            try:
                import docker

                self._docker_client = docker.from_env()
            except Exception:
                self._docker_failed = True
                return None
        try:
            name = self._docker_client.containers.get(container_id).name
        except Exception:
            return None
        self._container_names[container_id] = name
        return name

    # ---------------------------------------------------------------- sampling

    def _sample_device(self, index: int, handle: Any) -> dict[str, Any]:
        pynvml = self._nvml
        memory = _try(lambda: pynvml.nvmlDeviceGetMemoryInfo(handle))
        util = _try(lambda: pynvml.nvmlDeviceGetUtilizationRates(handle))

        used = int(memory.used) if memory else None
        total = int(memory.total) if memory else None
        power_draw = _try(lambda: pynvml.nvmlDeviceGetPowerUsage(handle))
        power_limit = _try(lambda: pynvml.nvmlDeviceGetEnforcedPowerLimit(handle))
        if power_limit is None:
            power_limit = _try(
                lambda: pynvml.nvmlDeviceGetPowerManagementLimit(handle)
            )
        persistence = _try(lambda: pynvml.nvmlDeviceGetPersistenceMode(handle))
        reasons = self._throttle_reasons(handle)
        power_draw_w = round(power_draw / 1000.0, 2) if power_draw is not None else None
        power_limit_w = (
            round(power_limit / 1000.0, 2) if power_limit is not None else None
        )

        return {
            "index": index,
            "name": _as_str(_try(lambda: pynvml.nvmlDeviceGetName(handle))),
            "uuid": _as_str(_try(lambda: pynvml.nvmlDeviceGetUUID(handle))),
            "utilization_percent": float(util.gpu) if util else None,
            "memory_utilization_percent": float(util.memory) if util else None,
            "memory_used_bytes": used,
            "memory_total_bytes": total,
            "memory_free_bytes": int(memory.free) if memory else None,
            "memory_percent": _percent(used, total),
            "temperature_c": _try(
                lambda: float(
                    pynvml.nvmlDeviceGetTemperature(
                        handle, pynvml.NVML_TEMPERATURE_GPU
                    )
                )
            ),
            "power_draw_watts": power_draw_w,
            "power_limit_watts": power_limit_w,
            "fan_percent": _try(
                lambda: float(pynvml.nvmlDeviceGetFanSpeed(handle))
            ),
            "clock_sm_mhz": _try(
                lambda: pynvml.nvmlDeviceGetClockInfo(handle, pynvml.NVML_CLOCK_SM)
            ),
            "clock_sm_max_mhz": _try(
                lambda: pynvml.nvmlDeviceGetMaxClockInfo(handle, pynvml.NVML_CLOCK_SM)
            ),
            "clock_memory_mhz": _try(
                lambda: pynvml.nvmlDeviceGetClockInfo(handle, pynvml.NVML_CLOCK_MEM)
            ),
            "clock_memory_max_mhz": _try(
                lambda: pynvml.nvmlDeviceGetMaxClockInfo(handle, pynvml.NVML_CLOCK_MEM)
            ),
            "pcie_generation": _try(
                lambda: pynvml.nvmlDeviceGetCurrPcieLinkGeneration(handle)
            ),
            "pcie_width": _try(
                lambda: pynvml.nvmlDeviceGetCurrPcieLinkWidth(handle)
            ),
            "pcie_max_generation": _try(
                lambda: pynvml.nvmlDeviceGetMaxPcieLinkGeneration(handle)
            ),
            "pcie_max_width": _try(
                lambda: pynvml.nvmlDeviceGetMaxPcieLinkWidth(handle)
            ),
            "persistence_mode": None if persistence is None else bool(persistence),
            "throttle_reasons": reasons,
            "throttled": _is_throttled(reasons, power_draw_w, power_limit_w),
            "processes": self._compute_processes(handle),
        }

    def _collect_nvml(self) -> dict[str, Any]:
        pynvml = self._nvml
        gpus = [
            self._sample_device(index, handle)
            for index, handle in enumerate(self._handles)
        ]
        cuda = _try(lambda: pynvml.nvmlSystemGetCudaDriverVersion_v2())
        if cuda is None:
            cuda = _try(lambda: pynvml.nvmlSystemGetCudaDriverVersion())
        return {
            "source": "nvml",
            "available": True,
            "count": len(gpus),
            "driver_version": _as_str(
                _try(lambda: pynvml.nvmlSystemGetDriverVersion())
            ),
            "cuda_version": _format_cuda(cuda),
            "gpus": gpus,
        }

    # ---------------------------------------------------------------- fallback

    def _collect_smi(self) -> dict[str, Any]:
        """Parse ``nvidia-smi`` CSV output as a fallback for a broken NVML."""
        fields = [
            "index",
            "name",
            "uuid",
            "utilization.gpu",
            "utilization.memory",
            "memory.used",
            "memory.total",
            "memory.free",
            "temperature.gpu",
            "power.draw",
            "power.limit",
            "fan.speed",
            "clocks.sm",
            "clocks.max.sm",
            "clocks.mem",
            "clocks.max.mem",
            "pcie.link.gen.current",
            "pcie.link.gen.max",
            "pcie.link.width.current",
            "pcie.link.width.max",
            "persistence_mode",
            "driver_version",
        ]
        out = subprocess.run(
            [
                NVIDIA_SMI,
                "--query-gpu=" + ",".join(fields),
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )

        gpus: list[dict[str, Any]] = []
        driver: str | None = None
        by_uuid = self._smi_processes()
        for line in out.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            cells = [cell.strip() for cell in line.split(",")]
            if len(cells) < len(fields):
                continue
            row = dict(zip(fields, cells))
            driver = driver or (row["driver_version"] or None)

            # nvidia-smi reports memory in MiB under ``nounits``.
            used_mib = _as_float(row["memory.used"])
            total_mib = _as_float(row["memory.total"])
            free_mib = _as_float(row["memory.free"])
            used = int(used_mib * 1024 * 1024) if used_mib is not None else None
            total = int(total_mib * 1024 * 1024) if total_mib is not None else None
            uuid = row["uuid"] or None
            persistence = row["persistence_mode"].strip().lower()

            gpus.append(
                {
                    "index": int(_as_float(row["index"]) or len(gpus)),
                    "name": row["name"] or None,
                    "uuid": uuid,
                    "utilization_percent": _as_float(row["utilization.gpu"]),
                    "memory_utilization_percent": _as_float(
                        row["utilization.memory"]
                    ),
                    "memory_used_bytes": used,
                    "memory_total_bytes": total,
                    "memory_free_bytes": (
                        int(free_mib * 1024 * 1024) if free_mib is not None else None
                    ),
                    "memory_percent": _percent(used, total),
                    "temperature_c": _as_float(row["temperature.gpu"]),
                    "power_draw_watts": _as_float(row["power.draw"]),
                    "power_limit_watts": _as_float(row["power.limit"]),
                    "fan_percent": _as_float(row["fan.speed"]),
                    "clock_sm_mhz": _as_int(row["clocks.sm"]),
                    "clock_sm_max_mhz": _as_int(row["clocks.max.sm"]),
                    "clock_memory_mhz": _as_int(row["clocks.mem"]),
                    "clock_memory_max_mhz": _as_int(row["clocks.max.mem"]),
                    "pcie_generation": _as_int(row["pcie.link.gen.current"]),
                    "pcie_width": _as_int(row["pcie.link.width.current"]),
                    "pcie_max_generation": _as_int(row["pcie.link.gen.max"]),
                    "pcie_max_width": _as_int(row["pcie.link.width.max"]),
                    "persistence_mode": (
                        True
                        if persistence == "enabled"
                        else False if persistence == "disabled" else None
                    ),
                    # nvidia-smi's CSV query cannot report throttle reasons.
                    "throttle_reasons": None,
                    "throttled": None,
                    "processes": by_uuid.get(uuid, []),
                }
            )

        return {
            "source": "nvidia-smi",
            "available": bool(gpus),
            "count": len(gpus),
            "driver_version": driver,
            "cuda_version": None,
            "gpus": gpus,
            "nvml_error": self._nvml_error,
        }

    def _smi_processes(self) -> dict[str, list[dict[str, Any]]]:
        """Group ``nvidia-smi`` compute apps by GPU UUID."""
        result = _try(
            lambda: subprocess.run(
                [
                    NVIDIA_SMI,
                    "--query-compute-apps=gpu_uuid,pid,used_memory",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=10,
                check=True,
            )
        )
        if result is None:
            return {}

        grouped: dict[str, list[dict[str, Any]]] = {}
        for line in result.stdout.splitlines():
            cells = [cell.strip() for cell in line.split(",")]
            if len(cells) < 3:
                continue
            uuid, raw_pid, raw_mem = cells[0], cells[1], cells[2]
            pid = _as_float(raw_pid)
            if pid is None:
                continue
            mib = _as_float(raw_mem)
            used = int(mib * 1024 * 1024) if mib is not None else None
            grouped.setdefault(uuid, []).append(
                self._describe_process(int(pid), used)
            )
        for procs in grouped.values():
            procs.sort(key=lambda p: (-(p.get("used_memory_bytes") or 0), p["pid"]))
        return grouped

    # ------------------------------------------------------------- collector API

    def _collect_blocking(self) -> dict[str, Any]:
        if self._init_nvml():
            try:
                data = self._collect_nvml()
                self._remember_static(data)
                return data
            except Exception as exc:
                # NVML went away mid-flight (driver reload, device fell off the
                # bus). Tear it down and schedule a retry so the next samples
                # can recover instead of being stuck on the fallback forever.
                self._shutdown_nvml()
                self._mark_nvml_failed(f"{type(exc).__name__}: {exc}")

        data = self._collect_smi()
        self._remember_static(data)
        return data

    def _remember_static(self, data: dict[str, Any]) -> None:
        self._static = {
            "source": data.get("source"),
            "driver_version": data.get("driver_version"),
            "cuda_version": data.get("cuda_version"),
            "count": data.get("count"),
            "gpus": [
                {
                    "index": gpu.get("index"),
                    "name": gpu.get("name"),
                    "uuid": gpu.get("uuid"),
                    "memory_total_bytes": gpu.get("memory_total_bytes"),
                    "power_limit_watts": gpu.get("power_limit_watts"),
                }
                for gpu in data.get("gpus", [])
            ],
        }

    async def collect(self) -> dict[str, Any]:
        return await self.run_to_thread(self._collect_blocking)

    def status_for(self, data: dict[str, Any]) -> Status:
        gpus = data.get("gpus") or []
        if not data.get("available") or not gpus:
            return Status.UNKNOWN

        mem_warn = self.config.threshold("gpu_memory_warn", 85.0)
        mem_critical = self.config.threshold("gpu_memory_critical", 95.0)
        temp_warn = self.config.threshold("gpu_temp_warn", 80.0)
        temp_critical = self.config.threshold("gpu_temp_critical", 88.0)

        statuses: list[Status] = []
        for gpu in gpus:
            statuses.append(
                threshold_status(gpu.get("memory_percent"), mem_warn, mem_critical)
            )
            statuses.append(
                threshold_status(gpu.get("temperature_c"), temp_warn, temp_critical)
            )
        return worst(statuses)

    def history_fields(self, data: dict[str, Any]) -> dict[str, float]:
        """Per-GPU series keyed by device index so each card keeps its own line.

        Averaging a 16 GB V100 with a 24 GB 3090 would produce a number that
        describes neither card, so the series are never merged.
        """
        fields: dict[str, float] = {}
        for gpu in data.get("gpus") or []:
            index = gpu.get("index")
            if index is None:
                continue
            prefix = f"gpu{index}"
            for suffix, key in (
                ("util", "utilization_percent"),
                ("mem_percent", "memory_percent"),
                ("temp", "temperature_c"),
            ):
                value = gpu.get(key)
                if isinstance(value, (int, float)):
                    fields[f"{prefix}_{suffix}"] = float(value)
        return fields

    def meta(self) -> dict[str, Any]:
        if not self._static:
            self._remember_static(self._collect_blocking())
        return self._static

    def _shutdown_nvml(self) -> None:
        pynvml, self._nvml = self._nvml, None
        self._handles = []
        if pynvml is not None:
            _try(lambda: pynvml.nvmlShutdown())

    async def aclose(self) -> None:
        if self._nvml is not None:
            await self.run_to_thread(self._shutdown_nvml)
        client, self._docker_client = self._docker_client, None
        if client is not None:
            # Dropping the reference would leave the requests.Session, its
            # urllib3 pool and the open unix socket to the garbage collector.
            await self.run_to_thread(client.close)

