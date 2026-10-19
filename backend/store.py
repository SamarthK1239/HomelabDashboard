"""In-memory state shared between the sampler and the API.

Holds the latest result per collector plus a rolling history window for the
scalar series collectors choose to expose. Nothing is persisted: restarting the
service starts the history fresh, which is the documented trade-off for having
no database.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from typing import Any

from .collectors.base import CollectorResult, Status, worst


class Store:
    def __init__(self, window_seconds: int = 3600) -> None:
        self.window_seconds = window_seconds
        self._lock = threading.Lock()
        self._latest: dict[str, CollectorResult] = {}
        self._history: dict[str, deque[tuple[float, float]]] = {}
        self._meta: dict[str, Any] = {}
        self.started_at = time.time()

    def set_meta(self, meta: dict[str, Any]) -> None:
        with self._lock:
            self._meta = meta

    def meta(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._meta)

    def record(self, result: CollectorResult, series: dict[str, float] | None = None) -> None:
        """Store a collector result and append any scalar series it produced."""
        with self._lock:
            self._latest[result.name] = result
            if not series:
                return
            cutoff = result.updated_at - self.window_seconds
            for field, value in series.items():
                if value is None:
                    continue
                # NaN and +/-Inf are valid floats but illegal JSON, and
                # Starlette serialises with allow_nan=False. One of them
                # reaching a deque would 500 /api/snapshot for every card, not
                # just this one, so they are dropped at the chokepoint.
                numeric = float(value)
                if not math.isfinite(numeric):
                    continue
                key = f"{result.name}.{field}"
                points = self._history.setdefault(key, deque())
                points.append((result.updated_at, numeric))
                while points and points[0][0] < cutoff:
                    points.popleft()

    def snapshot(self) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            cards = {name: result.to_dict(now) for name, result in self._latest.items()}
            statuses = [result.status for result in self._latest.values()]
        return {
            "timestamp": now,
            "overall_status": worst(statuses).value if statuses else Status.UNKNOWN.value,
            "collectors": cards,
        }

    def history(self, metric: str, window: int | None = None) -> dict[str, Any]:
        now = time.time()
        cutoff = now - (window or self.window_seconds)
        with self._lock:
            points = list(self._history.get(metric, ()))
        points = [(ts, value) for ts, value in points if ts >= cutoff]
        return {
            "metric": metric,
            "timestamps": [ts for ts, _ in points],
            "values": [value for _, value in points],
        }

    def history_keys(self) -> list[str]:
        with self._lock:
            return sorted(self._history)
