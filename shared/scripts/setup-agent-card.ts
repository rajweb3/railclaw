/**
 * AgentCard one-time setup — creates cardholder + attaches payment method.
 *
 * Run once before using agent-card-payment.ts:
 *   npx tsx setup-agent-card.ts
 *
 * In sandbox mode, complete the checkout URL with Stripe test card:
 *   Card: 4242 4242 4242 4242 | Exp: 12/29 | CVC: 123 | ZIP: 10001
 *
 * Env:
 *   AGENT_CARD_API_KEY   sk_test_... from: agent-cards-admin keys create
 */

const BASE_URL = (process.env.AGENT_CARD_BASE_URL || 'https://sandbox.api.agentcard.sh').replace(/\/$/, '');
const API_KEY  = process.env.AGENT_CARD_API_KEY || '';

if (!API_KEY) {
  console.error('❌ AGENT_CARD_API_KEY not set in environment.');
  console.error('   Run: agent-cards-admin keys create');
  console.error('   Then add AGENT_CARD_API_KEY=sk_test_... to ~/payclaw/.env');
  process.exit(1);
}

const headers = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

async function api<T>(method: string, path: string, body?: object): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method, headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json() as T;
  return { status: res.status, data };
}

type Cardholder = { id: string; firstName: string };

// Step 1: Get or create cardholder
const { data: listData } = await api<{ cardholders?: Cardholder[] } | Cardholder[]>('GET', '/api/v1/cardholders');
const existing = Array.isArray(listData)
  ? listData
  : ((listData as { cardholders?: Cardholder[] }).cardholders ?? []);

let cardholder: Cardholder;
if (existing.length > 0) {
  cardholder = existing[0];
  console.log(`✓ Using existing cardholder: ${cardholder.firstName} (${cardholder.id})`);
} else {
  const { status, data: created } = await api<Cardholder>('POST', '/api/v1/cardholders', {
    firstName: 'Railclaw',
    lastName:  'Agent',
    dateOfBirth: '1990-01-01',
    email: 'agent@railclaw.demo',
  });
  if (status !== 200 && status !== 201) {
    console.error('❌ Cardholder creation failed:', JSON.stringify(created));
    process.exit(1);
  }
  cardholder = created;
  console.log(`✓ Created cardholder: ${cardholder.firstName} (${cardholder.id})`);
}

// Step 2: Check payment method status
const { data: pmStatus } = await api<{ hasPaymentMethod: boolean }>('GET', `/api/v1/cardholders/${cardholder.id}/payment-method/status`);

if (pmStatus.hasPaymentMethod) {
  console.log('✓ Payment method already attached.');
  console.log('\n✅ Setup complete. You can now run agent-card-payment.ts');
  process.exit(0);
}

// Step 3: Create checkout session
const { status: csStatus, data: checkout } = await api<{ checkoutUrl?: string; stripeSessionId?: string }>('POST', `/api/v1/cardholders/${cardholder.id}/payment-method/setup`);

if (csStatus !== 200 && csStatus !== 201) {
  console.error('❌ Checkout session creation failed:', JSON.stringify(checkout));
  process.exit(1);
}

console.log('\n⚡ Open this URL in your browser to attach a payment method:');
console.log(`\n   ${checkout.checkoutUrl}\n`);
console.log('In sandbox mode, use Stripe test card:');
console.log('   Card: 4242 4242 4242 4242');
console.log('   Exp:  12/29  CVC: 123  ZIP: 10001');
console.log('\nWaiting for completion', { sessionId: checkout.stripeSessionId });
console.log('(Re-run this script after completing checkout to verify)');
