# Railclaw — Multi-Agent Architecture

## System Overview

![System Overview](docs/architecture/01-system-overview.png)

<details>
<summary>Mermaid source</summary>

```mermaid
graph TB
    subgraph Telegram
        BOT1["@railclaw_biz_bot<br/>(Business Owner)"]
        BOT2["@railclaw_product_bot<br/>(Business Users)"]
    end

    subgraph GW["OpenClaw Gateway :18789"]
        ROUTER["Binding Router"]
        ROUTER -->|"account: owner"| AGENT1
        ROUTER -->|"account: product"| AGENT2

        subgraph AGENT1["Agent: business-owner"]
            SOUL1["SOUL.md<br/>Onboarding + Boundaries"]
            SK1["Skills:<br/>onboarding<br/>boundary-manager<br/>wallet-manager"]
            MEM1["memory/"]
        end

        subgraph AGENT2["Agent: business-product"]
            SOUL2["SOUL.md<br/>Command Parser + Display"]
            SK2["Skills:<br/>command-parser"]
            MEM2["memory/"]
        end

        subgraph ORCH["Agent: orchestrator<br/>(Service Orchestrator)"]
            SOUL3["SOUL.md<br/>Boundary Enforcement Engine"]
            SK3["Skills:<br/>boundary-enforcer<br/>payment-executor<br/>tx-monitor"]
            MEM3["memory/"]
        end

        AGENT2 -->|"sessions_send<br/>parsed commands"| ORCH
        ORCH -->|"sessions_send<br/>results + events"| AGENT2
        AGENT1 -->|"sessions_send<br/>boundary_changed"| ORCH
    end

    subgraph SUB["Sub-Agents (Ephemeral)"]
        SA1["Payment Creator<br/>generate-payment-link.ts"]
        SA2["TX Monitor<br/>monitor-transaction.ts"]
    end

    subgraph SHARED["Shared Resources"]
        BOUNDARY["BOUNDARY.md<br/>(single source of truth)"]
        SCRIPTS["Scripts<br/>send-otp · verify-otp<br/>create-wallet · generate-link<br/>monitor-tx · check-confirm"]
        DATA["Data<br/>wallets/ · pending/ · otp/"]
    end

    BOT1 --> ROUTER
    BOT2 --> ROUTER
    AGENT1 -->|"read-write"| BOUNDARY
    ORCH -->|"read-only"| BOUNDARY
    ORCH -->|"sessions_spawn"| SA1
    ORCH -->|"sessions_spawn"| SA2
    AGENT1 --> SCRIPTS
    SA1 --> SCRIPTS
    SA2 --> SCRIPTS
    AGENT1 --> DATA
    SA1 --> DATA
    SA2 --> DATA

    SCRIPTS -->|"send-otp.ts"| SES["AWS SES"]
    SCRIPTS -->|"monitor-tx.ts"| RPC["Blockchain RPCs"]
    SCRIPTS -->|"create-wallet.ts"| DATA
```

</details>

## Three-Agent Model

![Three-Agent Model](docs/architecture/02-three-agent-model.png)

<details>
<summary>Mermaid source</summary>

```mermaid
graph LR
    subgraph FRONT["Front-Facing (Telegram)"]
        OW["business-owner<br/>Onboarding + Boundaries"]
        PR["business-product<br/>Command Parsing + Display"]
    end

    subgraph CORE["Core Engine (Internal)"]
        OR["orchestrator<br/>Boundary Enforcement<br/>+ Execution Coordination"]
    end

    subgraph EXEC["Execution (Ephemeral)"]
        S1["Sub-Agent 1<br/>Payment Creator"]
        S2["Sub-Agent 2<br/>TX Monitor"]
    end

    OW -->|"boundary_changed"| OR
    PR -->|"parsed command"| OR
    OR -->|"result / events"| PR
    OR -->|"sessions_spawn"| S1
    OR -->|"sessions_spawn"| S2
    S1 -->|"payment link"| OR
    S2 -->|"tx confirmed"| OR
```

</details>

## Business Onboarding Flow

![Onboarding Flow](docs/architecture/03-onboarding-flow.png)

<details>
<summary>Mermaid source</summary>

