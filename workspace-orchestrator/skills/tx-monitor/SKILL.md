---
name: tx-monitor
description: Spawns sub-agent to monitor blockchain for incoming transactions matching a pending payment.
user-invocable: false
metadata: {}
---

# Transaction Monitor

## Purpose

Spawns an ephemeral sub-agent that polls the blockchain for incoming transactions matching a pending payment. Runs in the background after a payment link is created.

## Execution

Spawn a sub-agent via `sessions_spawn` with these instructions:

```
Run the following command and return the JSON output when it completes:

npx tsx $RAILCLAW_SCRIPTS_DIR/monitor-transaction.ts \
  --payment-id "[payment_id]" \
  --chain "[chain]" \
  --token "[token]" \
  --amount [amount] \
  --wallet "[wallet]" \
  --confirmations 20 \
  --timeout 3600 \
  --poll-interval 15

This is a long-running command. Wait for it to complete. Return the full JSON output.
```

## Behavior

1. Polls RPC every 15 seconds
2. Checks ERC-20 Transfer events (or native tx) to the wallet
3. Matches token + amount with 1% slippage tolerance
4. When found: waits for 20 confirmations
5. Updates `$RAILCLAW_DATA_DIR/pending/pay_XXXXXXXX.json` → status: confirmed
6. Returns result

## On Completion

When the monitor sub-agent returns:

### Transaction Confirmed
Return the result (the parent session will receive it):
```json
{
  "event": "tx_confirmed",
  "payment_id": "pay_XXXXXXXX",
  "tx_hash": "0x...",
  "confirmations": 20,
  "chain": "polygon",
  "token": "USDC",
  "amount": 100
}
```

### Timeout (no tx found)
Return:
```json
{
  "event": "tx_timeout",
  "payment_id": "pay_XXXXXXXX",
  "timeout_seconds": 3600
}
```

## Important

- OpenClaw sub-agents auto-archive after 60 minutes
- The monitor script handles its own polling loop
- The sub-agent is KILLED after the script completes
- Record the outcome in narrative memory
