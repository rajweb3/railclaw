# Business Bot — Tools Guide

## Script Execution

All scripts are in the shared scripts directory. Run via:
```bash
npx tsx $RAILCLAW_SCRIPTS_DIR/<script>.ts [arguments]
```

| Script | Purpose |
|---|---|
| `send-otp.ts` | Send OTP email |
| `verify-otp.ts` | Verify OTP code |
| `create-wallet.ts` | Generate + encrypt wallet |

## File Operations

- BOUNDARY.md is at the workspace root (shared between bots)
- Read it before any operation
- Only the boundary-manager skill modifies it

## Skills

| Skill | Invocation | Purpose |
|---|---|---|
| onboarding | `/onboard` | Business onboarding flow |
| boundary-manager | `/boundary` | CRUD boundary definitions |
| wallet-manager | `/wallet` | View wallet info |
