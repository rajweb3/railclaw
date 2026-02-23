import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

/**
 * Generate a cryptographically secure 6-digit OTP.
 */
export function generateOTP(): string {
  const bytes = randomBytes(3);
  const num = (bytes[0] * 65536 + bytes[1] * 256 + bytes[2]) % 1000000;
  return num.toString().padStart(6, '0');
}

/**
 * Hash an email address for use as a filename (no PII in filenames).
 */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex').slice(0, 16);
}

/**
 * Generate a prefixed unique ID (e.g., biz_a1b2c3d4, pay_e5f6g7h8).
 */
export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns format: iv_hex:auth_tag_hex:ciphertext_hex
 */
export function encrypt(plaintext: string, keyHex: string): string {
  if (!keyHex || keyHex.length < 64) {
    throw new Error('Encryption key must be a 32-byte hex string (64 hex chars)');
  }

  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt AES-256-GCM encrypted data.
 * Expects format: iv_hex:auth_tag_hex:ciphertext_hex
 */
export function decrypt(encryptedData: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const parts = encryptedData.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted data format');

  const [ivHex, tagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
