#!/usr/bin/env bash
# Install the Rocket.Chat <-> managed Hermes bridge as a systemd service on the
# box that runs the hermes-* containers (the fleet box). Run with sudo.
#
# Config comes from /etc/hermes/rc-bridge.env (created below if absent).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FLEET_DIR="${MANAGED_HERMES_DIR:-$(cd "$HERE/.." && pwd)}"

install -d -m 0755 /opt/hermes-rc-bridge
install -m 0644 "$HERE/bridge.mjs" /opt/hermes-rc-bridge/bridge.mjs

install -d -m 0700 /etc/hermes
if [ ! -f /etc/hermes/rc-bridge.env ]; then
  cat > /etc/hermes/rc-bridge.env <<ENV
# Rocket.Chat base URL the bridge posts replies to (public URL or LAN IP).
RC_URL=https://chat.8examples.com
# Bridge bot account (created by provision.mjs).
RC_BOT_USER=hermes-bridge
RC_BOT_PASS=hermes-bridge-pass
# Shared secret; must match the outgoing-webhook token in Rocket.Chat.
WEBHOOK_TOKEN=changeme-hook-token
# Port the bridge listens on for Rocket.Chat's outgoing webhook.
BRIDGE_PORT=8091
# Where the control plane lives (data/tenants.json + tenants/<id>/data/.env).
MANAGED_HERMES_DIR=$FLEET_DIR
ENV
  chmod 0600 /etc/hermes/rc-bridge.env
  echo "Created /etc/hermes/rc-bridge.env — fill in RC_BOT_PASS / WEBHOOK_TOKEN to match provisioning."
fi

cat > /etc/systemd/system/hermes-rc-bridge.service <<'UNIT'
[Unit]
Description=Rocket.Chat <-> managed Hermes bridge
After=docker.service network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/hermes/rc-bridge.env
ExecStart=/usr/bin/node /opt/hermes-rc-bridge/bridge.mjs
Restart=on-failure
RestartSec=5
# reads tenants/<id>/data/.env (mode 0600, owned by the control-plane user)
User=root

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now hermes-rc-bridge.service
sleep 2
systemctl --no-pager status hermes-rc-bridge.service | head -6 || true
