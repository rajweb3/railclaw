# Service Orchestrator — Tools Guide

## Script Execution

Scripts at `$RAILCLAW_SCRIPTS_DIR/`. Run via sub-agents:
```bash
npx tsx $RAILCLAW_SCRIPTS_DIR/<script>.ts [arguments]
```

| Script | Purpose |
|---|---|
| `generate-payment-link.ts` | Create payment link + pending record |
| `monitor-transaction.ts` | Poll blockchain for incoming tx |
| `check-confirmations.ts` | Check tx confirmation count |

## File Operations

- BOUNDARY.md: READ ONLY (written by business-owner agent)
- `$RAILCLAW_DATA_DIR/pending/`: Read/write payment records
- `memory/YYYY-MM-DD.md`: Append execution traces

## Inter-Agent Communication

| Tool | Purpose |
|---|---|
| `sessions_send` | Receive requests from business-product and business-owner agents |
| `sessions_spawn` | Spawn ephemeral sub-agents for script execution |

## Skills

| Skill | Purpose |
|---|---|
| boundary-enforcer | Validate commands against BOUNDARY.md rules |
| payment-executor | Spawn sub-agent to generate payment links |
| tx-monitor | Spawn sub-agent to monitor blockchain for tx confirmation |

## Sub-Agent Pattern

```
Orchestrator (main session)
├── receives request from business-product via sessions_send
├── enforces boundaries (boundary-enforcer skill)
├── spawn: Payment Creator (sub-agent)
│   └── exec: generate-payment-link.ts
│   └── returns: { payment_id, link }
│   └── KILLED
├── spawn: Transaction Monitor (sub-agent)
│   └── exec: monitor-transaction.ts
│   └── returns: { tx_hash, confirmations }
│   └── KILLED
└── returns result to business-product via sessions_send
```
