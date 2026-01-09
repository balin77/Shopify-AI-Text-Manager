# 🛠️ Custom App Setup - Schnellste Methode für Entwicklung

## Warum Custom App statt Public App?

### Public App:
- ❌ Muss von Shopify überprüft werden
- ❌ Braucht öffentlich erreichbare URL (nicht localhost)
- ❌ Muss deployed sein
- ❌ Lange Review-Prozess

### Custom App:
- ✅ Sofort nutzbar
- ✅ Funktioniert mit localhost
- ✅ Perfekt für Entwicklung
- ✅ Keine Review nötig

---

## 🚀 Custom App erstellen - Schritt für Schritt

### Methode A: Direkt im Shop (Schnellste)

#### Schritt 1: Custom App Development aktivieren

1. Öffne deinen Shop Admin: `https://8c19f3-ce.myshopify.com/admin`
2. Gehe zu **Settings** (unten links)
3. Klicke auf **Apps and sales channels**
4. Klicke auf **"Develop apps"** (oben rechts, Button)
5. Falls du eine Warnung siehst: Klicke **"Allow custom app development"**

#### Schritt 2: App erstellen

1. Klicke **"Create an app"**
2. **App name**: `SEO Optimizer`
3. **App developer**: Dein Name/E-Mail
4. Klicke **"Create app"**

#### Schritt 3: API Scopes konfigurieren

1. Gehe zum Tab **"Configuration"**
2. Unter **"Admin API integration"**, klicke **"Configure"**
3. Wähle folgende Scopes:

**Products:**
- ✅ `read_products`
- ✅ `write_products`

**Translations:**
- ✅ `read_translations`
- ✅ `write_translations`
- ✅ `read_locales`

**Content:**
- ✅ `read_content`
- ✅ `write_content`

**Pages:**
- ✅ `read_online_store_pages`
- ✅ `write_online_store_pages`

**Navigation:**
- ✅ `read_navigation`
- ✅ `write_navigation`

**Product Listings:**
- ✅ `read_product_listings`
- ✅ `write_product_listings`

4. Klicke **"Save"**

#### Schritt 4: App installieren

1. Klicke oben rechts auf **"Install app"**
2. Bestätige die Installation
3. **WICHTIG**: Du siehst jetzt den **Admin API access token** - kopiere ihn!

#### Schritt 5: Credentials in .env eintragen

1. Gehe zum Tab **"API credentials"**
2. Kopiere:
   - **API key** → Das ist deine `SHOPIFY_API_KEY`
   - **API secret key** → Das ist dein `SHOPIFY_API_SECRET`
   - **Admin API access token** (vom vorherigen Schritt) → Das ist dein `SHOPIFY_ACCESS_TOKEN`

3. Aktualisiere deine `.env`:

```env
# Shopify API Credentials (Custom App)
SHOPIFY_API_KEY=<dein-api-key>
SHOPIFY_API_SECRET=<dein-api-secret>
SHOPIFY_SHOP_NAME=8c19f3-ce.myshopify.com
SHOPIFY_API_VERSION=2024-10
SHOPIFY_SCOPES=read_products,write_products,read_translations,write_translations,read_locales,read_content,write_content,read_online_store_pages,write_online_store_pages,read_navigation,write_navigation,read_product_listings,write_product_listings
SHOPIFY_ACCESS_TOKEN=<dein-access-token>

# Shopify App URLs
SHOPIFY_APP_URL=https://localhost:3000
NODE_ENV=development

# AI Provider
AI_PROVIDER=huggingface
HUGGINGFACE_API_KEY=hf_...
GOOGLE_API_KEY=AIza...
```

---

## ✅ Jetzt kannst du die App nutzen!

### Option 1: Remix App (Embedded)

**Problem**: Custom Apps können nicht embedded werden (kein OAuth).

**Lösung**: Nutze die alte Web-App für Custom Apps:

```bash
npm run web:old
```

Öffne: `http://localhost:3001`

### Option 2: Embedded App mit OAuth

Dafür brauchst du eine **Public App** im Partners Dashboard, aber mit localhost-URL für Development.

---

## 🔄 Public App für Embedded Development

Wenn du die embedded App nutzen willst (mit Remix):

### Schritt 1: App im Partners Dashboard

1. Gehe zu [Shopify Partners Dashboard](https://partners.shopify.com/)
2. **Apps** → **Create app**
3. **App Type**: Wähle **"Public"**
4. **App name**: `SEO Optimizer Dev`
5. **App URL**: `https://localhost:3000`
6. **Redirect URLs**:
   ```
   https://localhost:3000/auth/callback
   https://localhost:3000/auth/shopify/callback
   https://localhost:3000/api/auth/callback
   ```

### Schritt 2: Distribution auf "Development" setzen

1. In der App, gehe zu **Distribution**
2. **NICHT** auf "Public" setzen!
3. Lasse es auf **"Development"** oder **"Custom"**
4. So kannst du ohne Review installieren

### Schritt 3: Development Store hinzufügen

1. Im Partners Dashboard, unter **"Test your app"**
2. Klicke **"Select store"**
3. Wenn dein Store nicht da ist: **"Add store"**
4. Gib deine Store-URL ein: `8c19f3-ce.myshopify.com`

⚠️ **Wichtig**: Der Store muss ein "Development Store" sein, erstellt über das Partners Dashboard.

Falls dein Store ein regulärer Store ist, kannst du keinen Development-App darauf installieren.

---

## 🎯 Empfehlung für dich

### Für schnelles Testing JETZT:

**Nutze die Custom App (Methode A) + alte Web-App:**

1. Erstelle Custom App im Shop Admin (siehe oben)
2. Kopiere Access Token in `.env`
3. Starte alte Web-App:
   ```bash
   npm run web:old
   ```
4. Öffne: `http://localhost:3001`

✅ **Funktioniert sofort!**

### Für Production/echte Embedded App SPÄTER:

1. Erstelle Development Store im Partners Dashboard
2. Erstelle Public App (Distribution: Development)
3. Installiere auf Development Store
4. Nutze Remix App mit OAuth

---

## 📊 Vergleich

| Feature | Custom App (Shop) | Public App (Partners) |
|---------|-------------------|----------------------|
| Installation | ✅ Sofort | ⏳ Nach Review (wenn public) |
| Embedded | ❌ Nein | ✅ Ja |
| OAuth | ❌ Nein | ✅ Ja |
| Access Token | ✅ Ja (static) | ✅ Ja (per Session) |
| Localhost | ✅ Ja | ⚠️ Nur Development Mode |
| Testing | ✅ Perfekt | ✅ Perfekt |
| Production | ❌ Nicht skalierbar | ✅ Ja |

---

## ❓ FAQ

### Kann ich die Custom App embedded nutzen?

Nein, Custom Apps haben kein OAuth und können nicht embedded werden.

### Soll ich Custom oder Public App nutzen?

- **Custom App**: Für schnelles Testing, API-Zugriff, Scripts
- **Public App**: Für echte embedded Apps, Production

### Kann ich später wechseln?

Ja! Du kannst beide parallel nutzen:
- Custom App für Backend/API-Zugriff
- Public App für Frontend/Embedded UI

---

**Mein Tipp**: Starte mit Custom App + alte Web-App für schnelles Testing, baue dann später die Public App für Production.
