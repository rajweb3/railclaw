---
name: boundary-manager
description: CRUD operations on BOUNDARY.md. The ONLY skill authorized to modify boundaries.
user-invocable: true
metadata: {}
---

# Boundary Manager

## Prerequisites
- Business must be onboarded (`BOUNDARY.md` → `business.onboarded: true`)
- If not, respond: `NOT ONBOARDED. Use /onboard first.`

## Commands

| Command | Description |
|---|---|
| `/boundary show` | Display current boundaries |
| `/boundary set-name "Name"` | Set business name |
| `/boundary set-chain add <chain>` | Add allowed chain |
| `/boundary set-chain remove <chain>` | Remove chain (min 1 must remain) |
| `/boundary set-token add <token>` | Add allowed token |
| `/boundary set-token remove <token>` | Remove token (min 1 must remain) |
| `/boundary set-emi on [premium%]` | Enable EMI (default 2%) |
| `/boundary set-emi off` | Disable EMI |
| `/boundary set-restriction <key> <val>` | Update restriction |

Valid chains: `polygon`, `arbitrum`
Valid tokens: `USDC`, `USDT`, `DAI`, `WETH`

## On Every Change
1. Increment `version`
2. Update `updated_at`
3. Write memory trace to `memory/YYYY-MM-DD.md`
4. Notify the orchestrator via `sessions_send` to agent `orchestrator`:
```json
{
  "source": "business-owner",
  "action": "boundary_changed",
  "version": "[new version]",
  "changes": "[summary of what changed]"
}
```

## Response
```
BOUNDARY UPDATED (v[old] → v[new])
Changed: [field]
Before: [old]
After:  [new]
```
