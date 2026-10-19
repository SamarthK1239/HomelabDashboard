"""The sampling loop.

One asyncio task per collector, each on its own cadence. A collector that
raises, hangs, or returns nonsense degrades its own card and nothing else --
the loop logs the failure, records it as the card's error state, and carries on
at the normal interval.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .collectors.base import Collector, CollectorResult, Status
from .store import Store

log = logging.getLogger(__name__)

#: A collector that blocks for longer than this is abandoned for that round.
#: Without it, one wedged subsystem (a hung Docker socket, say) would silently
#: stop that card from ever updating again.
COLLECT_TIMEOUT = 30.0


class Sampler:
    def __init__(self, collectors: list[Collector], store: Store) -> None:
        self.collectors = collectors
        self.store = store
        self._tasks: list[asyncio.Task[None]] = []

    async def start(self) -> None:
        # meta() reaches out to NVML, the Docker socket and llama.cpp, so it is
        # blocking work. Running it inline here would stall the event loop
        # before uvicorn accepts its first connection.
        meta: dict[str, Any] = {"collectors": {}}
        for collector in self.collectors:
            try:
                meta["collectors"][collector.name] = await asyncio.wait_for(
                    asyncio.to_thread(collector.meta), timeout=COLLECT_TIMEOUT
                )
            except Exception as exc:  # noqa: BLE001 - metadata is best-effort
                log.warning("meta failed for %s: %s", collector.name, exc)
                meta["collectors"][collector.name] = {}
        self.store.set_meta(meta)

        for collector in self.collectors:
            self._tasks.append(asyncio.create_task(self._run(collector), name=f"sample:{collector.name}"))

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        for collector in self.collectors:
            try:
                await collector.aclose()
            except Exception as exc:  # noqa: BLE001 - shutdown is best-effort
                log.warning("close failed for %s: %s", collector.name, exc)

    async def sample_once(self, collector: Collector) -> CollectorResult:
        """Run a single collection, converting any failure into a result."""
        started = time.perf_counter()
        result = CollectorResult(name=collector.name, updated_at=time.time())
        series: dict[str, float] = {}
        try:
            data = await asyncio.wait_for(collector.collect(), timeout=COLLECT_TIMEOUT)
            result.data = data
            result.status = collector.status_for(data)
            series = collector.history_fields(data) or {}
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            result.status = Status.CRITICAL
            result.error = f"collection timed out after {COLLECT_TIMEOUT:.0f}s"
            log.warning("collector %s timed out", collector.name)
        except Exception as exc:  # noqa: BLE001 - isolation is the whole point
            result.status = Status.CRITICAL
            result.error = f"{type(exc).__name__}: {exc}"
            log.warning("collector %s failed: %s", collector.name, exc)

        result.duration_ms = (time.perf_counter() - started) * 1000

        # Recording is inside the isolation boundary too: a bad history value
        # raising here would kill the collector's task and freeze its card at a
        # stale value still labelled "ok" -- the worst failure mode for a
        # monitoring dashboard, because it looks healthy.
        try:
            self.store.record(result, series)
        except Exception as exc:  # noqa: BLE001 - never let recording kill the loop
            log.warning("recording %s failed: %s", collector.name, exc)
            result.status = Status.CRITICAL
            result.error = f"history recording failed: {type(exc).__name__}: {exc}"
            self.store.record(result, None)
        return result

    async def _run(self, collector: Collector) -> None:
        # Stagger startup so eight collectors do not all fire in the same tick.
        await asyncio.sleep(min(0.25 * self.collectors.index(collector), 2.0))
        while True:
            try:
                await self.sample_once(collector)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the loop must outlive any failure
                log.exception("sampler loop error for %s", collector.name)
            await asyncio.sleep(collector.interval)
