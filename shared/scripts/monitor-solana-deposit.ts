import { readFileSync, writeFileSync } from 'fs';
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
  createApproveCheckedInstruction,
} from '@solana/spl-token';
import { JsonRpcProvider, WebSocketProvider, Interface, zeroPadValue, toBeHex, keccak256 } from 'ethers';
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

// Minimal ABI for FilledRelay event on EVM SpokePool (Across V3 non-EVM / bytes32 format)
// Event name: "FilledRelay" (not "FilledV3Relay") — topic[0] = 0x44b559f1...
// All address-like fields are bytes32; depositId is uint256 (supports non-EVM chain IDs)
// Indexed fields: originChainId (topic[1]), depositId (topic[2]), relayer (topic[3])
// recipient and outputToken are NOT indexed — checked via isMatchingLog from parsed args
const EVM_SPOKE_POOL_ABI = [
  'event FilledRelay(' +
    'bytes32 inputToken,' +
    'bytes32 outputToken,' +
    'uint256 inputAmount,' +
    'uint256 outputAmount,' +
    'uint256 repaymentChainId,' +
    'uint256 indexed originChainId,' +
    'uint256 indexed depositId,' +
    'uint32 fillDeadline,' +
    'uint32 exclusivityDeadline,' +
    'bytes32 exclusiveRelayer,' +
    'bytes32 indexed relayer,' +
    'bytes32 depositor,' +
    'bytes32 recipient,' +
    'bytes32 messageHash,' +
    'tuple(bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo' +
  ')',
];


interface PendingRecord {
  payment_id: string;
  status: string;
  token: string;
  wallet: string;
  source_chain: string;
  amount: number;
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

// Pad a hex EVM address to a 32-byte Uint8Array (left-padded, matching EVM abi.encode)
function evmAddressToBytes32(address: string): Uint8Array {
  const clean = address.startsWith('0x') ? address.slice(2) : address;
  const padded = clean.padStart(64, '0');
  return Buffer.from(padded, 'hex');
}

// Encode a u64 as a 32-byte big-endian buffer (EVM uint256 style)
function u64ToBEBytes32(n: bigint): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeBigUInt64BE(n, 24); // 8 bytes at offset 24 (last 8 bytes)
  return buf;
}

// Derive Across SpokePool static PDAs (state, event_authority, vault)
function deriveSpoolPDAs(programId: PublicKey, inputTokenMint: PublicKey) {
  // State PDA: seeds = ["state", 0 as u64 LE] — seed 0 for mainnet deployment
  const [statePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('state'), Buffer.alloc(8)],
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
    true,            // allowOwnerOffCurve = true for PDA
    TOKEN_PROGRAM_ID,
  );

  return { statePDA, eventAuthority, vaultATA };
}

