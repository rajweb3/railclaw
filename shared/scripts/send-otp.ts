/**
 * send-otp.ts — Generate a 6-digit OTP and store it.
 *
 * The OTP is returned in the JSON output. The calling agent (business-owner)
 * sends it to the user directly via the Telegram conversation.
 * No external email service needed.
 *
 * Usage:
 *   npx tsx send-otp.ts --email "user@example.com"
 *
 * Output (stdout JSON):
 *   { success: true, otp: "482910", expires_in: 300 }
 *   { success: false, error: "..." }
 *
 * Data: Stores OTP record at $RAILCLAW_DATA_DIR/otp/{email_hash}.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseArgs, resolveDataPath } from './lib/config.js';
import { generateOTP, hashEmail } from './lib/crypto-utils.js';

const args = parseArgs(process.argv);
const email = args['email'];

if (!email) {
  console.log(JSON.stringify({ success: false, error: 'Missing --email argument' }));
  process.exit(1);
}

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!emailRegex.test(email)) {
  console.log(JSON.stringify({ success: false, error: 'Invalid email format' }));
  process.exit(1);
}

const otp = generateOTP();
const expiresAt = Date.now() + 5 * 60 * 1000;
const emailHash = hashEmail(email);
const otpDir = resolveDataPath('otp');

mkdirSync(otpDir, { recursive: true });

const otpRecord = {
  email_hash: emailHash,
  otp_plain: otp,
  expires_at: expiresAt,
  attempts: 0,
  max_attempts: 3,
  created_at: new Date().toISOString(),
};

writeFileSync(join(otpDir, `${emailHash}.json`), JSON.stringify(otpRecord, null, 2));

// Return OTP to the agent — agent sends it via Telegram message
console.log(JSON.stringify({ success: true, otp, expires_in: 300 }));
