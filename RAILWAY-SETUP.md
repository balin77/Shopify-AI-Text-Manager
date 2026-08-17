# Railway Development & Production Setup

## Übersicht
Dieses Projekt nutzt zwei Railway Environments für eine saubere Trennung:
- **Production**: Läuft auf dem `master` Branch
- **Development**: Läuft auf dem `develop` Branch

## 0. Config as Code — welche Datei zu welchem Service gehört

Die Deploy-Mechanik liegt im Repo, damit sie versioniert ist und nicht still im
Dashboard driftet. Railway liest die Config-Datei **pro Service**; der Pfad wird
je Service unter Settings → Config-as-Code hinterlegt.

| Service | Config-Datei | Inhalt |
|---|---|---|
| Web (production **und** development) | [railway.json](railway.json) | Dockerfile-Builder, `npm run start:production`, Healthcheck `/health` |
| Db Space Checker (Cron, nur production) | [railway.dbalert.json](railway.dbalert.json) | Dockerfile-Builder, `node scripts/db-alert.mjs`, alle 15 Min, kein Restart |
| Db Backup (Cron, production **und** development) | [railway.dbbackup.json](railway.dbbackup.json) | Dockerfile-Builder, `node scripts/db-backup.mjs`, täglich 02:00 UTC, kein Restart |

Beide Web-Environments sind identisch konfiguriert — deshalb braucht `railway.json`
keine `environments`-Überschreibungen. Weichen sie irgendwann ab, kommt ein Block
`"environments": { "development": { "deploy": { … } } }` dazu, statt die Abweichung
nur im Dashboard zu machen.

**Alle vier Services bauen mit dem [Dockerfile](Dockerfile).** Der `CMD` darin
(`npm run start`, **ohne** Migrationen) wird vom `startCommand` oben überschrieben —
der Dockerfile ist also nicht die Antwort darauf, wie die App startet.

Früher lagen hier zusätzlich ein `Procfile` und eine `nixpacks.toml`, die einen
Build-Pfad beschrieben, den Railway nie genommen hat. Beide sind gelöscht: drei
Dateien mit drei verschiedenen Start-Befehlen, von denen keine galt, haben
nachweislich zu falschen Annahmen geführt. Neue Deploy-Einstellungen gehören in
die Config-Dateien oben, nicht in eine weitere Parallelquelle.

Der Cron-Service hat im Dashboard zusätzlich ein *Custom Build Command*
(`npm ci && npx prisma generate`). Das steht bewusst nicht in der Config-Datei:
unter dem Dockerfile-Builder bestimmt der Dockerfile den Build, und der führt
`npm ci` und `npx prisma generate` ohnehin selbst aus. Der Eintrag im Dashboard
ist also im besten Fall redundant und kann geleert werden.

**Achtung: was die Datei überschreibt.** Jedes Feld, das hier steht, sticht den
Dashboard-Wert. Felder, die *nicht* hier stehen (z. B. Restart-Policy des Web-Service,
Replicas, Region), bleiben Dashboard-Sache. Beim Ergänzen also immer erst den
Ist-Wert im Dashboard ablesen, sonst ändert der nächste Deploy stillschweigend
das Laufzeitverhalten.

**Was NICHT hier hineinkann** und darum weiterhin nur im Dashboard existiert:
Environment-Variablen und Secrets, die Postgres-Datenbank, Volumes und deren Größe,
Domains, sowie die Branch-Zuordnung eines Environments.

### Env-Variablen des Cron-Service `Db Space Checker`

[scripts/db-alert.mjs](scripts/db-alert.mjs) misst `pg_database_size` + WAL und
schlägt Alarm, bevor das Railway-Volume voll läuft. Erforderlich:

| Variable | Bedeutung |
|---|---|
| `DATABASE_URL` | von Railway injiziert (`${{Postgres.DATABASE_URL}}`) |
| `VOLUME_LIMIT_MB` | **die real provisionierte Volume-Größe in MB** (z. B. `5120` für 5 GB) |
| `ALERT_PCT` | Schwelle in Prozent, Default `70` |
| `ALERT_WEBHOOK_URL` | Slack-/Discord-kompatibler Incoming-Webhook; fehlt er, wird nur geloggt |

