"""llama.cpp server collector.

Health here is two separate questions that can disagree, so both are answered
independently:

1. *Container layer* -- is the Docker container running, healthy, and not
   crash-looping? Answered through the Docker SDK.
2. *Application layer* -- is the HTTP server actually serving, what model is
   loaded, and is it generating right now? Answered through the server's own
   ``/health``, ``/props``, ``/v1/models``, ``/slots`` and ``/metrics``
   endpoints.

The interesting transitional state is "container up, HTTP down": a 27B model at
a 262144-token context takes minutes to load, during which the server is not
yet listening. That is normal startup, not an outage, so it degrades to WARN
rather than CRITICAL.

``/metrics`` is opt-in on llama.cpp (``--metrics``) and answers 501 when it was
not enabled. That is treated as a reportable capability gap with a stated fix,
never as an error -- and it is re-probed occasionally so that enabling the flag
starts producing throughput numbers with no code change.

Why ``/slots`` is not polled on a schedule
------------------------------------------

``/slots`` is not a passive read: on a server started with
``--sleep-idle-seconds`` it counts as activity. Polling it wakes a sleeping
model -- measured here, a single request pulled a 27B model back into VRAM
(363 MiB -> 15.8 GiB) and held it there -- so a dashboard refreshing every few
seconds would pin the weights in VRAM forever and silently defeat the server's
idle unloading. ``/health``, ``/props``, ``/v1/models`` and ``/metrics`` were
all measured as safe: the model stayed asleep across sustained polling of each.

So the slot counts come from the safe endpoints instead:
``llamacpp:requests_processing`` (``/metrics``) gives how many slots are busy
and ``total_slots`` (``/props``) gives how many exist. ``/slots`` is then
consulted only for its richer per-slot detail, and only while a request is
already in flight -- at which point the model is awake and working anyway, so
reading it costs nothing. See :meth:`LlamaCollector._slots_decision`.

Note that the cumulative counters (``tokens_predicted_total`` and friends) only
advance when a request *finishes*; they sit still for the whole of a long
generation. ``requests_processing`` is a gauge and moves the instant work
starts, which is why it, and not counter movement, is the activity signal.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import os
import time
from typing import Any

import httpx

from .base import Collector, Status, register

#: ``/metrics`` and ``/slots`` can be disabled at server start. Once a 501 is
#: seen, re-probing every sample is pure waste, so back off to this interval.
_DISABLED_ENDPOINT_RETRY_SECONDS = 300.0

#: Counters surfaced as history series when ``--metrics`` is enabled.
_METRIC_HISTORY_KEYS = (
    "llamacpp:prompt_tokens_total",
    "llamacpp:tokens_predicted_total",
    "llamacpp:n_decode_total",
    "llamacpp:kv_cache_usage_ratio",
    "llamacpp:requests_processing",
    "llamacpp:requests_deferred",
)

_METRICS_HINT = "restart the llama.cpp server with --metrics to enable this endpoint"

#: Gauge reporting how many requests are being processed right now. Unlike the
#: cumulative counters, which only move once a request completes, this moves as
#: soon as work starts -- so it is the signal for "is the server busy".
_BUSY_SLOTS_METRIC = "llamacpp:requests_processing"

#: How ``/slots`` may be polled. ``auto`` reads it only while a request is in
#: flight (see the module docstring); ``always`` restores unconditional polling
#: for servers that do not use ``--sleep-idle-seconds``; ``never`` disables it.
_SLOTS_POLICIES = ("auto", "always", "never")


def _parse_prometheus(text: str) -> dict[str, float]:
    """Parse the Prometheus text exposition format into ``name -> value``.

    Deliberately minimal (no client library dependency): comments are skipped,
    label sets are dropped, and repeated series for one metric name are summed,
    which is the right roll-up for llama.cpp's per-model counters.
    """
    values: dict[str, float] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        name, _, remainder = line.partition("{")
        if remainder:
            _, _, remainder = remainder.partition("}")
            sample = remainder
        else:
            name, _, sample = line.partition(" ")
        sample = sample.strip().split(" ")[0]
        name = name.strip()
        if not name or not sample:
            continue
        try:
            value = float(sample)
        except ValueError:
            continue
        values[name] = values.get(name, 0.0) + value
    return values


def _history_key(metric_name: str) -> str:
    """Flatten a metric name into a history-safe key.

    History is stored as ``<collector>.<field>``, so dots and slashes in field
    names would corrupt the key; colons are flattened too for consistency.
    """
    key = metric_name
    for char in (".", "/", ":", "-"):
        key = key.replace(char, "_")
    return key.strip("_")


def _parse_docker_time(value: Any) -> float | None:
    """Convert a Docker RFC3339 timestamp to a POSIX timestamp.

    Docker reports nanosecond precision, which :mod:`datetime` cannot parse, so
    the fractional part is truncated to microseconds.
    """
    if not isinstance(value, str) or not value or value.startswith("0001-01-01"):
        return None
    text = value.replace("Z", "+00:00")
    if "." in text:
        head, _, tail = text.partition(".")
        digits = ""
        while tail and tail[0].isdigit():
            digits += tail[0]
            tail = tail[1:]
        text = f"{head}.{digits[:6]}{tail}"
    try:
        return dt.datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


@register
class LlamaCollector(Collector):
    name = "llama"
    title = "llama.cpp"
    default_interval = 5.0

    def __init__(self, config: Any) -> None:
        super().__init__(config)
        section = config.section("llama")
        self.base_url = str(section.get("url") or "http://127.0.0.1:8090").rstrip("/")
        container = section.get("container", "llama-server")
        self.container_name = str(container).strip() if container else ""
        self.timeout = float(section.get("timeout", 3.0) or 3.0)
        policy = str(section.get("slots_policy", "auto") or "auto").strip().lower()
        self.slots_policy = policy if policy in _SLOTS_POLICIES else "auto"

        self._client: httpx.AsyncClient | None = None
        self._docker_client: Any = None
        #: Endpoint name -> earliest monotonic time at which to re-probe after
        #: the server reported it as disabled.
        self._retry_after: dict[str, float] = {}
        self._disabled_reason: dict[str, dict[str, Any]] = {}
        self._static: dict[str, Any] = {}

    # ------------------------------------------------------------------ http

    def _http(self) -> httpx.AsyncClient:
        """Return the shared client, recreating it only if it was closed.

        One client is reused across samples so connections are kept alive
        instead of being torn down every few seconds.
        """
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout)
        return self._client

    async def _get(self, path: str) -> tuple[int | None, Any, str | None]:
        """Fetch ``path``; return ``(status_code, parsed_body, error)``.

        Never raises: each endpoint must fail in isolation so that one slow or
        missing endpoint cannot blank out the others.
        """
        try:
            response = await self._http().get(path)
        except httpx.HTTPError as exc:
            return None, None, f"{type(exc).__name__}: {exc}"
        except Exception as exc:  # defensive: malformed URL, DNS, etc.
            return None, None, f"{type(exc).__name__}: {exc}"

        body: Any = None
        try:
            body = response.json()
        except ValueError:
            body = response.text
        return response.status_code, body, None

    @staticmethod
    def _error_message(body: Any, status_code: int | None) -> str:
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])
            if isinstance(error, str):
                return error
        if isinstance(body, str) and body.strip():
            return body.strip()[:200]
        return f"HTTP {status_code}"

    def _note_disabled(self, endpoint: str, message: str, status_code: int | None) -> dict[str, Any]:
        """Record a 501 (endpoint not enabled) and back off future probes."""
        record = {
            "available": False,
            "reason": message,
            "hint": _METRICS_HINT if endpoint == "metrics" else f"start the server with --{endpoint}",
            "status_code": status_code,
        }
        self._disabled_reason[endpoint] = record
        self._retry_after[endpoint] = time.monotonic() + _DISABLED_ENDPOINT_RETRY_SECONDS
        return dict(record)

    def _suppressed(self, endpoint: str) -> dict[str, Any] | None:
        """Return the cached "disabled" record while the back-off is active."""
        deadline = self._retry_after.get(endpoint)
        if deadline is not None and time.monotonic() < deadline:
            cached = dict(self._disabled_reason.get(endpoint, {}))
            cached.setdefault("available", False)
            cached["probed"] = False
            return cached
        return None

    # -------------------------------------------------------------- probes

    async def _probe_health(self) -> dict[str, Any]:
        started = time.perf_counter()
        status_code, body, error = await self._get("/health")
        latency_ms = round((time.perf_counter() - started) * 1000, 2)

        if error is not None:
            return {"reachable": False, "ok": False, "error": error, "latency_ms": None}

        status = body.get("status") if isinstance(body, dict) else None
        result: dict[str, Any] = {
            "reachable": True,
            "ok": status_code == 200 and status == "ok",
            "status": status,
            "status_code": status_code,
            "latency_ms": latency_ms,
        }
        if not result["ok"]:
            result["error"] = self._error_message(body, status_code)
        return result

    async def _probe_props(self) -> dict[str, Any]:
        status_code, body, error = await self._get("/props")
        if error is not None:
            return {"available": False, "error": error}
        if status_code == 501:
            return self._note_disabled("props", self._error_message(body, status_code), status_code)
        if status_code != 200 or not isinstance(body, dict):
            return {"available": False, "error": self._error_message(body, status_code)}

        defaults = body.get("default_generation_settings")
        defaults = defaults if isinstance(defaults, dict) else {}
        params = defaults.get("params")
        params = params if isinstance(params, dict) else {}
        model_path = body.get("model_path")

        # The full /props blob embeds the Jinja chat template (tens of KB), so
        # only the useful scalars are copied out.
        return {
            "available": True,
            "model_path": model_path,
            "model_file": os.path.basename(model_path) if isinstance(model_path, str) else None,
            "model_alias": body.get("model_alias"),
            "model_ftype": body.get("model_ftype"),
            "context_size": defaults.get("n_ctx"),
            "total_slots": body.get("total_slots"),
            "build_info": body.get("build_info"),
            "modalities": body.get("modalities") if isinstance(body.get("modalities"), dict) else None,
            "is_sleeping": body.get("is_sleeping"),
            "sampling": {
                "temperature": params.get("temperature"),
                "top_k": params.get("top_k"),
                "top_p": params.get("top_p"),
                "min_p": params.get("min_p"),
                "samplers": params.get("samplers") if isinstance(params.get("samplers"), list) else None,
            },
        }

    async def _probe_models(self) -> dict[str, Any]:
        status_code, body, error = await self._get("/v1/models")
        if error is not None:
            return {"available": False, "error": error}
        if status_code != 200 or not isinstance(body, dict):
            return {"available": False, "error": self._error_message(body, status_code)}

        entries: list[dict[str, Any]] = []
        for raw in body.get("models", []) or []:
            if not isinstance(raw, dict):
                continue
            details = raw.get("details") if isinstance(raw.get("details"), dict) else {}
            entries.append(
                {
                    "name": raw.get("name") or raw.get("model"),
                    "capabilities": raw.get("capabilities") or [],
                    "format": details.get("format"),
                }
            )
        # The OpenAI-shaped "data" list carries the real model geometry.
        for raw in body.get("data", []) or []:
            if not isinstance(raw, dict):
                continue
            meta = raw.get("meta") if isinstance(raw.get("meta"), dict) else {}
            match = next((e for e in entries if e["name"] == raw.get("id")), None)
            if match is None:
                match = {"name": raw.get("id"), "capabilities": [], "format": None}
                entries.append(match)
            match["n_ctx"] = meta.get("n_ctx")
            match["n_ctx_train"] = meta.get("n_ctx_train")
            match["n_params"] = meta.get("n_params")
            match["size_bytes"] = meta.get("size")
            match["ftype"] = meta.get("ftype")

        return {"available": True, "count": len(entries), "models": entries}

    async def _probe_slots(self) -> dict[str, Any]:
        cached = self._suppressed("slots")
        if cached is not None:
            return cached

        status_code, body, error = await self._get("/slots")
        if error is not None:
            return {"available": False, "error": error}
        if status_code == 501:
            return self._note_disabled("slots", self._error_message(body, status_code), status_code)
        if status_code != 200 or not isinstance(body, list):
            return {"available": False, "error": self._error_message(body, status_code)}

        slots: list[dict[str, Any]] = []
        busy = 0
        for raw in body:
            if not isinstance(raw, dict):
                continue
            processing = bool(raw.get("is_processing"))
            busy += 1 if processing else 0
            n_ctx = raw.get("n_ctx")
            n_past = raw.get("n_past")
            entry: dict[str, Any] = {
                "id": raw.get("id"),
                "processing": processing,
                "state": "busy" if processing else "idle",
                "n_ctx": n_ctx,
                "speculative": raw.get("speculative"),
            }
            # Context occupancy fields are build-dependent; include only what
            # this server actually exposes.
            if n_past is not None:
                entry["n_past"] = n_past
                if isinstance(n_ctx, (int, float)) and n_ctx:
                    entry["context_used_percent"] = round(100.0 * float(n_past) / float(n_ctx), 2)
            for key in ("prompt_n", "n_prompt_tokens", "next_token", "task_id"):
                if raw.get(key) is not None:
                    entry[key] = raw[key]
            slots.append(entry)

        return {
            "available": True,
            "total": len(slots),
            "busy": busy,
            "idle": len(slots) - busy,
            "slots": slots,
        }

    async def _probe_metrics(self) -> dict[str, Any]:
        cached = self._suppressed("metrics")
        if cached is not None:
            return cached

        status_code, body, error = await self._get("/metrics")
        if error is not None:
            return {"available": False, "error": error}
        if status_code == 501:
            return self._note_disabled("metrics", self._error_message(body, status_code), status_code)
        if status_code != 200 or not isinstance(body, str):
            return {"available": False, "error": self._error_message(body, status_code)}

        values = _parse_prometheus(body)
        self._retry_after.pop("metrics", None)
        self._disabled_reason.pop("metrics", None)
        return {"available": True, "count": len(values), "values": values}

    # ------------------------------------------------------------- docker

    def _container_snapshot(self) -> dict[str, Any]:
        """Blocking Docker lookup; always run through :meth:`run_to_thread`."""
        import docker  # imported lazily so a missing SDK degrades this layer only
        from docker.errors import NotFound

        try:
            if self._docker_client is None:
                self._docker_client = docker.from_env()
            container = self._docker_client.containers.get(self.container_name)
        except NotFound:
            return {
                "available": False,
                "name": self.container_name,
                "exists": False,
                "error": f"container {self.container_name!r} not found",
            }
        except Exception as exc:
            # A broken daemon connection must not poison later samples.
            self._docker_client = None
            return {
                "available": False,
                "name": self.container_name,
                "error": f"{type(exc).__name__}: {exc}",
            }

        attrs = container.attrs if isinstance(container.attrs, dict) else {}
        state = attrs.get("State", {}) if isinstance(attrs.get("State"), dict) else {}
        health = state.get("Health", {}) if isinstance(state.get("Health"), dict) else {}
        started_at = _parse_docker_time(state.get("StartedAt"))
        config_section = attrs.get("Config", {}) if isinstance(attrs.get("Config"), dict) else {}

        return {
            "available": True,
            "exists": True,
            "name": container.name,
            "state": state.get("Status") or container.status,
            "running": bool(state.get("Running")),
            "health": health.get("Status"),
            "uptime_seconds": round(time.time() - started_at, 1) if started_at else None,
            "started_at": state.get("StartedAt"),
            "restart_count": attrs.get("RestartCount"),
            "image": config_section.get("Image") or (container.image.tags or [None])[0],
            "exit_code": state.get("ExitCode") if not state.get("Running") else None,
        }

    async def _probe_container(self) -> dict[str, Any]:
        if not self.container_name:
            return {"available": False, "configured": False, "reason": "no container configured"}
        snapshot = await self.run_to_thread(self._container_snapshot)
        snapshot["configured"] = True
        return snapshot

    # ------------------------------------------------------------- collect

    def _slots_decision(
        self, props: dict[str, Any], metrics: dict[str, Any]
    ) -> tuple[bool, str]:
        """Decide whether ``/slots`` may be read this round, and say why.

        Reading ``/slots`` wakes a sleeping model, so the default policy only
        allows it when the server is demonstrably already busy. The reason is
        returned alongside the verdict and surfaced in the payload, so the card
        can explain why per-slot detail is absent rather than looking broken.
        """
        if self.slots_policy == "never":
            return False, "per-slot detail is disabled (slots_policy = never)"
        if self.slots_policy == "always":
            return True, "slots_policy = always"

        if props.get("is_sleeping") is True:
            return False, "model is sleeping; reading /slots would reload it into VRAM"
        if not metrics.get("available"):
            return False, (
                "cannot tell whether the server is busy without /metrics, so /slots is "
                "left alone to avoid pinning the model in VRAM — start the server with "
                "--metrics, or set slots_policy = \"always\" if it does not use "
                "--sleep-idle-seconds"
            )

        busy = _as_float((metrics.get("values") or {}).get(_BUSY_SLOTS_METRIC))
        if busy is None:
            return False, "/metrics did not report requests_processing"
        if busy > 0:
            return True, "a request is in flight, so the model is already awake"
        return False, "server is idle; leaving its sleep timer alone"

    async def collect(self) -> dict[str, Any]:
        # Only the endpoints that are safe to poll on a timer. /slots is
        # deliberately excluded here and decided on afterwards.
        results = await asyncio.gather(
            self._probe_health(),
            self._probe_props(),
            self._probe_models(),
            self._probe_metrics(),
            self._probe_container(),
            return_exceptions=True,
        )
        health, props, models, metrics, container = (
            r if isinstance(r, dict) else {"available": False, "error": f"{type(r).__name__}: {r}"}
            for r in results
        )

        may_poll, slots_reason = self._slots_decision(props, metrics)
        if may_poll:
            try:
                slots = await self._probe_slots()
            except Exception as exc:  # isolation: /slots must not fail the sample
                slots = {"available": False, "error": f"{type(exc).__name__}: {exc}"}
            slots["polled"] = True
        else:
            slots = {"available": False, "polled": False, "reason": slots_reason}
        slots["policy"] = self.slots_policy

        metric_values = (metrics.get("values") or {}) if metrics.get("available") else {}
        total_slots = slots.get("total") if slots.get("available") else props.get("total_slots")

        # Prefer /slots when it was read, since it counts slots directly;
        # otherwise derive the same numbers from the endpoints that are safe to
        # poll, so the headline "n busy / m" survives without waking anything.
        if slots.get("available"):
            busy = slots.get("busy")
            idle = slots.get("idle")
            slot_source = "slots"
        else:
            metric_busy = _as_float(metric_values.get(_BUSY_SLOTS_METRIC))
            if metric_busy is None:
                busy = idle = None
                slot_source = None
            else:
                busy = int(metric_busy)
                idle = (
                    max(0, int(total_slots) - busy)
                    if isinstance(total_slots, (int, float))
                    else None
                )
                slot_source = "metrics"

        model_name = props.get("model_alias")
        if not model_name:
            listed = models.get("models") or []
            model_name = listed[0].get("name") if listed else None

        data: dict[str, Any] = {
            "url": self.base_url,
            "reachable": bool(health.get("reachable")),
            "healthy": bool(health.get("ok")),
            "health": health,
            "generating": bool(busy) if busy is not None else None,
            "busy_slots": busy,
            "idle_slots": idle,
            "total_slots": total_slots,
            "slot_source": slot_source,
            "model": {
                "name": model_name,
                "path": props.get("model_path"),
                "file": props.get("model_file"),
                "ftype": props.get("model_ftype"),
                "context_size": props.get("context_size"),
                "modalities": props.get("modalities"),
            },
            "build_info": props.get("build_info"),
            "sampling": props.get("sampling"),
            "is_sleeping": props.get("is_sleeping"),
            "props": {
                "available": bool(props.get("available")),
                "error": props.get("error"),
                "reason": props.get("reason"),
            },
            "models": models,
            "slots": slots,
            "metrics": metrics,
            "container": container,
        }
        self._remember_static(data)
        return data

    def _remember_static(self, data: dict[str, Any]) -> None:
        """Cache the facts :meth:`meta` reports, so it works even once the
        server has gone away."""
        model = data.get("model", {})
        if model.get("name") or model.get("path"):
            self._static = {
                "model": model.get("name"),
                "model_path": model.get("path"),
                "model_file": model.get("file"),
                "context_size": model.get("context_size"),
                "total_slots": data.get("total_slots"),
                "build_info": data.get("build_info"),
            }

    # -------------------------------------------------------------- status

    def status_for(self, data: dict[str, Any]) -> Status:
        health = data.get("health", {}) if isinstance(data.get("health"), dict) else {}
        container = data.get("container", {}) if isinstance(data.get("container"), dict) else {}
        reachable = bool(health.get("reachable"))
        container_known = bool(container.get("exists"))
        container_running = bool(container.get("running"))

        if reachable:
            if not health.get("ok"):
                return Status.CRITICAL
            if container_known and not container_running:
                return Status.CRITICAL
            if container.get("health") == "unhealthy":
                return Status.WARN
            return Status.OK

        if container_known and not container_running:
            return Status.CRITICAL
        if container_running:
            # Container is up but not yet serving: a large model at a long
            # context takes minutes to load, so this is startup, not failure.
            return Status.WARN
        if health.get("error"):
            return Status.CRITICAL
        return Status.UNKNOWN

    def history_fields(self, data: dict[str, Any]) -> dict[str, float]:
        health = data.get("health", {}) if isinstance(data.get("health"), dict) else {}
        fields: dict[str, float | None] = {
            "health_latency_ms": _as_float(health.get("latency_ms")),
            "busy_slots": _as_float(data.get("busy_slots")),
            "generating": None if data.get("generating") is None else float(bool(data["generating"])),
        }

        metrics = data.get("metrics", {}) if isinstance(data.get("metrics"), dict) else {}
        if metrics.get("available"):
            values = metrics.get("values", {}) or {}
            for key in _METRIC_HISTORY_KEYS:
                fields[_history_key(key)] = _as_float(values.get(key))

        return {key: value for key, value in fields.items() if value is not None}

    def meta(self) -> dict[str, Any]:
        """Static facts. Non-fatal if the server is down: whatever is known
        (at minimum the configured URL and container) is returned."""
        info: dict[str, Any] = {
            "url": self.base_url,
            "container": self.container_name or None,
        }
        if not self._static:
            self._static = self._probe_static_sync()
        info.update({k: v for k, v in self._static.items() if v is not None})
        return info

    def _probe_static_sync(self) -> dict[str, Any]:
        """One blocking /props read for startup metadata, before any sample."""
        try:
            with httpx.Client(base_url=self.base_url, timeout=self.timeout) as client:
                response = client.get("/props")
                if response.status_code != 200:
                    return {}
                body = response.json()
        except Exception:
            return {}
        if not isinstance(body, dict):
            return {}

        defaults = body.get("default_generation_settings")
        defaults = defaults if isinstance(defaults, dict) else {}
        model_path = body.get("model_path")
        return {
            "model": body.get("model_alias"),
            "model_path": model_path,
            "model_file": os.path.basename(model_path) if isinstance(model_path, str) else None,
            "context_size": defaults.get("n_ctx"),
            "total_slots": body.get("total_slots"),
            "build_info": body.get("build_info"),
        }

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None
        if self._docker_client is not None:
            client, self._docker_client = self._docker_client, None
            try:
                await self.run_to_thread(client.close)
            except Exception:
                pass
