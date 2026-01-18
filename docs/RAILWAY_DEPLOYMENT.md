# Railway Deployment Guide

## Custom Start Command

Railway benötigt ein Custom Start Command, um Datenbankmigrationen automatisch vor dem App-Start auszuführen.

### Für Railway:

```bash
node scripts/run-migration.js && npm run start
```

Dieses Command:
1. ✅ Prüft ob DATABASE_URL konfiguriert ist
2. 🔄 Führt alle Migrationen aus (inkl. WebhookRetry)
3. 🔨 Generiert Prisma Client
4. 🚀 Startet die Applikation

### Alternativ: Mit npm script

Railway kann auch dieses npm script verwenden:

```bash
npm run start:migrate
```

## Migrationen

Aktuelle Migrationen (werden automatisch ausgeführt):

1. **add_entity_specific_ai_instructions.sql**
   - Fügt AI Instructions für verschiedene Content-Typen hinzu

2. **20250113_add_menu_model.sql**
   - Fügt Menu-Model für Navigation Menüs hinzu

3. **20260114_add_prompt_to_task.sql**
   - Fügt Prompt-Feld zu Task-Model hinzu

4. **20260116_add_webhook_retry.sql** 🆕
   - Fügt WebhookRetry-Model für Webhook-Retry-Logic hinzu
   - Exponential Backoff für fehlgeschlagene Webhooks
   - Verhindert Datenverlust bei temporären Fehlern

## Manuelle Migration (Local Development)

Falls du die Migration lokal ausführen möchtest:

```bash
# Option 1: Mit Prisma CLI (benötigt DATABASE_URL)
npx prisma migrate deploy

# Option 2: Mit dem Migration Script
node scripts/run-migration.js

# Option 3: Mit npm script
npm run prisma:migrate:predeploy
```

## Environment Variables

Stelle sicher, dass folgende Environment Variables in Railway konfiguriert sind:

### Required:
- `DATABASE_URL` - PostgreSQL Connection String
- `SHOPIFY_API_KEY` - Shopify App API Key
- `SHOPIFY_API_SECRET` - Shopify App API Secret
- `ENCRYPTION_KEY` - 64-character hex key für API Key Encryption
- `SESSION_SECRET` - Session Secret für Cookie Encryption

### Optional (AI Providers):
- `HUGGINGFACE_API_KEY`
- `GEMINI_API_KEY`
- `CLAUDE_API_KEY`
- `OPENAI_API_KEY`
- `GROK_API_KEY`
- `DEEPSEEK_API_KEY`

## Troubleshooting

### Migration schlägt fehl

**Problem:** `Table "WebhookRetry" already exists`

**Lösung:**
```sql
-- Verbinde dich mit der Datenbank und prüfe:
SELECT * FROM "WebhookRetry" LIMIT 1;

-- Falls die Tabelle leer oder veraltet ist:
DROP TABLE "WebhookRetry";

-- Dann Railway neu deployen (Migration wird automatisch ausgeführt)
```

### DATABASE_URL nicht gefunden

**Problem:** `Environment variable not found: DATABASE_URL`

**Lösung:**
1. Gehe zu Railway Dashboard
2. Wähle dein Projekt
3. Klicke auf "Variables"
4. Füge `DATABASE_URL` mit deinem PostgreSQL Connection String hinzu
5. Redeploy

### Prisma Client Generation schlägt fehl

**Problem:** `Failed to generate Prisma Client`

**Lösung:**
```bash
# Local:
npm run prisma:generate

# Railway wird es automatisch mit postinstall hook generieren
```

## Logs überprüfen

Railway Logs zeigen den Migration-Fortschritt:

```
🚀 Starting Railway deployment with database migration...
✅ DATABASE_URL is configured
📦 Running migration: 20260116_add_webhook_retry.sql...
✅ Migration 20260116_add_webhook_retry.sql completed successfully
🔨 Generating Prisma Client...
✅ Prisma Client generated successfully
✅ Database setup complete!
🚀 Ready to start application...
```

## Webhook Retry System

Nach erfolgreichem Deployment ist das Webhook Retry System aktiv:

- ✅ Automatische Wiederholung fehlgeschlagener Webhooks
- ✅ Exponential Backoff: 1s → 2s → 4s → 8s → 16s → 60s
- ✅ Max 5 Versuche
- ✅ Automatisches Cleanup nach 7 Tagen
- ✅ Strukturiertes Logging mit Winston

### Monitoring

Webhook Retry Status prüfen:

```typescript
import { webhookRetryService } from '~/services/webhook-retry.service';

// Statistiken abrufen
const stats = await webhookRetryService.getStats();
console.log('Pending retries:', stats.total);
console.log('By topic:', stats.byTopic);
console.log('By attempt:', stats.byAttempt);
```

## Weitere Ressourcen

- [Railway Docs](https://docs.railway.app/)
- [Prisma Migrations](https://www.prisma.io/docs/concepts/components/prisma-migrate)
- [WEBHOOK-SETUP-GUIDE.md](./WEBHOOK-SETUP-GUIDE.md)
