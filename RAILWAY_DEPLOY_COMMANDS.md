# Railway Deploy Commands

## Pre-deploy Command (Empfohlen)

**Was es macht:**
- Generiert Prisma Client
- Verschlüsselt bestehende API Keys (idempotent)
- Läuft **vor** dem App-Start

**Command zum Kopieren:**
```bash
node scripts/run-all-migrations.js
```

**Wo einfügen:**
Railway Dashboard → Settings → Deploy → **Pre-deploy Command**

---

## Post-deploy Command (Alternative)

**Was es macht:**
- Verschlüsselt API Keys **nach** dem Deployment
- App läuft bereits
- Weniger sicher, da App schon online ist

**Command zum Kopieren:**
```bash
npx tsx scripts/migrate-encrypt-api-keys.ts || true
```

**Wo einfügen:**
Railway Dashboard → Settings → Deploy → **Post-deploy Command**

⚠️ **Hinweis:** `|| true` am Ende sorgt dafür, dass der Deploy nicht fehlschlägt, wenn die Migration Probleme hat.

---

## Vergleich

| Feature | Pre-deploy | Post-deploy |
|---------|-----------|-------------|
| **Timing** | Vor App-Start | Nach App-Start |
| **Sicherheit** | ✅ Höher (Keys verschlüsselt bevor App startet) | ⚠️ Niedriger (App läuft mit unverschlüsselten Keys kurz) |
| **Fehlerbehandlung** | ❌ Deploy wird abgebrochen bei Fehler | ✅ Deploy läuft weiter bei Fehler |
| **Empfohlen für** | Production | Development/Testing |

---

## Empfehlung

Verwende **Pre-deploy Command** für Production:

```bash
node scripts/run-all-migrations.js
```

### Warum?
1. ✅ Keys werden verschlüsselt **bevor** die App online geht
2. ✅ Prisma Client wird auch generiert
3. ✅ Fehler stoppen das Deployment (Safety First!)
4. ✅ Ein Command für alle Migrationen

---

## Setup-Schritte

### 1. ENCRYPTION_KEY setzen

Railway Dashboard → Variables → Add Variable:
```
Name:  ENCRYPTION_KEY
Value: 8464c779bbe757fe879b9e67b4582dd09bccb4c98c9f2d18d88e30827e9f32c4
```

### 2. Pre-deploy Command setzen

Railway Dashboard → Settings → Deploy → Pre-deploy Command:
```bash
node scripts/run-all-migrations.js
```

### 3. Deploy triggern

```bash
git push
```

Oder im Railway Dashboard: "Redeploy"

### 4. Logs checken

Railway Dashboard → Deployment → View Logs

**Suche nach:**
```
🚀 Starting Railway Pre-deploy Migrations
✅ ENCRYPTION_KEY configured
✅ Generate Prisma Client completed
📦 Running API Key Encryption Migration...
✅ All migrations completed!
```

---

## Troubleshooting

### Problem: "ENCRYPTION_KEY not set"

**Lösung:**
```bash
railway variables set ENCRYPTION_KEY=8464c779bbe757fe879b9e67b4582dd09bccb4c98c9f2d18d88e30827e9f32c4
```

### Problem: "Migration failed"

**Debug:**
```bash
# In Railway Container testen
railway shell
npx tsx scripts/migrate-encrypt-api-keys.ts
```

### Problem: Pre-deploy Command wird nicht ausgeführt

**Checkliste:**
- [ ] Command korrekt kopiert? (kein Tippfehler)
- [ ] Settings gespeichert?
- [ ] Neues Deployment getriggert? (alter Deploy hatte Command noch nicht)
- [ ] Logs gecheckt?

---

## Manuelle Migration (Falls Pre-deploy nicht funktioniert)

```bash
# Option 1: Railway Shell
railway shell
npx tsx scripts/migrate-encrypt-api-keys.ts

# Option 2: Lokale Verbindung
railway variables get DATABASE_URL
# DATABASE_URL in .env kopieren (mit PUBLIC URL)
npx tsx scripts/migrate-encrypt-api-keys.ts
```

---

## Status Checken

Nach dem Deploy kannst du überprüfen ob die Keys verschlüsselt sind:

```bash
# Railway Shell
railway shell

# Prisma Studio öffnen (optional)
npx prisma studio

# Oder direkt in DB schauen
npx prisma db execute --stdin <<EOF
SELECT shop,
       CASE
         WHEN huggingfaceApiKey LIKE '%:%:%' THEN 'ENCRYPTED'
         WHEN huggingfaceApiKey IS NULL THEN 'EMPTY'
         ELSE 'PLAINTEXT'
       END as status
FROM "AISettings";
EOF
```

**Erwartetes Ergebnis:**
```
shop                    | status
------------------------+----------
my-shop.myshopify.com   | ENCRYPTED
```

---

**Erstellt:** 2026-01-14
**Version:** 1.0
**Status:** ✅ Production Ready
