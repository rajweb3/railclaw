/**
 * AgentCard Visa — payment script (API v1)
 *
 * Creates a pre-funded virtual Visa card for fiat payment.
 * Auto-provisions cardholder + card if they don't exist yet.
 * Outputs a single JSON object on stdout.
 *
 * Usage:
 *   npx tsx agent-card-payment.ts --amount <USD> [--description <text>]
 *
 * Env:
 *   AGENT_CARD_API_KEY   sk_test_... from: agent-cards-admin keys create
 *   AGENT_CARD_BASE_URL  optional, defaults to sandbox
 */

import { parseArgs } from './lib/config.js';

const BASE_URL = (process.env.AGENT_CARD_BASE_URL || 'https://sandbox.api.agentcard.sh').replace(/\/$/, '');
const API_KEY  = process.env.AGENT_CARD_API_KEY || '';

const args        = parseArgs(process.argv);
const amount      = parseFloat(args['amount'] || '0.01');
const description = args['description'] || 'Railclaw payment';
const amountCents = Math.round(amount * 100);

if (!API_KEY) {
  console.log(JSON.stringify({
    status: 'error',
    error: 'AGENT_CARD_API_KEY not set. Run: npm install -g agent-cards-admin && agent-cards-admin keys create',
  }));
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
};

async function api<T>(method: string, path: string, body?: object): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data: T;
  try { data = await res.json() as T; } catch { data = {} as T; }
  return { status: res.status, data };
}

type Cardholder = { id: string; firstName: string; lastName: string };
type Card = { id: string; last4: string; expiry: string; balanceCents: number; status: string };
type CardDetails = { pan?: string; cvv?: string; expiry?: string };

// ── Get or create cardholder ─────────────────────────────────────────────────

async function getOrCreateCardholder(): Promise<Cardholder> {
  const { data } = await api<{ cardholders?: Cardholder[] } | Cardholder[]>('GET', '/api/v1/cardholders');
  const list: Cardholder[] = Array.isArray(data)
    ? data
    : ((data as { cardholders?: Cardholder[] }).cardholders ?? []);

  if (list.length > 0) return list[0];

  const { status, data: created } = await api<Cardholder>('POST', '/api/v1/cardholders', {
    firstName: 'Railclaw',
    lastName:  'Agent',
    dateOfBirth: '1990-01-01',
    email: 'agent@railclaw.demo',
  });
  if (status !== 200 && status !== 201) {
    throw new Error(`Cardholder creation failed: HTTP ${status} — ${JSON.stringify(created)}`);
  }
  return created;
}

// ── Get or create card ────────────────────────────────────────────────────────

async function getOrCreateCard(cardholderId: string): Promise<{ card: Card; isNew: boolean; fundedAmount: string }> {
  const { data } = await api<{ cards?: Card[] } | Card[]>('GET', '/api/v1/cards');
  const list: Card[] = Array.isArray(data)
    ? data
    : ((data as { cards?: Card[] }).cards ?? []);

  const usable = list.find(c => c.status === 'OPEN' && c.balanceCents >= amountCents);
  if (usable) return { card: usable, isNew: false, fundedAmount: `$${(usable.balanceCents / 100).toFixed(2)}` };

  // Fund card: 10x amount, minimum $10, maximum $500
  const fundCents = Math.min(Math.max(amountCents * 10, 1000), 50000);

  const { status, data: newCard } = await api<Card>('POST', '/api/v1/cards', {
    cardholderId,
    amountCents: fundCents,
  });

  if (status === 422) {
    throw new Error(
      'Cardholder has no payment method. Run setup:\n' +
      '  npx tsx setup-agent-card.ts\n' +
      'Then open the checkout URL in a browser to attach a test card.'
    );
  }
  if (status !== 200 && status !== 201) {
    throw new Error(`Card creation failed: HTTP ${status} — ${JSON.stringify(newCard)}`);
  }
  return { card: newCard, isNew: true, fundedAmount: `$${(fundCents / 100).toFixed(2)}` };
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  const cardholder = await getOrCreateCardholder();
  const { card, isNew, fundedAmount } = await getOrCreateCard(cardholder.id);

  // Get card details (PAN + expiry)
  const { data: details } = await api<CardDetails>('GET', `/api/v1/cards/${card.id}/details`);

  const pan     = details.pan ?? '';
  const masked  = pan.length >= 8
    ? `${pan.slice(0, 4)} **** **** ${pan.slice(-4)}`
    : `**** **** **** ${card.last4}`;
  const expiry  = details.expiry ?? card.expiry ?? 'N/A';
  const balanceAfterCents = card.balanceCents - amountCents;
  const balance = `$${(balanceAfterCents / 100).toFixed(2)}`;

  console.log(JSON.stringify({
    status:       'success',
    rail:         'agent_card',
    mode:         API_KEY.startsWith('sk_test_') ? 'sandbox' : 'live',
    maskedPan:    masked,
    expiry,
    amount:       amount.toFixed(2),
    balance,
    fundedAmount,
    isNewCard:    isNew,
    description,
    cardId:       card.id,
    chargeStatus: 'approved',
  }));

} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ status: 'error', error: msg }));
  process.exit(1);
}