```mermaid
sequenceDiagram
    actor Owner as Business Owner
    participant Bot as @railclaw_biz_bot
    participant Agent as Agent: business-owner
    participant Script as Scripts
    participant SES as AWS SES
    participant Store as data/wallets/
    participant Orch as Agent: orchestrator

    Owner->>Bot: /onboard
    Bot->>Agent: Route via binding
    Agent->>Agent: Read BOUNDARY.md<br/>status: pending_onboarding

    Agent->>Owner: ONBOARDING Step 1/5<br/>Provide your business email

    Owner->>Agent: user@business.com
    Agent->>Script: exec: send-otp.ts --email user@business.com
    Script->>SES: Send OTP email
    SES-->>Owner: Email with 6-digit code
    Script-->>Agent: { success: true, expires_in: 300 }

    Agent->>Owner: ONBOARDING Step 2/5<br/>Enter the 6-digit code

    Owner->>Agent: 482910
    Agent->>Script: exec: verify-otp.ts --email ... --code 482910
    Script-->>Agent: { valid: true }

    Agent->>Script: exec: create-wallet.ts --email ...
    Script->>Store: Encrypted keystore (AES-256-GCM)
    Script-->>Agent: { address: 0xABC..., business_id: biz_a1b2 }

    Agent->>Agent: Write BOUNDARY.md<br/>status: active<br/>wallet: 0xABC...

    Agent->>Orch: sessions_send: boundary_changed (v1)

    Agent->>Owner: ONBOARDED<br/>Wallet: 0xABC...<br/>Next: /boundary to configure
```

</details>

## Payment Command Flow (via Orchestrator)

![Payment Command Flow](docs/architecture/04-payment-command-flow.png)

<details>
<summary>Mermaid source</summary>

```mermaid
sequenceDiagram
    actor User as Business User
    participant Bot as @railclaw_product_bot
    participant Product as Agent: business-product
    participant Orch as Agent: orchestrator
    participant SA1 as Sub-Agent 1<br/>(Payment Creator)
    participant SA2 as Sub-Agent 2<br/>(TX Monitor)
    participant Chain as Blockchain RPC

    User->>Bot: Create payment link<br/>for 100 USDC on Polygon
    Bot->>Product: Route via binding

    Note over Product: STEP 1: Parse Command
    Product->>Product: { action: create_payment_link<br/>amount: 100, token: USDC<br/>chain: polygon }

    Note over Product: STEP 2: Delegate to Orchestrator
    Product->>Orch: sessions_send:<br/>{ source: business-product<br/>action: create_payment_link<br/>amount: 100, token: USDC, chain: polygon }

    Note over Orch: STEP 3: Enforce Boundaries
    Orch->>Orch: Read BOUNDARY.md<br/>✓ polygon ∈ allowed_chains<br/>✓ USDC ∈ allowed_tokens<br/>✓ 100 ≤ max_single_payment<br/>DECISION: VALID

    Note over Orch: STEP 4: Spawn Sub-Agent
    Orch->>SA1: sessions_spawn
    SA1->>SA1: exec: generate-payment-link.ts
    SA1->>SA1: Create data/pending/pay_xxx.json
    SA1-->>Orch: { link: pay.railclaw.io/p/pay_xxx }
    Note over SA1: KILLED

    Note over Orch: STEP 5: Return Result
    Orch-->>Product: { status: executed, link: pay.railclaw.io/p/pay_xxx }
    Product->>User: EXECUTED<br/>Link: pay.railclaw.io/p/pay_xxx

    Note over Orch: STEP 6: Monitor (Background)
    Orch->>SA2: sessions_spawn
    loop Every 15 seconds
        SA2->>Chain: Check Transfer events<br/>to wallet 0xABC...
        Chain-->>SA2: No match yet
    end

    Note over Chain: Payer pays via link

    SA2->>Chain: Check Transfer events
    Chain-->>SA2: TX found: 0xdef...

    loop Wait for confirmations
        SA2->>Chain: getBlockNumber()
        Chain-->>SA2: confirmations: 20 ✓
    end

    SA2->>SA2: Update pay_xxx.json<br/>status: confirmed
    SA2-->>Orch: { tx_hash: 0xdef..., confirmations: 20 }
    Note over SA2: KILLED

    Note over Orch: STEP 7: Narrative Memory
    Orch->>Orch: Append to memory/YYYY-MM-DD.md

    Orch->>Product: sessions_send: tx_confirmed
    Product->>User: CONFIRMED<br/>TxHash: 0xdef...<br/>100 USDC on Polygon
```