// Derive the deposit delegate PDA.
// Seeds: ["delegate", keccak256(borsh_serialize(deposit_params))]
// The on-chain program uses this PDA as authority to pull tokens from depositor's ATA.
function computeDelegatePDA(
  programId:           PublicKey,
  depositor:           PublicKey,
  recipient:           Uint8Array,   // 32 bytes (EVM addr padded)
  inputToken:          PublicKey,
  outputToken:         Uint8Array,   // 32 bytes (EVM addr padded)
  inputAmount:         bigint,
  outputAmount:        Uint8Array,   // 32 bytes big-endian
  destinationChainId:  bigint,
  exclusiveRelayer:    Uint8Array,   // 32 bytes (zeros = no exclusivity)
  quoteTimestamp:      number,
  fillDeadline:        number,
  exclusivityParameter: number,
  message:             Uint8Array,
): PublicKey {
  // Borsh serialization of DepositSeedData struct (matches on-chain schema)
  const u64LE = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const u32LE = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n);    return b; };

  const serialized = Buffer.concat([
    depositor.toBuffer(),           // [32]  depositor
    Buffer.from(recipient),         // [32]  recipient
    inputToken.toBuffer(),          // [32]  inputToken
    Buffer.from(outputToken),       // [32]  outputToken
    u64LE(inputAmount),             // u64   inputAmount
    Buffer.from(outputAmount),      // [32]  outputAmount (big-endian u256)
    u64LE(destinationChainId),      // u64   destinationChainId
    Buffer.from(exclusiveRelayer),  // [32]  exclusiveRelayer
    u32LE(quoteTimestamp),          // u32   quoteTimestamp
    u32LE(fillDeadline),            // u32   fillDeadline
    u32LE(exclusivityParameter),    // u32   exclusivityParameter
    u32LE(message.length),          // u32   message length prefix
    Buffer.from(message),           // [u8]  message bytes
  ]);

  // keccak256 hash → PDA seed
  const hashHex   = keccak256(serialized);
  const hashBytes = Buffer.from(hashHex.slice(2), 'hex');

  const [delegatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('delegate'), hashBytes],
    programId,
  );
  return delegatePDA;
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

  // 2b — Derive static PDAs (state, vault, event_authority)
  const { statePDA, eventAuthority, vaultATA } = deriveSpoolPDAs(programId, inputMint);

  // 2c — Prepare deposit parameters
  const recipientBytes32    = evmAddressToBytes32(record.bridge.settlement_wallet);
  const outputTokenBytes32  = evmAddressToBytes32(record.bridge.output_token_address);
  const outputAmount        = BigInt(record.bridge.raw_output_amount);
  const outputAmountBuf     = u64ToBEBytes32(outputAmount);       // [u8; 32] big-endian
  const exclusiveRelayer    = Buffer.alloc(32);                   // zeros = no exclusivity
  const message             = Buffer.alloc(0);                    // empty
  const quoteTimestamp      = record.bridge.quote_timestamp;
  const fillDeadline        = record.bridge.fill_deadline;
  const exclusivityParam    = 0;
  const destinationChainId  = BigInt(record.bridge.destination_chain_id);

  // 2d — Compute deposit delegate PDA (needed for approve + accounts list)
  const delegatePDA = computeDelegatePDA(
    programId,
    tempKeypair.publicKey,
    recipientBytes32,
    inputMint,
    outputTokenBytes32,
    actualInputAmount,
    outputAmountBuf,
    destinationChainId,
    exclusiveRelayer,
    quoteTimestamp,
    fillDeadline,
    exclusivityParam,
    message,
  );
  console.error(`[monitor-solana-deposit] Delegate PDA: ${delegatePDA.toString()}`);

  // 2e — Approve delegate PDA to spend inputAmount from depositor's ATA
  // (The deposit instruction pulls tokens via this delegate authority)
  console.error('[monitor-solana-deposit] Stage 2b: Approving delegate...');
  const approveTx = new Transaction().add(
    createApproveCheckedInstruction(
      depositATA,                  // source token account
      inputMint,                   // mint
      delegatePDA,                 // delegate (the PDA we computed)
      tempKeypair.publicKey,       // owner of the source account
      actualInputAmount,           // amount to approve
      6,                           // USDC decimals
    ),
  );
  const approveSig = await sendAndPollConfirm(connection, approveTx, [tempKeypair]);
  console.error(`[monitor-solana-deposit] Approve tx: ${approveSig}`);

  // 2f — Build deposit instruction (raw borsh — no Anchor/BN dependency)
  // Discriminator: SHA256("global:deposit")[:8] = [242, 35, 198, 137, 82, 225, 242, 182]
  const DEPOSIT_DISCRIMINATOR = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
  const u64LE = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const u32LE = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n);    return b; };

  const depositData = Buffer.concat([
    DEPOSIT_DISCRIMINATOR,
    tempKeypair.publicKey.toBuffer(),          // depositor:            pubkey [32]
    Buffer.from(recipientBytes32),             // recipient:            pubkey [32] (EVM addr padded)
    inputMint.toBuffer(),                      // input_token:          pubkey [32]
    Buffer.from(outputTokenBytes32),           // output_token:         pubkey [32] (EVM addr padded)
    u64LE(actualInputAmount),                  // input_amount:         u64
    outputAmountBuf,                           // output_amount:        [u8; 32] big-endian
    u64LE(destinationChainId),                 // destination_chain_id: u64
    Buffer.from(exclusiveRelayer),             // exclusive_relayer:    pubkey [32] (zeros)
    u32LE(quoteTimestamp),                     // quote_timestamp:      u32
    u32LE(fillDeadline),                       // fill_deadline:        u32
    u32LE(exclusivityParam),                   // exclusivity_parameter:u32
    u32LE(0),                                  // message: borsh bytes length prefix (0 = empty)
    // (no message bytes follow — empty)
  ]);

  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

  const depositIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: tempKeypair.publicKey,       isSigner: true,  isWritable: true  }, // signer
      { pubkey: statePDA,                    isSigner: false, isWritable: true  }, // state
      { pubkey: delegatePDA,                 isSigner: false, isWritable: false }, // delegate
      { pubkey: depositATA,                  isSigner: false, isWritable: true  }, // depositor_token_account
      { pubkey: vaultATA,                    isSigner: false, isWritable: true  }, // vault
      { pubkey: inputMint,                   isSigner: false, isWritable: false }, // mint
      { pubkey: TOKEN_PROGRAM_ID,            isSigner: false, isWritable: false }, // token_program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // associated_token_program
      { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false }, // system_program
      { pubkey: eventAuthority,              isSigner: false, isWritable: false }, // event_authority
      { pubkey: programId,                   isSigner: false, isWritable: false }, // program (self-reference for CPI events)
    ],
    data: depositData,
  });

  console.error('[monitor-solana-deposit] Stage 2c: Calling deposit on Across SpokePool...');
  const depositTx = new Transaction().add(depositIx);
  const txSig = await sendAndPollConfirm(connection, depositTx, [tempKeypair]);
  console.error(`[monitor-solana-deposit] deposit tx: ${txSig}`);
  return txSig;
}

