# Service Orchestrator — Tools Guide

## Script Execution

Scripts at `$RAILCLAW_SCRIPTS_DIR/`. Run via bash tool:
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
├── enforces boundaries (boundary-enforcer skill)
├── runs generate-payment-link.ts
├── runs monitor-transaction.ts (if needed)
└── returns result (session completes, sub-agent dies)
```
