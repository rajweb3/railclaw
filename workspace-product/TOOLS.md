# Product Bot — Tools Guide

## Inter-Agent Communication

| Tool | Purpose |
|---|---|
| `sessions_send` | Send parsed commands to the orchestrator agent |

## Usage

Send command to orchestrator:
```
sessions_send to agent "orchestrator":
{
  "source": "business-product",
  "action": "create_payment_link",
  "amount": 100,
  "token": "USDC",
  "chain": "polygon"
}
```

## Skills

| Skill | Purpose |
|---|---|
| command-parser | Parse natural language into structured commands |

## Flow

```
User Message
├── Parse command (this bot)
├── Delegate to orchestrator (sessions_send)
├── Orchestrator checks boundaries + executes
├── Orchestrator returns result (sessions_send)
└── Format and display to user (this bot)
```

## Important

- This bot does NOT run any scripts directly
- This bot does NOT read BOUNDARY.md for enforcement
- This bot does NOT spawn sub-agents
- All execution is handled by the orchestrator
