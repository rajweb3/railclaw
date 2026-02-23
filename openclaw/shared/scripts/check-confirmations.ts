/**
 * check-confirmations.ts — Check confirmation count for a transaction.
 *
 * Usage:
 *   npx tsx check-confirmations.ts --tx-hash 0x... --chain polygon
 *
 * Output (stdout JSON):
 *   { success: true, tx_hash: "0x...", confirmations: 25, finalized: true }
 */

import { ethers } from 'ethers';
import { config, parseArgs } from './lib/config.js';

const args = parseArgs(process.argv);
const txHash = args['tx-hash'];
const chain = args['chain']?.toLowerCase();

if (!txHash || !chain) {
  console.log(JSON.stringify({ success: false, error: 'Missing --tx-hash or --chain' }));
  process.exit(1);
}

const rpcUrl = config.rpc[chain];
if (!rpcUrl) {
  console.log(JSON.stringify({ success: false, error: `No RPC for chain: ${chain}` }));
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(rpcUrl);

try {
  const receipt = await provider.getTransactionReceipt(txHash);

  if (!receipt) {
    console.log(JSON.stringify({ success: true, tx_hash: txHash, confirmations: 0, finalized: false, status: 'pending' }));
    process.exit(0);
  }

  const currentBlock = await provider.getBlockNumber();
  const confirmations = receipt.blockNumber ? currentBlock - receipt.blockNumber + 1 : 0;

  console.log(
    JSON.stringify({
      success: true,
      tx_hash: txHash,
      block_number: receipt.blockNumber,
      confirmations,
      finalized: confirmations >= config.monitoring.requiredConfirmations,
      status: receipt.status === 1 ? 'success' : 'failed',
    })
  );
} catch (err: any) {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
}