// Stage 3: Watch EVM SpokePool for FilledRelay
// WebSocket subscription starts FIRST (no gap), historical check runs in parallel.
// resolveOnce ensures whichever path finds the fill first wins.
async function waitForEVMFill(
  record: PendingRecord,
  deadline: number,
  lookbackBlocks = 300,
): Promise<{ txHash: string; confirmations: number }> {
  const settlementChain = record.settlement_chain;
  const rpcUrl          = config.rpc[settlementChain];
  const wsUrl           = rpcUrl.replace('https://', 'wss://');
  const spokePoolAddr   = record.bridge.spoke_pool_destination;

  const httpProvider   = new JsonRpcProvider(rpcUrl);
  const iface          = new Interface(EVM_SPOKE_POOL_ABI);
  const filledTopic    = iface.getEvent('FilledRelay')!.topicHash;
  // originChainId is topics[1] — filter to only our Solana deposit fills
  const solanaChainId      = BigInt(config.bridge.acrossChainIds.solana);
  const originChainIdTopic = zeroPadValue(toBeHex(solanaChainId), 32);

  const expectedOutputRaw = BigInt(record.bridge.raw_output_amount);
  const minOutput = (expectedOutputRaw * 9900n) / 10000n;
  const maxOutput = (expectedOutputRaw * 10100n) / 10000n;
  const outputTokenLower = record.bridge.output_token_address.toLowerCase();
  const recipientLower   = record.wallet.toLowerCase();

  // bytes32 fields are right-aligned EVM addresses — extract the last 40 hex chars.
  function bytes32ToAddress(b32: string): string {
    return '0x' + b32.slice(-40).toLowerCase();
  }

  function isMatchingLog(log: { topics: readonly string[]; data: string }): boolean {
    try {
      const parsed = iface.parseLog({ topics: Array.from(log.topics), data: log.data });
      if (!parsed) return false;
      const logRecipient: string    = bytes32ToAddress(parsed.args['recipient']);
      const logOutputToken: string  = bytes32ToAddress(parsed.args['outputToken']);
      const logOutputAmount: bigint = parsed.args['outputAmount'];
      return (
        logRecipient   === recipientLower   &&
        logOutputToken === outputTokenLower &&
        logOutputAmount >= minOutput &&
        logOutputAmount <= maxOutput
      );
    } catch { return false; }
  }

  return new Promise<{ txHash: string; confirmations: number }>((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new Error('FilledRelay not found within timeout'));
      return;
    }

    let settled = false;
    const wsProvider = new WebSocketProvider(wsUrl);

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      wsProvider.destroy();
      reject(new Error('FilledRelay not found within timeout'));
    }, remaining);

    // resolveOnce — called by either WebSocket or historical check, first one wins
    async function resolveOnce(txHash: string, blockNumber: number): Promise<void> {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      wsProvider.destroy();
      try {
        const curBlock = await httpProvider.getBlockNumber();
        const confs    = curBlock - blockNumber + 1;
        resolve({ txHash, confirmations: confs });
      } catch {
        resolve({ txHash, confirmations: 1 });
      }
    }

    // Phase 1: WebSocket subscription — register FIRST so no events are missed
    console.error(`[monitor-solana-deposit] Stage 3: Subscribing via WebSocket on ${settlementChain}...`);
    wsProvider.on(
      { address: spokePoolAddr, topics: [filledTopic, originChainIdTopic] },
      async (log) => {
        if (!isMatchingLog(log)) return;
        console.error(`[monitor-solana-deposit] Stage 3: WebSocket fill detected: ${log.transactionHash}`);
        await resolveOnce(log.transactionHash, log.blockNumber);
      },
    );

    // Phase 2: Historical check — runs in parallel, catches fills from during Stage 2
    (async () => {
      try {
        const currentBlock = await httpProvider.getBlockNumber();
        const fromBlock = Math.max(0, currentBlock - lookbackBlocks);
        console.error(`[monitor-solana-deposit] Stage 3: Historical check blocks ${fromBlock}–${currentBlock} (${lookbackBlocks} block lookback)...`);

        const MAX_BLOCK_RANGE = 10;
        for (let cs = fromBlock; cs <= currentBlock && !settled; cs += MAX_BLOCK_RANGE) {
          const ce = Math.min(cs + MAX_BLOCK_RANGE - 1, currentBlock);
          try {
            const logs = await httpProvider.getLogs({
              address:   spokePoolAddr,
              topics:    [filledTopic, originChainIdTopic],
              fromBlock: cs,
              toBlock:   ce,
            });
            for (const log of logs) {
              if (isMatchingLog(log)) {
                console.error(`[monitor-solana-deposit] Stage 3: Historical fill found: ${log.transactionHash}`);
                await resolveOnce(log.transactionHash, log.blockNumber);
                return;
              }
            }
          } catch { /* skip chunk on RPC error */ }
          await sleep(100);
        }
      } catch { /* getBlockNumber failed — WebSocket will still catch new fills */ }
    })();
  });
}

