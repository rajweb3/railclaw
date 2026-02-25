/**
 * monitor-transaction.ts — Watch blockchain for incoming transfers matching a pending payment.
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
 *   - ERC-20 tokens: quick historical getLogs check, then WebSocket subscription
 *   - Native tokens: block polling (no Transfer event to subscribe to)
 *   - Matches token + amount (with 1% slippage tolerance)
 *   - Waits for required confirmations
 *   - Updates payment record in $RAILCLAW_DATA_DIR/pending/
 *   - Exits on confirmation or timeout
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ethers, WebSocketProvider } from 'ethers';
import { config, parseArgs, resolveDataPath } from './lib/config.js';

const args = parseArgs(process.argv);

const paymentId = args['payment-id'];
const chain = args['chain']?.toLowerCase();
const token = args['token']?.toUpperCase();
const amount = parseFloat(args['amount'] || '0');
const wallet = args['wallet']?.toLowerCase();
const chatId = args['chat-id'] || '';
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

// Free-tier RPCs cap eth_getLogs to 10 blocks per request
const MAX_BLOCK_RANGE = 10;

const startTime = Date.now();
const timeoutMs = timeoutSeconds * 1000;

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

async function waitForConfirmations(txHash: string, txBlock: number): Promise<number> {
  while (Date.now() - startTime < timeoutMs) {
    const currentBlock = await provider.getBlockNumber();
    const confirmations = currentBlock - txBlock + 1;
    if (confirmations >= requiredConfirmations) return confirmations;
    await new Promise((r) => setTimeout(r, pollIntervalSeconds * 1000));
  }
  return 0;
}

// ERC-20: historical getLogs check first, then WebSocket subscription.
// Returns the matching transfer or throws on timeout.
async function waitForERC20Transfer(
  decimals: number,
  minAmount: bigint,
): Promise<{ txHash: string; blockNumber: number }> {
  const wsUrl = rpcUrl.replace('https://', 'wss://');
  const recipientTopic = ethers.zeroPadValue(wallet, 32);

  // Phase 1: Historical check — catches transfers that arrived before monitor started
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - 150);
  console.error(`[monitor] ERC-20 historical check blocks ${fromBlock}–${currentBlock}...`);

  for (let cs = fromBlock; cs <= currentBlock; cs += MAX_BLOCK_RANGE) {
    const ce = Math.min(cs + MAX_BLOCK_RANGE - 1, currentBlock);
    try {
      const logs = await provider.getLogs({
        address: tokenContract,
        topics: [TRANSFER_TOPIC, null, recipientTopic],
        fromBlock: cs,
        toBlock: ce,
      });
      for (const log of logs) {
        if (BigInt(log.data) >= minAmount) {
          console.error(`[monitor] Historical transfer found: ${log.transactionHash}`);
          return { txHash: log.transactionHash, blockNumber: log.blockNumber };
        }
      }
    } catch { /* skip chunk */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Phase 2: WebSocket subscription — instant notification on new Transfer
  console.error(`[monitor] No historical transfer found — subscribing via WebSocket...`);
  const wsProvider = new WebSocketProvider(wsUrl);

  return new Promise<{ txHash: string; blockNumber: number }>((resolve, reject) => {
    const remaining = timeoutMs - (Date.now() - startTime);
    if (remaining <= 0) {
      wsProvider.destroy();
      reject(new Error('timeout'));
      return;
    }

    const timeoutHandle = setTimeout(() => {
      wsProvider.destroy();
      reject(new Error('timeout'));
    }, remaining);

    wsProvider.on(
      { address: tokenContract, topics: [TRANSFER_TOPIC, null, recipientTopic] },
      (log) => {
        if (BigInt(log.data) < minAmount) return;
        clearTimeout(timeoutHandle);
        wsProvider.destroy();
        console.error(`[monitor] WebSocket Transfer detected: ${log.transactionHash}`);
        resolve({ txHash: log.transactionHash, blockNumber: log.blockNumber });
      },
    );
  });
}

