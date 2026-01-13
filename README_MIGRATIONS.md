# 📚 Migration & Deployment Dokumentation

## Schnellzugriff

| Dokument | Zweck | Für wen |
|----------|-------|---------|
| [PRISMA_MIGRATION_GUIDE.md](PRISMA_MIGRATION_GUIDE.md) | **⭐ Haupt-Guide** für alle zukünftigen Prisma Migrationen | Entwickler |
| [QUICK_START_MIGRATION.md](QUICK_START_MIGRATION.md) | Schnelleinstieg für aktuelle Migration | Alle |
| [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md) | Railway-spezifische Details | DevOps |
| [ENTITY_SPECIFIC_INSTRUCTIONS_IMPLEMENTATION.md](ENTITY_SPECIFIC_INSTRUCTIONS_IMPLEMENTATION.md) | Technische Implementation Details | Entwickler |

---

## 🚀 Quick Start: Aktuelle Migration deployen

### Railway Pre-deploy Command setzen:

```bash
node scripts/run-migration.js
```

**Wo:** Railway Dashboard → Settings → Deploy → Pre-deploy Command

**Mehr Details:** [QUICK_START_MIGRATION.md](QUICK_START_MIGRATION.md)

---

## 📖 Für neue Migrationen

**Lies zuerst:** [PRISMA_MIGRATION_GUIDE.md](PRISMA_MIGRATION_GUIDE.md)

Dieser Guide enthält:
- ✅ Template für Migration Scripts (ESM-Syntax!)
- ✅ Best Practices für SQL Migrationen
- ✅ Schritt-für-Schritt Anleitung
- ✅ Troubleshooting
- ✅ Vollständiges Beispiel End-to-End

---

## ⚠️ Wichtige Hinweise

### Nur Pre-deploy Commands funktionieren!

Railway erlaubt **nur** Pre-deploy Commands für Migrationen.

❌ **Funktioniert NICHT:**
- Custom Start Commands
- `start:railway` npm script
- Post-deploy Hooks

✅ **Funktioniert:**
- Pre-deploy Command: `node scripts/run-migration.js`

### ES Modules Syntax verwenden!

Da `package.json` `"type": "module"` hat, **MÜSSEN** alle Scripts ESM-Syntax verwenden:

```javascript
// ✅ Richtig
import fs from 'fs';
import { execSync } from 'child_process';

// ❌ Falsch
const fs = require('fs');
const { execSync } = require('child_process');
```

---

## 📁 Projektstruktur

```
├── prisma/
│   ├── schema.prisma                    # Prisma Schema
│   └── migrations/
│       └── *.sql                        # SQL Migration Dateien
├── scripts/
│   └── run-migration.js                 # Migration Runner (ESM!)
├── PRISMA_MIGRATION_GUIDE.md           # ⭐ Haupt-Guide
├── QUICK_START_MIGRATION.md            # Schnelleinstieg
├── RAILWAY_DEPLOYMENT.md               # Railway Details
└── package.json                        # npm scripts
```

---

## 🔧 Verfügbare npm Scripts

```bash
# Migration ausführen (für Pre-deploy)
npm run prisma:migrate:predeploy

# Prisma Client generieren
npm run prisma:generate

# Schema zu DB pushen (Development)
npm run prisma:push

# Alte Migration (Baseline)
npm run prisma:migrate
```

---

## 🆘 Bei Problemen

1. **Lies die Dokumentation:** [PRISMA_MIGRATION_GUIDE.md](PRISMA_MIGRATION_GUIDE.md) → Troubleshooting Sektion
2. **Logs checken:** Railway Dashboard → Build Logs
3. **Lokal testen:** `npm run prisma:migrate:predeploy`
4. **GitHub Issue erstellen** mit Logs

---

## 📊 Aktueller Stand

### Letzte Migration: 2025-01-13

**Was wurde geändert:**
- ✅ Grok & DeepSeek API Keys hinzugefügt
- ✅ Entity-spezifische AI Instructions (Products, Collections, Blogs, Pages, Policies)
- ✅ Alte generische Felder zu product-spezifischen Feldern umbenannt

**SQL-Datei:** `prisma/migrations/add_entity_specific_ai_instructions.sql`

**Status:** ✅ In Production deployed

---

## 📝 Changelog

### 2025-01-13: Entity-Specific Instructions & Grok/DeepSeek
- Added 54 new columns to AIInstructions table
- Added grokApiKey and deepseekApiKey to AISettings
- Migration is idempotent (can run multiple times safely)

---

**Letzte Aktualisierung:** 2025-01-13
