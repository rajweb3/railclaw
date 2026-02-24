import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { JsonRpcProvider, Interface, zeroPadValue } from 'ethers';
import { config, parseArgs, resolveDataPath } from './lib/config.js';
import { decrypt } from './lib/crypto-utils.js';

/**
 * Full bridge pipeline for Solana → EVM payments.
 *
 * Stage 1 — Watch Solana: Poll temp wallet's USDC ATA for incoming balance.
 * Stage 2 — Bridge:       Fund temp wallet with SOL, call depositV3 on Across SpokePool.
 * Stage 3 — Watch EVM:    Poll settlement chain SpokePool for FilledV3Relay event.
 *
 * Args:
 *   --payment-id       pay_xxx
 *   --source-chain     solana
 *   --settlement-chain polygon | arbitrum
 *   --token            USDC
 *   --amount           100
 *   --wallet           0x...
 *   --timeout          7200   (seconds, default 7200 — bridge can take a few minutes)
 *   --poll-interval    30     (seconds, default 30)
 */

// Minimal ABI for FilledV3Relay event on EVM SpokePool
const EVM_SPOKE_POOL_ABI = [
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
  token: string;
  wallet: string;
  bridge: {
    spoke_pool_source: string;
    spoke_pool_destination: string;
    destination_chain_id: number;
    deposit_address: string;
    temp_wallet_pubkey: string;
    temp_private_key_enc: string;
    input_token_mint: string;
    output_token_address: string;
    raw_input_amount: string;
    raw_output_amount: string;
    fill_deadline: number;
    quote_timestamp: number;
    settlement_wallet: string;
  };
  settlement_chain: string;
  [key: string]: unknown;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Confirm a transaction by polling getSignatureStatuses — no WebSocket needed
async function pollConfirm(connection: Connection, sig: string, maxWaitMs = 120_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    const { value: [status] } = await connection.getSignatureStatuses([sig]);
    if (status?.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
  }
  throw new Error(`Transaction ${sig} not confirmed within ${maxWaitMs / 1000}s`);
}

// Send a transaction and confirm via polling (no WebSocket subscriptions)
async function sendAndPollConfirm(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = signers[0].publicKey;
  transaction.sign(...signers);
  const sig = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false });
  await pollConfirm(connection, sig);
  return sig;
}

// Pad a hex EVM address to a 32-byte Uint8Array
function evmAddressToBytes32(address: string): Uint8Array {
  const clean = address.startsWith('0x') ? address.slice(2) : address;
  const padded = clean.padStart(64, '0');
  return Buffer.from(padded, 'hex');
}

// Derive Across SpokePool PDAs
function deriveSpoolPDAs(programId: PublicKey, inputTokenMint: PublicKey, destinationChainId: number) {
  // State PDA: seeds = ["state", seed(u64 LE)] — seed 0 for initial deployment
  const [statePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('state'), Buffer.alloc(8)], // seed = 0 as 8-byte LE
    programId,
  );

  // Route PDA: seeds = ["routes", input_token_mint, dest_chain_id(u64 LE)]
  const chainIdBuf = Buffer.alloc(8);
  chainIdBuf.writeBigUInt64LE(BigInt(destinationChainId));
  const [routePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('routes'), inputTokenMint.toBuffer(), chainIdBuf],
    programId,
  );

  // Event authority PDA: standard Anchor CPI event authority
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    programId,
  );

  // Vault: ATA of the state PDA for the input token
  const vaultATA = getAssociatedTokenAddressSync(
    inputTokenMint,
    statePDA,
    true,  // allowOwnerOffCurve = true for PDA
    TOKEN_PROGRAM_ID,
  );

  return { statePDA, routePDA, eventAuthority, vaultATA };
}

