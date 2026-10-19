"""Configuration loading.

Values come from ``config.toml`` next to the repository root, falling back to
the defaults baked in here. A handful of settings can also be overridden with
environment variables so the systemd unit can tweak them without editing files.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent

DEFAULTS: dict[str, Any] = {
    "server": {"host": "127.0.0.1", "port": 8800},
    "history": {"window_seconds": 3600},
    "ui": {"default_refresh_seconds": 5},
    "intervals": {
        "cpu": 2.0,
        "memory": 2.0,
        "gpu": 2.0,
        "uptime": 2.0,
        "llama": 5.0,
        "docker": 10.0,
        "disk": 15.0,
        "updates": 3600.0,
    },
    "collectors": {"disabled": []},
    "llama": {
        "url": "http://127.0.0.1:8090",
        "container": "llama-server",
        "timeout": 3.0,
    },
    "docker": {"include_stats": True},
    "disk": {"mounts": []},
    "updates": {"stale_after_hours": 24},
    "thresholds": {
        "cpu_warn": 80.0,
        "cpu_critical": 95.0,
        "memory_warn": 80.0,
        "memory_critical": 92.0,
        "swap_warn": 25.0,
        "swap_critical": 50.0,
        "disk_warn": 80.0,
        "disk_critical": 90.0,
        "gpu_memory_warn": 99.0,
        "gpu_memory_critical": 99.8,
        "gpu_temp_warn": 80.0,
        "gpu_temp_critical": 88.0,
        "cpu_temp_warn": 80.0,
        "cpu_temp_critical": 90.0,
        "updates_warn": 20,
        "updates_critical": 50,
        "security_updates_critical": 1,
    },
}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


@dataclass(frozen=True)
class Config:
    data: dict[str, Any] = field(default_factory=dict)

    def section(self, name: str) -> dict[str, Any]:
        value = self.data.get(name, {})
        return value if isinstance(value, dict) else {}

    def get(self, section: str, key: str, default: Any = None) -> Any:
        return self.section(section).get(key, default)

    @property
    def host(self) -> str:
        return str(self.get("server", "host", "127.0.0.1"))

    @property
    def port(self) -> int:
        return int(self.get("server", "port", 8800))

    @property
    def history_window(self) -> int:
        return int(self.get("history", "window_seconds", 3600))

    @property
    def disabled_collectors(self) -> set[str]:
        raw = self.get("collectors", "disabled", []) or []
        return {str(name) for name in raw}

    def interval(self, collector: str, default: float) -> float:
        return float(self.get("intervals", collector, default))

    def threshold(self, key: str, default: float = 0.0) -> float:
        return float(self.get("thresholds", key, default))


def config_path() -> Path:
    override = os.environ.get("HOMELAB_DASHBOARD_CONFIG")
    if override:
        return Path(override)
    return REPO_ROOT / "config.toml"


def load_config(path: Path | None = None) -> Config:
    """Load configuration, merging ``config.toml`` over the built-in defaults.

    A missing config file is not an error: the defaults are a working
    configuration on their own.
    """
    target = path or config_path()
    data = dict(DEFAULTS)

    if target.is_file():
        with target.open("rb") as handle:
            data = _deep_merge(data, tomllib.load(handle))

    if host := os.environ.get("HOMELAB_DASHBOARD_HOST"):
        data = _deep_merge(data, {"server": {"host": host}})
    if port := os.environ.get("HOMELAB_DASHBOARD_PORT"):
        data = _deep_merge(data, {"server": {"port": int(port)}})

    return Config(data)
