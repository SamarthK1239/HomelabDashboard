"""In-memory state shared between the sampler and the API.

Holds the latest result per collector, a rolling history window for the scalar
series collectors choose to expose, and a bounded log of status transitions.
Nothing is persisted: restarting the service starts the history fresh, which is
the documented trade-off for having no database.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from typing import Any

from .collectors.base import CollectorResult, Status, worst

# How many status transitions to remember. Transitions are rare by nature -- a
# healthy box produces none for days -- so a few hundred covers a long incident
# without the log ever being a memory concern.
MAX_EVENTS = 250


class Store:
    def __init__(self, window_seconds: int = 3600) -> None:
        self.window_seconds = window_seconds
        self._lock = threading.Lock()
        self._latest: dict[str, CollectorResult] = {}
        self._history: dict[str, deque[tuple[float, float]]] = {}
        self._events: deque[dict[str, Any]] = deque(maxlen=MAX_EVENTS)
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
            previous = self._latest.get(result.name)
            self._latest[result.name] = result

            # A transition is logged only when the status actually changes.
            # The very first sample is not a transition -- there was no prior
            # state to leave -- so it is recorded silently; otherwise every
            # restart would manufacture nine "events" that nothing happened.
            if previous is not None and previous.status is not result.status:
                self._events.append(
                    {
                        "collector": result.name,
                        "from": previous.status.value,
                        "to": result.status.value,
                        "timestamp": result.updated_at,
                        "error": result.error,
                    }
                )

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

    def events(self, limit: int = 50) -> list[dict[str, Any]]:
        """Most recent status transitions, newest first."""
        with self._lock:
            recent = list(self._events)[-limit:]
        recent.reverse()
        return recent
