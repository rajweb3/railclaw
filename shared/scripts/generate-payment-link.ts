/**
 * generate-payment-link.ts — Create a payment link and pending payment record.
 *
 * Usage:
 *   npx tsx generate-payment-link.ts \
 *     --chain polygon --token USDC --amount 100 \
 *     --wallet 0x... --business "Acme Corp" --business-id biz_001
 *
 * Output (stdout JSON):
 *   { success: true, payment_id: "pay_...", link: "https://...", ... }
 *
 * Data: Creates $RAILCLAW_DATA_DIR/pending/{payment_id}.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config, parseArgs, resolveDataPath } from './lib/config.js';
import { generateId } from './lib/crypto-utils.js';

const args = parseArgs(process.argv);

const chain = args['chain'];
const token = args['token'];
const amount = args['amount'];
const wallet = args['wallet'];
const business = args['business'];
const businessId = args['business-id'];
const chatId = args['chat-id'] || '';

const missing = [];
if (!chain) missing.push('--chain');
if (!token) missing.push('--token');
if (!amount) missing.push('--amount');
if (!wallet) missing.push('--wallet');
if (!business) missing.push('--business');
if (!businessId) missing.push('--business-id');

if (missing.length > 0) {
  console.log(JSON.stringify({ success: false, error: `Missing: ${missing.join(', ')}` }));
  process.exit(1);
}

const paymentId = generateId('pay');
const now = new Date();
const expiresAt = new Date(now.getTime() + config.payment.defaultExpiryHours * 60 * 60 * 1000);
const tokenAddress = config.tokens[chain.toLowerCase()]?.[token.toUpperCase()] || null;

const paymentRecord = {
  payment_id: paymentId,
  chain: chain.toLowerCase(),
  token: token.toUpperCase(),
  token_contract: tokenAddress,
  amount: parseFloat(amount),
  wallet,
  business_name: business,
  business_id: businessId,
  telegram_chat_id: chatId,
  status: 'pending',
  created_at: now.toISOString(),
  expires_at: expiresAt.toISOString(),
  tx_hash: null,
  confirmations: 0,
  confirmed_at: null,
};

const pendingDir = resolveDataPath('pending');
mkdirSync(pendingDir, { recursive: true });
writeFileSync(join(pendingDir, `${paymentId}.json`), JSON.stringify(paymentRecord, null, 2));

const link = `${config.payment.baseUrl}/p/${paymentId}`;

console.log(
  JSON.stringify({
    success: true,
    payment_id: paymentId,
    link,
    chain: paymentRecord.chain,
    token: paymentRecord.token,
    amount: paymentRecord.amount,
    wallet: paymentRecord.wallet,
    business_name: paymentRecord.business_name,
    expires_at: paymentRecord.expires_at,
  })
);
