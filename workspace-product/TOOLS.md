# Product Bot — Tools Guide

## Inter-Agent Communication

| Tool | Purpose |
|---|---|
| `sessions_spawn` | Spawn orchestrator sub-agent to process commands |

## Usage

Spawn orchestrator sub-agent to handle a payment command:
```
sessions_spawn with agentId "orchestrator":
"Process this payment request: action=create_payment_link, amount=100, token=USDC, chain=polygon. Source: business-product."
```

The orchestrator sub-agent will:
1. Read BOUNDARY.md and enforce rules
2. Execute the command (run scripts, generate links)
3. Return the result

**IMPORTANT:** Use `sessions_spawn` — NOT `sessions_send`. The orchestrator has no channel binding and no persistent session. You must spawn a new sub-agent session for each request.

## Flow

```
User Message
├── Parse command (this bot)
├── Spawn orchestrator sub-agent (sessions_spawn)
├── Orchestrator checks boundaries + executes
├── Orchestrator returns result
└── Format and display to user (this bot)
```

## Important

- This bot does NOT run any scripts directly
- This bot does NOT read BOUNDARY.md for enforcement
- All execution is handled by the orchestrator via sessions_spawn
