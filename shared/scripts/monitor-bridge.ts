import { readFileSync, writeFileSync } from 'fs';
import { JsonRpcProvider, Interface, zeroPadValue } from 'ethers';
import { config, parseArgs, resolveDataPath } from './lib/config.js';

/**
 * Monitor an Across bridge payment by watching FilledV3Relay events directly
 * on the EVM SpokePool contract. No Across API is used.
 *
 * The business receives funds when a relayer fills the deposit on the settlement
 * chain (Polygon or Arbitrum). We detect this by filtering SpokePool logs for
 * FilledV3Relay events where recipient = business wallet and outputAmount matches.
 *
 * SpokePool addresses:
 *   Polygon:  0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096
 *   Arbitrum: 0xe35e9842fceaca96570b734083f4a58e8f7c5f2a
 *
 * Args:
 *   --payment-id       pay_xxx
 *   --source-chain     solana
 *   --settlement-chain polygon | arbitrum
 *   --token            USDC
 *   --amount           100
 *   --wallet           0x...
 *   --timeout          3600   (seconds, default 3600)
 *   --poll-interval    30     (seconds, default 30)
 */

// Minimal ABI for the FilledV3Relay event.
// Indexed fields: depositor (topics[1]), recipient (topics[2])
// Non-indexed: inputToken, outputToken, inputAmount, outputAmount, ...
const SPOKE_POOL_ABI = [
  'event FilledV3Relay(' +
    'address inputToken,' +
    'address outputToken,' +
    'uint256 inputAmount,' +
    'uint256 outputAmount,' +
    'uint256 repaymentChainId,' +
    'uint256 originChainId,' +
    'uint32 depositId,' +
    'uint32 fillDeadline,' +
    'uint32 exclusivityDeadline,' +
    'address exclusiveRelayer,' +
    'address indexed depositor,' +
    'address indexed recipient,' +
    'bytes message,' +
    'tuple(address updatedRecipient, bytes updatedMessage, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo' +
  ')',
];

interface PendingRecord {
  payment_id: string;
  status: string;
  bridge: {
    spoke_pool_destination: string;
    output_token: string;
    raw_output_amount: string;
    fill_deadline: number;
  };
  wallet: string;
  [key: string]: unknown;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv);

  const paymentId = args['payment-id'];
  const settlementChain = args['settlement-chain'];
  const timeoutSec = parseInt(args['timeout'] || '3600');
  const pollIntervalSec = parseInt(args['poll-interval'] || '30');

  if (!paymentId || !settlementChain) {
    console.log(JSON.stringify({ success: false, error: 'Missing required arguments' }));
    process.exit(1);
  }

  const recordPath = `${resolveDataPath('pending')}/${paymentId}.json`;
  let record: PendingRecord;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf-8')) as PendingRecord;
  } catch {
    console.log(JSON.stringify({ success: false, error: `Payment record not found: ${paymentId}` }));
    process.exit(1);
  }

  const rpcUrl = config.rpc[settlementChain];
  const spokePoolAddress = record.bridge.spoke_pool_destination;

  if (!rpcUrl || !spokePoolAddress) {
    console.log(JSON.stringify({ success: false, error: `Missing RPC or SpokePool address for ${settlementChain}` }));
    process.exit(1);
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const iface = new Interface(SPOKE_POOL_ABI);

  const filledRelayTopic = iface.getEvent('FilledV3Relay')!.topicHash;

  // Pad recipient address to 32 bytes for topic filtering (indexed address)
  const recipientTopic = zeroPadValue(record.wallet, 32);

  const expectedOutputRaw = BigInt(record.bridge.raw_output_amount);
  const outputTokenLower = record.bridge.output_token.toLowerCase();

  // Allow 1% slippage on output amount match
  const slippageBps = 100n; // 1%
  const minOutput = (expectedOutputRaw * (10000n - slippageBps)) / 10000n;
  const maxOutput = (expectedOutputRaw * (10000n + slippageBps)) / 10000n;

  const deadline = Date.now() + timeoutSec * 1000;
  const pollMs = pollIntervalSec * 1000;

  // Poll from the block ~5 minutes before the payment was created so we don't miss fast relays.
  // ethers v6 getLogs expects a number (or "latest") for fromBlock/toBlock — not a decimal string.
  let fromBlock: number | 'latest' = 'latest';
  try {
    const currentBlock = await provider.getBlockNumber();
    // ~5 min ago: Polygon ~150 blocks (2s/block), Arbitrum ~1500 blocks (0.25s/block)
    const lookback = settlementChain === 'polygon' ? 150 : 1500;
    fromBlock = Math.max(0, currentBlock - lookback);
  } catch {
    fromBlock = 'latest';
  }

  console.error(
    `[monitor-bridge] Watching FilledV3Relay on ${settlementChain} SpokePool ${spokePoolAddress} ` +
    `for recipient ${record.wallet} (payment ${paymentId})`
  );

  while (Date.now() < deadline) {
    try {
      const currentBlock = await provider.getBlockNumber();

      const logs = await provider.getLogs({
        address: spokePoolAddress,
        topics: [
          filledRelayTopic,
          null,               // depositor — any
          recipientTopic,     // recipient — business wallet (indexed)
        ],
        fromBlock,
        toBlock: currentBlock,
      });

      for (const log of logs) {
        let parsed: ReturnType<Interface['parseLog']>;
        try {
          parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        } catch {
          continue;
        }
        if (!parsed) continue;

        const logOutputToken: string = parsed.args['outputToken'];
        const logOutputAmount: bigint = parsed.args['outputAmount'];

        const tokenMatch = logOutputToken.toLowerCase() === outputTokenLower;
        const amountMatch = logOutputAmount >= minOutput && logOutputAmount <= maxOutput;

        if (tokenMatch && amountMatch) {
          // Match found — get confirmation count
          const receipt = await provider.getTransactionReceipt(log.transactionHash);
          const confirmations = receipt ? currentBlock - receipt.blockNumber + 1 : 1;
          const confirmedAt = new Date().toISOString();

          record.status = 'confirmed';
          (record as Record<string, unknown>).tx_hash = log.transactionHash;
          (record as Record<string, unknown>).confirmations = confirmations;
          (record as Record<string, unknown>).confirmed_at = confirmedAt;
          (record as Record<string, unknown>).fill_block = log.blockNumber;
          (record as Record<string, unknown>).deposit_id = parsed.args['depositId'].toString();
          writeFileSync(recordPath, JSON.stringify(record, null, 2));

          console.log(JSON.stringify({
            success: true,
            status: 'confirmed',
            payment_id: paymentId,
            tx_hash: log.transactionHash,
            confirmations,
            confirmed_at: confirmedAt,
          }));
          process.exit(0);
        }
      }

      // Advance fromBlock for next poll so we don't re-scan old blocks
      fromBlock = currentBlock + 1;
    } catch (err) {
      // transient RPC error — keep polling
      console.error(`[monitor-bridge] RPC error (will retry): ${String(err)}`);
    }

    await sleep(pollMs);
  }

  // Timeout
  record.status = 'expired';
  (record as Record<string, unknown>).expired_at = new Date().toISOString();
  writeFileSync(recordPath, JSON.stringify(record, null, 2));

  console.log(JSON.stringify({
    success: false,
    status: 'expired',
    payment_id: paymentId,
    reason: 'FilledV3Relay event not found within timeout',
  }));
}

main().catch((err) => {
  console.log(JSON.stringify({ success: false, error: String(err) }));
  process.exit(1);
});
