# 🔧 Shopify Embedded App - Setup Anleitung

## Problem: Store nicht gefunden

Der Fehler `Could not find Store for domain 8c19f3-ce.myshopify.com` bedeutet, dass dein Development Store nicht mit deiner Shopify Partners Organization verbunden ist.

---

## ✅ Lösung: App im Partners Dashboard einrichten

### Schritt 1: Shopify Partners Dashboard öffnen

1. Gehe zu: [https://partners.shopify.com/](https://partners.shopify.com/)
2. Logge dich ein
3. Wähle deine Organization

### Schritt 2: App überprüfen/erstellen

**Option A: Bestehende App verwenden**

1. Klicke auf **Apps** im Menü
2. Finde deine App (Client ID: `60e05fcbb585ff0376a3914018d7b53d`)
3. Klicke auf die App

**Option B: Neue App erstellen (falls nötig)**

1. Klicke auf **Apps** > **Create app**
2. Wähle **Custom app**
3. App Name: `Shopify SEO Optimizer`
4. Notiere die **Client ID** und **Client Secret**

### Schritt 3: App-URLs konfigurieren

In den App-Einstellungen unter **Configuration**:

#### App URL:
```
https://localhost:3000
```

#### Allowed redirection URLs:
```
https://localhost:3000/auth/callback
https://localhost:3000/auth/shopify/callback
https://localhost:3000/api/auth/callback
```

#### App Proxy (optional):
Erstmal leer lassen

#### Scopes (unter "API access scopes"):
- ✅ `read_products`
- ✅ `write_products`
- ✅ `read_translations`
- ✅ `write_translations`

### Schritt 4: .env-Datei aktualisieren

Kopiere die **Client ID** und **Client Secret** aus dem Partners Dashboard in deine `.env`:

```env
# Shopify API Credentials
SHOPIFY_API_KEY=<deine-client-id>
SHOPIFY_API_SECRET=<dein-client-secret>
SHOPIFY_SHOP_NAME=8c19f3-ce.myshopify.com
SHOPIFY_API_VERSION=2024-10
SHOPIFY_SCOPES=read_products,write_products,read_translations,write_translations

# Für Embedded App
SHOPIFY_APP_URL=https://localhost:3000
NODE_ENV=development

# AI Provider
AI_PROVIDER=huggingface
HUGGINGFACE_API_KEY=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
GOOGLE_API_KEY=AIzaSyB8xcxcdTMC2Bs5qTlnJjVi4Wiv9F1VRmI
```

⚠️ **WICHTIG**: Lösche die `SHOPIFY_ACCESS_TOKEN` Zeile, da wir jetzt OAuth verwenden!

### Schritt 5: Development Store verbinden

1. Im Partners Dashboard, unter **Test your app**
2. Klicke auf **Select store**
3. Wähle deinen Store `8c19f3-ce.myshopify.com`
4. Oder erstelle einen neuen Development Store

### Schritt 6: Lokalen Server starten

```bash
# Terminal 1: Remix Dev Server
npm run dev
```

Der Server läuft auf: **http://localhost:3000**

### Schritt 7: App installieren

Es gibt zwei Wege, die App zu installieren:

#### Methode 1: Über Shopify Admin (Manuell)

1. Öffne deinen Shop Admin: `https://8c19f3-ce.myshopify.com/admin`
2. In der Browser-Adresszeile, gib ein:
   ```
   https://8c19f3-ce.myshopify.com/admin/oauth/authorize?client_id=<DEINE_CLIENT_ID>&scope=read_products,write_products,read_translations,write_translations&redirect_uri=https://localhost:3000/auth/callback
   ```
   Ersetze `<DEINE_CLIENT_ID>` mit deiner Client ID!

3. Klicke auf **Install app**
4. Du wirst zu deiner App weitergeleitet

#### Methode 2: Über Development Store URL (Einfacher)

1. Im Partners Dashboard, unter deiner App
2. Klicke auf **Test on development store**
3. Wähle `8c19f3-ce.myshopify.com`
4. Die App wird automatisch installiert

---

## 🎯 Alternative: Ohne Partners Dashboard (Nur für lokale Entwicklung)

Falls du keinen Zugriff auf Partners Dashboard hast:

### 1. Verwende die alte Web-App

```bash
npm run web:old
```

Diese läuft auf `http://localhost:3001` und nutzt den bestehenden Access Token.

### 2. Oder: Custom App in deinem Shop erstellen

1. Gehe zu deinem Shop Admin: `https://8c19f3-ce.myshopify.com/admin`
2. **Settings** > **Apps and sales channels** > **Develop apps**
3. **Create an app**
4. App Name: `SEO Optimizer Local`
5. **Configuration** > **Admin API integration**
6. Scopes: `read_products`, `write_products`, `read_translations`, `write_translations`
7. **Install app** und kopiere den **Access Token**

Dann in `.env`:
```env
SHOPIFY_ACCESS_TOKEN=<dein-neuer-token>
```

---

## 🐛 Troubleshooting

### Fehler: "Invalid OAuth callback"

**Ursache**: Die Redirect URL in der App-Konfiguration stimmt nicht mit der URL in deinem Code überein.

**Lösung**:
1. Prüfe, dass in Partners Dashboard: `https://localhost:3000/auth/callback` eingetragen ist
2. Prüfe, dass `SHOPIFY_APP_URL=https://localhost:3000` in `.env`

### Fehler: "SSL certificate problem"

**Ursache**: Localhost verwendet kein gültiges SSL-Zertifikat.

**Lösung**:
```bash
# In Windows: Tunnel mit ngrok
npx ngrok http 3000

# Verwende die ngrok-URL statt localhost:
# z.B. https://abc123.ngrok.io
```

Dann in `.env`:
```env
SHOPIFY_APP_URL=https://abc123.ngrok.io
```

Und im Partners Dashboard die URLs aktualisieren.

### Fehler: "Cannot find module"

```bash
npm install --legacy-peer-deps
```

### Fehler: Prisma

```bash
npm run prisma:generate
npm run prisma:push
```

---

## ✅ Erfolg prüfen

Wenn alles funktioniert:

1. Du siehst deine App im Shopify Admin unter **Apps**
2. Die App öffnet sich in einem iframe
3. Du siehst das Dashboard mit "Willkommen!"
4. Du kannst zu "Produkte verwalten" navigieren
5. Du siehst deine Produkte

---

## 📞 Weitere Hilfe

- [Shopify App Setup Docs](https://shopify.dev/docs/apps/getting-started)
- [OAuth Docs](https://shopify.dev/docs/apps/auth/oauth)
- [Partners Dashboard](https://partners.shopify.com/)

---

**Viel Erfolg! 🚀**
