# Prisma Migration Guide für Railway

> **Wichtig:** Railway erlaubt nur **Pre-deploy Commands** für Migrations. Custom Start Commands und andere Methoden funktionieren nicht zuverlässig.

## 📋 Inhaltsverzeichnis

1. [Schnellanleitung](#schnellanleitung)
2. [Pre-deploy Command Setup](#pre-deploy-command-setup)
3. [Migration Script erstellen](#migration-script-erstellen)
4. [SQL Migration erstellen](#sql-migration-erstellen)
5. [Testing](#testing)
6. [Troubleshooting](#troubleshooting)
7. [Best Practices](#best-practices)

---

## Schnellanleitung

### Für eine neue Migration:

1. **SQL-Datei erstellen** in `prisma/migrations/`
2. **Migration Script** in `scripts/` erstellen (ESM-Syntax!)
3. **Pre-deploy Command** in Railway setzen
4. **Pushen** → Railway führt Migration automatisch aus

---

## Pre-deploy Command Setup

### Railway Dashboard Einstellungen

1. **Railway Dashboard öffnen**
2. **Dein Projekt auswählen**
3. **Settings → Deploy**
4. **Pre-deploy Command** eingeben:

```bash
node scripts/run-migration.js
```

5. **Save Changes**
6. Bei nächstem Deployment wird das Script VOR dem App-Start ausgeführt

### Was ist ein Pre-deploy Command?

- ✅ Läuft **vor** dem eigentlichen App-Start
- ✅ Perfekt für Datenbank-Migrationen
- ✅ Bei Fehler wird Deployment abgebrochen (sicher!)
- ✅ Logs sind sichtbar im Railway Dashboard

---

## Migration Script erstellen

### Template für `scripts/run-migration.js`

**⚠️ WICHTIG:** Da dein Projekt `"type": "module"` in package.json hat, **MUSS** das Script ES Modules Syntax verwenden!

```javascript
#!/usr/bin/env node
/**
 * Prisma Migration Runner für Railway
 *
 * Dieses Script wird vom Pre-deploy Command ausgeführt.
 * Es führt SQL-Migrationen aus und generiert den Prisma Client.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function runCommand(command, errorMessage) {
  try {
    execSync(command, { stdio: 'inherit' });
    return true;
  } catch (error) {
    log(`❌ ${errorMessage}`, 'red');
    log(`Error: ${error.message}`, 'red');
    return false;
  }
}

async function main() {
  log('🚀 Starting Pre-deploy Migration...', 'blue');

  // 1. Check DATABASE_URL
  if (!process.env.DATABASE_URL) {
    log('❌ ERROR: DATABASE_URL not set!', 'red');
    process.exit(1);
  }
  log('✅ DATABASE_URL configured', 'green');

  // 2. Run SQL Migration (falls vorhanden)
  const migrationPath = path.join(
    __dirname,
    '..',
    'prisma',
    'migrations',
    'your_migration_file.sql'  // <-- HIER DEINEN DATEINAMEN EINTRAGEN!
  );

  if (fs.existsSync(migrationPath)) {
    log('📦 Running SQL migration...', 'blue');

    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    const tempSqlPath = path.join(__dirname, '..', 'temp_migration.sql');
    fs.writeFileSync(tempSqlPath, migrationSQL);

    const success = runCommand(
      `npx prisma db execute --file ${tempSqlPath} --schema prisma/schema.prisma`,
      'Migration failed'
    );

    // Cleanup
    try { fs.unlinkSync(tempSqlPath); } catch (e) {}

    if (success) {
      log('✅ SQL Migration completed', 'green');
    } else {
      log('⚠️  SQL Migration failed, continuing...', 'yellow');
    }
  } else {
    log('ℹ️  No SQL migration file found, skipping...', 'blue');
  }

  // 3. Generate Prisma Client
  log('🔨 Generating Prisma Client...', 'blue');
  const genSuccess = runCommand(
    'npx prisma generate',
    'Failed to generate Prisma Client'
  );

  if (!genSuccess) {
    log('❌ Prisma generate failed!', 'red');
    process.exit(1);
  }

  log('✅ Migration complete!', 'green');
}

main().catch((error) => {
  log(`❌ Unexpected error: ${error.message}`, 'red');
  process.exit(1);
});
```

### Script in package.json registrieren

```json
{
  "scripts": {
    "migrate": "node scripts/run-migration.js"
  }
}
```

---

## SQL Migration erstellen

### 1. Schema in `prisma/schema.prisma` ändern

```prisma
model MyModel {
  id        String   @id @default(cuid())
  newField  String?  // Neue Spalte
  createdAt DateTime @default(now())
}
```

### 2. SQL-Datei erstellen

Erstelle Datei: `prisma/migrations/YYYYMMDD_beschreibung.sql`

**Beispiel:** `prisma/migrations/20250113_add_new_field.sql`

```sql
-- ============================================
-- Migration: Add newField to MyModel
-- Date: 2025-01-13
-- ============================================

-- Idempotent: Prüft ob Spalte bereits existiert
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'MyModel'
        AND column_name = 'newField'
    ) THEN
        ALTER TABLE "MyModel" ADD COLUMN "newField" TEXT;
        RAISE NOTICE '✅ Added newField column';
    ELSE
        RAISE NOTICE 'ℹ️  newField column already exists, skipping...';
    END IF;
END $$;
```

### 3. Migration Script aktualisieren

In `scripts/run-migration.js` den Dateinamen anpassen:

```javascript
const migrationPath = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20250113_add_new_field.sql'  // <-- HIER!
);
```

---

## Testing

### Lokal testen (vor Railway Deploy)

```bash
# 1. .env mit DATABASE_URL erstellen
echo "DATABASE_URL=postgresql://..." > .env

# 2. Migration Script ausführen
npm run migrate

# 3. Überprüfen
npx prisma studio
```

### Railway Test-Deployment

```bash
# Railway CLI verwenden
railway login
railway link
railway run npm run migrate
```

### Logs überprüfen

**Railway Dashboard:**
- Build Logs → Suche nach "Pre-deploy Command"
- Schaue nach ✅ und ❌ Meldungen

```
🚀 Starting Pre-deploy Migration...
✅ DATABASE_URL configured
📦 Running SQL migration...
✅ SQL Migration completed
🔨 Generating Prisma Client...
✅ Migration complete!
```

---

## Troubleshooting

### Problem: "DATABASE_URL not found"

**Lösung:**
```bash
# Railway Variables checken
railway variables

# Falls nicht gesetzt:
railway variables set DATABASE_URL="postgresql://..."
```

### Problem: "require is not defined"

**Ursache:** Script verwendet CommonJS statt ESM

**Lösung:** Verwende `import` statt `require`:
```javascript
// ❌ Falsch
const fs = require('fs');

// ✅ Richtig
import fs from 'fs';
```

### Problem: "Migration file not found"

**Lösung:**
```bash
# Dateien committen und pushen
git add prisma/migrations/
git add scripts/
git commit -m "Add migration"
git push
```

### Problem: "Permission denied"

**Lösung:** Datenbank-User braucht CREATE/ALTER Rechte:
```sql
GRANT CREATE, ALTER ON DATABASE your_db TO your_user;
```

### Problem: Pre-deploy Command wird nicht ausgeführt

**Checkliste:**
- [ ] Pre-deploy Command in Railway Settings gesetzt?
- [ ] Script-Datei existiert und ist gepusht?
- [ ] Script ist ausführbar? (`chmod +x scripts/run-migration.js`)
- [ ] Keine Syntax-Fehler im Script?

**Debug:**
```bash
# Logs anschauen
railway logs --deployment <deployment-id>
```

---

## Best Practices

### 1. Immer idempotente Migrationen schreiben

```sql
-- ✅ Gut: Prüft vor dem Ändern
DO $$
BEGIN
    IF NOT EXISTS (...) THEN
        ALTER TABLE ...
    END IF;
END $$;

-- ❌ Schlecht: Schlägt beim 2. Mal fehl
ALTER TABLE "MyTable" ADD COLUMN "myColumn" TEXT;
```

### 2. Migration-Dateinamen mit Datum versehen

```
prisma/migrations/
├── 20250113_add_grok_support.sql
├── 20250114_add_entity_instructions.sql
└── 20250115_add_new_feature.sql
```

### 3. Immer testen vor Production Deploy

```bash
# 1. Lokal testen
npm run migrate

# 2. Railway Preview Deployment testen
railway up --detach
```

### 4. Migrations dokumentieren

In der SQL-Datei:
```sql
-- ============================================
-- Migration: Add Grok/DeepSeek Support
-- Date: 2025-01-13
-- Author: Developer Name
-- Ticket: PROJ-123
-- ============================================
-- Description:
-- - Adds grokApiKey and deepseekApiKey columns
-- - Adds rate limiting columns for both providers
-- ============================================
```

### 5. Rollback-Plan haben

```sql
-- ROLLBACK (falls nötig):
-- ALTER TABLE "AISettings" DROP COLUMN IF EXISTS "grokApiKey";
-- ALTER TABLE "AISettings" DROP COLUMN IF EXISTS "deepseekApiKey";
```

### 6. Mehrere Migrationen? Ein Script pro Migration!

Struktur:
```
scripts/
├── run-migration.js           # Haupt-Script
├── migrations/
│   ├── 001-add-grok.js       # Spezifische Migration
│   └── 002-add-entity.js     # Spezifische Migration
```

### 7. Environment-spezifische Migrationen

```javascript
// In run-migration.js
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  // Nur in Production ausführen
  log('Running production-only migration...', 'yellow');
}
```

---

## Checkliste für neue Migration

- [ ] **Schema aktualisiert** (`prisma/schema.prisma`)
- [ ] **SQL-Datei erstellt** (`prisma/migrations/YYYYMMDD_name.sql`)
- [ ] **Idempotent** (kann mehrfach ausgeführt werden)
- [ ] **Migration Script aktualisiert** (Dateiname eingefügt)
- [ ] **Lokal getestet** (`npm run migrate`)
- [ ] **Dokumentiert** (Kommentare in SQL)
- [ ] **Rollback-Plan** (als Kommentar in SQL)
- [ ] **Committet und gepusht**
- [ ] **Pre-deploy Command in Railway gesetzt**
- [ ] **Railway Logs überwacht** nach Deployment

---

## Beispiel: Komplette Migration End-to-End

### Schritt 1: Schema ändern

```prisma
// prisma/schema.prisma
model AISettings {
  id          String  @id @default(cuid())
  newProvider String? // NEU
}
```

### Schritt 2: SQL Migration erstellen

```sql
-- prisma/migrations/20250115_add_new_provider.sql
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AISettings'
        AND column_name = 'newProvider'
    ) THEN
        ALTER TABLE "AISettings" ADD COLUMN "newProvider" TEXT;
    END IF;
END $$;
```

### Schritt 3: Migration Script erstellen/aktualisieren

```javascript
// scripts/run-migration-20250115.js
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log('🚀 Running migration: Add new provider');

  const migrationPath = path.join(
    __dirname,
    '..',
    'prisma',
    'migrations',
    '20250115_add_new_provider.sql'
  );

  if (fs.existsSync(migrationPath)) {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const tempPath = path.join(__dirname, '..', 'temp.sql');
    fs.writeFileSync(tempPath, sql);

    try {
      execSync(
        `npx prisma db execute --file ${tempPath} --schema prisma/schema.prisma`,
        { stdio: 'inherit' }
      );
      console.log('✅ Migration successful');
    } catch (error) {
      console.error('❌ Migration failed:', error.message);
      process.exit(1);
    } finally {
      fs.unlinkSync(tempPath);
    }
  }

  // Generate Prisma Client
  execSync('npx prisma generate', { stdio: 'inherit' });
}

main();
```

### Schritt 4: package.json aktualisieren

```json
{
  "scripts": {
    "migrate:latest": "node scripts/run-migration-20250115.js"
  }
}
```

### Schritt 5: Railway Pre-deploy Command setzen

```bash
node scripts/run-migration-20250115.js
```

### Schritt 6: Testen und Deployen

```bash
# Lokal testen
npm run migrate:latest

# Committen
git add .
git commit -m "feat: Add new AI provider support"
git push

# Railway deployt automatisch mit Pre-deploy Command
```

---

## Support & Weitere Ressourcen

### Prisma Dokumentation
- [Prisma Migrations](https://www.prisma.io/docs/concepts/components/prisma-migrate)
- [Prisma CLI Reference](https://www.prisma.io/docs/reference/api-reference/command-reference)

### Railway Dokumentation
- [Build & Deploy](https://docs.railway.app/deploy/builds)
- [Environment Variables](https://docs.railway.app/develop/variables)

### Bei Problemen
1. Railway Logs checken: `railway logs`
2. Lokal reproduzieren: `npm run migrate`
3. GitHub Issue erstellen mit Logs

---

**Erstellt:** 2025-01-13
**Letztes Update:** 2025-01-13
**Version:** 1.0
