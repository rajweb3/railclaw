/**
 * create-wallet.ts — Generate an EVM wallet, encrypt private key, store keystore.
 *
 * Usage:
 *   npx tsx create-wallet.ts --email "user@example.com"
 *
 * Output (stdout JSON):
 *   { success: true, address: "0x...", business_id: "biz_XXXXXXXX" }
 *
 * SECURITY: Private key encrypted with AES-256-GCM. NEVER output to stdout.
 * Keystore stored at $RAILCLAW_DATA_DIR/wallets/{business_id}.enc.json (mode 0600)
 */

import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import { config, parseArgs, resolveDataPath } from './lib/config.js';
import { encrypt, generateId } from './lib/crypto-utils.js';

const args = parseArgs(process.argv);
const email = args['email'];

if (!email) {
  console.log(JSON.stringify({ success: false, error: 'Missing --email' }));
  process.exit(1);
}

if (!config.encryption.walletKey) {
  console.log(JSON.stringify({ success: false, error: 'WALLET_ENCRYPTION_KEY env var not set' }));
  process.exit(1);
}

const walletsDir = resolveDataPath('wallets');
mkdirSync(walletsDir, { recursive: true });

// Return existing wallet if one already exists for this email
const existing = readdirSync(walletsDir)
  .filter(f => f.endsWith('.enc.json'))
  .map(f => { try { return JSON.parse(readFileSync(join(walletsDir, f), 'utf8')); } catch { return null; } })
  .find(k => k && k.email === email);

if (existing) {
  console.log(JSON.stringify({ success: true, address: existing.address, business_id: existing.business_id, existing: true }));
  process.exit(0);
}

const wallet = ethers.Wallet.createRandom();
const businessId = generateId('biz');
const encryptedKey = encrypt(wallet.privateKey, config.encryption.walletKey);

const keystore = {
  business_id: businessId,
  email,
  address: wallet.address,
  encrypted_private_key: encryptedKey,
  derivation_path: "m/44'/60'/0'/0/0",
  created_at: new Date().toISOString(),
};

writeFileSync(join(walletsDir, `${businessId}.enc.json`), JSON.stringify(keystore, null, 2), {
  mode: 0o600,
});

// Output — NEVER include private key
console.log(JSON.stringify({ success: true, address: wallet.address, business_id: businessId }));
