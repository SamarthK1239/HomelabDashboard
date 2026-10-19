# Homelab Dashboard

A read-only monitoring dashboard for an AI/homelab server. It runs on the machine
it watches and is reached over Tailscale.

Monitors llama.cpp, Docker, NVIDIA GPUs, both CPU sockets, memory, disks, uptime,
and pending system updates — and is built so adding a ninth panel means adding one
file.

## What it shows

| Card | Covers |
|---|---|
| **llama.cpp** | Container state *and* HTTP health, loaded model, context size, inference slots busy vs idle, health latency |
| **GPUs** | Per device: utilization, VRAM, temperature, power vs limit, clocks, throttle reasons, and which container owns each compute process |
| **CPU** | Per-socket utilization, frequency and package temperature for both Xeons, an 88-core heatmap, and load normalized per core |
| **Memory** | Used/available/cached, swap, and a per-NUMA-node breakdown |
| **Disks** | Usage and inodes per mount, plus per-disk read/write throughput |
| **Docker** | Every container's state, health, uptime, restart count, CPU and memory |
| **Uptime** | Boot time, uptime, load averages, reboot-required flag |
| **Updates** | Pending and security counts, per-package detail, and the age of the apt cache |

## Design notes

A few behaviors are deliberate and worth knowing about, because they are the
difference between a dashboard you can trust and one that quietly lies.

**Stale data is shown as stale.** If the backend stops responding, the page keeps
displaying the last known values but explicitly marks itself disconnected. A
monitoring page showing frozen numbers as though they were live is worse than one
that admits it has lost contact.

**The apt cache age is reported alongside the update counts.** Refreshing the apt
cache needs root, which this unprivileged read-only service never does, so its
counts come from whatever Ubuntu's `apt-daily` timer last fetched. A stale cache
forces the card to at least WARN no matter how few updates are pending — otherwise
"0 updates available" from a two-week-old cache would read as reassuring when it
is meaningless.

**First samples report "—", not zero.** CPU percentages and disk throughput are
deltas between two samples, so they do not exist until the second one. The
backend returns `null` and the UI renders a dash rather than inventing a `0.0`
that looks like real idle.

**GPU memory thresholds are tuned for an inference box.** llama.cpp preallocates
its KV cache, so this server sits at ~98% VRAM whenever the model is loaded. The
conventional 85/95 ceilings would pin the card to CRITICAL permanently and train
you to ignore it, so the defaults only fire on genuine exhaustion. Temperature and
throttling carry the real signal.

**One slow collector cannot stall the others.** Each runs on its own cadence with
its own timeout, and a collector that raises degrades its own card while every
other card keeps updating.

## Requirements

