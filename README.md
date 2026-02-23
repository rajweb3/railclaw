# Railclaw

Boundary-defined agentic execution kernel for crypto payments, built on [OpenClaw](https://github.com/openclaw/openclaw).

Businesses declare constraints (allowed chains, tokens, limits), and the system deterministically enforces those rules against incoming payment commands. No negotiation, no ambiguity — valid commands execute, invalid ones are rejected.

## Architecture

```
Telegram Bots          OpenClaw Gateway              Execution
┌─────────────┐       ┌─────────────────┐
│ @biz_bot    │──────▶│ business-owner  │──── writes ───▶ BOUNDARY.md
│ (Owner)     │       │ (onboarding +   │                    │
└─────────────┘       │  boundaries)    │──── notifies ─┐    │
                      └─────────────────┘               │    │
                                                        ▼    ▼
┌─────────────┐       ┌─────────────────┐       ┌──────────────────┐
│ @product_bot│──────▶│ business-product│──────▶│   orchestrator   │
│ (Users)     │       │ (command parser │◀──────│ (boundary check  │
└─────────────┘       │  + display)     │       │  + sub-agents)   │
                      └─────────────────┘       └──────┬───────────┘
                                                       │
                                                ┌──────┴───────┐
                                                ▼              ▼
                                          Sub-Agent 1    Sub-Agent 2
                                          (Payment Link) (TX Monitor)
```

Three agents, one OpenClaw instance:

| Agent | Telegram Bot | Role |
|---|---|---|
| `business-owner` | `@railclaw_biz_bot` | Onboarding (email → OTP → wallet) + boundary management |
| `business-product` | `@railclaw_product_bot` | Parses payment commands, delegates to orchestrator |
| `orchestrator` | *(internal)* | Enforces boundaries, spawns sub-agents for execution |

## How It Works

1. **Business owner** onboards via `@railclaw_biz_bot` — verifies email, creates wallet, defines payment boundaries
2. **Boundaries** are written to `BOUNDARY.md` — allowed chains, tokens, amount limits, EMI rules
3. **Users** send payment commands to `@railclaw_product_bot` — "Create a payment link for 100 USDC on Polygon"
4. **Product bot** parses the command and delegates to the **orchestrator**
5. **Orchestrator** reads `BOUNDARY.md`, enforces rules, spawns sub-agents:
   - **Payment Creator** — generates a payment link
   - **TX Monitor** — polls blockchain until payment is confirmed
6. Results flow back: orchestrator → product bot → user

Boundary changes take **immediate effect** — if the owner removes Polygon, the next Polygon command is rejected.

## Project Structure

```
railclaw/
├── openclaw.json                    # 3 agents + 2 Telegram bots config
├── setup.sh                         # Bare metal setup (systemd)
├── .env.example                     # Environment variables template
├── ARCHITECTURE.md                  # Mermaid diagrams (detailed flows)
├── DEPLOY.md                        # AWS deployment guide
│
├── workspace-owner/                 # Business owner agent
│   ├── SOUL.md                      # Onboarding + boundary persona
│   ├── AGENTS.md                    # Operating instructions
│   └── skills/
│       ├── onboarding/              # Email → OTP → wallet flow
│       ├── boundary-manager/        # CRUD on BOUNDARY.md
│       └── wallet-manager/          # Wallet info + balance
│
├── workspace-product/               # Business product agent
│   ├── SOUL.md                      # Command parser persona
│   ├── AGENTS.md                    # Parse → delegate → display
│   └── skills/                      # (delegates to orchestrator)
│
├── workspace-orchestrator/          # Service orchestrator
│   ├── SOUL.md                      # Boundary enforcement engine
│   ├── AGENTS.md                    # Check → spawn → execute → memory
│   └── skills/
│       ├── boundary-enforcer/       # Validate against BOUNDARY.md
│       ├── payment-executor/        # Spawn sub-agent for link generation
│       └── tx-monitor/              # Spawn sub-agent for blockchain monitoring
│
├── shared/
│   ├── BOUNDARY.md                  # Business boundary definitions (YAML)
│   ├── scripts/                     # TypeScript execution scripts
│   │   ├── send-otp.ts              # Send OTP via AWS SES
│   │   ├── verify-otp.ts            # Validate OTP code
│   │   ├── create-wallet.ts         # Generate HD wallet (AES-256-GCM encrypted)
│   │   ├── generate-payment-link.ts # Create payment link + pending record
│   │   ├── monitor-transaction.ts   # Poll blockchain for tx confirmation
│   │   ├── check-confirmations.ts   # Check tx confirmation count
│   │   └── lib/
│   │       ├── config.ts            # Central config from env vars
│   │       └── crypto-utils.ts      # OTP, hashing, encryption helpers
│   └── data/                        # Runtime data (created by setup)
│       ├── wallets/                 # Encrypted keystores
│       ├── pending/                 # Pending payment records
│       └── otp/                     # OTP records
│
└── docs/                            # Design documents
    ├── basic-architecture.png
    ├── flow-diagram.png
    ├── aproach.png
    ├── contrast-explanation.png
    └── requirement-understanding.md
```

## Setup

### Prerequisites

- Node.js 22+
- [OpenClaw](https://github.com/openclaw/openclaw) installed globally
- Two Telegram bots (via @BotFather)
- Anthropic API key
- AWS SES (for OTP emails)
- Blockchain RPC endpoints (Alchemy/Infura)

### Quick Start

```bash
# Clone
git clone https://github.com/rajweb3/railclaw.git
cd railclaw

# Configure
cp .env.example .env
# Fill in: Telegram tokens, Anthropic key, AWS SES, RPC endpoints, wallet encryption key

# Setup (creates ~/.openclaw/ workspaces + systemd service)
chmod +x setup.sh
./setup.sh

# Onboard OpenClaw
source .env
openclaw onboard

# Start
sudo systemctl start railclaw
```

See [DEPLOY.md](DEPLOY.md) for full AWS deployment guide.

## Boundary Example

```yaml
version: 1
status: active
business:
  id: "biz_a1b2"
  name: "Acme Corp"
  wallet: "0xABC..."

specification:
  allowed_chains: ["polygon", "arbitrum"]
  allowed_tokens: ["USDC", "USDT"]

restrictions:
  max_single_payment: 10000
  max_tax_percent: 5

operational:
  emi_enabled: false
```

With this boundary:
- `100 USDC on Polygon` → **EXECUTED**
- `100 USDC on Solana` → **REJECTED** (chain not allowed)
- `50000 USDC on Polygon` → **REJECTED** (exceeds max_single_payment)

## Tech Stack

| Component | Technology |
|---|---|
| Agent Platform | [OpenClaw](https://github.com/openclaw/openclaw) |
| LLM | Anthropic Claude Sonnet 4.5 |
| Messaging | Telegram (grammY) |
| Wallet | ethers.js v6 (HD wallets, AES-256-GCM) |
| Email OTP | AWS SES |
| Blockchain | EVM RPCs (Polygon, Arbitrum, Ethereum, etc.) |
| Deployment | Ubuntu 22.04 + systemd |

## License

MIT
