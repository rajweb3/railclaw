---
version: 11
status: active
updated_at: "2026-03-13T13:00:00Z"
---

# Business Boundary Definition

> Auto-initialized during onboarding. Updated via /boundary commands only.

## business
```yaml
id: "biz_8f48a4c3"
name: "pay-human"
email: "raj@gmail.com"
wallet: "0xA0Eb1765950Ef76008a2b5d9F68EC2eA5A8e7fC9"
onboarded: true
```

## specification
```yaml
allowed_chains: [polygon, arbitrum]
allowed_tokens: [USDC]
inbound_only: true
```

## operational
```yaml
emi_enabled: false
emi_premium_percent: 0
max_slippage_percent: 1
```

## restrictions
```yaml
max_tax_percent: 5
max_single_payment: 10000
blocked_regions: []
```

## cross_chain
```yaml
user_payable_chains: [solana]
bridge:
  enabled: true
  provider: "across"
  settlement_chain: "polygon"
```

## payment_rails
```yaml
agent_card:
  enabled: true
  card_id: ""

nanopayment:
  enabled: true
  chain: "arcTestnet"
  seller_address: "0xA0Eb1765950Ef76008a2b5d9F68EC2eA5A8e7fC9"
```
