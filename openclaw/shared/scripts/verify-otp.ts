/**
 * verify-otp.ts — Validate an OTP code against the stored record.
 *
 * Usage:
 *   npx tsx verify-otp.ts --email "user@example.com" --code 123456
 *
 * Output (stdout JSON):
 *   { valid: true }
 *   { valid: false, reason: "expired" | "invalid" | "max_attempts_exceeded" }
 */

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { parseArgs, resolveDataPath } from './lib/config.js';
import { hashEmail } from './lib/crypto-utils.js';

const args = parseArgs(process.argv);
const email = args['email'];
const code = args['code'];

if (!email || !code) {
  console.log(JSON.stringify({ valid: false, reason: 'Missing --email or --code' }));
  process.exit(1);
}

const emailHash = hashEmail(email);
const filePath = join(resolveDataPath('otp'), `${emailHash}.json`);

let record: any;
try {
  record = JSON.parse(readFileSync(filePath, 'utf-8'));
} catch {
  console.log(JSON.stringify({ valid: false, reason: 'No OTP request found. Send OTP first.' }));
  process.exit(0);
}

// Check expiry
if (Date.now() > record.expires_at) {
  try { unlinkSync(filePath); } catch {}
  console.log(JSON.stringify({ valid: false, reason: 'expired' }));
  process.exit(0);
}

// Check max attempts
if (record.attempts >= record.max_attempts) {
  try { unlinkSync(filePath); } catch {}
  console.log(JSON.stringify({ valid: false, reason: 'max_attempts_exceeded' }));
  process.exit(0);
}

// Validate
if (record.otp_plain === code) {
  try { unlinkSync(filePath); } catch {}
  console.log(JSON.stringify({ valid: true }));
} else {
  record.attempts += 1;
  writeFileSync(filePath, JSON.stringify(record, null, 2));
  console.log(
    JSON.stringify({
      valid: false,
      reason: 'invalid',
      attempts_remaining: record.max_attempts - record.attempts,
    })
  );
}
