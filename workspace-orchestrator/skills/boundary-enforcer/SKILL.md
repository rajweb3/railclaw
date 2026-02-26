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

| # | Check | Rule | Outcome |
|---|---|---|---|
| 1 | Business active | `status` must be `active` | `not_ready` |
| 2 | Business onboarded | `business.onboarded` must be `true` | `not_ready` |
| 3 | Chain routing | See routing table below | `route: direct`, `route: bridge`, or `rejected: chain` |
| 4 | Token allowed | `command.token` in `specification.allowed_tokens` | `rejected: token` |
| 5 | Amount limit | `command.amount` ≤ `restrictions.max_single_payment` (if > 0) | `rejected: amount` |
| 6 | EMI check | If EMI requested, `operational.emi_enabled` must be `true` | `rejected: emi` |

All chain and token comparisons are **case-insensitive**.

### Check #3 — Chain Routing Logic

```
if command.chain in specification.allowed_chains:
    → route: "direct"   (standard payment flow)

elif command.chain in cross_chain.user_payable_chains
     AND cross_chain.bridge.enabled = true:
    → route: "bridge"
      settlement_chain = cross_chain.bridge.settlement_chain
      (must be in allowed_chains — validate this too)

else:
    → rejected: chain
      policy = specification.allowed_chains + cross_chain.user_payable_chains
```

When `route: "bridge"`, the orchestrator will use the **bridge-executor** skill instead of payment-executor.

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

### Valid — Direct route (chain in allowed_chains)
```json
{
  "valid": true,
  "route": "direct",
  "boundary_version": 3,
  "business_id": "biz_a1b2",
  "business_name": "Acme Corp",
  "wallet": "0xABC..."
}
```

### Valid — Bridge route (chain in user_payable_chains with bridge.enabled)
```json
{
  "valid": true,
  "route": "bridge",
  "settlement_chain": "polygon",
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
  "policy": ["polygon", "arbitrum", "solana"],
  "received": "ethereum",
  "boundary_version": 3
}
```