async function main() {
  const args = parseArgs(process.argv);

  const paymentId       = args['payment-id'];
  const settlementChain = args['settlement-chain'];
  const timeoutSec      = parseInt(args['timeout']       || '7200');
  const pollIntervalSec = parseInt(args['poll-interval'] || '30');
  const resumeStage3    = args['resume-stage3'] === 'true';
  // How many blocks back to look when resuming Stage 3 (covers fills that happened while monitor was down)
  const stage3Lookback  = parseInt(args['stage3-lookback'] || '2000');

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

  const deadline = Date.now() + timeoutSec * 1000;
  const pollMs   = pollIntervalSec * 1000;

  // --resume-stage3: skip Stage 1 + 2, jump straight to EVM fill detection.
  // Use this when the monitor was restarted after the Solana deposit + bridge call
  // already completed (record.status = "bridging").
  if (resumeStage3) {
    console.error(`[monitor-solana-deposit] Resuming from Stage 3 (lookback=${stage3Lookback} blocks)`);
  } else {
    const connection = new Connection(config.rpc.solana, 'confirmed');
    const depositATA = new PublicKey(record.bridge.deposit_address);
    const expectedRaw = BigInt(record.bridge.raw_input_amount);

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
  }

  // Stage 3: Wait for EVM fill
  let fillResult: { txHash: string; confirmations: number };
  try {
    fillResult = await waitForEVMFill(record, deadline, resumeStage3 ? stage3Lookback : 300);
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

  // Write to notifications queue so the orchestrator can report confirmation
  // on the next product-bot message (push via poll-on-trigger pattern)
  const decimals = 6;
  const rawInput  = BigInt(record.bridge.raw_input_amount);
  const rawOutput = BigInt(record.bridge.raw_output_amount);
  const humanInput  = (Number(rawInput)  / 10 ** decimals).toFixed(decimals);
  const humanOutput = (Number(rawOutput) / 10 ** decimals).toFixed(decimals);

  const notification = {
    type:              'bridge_confirmed',
    payment_id:        paymentId,
    // Solana side
    solana_deposit_tx: (record as Record<string, unknown>).deposit_tx_sig ?? null,
    amount_sent:       humanInput,
    // Polygon/EVM side
    evm_fill_tx:       fillResult.txHash,
    amount_received:   humanOutput,
    confirmations:     fillResult.confirmations,
    // Bridge details
    token:             record.token,
    relay_fee:         record.bridge.relay_fee,
    source_chain:      record.source_chain,
    settlement_chain:  record.settlement_chain,
    settlement_wallet: record.bridge.settlement_wallet,
    bridge_provider:   record.bridge.provider,
    // Timing
    confirmed_at:      confirmedAt,
  };
  try {
    const notifDir = resolveDataPath('notifications');
    const { mkdirSync } = await import('fs');
    mkdirSync(notifDir, { recursive: true });
    writeFileSync(`${notifDir}/${paymentId}.json`, JSON.stringify(notification, null, 2));
    console.error(`[monitor-solana-deposit] Notification queued at notifications/${paymentId}.json`);
  } catch (err) {
    console.error(`[monitor-solana-deposit] Failed to write notification: ${String(err)}`);
  }

  // Send Telegram confirmation directly if we have chat_id
  const chatId = (record as Record<string, unknown>).telegram_chat_id as string | undefined;
  const botToken = process.env.TELEGRAM_BOT_TOKEN_PRODUCT;
  if (chatId && botToken) {
    try {
      const text =
        `✅ <b>Bridge Payment Confirmed!</b>\n\n` +
        `💰 <b>${humanOutput} ${record.token}</b> received on ${record.settlement_chain}\n` +
        `📦 Payment: <code>${paymentId}</code>\n` +
        `🔗 Fill tx: <code>${fillResult.txHash}</code>\n` +
        `⛓ Route: Solana → ${record.settlement_chain}`;
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      });
      console.error(`[monitor-solana-deposit] Telegram confirmation sent to chat ${chatId}`);
    } catch (err) {
      console.error(`[monitor-solana-deposit] Failed to send Telegram notification: ${String(err)}`);
    }
  }

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
