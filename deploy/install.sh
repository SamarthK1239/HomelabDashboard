#!/usr/bin/env bash
# Install the Homelab Dashboard as a systemd service.
#
# Builds the frontend, syncs the Python environment, renders the unit file for
# this machine, and enables the service. Safe to re-run: it is the upgrade path
# as well as the install path.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="homelab-dashboard"
UNIT_SRC="$REPO_DIR/deploy/$SERVICE_NAME.service"
UNIT_DST="/etc/systemd/system/$SERVICE_NAME.service"
RUN_USER="${SUDO_USER:-$USER}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v uv >/dev/null 2>&1 || die "uv not found. Install it: https://docs.astral.sh/uv/"
command -v npm >/dev/null 2>&1 || die "npm not found. Install Node 20+ (see README)."

log "Syncing Python environment"
cd "$REPO_DIR"
uv sync --frozen 2>/dev/null || uv sync

log "Building frontend"
cd "$REPO_DIR/frontend"
npm ci 2>/dev/null || npm install
npm run build
[ -f "$REPO_DIR/frontend/dist/index.html" ] || die "frontend build produced no dist/index.html"

cd "$REPO_DIR"
if [ ! -f config.toml ]; then
    log "Creating config.toml from the example"
    cp config.example.toml config.toml
    # Default the bind address to this machine's Tailscale IP when we can find
    # it, so a fresh install is tailnet-only without manual editing.
    if command -v tailscale >/dev/null 2>&1; then
        TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
        if [ -n "${TS_IP:-}" ]; then
            sed -i "s|^host = .*|host = \"$TS_IP\"|" config.toml
            log "Bound to Tailscale IP $TS_IP"
        else
            log "Could not determine Tailscale IP; edit config.toml before starting"
        fi
    fi
fi

log "Installing systemd unit (requires sudo)"
sed -e "s|__INSTALL_DIR__|$REPO_DIR|g" -e "s|__USER__|$RUN_USER|g" "$UNIT_SRC" \
    | sudo tee "$UNIT_DST" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

sleep 3
if systemctl is-active --quiet "$SERVICE_NAME"; then
    PORT="$(grep -E '^port' "$REPO_DIR/config.toml" | head -1 | tr -dc '0-9')"
    HOST="$(grep -E '^host' "$REPO_DIR/config.toml" | head -1 | cut -d'"' -f2)"
    log "Running at http://${HOST:-127.0.0.1}:${PORT:-8800}"
else
    die "service failed to start. Check: journalctl -u $SERVICE_NAME -n 50"
fi
