import { describe, it, expect, beforeEach } from 'vitest';
import {
  encrypt,
  decrypt,
  isEncrypted,
  generateEncryptionKey,
  encryptApiKey,
  decryptApiKey,
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

      expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY environment variable is not set');
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
      const tamperedData = parts[1].replace(/A/g, 'B');
      const tampered = `${parts[0]}:${tamperedData}:${parts[2]}`;

      // Decryption should fail due to auth tag mismatch
      expect(() => decrypt(tampered)).toThrow();
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
});
