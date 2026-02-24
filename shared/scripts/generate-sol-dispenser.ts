import { Keypair } from '@solana/web3.js';

/**
 * Generate a new Solana keypair for use as the SOL dispenser wallet.
 *
 * Output:
 *   SOLANA_SOL_DISPENSER_KEY  — hex private key, goes in .env
 *   Solana address            — send at least 0.1 SOL to this address to fund it
 *
 * Usage:
 *   npx tsx shared/scripts/generate-sol-dispenser.ts
 */

const keypair = Keypair.generate();

const privateKeyHex = Buffer.from(keypair.secretKey).toString('hex');
const publicAddress = keypair.publicKey.toString();

console.log('\n=== SOL Dispenser Wallet ===\n');
console.log(`SOLANA_SOL_DISPENSER_KEY=${privateKeyHex}`);
console.log(`\nSolana address to fund: ${publicAddress}`);
console.log('\nSend at least 0.01 SOL to the address above before enabling bridge payments.');
console.log('Each bridge payment consumes ~0.001 SOL in transaction fees (~100 payments per 0.01 SOL).\n');
