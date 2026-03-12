export type StepKind = 'tool' | 'spawn' | 'script' | 'done' | 'error'

export type Msg =
  | { id: string; kind: 'user';     text: string }
  | { id: string; kind: 'agent';    text: string; streaming: boolean }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'step';     stepKind: StepKind; icon: string; label: string; body: string; active: boolean }
  | { id: string; kind: 'rail';     rail: string; amount?: string }

export type StatusState = 'idle' | 'thinking' | 'working' | 'done' | 'error'

export interface ChatStatus {
  state: StatusState
  text: string
}
