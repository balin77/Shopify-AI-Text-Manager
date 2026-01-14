# GDPR Compliance Implementation Guide

## Overview

Die Shopify API Connector App ist jetzt **GDPR-compliant** (General Data Protection Regulation - EU-Datenschutz-Grundverordnung).

Alle drei Pflicht-Webhooks von Shopify sind implementiert:
1. ✅ `customers/data_request` - Daten-Export
2. ✅ `customers/redact` - Kunden-Daten löschen
3. ✅ `shop/redact` - Shop-Daten löschen

---

## 📋 Was ist GDPR?

**GDPR (General Data Protection Regulation)** ist die EU-weite Datenschutzverordnung, die vorschreibt wie persönliche Daten verarbeitet werden müssen.

### Warum ist das wichtig?

- ✅ **Shopify Requirement:** Apps MÜSSEN GDPR-compliant sein
- ✅ **App Review:** Shopify lehnt Apps ohne GDPR Webhooks ab
- ✅ **Rechtliche Anforderungen:** Pflicht in der EU
- ✅ **Geldstrafen:** Bis zu €20 Millionen oder 4% des Jahresumsatzes bei Verstößen

---

## 🔍 Welche Daten speichern wir?

### Persönliche Daten (PII - Personally Identifiable Information)

**Session Tabelle:**
- `userId` - Shopify User ID
- `firstName` - Vorname des Users
- `lastName` - Nachname des Users
- `email` - E-Mail-Adresse
- `locale` - Sprache
- `accountOwner` - Ist Shop-Besitzer
- `collaborator` - Ist Mitarbeiter

**Weitere Tabellen (keine PII):**
- AISettings - API Keys (verschlüsselt), Provider-Einstellungen
- AIInstructions - AI-Format-Vorlagen
- Products, Collections, Articles, Pages - Shopify-Content
- Tasks - Background Jobs
- WebhookLogs - Event-Logs

---

## 📨 Implementierte GDPR Webhooks

### 1. customers/data_request

**Endpoint:** `POST /webhooks/gdpr/customers/data_request`

**Wann:**
- Kunde fordert Daten-Export an (z.B. über Shopify Admin)
- GDPR Artikel 15 - Recht auf Auskunft

**Was wir machen:**
1. Suchen alle Sessions des Kunden (by email/userId)
2. Exportieren alle persönlichen Daten
3. Returnieren JSON mit allen Daten

**Deadline:** 30 Tage

**Beispiel Response:**
```json
{
  "success": true,
  "data": {
    "customer": {
      "id": 123456,
      "email": "kunde@example.com",
      "phone": "+49123456789"
    },
    "shop": "my-shop.myshopify.com",
    "sessions": [
      {
        "id": "session_123",
        "userId": "123456",
        "firstName": "Max",
        "lastName": "Mustermann",
        "email": "kunde@example.com",
        "locale": "de",
        "accountOwner": true,
        "lastActivityAt": "2026-01-14T10:00:00Z"
      }
    ],
    "dataCollected": {
      "personalData": {
        "firstName": "Max",
        "lastName": "Mustermann",
        "email": "kunde@example.com",
        "locale": "de"
      }
    },
    "note": "This app only stores session data for authentication purposes."
  }
}
```

---

### 2. customers/redact

**Endpoint:** `POST /webhooks/gdpr/customers/redact`

**Wann:**
- Kunde fordert Löschung seiner Daten an
- GDPR Artikel 17 - Recht auf Vergessenwerden

**Was wir machen:**
1. Suchen alle Sessions des Kunden
2. **Löschen ALLE** persönlichen Daten des Kunden
3. Bestätigen Löschung

**Deadline:** 30 Tage (aber sofortige Löschung empfohlen)

**Was wird gelöscht:**
- Alle Sessions mit userId/email des Kunden
- Alle persönlichen Daten (firstName, lastName, email, etc.)

**Beispiel Response:**
```json
{
  "success": true,
  "message": "Customer data deleted successfully"
}
```

---

### 3. shop/redact

**Endpoint:** `POST /webhooks/gdpr/shop/redact`

**Wann:**
- Shop deinstalliert die App
- GDPR Artikel 17 - Recht auf Vergessenwerden

**Was wir machen:**
1. **Löschen ALLE Daten** des Shops aus ALLEN Tabellen
2. Komplette Bereinigung der Datenbank
3. Bestätigen Löschung

**Deadline:** 48 Stunden

