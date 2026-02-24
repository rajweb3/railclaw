---
name: bridge-executor
description: Spawns sub-agents to execute a cross-chain bridge payment via Across Protocol. Only called when boundary-enforcer returns route "bridge".
user-invocable: false
metadata: {}
---

# Bridge Executor

## Purpose

Handles cross-chain payment requests where the user pays on a source chain (e.g. Solana) and the business settles on their allowed chain (e.g. Polygon or Arbitrum). Uses Across Protocol SpokePool contracts directly — no Across API.

Only invoked AFTER boundary-enforcer returns `{ valid: true, route: "bridge" }`.

## Execution

### Step 1 — Generate bridge payment instructions

Spawn a sub-agent via `sessions_spawn` with:

```
Run the following command and return the JSON output:

npx tsx $RAILCLAW_SCRIPTS_DIR/bridge-payment.ts \
  --source-chain "[source_chain]" \
  --settlement-chain "[settlement_chain]" \
  --token "[token]" \
  --amount [amount] \
  --wallet "[wallet]" \
  --business "[business_name]" \
  --business-id "[business_id]"

Return the full JSON output. Do not modify it.
```

Where `settlement_chain` is `cross_chain.bridge.settlement_chain` from BOUNDARY.md.

### Step 2 — Spawn bridge monitor (background)

Immediately after Step 1 succeeds, spawn a second sub-agent via `sessions_spawn`:

```
Run the following command and return the JSON output when it completes:

npx tsx $RAILCLAW_SCRIPTS_DIR/monitor-solana-deposit.ts \
  --payment-id "[payment_id]" \
  --settlement-chain "[settlement_chain]" \
  --timeout 7200 \
  --poll-interval 30

This is a long-running command. Wait for it to complete and return the full JSON output.
```

## Script Outputs

### bridge-payment.ts
```json
{
  "success": true,
  "payment_id": "pay_XXXXXXXX",
  "bridge_instructions": {
    "network": "solana",
    "deposit_address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "token": "USDC",
    "amount_to_send": "100.50",
    "relay_fee": "0.50",
    "business_receives": "100.00",
    "settlement_chain": "polygon",
    "settlement_wallet": "0x...",
    "note": "Send USDC to deposit_address. Funds bridge automatically to settlement chain."
  },
  "expires_at": "2026-02-25T12:00:00Z"
}
```

### monitor-solana-deposit.ts (on fill)
```json
{
  "success": true,
  "status": "confirmed",
  "payment_id": "pay_XXXXXXXX",
  "tx_hash": "0x...",
  "confirmations": 3,
  "confirmed_at": "2026-02-24T12:05:00Z"
}
```

## Return Value (to calling agent)

```json
{
  "status": "bridge_payment",
  "payment_id": "pay_XXXXXXXX",
  "bridge_instructions": {
    "network": "solana",
    "deposit_address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "token": "USDC",
    "amount_to_send": "100.50",
    "relay_fee": "0.50",
    "business_receives": "100.00",
    "settlement_chain": "polygon",
    "settlement_wallet": "0x..."
  },
  "monitor": "active"
}
```

## Error Handling

If bridge-payment.ts fails:
```json
{
  "status": "error",
  "reason": "Bridge payment generation failed",
  "details": "[error output]"
}
```

## Important

- The relay fee is an **estimate** (~0.12% of amount). Actual fees vary with network conditions.
- The fill deadline is 6 hours from creation — user must deposit within this window.
- Across relayers typically fill within seconds to minutes.
- The EVM settlement is confirmed by watching `FilledV3Relay` events on the SpokePool contract directly.
- Record the full outcome in narrative memory.
