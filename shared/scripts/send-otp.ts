/**
 * send-otp.ts — Send a 6-digit OTP to a business email via AWS SES.
 *
 * Usage:
 *   npx tsx send-otp.ts --email "user@example.com"
 *
 * Output (stdout JSON):
 *   { success: true, expires_in: 300 }
 *   { success: false, error: "..." }
 *
 * Data: Stores OTP record at $RAILCLAW_DATA_DIR/otp/{email_hash}.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { config, parseArgs, resolveDataPath } from './lib/config.js';
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

const ses = new SESClient({ region: config.aws.region });

try {
  await ses.send(
    new SendEmailCommand({
      Source: config.aws.sesFromEmail,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: 'Railclaw — Your Verification Code' },
        Body: {
          Text: {
            Data: `Your Railclaw verification code is: ${otp}\n\nExpires in 5 minutes.\nIf you did not request this, ignore this email.`,
          },
          Html: {
            Data: `
              <div style="font-family:monospace;max-width:400px;margin:0 auto;padding:20px;">
                <h2>Railclaw</h2>
                <p>Your verification code:</p>
                <div style="font-size:32px;font-weight:bold;letter-spacing:8px;padding:16px;background:#f5f5f5;text-align:center;border-radius:8px;">
                  ${otp}
                </div>
                <p style="color:#666;font-size:12px;margin-top:16px;">
                  Expires in 5 minutes.
                </p>
              </div>`,
          },
        },
      },
    })
  );
  console.log(JSON.stringify({ success: true, expires_in: 300 }));
} catch (err: any) {
  console.log(JSON.stringify({ success: false, error: `SES error: ${err.message}` }));
  process.exit(1);
}
