"""Collector package.

Importing this package registers every built-in collector. To add one, drop a
module beside these and import it below -- the registry does the rest.
"""

from . import cpu, disk, docker_containers, gpu, llama, memory, updates, uptime  # noqa: F401
from .base import Collector, CollectorResult, Status, build_collectors, register, registered

__all__ = [
    "Collector",
    "CollectorResult",
    "Status",
    "build_collectors",
    "register",
    "registered",
]