// Stage 1: Poll Solana for USDC balance at deposit ATA
async function waitForSolanaDeposit(
  connection: Connection,
  depositATA: PublicKey,
  expectedRaw: bigint,
  deadline: number,
  pollMs: number,
  paymentId: string,
): Promise<bigint> {
  console.error(`[monitor-solana-deposit] Stage 1: Watching for USDC at ${depositATA.toString()} (payment ${paymentId})`);

  const slippage = (expectedRaw * 100n) / 10000n; // 1%
  const minExpected = expectedRaw - slippage;
  let errorCount = 0;

  while (Date.now() < deadline) {
    try {
      // Use getTokenAccountBalance (direct RPC) instead of getAccount (SPL helper)
      // — simpler call, more reliable against rate-limited public RPCs
      const balResp = await connection.getTokenAccountBalance(depositATA, 'confirmed');
      const balance = BigInt(balResp.value.amount);
      errorCount = 0;
      if (balance > 0n) {
        console.error(`[monitor-solana-deposit] Stage 1: Balance = ${balance} raw units (need ${minExpected})`);
      }
      if (balance >= minExpected) {
        console.error(`[monitor-solana-deposit] USDC deposit detected: ${balance.toString()} raw units`);
        return balance;
      }
    } catch (err) {
      errorCount++;
      const errStr = String(err);
      // Log first occurrence and every 10th after to avoid spam
      if (errorCount === 1 || errorCount % 10 === 0) {
        const isNotFound = errStr.includes('could not find account') ||
          errStr.includes('AccountNotFound') ||
          errStr.includes('TokenAccountNotFound') ||
          errStr.includes('Invalid param');
        if (isNotFound) {
          console.error(`[monitor-solana-deposit] Stage 1: ATA not yet created (poll #${errorCount}) — waiting for user deposit`);
        } else {
          console.error(`[monitor-solana-deposit] Stage 1 RPC error (poll #${errorCount}): ${errStr}`);
        }
      }
    }
    await sleep(pollMs);
  }
  return 0n;
}

