# Quick Start: Migration ausführen

## 🚀 Für Railway (Empfohlen)

### Option 1: Custom Start Command (Einfachste Methode)

1. Gehe zu deinem Railway Projekt
2. Öffne **Settings** → **Deploy**
3. Setze den **Custom Start Command** auf:
   ```bash
   npm run start:railway
   ```
4. Speichern und Railway wird automatisch neu deployen

Das war's! Die Migration wird automatisch bei jedem Deployment ausgeführt.

---

### Option 2: Einmalig manuell ausführen

Wenn du die Migration nur einmal ausführen willst:

```bash
npm run prisma:migrate:new
```

Dann normale start command verwenden:
```bash
npm run start
```

---

## 💻 Lokal testen (Development)

```bash
# 1. Stelle sicher dass DATABASE_URL in .env gesetzt ist
echo "DATABASE_URL=postgresql://..." > .env

# 2. Migration ausführen
npm run prisma:migrate:new

# 3. App starten
npm run dev
```

---

## ✅ Überprüfen ob Migration erfolgreich war

### Methode 1: Railway Logs checken

```bash
railway logs
```

Suche nach diesen Zeilen:
```
✅ DATABASE_URL is configured
📦 Running database migration...
✅ Migration completed successfully
✅ Prisma Client generated successfully
```

### Methode 2: Datenbank direkt checken

```sql
-- Prüfe ob neue Spalten existieren
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'AISettings'
AND column_name IN ('grokApiKey', 'deepseekApiKey');

-- Prüfe AI Instructions
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'AIInstructions'
AND column_name LIKE 'product%';
```

### Methode 3: In der App testen

1. Öffne deine App
2. Gehe zu **Settings** → **API Configuration**
3. Schaue nach, ob **Grok** und **DeepSeek** als Provider verfügbar sind
4. Gehe zu **Settings** → **AI Instructions**
5. Die Tabs sollten jetzt vorhanden sein (noch nicht implementiert in UI)

---

## 🔧 Troubleshooting

### Fehler: "DATABASE_URL not found"

**Lösung für Railway:**
```bash
railway variables
```
Überprüfe ob `DATABASE_URL` gesetzt ist.

**Lösung für lokal:**
Erstelle `.env` Datei:
```bash
DATABASE_URL="postgresql://user:password@localhost:5432/database"
```

### Fehler: "Migration file not found"

Stelle sicher dass die Dateien committed sind:
```bash
git status
git add prisma/migrations/ scripts/
git commit -m "Add migration scripts"
git push
```

### Fehler: "Permission denied"

Der Datenbank-User braucht CREATE/ALTER Rechte:
```sql
GRANT CREATE, ALTER ON DATABASE your_db TO your_user;
```

### Migration läuft, aber Änderungen sind nicht sichtbar

1. Cache clearen: `railway run npx prisma generate`
2. App neu starten: Im Railway Dashboard → Redeploy
3. Browser Cache leeren

---

## 📋 Was ändert sich?

### Neue API Provider
- ✅ Grok (X.AI) kann jetzt verwendet werden
- ✅ DeepSeek kann jetzt verwendet werden

### Entity-spezifische AI Instructions
- ✅ Produkte haben eigene Instructions
- ✅ Collections haben eigene Instructions
- ✅ Blogs haben eigene Instructions
- ✅ Pages haben eigene Instructions
- ✅ Policies haben eigene Instructions

**Beispiel:**
Früher: Eine Instruction für alle Titel
```
titleFormat: "Eleganter Produkttitel"
```

Jetzt: Separate Instructions pro Entity
```
productTitleFormat: "Premium Leder Geldbörse - Elegant"
collectionTitleFormat: "Leder Accessoires - Handgefertigt"
blogTitleFormat: "5 Tipps für Lederpflege"
```

---

## 📞 Support

Wenn etwas nicht funktioniert:

1. **Logs checken:** `railway logs` oder lokale Console
2. **Datenbank-Status:** `npm run prisma:push`
3. **GitHub Issue:** Erstelle ein Issue mit Logs

---

## 🎉 Fertig!

Nach erfolgreicher Migration:
- Grok und DeepSeek API Keys können in Settings eingegeben werden
- Produkt-AI-Generierung verwendet jetzt `product*` Instruktionen
- Bestehende Daten bleiben erhalten (alte Werte wurden zu Produkt-Instruktionen)

**Nächste Schritte:**
1. Settings UI mit Tabs implementieren (siehe ENTITY_SPECIFIC_INSTRUCTIONS_IMPLEMENTATION.md)
2. Collection/Blog/Page Actions anpassen
3. Default-Werte verwenden (aus aiInstructionsDefaults.ts)

---

**Stand:** 2025-01-13