`VOLUME_LIMIT_MB` gehört bewusst **nicht** ins Repo: der Wert muss dem Dashboard
folgen. Wird das Volume vergrößert, muss er dort mitgezogen werden — sonst feuert
der Alarm bei der falschen Schwelle.

Testlauf mit garantiertem Webhook-Post: `node scripts/db-alert.mjs --test`.
Im Cron-Modus postet das Skript nur bei Überschreitung und beendet sich dann mit
Exit-Code 2 — der Lauf erscheint in Railway also absichtlich als fehlgeschlagen.
Genau deshalb steht die Restart-Policy auf `NEVER`: bei `ON_FAILURE` würde Railway
den Container nach jedem Alarm neu starten und der Webhook liefe in eine Schleife.

### Env-Variablen des Cron-Service `Db Backup`

[scripts/db-backup.mjs](scripts/db-backup.mjs) zieht nachts einen `pg_dump` und
legt ihn in einem Cloudflare-R2-Bucket ab. Railways eigene Snapshots bleiben als
Grundsicherung bestehen — sie sind aber ein Service-Rollback: kein frei wählbarer
Zeitpunkt und kein Weg, eine *einzelne* Tabelle zurückzuholen. Genau das braucht
man vor einer destruktiven Migration, und dafür ist dieser Service da.

| Variable | Bedeutung |
|---|---|
| `DATABASE_URL` | von Railway injiziert (`${{Postgres.DATABASE_URL}}`) |
| `R2_ACCOUNT_ID` | Cloudflare-Account-ID; daraus wird `https://<id>.r2.cloudflarestorage.com` gebaut |
| `R2_ENDPOINT` | optional, überschreibt `R2_ACCOUNT_ID`. **Pflicht bei EU-Jurisdiction** (siehe unten) |
| `R2_BUCKET` | Ziel-Bucket |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2-API-Token. **Nur „Object Read & Write" auf genau diesen Bucket** — der Token liegt in einem Container, der sonst nichts mit R2 zu tun hat |
| `BACKUP_PREFIX` | Key-Präfix und Dateiname-Stamm, Default `contentpilot` |
| `BACKUP_RETENTION_DAYS` | ältere Dumps werden gelöscht, Default `30`, `0` = nie löschen |
| `BACKUP_KEEP_MINIMUM` | die N neuesten Dumps werden **nie** gelöscht, Default `3` |
| `ALERT_WEBHOOK_URL` | derselbe Slack-/Discord-Webhook wie beim Space Checker; fehlt er, wird nur geloggt |

**Zwei Environments, zwei Buckets, zwei Tokens.** Production und development
haben je eine eigene Postgres — also läuft der Backup-Service in beiden, und
jedes Environment schreibt in seinen **eigenen** Bucket mit einem Token, das
**nur** auf diesen Bucket berechtigt ist:

| | production | development |
|---|---|---|
| Bucket | `contentpilot-backups-prod` | `contentpilot-backups-dev` |
| `R2_BUCKET` | `contentpilot-backups-prod` | `contentpilot-backups-dev` |
| `BACKUP_RETENTION_DAYS` | `30` | `7` |
| `BACKUP_KEEP_MINIMUM` | `3` | `2` |
| R2-Token | eigenes, nur auf den prod-Bucket | eigenes, nur auf den dev-Bucket |

Der Punkt der Trennung ist der **Token**, nicht der Bucket: ein einziges Token
über beide Buckets würde bedeuten, dass ein Leak aus der Dev-Umgebung — die
naturgemäß mehr angefasst und weniger streng behandelt wird — die
Produktions-Backups löschen kann. Genau davor schützt die Aufteilung. Ein
gemeinsamer Bucket mit zwei `BACKUP_PREFIX`-Werten wäre billiger, gäbe diese
Eigenschaft aber auf.

