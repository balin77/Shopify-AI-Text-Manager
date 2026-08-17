# Datenhaltung & automatischer Cleanup

> **Status:** dauerhaft gültiger Contract. Extrahiert aus `DATABASE_MAINTENANCE.md`
> und gegen [sync-scheduler.service.ts](../../app/services/sync-scheduler.service.ts)
> verifiziert (2026-07-21). Das Runbook (SQL, Notfall-Schritte) liegt in
> [operations/DATABASE_MAINTENANCE.md](../operations/DATABASE_MAINTENANCE.md).

## Warum es das gibt

Der Hintergrund-Sync schreibt kontinuierlich in PostgreSQL. Ohne Retention wuchs die
Railway-Volume bis zum Disk-Full (historischer Auslöser: Theme-Translations). Retention
ist deshalb Teil des Systems, kein Ops-Nachgedanke.

## Periodischer Cleanup

`SyncScheduler.runDatabaseCleanup()` läuft **stündlich** (`CLEANUP_INTERVAL_MS`), global
und shop-unabhängig — der Timer startet bei Modul-Konstruktion und läuft auch dann, wenn
gerade kein Shop aktiv ist (sonst wüchsen die globalen Tabellen unbegrenzt weiter).
Beim ersten Start läuft er einmal sofort.

Gelöscht wird:

| # | Daten | Regel |
|---|-------|-------|
| 1 | `Task` | `expiresAt` abgelaufen **oder** Status `completed`/`failed`/`cancelled` und älter als **3 Tage** |
| 2 | `WebhookLog` | `processed: true` älter als **24 h**; **alle** Zeilen älter als **7 Tage** (auch fehlgeschlagene — sie waren früher exempt und wuchsen unbegrenzt) |
| 3 | `ProductImage` | nur **Free-Plan-Shops**: alles mit `position > 0` (Free = „featured-only"; bezahlte Pläne cachen alle Bilder). In Shop-Batches à 50, um lange Locks zu vermeiden |
| 4 | `ProductImageAltTranslation` | verwaiste Zeilen (Bild existiert nicht mehr) — ein atomares Anti-Join-SQL, kein N+1-Fetch |
| 5 | `ContentTranslation` | **nur** `resourceType = 'Product'` mit nicht mehr existierender `resourceId` |

### Warum #5 so eng gescoped ist

`ContentTranslation.resourceId` ist **polymorph** — kein FK, kein `ON DELETE CASCADE`.
Zeilen verwaisen, sobald eine Ressource verschwindet, ohne dass ein Pfad sie mit
aufräumt. Der Purge deckt bewusst nur den eindeutigen, dominanten Fall ab
(`resourceType='Product'` gegen die `Product`-Tabelle). Collection/Article/Page/
ShopPolicy/Metaobject und die Sub-Resource-Zeilen (ProductOption/Metafield) leben in
anderen ID-Räumen; ein korrekter Purge braucht pro-Typ-Mapping und ist absichtlich
einer eigenen Änderung vorbehalten. **Diese Scoping-Grenze nicht aufweichen** — ein
breiter Purge löscht sonst gültige Übersetzungen.

## Theme-Daten

Theme-Daten werden **nicht** vom stündlichen Cleanup angefasst. Sie werden vom
Sync-Zyklus selbst ersetzt (Upsert + alte Translations löschen + neu schreiben), sodass
sich nichts akkumuliert.

> Historie: Theme-Sync war zeitweise komplett deaktiviert und der Cleanup löschte
> stattdessen *alle* Theme-Daten. Das gilt seit der Theme-Selection-Arbeit
> nicht mehr (siehe [THEME_SELECTION.md](THEME_SELECTION.md)) — ältere Notizen, die
> „Theme-Sync ist deaktiviert" behaupten, sind überholt.

## Contract für neue Tabellen

Jede neue Tabelle, in die der Sync oder ein Webhook schreibt, braucht **eine** davon:

1. eine FK-Beziehung mit `ON DELETE CASCADE`, **oder**
2. einen Eintrag in `runDatabaseCleanup()` mit expliziter Retention, **oder**
3. eine dokumentierte Begründung, warum sie beschränkt wächst (z. B. eine Zeile pro Shop).

Sonst ist sie ein künftiger Disk-Full.

## Verwandt

- [SYNC_AND_WEBHOOKS.md](SYNC_AND_WEBHOOKS.md) — wer die Daten schreibt
- [PLAN_SYSTEM.md](PLAN_SYSTEM.md) — Plan-Limits (Basis der Free-Plan-Bildregel)
- [operations/DATABASE_MAINTENANCE.md](../operations/DATABASE_MAINTENANCE.md) — Runbook
