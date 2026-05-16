# Session PII Encryption Setup Guide

This guide explains how to set up and use Session PII (Personally Identifiable Information) encryption for GDPR compliance.

## Overview

The Session table stores sensitive PII data that must be encrypted:
- `firstName` - User's first name
- `lastName` - User's last name
- `email` - User's email address
- `accessToken` - Shopify OAuth access token
- `refreshToken` - Shopify OAuth refresh token

**Encryption Method:** AES-256-GCM (same as API Keys)

**Status:** Encryption-at-rest for these fields is **implemented in runtime code**.
`EncryptedPrismaSessionStorage` ([app/utils/encrypted-session-storage.server.ts](../app/utils/encrypted-session-storage.server.ts))
wraps the Shopify SDK's `PrismaSessionStorage` and transparently:

- encrypts `accessToken`, `refreshToken` and online-session PII
  (`firstName`/`lastName`/`email`) on every `storeSession` (i.e. on every
  login and token refresh), and
- decrypts them again on `loadSession` and `findSessionsByShop`.

PII lives at `session.onlineAccessInfo.associated_user.{first_name,last_name,email}`
and only exists for **online** sessions — offline sessions carry no PII and are
left untouched. The one-time backfill
([scripts/migrate-encrypt-session-pii.ts](../scripts/migrate-encrypt-session-pii.ts))
only needs to be run once to encrypt rows written before this wrapper existed.

### Idempotency & migration assumptions

- **Write path** skips re-encrypting values that are already encrypted
  (`isEncrypted` guard), so re-storing a session does not double-encrypt PII.
- **Read path** is tolerant of plaintext: `decryptPII` passes pre-backfill
  plaintext values through unchanged, so legacy rows never crash a login.
- A PII decryption failure is **logged and the raw value is kept** — unlike a
  failed `accessToken` decryption, it does **not** force re-auth (a
  name/email we cannot decrypt must not invalidate an otherwise valid session).
- `gdpr.service.ts` reads `db.session` **directly via Prisma** (bypassing this
  wrapper) and decrypts with `decryptPII` itself exactly once — there is no
  double decryption.

---

## Setup Steps

### 1. Environment Configuration

Ensure `ENCRYPTION_KEY` is set in your environment:

```bash
# Generate a new 32-byte key (if not already done for API keys)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Set in Railway/Environment
ENCRYPTION_KEY=your_generated_key_here
```

**Important:** Use the **same** `ENCRYPTION_KEY` as for API key encryption.

### 2. Run Migration

**Dry Run (Recommended First):**
```bash
npx tsx scripts/migrate-encrypt-session-pii.ts
```

**Live Run (Apply Changes):**
```bash
npx tsx scripts/migrate-encrypt-session-pii.ts --live
```

**Automatic (Railway Pre-deploy):**
The migration runs automatically on Railway deployments via `node scripts/run-all-migrations.js`.

---

## Usage in Code

### Reading Session Data

When reading Session PII data, decrypt it:

```typescript
import { decryptPII, decryptToken } from '../utils/encryption';

// Example: GDPR Export
const session = await db.session.findUnique({ where: { id: sessionId } });

const firstName = decryptPII(session.firstName); // Decrypted
const lastName = decryptPII(session.lastName);   // Decrypted
const email = decryptPII(session.email);         // Decrypted
const accessToken = decryptToken(session.accessToken);   // Decrypted
const refreshToken = decryptToken(session.refreshToken); // Decrypted
```

**Note:** `decryptPII()` and `decryptToken()` handle:
- `null`/`undefined` values gracefully
- Already-decrypted data (backwards compatibility during migration)
- Encrypted data (automatic decryption)

### Writing Session Data

Session writes go through `EncryptedPrismaSessionStorage`, which encrypts
`accessToken`/`refreshToken` and online-session PII automatically. You do
**not** call `encryptPII`/`encryptToken` for normal login/token-refresh flows.

Direct `db.session` writes that bypass the storage wrapper are **rare** and
must encrypt the fields themselves:

```typescript
import { encryptPII, encryptToken } from '../utils/encryption';

// Only if you're manually creating/updating sessions (NOT recommended)
await db.session.update({
  where: { id: sessionId },
  data: {
    firstName: encryptPII(firstName),
    lastName: encryptPII(lastName),
    email: encryptPII(email),
    accessToken: encryptToken(accessToken),
    refreshToken: encryptToken(refreshToken),
  },
});
```

**Best Practice:** Let `EncryptedPrismaSessionStorage` handle Session storage.
You only need to call `decryptPII` yourself when **reading** Session rows
**directly via Prisma** (e.g. in GDPR exports), not when going through
`loadSession`/`findSessionsByShop`.

---

## GDPR Export Integration

The GDPR service has been updated to automatically decrypt Session PII:

```typescript
// app/services/gdpr.service.ts
import { decryptPII, decryptToken } from '../utils/encryption';

const sessions = await db.session.findMany({ where: { shop } });

// Decrypt PII before export
const exportData = sessions.map(session => ({
  ...session,
  firstName: decryptPII(session.firstName),
  lastName: decryptPII(session.lastName),
  email: decryptPII(session.email),
  accessToken: '[REDACTED]', // Never export tokens
  refreshToken: '[REDACTED]',
}));
```

---

## Migration Details

### What the Migration Does

1. **Identifies** unencrypted Session PII fields
2. **Encrypts** each field using AES-256-GCM
3. **Updates** the database with encrypted values
4. **Skips** already-encrypted data (idempotent)

### Migration Output

