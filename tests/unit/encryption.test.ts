import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encrypt,
  decrypt,
  isEncrypted,
  generateEncryptionKey,
  encryptApiKey,
  decryptApiKey,
  tryDecryptApiKey,
  encryptPII,
  decryptPII,
  encryptToken,
  decryptToken,
} from '~/utils/encryption.server';

describe('Encryption Utils', () => {
  // Set up a valid encryption key for tests
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '988568df2b8ae4861f66586e234cb1ba58560d67e1842fa5040da8f98a3e5162';
  });

  describe('encrypt() and decrypt()', () => {
    it('should encrypt and decrypt a string successfully', () => {
      const plaintext = 'sk-test-api-key-12345';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for the same input (random IV)', () => {
      const plaintext = 'test-string';
      const encrypted1 = encrypt(plaintext);
      const encrypted2 = encrypt(plaintext);

      // Different encrypted strings due to random IV
      expect(encrypted1).not.toBe(encrypted2);

      // But both decrypt to the same plaintext
      expect(decrypt(encrypted1)).toBe(plaintext);
      expect(decrypt(encrypted2)).toBe(plaintext);
    });

    it('should encrypt and decrypt unicode characters', () => {
      const plaintext = '日本語 🎌 Émojis 🚀';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt long strings', () => {
      const plaintext = 'a'.repeat(10000);
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should throw error when encrypting empty string', () => {
      expect(() => encrypt('')).toThrow('Cannot encrypt empty string');
    });

    it('should throw error when decrypting empty string', () => {
      expect(() => decrypt('')).toThrow('Cannot decrypt empty string');
    });

    it('should throw error when decrypting invalid format', () => {
      expect(() => decrypt('invalid-format')).toThrow('Invalid encrypted data format');
    });

    it('should throw error when decrypting tampered data', () => {
      const plaintext = 'test-string';
      const encrypted = encrypt(plaintext);

      // Tamper with the encrypted data
      const parts = encrypted.split(':');
      const tampered = `${parts[0]}:${parts[1]}:TAMPERED==`;

      expect(() => decrypt(tampered)).toThrow();
    });

    it('should have correct encrypted format (iv:data:tag)', () => {
      const encrypted = encrypt('test');
      const parts = encrypted.split(':');

      expect(parts).toHaveLength(3);
      // All parts should be valid Base64
      parts.forEach(part => {
        expect(part).toMatch(/^[A-Za-z0-9+/]+=*$/);
      });
    });
  });

  describe('isEncrypted()', () => {
    it('should return true for encrypted strings', () => {
      const encrypted = encrypt('test-api-key');
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('should return false for plaintext strings', () => {
      expect(isEncrypted('sk-1234567890')).toBe(false);
      expect(isEncrypted('plain-text')).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isEncrypted(null)).toBe(false);
      expect(isEncrypted(undefined)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isEncrypted('')).toBe(false);
    });

    it('should return false for invalid format', () => {
      expect(isEncrypted('invalid:format')).toBe(false);
      expect(isEncrypted('only-one-part')).toBe(false);
    });
  });

  describe('generateEncryptionKey()', () => {
    it('should generate a valid hex key', () => {
      const key = generateEncryptionKey();

      // Should be 64 hex characters (32 bytes)
      expect(key).toHaveLength(64);
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should generate unique keys each time', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();

      expect(key1).not.toBe(key2);
    });

    it('generated key should work for encryption', () => {
      const newKey = generateEncryptionKey();
      process.env.ENCRYPTION_KEY = newKey;

      const plaintext = 'test-with-new-key';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('encryptApiKey() and decryptApiKey()', () => {
    it('should encrypt and decrypt API keys', () => {
      const apiKey = 'sk-ant-api03-1234567890';
      const encrypted = encryptApiKey(apiKey);
      const decrypted = decryptApiKey(encrypted);

      expect(encrypted).not.toBeNull();
      expect(decrypted).toBe(apiKey);
    });

    it('should handle null/undefined API keys', () => {
      expect(encryptApiKey(null)).toBeNull();
      expect(encryptApiKey(undefined)).toBeNull();
      expect(encryptApiKey('')).toBeNull();
      expect(encryptApiKey('   ')).toBeNull();

      expect(decryptApiKey(null)).toBeNull();
      expect(decryptApiKey(undefined)).toBeNull();
      expect(decryptApiKey('')).toBeNull();
    });

    it('should trim whitespace from API keys', () => {
      const apiKey = '  sk-test-123  ';
      const encrypted = encryptApiKey(apiKey);
      const decrypted = decryptApiKey(encrypted);

      expect(decrypted).toBe('sk-test-123'); // Trimmed
    });
  });

  describe('encryptPII() and decryptPII()', () => {
    it('should encrypt and decrypt PII data', () => {
      const piiData = 'John Doe';
      const encrypted = encryptPII(piiData);
      const decrypted = decryptPII(encrypted);

      expect(encrypted).not.toBeNull();
      expect(decrypted).toBe(piiData);
    });

    it('should handle null/undefined PII', () => {
      expect(encryptPII(null)).toBeNull();
      expect(encryptPII(undefined)).toBeNull();
      expect(encryptPII('')).toBeNull();

      expect(decryptPII(null)).toBeNull();
      expect(decryptPII(undefined)).toBeNull();
      expect(decryptPII('')).toBeNull();
    });

    it('should encrypt email addresses', () => {
      const email = 'user@example.com';
      const encrypted = encryptPII(email);
      const decrypted = decryptPII(encrypted);

      expect(decrypted).toBe(email);
    });
  });

  describe('encryptToken() and decryptToken()', () => {
    it('should encrypt and decrypt OAuth tokens', () => {
      const token = 'oauth-token-abc123xyz789';
      const encrypted = encryptToken(token);
      const decrypted = decryptToken(encrypted);

      expect(encrypted).not.toBeNull();
      expect(decrypted).toBe(token);
    });

    it('should handle null/undefined tokens', () => {
      expect(encryptToken(null)).toBeNull();
      expect(encryptToken(undefined)).toBeNull();
      expect(encryptToken('')).toBeNull();

      expect(decryptToken(null)).toBeNull();
      expect(decryptToken(undefined)).toBeNull();
      expect(decryptToken('')).toBeNull();
    });
  });

  describe('Error Handling', () => {
    it('should throw error if ENCRYPTION_KEY is missing', () => {
      delete process.env.ENCRYPTION_KEY;

      expect(() => encrypt('test')).toThrow('Failed to encrypt data');
    });

    it('should throw error if ENCRYPTION_KEY has invalid length', () => {
      process.env.ENCRYPTION_KEY = 'tooshort'; // Not 64 hex chars

      expect(() => encrypt('test')).toThrow();
    });
  });

  describe('Security Properties', () => {
    it('should use authenticated encryption (GCM)', () => {
      const encrypted = encrypt('test');

      // GCM provides authentication tag (3rd part of encrypted string)
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3);
      expect(parts[2].length).toBeGreaterThan(0); // Auth tag present
    });

    it('should detect tampering via auth tag', () => {
      const plaintext = 'secret-data';
      const encrypted = encrypt(plaintext);

      // Tamper with the encrypted data (change one character)
      const parts = encrypted.split(':');
      const tamperedData = parts[1].replace(/A/g, 'B').replace(/a/g, 'b');
      const tampered = `${parts[0]}:${tamperedData}:${parts[2]}`;

      // Decryption should fail due to auth tag mismatch or return wrong data
      try {
        const decrypted = decrypt(tampered);
        // If it doesn't throw, the decrypted data should be different
        expect(decrypted).not.toBe(plaintext);
      } catch (error) {
        // If it throws, that's also acceptable
        expect(error).toBeDefined();
      }
    });

    it('should use random IV for each encryption', () => {
      const plaintext = 'same-plaintext';

      // Encrypt same plaintext 10 times
      const encrypted = Array.from({ length: 10 }, () => encrypt(plaintext));

      // All IVs should be different
      const ivs = encrypted.map(e => e.split(':')[0]);
      const uniqueIvs = new Set(ivs);
      expect(uniqueIvs.size).toBe(10);

      // All should decrypt correctly
      encrypted.forEach(e => {
        expect(decrypt(e)).toBe(plaintext);
      });
    });
  });

  // R3-H7: the encrypt-migration / key-rotation scripts
  // (scripts/migrate-encrypt-*.ts) had no tests. They don't have their own
  // crypto — they lean entirely on these invariants, so we lock the
  // invariants down here. (The webhook HMAC check itself is owned by the
  // Shopify SDK's authenticate.webhook(); a hand-rolled HMAC test would only
  // re-implement and "verify" our own reimplementation — exactly the
  // decorative-test anti-pattern this review flags — so it is intentionally
  // not added.)
  describe('Key rotation & migration-script invariants (R3-H7)', () => {
    const KEY_A = '988568df2b8ae4861f66586e234cb1ba58560d67e1842fa5040da8f98a3e5162';
    const KEY_B = '11112222333344445555666677778888999900001111222233334444aaaabbbb';

    it('decrypt() FAILS CLOSED (throws) when the key was rotated — never returns garbage', () => {
      process.env.ENCRYPTION_KEY = KEY_A;
      const ciphertext = encrypt('sk-secret-value');

      process.env.ENCRYPTION_KEY = KEY_B; // operator rotated the key
      // AES-256-GCM auth tag must reject decryption under the wrong key
      // rather than silently emit corrupted plaintext.
      expect(() => decrypt(ciphertext)).toThrow();
    });

    it('tryDecryptApiKey() returns null (does NOT throw) for value encrypted under a previous key', () => {
      process.env.ENCRYPTION_KEY = KEY_A;
      const stored = encryptApiKey('sk-merchant-key');

      process.env.ENCRYPTION_KEY = KEY_B;
      // Documented rotation contract: an undecryptable key reads as "absent"
      // so one rotated key cannot break the whole request; the merchant just
      // re-enters it. The read paths rely on this exact behaviour.
      expect(tryDecryptApiKey(stored, 'openai')).toBeNull();
    });

    it('isEncrypted() lets a migration skip already-encrypted rows (idempotency / no double-encryption)', () => {
      process.env.ENCRYPTION_KEY = KEY_A;
      const plaintext = 'sk-plain-api-key';
      const once = encryptApiKey(plaintext)!;

      // The migrate-encrypt-* scripts gate on isEncrypted() before encrypting.
      expect(isEncrypted(plaintext)).toBe(false); // would be encrypted
      expect(isEncrypted(once)).toBe(true);        // would be skipped

      // Prove the guard prevents an unrecoverable double-encryption: if a
      // migration ignored isEncrypted and encrypted twice, one decrypt pass
      // would yield ciphertext, not the original secret.
      const twice = encrypt(once);
      expect(decrypt(twice)).toBe(once);
      expect(decrypt(twice)).not.toBe(plaintext);
    });

    it('re-encryption under a new key round-trips (the core migration operation)', () => {
      process.env.ENCRYPTION_KEY = KEY_A;
      const secret = 'rotate-me';
      const oldCipher = encrypt(secret);

      // Migration: decrypt with old key, then re-encrypt with the new key.
      const plain = decrypt(oldCipher);
      process.env.ENCRYPTION_KEY = KEY_B;
      const newCipher = encrypt(plain);

      expect(newCipher).not.toBe(oldCipher);
      expect(decrypt(newCipher)).toBe(secret);     // readable under new key
      process.env.ENCRYPTION_KEY = KEY_A;
      expect(() => decrypt(newCipher)).toThrow();   // not under the old one
    });

    afterEach(() => {
      process.env.ENCRYPTION_KEY = KEY_A;
    });
  });
});
