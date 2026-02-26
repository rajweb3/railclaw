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
| `/boundary set-chain add <chain>` | Add allowed settlement chain |
| `/boundary set-chain remove <chain>` | Remove settlement chain (min 1 must remain) |
| `/boundary set-token add <token>` | Add allowed token |
| `/boundary set-token remove <token>` | Remove token (min 1 must remain) |
| `/boundary set-emi on [premium%]` | Enable EMI (default 2%) |
| `/boundary set-emi off` | Disable EMI |
| `/boundary set-restriction <key> <val>` | Update restriction |
| `/boundary set-bridge on <settlement-chain>` | Enable Solana bridging; funds settle on given chain |
| `/boundary set-bridge off` | Disable bridging |
| `/boundary set-payable-chain add <chain>` | Add a user-payable source chain (e.g. solana) |
| `/boundary set-payable-chain remove <chain>` | Remove a user-payable source chain |

**Settlement chains** (where the business receives funds): `polygon`, `arbitrum`
**User-payable chains** (where users can originate payments from): `solana`
**Valid tokens**: `USDC`, `USDT`, `DAI`, `WETH`

## Bridge Configuration Rules

When `/boundary set-bridge on <settlement-chain>` is called:
1. Set `cross_chain.bridge.enabled: true`
2. Set `cross_chain.bridge.settlement_chain: <settlement-chain>`
3. Validate that `<settlement-chain>` is in `specification.allowed_chains` — if not, reject with: `ERROR: settlement_chain must be in allowed_chains. Run /boundary set-chain add <chain> first.`
4. Automatically add `solana` to `cross_chain.user_payable_chains` if not already present

When `/boundary set-bridge off` is called:
1. Set `cross_chain.bridge.enabled: false`
2. Leave `user_payable_chains` intact (user may re-enable later)

## On Every Change
1. Increment `version`
2. Update `updated_at`
3. Write memory trace to `memory/YYYY-MM-DD.md`
4. Copy the full contents of BOUNDARY.md to `$RAILCLAW_DATA_DIR/boundary-backup.md` (overwrite)

Note: The orchestrator reads BOUNDARY.md fresh on every request, so no notification is needed. Changes take immediate effect.

## Response
```
BOUNDARY UPDATED (v[old] → v[new])
Changed: [field]
Before: [old]
After:  [new]
```
