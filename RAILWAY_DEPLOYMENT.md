# Railway Deployment Guide

> ⚠️ **WICHTIG:** Verwende nur **Pre-deploy Commands** für Migrations. Custom Start Commands sind nicht zuverlässig!

## Datenbank-Migration auf Railway ausführen

### Methode 1: Pre-deploy Command (⭐ NUR DIESE METHODE FUNKTIONIERT)

Setze den **Pre-deploy Command** in Railway auf:

```bash
node scripts/run-migration.js
```

**Wo einstellen:**
1. Railway Dashboard öffnen
2. Dein Projekt → **Settings**
3. **Deploy** → **Pre-deploy Command**
4. Eingeben: `node scripts/run-migration.js`
5. **Save Changes**

Das Script führt automatisch VOR dem App-Start folgendes aus:
1. ✅ Überprüft ob `DATABASE_URL` gesetzt ist
2. 📦 Führt die Datenbank-Migration aus
3. 🔨 Generiert den Prisma Client

Die App startet dann automatisch **nach** erfolgreicher Migration.

**Siehe auch:** [PRISMA_MIGRATION_GUIDE.md](PRISMA_MIGRATION_GUIDE.md) für detaillierte Anleitung.

### Methode 2: Manuell mit Railway CLI (Nur für Testing)

Wenn du die Railway CLI installiert hast:

```bash
# In Railway einloggen
railway login

# Zum Projekt wechseln
railway link

# Migration ausführen
railway run npx prisma db execute --file prisma/migrations/add_entity_specific_ai_instructions.sql --schema prisma/schema.prisma

# Prisma Client generieren
railway run npx prisma generate

# App neu starten
railway up
```

### Methode 3: Direkt via psql

Falls du direkten Zugriff auf die Datenbank hast:

```bash
# DATABASE_URL aus Railway kopieren
# Dann lokal ausführen:
psql "postgresql://user:password@host:port/database" -f prisma/migrations/add_entity_specific_ai_instructions.sql
```

## Was die Migration macht

### Part 1: Grok & DeepSeek API Keys
- ✅ Fügt `grokApiKey` Spalte hinzu (falls nicht vorhanden)
- ✅ Fügt `deepseekApiKey` Spalte hinzu (falls nicht vorhanden)
- ✅ Fügt Rate-Limiting Spalten hinzu:
  - `grokMaxTokensPerMinute` (default: 100000)
  - `grokMaxRequestsPerMinute` (default: 60)
  - `deepseekMaxTokensPerMinute` (default: 100000)
  - `deepseekMaxRequestsPerMinute` (default: 60)

### Part 2: Entity-Specific AI Instructions
- ✅ Benennt alte generische Felder um zu `product*` Feldern
  - `titleFormat` → `productTitleFormat`
  - `titleInstructions` → `productTitleInstructions`
  - etc.
- ✅ Fügt neue Felder hinzu für:
  - **Collections**: 10 Felder (titleFormat, titleInstructions, descriptionFormat, etc.)
  - **Blogs**: 10 Felder
  - **Pages**: 10 Felder
  - **Policies**: 2 Felder (nur description)

## Sicherheit

Die Migration ist **idempotent** - das bedeutet:
- ✅ Kann mehrfach ausgeführt werden ohne Fehler
- ✅ Prüft vor jeder Änderung ob Spalten bereits existieren
- ✅ Überschreibt keine existierenden Daten
- ✅ Benennt Spalten nur um, wenn alte Namen existieren

## Troubleshooting

### Fehler: "DATABASE_URL not found"
**Lösung:** Stelle sicher, dass die `DATABASE_URL` Variable in Railway gesetzt ist:
- Railway Dashboard → Dein Projekt → Variables → DATABASE_URL

### Fehler: "Permission denied"
**Lösung:** Die Datenbank-User braucht folgende Rechte:
```sql
GRANT CREATE, ALTER ON DATABASE your_database TO your_user;
```

### Fehler: "Migration file not found"
**Lösung:** Stelle sicher dass die Datei committet und gepusht wurde:
```bash
git add prisma/migrations/add_entity_specific_ai_instructions.sql
git commit -m "Add migration script"
git push
```

### Migration wurde nicht ausgeführt
**Überprüfen:** Schaue in die Railway Logs:
```bash
railway logs
```

Suche nach den Migration Log-Meldungen:
- `📦 Running database migration...`
- `✅ Migration completed successfully`

## Nach der Migration

Nach erfolgreicher Migration kannst du:

1. **Grok & DeepSeek API Keys setzen:**
   - Gehe zu Settings → API Configuration
   - Trage deine Grok/DeepSeek API Keys ein
   - Wähle den gewünschten Provider

2. **Entity-spezifische AI Instructions konfigurieren:**
   - Gehe zu Settings → AI Instructions
   - Wähle den Tab (Produkte, Collections, Blogs, Pages, Policies)
   - Konfiguriere Formatbeispiele und Anweisungen pro Entity-Typ

3. **Teste die AI-Generierung:**
   - Erstelle/Bearbeite ein Produkt, Collection, Blog, etc.
   - Nutze die AI-Generierung für Titel, Beschreibung, etc.
   - Die AI verwendet jetzt die entity-spezifischen Instruktionen

## Railway Environment Variables

Stelle sicher dass folgende Variables gesetzt sind:

```bash
DATABASE_URL=postgresql://...       # Automatisch von Railway gesetzt
SHOPIFY_API_KEY=your_key           # Dein Shopify API Key
SHOPIFY_API_SECRET=your_secret     # Dein Shopify API Secret
NODE_ENV=production                # Für Production Mode
```

## Rollback (falls nötig)

Falls etwas schief geht, kannst du die Änderungen rückgängig machen:

```sql
-- Nur falls nötig! Entfernt die neuen Spalten

-- AISettings: Remove Grok/DeepSeek
ALTER TABLE "AISettings" DROP COLUMN IF EXISTS "grokApiKey";
ALTER TABLE "AISettings" DROP COLUMN IF EXISTS "deepseekApiKey";
ALTER TABLE "AISettings" DROP COLUMN IF EXISTS "grokMaxTokensPerMinute";
ALTER TABLE "AISettings" DROP COLUMN IF EXISTS "grokMaxRequestsPerMinute";
ALTER TABLE "AISettings" DROP COLUMN IF EXISTS "deepseekMaxTokensPerMinute";
ALTER TABLE "AISettings" DROP COLUMN IF EXISTS "deepseekMaxRequestsPerMinute";

-- AIInstructions: Rename back to generic (nur wenn du die alten Daten willst)
ALTER TABLE "AIInstructions" RENAME COLUMN "productTitleFormat" TO "titleFormat";
-- etc...
```

⚠️ **ACHTUNG:** Ein Rollback sollte nur im Notfall durchgeführt werden!

## Support

Bei Problemen:
1. Überprüfe Railway Logs: `railway logs`
2. Überprüfe Datenbank-Verbindung: `railway run npx prisma db push --accept-data-loss`
3. Kontaktiere Support

---

**Erstellt am:** 2025-01-13
**Letzte Aktualisierung:** 2025-01-13
