import { readFileSync, writeFileSync } from 'fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
} from '@solana/spl-token';
import { AnchorProvider, Program, BN, type Idl } from '@coral-xyz/anchor';
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

// Minimal Across Solana SpokePool IDL for depositV3 only.
// Program: DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru
const SPOKE_POOL_IDL: Idl = {
  version: '0.1.0',
  name: 'svm_spoke',
  instructions: [
    {
      name: 'depositV3',
      accounts: [
        { name: 'state',              isMut: true,  isSigner: false },
        { name: 'route',              isMut: false, isSigner: false },
        { name: 'signer',             isMut: true,  isSigner: true  },
        { name: 'userTokenAccount',   isMut: true,  isSigner: false },
        { name: 'relayerTokenAccount',isMut: true,  isSigner: false },
        { name: 'mint',               isMut: false, isSigner: false },
        { name: 'tokenProgram',       isMut: false, isSigner: false },
        { name: 'program',            isMut: false, isSigner: false },
        { name: 'eventAuthority',     isMut: false, isSigner: false },
        { name: 'systemProgram',      isMut: false, isSigner: false },
      ],
      args: [
        { name: 'depositor',           type: 'publicKey'             },
        { name: 'recipient',           type: { array: ['u8', 32] }   },
        { name: 'inputToken',          type: 'publicKey'             },
        { name: 'outputToken',         type: { array: ['u8', 32] }   },
        { name: 'inputAmount',         type: 'u64'                   },
        { name: 'outputAmount',        type: 'u64'                   },
        { name: 'destinationChainId',  type: 'u64'                   },
        { name: 'exclusiveRelayer',    type: { array: ['u8', 32] }   },
        { name: 'quoteTimestamp',      type: 'u32'                   },
        { name: 'fillDeadline',        type: 'u32'                   },
        { name: 'exclusivityDeadline', type: 'u32'                   },
        { name: 'message',             type: 'bytes'                 },
      ],
    },
  ],
  accounts: [],
  types: [],
  errors: [],
  events: [],
  metadata: { address: 'DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru' },
};

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

  while (Date.now() < deadline) {
    try {
      const acct = await getAccount(connection, depositATA, 'confirmed', TOKEN_PROGRAM_ID);
      const balance = acct.amount;
      if (balance >= minExpected) {
        console.error(`[monitor-solana-deposit] USDC deposit detected: ${balance.toString()} raw units`);
        return balance;
      }
    } catch {
      // Account doesn't exist yet — user hasn't sent yet
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
  const programId    = new PublicKey(record.bridge.spoke_pool_source);
  const inputMint    = new PublicKey(record.bridge.input_token_mint);
  const depositATA   = new PublicKey(record.bridge.deposit_address);

  // 2a — Fund temp wallet with SOL for fees
  if (config.sol.dispenserKey) {
    console.error('[monitor-solana-deposit] Stage 2a: Funding temp wallet with SOL for fees...');
    const dispenserKeypair = Keypair.fromSecretKey(
      Buffer.from(config.sol.dispenserKey, 'hex'),
    );
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: dispenserKeypair.publicKey,
        toPubkey:   tempKeypair.publicKey,
        lamports:   config.sol.fundAmountLamports,
      }),
    );
    await sendAndConfirmTransaction(connection, fundTx, [dispenserKeypair], { commitment: 'confirmed' });
    console.error(`[monitor-solana-deposit] Funded ${config.sol.fundAmountLamports / LAMPORTS_PER_SOL} SOL`);
  } else {
    console.error('[monitor-solana-deposit] SOLANA_SOL_DISPENSER_KEY not set — temp wallet must have SOL already');
  }

  // 2b — Derive PDAs
  const { statePDA, routePDA, eventAuthority, vaultATA } = deriveSpoolPDAs(
    programId,
    inputMint,
    record.bridge.destination_chain_id,
  );

  // 2c — Build Anchor provider and program
  const wallet = {
    publicKey:            tempKeypair.publicKey,
    signTransaction:      async (tx: Transaction) => { tx.sign(tempKeypair); return tx; },
    signAllTransactions:  async (txs: Transaction[]) => { txs.forEach(t => t.sign(tempKeypair)); return txs; },
  };
  const provider = new AnchorProvider(connection, wallet as never, { commitment: 'confirmed' });

  // Try to fetch IDL from on-chain; fall back to our minimal built-in IDL
  let idl: Idl = SPOKE_POOL_IDL;
  try {
    const fetched = await Program.fetchIdl(programId, provider);
    if (fetched) {
      idl = fetched;
      console.error('[monitor-solana-deposit] Using on-chain IDL');
    }
  } catch {
    console.error('[monitor-solana-deposit] On-chain IDL fetch failed — using built-in IDL');
  }

  const program = new Program(idl, provider);

  // 2d — Prepare depositV3 arguments
  const recipientBytes32     = evmAddressToBytes32(record.bridge.settlement_wallet);
  const outputTokenBytes32   = evmAddressToBytes32(record.bridge.output_token_address);
  const exclusiveRelayerZero = new Uint8Array(32);

  const outputAmount = BigInt(record.bridge.raw_output_amount);
  const now          = Math.floor(Date.now() / 1000);

  console.error('[monitor-solana-deposit] Stage 2b: Calling depositV3 on Across SpokePool...');

  const txSig = await (program.methods as unknown as {
    depositV3: (
      depositor: PublicKey, recipient: Buffer, inputToken: PublicKey, outputToken: Buffer,
      inputAmount: BN, outputAmount: BN, destinationChainId: BN, exclusiveRelayer: Buffer,
      quoteTimestamp: number, fillDeadline: number, exclusivityDeadline: number, message: Buffer,
    ) => { accounts: (a: object) => { rpc: () => Promise<string> } }
  }).depositV3(
    tempKeypair.publicKey,
    Buffer.from(recipientBytes32),
    inputMint,
    Buffer.from(outputTokenBytes32),
    new BN(actualInputAmount.toString()),
    new BN(outputAmount.toString()),
    new BN(record.bridge.destination_chain_id),
    Buffer.from(exclusiveRelayerZero),
    record.bridge.quote_timestamp,
    record.bridge.fill_deadline,
    0, // exclusivityDeadline
    Buffer.alloc(0), // empty message
  ).accounts({
    state:               statePDA,
    route:               routePDA,
    signer:              tempKeypair.publicKey,
    userTokenAccount:    depositATA,
    relayerTokenAccount: vaultATA,
    mint:                inputMint,
    tokenProgram:        TOKEN_PROGRAM_ID,
    program:             programId,
    eventAuthority,
    systemProgram:       SystemProgram.programId,
  }).rpc();

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
