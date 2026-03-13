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
| `/boundary set-rail nanopayment on <seller-address> [chain]` | Enable Circle Gateway nanopayment; business receives USDC at seller-address |
| `/boundary set-rail nanopayment off` | Disable nanopayment rail |
| `/boundary set-rail agent-card on [card-id]` | Enable AgentCard Visa rail; card-id optional (auto-provisioned if omitted) |
| `/boundary set-rail agent-card off` | Disable AgentCard rail |

**Settlement chains** (where the business receives funds): `polygon`, `arbitrum`
**User-payable chains** (where users can originate payments from): `solana`
**Valid tokens**: `USDC`, `USDT`, `DAI`, `WETH`
**Valid nanopayment chains**: `arcTestnet` (testnet), `base`, `baseSepolia`, `arbitrumSepolia`

## Bridge Configuration Rules

When `/boundary set-bridge on <settlement-chain>` is called:
1. Set `cross_chain.bridge.enabled: true`
2. Set `cross_chain.bridge.settlement_chain: <settlement-chain>`
3. Validate that `<settlement-chain>` is in `specification.allowed_chains` — if not, reject with: `ERROR: settlement_chain must be in allowed_chains. Run /boundary set-chain add <chain> first.`
4. Automatically add `solana` to `cross_chain.user_payable_chains` if not already present

When `/boundary set-bridge off` is called:
1. Set `cross_chain.bridge.enabled: false`
2. Leave `user_payable_chains` intact (user may re-enable later)

## Payment Rail Configuration Rules

When `/boundary set-rail nanopayment on <seller-address> [chain]` is called:
1. Set `payment_rails.nanopayment.enabled: true`
2. Set `payment_rails.nanopayment.seller_address: <seller-address>`
3. Set `payment_rails.nanopayment.chain: <chain>` (default: `arcTestnet`)
4. Validate seller-address starts with `0x` — reject if not a valid EVM address format

When `/boundary set-rail nanopayment off` is called:
1. Set `payment_rails.nanopayment.enabled: false`

When `/boundary set-rail agent-card on [card-id]` is called:
1. Set `payment_rails.agent_card.enabled: true`
2. If card-id provided, set `payment_rails.agent_card.card_id: <card-id>`; otherwise leave card_id as `""` (auto-provisioned at payment time)

When `/boundary set-rail agent-card off` is called:
1. Set `payment_rails.agent_card.enabled: false`

## On Every Change
1. Increment `version`
2. Update `updated_at`
3. Write memory trace to `memory/YYYY-MM-DD.md`
4. Run bash to create a timestamped backup:
```bash
mkdir -p /home/ec2-user/payclaw/shared/data/boundary-backups && cp /home/ec2-user/payclaw/shared/BOUNDARY.md "/home/ec2-user/payclaw/shared/data/boundary-backups/BOUNDARY-$(date +%Y%m%d-%H%M%S).md"
```

Note: The orchestrator reads BOUNDARY.md fresh on every request, so no notification is needed. Changes take immediate effect.

## Response
```
BOUNDARY UPDATED (v[old] → v[new])
Changed: [field]
Before: [old]
After:  [new]
```
