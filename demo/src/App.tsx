import { useEffect, useState } from 'react'
import { ChatPanel } from './ChatPanel'

interface Health { ok: boolean; openclawToken: boolean; sellerAddress: string | null }

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false, openclawToken: false, sellerAddress: null }))
  }, [])

  const dotClass = health === null
    ? 'health-dot'
    : health.ok && health.openclawToken
      ? 'health-dot health-dot-live'
      : 'health-dot health-dot-dead'

  const dotText = health === null
    ? 'connecting...'
    : health.ok && health.openclawToken
      ? 'Railclaw live'
      : health?.openclawToken ? 'gateway error' : 'token missing — run setup.sh'

  return (
    <>
      <header>
        <div className="logo-wrap">
          <img src="/logo.jpg" alt="Railclaw" className="logo-img" />
          <span className="logo">Railclaw</span>
        </div>
        <span className="tag">Cloudflare for Payments</span>
        <div className="agent-nodes">
          <div className="agent-node agent-node-blue">
            <span className="agent-node-dot" />
            <span>business-owner</span>
          </div>
          <div className="agent-node-arrow">→</div>
          <div className="agent-node agent-node-green">
            <span className="agent-node-dot" />
            <span>business-product</span>
          </div>
          <div className="agent-node-arrow">→</div>
          <div className="agent-node agent-node-purple">
            <span className="agent-node-dot" />
            <span>orchestrator</span>
          </div>
        </div>
        <div className="header-divider" />
        <div className="health">
          <div className={dotClass} />
          <span>{dotText}</span>
        </div>
      </header>

      <div className="panels">
        <ChatPanel
          side="left"
          title="Business Owner"
          subtitle="Configure payment rails & boundaries"
          agentBadge="business-owner"
          avatar="🏛️"
          endpoint="/api/chat/owner"
          placeholder="Enable nanopayment rail, show my boundary, add Polygon..."
        />
        <ChatPanel
          side="right"
          title="Agent Terminal"
          subtitle="Request payments — watch AI route & execute"
          agentBadge="business-product"
          avatar="⚡"
          endpoint="/api/chat/product"
          placeholder="pay 0.01 USDC · pay $5 · pay 0.1 USDC on polygon · pay 0.1 USDC from solana"
        />
      </div>
    </>
  )
}
