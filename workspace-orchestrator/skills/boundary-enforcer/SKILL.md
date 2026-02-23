---
name: boundary-enforcer
description: Validates commands against BOUNDARY.md. Central enforcement point for all execution requests.
user-invocable: false
metadata: {}
---

# Boundary Enforcer

## Purpose

This is the central boundary enforcement skill used by the Service Orchestrator. Every execution request passes through this check before any sub-agent is spawned.

## Checks (stop at first failure)

| # | Check | Rule | Rejection |
|---|---|---|---|
| 1 | Business active | `status` must be `active` | `not_ready` |
| 2 | Business onboarded | `business.onboarded` must be `true` | `not_ready` |
| 3 | Chain allowed | `command.chain` in `specification.allowed_chains` | `rejected: chain` |
| 4 | Token allowed | `command.token` in `specification.allowed_tokens` | `rejected: token` |
| 5 | Amount limit | `command.amount` ≤ `restrictions.max_single_payment` (if > 0) | `rejected: amount` |
| 6 | EMI check | If EMI requested, `operational.emi_enabled` must be `true` | `rejected: emi` |

All chain and token comparisons are **case-insensitive**.

## Input

```json
{
  "action": "create_payment_link",
  "chain": "polygon",
  "token": "USDC",
  "amount": 100
}
```

## Output

### Valid
```json
{
  "valid": true,
  "boundary_version": 3,
  "business_id": "biz_a1b2",
  "business_name": "Acme Corp",
  "wallet": "0xABC..."
}
```

### Invalid
```json
{
  "valid": false,
  "violation": "chain",
  "policy": ["polygon", "arbitrum"],
  "received": "solana",
  "boundary_version": 3
}
```
