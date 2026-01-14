# API Key Encryption Setup Guide

## Overview

Die Shopify API Connector App verschlüsselt nun alle API Keys in der Datenbank mit **AES-256-GCM** Verschlüsselung. Dies schützt sensitive API Keys bei einem Datenbank-Leak.

## Warum ist das wichtig?

**Vor der Verschlüsselung:**
```
AISettings Table (Klartext):
huggingfaceApiKey: "hf_abc123xyz..."  ❌ Sichtbar bei DB-Leak
geminiApiKey: "AIzaSyXYZ..."          ❌ Sichtbar bei DB-Leak
claudeApiKey: "sk-ant-api03-..."      ❌ Sichtbar bei DB-Leak
```

**Nach der Verschlüsselung:**
```
AISettings Table (Verschlüsselt):
huggingfaceApiKey: "dGhpcyBpcyBlbmNyeXB0ZWQ=:..."  ✅ Unlesbar
geminiApiKey: "a2V5MTIzNDU2Nzg=:..."               ✅ Unlesbar
claudeApiKey: "ZW5jcnlwdGVkZGF0YQ==:..."           ✅ Unlesbar
```

## Setup Instructions

### 1. Generate Encryption Key

Generiere einen sicheren 32-Byte (256-bit) Encryption Key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Output Beispiel:**
```
a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456
```

⚠️ **WICHTIG:** Speichere diesen Key sicher! Ohne diesen Key können verschlüsselte API Keys nicht entschlüsselt werden.

### 2. Add to Environment Variables

#### Lokale Entwicklung (.env)
```bash
# .env
ENCRYPTION_KEY=a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456
```

#### Railway Deployment
1. Gehe zu Railway Dashboard
2. Wähle dein Projekt
3. Navigiere zu **Variables** Tab
4. Füge hinzu:
   - Variable: `ENCRYPTION_KEY`
   - Value: `a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456`

#### Heroku Deployment
```bash
heroku config:set ENCRYPTION_KEY=a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456
```

#### Docker Deployment
```yaml
# docker-compose.yml
environment:
  - ENCRYPTION_KEY=a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456
```

### 3. Migrate Existing API Keys (Einmalig)

⚠️ **Backup your database first!**

```bash
# Backup Datenbank (PostgreSQL Beispiel)
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d_%H%M%S).sql

# Run Migration
node --require dotenv/config --loader tsx scripts/migrate-encrypt-api-keys.ts
```

**Was passiert:**
- ✅ Liest alle AISettings aus der Datenbank
- ✅ Prüft, ob Keys bereits verschlüsselt sind
- ✅ Verschlüsselt Klartext-Keys
- ✅ Updated die Datenbank
- ✅ Loggt alle Änderungen

**Beispiel Output:**
```
🔐 Starting API Key Encryption Migration
========================================

📊 Found 3 shop(s) with AI settings

🏪 Processing shop: my-shop.myshopify.com
──────────────────────────────────────────────────
  huggingfaceApiKey: Newly encrypted ✓
  geminiApiKey: Already encrypted ✓
  claudeApiKey: Empty (skipped)
  openaiApiKey: Newly encrypted ✓
  grokApiKey: Empty (skipped)
  deepseekApiKey: Empty (skipped)

  ✅ Updated 2 key(s) in database

==================================================
📋 MIGRATION SUMMARY
==================================================
Total shops processed:      3
Total API keys checked:     18
  - Already encrypted:      3
  - Newly encrypted:        6
  - Empty (skipped):        9
  - Errors:                 0

✅ Migration completed successfully!
6 API key(s) have been encrypted.
```

### 4. Deploy Application

Nach der Migration deployest du die neue Version:

```bash
# Build
npm run build

# Deploy (Railway pusht automatisch bei git push)
git push

# Oder manuell auf Railway
railway up
```

### 5. Verify Encryption Works

Nach dem Deployment teste die Verschlüsselung:

1. **Gehe zu Settings** in der App
2. **Füge einen neuen API Key** hinzu
3. **Speichere** die Einstellungen
4. **Prüfe die Datenbank:**

```sql
SELECT shop, huggingfaceApiKey FROM "AISettings" LIMIT 1;
```

**Erwartetes Ergebnis:**
```
shop                      | huggingfaceApiKey
--------------------------+--------------------------------------------
my-shop.myshopify.com     | a2V5MTIzNDU2Nzg=:ZW5jcnlwdGVkZGF0YQ==:dGFn...
```

Der API Key sollte im Format `{iv}:{encryptedData}:{authTag}` sein (Base64).

## How It Works

### Encryption Process

```typescript
// User gibt API Key ein
const userInput = "hf_abc123xyz...";

// App verschlüsselt
import { encryptApiKey } from './utils/encryption';
const encrypted = encryptApiKey(userInput);
// "a2V5MTIzNDU2Nzg=:ZW5jcnlwdGVkZGF0YQ==:dGFnMTIz..."

// Speichert in DB
await db.aISettings.update({ huggingfaceApiKey: encrypted });
```

