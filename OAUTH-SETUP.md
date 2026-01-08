# OAuth Setup Anleitung

Da Shopify Custom Apps abgeschafft hat, musst du jetzt OAuth verwenden. Keine Sorge - ich habe alles vorbereitet!

## Schritt 1: App im Shopify Dev Dashboard erstellen

1. Gehe zu: https://partners.shopify.com/
2. Wähle deine Organisation oder erstelle eine
3. Klicke auf **"Apps"** → **"Create app"**
4. Wähle **"Create app manually"**
5. Gib deiner App einen Namen (z.B. "API Connector")
6. **Wichtig:** Unter **"App URL"** trage ein: `http://localhost:3000`
7. Unter **"Allowed redirection URL(s)"** trage ein: `http://localhost:3000/api/auth/callback`
8. Klicke auf **"Create app"**

## Schritt 2: API Access Scopes konfigurieren

1. In deiner App gehe zu **"Configuration"**
2. Scrolle zu **"API access scopes"**
3. Aktiviere folgende Scopes:
   - `read_products`
   - `write_products`
   - `read_translations`
   - `write_translations`
4. Klicke auf **"Save"**

## Schritt 3: Client Credentials kopieren

1. Gehe zu **"Settings"** (in deiner App im Dev Dashboard)
2. Kopiere die **Client ID**
3. Kopiere das **Client secret**

## Schritt 4: .env Datei ausfüllen

Öffne die `.env` Datei und trage deine Werte ein:

```env
# Shopify API Credentials (OAuth Flow)
SHOPIFY_API_KEY=deine-client-id-hier
SHOPIFY_API_SECRET=dein-client-secret-hier
SHOPIFY_SHOP_NAME=dein-shop-name
SHOPIFY_API_VERSION=2024-01

# OAuth Settings (kannst du so lassen)
SHOPIFY_SCOPES=read_products,write_products,read_translations,write_translations
SHOPIFY_REDIRECT_URI=http://localhost:3000/api/auth/callback

# Access Token (wird automatisch ausgefüllt)
SHOPIFY_ACCESS_TOKEN=
```

**Wichtig bei `SHOPIFY_SHOP_NAME`:**
- Wenn deine Shop-URL `mein-shop.myshopify.com` ist
- Dann trage nur ein: `mein-shop` (ohne .myshopify.com)

## Schritt 5: OAuth Flow starten

Führe den OAuth Setup aus:

```bash
npm run oauth
```

Das startet einen lokalen Server auf Port 3000.

## Schritt 6: App autorisieren

1. Der Server zeigt dir eine URL: `http://localhost:3000/auth`
2. Öffne diese URL in deinem Browser
3. Du wirst zu Shopify weitergeleitet
4. Wähle deinen Shop aus (falls gefragt)
5. Klicke auf **"Install"** oder **"Authorize"**
6. Du wirst zurück zu `localhost:3000` weitergeleitet
7. Der Access Token wird automatisch in der `.env` Datei gespeichert!

## Schritt 7: Fertig!

Der Server stoppt automatisch nach 5 Sekunden. Dein `.env` sollte jetzt so aussehen:

```env
SHOPIFY_ACCESS_TOKEN=shpat_1234567890abcdefghijklmnopqrstuv
```

Jetzt kannst du den Connector nutzen:

```bash
npm run dev
```

## Troubleshooting

### "Invalid redirect_uri"
- Stelle sicher, dass `http://localhost:3000/api/auth/callback` in den "Allowed redirection URLs" im Dev Dashboard eingetragen ist

### "shop parameter is required"
- Überprüfe, dass `SHOPIFY_SHOP_NAME` in der `.env` korrekt gesetzt ist (nur der Shop-Name, ohne .myshopify.com)

### "Invalid API key or access token"
- Überprüfe, dass `SHOPIFY_API_KEY` und `SHOPIFY_API_SECRET` korrekt aus dem Dev Dashboard kopiert wurden

### Port 3000 bereits belegt
- Ändere in der `.env` den Port in `SHOPIFY_REDIRECT_URI`
- Ändere auch in [src/oauth-setup.ts](src/oauth-setup.ts) die Konstante `PORT`
- Ändere im Dev Dashboard die "Allowed redirection URL"

## Hinweis zur Produktion

Für eine produktive Anwendung:
1. Ändere `http://localhost:3000` zu deiner echten Domain
2. Verwende HTTPS (`https://deine-domain.com`)
3. Aktualisiere die URLs im Dev Dashboard
4. Aktualisiere `SHOPIFY_REDIRECT_URI` in der `.env`