`railway.dbbackup.json` bleibt für beide dieselbe Datei — die Unterschiede oben
sind ausschließlich Environment-Variablen, und die sind in Railway ohnehin pro
Environment gesetzt. Es braucht also keine zweite Config-Datei und keinen
`environments`-Block.

Der Ablauf bricht bei jedem Schritt ab, statt ein halbes Backup als Erfolg zu
melden: Versionscheck → `pg_dump -Fc` → **`pg_restore --list` auf das Ergebnis**
→ Upload → Retention. Der Verifikationsschritt ist der Punkt, an dem ein
abgeschnittener oder leerer Dump auffällt — im Backup-Fenster, nicht in dem
Moment, in dem man ihn unter Druck zurückspielen will.

Zwei Sicherheitseigenschaften der Retention, die bewusst so gebaut sind: die
`BACKUP_KEEP_MINIMUM` neuesten Dumps überleben **jedes** Alter (läuft der Cron
monatelang nicht, darf der nächste Lauf nicht „alle sind alt" als „alle löschen"
lesen), und gelöscht wird nur, was auf `.dump` endet — was sonst noch unter dem
Präfix liegt, gehört der Retention nicht. Beides ist in
[tests/unit/db-backup.test.ts](tests/unit/db-backup.test.ts) festgenagelt.

**EU-Jurisdiction ändert den Endpoint.** Die Dumps enthalten Shop-Daten und
Session-PII, EU-Residenz ist also naheliegend — aber Cloudflare trennt zwei
Dinge, die im Anlege-Dialog nebeneinander stehen: ein *Location Hint* ist eine
unverbindliche Platzierungs-Empfehlung und lässt den Endpoint unverändert, eine
*Jurisdiction* `European Union` ist die harte Zusage und verschiebt den
S3-Endpoint auf `https://<account>.eu.r2.cloudflarestorage.com`. Für einen
Jurisdiction-Bucket reicht `R2_ACCOUNT_ID` daher **nicht** — das Skript würde
den Endpoint ohne `.eu` zusammenbauen und ins Leere greifen. Dann `R2_ENDPOINT`
explizit setzen. Die Jurisdiction ist beim Anlegen zu wählen und später nicht
mehr änderbar.

**Postgres-Client-Version.** `pg_dump` verweigert den Dump eines *neueren*
Servers. Das [Dockerfile](Dockerfile) installiert Alpines Default-`postgresql-client`;
wird Railways Postgres später hochgezogen, scheitert der Lauf mit genau dem
Paketnamen, den man dort pinnen muss (`postgresql17-client` o. ä.) — statt still
ein unbrauchbares Backup abzulegen.

Erste Inbetriebnahme, in dieser Reihenfolge:

```bash
# 1. Nur Dump + Verifikation, ohne Bucket und ohne Credentials:
node scripts/db-backup.mjs --dry-run
# 2. Vollständiger Lauf, der auch bei Erfolg in den Webhook postet:
node scripts/db-backup.mjs --test
```

Im Cron-Modus meldet sich der Service **nur bei Fehlern** (Exit-Code 1 plus
Webhook-Post). Restart-Policy `NEVER` aus demselben Grund wie beim Space Checker.

Ein Backup, das nie zurückgespielt wurde, ist kein Backup — der Restore-Weg:

```bash
pg_restore -d "$ZIEL_URL" --no-owner --no-privileges backup.dump
# nur eine einzelne Tabelle (das ist der Grund fuer das custom format):
pg_restore -d "$ZIEL_URL" --no-owner --no-privileges -t Shop backup.dump
```

## 1. Railway Project Setup

### Schritt 1: Environments einrichten

1. Öffne dein Railway Dashboard: https://railway.app/dashboard
2. Wähle dein Project "compassionate-love"
3. Klicke auf das **Environment Dropdown** oben (da wo du zwischen Environments wechseln kannst)
4. Du solltest aktuell eine Environment sehen (wahrscheinlich "production")

### Schritt 2: Development Environment erstellen

1. Klicke auf das Environment Dropdown
2. Wähle **"New Environment"**
3. Name: `development`
4. Base Environment: `production` (optional, um Settings zu kopieren)
5. Erstelle die Environment

