# Sync- & Webhook-Architektur

> **Status:** dauerhaft gültiger Contract. Extrahiert aus `WEBHOOK-SETUP-GUIDE.md`
> (dort standen Architektur und Deployment-Schritte vermischt) und gegen den Code
> verifiziert (2026-07-21). Die Setup-/Deployment-Anleitung liegt in
> [setup/WEBHOOK-SETUP-GUIDE.md](../setup/WEBHOOK-SETUP-GUIDE.md).

## Grundprinzip: DB-first, Shopify-second

Die UI liest **nie** direkt von Shopify. Loader lesen aus PostgreSQL; Shopify-Daten
kommen über zwei Wege in die DB:

1. **Webhooks** (Produkte, Collections, Subscription, Uninstall, Compliance) — Push
2. **Background-Sync** (Pages, Policies, Themes, Metaobjects, …) — Pull im Intervall

Daraus folgt der Invariant, der in [CLAUDE.md](../../CLAUDE.md) als „Reload only
refreshes known IDs" steht: Ein Einzel-Reload (`syncSingleProduct`) aktualisiert nur
bereits bekannte IDs. Neue Shopify-Ressourcen erscheinen ausschließlich über einen
vollen `syncAll*`-Lauf oder über ein `*/create`-Webhook.

## Webhook-Topics

Deklarativ in `shopify.app.dev.toml` / `shopify.app.prod.toml` (nicht im Code
hartkodiert), zusätzlich programmatisch registrierbar über
[webhook-registration.service.ts](../../app/services/webhook-registration.service.ts)
(genutzt von `/app/setup` und `api.setup-webhooks.tsx`):

| Topics | Route |
|--------|-------|
| `customers/data_request`, `customers/redact`, `shop/redact` | `/webhooks/compliance` |
| `app/uninstalled` | `/webhooks/app-uninstalled` |
| `products/create`, `products/update`, `products/delete` | `/webhooks/products` |
| `collections/create`, `collections/update`, `collections/delete` | `/webhooks/collections` |
| `app_subscriptions/update` | `/webhooks/subscription` |

**Shopify bietet keine `article/*`-Topics.** Blog-Artikel werden deshalb nur über den
Background-Sync frisch gehalten, nicht über Webhooks.

## Verarbeitungs-Contract

Jeder Webhook-Handler folgt demselben Ablauf (Referenz:
[webhooks.products.tsx](../../app/routes/webhooks.products.tsx)):

1. **HMAC-Verifikation** über `authenticate.webhook(request)` aus
   `@shopify/shopify-app-remix` — ungültige Signaturen werfen automatisch 401.
   Keine eigene HMAC-Implementierung.
2. **`WebhookLog`-Zeile anlegen** (`processed: false`). Es werden nur Metadaten
   geloggt — das Payload-Feld ist `"{}"`, der echte Payload wird nur im Fehlerfall
   gespeichert (siehe [LOGGING_GUIDE.md](LOGGING_GUIDE.md)).
3. **Sofort `200` zurückgeben**, Verarbeitung asynchron im Hintergrund
   (`processWebhookAsync(...)`). Shopify darf nicht auf den Sync warten.
4. **Fehler → Retry**, nicht Datenverlust: `webhookRetryService.scheduleRetry(...)`
   mit Exponential Backoff (1s → 2s → 4s → 8s → 16s, Deckel 60s), begrenzt durch
   `WEBHOOK_CONFIG.MAX_RETRY_ATTEMPTS`.

## Drift-Reconcile (Safety-Net)

Products und Collections liegen **nicht** im regulären
`BackgroundSyncService.syncAll`-Zyklus — sie hängen an Webhooks. Verpasst die App ein
Event (Downtime, Zustellfehler), driftet der Cache still.
[webhook-reconcile.service.ts](../../app/services/webhook-reconcile.service.ts)
gleicht das ab:

- listet nur `id + updatedAt` (auf das Plan-Limit gedeckelt),
- diffed gegen den lokalen Cache,
- repariert **nur** gedriftete Items über **exakt dieselben** Einzel-Item-Entrypoints,
  die auch die Webhooks nutzen — kein zweiter, divergierender Sync-Pfad,
- löscht veraltete Zeilen nur, wenn das Remote-Listing beweisbar vollständig ist
  (Outage-Guard gegen leere Antworten),
- läuft nur für aktive Shops, alle N Inkrement-Zyklen.

## Scheduler-Parameter

[sync-scheduler.service.ts](../../app/services/sync-scheduler.service.ts):

| Parameter | Wert |
|-----------|------|
| Sync-Intervall | `SYNC_INTERVAL_MS`, Default **60 s** (env-konfigurierbar) |
| Inaktivitäts-Stopp | **5 Minuten** ohne Shop-Aktivität |
| Cleanup-Intervall | **1 Stunde**, global (shop-unabhängig) — siehe [DATA_RETENTION_AND_CLEANUP.md](DATA_RETENTION_AND_CLEANUP.md) |
| Initial-Sync-Maxalter | 3 Stunden |

Der Start jedes Shop-Timers bekommt einen zufälligen Phasen-Offset innerhalb des
Intervalls, damit nicht alle Mandanten gleichzeitig gegen Shopify laufen.

**Theme-Sync:** `syncAll()` deckt nur das MAIN-Theme ab (Shopifys
`translatableResources` kann andere Themes nicht listen). Für ein vom Händler
ausgewähltes Nicht-MAIN-Theme läuft ein zusätzlicher, gescopeter `syncTheme(id)`-Pass
im selben Zyklus — siehe [THEME_SELECTION.md](THEME_SELECTION.md).

## Verwandt

- [DATA_RETENTION_AND_CLEANUP.md](DATA_RETENTION_AND_CLEANUP.md) — was der Cleanup löscht
- [THEME_SELECTION.md](THEME_SELECTION.md) — Theme-Scoping des Syncs
- [GDPR_COMPLIANCE.md](GDPR_COMPLIANCE.md) — Compliance-Webhooks, `redactShopData`
- [BILLING_SYSTEM.md](BILLING_SYSTEM.md) — `app_subscriptions/update`