**Was wird gelöscht (ALLES!):**
- ✅ Sessions (alle User des Shops)
- ✅ AISettings (inkl. API Keys)
- ✅ AIInstructions
- ✅ Tasks
- ✅ Products (mit Translations, Images, etc.)
- ✅ Collections
- ✅ Articles
- ✅ Pages
- ✅ Shop Policies
- ✅ Menus
- ✅ Content Translations
- ✅ Theme Content
- ✅ Theme Translations
- ✅ Webhook Logs

**Beispiel Response:**
```json
{
  "success": true,
  "message": "Shop data deleted successfully"
}
```

---

## 🚀 Shopify Partner Dashboard Setup

### Schritt 1: Webhooks registrieren

1. **Gehe zu:** https://partners.shopify.com/
2. **Apps auswählen** → Deine App
3. **App setup** → **Event subscriptions**

### Schritt 2: GDPR Webhooks hinzufügen

**1. Customers/Data Request:**
```
Topic:   customers/data_request
URL:     https://your-app.railway.app/webhooks/gdpr/customers/data_request
Format:  JSON
Version: 2024-10 (latest)
```

**2. Customers/Redact:**
```
Topic:   customers/redact
URL:     https://your-app.railway.app/webhooks/gdpr/customers/redact
Format:  JSON
Version: 2024-10 (latest)
```

**3. Shop/Redact:**
```
Topic:   shop/redact
URL:     https://your-app.railway.app/webhooks/gdpr/shop/redact
Format:  JSON
Version: 2024-10 (latest)
```

### Schritt 3: Webhooks verifizieren

Nach dem Hinzufügen:
1. Klicke auf **"Test webhook"** für jeden Endpoint
2. Prüfe Railway Logs für erfolgreiche Verarbeitung
3. Status sollte **"Active"** sein

---

## 🧪 Testing

### Lokales Testing

Da GDPR Webhooks nur von Shopify gesendet werden, kannst du sie lokal mit curl testen:

```bash
# Test customers/data_request
curl -X POST http://localhost:3000/webhooks/gdpr/customers/data_request \
  -H "Content-Type: application/json" \
  -d '{
    "shop_id": 12345,
    "shop_domain": "test-shop.myshopify.com",
    "customer": {
      "id": 67890,
      "email": "test@example.com",
      "phone": "+491234567890"
    },
    "orders_requested": []
  }'

# Test customers/redact
curl -X POST http://localhost:3000/webhooks/gdpr/customers/redact \
  -H "Content-Type: application/json" \
  -d '{
    "shop_id": 12345,
    "shop_domain": "test-shop.myshopify.com",
    "customer": {
      "id": 67890,
      "email": "test@example.com",
      "phone": "+491234567890"
    },
    "orders_to_redact": []
  }'

# Test shop/redact
curl -X POST http://localhost:3000/webhooks/gdpr/shop/redact \
  -H "Content-Type: application/json" \
  -d '{
    "shop_id": 12345,
    "shop_domain": "test-shop.myshopify.com"
  }'
```

### Production Testing

1. **Shopify Partner Dashboard** → Event subscriptions
2. Klicke **"Send test webhook"** für jeden GDPR Webhook
3. Prüfe Railway Logs:
   ```bash
   railway logs
   ```
4. Suche nach:
   ```
   📨 [GDPR] Received customers/data_request webhook
   ✅ [GDPR] Customer data exported successfully
   ```

---

## 📊 Compliance Logging

Alle GDPR Requests werden geloggt für Compliance Audit Trail:

```typescript
{
  timestamp: "2026-01-14T10:00:00.000Z",
  shop: "my-shop.myshopify.com",
  requestType: "customer_redact",
  customerId: 67890,
  customerEmail: "kunde@example.com",
  status: "completed"
}
```

**WICHTIG:** Diese Logs müssen für **mindestens 3 Jahre** aufbewahrt werden (GDPR Compliance).

**TODO für Production:**
- [ ] Erstelle separate GDPR Audit Log Tabelle
- [ ] Implementiere automatische Archivierung
- [ ] Backup-Strategie für Compliance Logs

---

## 🔐 Security

### Webhook Authentifizierung

⚠️ **WICHTIG:** Shopify GDPR Webhooks verwenden **HMAC-Signatur** zur Authentifizierung.

**TODO für Production:**
- [ ] HMAC Verification implementieren
- [ ] Shopify Webhook Secret in Environment Variables
- [ ] Request Signature validieren

