import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { Msg, ChatStatus, StepKind, StatusState } from './types'

// ── State ────────────────────────────────────────────────────────────────────

interface State {
  messages: Msg[]
  status: ChatStatus
  busy: boolean
}

type Action =
  | { type: 'ADD_MSG';         msg: Msg }
  | { type: 'APPEND_AGENT';    id: string; chunk: string }
  | { type: 'FINISH_AGENT';    id: string }
  | { type: 'APPEND_THINKING'; id: string; chunk: string }
  | { type: 'SETTLE_STEP';     id: string; stepKind?: StepKind; body?: string }
  | { type: 'SET_STATUS';      status: ChatStatus }
  | { type: 'SET_BUSY';        busy: boolean }
  | { type: 'CLEAR' }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'ADD_MSG':
      return { ...state, messages: [...state.messages, action.msg] }
    case 'APPEND_AGENT':
      return {
        ...state,
        messages: state.messages.map(m =>
          m.id === action.id && m.kind === 'agent'
            ? { ...m, text: m.text + action.chunk }
            : m,
        ),
      }
    case 'FINISH_AGENT':
      return {
        ...state,
        messages: state.messages.map(m =>
          m.id === action.id && m.kind === 'agent' ? { ...m, streaming: false } : m,
        ),
      }
    case 'APPEND_THINKING':
      return {
        ...state,
        messages: state.messages.map(m =>
          m.id === action.id && m.kind === 'thinking'
            ? { ...m, text: m.text + action.chunk }
            : m,
        ),
      }
    case 'SETTLE_STEP':
      return {
        ...state,
        messages: state.messages.map(m =>
          m.id === action.id && m.kind === 'step'
            ? {
                ...m,
                active: false,
                ...(action.stepKind ? { stepKind: action.stepKind } : {}),
                ...(action.body !== undefined ? { body: action.body } : {}),
              }
            : m,
        ),
      }
    case 'SET_STATUS':
      return { ...state, status: action.status }
    case 'SET_BUSY':
      return { ...state, busy: action.busy }
    case 'CLEAR':
      return { messages: [], status: { state: 'idle', text: 'idle' }, busy: false }
  }
}

// ── SSE parser ────────────────────────────────────────────────────────────────

interface SSEEvent { event: string | null; data: Record<string, unknown> }

function parseSSE(raw: string): SSEEvent[] {
  const events: SSEEvent[] = []
  let curEvent: string | null = null
  let curData = ''
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: '))      curEvent = line.slice(7).trim()
    else if (line.startsWith('data: '))  curData  = line.slice(6).trim()
    else if (line === '' && (curEvent || curData)) {
      if (curData && curData !== '[DONE]') {
        try { events.push({ event: curEvent, data: JSON.parse(curData) }) } catch { /* skip */ }
      }
      curEvent = null; curData = ''
    }
  }
  return events
}

// ── Payment result parser ─────────────────────────────────────────────────────
// Parses the product bot's formatted text output into structured receipt Msgs.

function g(text: string, pattern: RegExp): string {
  return text.match(pattern)?.[1]?.trim() ?? ''
}

