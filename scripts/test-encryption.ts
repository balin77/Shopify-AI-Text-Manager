/**
 * Test Script: Verify Encryption/Decryption Works
 *
 * This script tests the encryption and decryption functionality
 * to ensure API keys can be safely encrypted and decrypted.
 *
 * Usage:
 *   node --require dotenv/config --loader tsx scripts/test-encryption.ts
 *
 * Tests:
 *   1. Encryption of sample API keys
 *   2. Decryption back to original values
 *   3. isEncrypted() detection
 *   4. Error handling
 */

import { encrypt, decrypt, isEncrypted, encryptApiKey, decryptApiKey } from '../app/utils/encryption';

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, passed: true, message: 'Passed' });
    console.log(`✅ ${name}`);
  } catch (error) {
    results.push({
      name,
      passed: false,
      message: error instanceof Error ? error.message : String(error),
    });
    console.error(`❌ ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

async function runTests() {
  console.log('🧪 Starting Encryption Tests');
  console.log('============================\n');

  // Check if ENCRYPTION_KEY is set
  if (!process.env.ENCRYPTION_KEY) {
    console.error('❌ ERROR: ENCRYPTION_KEY environment variable is not set!');
    console.error('Generate one with:');
    console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    console.error('\nThen add to .env file:');
    console.error('  ENCRYPTION_KEY=your_generated_key');
    process.exit(1);
  }

  console.log('✅ ENCRYPTION_KEY is set\n');

  // Test 1: Basic encryption/decryption
  test('Test 1: Basic encrypt/decrypt', () => {
    const plaintext = 'my-secret-api-key-123';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);

    if (plaintext !== decrypted) {
      throw new Error(`Expected "${plaintext}", got "${decrypted}"`);
    }
  });

  // Test 2: Encryption format
  test('Test 2: Encrypted format is correct', () => {
    const plaintext = 'test-key';
    const encrypted = encrypt(plaintext);
    const parts = encrypted.split(':');

    if (parts.length !== 3) {
      throw new Error(`Expected format {iv}:{data}:{tag}, got ${parts.length} parts`);
    }

    // Check each part is valid Base64
    const base64Regex = /^[A-Za-z0-9+/]+=*$/;
    parts.forEach((part, index) => {
      if (!base64Regex.test(part)) {
        throw new Error(`Part ${index} is not valid Base64`);
      }
    });
  });

  // Test 3: isEncrypted() detection
  test('Test 3: isEncrypted() detects encrypted data', () => {
    const plaintext = 'hf_abc123xyz';
    const encrypted = encrypt(plaintext);

    if (!isEncrypted(encrypted)) {
      throw new Error('isEncrypted() should return true for encrypted data');
    }

    if (isEncrypted(plaintext)) {
      throw new Error('isEncrypted() should return false for plain text');
    }

    if (isEncrypted(null)) {
      throw new Error('isEncrypted() should return false for null');
    }

    if (isEncrypted('')) {
      throw new Error('isEncrypted() should return false for empty string');
    }
  });

  // Test 4: Different plaintext produces different ciphertext (due to random IV)
  test('Test 4: Same plaintext produces different ciphertext (random IV)', () => {
    const plaintext = 'test-key';
    const encrypted1 = encrypt(plaintext);
    const encrypted2 = encrypt(plaintext);

    if (encrypted1 === encrypted2) {
      throw new Error('Same plaintext should produce different ciphertext (due to random IV)');
    }

    // But both should decrypt to the same value
    const decrypted1 = decrypt(encrypted1);
    const decrypted2 = decrypt(encrypted2);

    if (decrypted1 !== plaintext || decrypted2 !== plaintext) {
      throw new Error('Both encrypted values should decrypt to original plaintext');
    }
  });

  // Test 5: encryptApiKey() handles null/undefined
  test('Test 5: encryptApiKey() handles null/undefined', () => {
    const result1 = encryptApiKey(null);
    const result2 = encryptApiKey(undefined);
    const result3 = encryptApiKey('');

    if (result1 !== null || result2 !== null || result3 !== null) {
      throw new Error('encryptApiKey() should return null for empty inputs');
    }
  });

  // Test 6: decryptApiKey() handles null/undefined
  test('Test 6: decryptApiKey() handles null/undefined', () => {
    const result1 = decryptApiKey(null);
    const result2 = decryptApiKey(undefined);
    const result3 = decryptApiKey('');

    if (result1 !== null || result2 !== null || result3 !== null) {
      throw new Error('decryptApiKey() should return null for empty inputs');
    }
  });

  // Test 7: decryptApiKey() returns plaintext if not encrypted (backwards compatibility)
  test('Test 7: decryptApiKey() handles unencrypted data (backwards compatibility)', () => {
    const plaintext = 'hf_abc123xyz';
    const result = decryptApiKey(plaintext);

    if (result !== plaintext) {
      throw new Error('decryptApiKey() should return plaintext for unencrypted data');
    }
  });

  // Test 8: Realistic API key examples
  test('Test 8: Hugging Face API key', () => {
    const apiKey = 'hf_abcdefghijklmnopqrstuvwxyz1234567890';
    const encrypted = encryptApiKey(apiKey);
    const decrypted = decryptApiKey(encrypted);

    if (decrypted !== apiKey) {
      throw new Error(`Expected "${apiKey}", got "${decrypted}"`);
    }
  });

  test('Test 9: Gemini API key', () => {
    const apiKey = 'AIzaSyAbcdefGhijklmnopQrstuvwxyz123456';
    const encrypted = encryptApiKey(apiKey);
    const decrypted = decryptApiKey(encrypted);

    if (decrypted !== apiKey) {
      throw new Error(`Expected "${apiKey}", got "${decrypted}"`);
    }
  });

  test('Test 10: Claude API key', () => {
    const apiKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrs';
    const encrypted = encryptApiKey(apiKey);
    const decrypted = decryptApiKey(encrypted);

    if (decrypted !== apiKey) {
      throw new Error(`Expected "${apiKey}", got "${decrypted}"`);
    }
  });

  test('Test 11: OpenAI API key', () => {
    const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH';
    const encrypted = encryptApiKey(apiKey);
    const decrypted = decryptApiKey(encrypted);

    if (decrypted !== apiKey) {
      throw new Error(`Expected "${apiKey}", got "${decrypted}"`);
    }
  });

  // Test 12: Special characters and Unicode
  test('Test 12: Special characters', () => {
    const specialChars = 'Key-with-special!@#$%^&*()_+=[]{}|;:,.<>?/~`';
    const encrypted = encrypt(specialChars);
    const decrypted = decrypt(encrypted);

    if (decrypted !== specialChars) {
      throw new Error(`Expected "${specialChars}", got "${decrypted}"`);
    }
  });

  test('Test 13: Unicode characters', () => {
    const unicode = 'Key-äöü-日本語-🔐';
    const encrypted = encrypt(unicode);
    const decrypted = decrypt(encrypted);

    if (decrypted !== unicode) {
      throw new Error(`Expected "${unicode}", got "${decrypted}"`);
    }
  });

  // Test 14: Long strings
  test('Test 14: Long API key (500 characters)', () => {
    const longKey = 'x'.repeat(500);
    const encrypted = encrypt(longKey);
    const decrypted = decrypt(encrypted);

    if (decrypted !== longKey) {
      throw new Error('Failed to encrypt/decrypt long string');
    }
  });

  // Test 15: Error handling - invalid encrypted data
  test('Test 15: Error handling - invalid encrypted data', () => {
    try {
      decrypt('invalid-data-not-encrypted');
      throw new Error('Should have thrown an error for invalid data');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Invalid encrypted data format')) {
        // Expected error
      } else {
        throw error;
      }
    }
  });

  // Test 16: Error handling - tampered data
  test('Test 16: Error handling - tampered auth tag', () => {
    const plaintext = 'test-key';
    const encrypted = encrypt(plaintext);
    const [iv, data, authTag] = encrypted.split(':');

    // Tamper with auth tag
    const tamperedAuthTag = 'dGFtcGVyZWQ=';
    const tampered = `${iv}:${data}:${tamperedAuthTag}`;

    try {
      decrypt(tampered);
      throw new Error('Should have thrown an error for tampered data');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Failed to decrypt')) {
        // Expected error
      } else {
        throw error;
      }
    }
  });

  // Print summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(50));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`Total tests: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log('\n❌ FAILED TESTS:');
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`  - ${r.name}: ${r.message}`);
      });
  }

  if (failed === 0) {
    console.log('\n✅ All tests passed!');
    console.log('Encryption is working correctly.');
  } else {
    console.log('\n❌ Some tests failed!');
    console.log('Please check the errors above.');
  }

  return failed === 0;
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Test execution failed:', error);
      process.exit(1);
    });
}

export { runTests };
