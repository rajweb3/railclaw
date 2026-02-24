# Service Orchestrator — Tools Guide

## Script Execution

Scripts at `$RAILCLAW_SCRIPTS_DIR/`. Run via bash tool:
```bash
npx tsx $RAILCLAW_SCRIPTS_DIR/<script>.ts [arguments]
```

| Script | Purpose | When to use |
|---|---|---|
| `generate-payment-link.ts` | Create EVM payment link + pending record | `route = "direct"` (polygon, arbitrum) |
| `monitor-transaction.ts` | Poll EVM blockchain for incoming tx | After generate-payment-link.ts |
| `bridge-payment.ts` | Generate temp Solana wallet + bridge params | `route = "bridge"` (solana) |
| `monitor-solana-deposit.ts` | Watch Solana deposit → bridge → EVM confirm | After bridge-payment.ts |
| `check-confirmations.ts` | Check tx confirmation count | On demand |

## File Operations

- BOUNDARY.md: READ ONLY (written by business-owner agent)
- `$RAILCLAW_DATA_DIR/pending/`: Read/write payment records
- `memory/YYYY-MM-DD.md`: Append execution traces

## How You Are Invoked

You are spawned as a sub-agent by other agents via `sessions_spawn`. You do NOT have a persistent session. Each request creates a new session for you.

| Tool | Purpose |
|---|---|
| `sessions_spawn` | Spawn ephemeral sub-agents for script execution |

## Skills

| Skill | Purpose |
|---|---|
| boundary-enforcer | Validate commands against BOUNDARY.md rules |
| payment-executor | Spawn sub-agent to generate payment links |
| tx-monitor | Spawn sub-agent to monitor blockchain for tx confirmation |

## Execution Pattern

```
business-product spawns orchestrator (sessions_spawn)
├── orchestrator reads BOUNDARY.md
├── determines route: "direct" or "bridge"
│
├── route = "direct" (polygon, arbitrum)
│   ├── runs generate-payment-link.ts  → payment link URL
│   └── runs monitor-transaction.ts   → watches EVM for confirmation
│
├── route = "bridge" (solana)
│   ├── runs bridge-payment.ts         → temp Solana wallet + deposit address
│   └── runs monitor-solana-deposit.ts → watches Solana → bridges → EVM confirm
│
└── returns result (session completes, sub-agent dies)
```