### Schritt 3: Deployment-Trigger konfigurieren

#### Production Environment:
1. Wähle "production" Environment aus dem Dropdown
2. Klicke auf dein **Service** (wahrscheinlich heißt es wie dein Repo)
3. Gehe zu **Settings** → **Source**
4. Bei **Branch**: Wähle `master`
5. Bei **Automatic Deployments**:
   - **Deaktiviere** "Deploy on every push" (für mehr Kontrolle)
   - ODER lasse es aktiv wenn du automatische Deployments willst

#### Development Environment:
1. Wähle "development" Environment aus dem Dropdown
2. Klicke auf dein Service
3. Gehe zu **Settings** → **Source**
4. Bei **Branch**: Wähle `develop`
5. Bei **Automatic Deployments**: **Aktiviere** "Deploy on every push" ✓
6. Root Directory: `/` (oder dein Project-Root)
7. Build Command: `npm run build`
8. Start Command: `npm run start`

## 2. Separate Datenbanken einrichten

### Production Database (bereits vorhanden):
1. In "production" Environment
2. Du solltest bereits eine PostgreSQL Database haben

### Development Database (neu erstellen):
1. Wechsle zu "development" Environment
2. Klicke auf **"+ New"** → **"Database"** → **"Add PostgreSQL"**
3. Railway erstellt automatisch eine neue Datenbank
4. Die `DATABASE_URL` wird automatisch als Environment Variable gesetzt

## 3. Environment Variables konfigurieren

### Für BEIDE Environments musst du folgende Variablen setzen:

#### Production Environment Variables:
```
NODE_ENV=production
SHOPIFY_API_KEY=<dein-production-api-key>
SHOPIFY_API_SECRET=<dein-production-api-secret>
SHOPIFY_API_VERSION=2025-10
SHOPIFY_SCOPES=read_legal_policies,write_legal_policies,read_locales,read_online_store_navigation,write_online_store_navigation,read_online_store_pages,write_online_store_pages,read_product_listings,write_product_listings,read_products,write_products,read_content,write_content,read_themes,write_themes,read_translations,write_translations
SHOPIFY_APP_URL=${{RAILWAY_PUBLIC_DOMAIN}} oder deine Custom Domain
AI_PROVIDER=huggingface
HUGGINGFACE_API_KEY=<dein-key>
GOOGLE_API_KEY=<dein-key>
ENCRYPTION_KEY=<dein-encryption-key>
DATABASE_URL=${{Postgres.DATABASE_URL}} (automatisch gesetzt)
```

> **Hinweis**: Shop-Name und Access-Token werden automatisch aus der Datenbank-Session geladen (Multi-Tenant SaaS).

#### Development Environment Variables:
```
NODE_ENV=development
SHOPIFY_API_KEY=<dein-dev-api-key oder gleich wie prod>
SHOPIFY_API_SECRET=<dein-dev-api-secret oder gleich wie prod>
SHOPIFY_API_VERSION=2025-10
SHOPIFY_SCOPES=<gleiche wie oben>
SHOPIFY_APP_URL=${{RAILWAY_PUBLIC_DOMAIN}}
AI_PROVIDER=huggingface
HUGGINGFACE_API_KEY=<dein-key>
GOOGLE_API_KEY=<dein-key>
ENCRYPTION_KEY=<dein-encryption-key>
DATABASE_URL=${{Postgres.DATABASE_URL}} (automatisch von dev-database)
```

### Variables setzen:
1. Wähle die Environment aus dem Dropdown
2. Klicke auf dein Service
3. Gehe zu **Variables** Tab
4. Klicke **"New Variable"**
5. Füge alle Variablen hinzu

**Wichtig**: `DATABASE_URL` wird automatisch gesetzt wenn du die Postgres Database hinzufügst!

## 4. Domains einrichten

### Production Domain:
1. In "production" Environment
2. Gehe zu deinem Service → **Settings** → **Networking**
3. Klicke **"Generate Domain"** für Railway Domain
4. ODER füge eine **Custom Domain** hinzu
5. Diese URL verwendest du dann für `SHOPIFY_APP_URL` in Shopify Partners

