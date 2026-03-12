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
      ? 'OpenClaw live'
      : health?.openclawToken ? 'gateway error' : 'token missing — run setup.sh'

  return (
    <>
      <header>
        <span className="logo">⚡ Railclaw</span>
        <span className="tag">Dynamic Payment Rails</span>
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
          avatar="🏢"
          endpoint="/api/chat/owner"
          placeholder="Enable nanopayment rail, show my boundary, add Polygon..."
        />
        <ChatPanel
          side="right"
          title="Agent Terminal"
          subtitle="Request payments — watch AI route & execute"
          agentBadge="business-product"
          avatar="🤖"
          endpoint="/api/chat/product"
          placeholder="I want to receive 5 USDC on Polygon..."
        />
      </div>
    </>
  )
}
