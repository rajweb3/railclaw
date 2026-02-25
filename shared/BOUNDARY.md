---
version: 0
status: pending_onboarding
updated_at: "2026-02-20T00:00:00Z"
---

# Business Boundary Definition

> Auto-initialized during onboarding. Updated via /boundary commands only.

## business
```yaml
id: ""
name: ""
email: ""
wallet: ""
onboarded: false
telegram_chat_id: ""
```

## specification
```yaml
allowed_chains: []
allowed_tokens: []
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
user_payable_chains: []          # Chains users may originate payments from (e.g. [solana])
bridge:
  enabled: false                 # Set to true to allow bridged payments
  provider: "across"             # Bridge provider (only "across" is supported)
  settlement_chain: "polygon"    # Must be one of allowed_chains — where bridge funds settle
```