// Stage 2: Fund temp wallet with SOL and call depositV3
async function callDepositV3(
  connection: Connection,
  tempKeypair: Keypair,
  record: PendingRecord,
  actualInputAmount: bigint,
): Promise<string> {
  const programId  = new PublicKey(record.bridge.spoke_pool_source);
  const inputMint  = new PublicKey(record.bridge.input_token_mint);
  const depositATA = new PublicKey(record.bridge.deposit_address);

  // 2a — Fund temp wallet with SOL for fees
  if (config.sol.dispenserKey) {
    console.error('[monitor-solana-deposit] Stage 2a: Funding temp wallet with SOL for fees...');
    const dispenserKeypair = Keypair.fromSecretKey(Buffer.from(config.sol.dispenserKey, 'hex'));
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: dispenserKeypair.publicKey,
        toPubkey:   tempKeypair.publicKey,
        lamports:   config.sol.fundAmountLamports,
      }),
    );
    const fundSig = await sendAndPollConfirm(connection, fundTx, [dispenserKeypair]);
    console.error(`[monitor-solana-deposit] Funded ${config.sol.fundAmountLamports / LAMPORTS_PER_SOL} SOL (tx: ${fundSig})`);
  } else {
    console.error('[monitor-solana-deposit] SOLANA_SOL_DISPENSER_KEY not set — temp wallet must have SOL already');
  }

  // 2b — Derive PDAs
  const { statePDA, routePDA, eventAuthority, vaultATA } = deriveSpoolPDAs(
    programId,
    inputMint,
    record.bridge.destination_chain_id,
  );

  // 2c — Build depositV3 instruction data manually (raw borsh, no Anchor/BN needed)
  // Discriminator = first 8 bytes of SHA256("global:deposit_v3")
  const discriminator = createHash('sha256').update('global:deposit_v3').digest().slice(0, 8);

  const recipientBytes32   = evmAddressToBytes32(record.bridge.settlement_wallet);
  const outputTokenBytes32 = evmAddressToBytes32(record.bridge.output_token_address);
  const outputAmount       = BigInt(record.bridge.raw_output_amount);

  const u64LE = (n: bigint)  => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const u32LE = (n: number)  => { const b = Buffer.alloc(4); b.writeUInt32LE(n);    return b; };

  const data = Buffer.concat([
    discriminator,                                               // [u8; 8]  anchor discriminator
    tempKeypair.publicKey.toBuffer(),                           // depositor:           PublicKey
    Buffer.from(recipientBytes32),                              // recipient:           [u8; 32]
    inputMint.toBuffer(),                                       // inputToken:          PublicKey
    Buffer.from(outputTokenBytes32),                            // outputToken:         [u8; 32]
    u64LE(actualInputAmount),                                   // inputAmount:         u64
    u64LE(outputAmount),                                        // outputAmount:        u64
    u64LE(BigInt(record.bridge.destination_chain_id)),          // destinationChainId:  u64
    Buffer.alloc(32),                                           // exclusiveRelayer:    [u8; 32] (zero)
    u32LE(record.bridge.quote_timestamp),                       // quoteTimestamp:      u32
    u32LE(record.bridge.fill_deadline),                         // fillDeadline:        u32
    u32LE(0),                                                   // exclusivityDeadline: u32
    u32LE(0),                                                   // message length:      u32 (empty bytes)
  ]);

  console.error('[monitor-solana-deposit] Stage 2b: Calling depositV3 on Across SpokePool...');

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: statePDA,               isSigner: false, isWritable: true  },
      { pubkey: routePDA,               isSigner: false, isWritable: false },
      { pubkey: tempKeypair.publicKey,  isSigner: true,  isWritable: true  },
      { pubkey: depositATA,             isSigner: false, isWritable: true  },
      { pubkey: vaultATA,               isSigner: false, isWritable: true  },
      { pubkey: inputMint,              isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
      { pubkey: programId,              isSigner: false, isWritable: false },
      { pubkey: eventAuthority,         isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const depositTx = new Transaction().add(ix);
  const txSig = await sendAndPollConfirm(connection, depositTx, [tempKeypair]);
  console.error(`[monitor-solana-deposit] depositV3 tx: ${txSig}`);
  return txSig;
}

// Stage 3: Watch EVM SpokePool for FilledV3Relay
async function waitForEVMFill(
  record: PendingRecord,
  deadline: number,
  pollMs: number,
): Promise<{ txHash: string; confirmations: number }> {
  const settlementChain = record.settlement_chain;
  const rpcUrl          = config.rpc[settlementChain];
  const spokePoolAddr   = record.bridge.spoke_pool_destination;

  const provider        = new JsonRpcProvider(rpcUrl);
  const iface           = new Interface(EVM_SPOKE_POOL_ABI);
  const filledTopic     = iface.getEvent('FilledV3Relay')!.topicHash;
  const recipientTopic  = zeroPadValue(record.wallet, 32);

  const expectedOutputRaw = BigInt(record.bridge.raw_output_amount);
  const slippageBps       = 100n;
  const minOutput         = (expectedOutputRaw * (10000n - slippageBps)) / 10000n;
  const maxOutput         = (expectedOutputRaw * (10000n + slippageBps)) / 10000n;
  const outputTokenLower  = record.bridge.output_token_address.toLowerCase();

  let fromBlock: number | 'latest' = 'latest';
  try {
    const current = await provider.getBlockNumber();
    const lookback = settlementChain === 'polygon' ? 150 : 1500;
    fromBlock = Math.max(0, current - lookback);
  } catch { /* use 'latest' */ }

  console.error(`[monitor-solana-deposit] Stage 3: Watching FilledV3Relay on ${settlementChain} SpokePool...`);

  while (Date.now() < deadline) {
    try {
      const currentBlock = await provider.getBlockNumber();
      const logs = await provider.getLogs({
        address: spokePoolAddr,
        topics: [filledTopic, null, recipientTopic],
        fromBlock,
        toBlock: currentBlock,
      });

      for (const log of logs) {
        let parsed: ReturnType<Interface['parseLog']>;
        try {
          parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        } catch { continue; }
        if (!parsed) continue;

        const logOutputToken: string = parsed.args['outputToken'];
        const logOutputAmount: bigint = parsed.args['outputAmount'];

        if (
          logOutputToken.toLowerCase() === outputTokenLower &&
          logOutputAmount >= minOutput &&
          logOutputAmount <= maxOutput
        ) {
          const receipt      = await provider.getTransactionReceipt(log.transactionHash);
          const confirmations = receipt ? currentBlock - receipt.blockNumber + 1 : 1;
          return { txHash: log.transactionHash, confirmations };
        }
      }
      fromBlock = currentBlock + 1;
    } catch (err) {
      console.error(`[monitor-solana-deposit] EVM RPC error (will retry): ${String(err)}`);
    }
    await sleep(pollMs);
  }

  throw new Error('FilledV3Relay not found within timeout');
}

async function main() {
  const args = parseArgs(process.argv);

  const paymentId       = args['payment-id'];
  const settlementChain = args['settlement-chain'];
  const timeoutSec      = parseInt(args['timeout']       || '7200');
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

  const connection = new Connection(config.rpc.solana, 'confirmed');
  const depositATA = new PublicKey(record.bridge.deposit_address);
  const expectedRaw = BigInt(record.bridge.raw_input_amount);

  const deadline = Date.now() + timeoutSec * 1000;
  const pollMs   = pollIntervalSec * 1000;

  // Stage 1: Wait for USDC deposit on Solana
  const actualInputAmount = await waitForSolanaDeposit(
    connection, depositATA, expectedRaw, deadline, pollMs, paymentId,
  );

  if (actualInputAmount === 0n) {
    record.status = 'expired';
    (record as Record<string, unknown>).expired_at = new Date().toISOString();
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    console.log(JSON.stringify({
      success: false, status: 'expired', payment_id: paymentId,
      reason: 'No USDC deposit received within timeout',
    }));
    return;
  }

  // Update record: deposit received
  record.status = 'deposit_received';
  (record as Record<string, unknown>).deposit_received_at = new Date().toISOString();
  writeFileSync(recordPath, JSON.stringify(record, null, 2));

  // Decrypt temp private key
  const secretKeyHex = decrypt(record.bridge.temp_private_key_enc, config.encryption.walletKey);
  const tempKeypair  = Keypair.fromSecretKey(Buffer.from(secretKeyHex, 'hex'));

  // Stage 2: Call depositV3 on Across SpokePool
  let depositTxSig: string;
  try {
    depositTxSig = await callDepositV3(connection, tempKeypair, record, actualInputAmount);
  } catch (err) {
    console.log(JSON.stringify({
      success: false, status: 'error', payment_id: paymentId,
      reason: `depositV3 failed: ${String(err)}`,
    }));
    process.exit(1);
  }

  record.status = 'bridging';
  (record as Record<string, unknown>).deposit_tx_sig = depositTxSig;
  (record as Record<string, unknown>).bridging_at    = new Date().toISOString();
  writeFileSync(recordPath, JSON.stringify(record, null, 2));

  // Stage 3: Wait for EVM fill
  let fillResult: { txHash: string; confirmations: number };
  try {
    fillResult = await waitForEVMFill(record, deadline, pollMs);
  } catch (err) {
    record.status = 'expired';
    (record as Record<string, unknown>).expired_at = new Date().toISOString();
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    console.log(JSON.stringify({
      success: false, status: 'expired', payment_id: paymentId,
      reason: String(err),
    }));
    return;
  }

  // Confirmed
  const confirmedAt = new Date().toISOString();
  record.status = 'confirmed';
  (record as Record<string, unknown>).tx_hash      = fillResult.txHash;
  (record as Record<string, unknown>).confirmations = fillResult.confirmations;
  (record as Record<string, unknown>).confirmed_at  = confirmedAt;
  writeFileSync(recordPath, JSON.stringify(record, null, 2));

  console.log(JSON.stringify({
    success:      true,
    status:       'confirmed',
    payment_id:   paymentId,
    tx_hash:      fillResult.txHash,
    confirmations: fillResult.confirmations,
    confirmed_at: confirmedAt,
  }));
}

main().catch((err) => {
  console.log(JSON.stringify({ success: false, error: String(err) }));
  process.exit(1);
});
