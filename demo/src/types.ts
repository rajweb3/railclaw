export type StepKind = 'tool' | 'spawn' | 'script' | 'done' | 'error'

export type Msg =
  | { id: string; kind: 'user';         text: string }
  | { id: string; kind: 'agent';        text: string; streaming: boolean }
  | { id: string; kind: 'thinking';     text: string }
  | { id: string; kind: 'step';         stepKind: StepKind; icon: string; label: string; body: string; active: boolean }
  | { id: string; kind: 'rail';         rail: string; amount?: string }
  // ── Payment receipt cards ──────────────────────────────────────────────────
  | { id: string; kind: 'nano-receipt';
      chain: string; serviceUrl: string; amount: string; mode: string;
      balanceBefore?: string; balanceAfter?: string; txHash?: string }
  | { id: string; kind: 'card-receipt';
      maskedPan: string; expiry: string; amount: string; balance: string;
      mode: string; chargeStatus?: string; cardId?: string;
      description?: string; fundedAmount?: string; isNewCard?: boolean }
  | { id: string; kind: 'link-receipt';
      paymentId: string; link: string; chain: string; token: string;
      amount: string; recipient: string; expires?: string;
      txHash?: string; confirmed?: boolean }
  | { id: string; kind: 'bridge-receipt';
      paymentId: string; depositAddress: string; amountToSend: string;
      relayFee: string; businessReceives: string; settlementChain: string; expires?: string;
      txHash?: string; confirmed?: boolean }
  | { id: string; kind: 'rejected';
      violation: string; policy: string; received: string }

export type StatusState = 'idle' | 'thinking' | 'working' | 'done' | 'error'

export interface ChatStatus {
  state: StatusState
  text: string
}
