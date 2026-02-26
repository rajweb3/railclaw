---
name: payment-executor
description: Executes a payment request. Handles both direct EVM payments and Solana bridge payments by checking the chain type.
user-invocable: false
metadata: {}
---

# Payment Executor

## Purpose

Executes a payment request. Routes to the correct script based on the chain:
- **Solana** (or any chain in `cross_chain.user_payable_chains`) → `bridge-payment.ts` → returns a Solana deposit address
- **Polygon / Arbitrum** (chains in `specification.allowed_chains`) → `generate-payment-link.ts` → returns a payment link URL

## Step 1 — Check the chain

Read `BOUNDARY.md` to determine the route:

**If `command.chain` is in `cross_chain.user_payable_chains` AND `cross_chain.bridge.enabled = true`** (e.g. solana):

→ Go to **[Bridge Path]** below. Do NOT run generate-payment-link.ts.

**If `command.chain` is in `specification.allowed_chains`** (e.g. polygon, arbitrum):

→ Go to **[Direct Path]** below.

---

## [Bridge Path] — Solana → EVM via Across Protocol

Spawn a sub-agent via `sessions_spawn`:

```
Run the following command and return the full JSON output:

npx tsx $RAILCLAW_SCRIPTS_DIR/bridge-payment.ts \
  --source-chain "[chain]" \
  --settlement-chain "[cross_chain.bridge.settlement_chain]" \
  --token "[token]" \
  --amount [amount] \
  --wallet "[wallet]" \
  --business "[business_name]" \
  --business-id "[business_id]"

Return the full JSON output. Do not modify it.
```

On success, immediately spawn a second sub-agent:

```
Run the following command and return the full JSON output when it completes:

npx tsx $RAILCLAW_SCRIPTS_DIR/monitor-solana-deposit.ts \
  --payment-id "[payment_id from previous output]" \
  --settlement-chain "[cross_chain.bridge.settlement_chain]" \
  --timeout 7200 \
  --poll-interval 30

This is a long-running command. Wait for it to complete.
```

Return `status: "bridge_payment"` with the full `bridge_instructions` from the bridge-payment.ts output.

### bridge-payment.ts output
```json
{
  "success": true,
  "payment_id": "pay_XXXXXXXX",
  "bridge_instructions": {
    "network": "solana",
    "deposit_address": "5EjFZbN5eYVNjm9WvRWWiS4goXS5QxX8cARDtsxmXbTc",
    "token": "USDC",
    "amount_to_send": "0.60",
    "relay_fee": "0.50",
    "business_receives": "0.10",
    "settlement_chain": "polygon",
    "settlement_wallet": "0x...",
    "note": "Send USDC to deposit_address. Funds bridge automatically to settlement chain."
  },
  "expires_at": "2026-02-25T12:00:00Z"
}
```

---

## [Direct Path] — EVM Payment Link

Spawn a sub-agent via `sessions_spawn`:

```
Run the following command and return the full JSON output:

npx tsx $RAILCLAW_SCRIPTS_DIR/generate-payment-link.ts \
  --chain "[chain]" \
  --token "[token]" \
  --amount [amount] \
  --wallet "[wallet]" \
  --business "[business_name]" \
  --business-id "[business_id]"

Return the full JSON output. Do not modify it.
```

On success, spawn a tx-monitor sub-agent and return `status: "executed"` with the link.

### generate-payment-link.ts output
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

---

## Error Handling

If either script fails:
```json
{
  "status": "error",
  "reason": "Script execution failed",
  "details": "[error output]"
}
```
