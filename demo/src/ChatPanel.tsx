import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import confetti from 'canvas-confetti'
import { useChat } from './useChat'
import type { Msg, ChatStatus } from './types'

// ── CSS class helpers ─────────────────────────────────────────────────────────

const STEP_CLASSES: Record<string, string> = {
  tool:   'step step-tool',
  spawn:  'step step-spawn',
  script: 'step step-script',
  done:   'step step-done',
  error:  'step step-error',
}

// ── Typewriter hook ───────────────────────────────────────────────────────────

const LEFT_HINTS = [
  'show my boundary',
  'enable polygon rail',
  'set max payment to $500',
  'add arbitrum as settlement chain',
  'enable bridge from solana',
  'show wallet address',
]

const RIGHT_HINTS = [
  'pay 0.01 USDC',
  'pay $5 via card',
  'pay 0.1 USDC on polygon',
  'pay 0.1 USDC from solana',
  'pay 50 USDC on arbitrum',
]

function useTypewriter(hints: string[]) {
  const [display, setDisplay] = useState('')
  const [hintIdx, setHintIdx] = useState(0)
  const [charIdx, setCharIdx] = useState(0)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    const target = hints[hintIdx]
    let timeout: ReturnType<typeof setTimeout>

    if (!deleting && charIdx < target.length) {
      timeout = setTimeout(() => setCharIdx(i => i + 1), 55)
    } else if (!deleting && charIdx === target.length) {
      timeout = setTimeout(() => setDeleting(true), 1800)
    } else if (deleting && charIdx > 0) {
      timeout = setTimeout(() => setCharIdx(i => i - 1), 28)
    } else {
      timeout = setTimeout(() => {
        setDeleting(false)
        setHintIdx(i => (i + 1) % hints.length)
      }, 300)
    }

    setDisplay(target.slice(0, charIdx))
    return () => clearTimeout(timeout)
  }, [charIdx, deleting, hintIdx, hints])

  return display
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyBtn({ text, display }: { text: string; display?: string }) {
  const [copied, setCopied] = useState(false)

  function copy(e: React.MouseEvent) {
    e.stopPropagation()
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <span className="copy-wrap">
      <span className="copy-text">{display ?? text}</span>
      <button className={`copy-btn${copied ? ' copy-btn-ok' : ''}`} onClick={copy} title="Copy">
        {copied ? '✓' : '⎘'}
      </button>
    </span>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function UserBubble({ text, ts }: { text: string; ts: number }) {
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="row row-user msg-enter" title={time}>
      <div className="row-avatar">👤</div>
      <div className="bubble bubble-user">{text}</div>
    </div>
  )
}

function AgentBubble({ text, streaming, side, ts }: { text: string; streaming: boolean; side: 'left' | 'right'; ts: number }) {
  const avatar = side === 'left' ? '🏛️' : '⚡'
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="row row-agent msg-enter" title={time}>
      <div className={`row-avatar row-avatar-${side}`}>{avatar}</div>
      <div className={`bubble bubble-agent bubble-agent-${side}`}>
        {text}
        {streaming && <span className="cursor" />}
      </div>
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <div className="thinking-wrap msg-enter">
      <div className="thinking-label">🧠 reasoning</div>
      <div className="thinking-blk">{text}<span className="cursor" /></div>
    </div>
  )
}

function StepCard({ msg }: { msg: Extract<Msg, { kind: 'step' }> }) {
  const cls = `${STEP_CLASSES[msg.stepKind] ?? 'step'}${msg.active ? ' step-active' : ''} msg-enter`
  return (
    <div className={cls}>
      <span className="step-icon">{msg.icon}</span>
      <div className="step-body">
        <div className="step-label">{msg.label}</div>
        {msg.body && <div className="step-text">{msg.body}</div>}
      </div>
    </div>
  )
}

function RailCard({ msg }: { msg: Extract<Msg, { kind: 'rail' }> }) {
  const isNano = msg.rail === 'nanopayment'
  const icon   = isNano ? '⚡' : '💳'
  const name   = isNano ? 'Circle Nanopayment (USDC)' : 'AgentCard Visa (Fiat)'
  return (
    <div className="rail-card msg-enter">
      <div className="rc-header">{icon} Rail selected: {name}</div>
      {msg.amount && (
        <div className="rc-row"><span className="rc-k">amount</span><span className="rc-v amount-val">{msg.amount}</span></div>
      )}
    </div>
  )
}