function parsePaymentResult(text: string, id: string): Msg | null {
  if (text.includes('NANOPAYMENT COMPLETE')) {
    return {
      id, kind: 'nano-receipt',
      chain:         g(text, /Chain:\s*(.+)/),
      serviceUrl:    g(text, /Service:\s*(.+)/),
      amount:        g(text, /Amount:\s*([0-9.]+)/),
      mode:          g(text, /Mode:\s*(live|simulation)/i) || 'live',
      balanceBefore: g(text, /[Bb]alance before:\s*(.+)/) || undefined,
      balanceAfter:  g(text, /[Bb]alance after:\s*(.+)/)  || undefined,
    }
  }
  if (text.includes('CARD PAYMENT COMPLETE')) {
    return {
      id, kind: 'card-receipt',
      maskedPan:    g(text, /Card:\s*(.+)/),
      expiry:       g(text, /Expiry:\s*(.+)/),
      amount:       g(text, /Amount:\s*\$?([0-9.]+)/),
      balance:      g(text, /(?:Remaining|Balance):\s*(.+)/),
      mode:         g(text, /Mode:\s*(live|sandbox|simulation)/i) || 'sandbox',
      chargeStatus: g(text, /Status:\s*(.+)/) || undefined,
      cardId:       g(text, /Card ID:\s*(.+)/) || undefined,
      description:  g(text, /Note:\s*(.+)/) || undefined,
      fundedAmount: g(text, /Card limit:\s*(.+)/) || undefined,
      isNewCard:    text.includes('Newly provisioned'),
    }
  }
  if (text.includes('EXECUTED') && text.includes('Payment:')) {
    return {
      id, kind: 'link-receipt',
      paymentId: g(text, /Payment:\s*(pay_\S+)/),
      link:      g(text, /Link:\s*(https?:\/\/\S+)/),
      chain:     g(text, /Chain:\s*(\w+)/),
      token:     g(text, /Token:\s*(\w+)/),
      amount:    g(text, /Amount:\s*([0-9.]+)/),
      recipient: g(text, /Recipient:\s*(.+)/),
      expires:   g(text, /Expires:\s*(.+)/) || undefined,
    }
  }
  if (text.includes('BRIDGE PAYMENT') && text.includes('Payment:')) {
    return {
      id, kind: 'bridge-receipt',
      paymentId:        g(text, /Payment:\s*(pay_\S+)/),
      depositAddress:   g(text, /Address:\s*(\S+)/),
      amountToSend:     g(text, /You send:\s*([0-9.]+)/),
      relayFee:         g(text, /Bridge fee:\s*([0-9.]+)/),
      businessReceives: g(text, /Requested:\s*([0-9.]+)/),
      settlementChain:  g(text, /The business receives [0-9.]+ USDC on (\w+)/),
      expires:          g(text, /Expires:\s*(.+)/) || undefined,
    }
  }
  if (text.includes('REJECTED') && text.includes('Violation:')) {
    return {
      id, kind: 'rejected',
      violation: g(text, /Violation:\s*(.+)/),
      policy:    g(text, /Policy:\s*(.+)/),
      received:  g(text, /Received:\s*(.+)/),
    }
  }
  // Fallback: orchestrator-style markdown table or bullet points
  const hasNanopaySuccess = /nanopayment/i.test(text) && /success|HTTP.*200|200/i.test(text)
  const balanceFlow = text.match(/[Bb]alance\s+[Ff]low[:\s]*([0-9.]+)\s*[→\-]+\s*([0-9.]+)/)
  if (hasNanopaySuccess) {
    const chainMatch = text.match(/arcTestnet|polygon|arbitrum|base/i)
    const amountMatch = text.match(/[Aa]mount[|\s:*]+([0-9.]+)/)
    return {
      id, kind: 'nano-receipt',
      chain:         chainMatch ? chainMatch[0] : 'arcTestnet',
      serviceUrl:    'http://localhost:3100/api/service/premium',
      amount:        amountMatch ? amountMatch[1] : '0.1',
      mode:          'live',
      balanceBefore: balanceFlow ? `${balanceFlow[1]} USDC` : undefined,
      balanceAfter:  balanceFlow ? `${balanceFlow[2]} USDC` : undefined,
    }
  }
  return null
}

function detectTool(text: string): 'spawn' | 'script' | 'boundary' | null {
  if (text.includes('sessions_spawn') || text.includes('spawning')) return 'spawn'
  if (text.includes('npx tsx') || text.includes('nanopayment.ts') || text.includes('agent-card-payment.ts')) return 'script'
  if (text.includes('BOUNDARY.md') || text.includes('boundary')) return 'boundary'
  return null
}

// ── Persistence ───────────────────────────────────────────────────────────────

function storageKey(endpoint: string) {
  return `railclaw:chat:${endpoint.replace(/\W/g, '_')}`
}

