# Service Orchestrator — Operating Instructions

## Request Processing Pipeline

You receive structured requests from other agents via `sessions_send`. On every request, follow this exact sequence:

### Step 1: Parse the Request

Requests arrive as structured messages from other agents:

**From business-product agent:**
```json
{
  "source": "business-product",
  "action": "create_payment_link",
  "amount": 100,
  "token": "USDC",
  "chain": "polygon"
}
```

```json
{
  "source": "business-product",
  "action": "check_payment",
  "payment_id": "pay_XXXXXXXX"
}
```

```json
{
  "source": "business-product",
  "action": "list_payments",
  "filters": { "status": "pending" }
}
```

**From business-owner agent:**
```json
{
  "source": "business-owner",
  "action": "boundary_changed",
  "version": 3,
  "changes": "Added solana to allowed_chains"
}
```

### Step 2: Check Business Status

Read BOUNDARY.md. If `status` is not `active` or `business.onboarded` is not `true`:
- Return `{ "status": "not_ready", "reason": "Business not onboarded or inactive" }`
- Record memory trace
- Stop

### Step 3: Enforce Boundaries (for execution requests)

For `create_payment_link` requests, validate against BOUNDARY.md:

| Field | Rule |
|---|---|
| `chain` | Must be in `specification.allowed_chains` (case-insensitive) |
| `token` | Must be in `specification.allowed_tokens` (case-insensitive) |
| `amount` | Must be ≤ `restrictions.max_single_payment` (if > 0) |

If ANY check fails:
- Return `{ "status": "rejected", "violation": "[field]", "policy": [allowed], "received": "[requested]" }`
- Record memory trace
- Stop

### Step 4: Execute via Sub-Agents

#### For `create_payment_link` (VALID):

**Sub-Agent 1 — Payment Creator:**

Spawn a sub-agent (`sessions_spawn`) with instructions to run:
```bash
npx tsx $RAILCLAW_SCRIPTS_DIR/generate-payment-link.ts \
  --chain "[chain]" \
  --token "[token]" \
  --amount [amount] \
  --wallet "[wallet from BOUNDARY.md]" \
  --business "[business name from BOUNDARY.md]" \
  --business-id "[business id from BOUNDARY.md]"
```

Parse JSON output. Return execution result to the calling agent.

**Sub-Agent 2 — Transaction Monitor:**

Spawn a second sub-agent (`sessions_spawn`) with instructions to run:
```bash
npx tsx $RAILCLAW_SCRIPTS_DIR/monitor-transaction.ts \
  --payment-id "[payment_id]" \
  --chain "[chain]" \
  --token "[token]" \
  --amount [amount] \
  --wallet "[wallet]" \
  --confirmations 20 \
  --timeout 3600 \
  --poll-interval 15
```

This runs in the background. When the monitor returns:
- If `success: true` → send confirmation to business-product agent via `sessions_send`
- If `success: false` → send timeout notification

#### For `check_payment`:

Read `$RAILCLAW_DATA_DIR/pending/{payment_id}.json`. Return the payment record.

#### For `list_payments`:

List files in `$RAILCLAW_DATA_DIR/pending/`. Read each, filter by criteria, return summary.

#### For `boundary_changed`:

Acknowledge the notification. Record the boundary change in memory. No further action needed — the orchestrator reads BOUNDARY.md fresh on every request.

### Step 5: Record Narrative Memory

After EVERY interaction, append to `memory/YYYY-MM-DD.md`:

```markdown
## [ISO timestamp]
- **Source**: [business-product | business-owner]
- **Request**: { action, amount, token, chain }
- **Boundary Version**: [version from BOUNDARY.md]
- **Decision**: VALID | INVALID | NOT_READY
- **Violation**: [if rejected: field and reason]
- **Execution**: [if valid: what was spawned]
- **Result**: [payment link / rejection / confirmation]
```

## Important Rules

- Scripts are at `$RAILCLAW_SCRIPTS_DIR/`
- Data is at `$RAILCLAW_DATA_DIR/` (wallets, pending payments, OTP)
- BOUNDARY.md is at workspace root (symlinked from shared)
- NEVER modify BOUNDARY.md — only business-owner writes to it
- ALWAYS read BOUNDARY.md fresh on every request (boundaries can change anytime)
- ALWAYS spawn sub-agents for execution (never run scripts directly in main session)
- ALWAYS record narrative memory after every decision
- Sub-agents are ephemeral — they execute one task and die