**Beispiel HMAC Verification:**
```typescript
import crypto from 'crypto';

function verifyShopifyWebhook(body: string, hmacHeader: string): boolean {
  const secret = process.env.SHOPIFY_API_SECRET;
  const hash = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');
  return hash === hmacHeader;
}
```

---

## ⚠️ Wichtige Hinweise

### 1. Daten-Retention

**Was wir NICHT löschen dürfen:**
- Finanzdaten (falls vorhanden) - 10 Jahre Aufbewahrungspflicht
- GDPR Compliance Logs - 3 Jahre Aufbewahrungspflicht
- Rechtlich erforderliche Daten

**Was wir löschen müssen:**
- Alle persönlichen Daten des Kunden/Shops
- Sessions, Profile, Preferences
- Nicht-essentielle Metadaten

### 2. Anonymisierung vs. Löschung

Bei `customers/redact`:
- **Option A:** Komplette Löschung (aktuell implementiert)
- **Option B:** Anonymisierung (Name → "User_123456")

Wir verwenden **Option A** (Löschung), da wir keine historischen Daten benötigen.

### 3. Cascade Deletes

Das Prisma Schema nutzt Cascade Deletes:
```prisma
model Product {
  translations Translation[] // Cascade delete
  images ProductImage[]      // Cascade delete
}
```

Beim Löschen eines Products werden automatisch alle Relations gelöscht.

---

## 📚 GDPR Artikel Referenz

| Artikel | Titel | Implementierung |
|---------|-------|-----------------|
| **Art. 15** | Recht auf Auskunft | `customers/data_request` |
| **Art. 17** | Recht auf Vergessenwerden | `customers/redact`, `shop/redact` |
| **Art. 30** | Verzeichnis von Verarbeitungstätigkeiten | Compliance Logs |
| **Art. 32** | Sicherheit der Verarbeitung | API Key Encryption |
| **Art. 33** | Meldung von Datenschutzverletzungen | Error Logging |

---

## 🎯 Deployment Checklist

### Pre-Production
- [x] GDPR Service implementiert
- [x] Alle 3 Webhook Routes erstellt
- [x] Logging implementiert
- [ ] HMAC Verification implementiert
- [ ] Separate Audit Log Tabelle erstellt
- [ ] Lokales Testing durchgeführt

### Production
- [ ] Webhooks in Shopify Partner Dashboard registriert
- [ ] Test Webhooks von Shopify gesendet
- [ ] Logs in Railway überprüft
- [ ] ENCRYPTION_KEY für API Keys gesetzt
- [ ] Backup-Strategie für Compliance Logs

### Post-Production
- [ ] GDPR Compliance Team informiert
- [ ] Datenschutzerklärung aktualisiert
- [ ] App Review bei Shopify eingereicht

---

## 🆘 Troubleshooting

### Problem: Webhook wird nicht empfangen

**Checkliste:**
- [ ] Webhook URL korrekt? (https://your-app.railway.app/webhooks/...)
- [ ] App ist deployed und online?
- [ ] Railway Logs zeigen eingehende Requests?
- [ ] Shopify Webhook Status ist "Active"?

**Debug:**
```bash
# Railway Logs checken
railway logs

# Nach GDPR Requests suchen
railway logs | grep GDPR
```

### Problem: "Failed to delete shop data"

**Ursachen:**
- Datenbank Constraint Violations
- Orphaned Records
- Transaction Timeout

**Lösung:**
```typescript
// Erhöhe Transaction Timeout
await db.$transaction(async (tx) => {
  // ...
}, {
  timeout: 30000, // 30 seconds
});
```

### Problem: HMAC Verification fails

**Lösung:**
```bash
# Prüfe SHOPIFY_API_SECRET
railway variables get SHOPIFY_API_SECRET

# Stelle sicher dass es mit Partner Dashboard übereinstimmt
```

---

## 📞 Support

Bei Fragen zur GDPR Compliance:
1. Shopify Developer Docs: https://shopify.dev/docs/apps/build/privacy-law-compliance
2. GDPR Full Text: https://gdpr-info.eu/
3. Shopify Privacy Team: privacy@shopify.com

---

## 📝 Changelog

### v1.0.0 (2026-01-14)
- ✅ Initial GDPR implementation
- ✅ All 3 mandatory webhooks implemented
- ✅ GDPR Service with export/redact functions
- ✅ Compliance logging
- ✅ Comprehensive documentation

---

**Erstellt:** 2026-01-14
**Letztes Update:** 2026-01-14
**Version:** 1.0.0
**Status:** ✅ Ready for Production (HMAC verification pending)
