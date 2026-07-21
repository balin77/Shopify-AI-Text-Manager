# Webhook-System — Setup Guide

> **Wie das System funktioniert** (Topics, HMAC, Retry, Drift-Reconcile,
> Scheduler-Parameter) steht im Contract:
> [architecture/SYNC_AND_WEBHOOKS.md](../architecture/SYNC_AND_WEBHOOKS.md).
> Diese Seite ist die Einrichtungs-Anleitung.

Ergebnis nach dem Setup: Produkt- und Übersetzungsdaten liegen in PostgreSQL, die App
lädt ohne Shopify-API-Call beim Page-Load, Sprachwechsel ist instant, und Änderungen im
Shopify-Admin fließen per Webhook automatisch nach.

---

## Deployment-Schritte

### 1. Code deployen

```bash
git push
```

Railway deployt automatisch.

### 2. Datenbank-Migration ausführen

```bash
# Via Railway CLI (lokal)
railway run npx prisma migrate deploy

# Oder im Railway Web-Terminal
npx prisma migrate deploy
```

Details und Troubleshooting: [PRISMA_MIGRATION_GUIDE.md](PRISMA_MIGRATION_GUIDE.md).

### 3. App-Setup durchführen

1. App im Shopify-Admin öffnen
2. Zu `/app/setup` navigieren
3. **„Setup Webhooks"** klicken — registriert die Product-/Collection-Webhooks
4. **„Sync Products"** klicken — importiert Produkte + Übersetzungen in die DB
   (bei Fehlern: „Force Re-Sync")

### 4. Verifizieren

Auf `/app/setup` sollte stehen:

- ✅ „Products in database: X" (X = Anzahl deiner Produkte)
- ✅ „Translations in database: Y"
- ✅ „Webhook events received: 0" (steigt, sobald du im Admin etwas änderst)

---

## Testing

### Sprachwechsel

Produkt wählen → Sprache wechseln (DE → EN) → **Erwartung:** sofortiger Wechsel ohne
Ladezeit. Console: `[LANGUAGE-CHANGE] Switching to: en`.

### Webhook

Produkt im Shopify-Admin ändern und speichern, dann Railway-Logs prüfen:

```
🎣 [WEBHOOK] === PRODUCT WEBHOOK RECEIVED ===
[WEBHOOK] Topic: products/update
[WEBHOOK-ASYNC] Syncing product: gid://shopify/Product/123
[ProductSync] Successfully synced product
```

App neu laden → Änderung ist sichtbar.

### Speichern & Translate All

Fremdsprache wählen → Text ändern → speichern → Sprache wechseln und zurück →
Änderung ist da. „Translate All" ausführen, alle Sprachen prüfen, Seite neu laden →
Übersetzungen bleiben (liegen in der DB).

---

## Troubleshooting

### „Products in database: 0" nach dem Sync

Migration nicht gelaufen:

```bash
railway run npx prisma migrate deploy
```

### „No webhook events received"

1. `/app/setup` → „Setup Webhooks" erneut klicken
2. Shopify-Admin → Settings → Notifications → Webhooks prüfen
3. Erwartet: `products/create`, `products/update`, `products/delete` auf
   `https://<app-domain>/webhooks/products`

### Übersetzungen werden nicht gespeichert

1. Railway-Logs auf Webhook-Events prüfen
2. Webhook-URL korrekt? `https://<app-domain>/webhooks/products`
3. `SHOPIFY_API_SECRET` korrekt gesetzt? (Ohne das schlägt die HMAC-Prüfung fehl → 401)

### Sprachwechsel lädt nicht sofort

`/app/setup` → „Force Re-Sync" → warten → App neu laden.

---

## Monitoring

**In der App:** `/app/setup` zeigt Produkte, Übersetzungen und empfangene
Webhook-Events.

**Railway-Logs:**

```bash
railway logs | grep WEBHOOK
railway logs | grep ProductSync
```

**Shopify-Admin:** Settings → Notifications → Webhooks

---

## Success-Checklist

- [ ] Code deployt
- [ ] Migration ausgeführt
- [ ] Webhooks registriert (via `/app/setup`)
- [ ] Produkte synchronisiert (via `/app/setup`)
- [ ] Sprachwechsel getestet → instant
- [ ] Webhook getestet → Admin-Änderung erscheint in der App
- [ ] Speichern getestet
- [ ] Translate All getestet → Übersetzungen überleben Reload
