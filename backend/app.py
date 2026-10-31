"""FastAPI application.

Serves the JSON API backed by the sampler's in-memory store, plus the built
frontend as static files, so the deployed system is a single process on a
single port.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .collectors import build_collectors
from .config import REPO_ROOT, Config, load_config
from .sampler import Sampler
from .store import Store

log = logging.getLogger(__name__)

FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"

# Upper bound on `/api/history/batch`. Generous enough for every view the UI
# has (the widest is the detail sheet), small enough that a stray request
# cannot ask the store to serialise its entire key space in one go.
MAX_BATCH_METRICS = 24


def create_app(config: Config | None = None) -> FastAPI:
    config = config or load_config()
    store = Store(config.history_window)
    collectors = build_collectors(config)
    sampler = Sampler(collectors, store)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        log.info("starting sampler with collectors: %s", [c.name for c in collectors])
        await sampler.start()
        try:
            yield
        finally:
            await sampler.stop()

    app = FastAPI(
        title="Homelab Dashboard",
        description="Read-only monitoring for an AI/homelab server",
        version="0.1.0",
        lifespan=lifespan,
    )

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        """Liveness of the dashboard itself, distinct from the host's health."""
        return {"status": "ok", "collectors": [c.name for c in collectors]}

    @app.get("/api/snapshot")
    async def snapshot() -> dict[str, Any]:
        return store.snapshot()

    @app.get("/api/meta")
    async def meta() -> dict[str, Any]:
        data = store.meta()
        data["ui"] = {
            "default_refresh_seconds": config.get("ui", "default_refresh_seconds", 5),
            "history_window_seconds": config.history_window,
        }
        data["intervals"] = {c.name: c.interval for c in collectors}
        data["titles"] = {c.name: (c.title or c.name.title()) for c in collectors}
        return data

    @app.get("/api/history")
    async def history(
        metric: str = Query(..., description="Series key, e.g. cpu.usage"),
        window: int | None = Query(None, ge=1, description="Seconds of history"),
    ) -> dict[str, Any]:
        return store.history(metric, window)

    @app.get("/api/history/batch")
    async def history_batch(
        metrics: str = Query(
            ...,
            description="Comma-separated series keys, e.g. cpu.usage,memory.percent",
        ),
        window: int | None = Query(None, ge=1, description="Seconds of history"),
    ) -> dict[str, Any]:
        """Several series in one request.

        The summary strip and the detail sheet each want a handful of
        sparklines at once. Fetching them one at a time turned a single glance
        into six round trips on every poll -- noticeable on a phone over
        Tailscale, and pointless when the store can answer them together.

        Unknown keys come back as empty series rather than an error: history is
        in-memory and starts empty after a restart, so "no points yet" is the
        normal state for the first few seconds, not a client mistake.
        """
        requested = [m.strip() for m in metrics.split(",")]
        unique = list(dict.fromkeys(m for m in requested if m))
        if not unique:
            raise HTTPException(status_code=422, detail="metrics must not be empty")
        if len(unique) > MAX_BATCH_METRICS:
            raise HTTPException(
                status_code=422,
                detail=f"at most {MAX_BATCH_METRICS} metrics per request",
            )
        return {"series": [store.history(metric, window) for metric in unique]}

    @app.get("/api/history/keys")
    async def history_keys() -> dict[str, Any]:
        return {"keys": store.history_keys()}

    @app.get("/api/events")
    async def events(
        limit: int = Query(50, ge=1, le=500, description="Most recent N transitions"),
    ) -> dict[str, Any]:
        """Recent collector status transitions, newest first.

        The snapshot says what is wrong *now*; this says what changed and when.
        Without it a card that flapped critical for ninety seconds at 04:00 and
        recovered leaves no trace at all, which is exactly the event an
        operator most wants to know about.
        """
        return {"events": store.events(limit)}

    _mount_frontend(app)
    return app


def _mount_frontend(app: FastAPI) -> None:
    """Serve the built frontend, if it has been built.

    The dashboard stays useful as a pure JSON API when ``frontend/dist`` is
    absent, which is what happens during backend development.
    """
    if not FRONTEND_DIST.is_dir():
        @app.get("/")
        async def missing_frontend() -> JSONResponse:
            return JSONResponse(
                status_code=503,
                content={
                    "error": "frontend not built",
                    "hint": "run 'npm install && npm run build' in frontend/",
                },
            )
        return

    assets = FRONTEND_DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(FRONTEND_DIST / "index.html")

    @app.get("/{path:path}")
    async def spa_fallback(path: str) -> FileResponse:
        """Serve real files directly, falling back to index.html for SPA routes.

        Unknown ``/api`` paths deliberately 404 instead of returning HTML, so a
        typo in a fetch call fails loudly rather than parsing a page as JSON.
        """
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="unknown API endpoint")
        candidate = (FRONTEND_DIST / path).resolve()
        if candidate.is_file() and candidate.is_relative_to(FRONTEND_DIST.resolve()):
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")


app = create_app()