function loadMessages(endpoint: string): Msg[] {
  try {
    const raw = localStorage.getItem(storageKey(endpoint))
    if (!raw) return []
    const msgs = JSON.parse(raw) as Msg[]
    // Finalize any items that were mid-stream when page was closed
    return msgs.map(m => {
      if (m.kind === 'agent' && m.streaming) return { ...m, streaming: false }
      if (m.kind === 'step'  && m.active)    return { ...m, active: false }
      return m
    })
  } catch {
    return []
  }
}

function saveMessages(endpoint: string, messages: Msg[]) {
  try {
    localStorage.setItem(storageKey(endpoint), JSON.stringify(messages))
  } catch { /* storage full — ignore */ }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

let _idSeq = 0
const uid = () => `m${++_idSeq}`

export function useChat(endpoint: string) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    messages: loadMessages(endpoint),
    status: { state: 'idle' as const, text: 'idle' },
    busy: false,
  }))

  // Persist messages to localStorage whenever they change
  useEffect(() => {
    saveMessages(endpoint, state.messages)
  }, [endpoint, state.messages])

  // ── Owner panel: poll for payment notifications ────────────────────────────
  const notifSinceRef = useRef<string>('')
  const unreadRef     = useRef(0)
  useEffect(() => {
    if (!endpoint.includes('owner')) return

    function onVisible() {
      if (!document.hidden) {
        unreadRef.current = 0
        document.title = 'Railclaw'
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    const timer = setInterval(async () => {
      try {
        const url = notifSinceRef.current
          ? `/api/notifications?since=${encodeURIComponent(notifSinceRef.current)}`
          : '/api/notifications'
        const res  = await fetch(url)
        const data = await res.json() as { notifications: Array<Record<string, unknown>> }
        if (data.notifications?.length) {
          notifSinceRef.current = data.notifications[data.notifications.length - 1].timestamp as string
          for (const n of data.notifications) {
            dispatch({ type: 'ADD_MSG', msg: {
              id:        uid(),
              kind:      'notification',
              rail:      String(n.rail ?? ''),
              event:     String(n.event ?? ''),
              message:   String(n.message ?? ''),
              timestamp: String(n.timestamp ?? new Date().toISOString()),
              details:   (n.details ?? {}) as Record<string, unknown>,
            }})
          }
          if (document.hidden) {
            unreadRef.current += data.notifications.length
            document.title = `(${unreadRef.current}) Railclaw`
          }
        }
      } catch { /* ignore network blips */ }
    }, 5000)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [endpoint])

  // Track in-flight streaming IDs via ref (stable across renders)
  const streamRef = useRef({
    agentId:      null as string | null,
    agentText:    '',                      // accumulated full text for receipt parsing
    thinkingId:   null as string | null,
    spawnId:      null as string | null,
    scriptId:     null as string | null,
    inThinking:   false,
    toolShown:    new Set<string>(),
    pollingTimer: null as ReturnType<typeof setInterval> | null,
  })

  // ── Receipt from JSON (used by both polling and output-array parsing) ─────────
  function receiptFromJSON(p: Record<string, unknown>): Msg | null {
    const scriptOut = (p.script_output ?? p) as Record<string, unknown>
    const rail   = String(p.rail ?? scriptOut.rail ?? '')
    const amount = String(p.amount ?? scriptOut.amount ?? '')
    if (rail === 'nanopayment' || scriptOut.service_url) {
      return { id: uid(), kind: 'nano-receipt',
        chain:         String(scriptOut.chain ?? p.chain ?? 'arcTestnet'),
        serviceUrl:    String(scriptOut.service_url ?? 'http://localhost:3100/api/service/premium'),
        amount:        String(scriptOut.amount ?? amount ?? '0.01'),
        mode:          String(scriptOut.mode ?? 'live'),
        balanceBefore: scriptOut.balanceBefore ? String(scriptOut.balanceBefore) : undefined,
        balanceAfter:  scriptOut.balanceAfter  ? String(scriptOut.balanceAfter)  : undefined,
        txHash:        scriptOut.transaction   ? String(scriptOut.transaction)   : undefined,
      }
    }
    if (rail === 'agent_card' || scriptOut.maskedPan) {
      return { id: uid(), kind: 'card-receipt',
        maskedPan:    String(scriptOut.maskedPan ?? '•••• •••• •••• ••••'),
        expiry:       String(scriptOut.expiry ?? 'N/A'),
        amount:       String(scriptOut.amount ?? amount),
        balance:      String(scriptOut.balance ?? 'N/A'),
        mode:         String(scriptOut.mode ?? 'sandbox'),
        chargeStatus: scriptOut.chargeStatus ? String(scriptOut.chargeStatus) : undefined,
        cardId:       scriptOut.cardId ? String(scriptOut.cardId) : undefined,
        description:  scriptOut.description ? String(scriptOut.description) : undefined,
        fundedAmount: scriptOut.fundedAmount ? String(scriptOut.fundedAmount) : undefined,
        isNewCard:    Boolean(scriptOut.isNewCard),
      }
    }
    if (rail === 'payment_link' || (scriptOut.link && !scriptOut.service_url)) {
      return { id: uid(), kind: 'link-receipt',
        paymentId: String(scriptOut.payment_id ?? p.payment_id ?? ''),
        link:      String(scriptOut.link ?? ''),
        chain:     String(scriptOut.chain ?? ''),
        token:     String(scriptOut.token ?? 'USDC'),
        amount:    String(scriptOut.amount ?? ''),
        recipient: String(scriptOut.wallet ?? ''),
        expires:   scriptOut.expires_at ? String(scriptOut.expires_at) : undefined,
        confirmed: false,
      }
    }
    if (rail === 'payment_link_confirmed') {
      return { id: uid(), kind: 'link-receipt',
        paymentId: String(p.payment_id ?? ''),
        link:      '',
        chain:     String(p.chain ?? ''),
        token:     String(p.token ?? 'USDC'),
        amount:    String(p.amount ?? ''),
        recipient: '',
        txHash:    p.tx_hash ? String(p.tx_hash) : undefined,
        confirmed: true,
      }
    }
    if (rail === 'bridge' || scriptOut.bridge_instructions) {
      const bi = (scriptOut.bridge_instructions ?? scriptOut) as Record<string, unknown>
      return { id: uid(), kind: 'bridge-receipt',
        paymentId:        String(scriptOut.payment_id ?? p.payment_id ?? ''),
        depositAddress:   String(bi.deposit_address ?? ''),
        amountToSend:     String(bi.amount_to_send ?? ''),
        relayFee:         String(bi.relay_fee ?? ''),
        businessReceives: String(bi.business_receives ?? ''),
        settlementChain:  String(bi.settlement_chain ?? ''),
        expires:          scriptOut.expires_at ? String(scriptOut.expires_at) : undefined,
        confirmed: false,
      }
    }
    if (rail === 'bridge_confirmed') {
      return { id: uid(), kind: 'bridge-receipt',
        paymentId:        String(p.payment_id ?? ''),
        depositAddress:   '',
        amountToSend:     '',
        relayFee:         '',
        businessReceives: '',
        settlementChain:  String(p.settlement_chain ?? ''),
        txHash:           p.tx_hash ? String(p.tx_hash) : undefined,
        confirmed:        true,
      }
    }
    if (p.status === 'rejected') {
      return { id: uid(), kind: 'rejected',
        violation: String(p.violation ?? ''),
        policy:    String(p.policy ?? ''),
        received:  String(p.received ?? ''),
      }
    }
    return null
  }

  // ── Poll for async payment result ─────────────────────────────────────────────
  function startConfirmationPoll(confirmId: string) {
    let attempts = 0
    const maxAttempts = 450 // 900s / 15 minutes — enough for bridge
    const timer = setInterval(async () => {
      attempts++
      try {
        const res  = await fetch(`/api/payment-status/${confirmId}`)
        const data = await res.json() as { status: string; result?: Record<string, unknown> }
        if (data.status === 'complete' && data.result) {
          clearInterval(timer)
          const confirmed = receiptFromJSON(data.result)
          if (confirmed) dispatch({ type: 'ADD_MSG', msg: confirmed })
        }
      } catch { /* keep polling */ }
      if (attempts >= maxAttempts) clearInterval(timer)
    }, 2000)
  }

  function startPolling(paymentId: string, queueStepId: string) {
    const ref = streamRef.current
    if (ref.pollingTimer) clearInterval(ref.pollingTimer)
    let attempts = 0
    ref.pollingTimer = setInterval(async () => {
      attempts++
      try {
        const res  = await fetch(`/api/payment-status/${paymentId}`)
        const data = await res.json() as { status: string; result?: Record<string, unknown> }
        if (data.status === 'complete' && data.result) {
          clearInterval(ref.pollingTimer!); ref.pollingTimer = null
          dispatch({ type: 'SETTLE_STEP', id: queueStepId, stepKind: 'done', body: 'orchestrator complete' })
          const receipt = receiptFromJSON(data.result)
          if (receipt) {
            dispatch({ type: 'ADD_MSG', msg: receipt })
            if ((receipt.kind === 'link-receipt' || receipt.kind === 'bridge-receipt') && !receipt.confirmed) {
              startConfirmationPoll(paymentId + '_c')
            }
          }
          dispatch({ type: 'SET_STATUS', status: { state: 'done', text: '✓ done' } })
          setTimeout(() => dispatch({ type: 'SET_STATUS', status: { state: 'idle', text: 'idle' } }), 1800)
        }
      } catch { /* network blip — keep polling */ }
      if (attempts >= 30) { // 60s timeout
        clearInterval(ref.pollingTimer!); ref.pollingTimer = null
        dispatch({ type: 'SETTLE_STEP', id: queueStepId, stepKind: 'error', body: 'timeout' })
      }
    }, 2000)
  }

  const setStatus = useCallback((s: StatusState, text: string) => {
    dispatch({ type: 'SET_STATUS', status: { state: s, text } })
  }, [])

  const resetStatusLater = useCallback(() => {
    setTimeout(() => dispatch({ type: 'SET_STATUS', status: { state: 'idle', text: 'idle' } }), 1800)
  }, [])

  const send = useCallback(async (text: string) => {
    if (state.busy) return
    dispatch({ type: 'SET_BUSY', busy: true })

    const ref = streamRef.current
    ref.agentId = null; ref.agentText = ''
    ref.thinkingId = null
    ref.spawnId = null; ref.scriptId = null
    ref.inThinking = false; ref.toolShown.clear()

    dispatch({ type: 'ADD_MSG', msg: { id: uid(), kind: 'user', text } })
    setStatus('thinking', '🧠 thinking...')

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as Record<string, unknown>
        dispatch({ type: 'ADD_MSG', msg: { id: uid(), kind: 'step', stepKind: 'error', icon: '✖', label: 'Connection error', body: String(err.error ?? `HTTP ${res.status}`), active: false } })
        setStatus('error', '✖ error'); resetStatusLater(); return
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const events = parseSSE(buffer)
        const lastDnl = buffer.lastIndexOf('\n\n')
        buffer = lastDnl >= 0 ? buffer.slice(lastDnl + 2) : buffer

        for (const { event, data } of events) {
          const evType = event ?? (data?.type as string) ?? ''
          const item = (data?.item ?? data) as Record<string, unknown>

          // ── output_item.added ──────────────────────────────────────────────
          if (evType === 'response.output_item.added') {
            if (item?.type === 'thinking' || item?.type === 'reasoning') {
              ref.inThinking = true
              ref.thinkingId = uid()
              dispatch({ type: 'ADD_MSG', msg: { id: ref.thinkingId, kind: 'thinking', text: '' } })
              setStatus('thinking', '🧠 reasoning...')
            }
            if (item?.type === 'function_call') {
              ref.inThinking = false
              const name = String(item.name ?? '')
              const isSpawn  = name.includes('spawn')
              const isScript = name.includes('bash') || name.includes('exec')
              const id = uid()
              if (isSpawn) {
                ref.spawnId = id
                dispatch({ type: 'ADD_MSG', msg: { id, kind: 'step', stepKind: 'spawn', icon: '🔀', label: 'Spawning orchestrator', body: 'sessions_spawn → delegating...', active: true } })
                setStatus('working', '🔀 spawning agent...')
              } else if (isScript) {
                ref.scriptId = id
                dispatch({ type: 'ADD_MSG', msg: { id, kind: 'step', stepKind: 'script', icon: '▶', label: 'Executing script', body: 'npx tsx ... running', active: true } })
                setStatus('working', '▶ running script...')
              } else {
                const tid = uid()
                dispatch({ type: 'ADD_MSG', msg: { id: tid, kind: 'step', stepKind: 'tool', icon: '🔧', label: `Tool: ${name}`, body: '...', active: true } })
                dispatch({ type: 'SETTLE_STEP', id: tid }) // settle immediately (no result to wait for)
                setStatus('working', `🔧 ${name}...`)
              }
            }
          }

          // ── output_item.done ───────────────────────────────────────────────
          if (evType === 'response.output_item.done') {
            if (item?.type === 'thinking' || item?.type === 'reasoning') ref.inThinking = false
            if (item?.type === 'function_call') {
              let argsStr = ''
              try { argsStr = JSON.stringify(JSON.parse(String(item.arguments ?? '{}')), null, 0).slice(0, 200) }
              catch { argsStr = String(item.arguments ?? '').slice(0, 200) }
              if (ref.spawnId)  { dispatch({ type: 'SETTLE_STEP', id: ref.spawnId,  body: argsStr || 'invoked' }); ref.spawnId  = null; setStatus('working', '⏳ waiting for result...') }
              if (ref.scriptId) { dispatch({ type: 'SETTLE_STEP', id: ref.scriptId, body: argsStr || 'invoked' }); ref.scriptId = null; setStatus('working', '⏳ script running...') }
            }
          }

          // ── text delta ─────────────────────────────────────────────────────
          // OpenClaw sends delta as a plain string: {"delta":"text"}
          // Anthropic SDK sends delta as object: {"delta":{"text":"..."}}
          const rawDelta = data?.delta
          const chunk = typeof rawDelta === 'string'
            ? rawDelta
            : (rawDelta as Record<string, unknown>)?.text as string
              ?? (rawDelta as Record<string, unknown>)?.value as string
              ?? null

          if (chunk) {
            if (ref.inThinking && ref.thinkingId) {
              dispatch({ type: 'APPEND_THINKING', id: ref.thinkingId, chunk })
            } else {
              ref.inThinking = false
              if (!ref.agentId) {
                ref.agentId = uid()
                dispatch({ type: 'ADD_MSG', msg: { id: ref.agentId, kind: 'agent', text: '', streaming: true } })
                setStatus('thinking', '📝 responding...')
              }
              dispatch({ type: 'APPEND_AGENT', id: ref.agentId, chunk })
              ref.agentText += chunk
            }

            // Detect PAYMENT QUEUED pattern — wait for full block (Status: Delegating comes after Rail:)
            const payIdMatch = (ref.agentText).match(/ID:\s*(pay_\d+)/)
            const delegating = ref.agentText.includes('Delegating to orchestrator')
            if (payIdMatch && delegating && !ref.toolShown.has('queued')) {
              ref.toolShown.add('queued')
              const paymentId = payIdMatch[1]
              const queueId = uid()
              dispatch({ type: 'ADD_MSG', msg: { id: queueId, kind: 'step', stepKind: 'spawn', icon: '🔀', label: `Payment queued: ${paymentId}`, body: 'Orchestrator processing — polling for result...', active: true } })
              setStatus('working', '⏳ orchestrator executing...')
              startPolling(paymentId, queueId)
              // Notify owner panel about the incoming request (only fires from product panel)
              if (endpoint.includes('product')) {
                const railMatch   = ref.agentText.match(/Rail:\s*(.+)/)
                const railText    = railMatch ? railMatch[1].trim() : 'unknown'
                const amtMatch    = ref.agentText.match(/(\d+(?:\.\d+)?)\s*(?:USDC|\$|USD)/i)
                const amtText     = amtMatch ? amtMatch[0].trim() : ''
                const amtNum      = ref.agentText.match(/(\d+(?:\.\d+)?)/)
                const chainMatch  = ref.agentText.match(/on\s+(polygon|arbitrum|solana)/i)
                const chainText   = chainMatch ? chainMatch[1].toLowerCase() : ''
                const isAgentCard  = /agentcard|fiat|visa/i.test(railText)
                const isNano       = /circle|gateway|usdc/i.test(railText) && !chainText && !isAgentCard
                const isBridge     = /solana|bridge/i.test(railText)
                const railKey      = isAgentCard ? 'agent_card' : isNano ? 'nanopayment' : isBridge ? 'bridge' : 'payment_link'
                const token        = isAgentCard ? 'USD' : 'USDC'
                const chain        = isAgentCard ? '' : chainText || (isNano ? 'arcTestnet' : 'polygon')
                fetch('/api/notify', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    rail:    railKey,
                    event:   'payment_queued',
                    message: `Payment requested: ${amtText || railText}`,
                    details: {
                      payment_id: paymentId,
                      method:     railText,
                      amount:     amtNum ? amtNum[1] : '',
                      token,
                      chain,
                    },
                  }),
                }).catch(() => {})
              }
            }

            // Heuristic: detect spawn/script from plain text stream
            const toolType = detectTool(chunk)
            if (toolType && !ref.toolShown.has(toolType) && !ref.inThinking) {
              ref.toolShown.add(toolType)
              if (toolType === 'spawn' && !ref.spawnId) {
                const id = uid(); ref.spawnId = id
                dispatch({ type: 'ADD_MSG', msg: { id, kind: 'step', stepKind: 'spawn', icon: '🔀', label: 'Spawning orchestrator', body: 'sessions_spawn → delegating...', active: true } })
                setStatus('working', '🔀 spawning agent...')
              }
              if (toolType === 'script' && !ref.scriptId) {
                const id = uid(); ref.scriptId = id
                dispatch({ type: 'ADD_MSG', msg: { id, kind: 'step', stepKind: 'script', icon: '▶', label: 'Executing script', body: 'npx tsx ... running', active: true } })
                setStatus('working', '▶ running script...')
              }
              if (toolType === 'boundary') {
                const id = uid()
                dispatch({ type: 'ADD_MSG', msg: { id, kind: 'step', stepKind: 'tool', icon: '📋', label: 'Reading boundary', body: 'BOUNDARY.md', active: false } })
                setStatus('working', '📋 reading boundary...')
              }
            }
          }

          // ── completed ──────────────────────────────────────────────────────
          if (evType === 'response.completed' || evType === 'response.done') {
            let receiptAdded = false
            if (ref.agentId) {
              dispatch({ type: 'FINISH_AGENT', id: ref.agentId })
              const receipt = parsePaymentResult(ref.agentText, uid())
              if (receipt) { dispatch({ type: 'ADD_MSG', msg: receipt }); receiptAdded = true }
              ref.agentId = null; ref.agentText = ''
            }
            if (ref.spawnId)  { dispatch({ type: 'SETTLE_STEP',  id: ref.spawnId, body: 'complete' });  ref.spawnId  = null }
            if (ref.scriptId) { dispatch({ type: 'SETTLE_STEP',  id: ref.scriptId, body: 'complete' }); ref.scriptId = null }

            // Only parse output array if no receipt was already added from streamed text
            if (!receiptAdded) {
            const output = ((data?.response as Record<string, unknown>)?.output ?? []) as Array<Record<string, unknown>>
            for (const out of output) {
              if (out.type === 'message') {
                const txt = ((out.content as Array<Record<string, unknown>>)?.[0]?.text as string) ?? ''

                // Try receipt patterns first (formatted text from product bot)
                const receiptFromOutput = parsePaymentResult(txt, uid())
                if (receiptFromOutput) {
                  dispatch({ type: 'ADD_MSG', msg: receiptFromOutput })
                  break
                }

                // Try JSON embedded in output text
                const m = txt.match(/\{[\s\S]*\}/)
                if (m) {
                  try {
                    const p = JSON.parse(m[0]) as Record<string, unknown>
                    const receipt = receiptFromJSON(p)
                    if (receipt) { dispatch({ type: 'ADD_MSG', msg: receipt }); break }
                    if (p.status === 'executed') {
                      dispatch({ type: 'ADD_MSG', msg: { id: uid(), kind: 'step', stepKind: 'done', icon: '✓', label: 'Payment link created', body: String(p.payment_id ?? ''), active: false } })
                    } else if (p.status === 'bridge_payment') {
                      dispatch({ type: 'ADD_MSG', msg: { id: uid(), kind: 'step', stepKind: 'done', icon: '✓', label: 'Bridge payment initiated', body: 'Monitoring Solana deposit...', active: false } })
                    }
                  } catch { /* text response */ }
                }
              }
            }
            } // end if (!receiptAdded)
            setStatus('done', '✓ done'); resetStatusLater()
          }

          // ── failed ─────────────────────────────────────────────────────────
          if (evType === 'response.failed' || evType === 'error') {
            if (ref.agentId)  { dispatch({ type: 'FINISH_AGENT', id: ref.agentId }); ref.agentId = null }
            if (ref.spawnId)  { dispatch({ type: 'SETTLE_STEP',  id: ref.spawnId,  stepKind: 'error' }); ref.spawnId  = null }
            if (ref.scriptId) { dispatch({ type: 'SETTLE_STEP',  id: ref.scriptId, stepKind: 'error' }); ref.scriptId = null }
            dispatch({ type: 'ADD_MSG', msg: { id: uid(), kind: 'step', stepKind: 'error', icon: '✖', label: 'Agent error', body: JSON.stringify((data as Record<string, unknown>).error ?? data).slice(0, 250), active: false } })
            setStatus('error', '✖ error'); resetStatusLater()
          }
        }
      }

      // finalize on stream end
      if (ref.agentId) {
        dispatch({ type: 'FINISH_AGENT', id: ref.agentId })
        const receipt = parsePaymentResult(ref.agentText, uid())
        if (receipt) dispatch({ type: 'ADD_MSG', msg: receipt })
        ref.agentId = null; ref.agentText = ''
      }
      if (ref.spawnId)  { dispatch({ type: 'SETTLE_STEP',  id: ref.spawnId, body: 'complete' });  ref.spawnId  = null }
      if (ref.scriptId) { dispatch({ type: 'SETTLE_STEP',  id: ref.scriptId, body: 'complete' }); ref.scriptId = null }

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      dispatch({ type: 'ADD_MSG', msg: { id: uid(), kind: 'step', stepKind: 'error', icon: '✖', label: 'Network error', body: msg, active: false } })
      setStatus('error', '✖ error'); resetStatusLater()
    } finally {
      dispatch({ type: 'SET_BUSY', busy: false })
    }
  }, [endpoint, state.busy, setStatus, resetStatusLater])

  const clearHistory = useCallback(() => {
    localStorage.removeItem(storageKey(endpoint))
    dispatch({ type: 'CLEAR' })
  }, [endpoint])

  return { messages: state.messages, status: state.status, busy: state.busy, send, clearHistory }
}
