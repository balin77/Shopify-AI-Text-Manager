/**
 * Encryption Utility for Sensitive Data
 *
 * Uses AES-256-GCM for secure encryption of sensitive data like API keys and PII.
 *
 * Security Features:
 * - AES-256-GCM (Authenticated Encryption with Associated Data)
 * - Random IV (Initialization Vector) per encryption
 * - Authentication Tag for integrity verification
 * - NIST-recommended algorithm
 *
 * Storage Format: {iv}:{encryptedData}:{authTag} (Base64-encoded)
 *
 * Use Cases:
 * - API Keys (Claude, OpenAI, Gemini, etc.)
 * - PII Data (firstName, lastName, email)
 * - OAuth Tokens (accessToken, refreshToken)
 *
 * @example
 * ```typescript
 * const encrypted = encrypt('sk-1234567890');
 * // Returns: "b2Fzd2Vmc2Rm:aGVsbG8gd29ybGQ=:dGFnMTIzNDU2Nzg5MA=="
 *
 * const decrypted = decrypt(encrypted);
 * // Returns: "sk-1234567890"
 * ```
 */

import crypto from 'crypto';

/**
 * Encryption algorithm (AES-256-GCM)
 * GCM = Galois/Counter Mode (provides both confidentiality and authenticity)
 */
const ALGORITHM = 'aes-256-gcm';

/**
 * IV (Initialization Vector) length in bytes
 * GCM standard recommends 12 bytes (96 bits)
 */
const IV_LENGTH = 12;

/**
 * Auth Tag length in bytes
 * GCM standard uses 16 bytes (128 bits)
 */
const AUTH_TAG_LENGTH = 16;

/**
 * Encryption key length in bytes (32 bytes = 256 bits)
 */
const KEY_LENGTH = 32;

/**
 * Get or validate the encryption key from environment variables
 *
 * @throws {Error} If ENCRYPTION_KEY is not set or invalid
 * @returns {Buffer} The encryption key as a Buffer
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;

  if (!envKey) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is not set. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  // Remove any whitespace
  const cleanKey = envKey.trim();

  // Try to parse as hex
  let keyBuffer: Buffer;
  try {
    keyBuffer = Buffer.from(cleanKey, 'hex');
  } catch (error) {
    throw new Error('ENCRYPTION_KEY must be a valid hex string');
  }

  // Validate length
  if (keyBuffer.length !== KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY must be exactly ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex characters). ` +
      `Got ${keyBuffer.length} bytes. ` +
      'Generate a new key with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  return keyBuffer;
}

/**
 * Encrypt a string using AES-256-GCM
 *
 * @param plaintext - The string to encrypt (e.g., API key)
 * @returns {string} Encrypted string in format: {iv}:{encryptedData}:{authTag} (Base64)
 * @throws {Error} If encryption fails or ENCRYPTION_KEY is not configured
 *
 * @example
 * ```typescript
 * const encrypted = encrypt('sk-ant-api03-1234567890');
 * console.log(encrypted);
 * // "a2V5MTIzNDU2Nzg=:ZW5jcnlwdGVkZGF0YQ==:dGFnMTIzNDU2Nzg5MA=="
 * ```
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) {
    throw new Error('Cannot encrypt empty string');
  }

  try {
    // Get encryption key
    const key = getEncryptionKey();

    // Generate random IV (Initialization Vector)
    const iv = crypto.randomBytes(IV_LENGTH);

    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    // Encrypt the plaintext
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    // Get authentication tag (GCM mode)
    const authTag = cipher.getAuthTag();

    // Combine IV + Encrypted Data + Auth Tag, separated by colons
    // All parts are Base64-encoded for safe storage
    return `${iv.toString('base64')}:${encrypted.toString('base64')}:${authTag.toString('base64')}`;
  } catch (error) {
    // Don't expose the actual plaintext in error messages
    console.error('Encryption failed:', error instanceof Error ? error.message : 'Unknown error');
    throw new Error('Failed to encrypt data. Check ENCRYPTION_KEY configuration.');
  }
}

/**
 * Decrypt a string that was encrypted with encrypt()
 *
 * @param encryptedData - The encrypted string in format: {iv}:{encryptedData}:{authTag}
 * @returns {string} The decrypted plaintext
 * @throws {Error} If decryption fails, data is tampered, or format is invalid
 *
 * @example
 * ```typescript
 * const encrypted = "a2V5MTIzNDU2Nzg=:ZW5jcnlwdGVkZGF0YQ==:dGFnMTIzNDU2Nzg5MA==";
 * const decrypted = decrypt(encrypted);
 * console.log(decrypted); // "sk-ant-api03-1234567890"
 * ```
 */