- Linux with systemd (developed against Ubuntu 24.04)
- Python 3.12+ and [uv](https://docs.astral.sh/uv/)
- Node 20+ (only to build the frontend)
- Optional: NVIDIA driver for the GPU card, Docker for the container cards

## Install

```bash
git clone https://github.com/SamarthK1239/HomelabDashboard
cd HomelabDashboard
./deploy/install.sh
```

The installer syncs the Python environment, builds the frontend, writes a
`config.toml` pre-pointed at this machine's Tailscale IP, and installs and starts
the systemd unit. Re-running it is also the upgrade path.

Then browse to `http://<tailscale-ip>:8800`.

### Manual run

```bash
uv sync
cd frontend && npm install && npm run build && cd ..
uv run python -m backend
```

### Service management

```bash
systemctl status homelab-dashboard
journalctl -u homelab-dashboard -f
sudo systemctl restart homelab-dashboard
```

## Configuration

Copy `config.example.toml` to `config.toml` and edit; every key is optional and
falls back to a working default. `config.toml` is gitignored, so local settings
stay local.

Highlights:

```toml
[server]
host = "100.123.241.114"   # Tailscale IP: tailnet-only, nothing on LAN/WAN
port = 8800

[intervals]                 # per-collector sampling cadence, seconds
cpu = 2.0
docker = 10.0
updates = 3600.0

[collectors]
disabled = ["updates"]      # turn any collector off without touching code

[thresholds]
cpu_warn = 80.0
disk_critical = 90.0
```

`HOMELAB_DASHBOARD_CONFIG`, `HOMELAB_DASHBOARD_HOST`, and `HOMELAB_DASHBOARD_PORT`
override the file if set.

### Enabling llama.cpp throughput metrics

llama.cpp only serves `/metrics` when started with `--metrics`. Without it that
endpoint returns 501, and the dashboard reports token-throughput as unavailable
with the reason — it does not treat it as a failure. Add `--metrics` to the
container's arguments and the extra series appear on their own, no code or config
change needed.

### Why per-slot detail comes and goes

If you run llama-server with `--sleep-idle-seconds`, it offloads the model from
VRAM after an idle period. Reading `/slots` defeats that: measured on this
server, a single poll against a sleeping model took VRAM from 363 MiB to
15.8 GiB — it does not merely reset the idle timer, it reloads the weights.
Polling it on a timer therefore pins the model in VRAM permanently.

So the collector only reads `/slots` when the server is *already* awake and
working. It decides from two endpoints that are safe to poll (both verified not
to wake a sleeping model): `/props`, which reports `is_sleeping`, and the
`llamacpp:requests_processing` gauge from `/metrics`.

The gauge matters specifically. llama.cpp's `*_total` metrics are cumulative
counters that only advance when a request *finishes*, so they sit at zero
throughout a long generation — gating on "did the counters change" would go
blind during exactly the work you want to watch. The gauge moves the moment a
request is accepted.

Busy/idle counts keep rendering either way, derived from `/metrics` plus the
`total_slots` in `/props`; only the per-slot pips go quiet, and the card says
why. Tune with:

```toml
[llama]
slots_policy = "auto"   # read /slots only while a request is in flight
# slots_policy = "always"  # poll unconditionally — fine if you don't use --sleep-idle-seconds
# slots_policy = "never"   # never read /slots
```

Use `"always"` only if your server has no idle-sleep configured; there is
nothing to protect in that case and you get per-slot detail at all times.

## API

The backend is usable on its own if you want to script against it.

| Endpoint | Returns |
|---|---|
| `GET /api/snapshot` | Every collector's latest reading, status, and age |
| `GET /api/history?metric=cpu.usage&window=3600` | A rolling series for sparklines |
| `GET /api/history/keys` | Every available series key |
| `GET /api/meta` | Static facts: CPU model, GPU names, total RAM, intervals |
| `GET /api/health` | The dashboard's own liveness |

History lives in memory only, in a rolling window (default one hour). Restarting
the service clears it — the documented trade-off for having no database.

## Adding a collector

The registry is the whole extension story. To add a panel:

**1. Write `backend/collectors/fans.py`:**

```python
from __future__ import annotations

from typing import Any

from .base import Collector, Status, register


@register
class FanCollector(Collector):
    name = "fans"              # API key and card id
    title = "Chassis Fans"
    default_interval = 10.0

    async def collect(self) -> dict[str, Any]:
        return {"rpm": read_fan_rpm()}

    def status_for(self, data: dict[str, Any]) -> Status:
        return Status.CRITICAL if data["rpm"] == 0 else Status.OK

    def history_fields(self, data: dict[str, Any]) -> dict[str, float]:
        return {"rpm": data["rpm"]}          # becomes series "fans.rpm"
```

**2. Import it in `backend/collectors/__init__.py`.**

That is enough. The sampler picks it up, `/api/snapshot` carries it, history is
retained, and the frontend renders it automatically with the generic key/value
card. Add `[intervals] fans = 10.0` to `config.toml` to retune its cadence, or
`[collectors] disabled = ["fans"]` to switch it off.

**3. Optional — give it a bespoke card.** Write a component in
`frontend/src/components/cards/` and register it in
`frontend/src/components/cards/registry.ts`. That file is the only place a card
mapping needs to change.

Notes for collector authors:

- `collect()` may raise freely; the sampler converts failures into a degraded card.
- Wrap blocking calls in `await self.run_to_thread(...)` so they do not stall the loop.
- Return only JSON-serializable values.
- Return `None` for a value you cannot measure yet; never substitute a plausible zero.
- `history_fields` keys must not contain `.` or `/` — series are keyed `<collector>.<field>`.

## Security

The dashboard is read-only: no endpoint changes host state, and no collector
shells out through `shell=True` or interpolates input into a command.

Access control is Tailscale. Binding to the tailnet IP means the dashboard is not
reachable from the LAN or the internet, and there is no login screen to manage.

**The Docker socket is root-equivalent.** Any process that can reach
`/var/run/docker.sock` can start a privileged container and take over the host.
This service only ever issues read calls, but the capability is present, so the
systemd unit drops all capabilities and applies `NoNewPrivileges`,
`ProtectSystem=strict`, `ProtectHome=read-only`, and a syscall filter to bound
what a compromise of the web process could reach. If you want to tighten this
further, putting a GET-only proxy in front of the Docker socket is the natural
next step; it is not built in because it adds a moving part.

## Layout

```
backend/
  app.py            FastAPI routes + static serving
  config.py         TOML config and defaults
  sampler.py        async loop, per-collector cadence, error isolation
  store.py          latest snapshot + rolling history
  collectors/
    base.py         Collector protocol, Status, registry
    cpu.py memory.py disk.py uptime.py
    gpu.py docker_containers.py llama.py updates.py
frontend/           Vite + React + TypeScript
deploy/             systemd unit + installer
```
