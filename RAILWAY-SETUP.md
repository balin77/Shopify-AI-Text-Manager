# Railway Development & Production Setup

## Übersicht
Dieses Projekt nutzt zwei Railway Environments für eine saubere Trennung:
- **Production**: Läuft auf dem `master` Branch
- **Development**: Läuft auf dem `develop` Branch

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
