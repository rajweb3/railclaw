import { writeFileSync } from 'fs';
import {
  Keypair,
  PublicKey,
  Connection,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { config, parseArgs, resolveDataPath } from './lib/config.js';
import { generateId, encrypt } from './lib/crypto-utils.js';

/**
 * Generate a temporary Solana keypair for receiving a bridge payment.
 *
 * Flow:
 *   1. Generate a one-time Solana keypair
 *   2. Derive its USDC Associated Token Account (ATA) — this is where the user sends
 *   3. Encrypt and store the temp private key in the payment record
 *   4. Return deposit_address (ATA) so the user knows where to send USDC
 *
 * A background monitor (monitor-solana-deposit.ts) watches for USDC arrival at the
 * deposit_address, then automatically calls depositV3 on the Across SpokePool and
 * bridges the funds to the business wallet on the settlement chain.
 *
 * Args:
 *   --source-chain     solana
 *   --settlement-chain polygon | arbitrum
 *   --token            USDC
 *   --amount           100            (amount business will receive)
 *   --wallet           0x...          (business EVM wallet on settlement chain)
 *   --business         "Acme Corp"
 *   --business-id      biz_xxx
 */

const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6, USDT: 6, DAI: 18, WETH: 18,
};

function toRawAmount(human: number, decimals: number): bigint {
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

  const sourceChain     = args['source-chain'];
  const settlementChain = args['settlement-chain'];
  const token           = args['token']?.toUpperCase();
  const amount          = parseFloat(args['amount']);
  const wallet          = args['wallet'];
  const businessName    = args['business'];
  const businessId      = args['business-id'];

  if (!sourceChain || !settlementChain || !token || !amount || !wallet || !businessName || !businessId) {
    console.log(JSON.stringify({ success: false, error: 'Missing required arguments' }));
    process.exit(1);
  }

  if (sourceChain !== 'solana') {
    console.log(JSON.stringify({ success: false, error: `bridge-payment.ts only handles Solana source chain, got: ${sourceChain}` }));
    process.exit(1);
  }

  // Validate chain/token support
  const spokePoolSource = config.bridge.spokePools[sourceChain];
  const spokePoolDest   = config.bridge.spokePools[settlementChain];
  if (!spokePoolSource || !spokePoolDest) {
    console.log(JSON.stringify({ success: false, error: `Unsupported chain pair: ${sourceChain} → ${settlementChain}` }));
    process.exit(1);
  }

  const inputTokenMint  = config.tokens[sourceChain]?.[token];
  const outputTokenAddr = config.tokens[settlementChain]?.[token];
  if (!inputTokenMint || !outputTokenAddr) {
    console.log(JSON.stringify({ success: false, error: `Token ${token} not supported on ${sourceChain} or ${settlementChain}` }));
    process.exit(1);
  }

  if (!config.encryption.walletKey) {
    console.log(JSON.stringify({ success: false, error: 'WALLET_ENCRYPTION_KEY is not set' }));
    process.exit(1);
  }

  const decimals = TOKEN_DECIMALS[token] ?? 6;

  // Estimate relay fee: max(pct-based, minimum buffer)
  const pctFee    = amount * config.bridge.estimatedRelayFeePct;
  const relayFee  = Math.max(pctFee, config.bridge.minRelayFeeBuffer);
  const inputAmt  = amount + relayFee; // user sends this
  const outputAmt = amount;            // business receives this

  const rawInputAmount  = toRawAmount(inputAmt, decimals);
  const rawOutputAmount = toRawAmount(outputAmt, decimals);

  // depositV3 timing
  const now          = Math.floor(Date.now() / 1000);
  const fillDeadline = now + config.bridge.fillDeadlineOffsetSec;

  // --- Generate one-time Solana keypair ---
  const tempKeypair = Keypair.generate();

  // Derive the USDC Associated Token Account for the temp wallet.
  // This is the address the user sends USDC to — it's deterministic and doesn't
  // need to exist yet (modern Solana wallets create it on first transfer).
  const usdcMint = new PublicKey(inputTokenMint);
  const depositATA = getAssociatedTokenAddressSync(
    usdcMint,
    tempKeypair.publicKey,
    false,           // allowOwnerOffCurve — false for regular keypair
    TOKEN_PROGRAM_ID,
  );

  // Encrypt and store the temp private key so monitor-solana-deposit.ts can use it
  const encryptedPrivKey = encrypt(
    Buffer.from(tempKeypair.secretKey).toString('hex'),
    config.encryption.walletKey,
  );

  const paymentId = generateId('pay');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + config.payment.defaultExpiryHours * 60 * 60 * 1000);

  const record = {
    payment_id:       paymentId,
    status:           'waiting_deposit',
    source_chain:     sourceChain,
    settlement_chain: settlementChain,
    token,
    amount,
    wallet,
    business_name:    businessName,
    business_id:      businessId,
    bridge: {
      provider:               'across',
      spoke_pool_source:      spokePoolSource,
      spoke_pool_destination: spokePoolDest,
      origin_chain_id:        config.bridge.acrossChainIds[sourceChain],
      destination_chain_id:   config.bridge.acrossChainIds[settlementChain],
      // Temp Solana keypair — private key encrypted at rest
      temp_wallet_pubkey:     tempKeypair.publicKey.toString(),
      deposit_address:        depositATA.toString(),   // user sends USDC here
      temp_private_key_enc:   encryptedPrivKey,
      // Token details
      input_token_mint:       inputTokenMint,          // USDC mint on Solana
      output_token_address:   outputTokenAddr,         // USDC contract on EVM
      // Amounts
      raw_input_amount:       rawInputAmount.toString(),
      raw_output_amount:      rawOutputAmount.toString(),
      relay_fee:              relayFee.toFixed(decimals > 6 ? 6 : decimals),
      // depositV3 parameters
      fill_deadline:          fillDeadline,
      quote_timestamp:        now,
      // Settlement
      settlement_wallet:      wallet,
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
      // User sends USDC to this Solana address
      network:          'solana',
      deposit_address:  depositATA.toString(),
      token,
      amount_to_send:   toHuman(rawInputAmount, decimals),
      relay_fee:        relayFee.toFixed(2),
      business_receives: toHuman(rawOutputAmount, decimals),
      settlement_chain: settlementChain,
      settlement_wallet: wallet,
      note: 'Send USDC to deposit_address. Funds bridge automatically to settlement chain.',
    },
    expires_at: expiresAt.toISOString(),
  }));
}

main().catch((err) => {
  console.log(JSON.stringify({ success: false, error: String(err) }));
  process.exit(1);
});
