---
name: tx-monitor
description: "[DEPRECATED] Transaction monitoring is now handled by the Service Orchestrator via sub-agents."
user-invocable: false
metadata: {}
---

# Transaction Monitor — Deprecated

Transaction monitoring has been moved to the **Service Orchestrator** agent.

This bot (business-product) no longer spawns monitoring sub-agents. Instead:
- The orchestrator spawns tx-monitor sub-agents automatically after payment link creation
- When a transaction is confirmed, the orchestrator returns the result in the spawned session
- This bot formats the confirmation and displays it to the user
