---
name: wallet-manager
description: View business wallet information.
user-invocable: true
metadata: {}
---

# Wallet Manager

## Commands

| Command | Description |
|---|---|
| `/wallet show` | Display wallet address from BOUNDARY.md |
| `/wallet info` | Show wallet + associated chains + pending payments count |

## Response
```
WALLET
Address: 0xABCD...EF12
Business: [name]
Chains: [allowed_chains]
```

## Rules
- NEVER expose private keys
- Read-only — wallet address changes go through /boundary
