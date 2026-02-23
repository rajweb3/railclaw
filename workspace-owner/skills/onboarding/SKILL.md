---
name: onboarding
description: Business onboarding — email verification, OTP, wallet creation.
user-invocable: true
metadata: {}
---

# Business Onboarding

Handles the complete onboarding flow. See AGENTS.md for the full step-by-step procedure.

## Script Paths (inside container)

```bash
# Step 2: Send OTP
npx tsx $RAILCLAW_SCRIPTS_DIR/send-otp.ts --email "EMAIL"

# Step 3: Verify OTP
npx tsx $RAILCLAW_SCRIPTS_DIR/verify-otp.ts --email "EMAIL" --code "CODE"

# Step 4: Create wallet
npx tsx $RAILCLAW_SCRIPTS_DIR/create-wallet.ts --email "EMAIL"
```

## Flow Summary

1. Ask email → validate format
2. Send OTP → `send-otp.ts` → SES email
3. Verify OTP → `verify-otp.ts` → 3 attempts, 5-min expiry
4. Create wallet → `create-wallet.ts` → encrypted keystore
5. Update BOUNDARY.md → set business info + status: active
6. Confirm → show wallet address + next steps