### Development Domain:
1. In "development" Environment
2. Gehe zu deinem Service → **Settings** → **Networking**
3. Klicke **"Generate Domain"** für eine separate Railway Domain
4. Diese URL ist für Testing gedacht

## 5. Shopify App Configuration

### Production App:
- In Shopify Partners → Dein Production App
- App URL: Deine Production Railway Domain
- Allowed redirection URL(s): `https://<production-domain>/api/auth/callback`

### Development App (Optional aber empfohlen):
- Erstelle eine **separate Shopify App** für Development
- App URL: Deine Development Railway Domain
- Allowed redirection URL(s): `https://<development-domain>/api/auth/callback`
- Nutze die Dev-App Credentials in Development Environment

**Oder**: Nutze die gleiche App für beide Environments (weniger sauber aber einfacher)

## 6. Workflow Übersicht

### Entwicklung:
```bash
# Lokal arbeiten auf develop branch
git checkout develop

# Änderungen machen
# ... code änderungen ...

# Committen und pushen
git add .
git commit -m "feat: neue feature"
git push origin develop

# → Railway deployed automatisch zu Development Environment
# → Testen auf https://<dev-domain>
```

### Production Release:
```bash
# Nach erfolgreichem Test auf Development
git checkout master
git merge develop
git push origin master

# → Railway deployed zu Production Environment (je nach Config)
# → Oder manuell triggern im Railway Dashboard
```

### Manuelles Deployment triggern:
1. Gehe zu Railway Dashboard
2. Wähle Environment (production oder development)
3. Klicke auf dein Service
4. Klicke **"Deploy"** Button
5. Oder nutze: `railway up` (wenn CLI verbunden)

## 7. CLI Setup (Optional)

Falls du Railway CLI nutzen möchtest:

```bash
# Project verbinden (im Project-Root)
railway link

# Zu Development Environment wechseln
railway environment development

# Deploy manuell triggern
railway up

# Logs anschauen
railway logs

# Variables anzeigen
railway variables
```

## 8. Monitoring und Debugging

### Logs checken:
1. Railway Dashboard → Environment wählen → Service
2. **"View Logs"** Button
3. Oder: `railway logs` im Terminal

### Database verbinden:
```bash
# Zu Environment wechseln
railway environment development  # oder production

# Database Shell öffnen
railway connect Postgres
```

## Best Practices

1. **Niemals direkt auf master pushen** - immer erst auf develop testen
2. **Separate API Keys** für Dev/Prod wenn möglich (für Tracking)
3. **Database Backups** regelmäßig machen (Railway macht automatisch Snapshots)
4. **Environment Variables** niemals im Code committen
5. **Testing** immer zuerst auf Development Environment
6. **Production Deployments** nur nach erfolgreichem Testing
7. **Rollback**: Bei Problemen in Railway auf vorherige Deployment Version zurück

## Troubleshooting

### Build Fails:
- Checke Logs im Railway Dashboard
- Prüfe ob alle Environment Variables gesetzt sind
- Prüfe `package.json` scripts

### Database Connection Error:
- Prüfe ob `DATABASE_URL` korrekt gesetzt ist
- Prüfe ob Postgres Database läuft
- Prüfe ob Migrations gelaufen sind

### Shopify Auth Error:
- Prüfe `SHOPIFY_APP_URL` stimmt mit Railway Domain überein
- Prüfe Allowed Redirect URLs in Shopify Partners
- Prüfe API Keys sind korrekt

## Nächste Schritte

1. ☐ Railway Environments wie oben beschrieben einrichten
2. ☐ Development Database erstellen
3. ☐ Environment Variables für beide Environments setzen
4. ☐ Domains generieren
5. ☐ Deployment-Trigger konfigurieren
6. ☐ Test-Deployment auf Development machen
7. ☐ Nach erfolgreichem Test, Production deployen

---

Bei Fragen oder Problemen, checke die Railway Docs: https://docs.railway.app/
