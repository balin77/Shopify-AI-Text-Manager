# Test-Anleitung: API Key Verschlüsselung

## ✅ Schritt 1: Basis-Verschlüsselung testen (ERLEDIGT)

```bash
node test-quick.cjs
```

**Erwartetes Ergebnis:**
```
✅ ALL TESTS PASSED!
```

✅ **Status:** Erfolgreich getestet!

---

## 📝 Schritt 2: TypeScript Build prüfen

Sobald der andere Agent fertig ist, baue das Projekt:

```bash
npm run build
```

**Erwartetes Ergebnis:**
- Keine Fehler im `app/utils/encryption.ts`
- Keine Fehler in den angepassten Dateien

**Falls Fehler auftreten:**
- Prüfe ob alle Imports korrekt sind
- Stelle sicher dass `ENCRYPTION_KEY` in `.env` gesetzt ist

---

## 🗄️ Schritt 3: Datenbank-Test (Falls bereits API Keys vorhanden)

### 3.1 Datenbank Backup erstellen

```bash
# PostgreSQL Beispiel
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d_%H%M%S).sql
```

### 3.2 Aktuelle API Keys prüfen

```sql
SELECT shop,
       CASE
         WHEN huggingfaceApiKey IS NULL THEN 'NULL'
         WHEN huggingfaceApiKey LIKE '%:%:%' THEN 'ENCRYPTED'
         ELSE 'PLAINTEXT'
       END as hf_status,
       CASE
         WHEN geminiApiKey IS NULL THEN 'NULL'
         WHEN geminiApiKey LIKE '%:%:%' THEN 'ENCRYPTED'
         ELSE 'PLAINTEXT'
       END as gemini_status
FROM "AISettings";
```

**Erwartetes Ergebnis (vor Migration):**
```
shop                    | hf_status  | gemini_status
------------------------+------------+--------------
my-shop.myshopify.com   | PLAINTEXT  | PLAINTEXT
```

### 3.3 Migration ausführen

```bash
node --require dotenv/config --loader tsx scripts/migrate-encrypt-api-keys.ts
```

**Erwartetes Ergebnis:**
```
🔐 Starting API Key Encryption Migration
========================================

📊 Found X shop(s) with AI settings

🏪 Processing shop: my-shop.myshopify.com
──────────────────────────────────────────────────
  huggingfaceApiKey: Newly encrypted ✓
  geminiApiKey: Newly encrypted ✓
  ...

✅ Migration completed successfully!
```

### 3.4 Verschlüsselung in DB verifizieren

```sql
SELECT shop,
       LEFT(huggingfaceApiKey, 30) as hf_encrypted,
       LEFT(geminiApiKey, 30) as gemini_encrypted
FROM "AISettings"
WHERE huggingfaceApiKey IS NOT NULL;
```

**Erwartetes Ergebnis (nach Migration):**
```
shop                    | hf_encrypted                    | gemini_encrypted
------------------------+---------------------------------+---------------------------
my-shop.myshopify.com   | a2V5MTIzNDU2Nzg=:ZW5jcnlwdGVk... | b3RoZXJrZXk=:ZGF0YQ==:...
```

Die Keys sollten jetzt im Format `{iv}:{data}:{tag}` sein (Base64).

---

## 🖥️ Schritt 4: App-Test (Frontend & Backend)

### 4.1 App starten

```bash
npm run dev
```

### 4.2 Settings Seite testen

1. **Navigiere zu:** `http://localhost:3000/app/settings`
2. **AI-Tab öffnen**
3. **Neuen API Key eingeben:**
   - Hugging Face: `hf_test1234567890abcdefghijklmnopqrstuvwxyz`
4. **Speichern** klicken
5. **Seite neu laden**
6. **API Key sollte sichtbar sein** (entschlüsselt angezeigt)

**Erwartetes Verhalten:**
- ✅ Key wird gespeichert
- ✅ Key wird beim Laden entschlüsselt angezeigt
- ✅ Keine Fehler in Console
- ✅ "Settings saved successfully" Nachricht

### 4.3 AI-Funktion testen

1. **Navigiere zu:** Produkt bearbeiten
2. **"Generate with AI"** Button klicken
3. **AI sollte funktionieren** mit dem verschlüsselten Key

**Erwartetes Verhalten:**
- ✅ AI Request funktioniert
- ✅ Content wird generiert
- ✅ Keine "API Key invalid" Fehler

### 4.4 Console Logs prüfen

```bash
# Server logs prüfen
npm run dev

# Nach dem Verwenden der AI-Funktion solltest du sehen:
🤖 AI Provider: Hugging Face (FREE)
```

**NICHT sehen solltest du:**
- ❌ Klartext API Keys in Logs
- ❌ "Failed to decrypt" Fehler
- ❌ "ENCRYPTION_KEY not set" Fehler

---

## 🔍 Schritt 5: Security Verification

### 5.1 Prüfe dass Keys verschlüsselt sind

