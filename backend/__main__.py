"""Entry point: ``python -m backend``."""

from __future__ import annotations

import logging

import uvicorn

from .config import load_config


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # The llama collector polls four endpoints every few seconds, and httpx
    # logs every request at INFO. Left alone that is ~50k journal lines a day
    # saying "the thing that is working is still working", which buries the
    # warnings that actually matter.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    config = load_config()
    uvicorn.run(
        "backend.app:app",
        host=config.host,
        port=config.port,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
