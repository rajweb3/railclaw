---
name: boundary-enforcer
description: "[DEPRECATED] Boundary enforcement is now handled by the Service Orchestrator. This bot delegates to the orchestrator."
user-invocable: false
metadata: {}
---

# Boundary Enforcer — Deprecated

Boundary enforcement has been moved to the **Service Orchestrator** agent.

This bot (business-product) no longer checks boundaries directly. Instead:
1. Parse the user's command
2. Send it to the orchestrator via `sessions_send`
3. The orchestrator enforces boundaries and returns the result

Do NOT perform boundary checks in this agent.
