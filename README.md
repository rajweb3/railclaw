# Railclaw

<img src="logo.jpg" alt="Railclaw" width="120" />

Crypto payment infrastructure for businesses, built on [OpenClaw](https://github.com/openclaw/openclaw). Businesses define rules once — allowed chains, tokens, limits — and the system enforces them automatically on every payment request.

## Architecture

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  Owner Bot   │────▶│ business-owner  │────▶│  BOUNDARY.md     │
│  (Telegram)  │     │ onboarding +    │     │  (rules)         │
└──────────────┘     │ boundaries      │     └────────┬─────────┘
                     └─────────────────┘              │
┌──────────────┐     ┌─────────────────┐     ┌────────▼─────────┐
│ Product Bot  │────▶│business-product │────▶│  orchestrator    │
│  (Telegram)  │     │ parse + display │◀────│  enforce + spawn │
└──────────────┘     └─────────────────┘     └────────┬─────────┘
                                                       │
                                              ┌────────┴────────┐
                                              ▼                 ▼
                                        Payment Link       TX Monitor
                                        (sub-agent)        (sub-agent)
```

| Agent | Role |
|---|---|
| `business-owner` | Onboarding (email → OTP → wallet) + boundary management |
| `business-product` | Parses user commands, delegates to orchestrator, formats response |
| `orchestrator` | Reads BOUNDARY.md, enforces rules, spawns execution sub-agents |

## Payment Flows

**Direct** (Polygon / Arbitrum) — generates a payment link, monitors ERC-20 Transfer events via WebSocket, sends Telegram confirmation on N confirmations.

**Bridge** (Solana → Polygon/Arbitrum) — generates a Solana deposit address, watches for USDC arrival, calls Across Protocol `depositV3`, monitors the EVM fill event, sends Telegram confirmation.

Both monitors run as independent `sessions_spawn` sub-agents and cannot interfere with each other.

## Project Structure

```
railclaw/
├── openclaw.json                  # Agent + Telegram bot configuration
├── setup.sh                       # EC2 setup + systemd service
├── shared/
│   ├── BOUNDARY.md                # Business rules (chains, tokens, limits)
│   └── scripts/                   # TypeScript execution scripts
│       ├── generate-payment-link.ts
│       ├── bridge-payment.ts
│       ├── monitor-transaction.ts
│       ├── monitor-solana-deposit.ts
│       ├── check-wallet-balance.ts
│       ├── send-otp.ts / verify-otp.ts / create-wallet.ts
│       └── lib/config.ts
├── workspace-owner/AGENTS.md      # Owner bot instructions
├── workspace-product/AGENTS.md    # Product bot instructions
└── workspace-orchestrator/AGENTS.md  # Orchestrator instructions
```

## Quick Start

```bash
git clone https://github.com/rajweb3/railclaw.git && cd railclaw
cp .env.example .env               # fill in tokens, keys, RPCs
chmod +x setup.sh && ./setup.sh
source .env && openclaw onboard
sudo systemctl start railclaw
```

**Prerequisites:** Node.js 22+, OpenClaw, two Telegram bots, Anthropic API key, RPC endpoints.

## Tech Stack

| | |
|---|---|
| Agent runtime | [OpenClaw](https://github.com/openclaw/openclaw) |
| LLM | Anthropic Claude Sonnet |
| Chains | Polygon, Arbitrum (EVM) · Solana (bridge via Across Protocol) |
| Wallet | ethers.js v6 · AES-256-GCM encrypted keystores |
| Messaging | Telegram |

## License

MIT
