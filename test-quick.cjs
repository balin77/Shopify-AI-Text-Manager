// Quick Test: Verschlüsselung testen
// Usage: node test-quick.js

require('dotenv').config();
const crypto = require('crypto');

// Kopiere die Funktionen aus encryption.ts
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function getEncryptionKey() {
  const envKey = process.env.ENCRYPTION_KEY;
  if (!envKey) {
    throw new Error('ENCRYPTION_KEY not set');
  }
  const keyBuffer = Buffer.from(envKey.trim(), 'hex');
  if (keyBuffer.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes`);
  }
  return keyBuffer;
}

function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${encrypted.toString('base64')}:${authTag.toString('base64')}`;
}

function decrypt(encryptedData) {
  const key = getEncryptionKey();
  const [ivBase64, encryptedBase64, authTagBase64] = encryptedData.split(':');
  const iv = Buffer.from(ivBase64, 'base64');
  const encrypted = Buffer.from(encryptedBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// === TESTS ===
console.log('🧪 Testing API Key Encryption\n');

// Test 1: Basic Encryption
console.log('Test 1: Basic Encryption/Decryption');
const testKey = 'hf_abc123xyz456';
console.log('  Original:', testKey);
const encrypted = encrypt(testKey);
console.log('  Encrypted:', encrypted.substring(0, 50) + '...');
const decrypted = decrypt(encrypted);
console.log('  Decrypted:', decrypted);
console.log('  ✅ Match:', testKey === decrypted ? 'YES' : 'NO');

// Test 2: Different API Key Types
console.log('\nTest 2: Different API Key Types');
const apiKeys = {
  'Hugging Face': 'hf_abcdefghijklmnopqrstuvwxyz1234567890',
  'Gemini': 'AIzaSyAbcdefGhijklmnopQrstuvwxyz123456',
  'Claude': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
  'OpenAI': 'sk-abcdefghijklmnopqrstuvwxyz1234567890',
};

let allPassed = true;
for (const [provider, key] of Object.entries(apiKeys)) {
  const enc = encrypt(key);
  const dec = decrypt(enc);
  const passed = key === dec;
  console.log(`  ${provider}: ${passed ? '✅' : '❌'}`);
  if (!passed) allPassed = false;
}

// Test 3: Random IV (same plaintext = different ciphertext)
console.log('\nTest 3: Random IV Test');
const plaintext = 'test-key';
const enc1 = encrypt(plaintext);
const enc2 = encrypt(plaintext);
console.log('  Same plaintext, different ciphertext:', enc1 !== enc2 ? '✅ YES' : '❌ NO');
console.log('  Both decrypt correctly:',
  (decrypt(enc1) === plaintext && decrypt(enc2) === plaintext) ? '✅ YES' : '❌ NO');

// Final Result
console.log('\n' + '='.repeat(50));
console.log(allPassed ? '✅ ALL TESTS PASSED!' : '❌ SOME TESTS FAILED!');
console.log('='.repeat(50));
