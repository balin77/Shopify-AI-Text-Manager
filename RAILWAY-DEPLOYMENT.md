# 🚂 Railway Deployment - Kostenlos!

## Warum Railway?

- ✅ **$5/Monat gratis Guthaben** (reicht für Development)
- ✅ **GitHub-Integration**: Push = Auto-Deploy
- ✅ **Postgres-Datenbank inklusive**
- ✅ **Automatisches SSL**
- ✅ **Environment Variables UI**
- ✅ **Logs & Monitoring**

---

## 🚀 Schritt 1: Railway Account erstellen

1. Gehe zu: **https://railway.app/**
2. Klicke **"Start a New Project"**
3. Login mit **GitHub** (empfohlen)
4. Verifiziere deine E-Mail

**Kosten**: $0 - du bekommst $5 Guthaben/Monat kostenlos!

---

## 📦 Schritt 2: Code zu GitHub pushen

### 2.1 Aktuellen Stand committen

```bash
git add .
git commit -m "Ready for Railway deployment"
```

### 2.2 GitHub Repository erstellen

1. Gehe zu: https://github.com/new
2. Repository Name: `shopify-seo-optimizer`
3. **Private** (empfohlen)
4. Klicke **"Create repository"**

### 2.3 Push zu GitHub

```bash
git remote add origin https://github.com/DEIN-USERNAME/shopify-seo-optimizer.git
git branch -M main
git push -u origin main
```

---

## 🎯 Schritt 3: Projekt auf Railway deployen

### 3.1 Neues Projekt erstellen

1. In Railway Dashboard: **"New Project"**
2. Wähle **"Deploy from GitHub repo"**
3. Autorisiere Railway für GitHub (falls nötig)
4. Wähle dein Repository: `shopify-seo-optimizer`

### 3.2 Railway konfiguriert automatisch

Railway erkennt automatisch:
- ✅ Node.js Projekt
- ✅ package.json
- ✅ Build-Command: `npm run build`
- ✅ Start-Command: `npm start`

### 3.3 Postgres-Datenbank hinzufügen

1. Im Projekt, klicke **"+ New"**
2. Wähle **"Database"** → **"PostgreSQL"**
3. Railway erstellt automatisch eine Datenbank

### 3.4 Datenbank verbinden

Railway setzt automatisch die Variable:
```
DATABASE_URL=postgresql://...
```

---

## ⚙️ Schritt 4: Environment Variables setzen

Im Railway Dashboard, unter **"Variables"**:

```env
# Shopify
SHOPIFY_API_KEY=433cf493223c0c6b95bdb91b0de5961a
SHOPIFY_API_SECRET=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
SHOPIFY_SHOP_NAME=8c19f3-ce.myshopify.com
SHOPIFY_API_VERSION=2024-10
SHOPIFY_SCOPES=read_locales,read_online_store_navigation,write_online_store_navigation,read_online_store_pages,write_online_store_pages,read_product_listings,write_product_listings,read_products,write_products,read_content,write_content,read_translations,write_translations

# App URL (Railway gibt dir diese automatisch)
SHOPIFY_APP_URL=https://contentpilot-production.up.railway.app
NODE_ENV=production

# AI Provider
AI_PROVIDER=huggingface
HUGGINGFACE_API_KEY=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
GOOGLE_API_KEY=AIzaSyB8xcxcdTMC2Bs5qTlnJjVi4Wiv9F1VRmI
```

**Wichtig**: Die Railway-URL findest du unter **"Settings"** → **"Domains"**

---

## 🔧 Schritt 5: Prisma für Postgres konfigurieren

### 5.1 Schema für Postgres anpassen

Aktualisiere `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"  // Geändert von "sqlite"
  url      = env("DATABASE_URL")
}
```

### 5.2 package.json Build-Script anpassen

```json
{
  "scripts": {
    "build": "prisma generate && prisma db push && remix vite:build",
    "start": "remix-serve ./build/server/index.js"
  }
}
```

### 5.3 Committen und pushen

```bash
git add prisma/schema.prisma package.json
git commit -m "Configure for Railway deployment"
git push
```

Railway deployt automatisch neu!

---

## 🌐 Schritt 6: Shopify URLs aktualisieren

Nach dem Deployment bekommst du eine URL wie:
```
https://contentpilot-production.up.railway.app
```

### 6.1 In Shopify Partners Dashboard

1. Gehe zu: https://partners.shopify.com/
2. Öffne deine App: **ContentPilot AI Dev**
3. **Configuration** → **URLs**

**App URL:**
```
https://contentpilot-production.up.railway.app
```

**Redirect URLs:**
```
https://contentpilot-production.up.railway.app/auth/callback
https://contentpilot-production.up.railway.app/auth/shopify/callback
https://contentpilot-production.up.railway.app/api/auth/callback
```

### 6.2 Save & Reload

Speichern und App neu installieren!

---

## ✅ Schritt 7: App testen

1. Gehe zu deinem Shop Admin
2. **Apps** → **ContentPilot AI Dev**
3. Die App sollte jetzt funktionieren - vollständig embedded!

---

## 📊 Railway Dashboard

### Logs ansehen:
```
Deployments → Latest → Logs
```

### Build Status:
```
Deployments → Build Logs
```

### Datenbank verwalten:
```
PostgreSQL → Data → Tables
```

---

## 💰 Kosten

**Free Tier**: $5 Guthaben/Monat

Durchschnittlicher Verbrauch:
- Web Service: ~$3-4/Monat
- Postgres DB: ~$1/Monat

**= Bleibt im Free Tier!** 🎉

---

## 🔄 Auto-Deployment

Jedes Mal wenn du pushst:
```bash
git add .
git commit -m "Update features"
git push
```

Railway deployt automatisch neu! (dauert ~2-3 Minuten)

---

## 🐛 Troubleshooting

### Build schlägt fehl

Check die Build Logs in Railway:
```
Deployments → Latest → Build Logs
```

Häufige Probleme:
- `prisma generate` fehlt → Füge zu build script hinzu
- TypeScript errors → `npm run typecheck` lokal
- Missing env vars → Prüfe Railway Variables

### App lädt nicht

1. Check Logs: `Deployments → Latest → Deploy Logs`
2. Prüfe `SHOPIFY_APP_URL` in Railway Variables
3. Prüfe Redirect URLs im Partners Dashboard

### Prisma Connection Error

1. Prüfe `DATABASE_URL` in Railway Variables
2. Check Postgres Service Status
3. Run `prisma db push` im Build Script

---

## 🎯 Alternative: Fly.io

Falls Railway nicht funktioniert:

```bash
# Fly CLI installieren
npm install -g flyctl

# Login
flyctl auth login

# App erstellen
flyctl launch

# Deployen
flyctl deploy
```

Fly.io ist auch kostenlos (3 VMs im Free Tier)!

---

## 📚 Weitere Ressourcen

- [Railway Docs](https://docs.railway.app/)
- [Remix auf Railway](https://docs.railway.app/guides/remix)
- [Prisma mit Railway](https://www.prisma.io/docs/guides/deployment/deployment-guides/deploying-to-railway)

---

**Bereit?** Erstelle einen Railway Account und wir deployen zusammen! 🚀