// Native token path: block polling (no Transfer event to subscribe to)
async function pollForNativeTransfer(): Promise<{ txHash: string; blockNumber: number } | null> {
  let lastCheckedBlock = 0;
  while (Date.now() - startTime < timeoutMs) {
    try {
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = lastCheckedBlock > 0 ? lastCheckedBlock + 1 : currentBlock - 5;
      for (let b = fromBlock; b <= currentBlock; b++) {
        const block = await provider.getBlock(b, true);
        if (!block?.prefetchedTransactions) continue;
        for (const tx of block.prefetchedTransactions) {
          if (
            tx.to?.toLowerCase() === wallet &&
            parseFloat(ethers.formatEther(tx.value)) >= amount * 0.99
          ) {
            return { txHash: tx.hash, blockNumber: b };
          }
        }
      }
      lastCheckedBlock = currentBlock;
    } catch (err: any) {
      console.error(`[monitor] Poll error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalSeconds * 1000));
  }
  return null;
}

async function main() {
  console.error(`[monitor] ${paymentId}: ${amount} ${token} on ${chain} → ${wallet}`);
  console.error(`[monitor] timeout=${timeoutSeconds}s, confirmations=${requiredConfirmations}`);

  let txHash: string;
  let txBlock: number;

  const nativeTokens = ['ETH', 'MATIC', 'AVAX', 'BNB', 'SOL'];

  if (nativeTokens.includes(token)) {
    const result = await pollForNativeTransfer();
    if (!result) {
      updatePaymentRecord('expired');
      console.log(JSON.stringify({
        success: false, status: 'expired', payment_id: paymentId,
        reason: `No matching transaction within ${timeoutSeconds}s`,
      }));
      return;
    }
    txHash = result.txHash;
    txBlock = result.blockNumber;
  } else if (tokenContract) {
    const decimals = await getTokenDecimals(tokenContract);
    const expectedAmount = ethers.parseUnits(amount.toString(), decimals);
    const minAmount = (expectedAmount * 99n) / 100n; // 1% slippage
    try {
      const result = await waitForERC20Transfer(decimals, minAmount);
      txHash = result.txHash;
      txBlock = result.blockNumber;
    } catch {
      updatePaymentRecord('expired');
      console.log(JSON.stringify({
        success: false, status: 'expired', payment_id: paymentId,
        reason: `No matching transaction within ${timeoutSeconds}s`,
      }));
      return;
    }
  } else {
    console.log(JSON.stringify({ success: false, error: `No contract address for ${token} on ${chain}` }));
    process.exit(1);
  }

  console.error(`[monitor] TX found: ${txHash} at block ${txBlock}`);
  updatePaymentRecord('confirming', txHash, 0);

  const finalConfirmations = await waitForConfirmations(txHash, txBlock);

  if (finalConfirmations >= requiredConfirmations) {
    const confirmedAt = new Date().toISOString();
    updatePaymentRecord('confirmed', txHash, finalConfirmations);

    // Write notification for product bot to pick up on next request
    try {
      const notifDir = resolveDataPath('notifications');
      mkdirSync(notifDir, { recursive: true });
      writeFileSync(
        join(notifDir, `${paymentId}.json`),
        JSON.stringify({
          type: 'direct_confirmed',
          payment_id: paymentId,
          tx_hash: txHash,
          confirmations: finalConfirmations,
          chain,
          token,
          amount,
          confirmed_at: confirmedAt,
        }, null, 2)
      );
    } catch (err: any) {
      console.error(`Warning: Could not write notification: ${err.message}`);
    }

    // Send Telegram confirmation directly if we have chat_id
    const botToken = process.env.TELEGRAM_BOT_TOKEN_PRODUCT;
    if (chatId && botToken) {
      try {
        const text =
          `✅ <b>Payment Confirmed!</b>\n\n` +
          `💰 <b>${amount} ${token}</b> received on ${chain}\n` +
          `📦 Payment: <code>${paymentId}</code>\n` +
          `🔗 Tx: <code>${txHash}</code>`;
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
        });
        console.error(`[monitor] Telegram confirmation sent to chat ${chatId}`);
      } catch (err: any) {
        console.error(`Warning: Could not send Telegram notification: ${err.message}`);
      }
    }

    console.log(JSON.stringify({
      success: true,
      status: 'confirmed',
      payment_id: paymentId,
      tx_hash: txHash,
      chain,
      token,
      amount,
      confirmations: finalConfirmations,
      confirmed_at: confirmedAt,
    }));
    process.exit(0);
  }

  // Timed out waiting for confirmations
  updatePaymentRecord('expired');
  console.log(JSON.stringify({
    success: false,
    status: 'expired',
    payment_id: paymentId,
    reason: `Transaction found but did not reach ${requiredConfirmations} confirmations within ${timeoutSeconds}s`,
  }));
}

main().catch((err) => {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
