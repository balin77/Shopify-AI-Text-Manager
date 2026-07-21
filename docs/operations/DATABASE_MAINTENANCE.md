# Database Maintenance — Runbook

> Wie die Retention **funktioniert** und was sie garantiert, steht im Contract:
> [architecture/DATA_RETENTION_AND_CLEANUP.md](../architecture/DATA_RETENTION_AND_CLEANUP.md).
> Diese Seite ist das operative Runbook: prüfen, aufräumen, Notfall.

## Kontext

Der Hintergrund-Sync schreibt laufend in PostgreSQL. Ein stündlicher Cleanup
(`SyncScheduler.runDatabaseCleanup()`) hält Tasks, Webhook-Logs, überzählige
Free-Plan-Bilder und verwaiste Übersetzungen in Schranken. Historisch lief die
Railway-Volume trotzdem einmal voll — daher dieses Runbook.

## Manueller Cleanup

Für Einmal-Aufräumen oder Notfälle:

```bash
node scripts/cleanup-database.js
# auf Railway:
railway run node scripts/cleanup-database.js
```

Entfernt Theme-Daten, abgelaufene Tasks, alte Webhook-Logs und verwaiste
Übersetzungen und führt anschließend `VACUUM FULL` aus, um Speicher wirklich
freizugeben (der stündliche Cleanup macht **kein** VACUUM).

## Status prüfen

### Sync-Logs

```
[SyncScheduler] Running sync cycle for {shop}
[SyncScheduler] Sync complete for {shop}: X items in Yms
[SyncScheduler] Running periodic database cleanup...
[SyncScheduler] Cleanup complete: X tasks, Y logs, Z excess images, W orphan product translations
```

```bash
railway logs | grep SyncScheduler
```

### Datenbankgröße

```bash
railway connect postgres
```

```sql
-- Datenbankgröße
SELECT pg_database.datname, pg_size_pretty(pg_database_size(pg_database.datname))
FROM pg_database;

-- Tabellengrößen (größte zuerst)
SELECT
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Zeilen in den wachstumskritischen Tabellen
SELECT 'Pages' as table_name, COUNT(*) FROM "Page"
UNION ALL SELECT 'Shop Policies', COUNT(*) FROM "ShopPolicy"
UNION ALL SELECT 'Content Translations', COUNT(*) FROM "ContentTranslation"
UNION ALL SELECT 'Theme Content', COUNT(*) FROM "ThemeContent"
UNION ALL SELECT 'Theme Translations', COUNT(*) FROM "ThemeTranslation"
UNION ALL SELECT 'Tasks', COUNT(*) FROM "Task"
UNION ALL SELECT 'Webhook Logs', COUNT(*) FROM "WebhookLog";
```

## Railway-Empfehlungen

- **Volume:** mindestens 1 GB, besser 2 GB Sicherheitsmarge
- **Disk-Usage** regelmäßig im Railway-Dashboard prüfen
- Prisma-Connection-Limits: Default-Einstellungen reichen

## Wenn die Datenbank wieder vollläuft

1. `railway run node scripts/cleanup-database.js` (inkl. `VACUUM FULL`)
2. Volume-Größe erhöhen: Railway-Dashboard → PostgreSQL-Service → Volumes
3. Größte Tabelle über die SQL oben identifizieren und prüfen, ob sie unter die
   Retention-Regeln fällt — falls nicht, ist das ein Contract-Verstoß, siehe
   [architecture/DATA_RETENTION_AND_CLEANUP.md](../architecture/DATA_RETENTION_AND_CLEANUP.md)
   („Contract für neue Tabellen")
4. Letzter Ausweg: Volume löschen und neu anlegen — **alle Daten sind weg**, der Shop
   muss danach einen vollen `syncAll*`-Lauf machen

## Tuning-Stellschrauben

- `SYNC_INTERVAL_MS` (Default 60 000) — Sync-Frequenz pro aktivem Shop
- Inaktivitäts-Stopp: 5 Minuten (Code-Konstante)
- Cleanup-Intervall: 1 Stunde (Code-Konstante)

Details und Begründung: [architecture/SYNC_AND_WEBHOOKS.md](../architecture/SYNC_AND_WEBHOOKS.md).
