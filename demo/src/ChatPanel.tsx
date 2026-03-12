import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
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

// ── Sub-components ────────────────────────────────────────────────────────────

function UserBubble({ text }: { text: string }) {
  return (
    <div className="row row-user">
      <div className="row-avatar">👤</div>
      <div className="bubble bubble-user">{text}</div>
    </div>
  )
}

function AgentBubble({ text, streaming, side }: { text: string; streaming: boolean; side: 'left' | 'right' }) {
  const avatar = side === 'left' ? '🏢' : '🤖'
  return (
    <div className="row row-agent">
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
    <div className="thinking-wrap">
      <div className="thinking-label">🧠 reasoning</div>
      <div className="thinking-blk">{text}<span className="cursor" /></div>
    </div>
  )
}

function StepCard({ msg }: { msg: Extract<Msg, { kind: 'step' }> }) {
  const cls = `${STEP_CLASSES[msg.stepKind] ?? 'step'}${msg.active ? ' step-active' : ''}`
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
    <div className="rail-card">
      <div className="rc-header">{icon} Rail selected: {name}</div>
      {msg.amount && (
        <div className="rc-row"><span className="rc-k">amount</span><span className="rc-v">{msg.amount}</span></div>
      )}
    </div>
  )
}

function StatusStrip({ status }: { status: ChatStatus }) {
  return (
    <div className="status-strip">
      <div className={`spip spip-${status.state}`} />
      <span>{status.text}</span>
    </div>
  )
}

function ThinkingDots({ side }: { side: 'left' | 'right' }) {
  const avatar = side === 'left' ? '🏢' : '🤖'
  return (
    <div className="thinking-row">
      <div className={`row-avatar row-avatar-${side}`}>{avatar}</div>
      <div className="thinking-dots">
        <span /><span /><span />
      </div>
      <span className="thinking-label-sm">reasoning...</span>
    </div>
  )
}

function EmptyState({ side }: { side: 'left' | 'right' }) {
  if (side === 'left') {
    return (
      <div className="empty">
        <div className="empty-icon">🏢</div>
        <div className="empty-title">Business owner panel</div>
        <p className="empty-body">
          Type natural language commands to configure your business.<br />
          <span className="empty-muted">Routes through the <strong>business-owner</strong> OpenClaw agent.</span>
        </p>
      </div>
    )
  }
  return (
    <div className="empty">
      <div className="empty-icon">🤖</div>
      <div className="empty-title">Agent terminal</div>
      <p className="empty-body">
        Type payment requests — watch the AI route &amp; execute in real-time.<br />
        <span className="empty-muted">Routes through the <strong>business-product</strong> OpenClaw agent.</span>
      </p>
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

export function ChatPanel({ side, title, subtitle, agentBadge, avatar, endpoint, placeholder }: PanelProps) {
  const { messages, status, busy, send, clearHistory } = useChat(endpoint)
  const [input, setInput] = useState('')
  const feedRef   = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll on new messages
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

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
    send(text)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  // Auto-grow textarea
  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const el = e.target
    setInput(el.value)
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  return (
    <div className={`panel panel-${side}`}>
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
      <StatusStrip status={status} />

      {/* Feed */}
      <div className="feed" ref={feedRef}>
        {messages.length === 0 && <EmptyState side={side} />}

        {messages.map(msg => {
          if (msg.kind === 'user')     return <UserBubble  key={msg.id} text={msg.text} />
          if (msg.kind === 'agent')    return <AgentBubble key={msg.id} text={msg.text} streaming={msg.streaming} side={side} />
          if (msg.kind === 'thinking') return <ThinkingBlock key={msg.id} text={msg.text} />
          if (msg.kind === 'step')     return <StepCard   key={msg.id} msg={msg} />
          if (msg.kind === 'rail')     return <RailCard   key={msg.id} msg={msg} />
          return null
        })}

        {busy && messages.length > 0 && status.state === 'thinking' && status.text === '🧠 thinking...' && (
          <ThinkingDots side={side} />
        )}
      </div>

      {/* Input */}
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
          Send
        </button>
      </div>
    </div>
  )
}
