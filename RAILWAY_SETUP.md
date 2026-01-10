# Railway Environment Variables Setup

## Problem: Navigation funktioniert nicht

Wenn die Navigation zwischen Tabs nicht funktioniert, liegt das meistens an falschen Environment Variables in Railway.

## Lösung: Railway Environment Variables überprüfen

### 1. Railway Domain finden

1. Gehe zu Railway Dashboard: https://railway.app/
2. Öffne dein Projekt
3. Gehe zu **Settings** → **Domains**
4. Kopiere die Railway Domain (z.B. `https://your-project.up.railway.app`)

### 2. Environment Variables in Railway setzen

Gehe zu **Variables** Tab und stelle sicher, dass folgende Variablen gesetzt sind:

#### Erforderliche Variablen:

```bash
# Shopify API Credentials (aus Partner Dashboard)
SHOPIFY_API_KEY=dein-api-key-hier
SHOPIFY_API_SECRET=shpss_dein-secret-hier

# WICHTIG: Diese URL MUSS deine Railway URL sein!
SHOPIFY_APP_URL=https://your-project.up.railway.app

# Shopify Scopes
SHOPIFY_SCOPES=read_legal_policies,write_legal_policies,read_locales,read_online_store_navigation,write_online_store_navigation,read_online_store_pages,write_online_store_pages,read_product_listings,write_product_listings,read_products,write_products,read_content,write_content,read_themes,write_themes,read_translations,write_translations

# Node Environment
NODE_ENV=production

# Database (automatisch von Railway gesetzt)
DATABASE_URL=postgresql://...
```

#### Optionale AI Provider Variablen:

```bash
# AI Provider
AI_PROVIDER=huggingface

# Hugging Face (kostenlos)
HUGGINGFACE_API_KEY=hf_dein-key-hier

# Google Gemini (kostenlos)
GOOGLE_API_KEY=dein-key-hier

# Claude (optional)
ANTHROPIC_API_KEY=dein-key-hier

# OpenAI (optional)
OPENAI_API_KEY=dein-key-hier
```

### 3. Shopify Partner Dashboard aktualisieren

Nach dem Setzen der Railway Variables:

1. Gehe zu https://partners.shopify.com/
2. Öffne deine App
3. Gehe zu **Configuration**
4. Aktualisiere folgende URLs mit deiner Railway URL:
   - **App URL**: `https://your-project.up.railway.app`
   - **Allowed redirection URL(s)**:
     - `https://your-project.up.railway.app/auth/callback`
     - `https://your-project.up.railway.app/auth/shopify/callback`

### 4. Deployment neu starten

Nach dem Aktualisieren der Variables:

1. Gehe zum **Deployments** Tab in Railway
2. Klicke auf die drei Punkte beim letzten Deployment
3. Wähle **Redeploy**

### 5. Validierung

Nach dem Deployment solltest du in den Railway Logs sehen:

```
🔍 Validating environment variables...
✅ SHOPIFY_API_KEY: ...
✅ SHOPIFY_API_SECRET: ...
✅ SHOPIFY_SCOPES: ...
✅ SHOPIFY_APP_URL: ...
✅ All required scopes present
```

Wenn du Warnungen siehst:
```
⚠️  SHOPIFY_APP_URL uses Cloudflare Tunnel (temporary!)
```

Dann ist die `SHOPIFY_APP_URL` falsch und muss auf deine Railway URL aktualisiert werden!

## Häufige Fehler

### ❌ Cloudflare Tunnel URL verwenden
```bash
# FALSCH (temporär):
SHOPIFY_APP_URL=https://adipex-blanket-dried-cubic.trycloudflare.com

# RICHTIG (permanent):
SHOPIFY_APP_URL=https://your-project.up.railway.app
```

### ❌ Localhost in Production
```bash
# FALSCH:
SHOPIFY_APP_URL=https://localhost:3000

# RICHTIG:
SHOPIFY_APP_URL=https://your-project.up.railway.app
```

### ❌ Trailing Slash
```bash
# FALSCH:
SHOPIFY_APP_URL=https://your-project.up.railway.app/

# RICHTIG:
SHOPIFY_APP_URL=https://your-project.up.railway.app
```

## Manuelle Validierung

Du kannst die Environment Variables auch manuell testen:

```bash
npm run validate:env
```

Dieses Script wird automatisch bei jedem Start ausgeführt und überprüft alle wichtigen Variablen.
