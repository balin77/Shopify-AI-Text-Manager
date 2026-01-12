# Database Cleanup - Railway Deployment

## Status: ⚠️ TEMPORARY - Delete after one-time use

Diese Cleanup-Scripts sind **temporär** und sollten nach einmaligem Ausführen entfernt werden.

## Verwendung:

### 1. Cleanup durchführen:

```bash
# Code pushen
git push

# In Railway Settings → Start Command ändern zu:
npm run cleanup:once

# Warten bis Deployment fertig ist und Cleanup gelaufen ist
```

### 2. Zurück zu normalem Betrieb:

```bash
# In Railway Settings → Start Command zurück ändern zu:
npm start
```

### 3. Cleanup-Scripts löschen:

```bash
# Diese Dateien löschen:
git rm scripts/cleanup-once.js
git rm scripts/cleanup-railway.ts
git rm scripts/cleanup-railway.sql
git rm scripts/cleanup-sync-data.ts
git rm scripts/reset-database.ts
git rm scripts/start-with-cleanup.js
git rm CLEANUP-README.md

# Package.json aufräumen - diese Zeilen entfernen:
# - "cleanup:once": "node scripts/cleanup-once.js",
# - "db:cleanup": "tsx scripts/cleanup-sync-data.ts",
# - "db:cleanup:railway": "tsx scripts/cleanup-railway.ts",
# - "db:reset": "tsx scripts/reset-database.ts",

# Commit erstellen:
git commit -m "chore: Remove temporary cleanup scripts after successful database cleanup"

# Pushen:
git push
```

## Was wurde durch das Cleanup gelöscht?

- ❌ ThemeTranslation (Hauptverursacher des DB Overflows)
- ❌ ThemeContent
- ❌ ContentTranslation
- ❌ Pages, Policies, Collections, Articles

## Was wurde behalten?

- ✅ Sessions
- ✅ Products
- ✅ AI Settings
- ✅ Webhook Logs
- ✅ Tasks

## Nach dem Cleanup:

Der Background-Sync läuft jetzt stabil weiter mit:
- ✅ Pages Sync (alle 40s)
- ✅ Policies Sync (alle 40s)
- ⚠️ Themes Sync **DEAKTIVIERT** (würde DB wieder füllen)

Themes werden weiterhin live von Shopify API geladen.
