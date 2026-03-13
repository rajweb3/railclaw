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

const args = parseArgs(process.argv);
const url   = args['url'] || 'http://localhost:3100/api/service/premium';
const chain = (args['chain'] || 'arcTestnet') as 'arcTestnet' | 'base' | 'baseSepolia' | 'arbitrumSepolia';

const privateKey = process.env.CIRCLE_BUYER_PRIVATE_KEY as `0x${string}` | undefined;

if (!privateKey) {
  // Simulation mode — no real payment
  console.log(JSON.stringify({
    status: 'success',
    rail: 'nanopayment',
    mode: 'simulation',
    chain,
    service_url: url,
    note: 'CIRCLE_BUYER_PRIVATE_KEY not set — simulated payment only',
  }));
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

  const { data, status } = await client.pay(url);

  const updated = await client.getBalances();
  const balanceAfter = updated.gateway.formattedAvailable;

  console.log(JSON.stringify({
    status: 'success',
    rail: 'nanopayment',
    mode: 'live',
    chain,
    service_url: url,
    http_status: status,
    balanceBefore: `${balanceBefore} USDC`,
    balanceAfter:  `${balanceAfter} USDC`,
    data,
  }));
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ status: 'error', error: msg }));
  process.exit(1);
}
