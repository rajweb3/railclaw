import { writeFileSync } from 'fs';
import { config, parseArgs, resolveDataPath } from './lib/config.js';
import { generateId } from './lib/crypto-utils.js';

/**
 * Generate Across Protocol depositV3 parameters for a Solana → EVM bridge payment.
 * No Across API is used — all parameters are computed locally and the user submits
 * the depositV3 transaction to the Solana SpokePool directly from their wallet.
 *
 * Reference:
 *   Solana SpokePool program: DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru
 *   Polygon SpokePool:        0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096
 *   Arbitrum SpokePool:       0xe35e9842fceaca96570b734083f4a58e8f7c5f2a
 *
 * Args:
 *   --source-chain     solana
 *   --settlement-chain polygon | arbitrum
 *   --token            USDC
 *   --amount           100            (amount business will receive, in human-readable units)
 *   --wallet           0x...          (business EVM wallet on settlement chain)
 *   --business         "Acme Corp"
 *   --business-id      biz_xxx
 */

// USDC / USDT use 6 decimals; DAI / WETH use 18
const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
  USDT: 6,
  DAI: 18,
  WETH: 18,
};

function toRawAmount(human: number, decimals: number): bigint {
  // Avoid floating-point precision issues by rounding to the nearest integer unit
  return BigInt(Math.round(human * 10 ** decimals));
}

function toHuman(raw: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
}

async function main() {
  const args = parseArgs(process.argv);

  const sourceChain = args['source-chain'];
  const settlementChain = args['settlement-chain'];
  const token = args['token']?.toUpperCase();
  const amount = parseFloat(args['amount']);
  const wallet = args['wallet'];
  const businessName = args['business'];
  const businessId = args['business-id'];

  if (!sourceChain || !settlementChain || !token || !amount || !wallet || !businessName || !businessId) {
    console.log(JSON.stringify({ success: false, error: 'Missing required arguments' }));
    process.exit(1);
  }

  // Validate chain support
  const spokePoolSource = config.bridge.spokePools[sourceChain];
  const spokePoolDest = config.bridge.spokePools[settlementChain];
  if (!spokePoolSource || !spokePoolDest) {
    console.log(JSON.stringify({ success: false, error: `Unsupported chain pair: ${sourceChain} → ${settlementChain}` }));
    process.exit(1);
  }

  // Resolve token addresses
  const inputTokenAddress = config.tokens[sourceChain]?.[token];
  const outputTokenAddress = config.tokens[settlementChain]?.[token];
  if (!inputTokenAddress || !outputTokenAddress) {
    console.log(JSON.stringify({ success: false, error: `Token ${token} not supported on ${sourceChain} or ${settlementChain}` }));
    process.exit(1);
  }

  const decimals = TOKEN_DECIMALS[token] ?? 6;

  // Estimate relay fee: max(pct-based, minimum buffer)
  const pctFee = amount * config.bridge.estimatedRelayFeePct;
  const relayFee = Math.max(pctFee, config.bridge.minRelayFeeBuffer);
  const amountToSend = amount + relayFee; // user sends this on source chain
  const outputAmount = amount;            // business receives exactly this

  const rawInputAmount = toRawAmount(amountToSend, decimals);
  const rawOutputAmount = toRawAmount(outputAmount, decimals);
  const rawRelayFee = toRawAmount(relayFee, decimals);

  // depositV3 timing parameters
  const now = Math.floor(Date.now() / 1000);
  const fillDeadline = now + config.bridge.fillDeadlineOffsetSec; // 6 hours
  const quoteTimestamp = now;

  const destinationChainId = config.bridge.acrossChainIds[settlementChain];

  // Build the depositV3 instruction parameters the user submits to the Solana SpokePool
  const depositParams = {
    depositor: '<user_solana_wallet>',           // filled by user's wallet at signing time
    recipient: wallet,                            // business EVM address on settlement chain
    inputToken: inputTokenAddress,                // USDC on Solana
    outputToken: outputTokenAddress,              // USDC on destination EVM chain
    inputAmount: rawInputAmount.toString(),
    outputAmount: rawOutputAmount.toString(),
    destinationChainId,
    exclusiveRelayer: '0x0000000000000000000000000000000000000000',
    quoteTimestamp,
    fillDeadline,
    exclusivityDeadline: 0,                       // no exclusive relayer
    message: '',                                  // empty bytes
  };

  // Create the pending payment record
  const paymentId = generateId('pay');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + config.payment.defaultExpiryHours * 60 * 60 * 1000);

  const record = {
    payment_id: paymentId,
    status: 'waiting_deposit',
    source_chain: sourceChain,
    settlement_chain: settlementChain,
    token,
    amount,
    wallet,
    business_name: businessName,
    business_id: businessId,
    bridge: {
      provider: 'across',
      spoke_pool_source: spokePoolSource,
      spoke_pool_destination: spokePoolDest,
      origin_chain_id: config.bridge.acrossChainIds[sourceChain],
      destination_chain_id: destinationChainId,
      input_token: inputTokenAddress,
      output_token: outputTokenAddress,
      raw_input_amount: rawInputAmount.toString(),
      raw_output_amount: rawOutputAmount.toString(),
      raw_relay_fee: rawRelayFee.toString(),
      fill_deadline: fillDeadline,
      quote_timestamp: quoteTimestamp,
      deposit_params: depositParams,
    },
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  const pendingDir = resolveDataPath('pending');
  writeFileSync(`${pendingDir}/${paymentId}.json`, JSON.stringify(record, null, 2));

  console.log(JSON.stringify({
    success: true,
    payment_id: paymentId,
    bridge_instructions: {
      // Human-facing instructions for the paying user
      network: sourceChain,
      spoke_pool_program: spokePoolSource,
      token,
      input_token_address: inputTokenAddress,
      amount_to_send: toHuman(rawInputAmount, decimals),
      relay_fee_estimate: toHuman(rawRelayFee, decimals),
      expected_output: toHuman(rawOutputAmount, decimals),
      settlement_chain: settlementChain,
      settlement_wallet: wallet,
      fill_deadline_unix: fillDeadline,
      // Raw depositV3 parameters for programmatic submission
      deposit_params: depositParams,
    },
    expires_at: expiresAt.toISOString(),
  }));
}

main().catch((err) => {
  console.log(JSON.stringify({ success: false, error: String(err) }));
  process.exit(1);
});