```
🔐 Session PII Encryption Migration
================================================================================

🔍 Validating environment...
✅ Environment validated
📊 Database: your-db.railway.app

📊 Found 42 sessions in database

🔄 Processing sessions in batches of 100...

📦 Batch 1: Processing 42 sessions...
  Processing session: offline_test-shop.my... (shop: test-shop.myshopify.com)
    ✅ Encrypted 5 field(s)
  Progress: 100% (42/42)

================================================================================
📊 Migration Summary
================================================================================
Mode: ✅ LIVE RUN (changes applied)

Sessions:
  Total:     42
  Processed: 42
  Encrypted: 42
  Skipped:   0 (already encrypted)
  Errors:    0

Fields Encrypted:
  firstName:    42
  lastName:     42
  email:        42
  accessToken:  42
  refreshToken: 0
================================================================================

✅ Migration completed successfully!

⚠️  IMPORTANT: All PII data is now encrypted.
   Make sure to use decryptPII/decryptToken when reading Session data.
```

---

## Security Benefits

### Before Encryption
```sql
SELECT * FROM "Session" LIMIT 1;

id       | shop                | firstName | email
---------|---------------------|-----------|-------------------
offline_ | test.myshopify.com  | John      | john@example.com
```

Anyone with database access can read PII in plaintext.

### After Encryption
```sql
SELECT * FROM "Session" LIMIT 1;

id       | shop                | firstName              | email
---------|---------------------|------------------------|------------------------
offline_ | test.myshopify.com  | a2V5MTIz:ZW5j:dGFn... | b3V0cHV0:ZGF0YQ==:dGFn...
```

PII is encrypted. Database leaks don't expose personal data.

---

## Compliance

### GDPR Requirements

✅ **Article 32: Security of Processing**
- PII is encrypted at rest using AES-256-GCM
- Encryption keys are stored separately (environment variables)
- Data breaches don't expose plaintext PII

✅ **Article 15: Right of Access**
- GDPR export service decrypts data for legitimate requests
- Encryption doesn't prevent data subject access

✅ **Article 17: Right to Erasure**
- Encrypted data is deleted on customer/shop redact requests
- Encryption doesn't prevent data deletion

---

## Troubleshooting

### Migration Fails with "ENCRYPTION_KEY not set"

**Cause:** `ENCRYPTION_KEY` environment variable missing

**Solution:**
```bash
# Generate key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Set in environment
export ENCRYPTION_KEY=your_generated_key_here

# Re-run migration
npx tsx scripts/migrate-encrypt-session-pii.ts --live
```

### Decryption Fails

**Cause:** Wrong `ENCRYPTION_KEY` or corrupted data

**Solution:**
1. Verify `ENCRYPTION_KEY` matches the key used for encryption
2. Check if data was corrupted during migration
3. Re-run migration if needed

### Session Login Issues

**Symptom:** Users can't log in after migration

**Cause:** Shopify SDK might not handle encrypted `accessToken` correctly

**Solution:**
The Shopify SDK (`PrismaSessionStorage`) manages sessions automatically and should handle encrypted tokens. If issues occur:

1. Check Shopify SDK logs for authentication errors
2. Verify `accessToken` is properly decrypted when needed
3. Consider selective encryption (encrypt PII only, not tokens)

---

## Rollback (Emergency)

If you need to rollback encryption (NOT recommended):

```typescript
// scripts/rollback-session-encryption.ts
import { db } from '../app/db.server';
import { decryptPII, decryptToken } from '../app/utils/encryption';

const sessions = await db.session.findMany();

for (const session of sessions) {
  await db.session.update({
    where: { id: session.id },
    data: {
      firstName: decryptPII(session.firstName),
      lastName: decryptPII(session.lastName),
      email: decryptPII(session.email),
      accessToken: decryptToken(session.accessToken),
      refreshToken: decryptToken(session.refreshToken),
    },
  });
}
```

**Warning:** This exposes PII in plaintext again. Only use in emergencies.

---

## Testing

### Test Encryption/Decryption

```bash
node -e "
const { encryptPII, decryptPII } = require('./app/utils/encryption');

const plaintext = 'John Doe';
const encrypted = encryptPII(plaintext);
const decrypted = decryptPII(encrypted);

console.log('Plaintext:', plaintext);
console.log('Encrypted:', encrypted);
console.log('Decrypted:', decrypted);
console.log('Match:', plaintext === decrypted);
"
```

### Test GDPR Export

```bash
# Trigger a GDPR data request webhook
curl -X POST https://your-app.com/webhooks/gdpr/customers/data_request \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Hmac-Sha256: VALID_HMAC" \
  -d '{
    "shop_domain": "test-shop.myshopify.com",
    "customer": {
      "id": 12345,
      "email": "test@example.com"
    }
  }'
```

Verify that exported data contains decrypted PII.

---

## Production Checklist

Before deploying to production:

- [ ] `ENCRYPTION_KEY` is set in Railway environment variables
- [ ] Migration tested in dry-run mode
- [ ] Migration applied with `--live` flag
- [ ] GDPR export tested with encrypted data
- [ ] Shopify login still works after encryption
- [ ] Logs don't expose decrypted PII
- [ ] Backup created before migration

---

## Support

For issues or questions:
1. Check [SECURITY_IMPROVEMENTS.md](./SECURITY_IMPROVEMENTS.md)
2. Review [API_KEY_ENCRYPTION_SETUP.md](./API_KEY_ENCRYPTION_SETUP.md) (similar setup)
3. Examine migration logs for errors

---

**Last Updated:** 2026-05-16
**Version:** 1.1.0
**Status:** ✅ Implemented — PII encrypted at rest via `EncryptedPrismaSessionStorage` (runtime), backfill script for legacy rows
