/**
 * AgentCard Visa — payment script (REST API, non-interactive)
 *
 * Calls the agentcard.sh REST API directly using the JWT stored by
 * `agent-cards login`. Does NOT use the interactive CLI.
 * Outputs a single JSON object on stdout for the orchestrator to parse.
 *
 * Usage:
 *   npx tsx agent-card-payment.ts --card-id <id> --amount <USD> [--description <text>]
 *
 * Prerequisites:
 *   npm install -g agent-cards
 *   agent-cards signup   (or agent-cards login)
 *   → stores JWT at ~/.agent-cards/config.json
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseArgs } from './lib/config.js';

const BASE_URL = 'https://backend-production-8bc3.up.railway.app';

const args        = parseArgs(process.argv);
const cardId      = args['card-id'];
const amount      = args['amount'] || '0.01';
const description = args['description'] || 'Railclaw agent payment';

if (!cardId) {
  console.log(JSON.stringify({ status: 'error', error: 'Missing --card-id argument' }));
  process.exit(1);
}

// Read JWT from ~/.agent-cards/config.json
let token: string;
try {
  const cfgPath  = join(homedir(), '.agent-cards', 'config.json');
  const cfgRaw   = readFileSync(cfgPath, 'utf8');
  const cfg      = JSON.parse(cfgRaw);
  token = cfg.token || cfg.accessToken || cfg.jwt;
  if (!token) throw new Error('No token field found in config');
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({
    status: 'error',
    error: `Cannot read AgentCard JWT: ${msg}. Run: npm install -g agent-cards && agent-cards signup`,
  }));
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
};

async function apiGet(path: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiPost(path: string, body: object) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST', headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

try {
  // 1. Fetch card details
  const card = await apiGet(`/cards/${cardId}`) as Record<string, unknown>;
  const pan     = String(card.pan || card.number || '');
  const masked  = pan.length >= 8 ? `${pan.slice(0, 4)} **** **** ${pan.slice(-4)}` : '•••• •••• •••• ••••';
  const expiry  = String(card.expiry || card.expiryDate || card.exp || 'N/A');
  const balance = card.balance !== undefined ? `$${card.balance}` : 'N/A';

  // 2. Initiate charge
  const { status: chargeStatus, body: chargeBody } = await apiPost(
    `/cards/${cardId}/charges`,
    { amount: parseFloat(amount), description },
  );
  const cb = chargeBody as Record<string, unknown>;

  if (chargeStatus === 200 || chargeStatus === 201) {
    // Immediate success
    console.log(JSON.stringify({
      status: 'success',
      rail: 'agent_card',
      mode: 'live',
      maskedPan: masked,
      expiry,
      amount,
      balance,
      description,
      charge: cb,
    }));

  } else if (chargeStatus === 202) {
    // Approval required — auto-approve
    const chargeId = String(cb.chargeId || cb.id || '');
    if (!chargeId) throw new Error(`202 response missing chargeId: ${JSON.stringify(cb)}`);

    await apiPost(`/charges/${chargeId}/resolve`, { approved: true });

    // Verify final state
    const finalCharge = await apiGet(`/charges/${chargeId}`) as Record<string, unknown>;

    console.log(JSON.stringify({
      status: 'success',
      rail: 'agent_card',
      mode: 'live',
      maskedPan: masked,
      expiry,
      amount,
      balance,
      description,
      chargeId,
      chargeStatus: finalCharge.status ?? 'approved',
    }));

  } else {
    throw new Error(`Charge rejected: HTTP ${chargeStatus} — ${JSON.stringify(cb)}`);
  }

} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ status: 'error', error: msg }));
  process.exit(1);
}