// ── Receipt row helper ─────────────────────────────────────────────────────────
function RR({ k, v, copy, amount }: { k: string; v?: string; copy?: boolean; amount?: boolean }) {
  if (!v) return null
  return (
    <div className="receipt-row">
      <span className="rk">{k}</span>
      <span className={`rv${amount ? ' amount-val' : ''}`}>
        {copy ? <CopyBtn text={v} display={v.length > 24 ? `${v.slice(0, 12)}…${v.slice(-8)}` : v} /> : v}
      </span>
    </div>
  )
}

function NanoReceipt({ msg }: { msg: Extract<Msg, { kind: 'nano-receipt' }> }) {
  return (
    <div className="receipt receipt-nano msg-enter">
      <div className="receipt-header">⚡ Nanopayment Complete</div>
      <hr className="receipt-divider" />
      <RR k="Rail"    v="Circle Gateway (gasless USDC)" />
      <RR k="Chain"   v={msg.chain} />
      <RR k="Service" v={msg.serviceUrl} />
      <RR k="Amount"  v={msg.amount ? `${msg.amount} USDC` : undefined} amount />
      <RR k="Mode"    v={msg.mode} />
      {msg.balanceBefore && <RR k="Balance before" v={msg.balanceBefore} />}
      {msg.balanceAfter  && <RR k="Balance after"  v={msg.balanceAfter} />}
      {msg.txHash && <RR k="Tx Hash" v={msg.txHash} copy />}
    </div>
  )
}

function CardReceipt({ msg }: { msg: Extract<Msg, { kind: 'card-receipt' }> }) {
  return (
    <div className="receipt receipt-card msg-enter">
      <div className="receipt-header">💳 Card Payment Complete</div>
      <hr className="receipt-divider" />
      <RR k="Rail"        v="AgentCard Visa (fiat)" />
      <RR k="Card"        v={msg.maskedPan} />
      <RR k="Expiry"      v={msg.expiry} />
      <RR k="Amount"      v={msg.amount ? `$${msg.amount} USD` : undefined} amount />
      {msg.fundedAmount && <RR k="Card limit"  v={msg.fundedAmount} />}
      <RR k="Remaining"   v={msg.balance} />
      <RR k="Status"      v={msg.chargeStatus ?? 'approved'} />
      <RR k="Mode"        v={msg.mode} />
      {msg.isNewCard      && <RR k="Note"    v="Newly provisioned ✦" />}
      {msg.description    && <RR k="Note"    v={msg.description} />}
      {msg.cardId         && <RR k="Card ID" v={msg.cardId} copy />}
    </div>
  )
}