**Direkt in der Datenbank:**
```sql
-- Alle API Keys sollten verschlüsselt sein
SELECT shop,
       huggingfaceApiKey NOT LIKE 'hf_%' as hf_encrypted,
       geminiApiKey NOT LIKE 'AIzaSy%' as gemini_encrypted,
       claudeApiKey NOT LIKE 'sk-ant-%' as claude_encrypted
FROM "AISettings"
WHERE huggingfaceApiKey IS NOT NULL
   OR geminiApiKey IS NOT NULL
   OR claudeApiKey IS NOT NULL;
```

**Alle Werte sollten `true` sein!**

### 5.2 Prüfe Logs auf Klartext-Keys

```bash
# Suche nach typischen API Key Patterns in Logs
grep -r "hf_" logs/
grep -r "AIzaSy" logs/
grep -r "sk-ant-" logs/

# Sollte NICHTS finden!
```

### 5.3 Test: Was passiert bei fehlendem ENCRYPTION_KEY?

```bash
# Temporär ENCRYPTION_KEY aus .env entfernen
# App sollte Fehler werfen beim Versuch Keys zu laden

# Erwarteter Fehler:
# "ENCRYPTION_KEY environment variable is not set"
```

---

## 🚀 Schritt 6: Production Deployment Test

### 6.1 Railway Variables setzen

1. **Railway Dashboard öffnen**
2. **Variables Tab**
3. **Hinzufügen:**
   ```
   ENCRYPTION_KEY=8464c779bbe757fe879b9e67b4582dd09bccb4c98c9f2d18d88e30827e9f32c4
   ```

### 6.2 Deployment

```bash
git add .
git commit -m "feat: Add API key encryption with AES-256-GCM"
git push
```

### 6.3 Production Verification

1. **Öffne Production App**
2. **Gehe zu Settings**
3. **Füge API Key hinzu**
4. **Prüfe Datenbank:**
   ```sql
   -- Production DB
   SELECT shop, LEFT(huggingfaceApiKey, 50)
   FROM "AISettings"
   LIMIT 1;
   ```
5. **Key sollte verschlüsselt sein!**

---

## ✅ Test Checklist

### Basis Tests (Lokal)
- [x] ✅ Verschlüsselung/Entschlüsselung funktioniert (`test-quick.cjs`)
- [ ] TypeScript Build erfolgreich (`npm run build`)
- [ ] Keine Compiler-Fehler in `encryption.ts`

### Datenbank Tests (Falls Keys vorhanden)
- [ ] Datenbank Backup erstellt
- [ ] Migration erfolgreich durchgeführt
- [ ] Keys in DB sind verschlüsselt (Format: `{iv}:{data}:{tag}`)
- [ ] Keys können entschlüsselt werden

### App Tests (Frontend & Backend)
- [ ] Settings Seite lädt ohne Fehler
- [ ] Neue API Keys können gespeichert werden
- [ ] Gespeicherte Keys werden entschlüsselt angezeigt
- [ ] AI-Funktionen arbeiten mit verschlüsselten Keys
- [ ] Keine Klartext-Keys in Logs

### Security Tests
- [ ] Keine Klartext-Keys in Datenbank
- [ ] Fehler bei fehlendem `ENCRYPTION_KEY`
- [ ] Verschlüsselte Keys folgen Format `{iv}:{data}:{tag}`

### Production Tests
- [ ] `ENCRYPTION_KEY` in Railway gesetzt
- [ ] Production Deployment erfolgreich
- [ ] Keys in Production DB verschlüsselt
- [ ] App funktioniert in Production

---

## 🐛 Troubleshooting

### Problem: "ENCRYPTION_KEY not set"
**Lösung:** Füge zu `.env` hinzu:
```bash
ENCRYPTION_KEY=8464c779bbe757fe879b9e67b4582dd09bccb4c98c9f2d18d88e30827e9f32c4
```

### Problem: "Failed to decrypt data"
**Ursachen:**
1. ENCRYPTION_KEY wurde geändert nach Verschlüsselung
2. Daten wurden manuell in DB verändert

**Lösung:**
- Verwende den originalen `ENCRYPTION_KEY`
- Falls Key verloren: Lösche API Keys aus DB und lasse User neu eingeben

### Problem: TypeScript Fehler in encryption.ts
**Lösung:**
- Stelle sicher dass `@types/node` installiert ist:
  ```bash
  npm install --save-dev @types/node
  ```

### Problem: Migration findet keine Shops
**Lösung:**
- Normal, wenn noch keine API Keys in DB vorhanden sind
- Neue Keys werden automatisch verschlüsselt beim Speichern

---

## 📊 Test Ergebnisse

**Letzter Test:** 2026-01-14
**Status:** ✅ Basis-Verschlüsselung erfolgreich
**Nächster Schritt:** TypeScript Build prüfen (wenn anderer Agent fertig)

---

**Für Fragen:** Siehe [docs/API_KEY_ENCRYPTION_SETUP.md](API_KEY_ENCRYPTION_SETUP.md)