</details>

## Boundary Rejection Flow (via Orchestrator)

![Boundary Rejection](docs/architecture/05-boundary-rejection.png)

<details>
<summary>Mermaid source</summary>

```mermaid
sequenceDiagram
    actor User as Business User
    participant Product as Agent: business-product
    participant Orch as Agent: orchestrator

    User->>Product: Create payment link<br/>for 100 USDC on Solana

    Product->>Product: Parse: chain=solana
    Product->>Orch: sessions_send:<br/>{ action: create_payment_link, chain: solana }

    Orch->>Orch: Read BOUNDARY.md<br/>allowed_chains: [polygon]
    Orch->>Orch: solana ∉ [polygon]<br/>DECISION: INVALID

    Orch->>Orch: Write memory trace

    Orch-->>Product: { status: rejected,<br/>violation: chain,<br/>policy: [polygon], received: solana }

    Product->>User: REJECTED<br/>Violation: chain<br/>Policy: [polygon]<br/>Received: solana
```

</details>

## Boundary Change = Immediate Effect

![Boundary Change](docs/architecture/06-boundary-change.png)

<details>
<summary>Mermaid source</summary>

```mermaid
sequenceDiagram
    actor Owner as Business Owner
    actor User as Business User
    participant OBot as @railclaw_biz_bot
    participant PBot as @railclaw_product_bot
    participant Orch as Agent: orchestrator
    participant B as BOUNDARY.md

    Note over B: v2: allowed_chains: [polygon]

    User->>PBot: 100 USDC on Solana
    PBot->>Orch: sessions_send: create_payment_link
    Orch->>B: Read
    Orch->>PBot: REJECTED (solana not allowed)
    PBot->>User: REJECTED

    Owner->>OBot: /boundary set-chain add solana
    OBot->>B: Write v3: [polygon, solana]
    OBot->>Orch: sessions_send: boundary_changed (v3)
    OBot->>Owner: BOUNDARY UPDATED (v2 → v3)

    User->>PBot: 100 USDC on Solana
    PBot->>Orch: sessions_send: create_payment_link
    Orch->>B: Read
    Orch->>PBot: EXECUTED ✓ (solana allowed now)
    PBot->>User: EXECUTED ✓
```

</details>

## Workspace Layout

![Workspace Layout](docs/architecture/07-workspace-layout.png)

<details>
<summary>Mermaid source</summary>

```mermaid
graph LR
    subgraph HOME["~/.openclaw/"]
        CONFIG["openclaw.json<br/>3 agents + 2 telegram bots"]

        subgraph WO["workspace-owner/"]
            WO_SOUL["SOUL.md"]
            WO_AGENTS["AGENTS.md"]
            WO_SKILLS["skills/<br/>onboarding/<br/>boundary-manager/<br/>wallet-manager/"]
            WO_MEM["memory/"]
            WO_BOUND["BOUNDARY.md"]
        end

        subgraph WP["workspace-product/"]
            WP_SOUL["SOUL.md"]
            WP_AGENTS["AGENTS.md"]
            WP_SKILLS["skills/<br/>command-parser/"]
            WP_MEM["memory/"]
        end

        subgraph WORCH["workspace-orchestrator/"]
            WORCH_SOUL["SOUL.md"]
            WORCH_AGENTS["AGENTS.md"]
            WORCH_SKILLS["skills/<br/>boundary-enforcer/<br/>payment-executor/<br/>tx-monitor/"]
            WORCH_MEM["memory/"]
            WORCH_BOUND["BOUNDARY.md"]
        end
    end

    subgraph SHARED["shared/ (in repo)"]
        S_BOUND["BOUNDARY.md"]
        S_SCRIPTS["scripts/<br/>6 TypeScript files"]
        S_DATA["data/<br/>wallets/ pending/ otp/"]
    end

    WO_BOUND -.->|symlink| S_BOUND
    WORCH_BOUND -.->|symlink| S_BOUND
    WO_SKILLS -.->|symlink| REPO_OW["repo/workspace-owner/skills/"]
    WP_SKILLS -.->|symlink| REPO_PD["repo/workspace-product/skills/"]
    WORCH_SKILLS -.->|symlink| REPO_OR["repo/workspace-orchestrator/skills/"]
```

</details>
