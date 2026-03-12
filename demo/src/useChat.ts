import { useCallback, useReducer, useRef } from 'react'
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

function detectTool(text: string): 'spawn' | 'script' | 'boundary' | null {
  if (text.includes('sessions_spawn') || text.includes('spawning')) return 'spawn'
  if (text.includes('npx tsx') || text.includes('nanopayment.ts') || text.includes('agent-card-payment.ts')) return 'script'
  if (text.includes('BOUNDARY.md') || text.includes('boundary')) return 'boundary'
  return null
}

// ── Hook ──────────────────────────────────────────────────────────────────────

let _idSeq = 0
const uid = () => `m${++_idSeq}`

export function useChat(endpoint: string) {
  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    status: { state: 'idle', text: 'idle' },
    busy: false,
  })

  // Track in-flight streaming IDs via ref (stable across renders)
  const streamRef = useRef({
    agentId:    null as string | null,
    thinkingId: null as string | null,
    spawnId:    null as string | null,
    scriptId:   null as string | null,
    inThinking: false,
    toolShown:  new Set<string>(),
  })

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
    ref.agentId = null; ref.thinkingId = null
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
          const chunk = (data?.delta as Record<string, unknown>)?.text as string
                     ?? (data?.delta as Record<string, unknown>)?.value as string
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
            if (ref.agentId)  { dispatch({ type: 'FINISH_AGENT', id: ref.agentId }); ref.agentId = null }
            if (ref.spawnId)  { dispatch({ type: 'SETTLE_STEP',  id: ref.spawnId, body: 'complete' });  ref.spawnId  = null }
            if (ref.scriptId) { dispatch({ type: 'SETTLE_STEP',  id: ref.scriptId, body: 'complete' }); ref.scriptId = null }

            const output = ((data?.response as Record<string, unknown>)?.output ?? []) as Array<Record<string, unknown>>
            for (const out of output) {
              if (out.type === 'message') {
                const txt = ((out.content as Array<Record<string, unknown>>)?.[0]?.text as string) ?? ''
                const m = txt.match(/\{[\s\S]*\}/)
                if (m) {
                  try {
                    const p = JSON.parse(m[0]) as Record<string, unknown>
                    if (p.status === 'rail_payment') {
                      dispatch({ type: 'ADD_MSG', msg: { id: uid(), kind: 'rail', rail: String(p.rail ?? ''), amount: p.amount ? String(p.amount) : undefined } })
                      dispatch({ type: 'ADD_MSG', msg: { id: uid(), kind: 'step', stepKind: 'done', icon: '✓', label: 'Payment complete', body: `rail: ${p.rail}`, active: false } })
                    } else if (p.status === 'executed') {
                      dispatch({ type: 'ADD_MSG', msg: { id: uid(), kind: 'step', stepKind: 'done', icon: '✓', label: 'Payment link created', body: String(p.payment_id ?? ''), active: false } })
                    } else if (p.status === 'bridge_payment') {
                      dispatch({ type: 'ADD_MSG', msg: { id: uid(), kind: 'step', stepKind: 'done', icon: '✓', label: 'Bridge payment initiated', body: 'Monitoring Solana deposit...', active: false } })
                    } else if (p.status === 'rejected') {
                      dispatch({ type: 'ADD_MSG', msg: { id: uid(), kind: 'step', stepKind: 'error', icon: '✖', label: `Rejected: ${p.violation}`, body: String(p.policy ?? ''), active: false } })
                    }
                  } catch { /* text response */ }
                }
              }
            }
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
      if (ref.agentId)  { dispatch({ type: 'FINISH_AGENT', id: ref.agentId }); ref.agentId = null }
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

  return { messages: state.messages, status: state.status, busy: state.busy, send }
}
