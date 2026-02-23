# Railclaw — AWS Deployment Guide

Single OpenClaw instance, three agents (including Service Orchestrator), two Telegram bots.

---

## STEP 1: Provision EC2

1. AWS Console → EC2 → Launch Instance
2. **AMI**: Amazon Linux 2023
3. **Type**: t3.medium (2 vCPU, 4 GB)
4. **Storage**: 30 GB gp3
5. **Security Group**: SSH (22) from your IP
6. Download key pair → Launch

```bash
ssh -i your-key.pem ec2-user@YOUR_IP
```

---

## STEP 2: Install Git, OpenClaw, and tsx

```bash
sudo yum update -y
sudo yum install -y git

# Install OpenClaw (installs Node.js 22 automatically if missing)
curl -fsSL https://openclaw.ai/install.sh | bash

# Install tsx globally
npm install -g tsx
```

Verify:
```bash
node --version      # v22.x.x
openclaw doctor
```

---

## STEP 3: Create Two Telegram Bots

Open Telegram → @BotFather.

### Bot 1: Business Owner
```
/newbot → Name: Railclaw Business → Username: your_biz_bot
```
Save token → `TELEGRAM_BOT_TOKEN_OWNER`

```
/setcommands (select bot)
onboard - Start business onboarding
boundary - Manage payment boundaries
wallet - View wallet info

/setprivacy (select bot) → Disable
```

### Bot 2: Business Product
```
/newbot → Name: Railclaw Product → Username: your_product_bot
```
Save token → `TELEGRAM_BOT_TOKEN_PRODUCT`

```
/setprivacy (select bot) → Disable
```

---

## STEP 4: Get API Keys

| Key | Where |
|---|---|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/ → Create key |
| RPC endpoints | https://alchemy.com/ → Create apps for Polygon, Arbitrum |

> **Note:** OTP verification is sent directly via the Telegram bot — no email service (SES/Resend) needed.

---

## STEP 5: Clone and Configure

```bash
cd ~
git clone YOUR_REPO railclaw
cd railclaw

cp .env.example .env
nano .env
```

Fill in all values. Generate wallet encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## STEP 6: Run Setup

```bash
chmod +x setup.sh
./setup.sh
```

This creates:
```
~/.openclaw/
├── openclaw.json                  ← main config with 3 agents + 2 Telegram bots
├── workspace-owner/               ← business owner agent
│   ├── SOUL.md, AGENTS.md        ← onboarding + boundary management
│   ├── BOUNDARY.md               ← symlink to shared/BOUNDARY.md (read-write)
│   ├── skills/                   ← onboarding, boundary-manager, wallet-manager
│   └── memory/
├── workspace-product/             ← business product agent
│   ├── SOUL.md, AGENTS.md        ← command parsing + display
│   ├── skills/                   ← command-parser (delegates to orchestrator)
│   └── memory/
└── workspace-orchestrator/        ← service orchestrator (central engine)
    ├── SOUL.md, AGENTS.md        ← boundary enforcement + execution coordination
    ├── BOUNDARY.md               ← symlink to shared/BOUNDARY.md (read-only)
    ├── skills/                   ← boundary-enforcer, payment-executor, tx-monitor
    └── memory/
```

---

## STEP 7: Onboard OpenClaw

```bash
# Export env vars (source alone doesn't export them)
set -a && source ~/railclaw/.env && set +a

openclaw onboard
```

- Provider: **Anthropic**
- API Key: auto-detected from env
- Accept defaults

---

## STEP 8: Start

```bash
sudo systemctl start railclaw
sudo systemctl status railclaw
```

---

## STEP 9: Verify

```bash
# Logs
journalctl -u railclaw -f

# Test bot tokens
source ~/railclaw/.env
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN_OWNER}/getMe"
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN_PRODUCT}/getMe"
```

### Test Owner Bot
1. Telegram → Railclaw Business bot → `/onboard`
2. Enter email → get OTP → enter code → wallet created
3. `/boundary set-name "My Business"`
4. `/boundary set-chain add polygon`
5. `/boundary set-token add USDC`
6. `/boundary show`

### Test Product Bot
1. Telegram → Railclaw Product bot
2. `Create a payment link for 100 USDC on Polygon`
3. Should return payment link with business wallet

---

## Operations

```bash
# Logs
journalctl -u railclaw -f

# Restart (after editing workspace files)
sudo systemctl restart railclaw

# Stop
sudo systemctl stop railclaw

# Backup wallets (CRITICAL)
cp -r ~/railclaw/shared/data/wallets/ ~/backup-wallets-$(date +%Y%m%d)/
```

---

## Troubleshooting

```bash
# Service not starting
journalctl -u railclaw -n 50 --no-pager

# Port conflict / "Gateway already running"
# OpenClaw's own daemon may conflict with our systemd service. Disable it:
openclaw gateway stop
systemctl --user stop openclaw-gateway 2>/dev/null
systemctl --user disable openclaw-gateway 2>/dev/null
sudo systemctl restart railclaw

# Telegram bots not connecting
# Verify tokens are hardcoded (not ${VAR} placeholders) in the config:
grep botToken ~/.openclaw/openclaw.json
# If you still see ${TELEGRAM_BOT_TOKEN_...}, re-run setup.sh

# Test scripts directly
set -a && source ~/railclaw/.env && set +a
cd ~/railclaw/shared/scripts
RAILCLAW_DATA_DIR=~/railclaw/shared/data npx tsx send-otp.ts --email "test@test.com"
RAILCLAW_DATA_DIR=~/railclaw/shared/data npx tsx create-wallet.ts --email "test@test.com"
```
