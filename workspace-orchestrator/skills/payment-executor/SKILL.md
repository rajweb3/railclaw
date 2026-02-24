---
name: payment-executor
description: Spawns sub-agent to generate payment links. Only called after boundary enforcement passes.
user-invocable: false
metadata: {}
---

# Payment Executor

## ⚠️ EVM CHAINS ONLY

**DO NOT use this skill for Solana or any chain in `cross_chain.user_payable_chains`.**

If the payment chain is Solana (or any user-payable bridge chain): **stop, use bridge-executor instead.**

This skill runs `generate-payment-link.ts` which creates an EVM payment link URL. It does NOT create a Solana deposit address and will not work for cross-chain bridge payments.

## Purpose

Spawns an ephemeral sub-agent to generate an EVM payment link. Only for chains in `specification.allowed_chains` (e.g. polygon, arbitrum).

## Execution

Spawn a sub-agent via `sessions_spawn` with these instructions:

```
Run the following command and return the JSON output:

npx tsx $RAILCLAW_SCRIPTS_DIR/generate-payment-link.ts \
  --chain "[chain]" \
  --token "[token]" \
  --amount [amount] \
  --wallet "[wallet]" \
  --business "[business_name]" \
  --business-id "[business_id]"

Return the full JSON output. Do not modify it.
```

## Script Output

```json
{
  "success": true,
  "payment_id": "pay_XXXXXXXX",
  "link": "https://pay.railclaw.io/p/pay_XXXXXXXX",
  "chain": "polygon",
  "token": "USDC",
  "amount": 100,
  "wallet": "0x...",
  "business_name": "Acme Corp",
  "expires_at": "2026-02-21T14:30:00Z"
}
```

## After Success

1. Return the result to the calling agent
2. Immediately spawn a tx-monitor sub-agent for this payment
3. Record execution in narrative memory

## Error Handling

If the script fails, return:
```json
{
  "status": "error",
  "reason": "Script execution failed",
  "details": "[error output]"
}
```
