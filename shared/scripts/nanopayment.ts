/**
 * Circle Gateway Nanopayment — buyer-side script
 *
 * Makes a gasless USDC nanopayment to an x402-protected endpoint.
 * Outputs a single JSON object on stdout for the orchestrator to parse.
 *
 * Usage:
 *   npx tsx nanopayment.ts --url <endpoint-url> [--chain arcTestnet]
 *
 * Env:
 *   CIRCLE_BUYER_PRIVATE_KEY   EVM private key for the buyer wallet
 */

import { GatewayClient } from '@circle-fin/x402-batching/client';
import { parseArgs } from './lib/config.js';

const args      = parseArgs(process.argv);
const url       = args['url'] || 'http://localhost:3100/api/service/premium';
const chain     = (args['chain'] || 'arcTestnet') as 'arcTestnet' | 'base' | 'baseSepolia' | 'arbitrumSepolia';
const paymentId = args['payment-id'] || '';

async function postCallback(result: object) {
  if (!paymentId) return;
  try {
    await fetch('http://localhost:3100/api/payment-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId, result }),
    });
  } catch { /* best-effort */ }
}

async function postNotification(details: Record<string, unknown>): Promise<void> {
  try {
    await fetch('http://localhost:3100/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rail: 'nanopayment',
        event: 'payment_received',
        message: `Received ${details.amount ?? ''} USDC via Circle Gateway (${details.chain ?? chain})`,
        details,
      }),
    });
  } catch { /* best-effort */ }
}

const privateKey = process.env.CIRCLE_BUYER_PRIVATE_KEY as `0x${string}` | undefined;

if (!privateKey) {
  // Simulation mode — no real payment
  const simResult = {
    status: 'success', rail: 'nanopayment', mode: 'simulation',
    chain, service_url: url, note: 'CIRCLE_BUYER_PRIVATE_KEY not set — simulated payment only',
  };
  console.log(JSON.stringify(simResult));
  await postCallback(simResult);
  process.exit(0);
}

try {
  const client = new GatewayClient({ chain, privateKey });

  const balances = await client.getBalances();
  const balanceBefore = balances.gateway.formattedAvailable;

  // Auto-deposit 1 USDC if gateway balance < 1 USDC
  if (balances.gateway.available < 1_000_000n) {
    await client.deposit('1');
  }

  const { data, status, transaction, formattedAmount } = await client.pay(url);

  const updated = await client.getBalances();
  const balanceAfter = updated.gateway.formattedAvailable;

  const liveResult = {
    status: 'success', rail: 'nanopayment', mode: 'live',
    chain, service_url: url, http_status: status,
    transaction: transaction || undefined,
    amount: formattedAmount || undefined,
    balanceBefore: `${balanceBefore} USDC`, balanceAfter: `${balanceAfter} USDC`, data,
  };
  console.log(JSON.stringify(liveResult));
  await postCallback(liveResult);
  await postNotification({ ...liveResult });
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const errResult = { status: 'error', rail: 'nanopayment', error: msg };
  console.log(JSON.stringify(errResult));
  await postCallback(errResult);
  process.exit(1);
}
