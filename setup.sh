#!/bin/bash
set -euo pipefail

# ============================================
# Railclaw Setup — Single OpenClaw Instance
# Two agents: business-owner + business-product
# ============================================

RAILCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_HOME="$HOME/.openclaw"

echo "=========================================="
echo "  Railclaw Setup"
echo "  Source: $RAILCLAW_DIR"
echo "  OpenClaw Home: $OPENCLAW_HOME"
echo "=========================================="

# --- Step 1: Check prerequisites ---
echo ""
echo "[1/6] Checking prerequisites..."

NODE_VERSION=$(node --version 2>/dev/null || echo "none")
if [[ "$NODE_VERSION" == "none" ]]; then
  echo "ERROR: Node.js not installed."
  echo "  For Amazon Linux: curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo yum install -y nodejs"
  echo "  For Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi

NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "ERROR: Node.js 22+ required. Found: $NODE_VERSION"
  exit 1
fi

if ! command -v openclaw &>/dev/null; then
  echo "ERROR: OpenClaw not installed. Run: npm install -g openclaw@latest"
  exit 1
fi

if ! command -v tsx &>/dev/null; then
  echo "  Installing tsx globally..."
  npm install -g tsx
fi

echo "  Node.js: $NODE_VERSION"
echo "  OpenClaw: $(openclaw --version 2>/dev/null || echo 'installed')"
echo "  OK"

# --- Step 2: Check .env ---
echo ""
echo "[2/6] Checking .env..."

if [[ ! -f "$RAILCLAW_DIR/.env" ]]; then
  echo "ERROR: .env not found. Run: cp .env.example .env && nano .env"
  exit 1
fi

source "$RAILCLAW_DIR/.env"

MISSING=""
[[ -z "${TELEGRAM_BOT_TOKEN_OWNER:-}" ]] && MISSING="$MISSING TELEGRAM_BOT_TOKEN_OWNER"
[[ -z "${TELEGRAM_BOT_TOKEN_PRODUCT:-}" ]] && MISSING="$MISSING TELEGRAM_BOT_TOKEN_PRODUCT"
[[ -z "${ANTHROPIC_API_KEY:-}" ]] && MISSING="$MISSING ANTHROPIC_API_KEY"
[[ -z "${WALLET_ENCRYPTION_KEY:-}" ]] && MISSING="$MISSING WALLET_ENCRYPTION_KEY"

if [[ -n "$MISSING" ]]; then
  echo "ERROR: Missing env vars:$MISSING"
  exit 1
fi
echo "  OK"

# --- Step 3: Install script dependencies ---
echo ""
echo "[3/6] Installing script dependencies..."

cd "$RAILCLAW_DIR/shared/scripts"
npm install --production
cd "$RAILCLAW_DIR"
echo "  OK"

# --- Step 4: Create data directories ---
echo ""
echo "[4/6] Creating directories..."

mkdir -p "$RAILCLAW_DIR/shared/data/wallets"
mkdir -p "$RAILCLAW_DIR/shared/data/pending"
mkdir -p "$RAILCLAW_DIR/shared/data/otp"
mkdir -p "$OPENCLAW_HOME"
echo "  OK"

# --- Step 5: Set up workspace structure under ~/.openclaw ---
echo ""
echo "[5/6] Setting up OpenClaw workspaces..."

# Copy the main config
cp "$RAILCLAW_DIR/openclaw.json" "$OPENCLAW_HOME/openclaw.json"

# --- workspace-owner ---
OWNER_WS="$OPENCLAW_HOME/workspace-owner"
mkdir -p "$OWNER_WS/skills" "$OWNER_WS/memory"

ln -sf "$RAILCLAW_DIR/workspace-owner/SOUL.md" "$OWNER_WS/SOUL.md"
ln -sf "$RAILCLAW_DIR/workspace-owner/AGENTS.md" "$OWNER_WS/AGENTS.md"
ln -sf "$RAILCLAW_DIR/workspace-owner/IDENTITY.md" "$OWNER_WS/IDENTITY.md"
ln -sf "$RAILCLAW_DIR/workspace-owner/TOOLS.md" "$OWNER_WS/TOOLS.md"
ln -sf "$RAILCLAW_DIR/shared/BOUNDARY.md" "$OWNER_WS/BOUNDARY.md"

rm -rf "$OWNER_WS/skills"
ln -sf "$RAILCLAW_DIR/workspace-owner/skills" "$OWNER_WS/skills"
cp -n "$RAILCLAW_DIR/workspace-owner/memory/MEMORY.md" "$OWNER_WS/memory/MEMORY.md" 2>/dev/null || true

