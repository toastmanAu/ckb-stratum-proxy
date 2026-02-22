#!/bin/bash
# ── CKB Stratum Proxy — Orange Pi 3B installer ────────────────────────────────
# Run this once on the node machine as the phill user:
#   bash <(curl -fsSL https://raw.githubusercontent.com/toastmanAu/ckb-stratum-proxy/main/install.sh)
# Or copy it over and: bash install.sh
set -e

INSTALL_DIR="$HOME/ckb-stratum-proxy"
REPO="https://github.com/toastmanAu/ckb-stratum-proxy.git"
SERVICE_NAME="ckb-stratum-proxy"

echo "═══════════════════════════════════════════"
echo "  CKB Stratum Proxy — installer"
echo "═══════════════════════════════════════════"

# ── 1. Node.js ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "► Node.js not found — installing via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "✓ Node.js $(node --version)"
fi

# ── 2. Git ────────────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  echo "► Installing git..."
  sudo apt-get install -y git
fi

# ── 3. Clone / update repo ────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "► Updating existing install..."
  cd "$INSTALL_DIR" && git pull
else
  echo "► Cloning repo..."
  git clone "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ── 4. Config ─────────────────────────────────────────────────────────────────
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo ""
  echo "┌─────────────────────────────────────────────┐"
  echo "│  Edit config.json with your pool details:   │"
  echo "│    nano $INSTALL_DIR/config.json │"
  echo "└─────────────────────────────────────────────┘"
  echo ""
  # Pre-fill with solo mining defaults (direct to local CKB node)
  cat > config.json << 'CONF'
{
  "mode": "solo",
  "node": {
    "host"    : "127.0.0.1",
    "port"    : 8114,
    "coinbase": "ckb1qyqwueud5e9j3lp3chv8qq820s7lxyggd9usvlg"
  },
  "local": {
    "host"     : "0.0.0.0",
    "port"     : 3333,
    "statsPort": 8081
  },
  "vardiff": {
    "targetShareSec"  : 30,
    "retargetSec"     : 60,
    "variancePercent" : 30,
    "minDiff"         : 0.001,
    "maxDiff"         : 1000000000,
    "initialDiff"     : 1.0
  }
}
CONF
  echo "► Default config written (solo mode → local CKB node port 8114)"
else
  echo "✓ config.json already exists — not overwriting"
fi

# ── 5. systemd service ────────────────────────────────────────────────────────
NODE_BIN=$(command -v node)
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "► Installing systemd service..."
sudo tee "$UNIT_FILE" > /dev/null << EOF
[Unit]
Description=CKB Stratum Proxy (Eaglesong/ViaBTC)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/solo-proxy.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
sleep 2

# ── 6. Firewall (ufw) ─────────────────────────────────────────────────────────
if command -v ufw &>/dev/null && sudo ufw status | grep -q "Status: active"; then
  echo "► Opening port 3333 in ufw..."
  sudo ufw allow 3333/tcp comment "CKB Stratum Proxy"
fi

# ── 7. Status check ───────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "  ✓ Service running!"
  LOCAL_IP=$(hostname -I | awk '{print $1}')
  echo "  Stratum : stratum+tcp://${LOCAL_IP}:3333"
  echo "  Stats   : http://${LOCAL_IP}:8081/"
  echo ""
  echo "  Logs    : journalctl -u ${SERVICE_NAME} -f"
  curl -sf http://localhost:8081/ 2>/dev/null | python3 -m json.tool 2>/dev/null || \
  curl -sf http://localhost:8081/health 2>/dev/null || true
else
  echo "  ✗ Service failed to start"
  echo "  Logs:"
  sudo journalctl -u "$SERVICE_NAME" --no-pager -n 20
fi
echo "═══════════════════════════════════════════"

# ── 8. SSH key for remote management (optional) ───────────────────────────────
PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBKigr4DtDQ1mUDpWX84uHyRjtxH0MVBquzkSzH/TdEe kernel@oPI5-oc"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
if ! grep -qF "$PUBKEY" ~/.ssh/authorized_keys 2>/dev/null; then
  echo "$PUBKEY" >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
  echo "► SSH key added (Pi 5 can now manage this node remotely)"
fi

echo ""
echo "Done. Point your miners at $(hostname -I | awk '{print $1}'):3333"
