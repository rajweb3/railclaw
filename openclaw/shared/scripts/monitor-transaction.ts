/**
 * monitor-transaction.ts — Poll blockchain for incoming transfers matching a pending payment.
 *
 * Usage:
 *   npx tsx monitor-transaction.ts \
 *     --payment-id pay_XXXX --chain polygon --token USDC --amount 100 \
 *     --wallet 0x... --confirmations 20 --timeout 3600 --poll-interval 15
 *
 * Output (stdout JSON):
 *   { success: true, status: "confirmed", tx_hash: "0x...", ... }
 *   { success: false, status: "expired", reason: "..." }
 *
 * Behavior:
 *   - Polls RPC every N seconds for Transfer events to the wallet
 *   - Matches token + amount (with 1% slippage tolerance)
 *   - Waits for required confirmations
 *   - Updates payment record in $RAILCLAW_DATA_DIR/pending/
 *   - Exits on confirmation or timeout
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import { config, parseArgs, resolveDataPath } from './lib/config.js';

const args = parseArgs(process.argv);

const paymentId = args['payment-id'];
const chain = args['chain']?.toLowerCase();
const token = args['token']?.toUpperCase();
const amount = parseFloat(args['amount'] || '0');
const wallet = args['wallet']?.toLowerCase();
const requiredConfirmations = parseInt(args['confirmations'] || String(config.monitoring.requiredConfirmations));
const timeoutSeconds = parseInt(args['timeout'] || String(config.monitoring.timeoutMs / 1000));
const pollIntervalSeconds = parseInt(args['poll-interval'] || String(config.monitoring.pollIntervalMs / 1000));

if (!paymentId || !chain || !token || !amount || !wallet) {
  console.log(JSON.stringify({ success: false, error: 'Missing required arguments' }));
  process.exit(1);
}

const rpcUrl = config.rpc[chain];
if (!rpcUrl) {
  console.log(JSON.stringify({ success: false, error: `No RPC configured for chain: ${chain}` }));
  process.exit(1);
}

const tokenContract = config.tokens[chain]?.[token];
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const provider = new ethers.JsonRpcProvider(rpcUrl);

const startTime = Date.now();
const timeoutMs = timeoutSeconds * 1000;
let lastCheckedBlock = 0;

function updatePaymentRecord(status: string, txHash?: string, confirmations?: number): void {
  const filePath = join(resolveDataPath('pending'), `${paymentId}.json`);
  try {
    const record = JSON.parse(readFileSync(filePath, 'utf-8'));
    record.status = status;
    if (txHash) record.tx_hash = txHash;
    if (confirmations !== undefined) record.confirmations = confirmations;
    if (status === 'confirmed') record.confirmed_at = new Date().toISOString();
    writeFileSync(filePath, JSON.stringify(record, null, 2));
  } catch (err: any) {
    console.error(`Warning: Could not update payment record: ${err.message}`);
  }
}

async function getTokenDecimals(contractAddress: string): Promise<number> {
  try {
    const contract = new ethers.Contract(
      contractAddress,
      ['function decimals() view returns (uint8)'],
      provider
    );
    return await contract.decimals();
  } catch {
    return 6;
  }
}

async function checkForTransfer(): Promise<{ found: boolean; txHash?: string; blockNumber?: number }> {
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = lastCheckedBlock > 0 ? lastCheckedBlock + 1 : currentBlock - 10;

  if (fromBlock > currentBlock) return { found: false };

  // Native token transfers (ETH, MATIC, etc.)
  const nativeTokens = ['ETH', 'MATIC', 'AVAX', 'BNB', 'SOL'];
  if (nativeTokens.includes(token)) {
    for (let b = fromBlock; b <= currentBlock; b++) {
      const block = await provider.getBlock(b, true);
      if (!block?.prefetchedTransactions) continue;

      for (const tx of block.prefetchedTransactions) {
        if (
          tx.to?.toLowerCase() === wallet &&
          parseFloat(ethers.formatEther(tx.value)) >= amount * 0.99
        ) {
          lastCheckedBlock = currentBlock;
          return { found: true, txHash: tx.hash, blockNumber: b };
        }
      }
    }
  }

  // ERC-20 token transfers
  if (tokenContract) {
    const decimals = await getTokenDecimals(tokenContract);
    const expectedAmount = ethers.parseUnits(amount.toString(), decimals);
    const minAmount = (expectedAmount * 99n) / 100n; // 1% slippage

    const logs = await provider.getLogs({
      address: tokenContract,
      topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(wallet, 32)],
      fromBlock,
      toBlock: currentBlock,
    });

    for (const log of logs) {
      const transferAmount = BigInt(log.data);
      if (transferAmount >= minAmount) {
        lastCheckedBlock = currentBlock;
        return { found: true, txHash: log.transactionHash, blockNumber: log.blockNumber };
      }
    }
  }

  lastCheckedBlock = currentBlock;
  return { found: false };
}

async function waitForConfirmations(txHash: string, txBlock: number): Promise<number> {
  while (Date.now() - startTime < timeoutMs) {
    const currentBlock = await provider.getBlockNumber();
    const confirmations = currentBlock - txBlock + 1;
    if (confirmations >= requiredConfirmations) return confirmations;
    await new Promise((r) => setTimeout(r, pollIntervalSeconds * 1000));
  }
  return 0;
}

// Main loop
async function main() {
  console.error(`[monitor] ${paymentId}: ${amount} ${token} on ${chain} → ${wallet}`);
  console.error(`[monitor] poll=${pollIntervalSeconds}s, timeout=${timeoutSeconds}s, confirmations=${requiredConfirmations}`);

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await checkForTransfer();

      if (result.found && result.txHash && result.blockNumber) {
        console.error(`[monitor] TX found: ${result.txHash} at block ${result.blockNumber}`);
        updatePaymentRecord('confirming', result.txHash, 0);

        const finalConfirmations = await waitForConfirmations(result.txHash, result.blockNumber);

        if (finalConfirmations >= requiredConfirmations) {
          updatePaymentRecord('confirmed', result.txHash, finalConfirmations);
          console.log(
            JSON.stringify({
              success: true,
              status: 'confirmed',
              payment_id: paymentId,
              tx_hash: result.txHash,
              chain,
              token,
              amount,
              confirmations: finalConfirmations,
              confirmed_at: new Date().toISOString(),
            })
          );
          process.exit(0);
        }
      }
    } catch (err: any) {
      console.error(`[monitor] Poll error: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, pollIntervalSeconds * 1000));
  }

  // Timeout
  updatePaymentRecord('expired');
  console.log(
    JSON.stringify({
      success: false,
      status: 'expired',
      payment_id: paymentId,
      reason: `No matching transaction within ${timeoutSeconds}s`,
    })
  );
}

main().catch((err) => {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