export function decrypt(encryptedData: string): string {
  if (!encryptedData) {
    throw new Error('Cannot decrypt empty string');
  }

  try {
    // Get encryption key
    const key = getEncryptionKey();

    // Split the encrypted data into its components
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format. Expected format: {iv}:{data}:{tag}');
    }

    const [ivBase64, encryptedBase64, authTagBase64] = parts;

    // Decode from Base64
    const iv = Buffer.from(ivBase64, 'base64');
    const encrypted = Buffer.from(encryptedBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    // Validate lengths
    if (iv.length !== IV_LENGTH) {
      throw new Error(`Invalid IV length. Expected ${IV_LENGTH} bytes, got ${iv.length}`);
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error(`Invalid auth tag length. Expected ${AUTH_TAG_LENGTH} bytes, got ${authTag.length}`);
    }

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    // Decrypt the data
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (error) {
    // Don't expose encrypted data in error messages
    console.error('Decryption failed:', error instanceof Error ? error.message : 'Unknown error');

    // Check for common errors
    if (error instanceof Error) {
      if (error.message.includes('Unsupported state or unable to authenticate data')) {
        throw new Error('Failed to decrypt data. Data may be corrupted or tampered with.');
      }
      if (error.message.includes('Invalid encrypted data format')) {
        throw error; // Re-throw format errors as-is
      }
    }

    throw new Error('Failed to decrypt data. Check ENCRYPTION_KEY configuration.');
  }
}

/**
 * Check if a string is encrypted (has the expected format)
 *
 * @param data - The string to check
 * @returns {boolean} True if the string appears to be encrypted
 *
 * @example
 * ```typescript
 * isEncrypted('sk-1234567890'); // false
 * isEncrypted('a2V5MTIzNDU2Nzg=:ZW5jcnlwdGVkZGF0YQ==:dGFnMTIzNDU2Nzg5MA=='); // true
 * ```
 */
export function isEncrypted(data: string | null | undefined): boolean {
  if (!data) return false;

  // Check if it matches the format: {base64}:{base64}:{base64}
  const parts = data.split(':');
  if (parts.length !== 3) return false;

  // Check if all parts are valid Base64
  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  return parts.every(part => base64Regex.test(part));
}

/**
 * Generate a new random encryption key (for setup/initialization)
 *
 * @returns {string} A new 32-byte key as a hex string
 *
 * @example
 * ```typescript
 * const newKey = generateEncryptionKey();
 * console.log(`ENCRYPTION_KEY=${newKey}`);
 * // ENCRYPTION_KEY=a1b2c3d4e5f6...
 * ```
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(KEY_LENGTH).toString('hex');
}

/**
 * Safely encrypt an API key (handles null/undefined)
 *
 * @param apiKey - The API key to encrypt (can be null/undefined)
 * @returns {string | null} Encrypted API key or null
 */
export function encryptApiKey(apiKey: string | null | undefined): string | null {
  if (!apiKey || apiKey.trim() === '') {
    return null;
  }
  return encrypt(apiKey.trim());
}

/**
 * Safely decrypt an API key (handles null/undefined/already-decrypted)
 *
 * @param encryptedApiKey - The encrypted API key (can be null/undefined)
 * @returns {string | null} Decrypted API key or null
 */
export function decryptApiKey(encryptedApiKey: string | null | undefined): string | null {
  if (!encryptedApiKey || encryptedApiKey.trim() === '') {
    return null;
  }

  const trimmed = encryptedApiKey.trim();

  // If it's not encrypted, return as-is (for backwards compatibility during migration)
  if (!isEncrypted(trimmed)) {
    console.warn('Warning: API key is not encrypted. Consider running migration.');
    return trimmed;
  }

  return decrypt(trimmed);
}

// ============================================================================
// PII (Personally Identifiable Information) Encryption
// ============================================================================

/**
 * Safely encrypt PII data (firstName, lastName, email, etc.)
 *
 * @param piiData - The PII data to encrypt (can be null/undefined)
 * @returns {string | null} Encrypted PII data or null
 *
 * @example
 * ```typescript
 * const encrypted = encryptPII('John');
 * const decrypted = decryptPII(encrypted); // 'John'
 * ```
 */
export function encryptPII(piiData: string | null | undefined): string | null {
  if (!piiData || piiData.trim() === '') {
    return null;
  }
  return encrypt(piiData.trim());
}

/**
 * Safely decrypt PII data (handles null/undefined/already-decrypted)
 *
 * @param encryptedPII - The encrypted PII data (can be null/undefined)
 * @returns {string | null} Decrypted PII data or null
 *
 * @example
 * ```typescript
 * const encrypted = 'a2V5MTIzNDU2Nzg=:ZW5jcnlwdGVk:dGFn';
 * const decrypted = decryptPII(encrypted); // 'John'
 * ```
 */
export function decryptPII(encryptedPII: string | null | undefined): string | null {
  if (!encryptedPII || encryptedPII.trim() === '') {
    return null;
  }

  const trimmed = encryptedPII.trim();

  // If it's not encrypted, return as-is (for backwards compatibility during migration)
  if (!isEncrypted(trimmed)) {
    console.warn('Warning: PII data is not encrypted. Consider running migration.');
    return trimmed;
  }

  return decrypt(trimmed);
}

/**
 * Safely encrypt an OAuth token (accessToken, refreshToken)
 *
 * @param token - The OAuth token to encrypt (can be null/undefined)
 * @returns {string | null} Encrypted token or null
 */
export function encryptToken(token: string | null | undefined): string | null {
  if (!token || token.trim() === '') {
    return null;
  }
  return encrypt(token.trim());
}

/**
 * Safely decrypt an OAuth token (handles null/undefined/already-decrypted)
 *
 * @param encryptedToken - The encrypted token (can be null/undefined)
 * @returns {string | null} Decrypted token or null
 */
export function decryptToken(encryptedToken: string | null | undefined): string | null {
  if (!encryptedToken || encryptedToken.trim() === '') {
    return null;
  }

  const trimmed = encryptedToken.trim();

  // If it's not encrypted, return as-is (for backwards compatibility during migration)
  if (!isEncrypted(trimmed)) {
    console.warn('Warning: OAuth token is not encrypted. Consider running migration.');
    return trimmed;
  }

  return decrypt(trimmed);
}

// ============================================================================
// Webhook Payload Encryption
// ============================================================================

/**
 * Safely encrypt webhook payload data
 *
 * @param payload - The webhook payload to encrypt (can be null/undefined)
 * @returns {string | null} Encrypted payload or null
 *
 * @example
 * ```typescript
 * const encrypted = encryptPayload(JSON.stringify(webhookData));
 * const decrypted = decryptPayload(encrypted); // Original JSON string
 * ```
 */
export function encryptPayload(payload: string | null | undefined): string | null {
  if (!payload || payload.trim() === '') {
    return null;
  }
  return encrypt(payload.trim());
}

/**
 * Safely decrypt webhook payload data (handles null/undefined/already-decrypted)
 *
 * @param encryptedPayload - The encrypted payload (can be null/undefined)
 * @returns {string | null} Decrypted payload or null
 *
 * @example
 * ```typescript
 * const encrypted = 'a2V5MTIzNDU2Nzg=:ZW5jcnlwdGVk:dGFn';
 * const decrypted = decryptPayload(encrypted); // Original JSON string
 * const webhookData = JSON.parse(decrypted);
 * ```
 */
export function decryptPayload(encryptedPayload: string | null | undefined): string | null {
  if (!encryptedPayload || encryptedPayload.trim() === '') {
    return null;
  }

  const trimmed = encryptedPayload.trim();

  // If it's not encrypted, return as-is (for backwards compatibility during migration)
  if (!isEncrypted(trimmed)) {
    console.warn('Warning: Webhook payload is not encrypted. Consider running migration.');
    return trimmed;
  }

  return decrypt(trimmed);
}