function LinkReceipt({ msg }: { msg: Extract<Msg, { kind: 'link-receipt' }> }) {
  if (msg.confirmed) {
    const explorerBase: Record<string, string> = {
      polygon:  'https://polygonscan.com/tx',
      arbitrum: 'https://arbiscan.io/tx',
    }
    const explorer = explorerBase[msg.chain?.toLowerCase()] ?? 'https://polygonscan.com/tx'
    return (
      <div className="receipt receipt-link receipt-confirmed msg-enter">
        <div className="receipt-header">✅ Payment Confirmed</div>
        <hr className="receipt-divider" />
        <RR k="Payment"  v={msg.paymentId} copy />
        {msg.chain  && <RR k="Chain"  v={msg.chain} />}
        {msg.token  && <RR k="Token"  v={msg.token} />}
        {msg.amount && <RR k="Amount" v={`${msg.amount} USDC`} amount />}
        {msg.txHash && (
          <div className="receipt-row">
            <span className="rk">Tx Hash</span>
            <span className="rv">
              <CopyBtn text={msg.txHash} display={`${msg.txHash.slice(0, 10)}…${msg.txHash.slice(-8)}`} />
              {' '}
              <a className="rv-link" href={`${explorer}/${msg.txHash}`} target="_blank" rel="noopener noreferrer">↗</a>
            </span>
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="receipt receipt-link msg-enter">
      <div className="receipt-header">🔗 Payment Link Created</div>
      <hr className="receipt-divider" />
      <RR k="Payment"   v={msg.paymentId} copy />
      <RR k="Chain"     v={msg.chain} />
      <RR k="Token"     v={msg.token} />
      <RR k="Amount"    v={msg.amount} amount />
      <RR k="Recipient" v={msg.recipient} copy />
      {msg.expires && <RR k="Expires" v={msg.expires} />}
      {msg.link && (
        <div className="receipt-row" style={{ marginTop: 6 }}>
          <a className="receipt-link-url" href={msg.link} target="_blank" rel="noreferrer">{msg.link}</a>
        </div>
      )}
      <div className="receipt-monitor">⬤ Monitoring for incoming transaction</div>
    </div>
  )
}

function BridgeReceipt({ msg }: { msg: Extract<Msg, { kind: 'bridge-receipt' }> }) {
  if (msg.confirmed) {
    const explorerBase: Record<string, string> = {
      polygon:  'https://polygonscan.com/tx',
      arbitrum: 'https://arbiscan.io/tx',
    }
    const explorer = explorerBase[msg.settlementChain?.toLowerCase()] ?? 'https://polygonscan.com/tx'
    return (
      <div className="receipt receipt-bridge receipt-confirmed msg-enter">
        <div className="receipt-header">✅ Bridge Confirmed</div>
        <hr className="receipt-divider" />
        <RR k="Payment"    v={msg.paymentId} copy />
        <RR k="Settled on" v={msg.settlementChain} />
        {msg.txHash && (
          <div className="receipt-row">
            <span className="rk">Tx Hash</span>
            <span className="rv">
              <CopyBtn text={msg.txHash} display={`${msg.txHash.slice(0, 10)}…${msg.txHash.slice(-8)}`} />
              {' '}
              <a className="rv-link" href={`${explorer}/${msg.txHash}`} target="_blank" rel="noopener noreferrer">↗</a>
            </span>
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="receipt receipt-bridge msg-enter">
      <div className="receipt-header">🌉 Bridge Payment Initiated</div>
      <hr className="receipt-divider" />
      <RR k="Payment"    v={msg.paymentId} copy />
      <RR k="Send to"    v={msg.depositAddress} copy />
      <RR k="You send"   v={msg.amountToSend ? `${msg.amountToSend} USDC (Solana)` : undefined} amount />
      <RR k="Bridge fee" v={msg.relayFee ? `${msg.relayFee} USDC` : undefined} />
      <RR k="Receives"   v={msg.businessReceives ? `${msg.businessReceives} USDC on ${msg.settlementChain}` : undefined} amount />
      {msg.expires && <RR k="Expires" v={msg.expires} />}
      <div className="receipt-monitor">⬤ Monitoring Solana deposit</div>
    </div>
  )
}

function NotificationCard({ msg }: { msg: Extract<Msg, { kind: 'notification' }> }) {
  const icon = msg.event === 'payment_queued'    ? '📨'
             : msg.event === 'payment_received'  ? '✅'
             : msg.event === 'payment_confirmed' ? '🔒'
             : msg.event === 'link_created'      ? '🔗'
             : msg.rail  === 'bridge'            ? '🌉'
             : '💬'
  const d    = msg.details
  const s    = (k: string) => d[k] ? String(d[k]) : ''
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const txHash = s('tx_hash') || s('transaction')
  const chain  = s('chain') || s('settlement_chain')
  const wallet = s('wallet') || s('recipient')
  const link   = s('link')

  type Row = [string, string | JSX.Element, boolean?]
  const rows: Row[] = []

  if (s('payment_id'))  rows.push(['Reference',     s('payment_id').replace('pay_', '#')])
  if (s('amount'))      rows.push(['Amount',        `${s('amount')} ${s('token') || 'USDC'}`, true])
  if (s('method') || s('rail')) rows.push(['Method', s('method') || s('rail')])
  if (chain)            rows.push(['Network',       chain])
  if (s('maskedPan'))   rows.push(['Card',          s('maskedPan')])
  if (s('expiry'))      rows.push(['Expires',       s('expiry')])
  if (s('chargeStatus'))rows.push(['Charge status', s('chargeStatus')])
  if (s('balance'))     rows.push(['Remaining bal', s('balance')])
  if (s('balanceBefore') && s('balanceAfter'))
                        rows.push(['Gateway bal',   `${s('balanceBefore')} → ${s('balanceAfter')}`])
  if (s('mode') && s('mode') !== 'live')
                        rows.push(['Mode',          s('mode')])
  if (wallet)           rows.push(['Recipient',     `${wallet.slice(0, 8)}…${wallet.slice(-4)}`])
  if (link)             rows.push(['Payment link',  <a href={link} target="_blank" rel="noreferrer">{link.slice(0, 28)}…</a>])
  if (txHash)           rows.push(['Tx hash',       <CopyBtn text={txHash} display={`${txHash.slice(0, 14)}…`} />])

  return (
    <div className={`notif-card notif-${msg.event} msg-enter`}>
      <div className="notif-header">{icon} {msg.message} <span className="notif-time">{time}</span></div>
      {rows.length > 0 && (
        <table className="notif-table">
          <tbody>
            {rows.map(([label, val, isAmount]) => (
              <tr key={String(label)}>
                <td className="notif-label">{label}</td>
                <td className={`notif-val${isAmount ? ' amount-val' : ''}`}>{val}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function RejectedCard({ msg }: { msg: Extract<Msg, { kind: 'rejected' }> }) {
  return (
    <div className="receipt receipt-rejected msg-enter">
      <div className="receipt-header">✖ Payment Rejected</div>
      <hr className="receipt-divider" />
      <RR k="Violation" v={msg.violation} />
      <RR k="Policy"    v={msg.policy} />
      <RR k="Received"  v={msg.received} />
    </div>
  )
}

// ── Status strip with elapsed timer ──────────────────────────────────────────

function StatusStrip({ status, busy }: { status: ChatStatus; busy: boolean }) {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    if (busy) {
      startRef.current = Date.now()
      setElapsed(0)
      const timer = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current!) / 1000))
      }, 1000)
      return () => clearInterval(timer)
    } else {
      startRef.current = null
      setElapsed(0)
    }
  }, [busy])

  return (
    <div className="status-strip">
      <div className={`spip spip-${status.state}`} />
      <span>{status.text}</span>
      {status.state === 'idle' && <span className="strip-cursor">▋</span>}
      {busy && elapsed > 0 && <span className="strip-elapsed">{elapsed}s</span>}
    </div>
  )
}

// ── Thinking dots ─────────────────────────────────────────────────────────────

function ThinkingDots({ side }: { side: 'left' | 'right' }) {
  const avatar = side === 'left' ? '🏛️' : '⚡'
  return (
    <div className="thinking-row msg-enter">
      <div className={`row-avatar row-avatar-${side}`}>{avatar}</div>
      <div className="thinking-dots">
        <span /><span /><span />
      </div>
      <span className="thinking-label-sm">reasoning...</span>
    </div>
  )
}

// ── Empty state with typewriter ───────────────────────────────────────────────

function EmptyState({ side }: { side: 'left' | 'right' }) {
  const hints = side === 'left' ? LEFT_HINTS : RIGHT_HINTS
  const typed = useTypewriter(hints)

  if (side === 'left') {
    return (
      <div className="empty">
        <div className="empty-icon">🏛️</div>
        <div className="empty-title">Business owner panel</div>
        <p className="empty-body">
          Configure your payment rails &amp; boundaries.<br />
          <span className="empty-muted">Agent: <strong>business-owner</strong></span>
        </p>
        <div className="empty-typewriter">
          <span className="empty-prompt">$ </span>
          <span>{typed}</span>
          <span className="empty-caret">▋</span>
        </div>
      </div>
    )
  }
  return (
    <div className="empty">
      <div className="empty-icon">⚡</div>
      <div className="empty-title">Agent terminal</div>
      <p className="empty-body">
        Request payments — watch AI route &amp; execute in real-time.<br />
        <span className="empty-muted">Agent: <strong>business-product</strong> → <strong>orchestrator</strong></span>
      </p>
      <div className="empty-typewriter">
        <span className="empty-prompt">$ </span>
        <span>{typed}</span>
        <span className="empty-caret">▋</span>
      </div>
    </div>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface PanelProps {
  side: 'left' | 'right'
  title: string
  subtitle: string
  agentBadge: string
  avatar: string
  endpoint: string
  placeholder: string
}

const CONFIRMED_KINDS = new Set(['nano-receipt', 'card-receipt'])

function fireConfetti() {
  confetti({ particleCount: 90, spread: 70, origin: { y: 0.75 }, colors: ['#22c55e', '#3b82f6', '#a78bfa', '#f59e0b'] })
  setTimeout(() => confetti({ particleCount: 40, spread: 50, origin: { y: 0.75, x: 0.3 }, colors: ['#22c55e', '#34d399'] }), 200)
  setTimeout(() => confetti({ particleCount: 40, spread: 50, origin: { y: 0.75, x: 0.7 }, colors: ['#3b82f6', '#818cf8'] }), 350)
}

export function ChatPanel({ side, title, subtitle, agentBadge, avatar, endpoint, placeholder }: PanelProps) {
  const { messages, status, busy, send, clearHistory } = useChat(endpoint)
  const [input, setInput]             = useState('')
  const [hasSent, setHasSent]         = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const feedRef   = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)
  const prevLenRef = useRef(messages.length)

  // Auto-scroll on new messages (only if near bottom)
  useEffect(() => {
    const el = feedRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom || messages.length !== prevLenRef.current) {
      el.scrollTop = el.scrollHeight
    }
    prevLenRef.current = messages.length
  }, [messages])

  // Confetti on confirmed payments
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last) return
    if (
      CONFIRMED_KINDS.has(last.kind) ||
      (last.kind === 'link-receipt' && last.confirmed) ||
      (last.kind === 'bridge-receipt' && last.confirmed) ||
      (last.kind === 'notification' && (last.event === 'payment_received' || last.event === 'payment_confirmed'))
    ) {
      fireConfetti()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  // Cross-panel flash: when a spawn step is active in this panel
  const hasActiveSpawn = messages.some(m => m.kind === 'step' && m.stepKind === 'spawn' && m.active)

  function onFeedScroll() {
    const el = feedRef.current
    if (!el) return
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 80)
  }

  function scrollToBottom() {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
    setShowScrollBtn(false)
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleSend() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setHasSent(true)
    send(text)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const el = e.target
    setInput(el.value)
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  const now = useRef(Date.now())

  return (
    <div className={`panel panel-${side}${hasActiveSpawn ? ' panel-spawning' : ''}`}>
      {/* Header */}
      <div className="panel-header">
        <div className={`ph-avatar ph-avatar-${side}`}>{avatar}</div>
        <div className="ph-info">
          <div className="ph-title">{title}</div>
          <div className="ph-sub">{subtitle}</div>
        </div>
        <div className={`ph-badge ph-badge-${side}`}>{agentBadge}</div>
        {messages.length > 0 && (
          <button className="clear-btn" onClick={clearHistory} title="Clear history">✕</button>
        )}
      </div>

      {/* Status strip */}
      <StatusStrip status={status} busy={busy} />

      {/* Feed */}
      <div className="feed" ref={feedRef} onScroll={onFeedScroll}>
        {messages.length === 0 && <EmptyState side={side} />}

        {messages.map(msg => {
          const ts = (msg as { ts?: number }).ts ?? now.current
          if (msg.kind === 'user')           return <UserBubble    key={msg.id} text={msg.text} ts={ts} />
          if (msg.kind === 'agent')          return <AgentBubble   key={msg.id} text={msg.text} streaming={msg.streaming} side={side} ts={ts} />
          if (msg.kind === 'thinking')       return <ThinkingBlock key={msg.id} text={msg.text} />
          if (msg.kind === 'step')           return <StepCard      key={msg.id} msg={msg} />
          if (msg.kind === 'rail')           return <RailCard      key={msg.id} msg={msg} />
          if (msg.kind === 'nano-receipt')   return <NanoReceipt   key={msg.id} msg={msg} />
          if (msg.kind === 'card-receipt')   return <CardReceipt   key={msg.id} msg={msg} />
          if (msg.kind === 'link-receipt')   return <LinkReceipt   key={msg.id} msg={msg} />
          if (msg.kind === 'bridge-receipt') return <BridgeReceipt key={msg.id} msg={msg} />
          if (msg.kind === 'notification')   return <NotificationCard key={msg.id} msg={msg} />
          if (msg.kind === 'rejected')       return <RejectedCard  key={msg.id} msg={msg} />
          return null
        })}

        {busy && messages.length > 0 && status.state === 'thinking' && status.text === '🧠 thinking...' && (
          <ThinkingDots side={side} />
        )}
      </div>

      {/* Scroll to bottom button */}
      {showScrollBtn && (
        <button className={`scroll-to-bottom scroll-to-bottom-${side}`} onClick={scrollToBottom}>
          ↓
        </button>
      )}

      {/* Input */}
      <div className="input-area">
        <div className="input-row">
          <textarea
            ref={inputRef}
            className={`chat-input chat-input-${side}`}
            value={input}
            placeholder={placeholder}
            rows={1}
            onKeyDown={handleKey}
            onChange={handleInput}
            disabled={busy}
          />
          <button
            className={`send-btn send-btn-${side}`}
            onClick={handleSend}
            disabled={busy || !input.trim()}
          >
            ↑
          </button>
        </div>
        {!hasSent && (
          <div className="input-hint">Enter to send · Shift+Enter for newline</div>
        )}
      </div>
    </div>
  )
}