echo "  Owner workspace → $OWNER_WS"

# --- workspace-product ---
PRODUCT_WS="$OPENCLAW_HOME/workspace-product"
mkdir -p "$PRODUCT_WS/skills" "$PRODUCT_WS/memory"

ln -sf "$RAILCLAW_DIR/workspace-product/SOUL.md" "$PRODUCT_WS/SOUL.md"
ln -sf "$RAILCLAW_DIR/workspace-product/AGENTS.md" "$PRODUCT_WS/AGENTS.md"
ln -sf "$RAILCLAW_DIR/workspace-product/IDENTITY.md" "$PRODUCT_WS/IDENTITY.md"
ln -sf "$RAILCLAW_DIR/workspace-product/TOOLS.md" "$PRODUCT_WS/TOOLS.md"
ln -sf "$RAILCLAW_DIR/shared/BOUNDARY.md" "$PRODUCT_WS/BOUNDARY.md"

rm -rf "$PRODUCT_WS/skills"
ln -sf "$RAILCLAW_DIR/workspace-product/skills" "$PRODUCT_WS/skills"
cp -n "$RAILCLAW_DIR/workspace-product/memory/MEMORY.md" "$PRODUCT_WS/memory/MEMORY.md" 2>/dev/null || true

echo "  Product workspace → $PRODUCT_WS"

# --- workspace-orchestrator ---
ORCH_WS="$OPENCLAW_HOME/workspace-orchestrator"
mkdir -p "$ORCH_WS/skills" "$ORCH_WS/memory"

ln -sf "$RAILCLAW_DIR/workspace-orchestrator/SOUL.md" "$ORCH_WS/SOUL.md"
ln -sf "$RAILCLAW_DIR/workspace-orchestrator/AGENTS.md" "$ORCH_WS/AGENTS.md"
ln -sf "$RAILCLAW_DIR/workspace-orchestrator/IDENTITY.md" "$ORCH_WS/IDENTITY.md"
ln -sf "$RAILCLAW_DIR/workspace-orchestrator/TOOLS.md" "$ORCH_WS/TOOLS.md"
ln -sf "$RAILCLAW_DIR/shared/BOUNDARY.md" "$ORCH_WS/BOUNDARY.md"

rm -rf "$ORCH_WS/skills"
ln -sf "$RAILCLAW_DIR/workspace-orchestrator/skills" "$ORCH_WS/skills"
cp -n "$RAILCLAW_DIR/workspace-orchestrator/memory/MEMORY.md" "$ORCH_WS/memory/MEMORY.md" 2>/dev/null || true

echo "  Orchestrator workspace → $ORCH_WS"

# --- Step 6: Install systemd service ---
echo ""
echo "[6/6] Installing systemd service..."

# Build env file for systemd
ENV_FILE="$RAILCLAW_DIR/railclaw.env"
cp "$RAILCLAW_DIR/.env" "$ENV_FILE"
echo "" >> "$ENV_FILE"
echo "RAILCLAW_DATA_DIR=$RAILCLAW_DIR/shared/data" >> "$ENV_FILE"
echo "RAILCLAW_SCRIPTS_DIR=$RAILCLAW_DIR/shared/scripts" >> "$ENV_FILE"

# Single service — one OpenClaw instance, two agents
sudo tee /etc/systemd/system/railclaw.service > /dev/null <<SERVICEEOF
[Unit]
Description=Railclaw (OpenClaw Gateway)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$RAILCLAW_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(which openclaw) start --foreground
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=railclaw

[Install]
WantedBy=multi-user.target
SERVICEEOF

sudo systemctl daemon-reload
sudo systemctl enable railclaw

echo "  Systemd service installed: railclaw"

echo ""
echo "=========================================="
echo "  Setup complete!"
echo "=========================================="
echo ""
echo "  Next steps:"
echo ""
echo "  1. Run OpenClaw onboarding:"
echo "     openclaw onboard"
echo ""
echo "  2. Start the service:"
echo "     sudo systemctl start railclaw"
echo ""
echo "  3. Check status:"
echo "     sudo systemctl status railclaw"
echo ""
echo "  4. View logs:"
echo "     journalctl -u railclaw -f"
echo ""
echo "  5. Message your Telegram bots to test!"
echo ""
echo "  Structure under ~/.openclaw/:"
echo "    openclaw.json              ← main config (3 agents, 2 Telegram bots)"
echo "    workspace-owner/           ← business owner agent (onboarding + boundaries)"
echo "    workspace-product/         ← business product agent (command parsing + display)"
echo "    workspace-orchestrator/    ← service orchestrator (boundary enforcement + execution)"
echo ""
echo "=========================================="