### Decryption Process

```typescript
// App liest aus DB
const settings = await db.aISettings.findUnique({ where: { shop } });

// App entschlüsselt
import { decryptApiKey } from './utils/encryption';
const apiKey = decryptApiKey(settings.huggingfaceApiKey);
// "hf_abc123xyz..."

// Verwendet für AI Service
const aiService = new AIService(provider, { huggingfaceApiKey: apiKey });
```

## Security Features

### AES-256-GCM
- **Algorithm:** AES-256-GCM (NIST-empfohlen)
- **Key Length:** 256 bits (32 bytes)
- **IV (Initialization Vector):** 12 bytes (random pro Verschlüsselung)
- **Auth Tag:** 16 bytes (Integritätsschutz)

### Why GCM?
- ✅ **Confidentiality:** Daten sind verschlüsselt
- ✅ **Authenticity:** Auth Tag verhindert Manipulation
- ✅ **Performance:** Schneller als andere Modi
- ✅ **NIST-Standard:** Industriestandard

### Storage Format
```
{iv}:{encryptedData}:{authTag}

Beispiel:
a2V5MTIzNDU2Nzg=:ZW5jcnlwdGVkZGF0YQ==:dGFnMTIzNDU2Nzg5MA==
     ↑                  ↑                      ↑
    IV          Encrypted Data           Auth Tag
(12 bytes)      (variable length)      (16 bytes)
```

## Troubleshooting

### Problem: "ENCRYPTION_KEY environment variable is not set"

**Lösung:**
1. Generiere einen Key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Füge zu `.env` hinzu: `ENCRYPTION_KEY=your_generated_key`
3. Starte die App neu

### Problem: "Failed to decrypt data"

**Mögliche Ursachen:**
1. ENCRYPTION_KEY wurde geändert nach der Verschlüsselung
2. Daten wurden manuell in der Datenbank verändert
3. ENCRYPTION_KEY ist nicht gesetzt

**Lösung:**
- Verwende den **originalen** ENCRYPTION_KEY
- Wenn Key verloren: Lösche alle API Keys aus DB und lasse User neu eingeben

### Problem: "Invalid encrypted data format"

**Ursache:** Daten im falschen Format (nicht `{iv}:{data}:{tag}`)

**Lösung:**
- Prüfe ob Migration durchgeführt wurde
- Manuell geänderte Daten können nicht entschlüsselt werden

### Problem: Migration findet keine Shops

**Ursache:** Keine Einträge in AISettings Tabelle

**Lösung:** Normal - wenn noch keine API Keys gespeichert wurden

## Key Rotation (Optional)

Falls du den ENCRYPTION_KEY ändern möchtest:

1. **Backup Datenbank**
2. **Entschlüssele alle Keys mit altem Key:**
   ```typescript
   // OLD_KEY in .env setzen
   const oldKeys = await decryptAllKeys(OLD_KEY);
   ```
3. **Re-encrypt mit neuem Key:**
   ```typescript
   // NEW_KEY in .env setzen
   await encryptAllKeys(NEW_KEY, oldKeys);
   ```
4. **Update ENCRYPTION_KEY** in Environment Variables

⚠️ **Niemals beide Keys gleichzeitig ändern!**

## Best Practices

### ✅ DO
- Generiere einen sicheren, zufälligen Key
- Speichere ENCRYPTION_KEY sicher (Password Manager, Secrets Manager)
- Backup Datenbank vor Migration
- Teste auf Staging-Environment zuerst
- Rotiere Keys regelmäßig (alle 1-2 Jahre)

### ❌ DON'T
- Committe ENCRYPTION_KEY nicht in Git
- Verwende keine einfachen Keys wie "password123"
- Ändere ENCRYPTION_KEY nicht ohne Re-Encryption
- Teile ENCRYPTION_KEY nicht mit unauthorized Personen

## Production Checklist

- [ ] ENCRYPTION_KEY generiert (32 bytes hex)
- [ ] ENCRYPTION_KEY in Environment Variables gesetzt
- [ ] Datenbank Backup erstellt
- [ ] Migration auf Staging getestet
- [ ] Migration auf Production durchgeführt
- [ ] Neue Keys in App UI getestet
- [ ] Encryption in Datenbank verifiziert
- [ ] ENCRYPTION_KEY sicher gespeichert (Password Manager)

## Support

Bei Fragen oder Problemen:
1. Prüfe die Logs: `railway logs` oder `heroku logs --tail`
2. Verifiziere ENCRYPTION_KEY: `echo $ENCRYPTION_KEY`
3. Teste Verschlüsselung manuell:
   ```typescript
   import { encrypt, decrypt } from './app/utils/encryption';
   const enc = encrypt('test');
   const dec = decrypt(enc);
   console.log(dec); // Should be 'test'
   ```

---

**Erstellt:** 2026-01-14
**Version:** 1.0.0
**Status:** ✅ Production Ready
