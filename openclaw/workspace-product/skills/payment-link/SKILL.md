---
name: payment-link
description: "[DEPRECATED] Payment link generation is now handled by the Service Orchestrator via sub-agents."
user-invocable: false
metadata: {}
---

# Payment Link — Deprecated

Payment link generation has been moved to the **Service Orchestrator** agent.

This bot (business-product) no longer spawns sub-agents or runs scripts. Instead:
1. Parse the user's command
2. Send it to the orchestrator via `sessions_send`
3. The orchestrator spawns sub-agents for execution

Do NOT run `generate-payment-link.ts` from this agent.
