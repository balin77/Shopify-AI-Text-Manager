# Admin-Seite: Shop-Übersicht und Verbindungszustand — Plan

**Status:** Entwurf 2026-11-08. Nichts gebaut. Die Grundlage sind zwei Planungsläufe gegen `develop` `f0a4d2fb`. Die beiden dringenden Befunde in §0 sind gegen Code und Production-Logs geprüft, der Rest gegen den Code. Zeilenangaben beziehen sich auf `f0a4d2fb`.

**Arbeitsweise:** Wie in [CLAUDE.md](../../CLAUDE.md) «Working agreement»: Sonnet setzt um, frische Opus-Agenten prüfen bis ohne kritischen Befund. Typecheck, `lint:hooks`, Tests und Build müssen grün sein, bevor etwas auf `develop` geht. Ein Commit pro Schritt aus §6. Offene Befunde kommen nach [KNOWN_ISSUES.md](../reference/KNOWN_ISSUES.md).

Das Repo ist öffentlich: keine Shop-Namen, keine Tokens, keine Sicherheitsdetails in Commits, Tests oder Doku.

---

## Ziel

Der Owner will pro Shop sehen, ob und wie die App benutzt wird, und Shops mit unbrauchbarem Zugang sollen das System nicht mehr belasten. Zwei Teile:

- **Teil A — Verbindungszustand:** Ein Shop mit totem Zugang flutet heute die Logs. Ein Shop dieser Art erzeugt in Production mehrere hundert Logzeilen pro Stunde aus Webhooks, die alle mit 401 scheitern. Teil A führt einen klaren Zustand pro Shop ein und nimmt Webhooks solcher Shops an, ohne sie gegen die Admin API zu verarbeiten. Was dabei verpasst wird, holt die App nach einer neuen Anmeldung nach. Veraltete Installationseinträge werden bereinigt, und die Token-Migration wiederholt 403 und 404 nicht endlos.
- **Teil B — Aktivitätsübersicht auf `/admin`:** eine Shop-Tabelle mit Ampel, zuletzt geöffnet, Aktivität der letzten 7 und 30 Tage, Webhooks, Token-Zustand, Installation und Plan, dazu eine Detailansicht pro Shop.

Teil A liefert die Felder, die Teil B anzeigt (§4).

---

## 0. Sofort, vor allem anderen

### 0.1 Wiederholungsflut bei gelöschtem Zugang (verifiziert)

Seit die Token-Migration am 2026-11-08 tote Zugänge leert, wirft `getOfflineAdmin` für diese Shops `OfflineAdminUnavailableError` mit dem Grund `no_token` und der Meldung «Offline session for … has no access token» ([offline-admin.server.ts:194](../../app/utils/offline-admin.server.ts)). Diese Meldung passt nicht auf die 401-Prüfung in [webhook-retry.service.ts:92](../../app/services/webhook-retry.service.ts). Darum plant `scheduleRetry` jetzt für jeden Webhook fünf Wiederholungen ein, und auch die Bereinigung bei Auth-Fehlern greift nicht (Zeilen 303–315). In Production waren es 189 Wiederholungsversuche in 30 Minuten für einen einzigen Shop.

**Fix (Commit 1, allein auslieferbar):** `scheduleRetry` und die Bereinigung in `processRetry` behandeln `code === "OFFLINE_ADMIN_UNAVAILABLE"` (Form prüfen, nicht `instanceof`) wie einen 401. Test: Ein `no_token`-Fehler erzeugt keine `WebhookRetry`-Zeile, eine bestehende Zeile eines solchen Shops wird beim nächsten Versuch gelöscht.

### 0.2 Deinstallation und Redact können mit 500 antworten (Reihenfolge verifiziert, Auswirkung nicht gemessen)

`authenticate.webhook` der Bibliothek prüft zuerst die Signatur und ruft danach `ensureValidOfflineSession` auf (`node_modules/@shopify/shopify-app-react-router/dist/cjs/server/authenticate/webhooks/authenticate.js`, Zeilen 21–38). Mit `SHOPIFY_EXPIRING_OFFLINE_TOKENS` (in Production seit 2026-11-06 an) frischt das bei einem fast abgelaufenen Token auf. Das betrifft jeden Shop, der die App länger als etwa eine Stunde nicht benutzt hat. Bei einer Deinstallation hat Shopify die Tokens aber schon widerrufen. Das Auffrischen scheitert dann, `app/uninstalled` beziehungsweise `shop/redact` antwortet mit 500, und Shopify gibt nach den Wiederholungen auf. So entsteht neuer veralteter Installationsstatus.

**Prüfen (Owner):** Partner Dashboard → App → Webhook-Zustellungen: Gibt es seit 2026-11-06 500er auf `app/uninstalled` oder `shop/redact`? Wenn ja, wird Schritt 5 aus §6 (toleranter Webhook-Auth-Wrapper) dringend und kommt direkt nach Commit 1.

---

## 1. Ist-Zustand (gegen den Code verifiziert)

| Was | Wo | Bedeutung |
|---|---|---|
| Admin-Seite | [admin.tsx](../../app/routes/admin.tsx), etwa 700 Zeilen, Passwort-Login | Zeigt pro Shop nur Zählungen (Produkte, Kollektionen, Artikel, Seiten, Tasks), Installationsstatus, KI-Einstellungen und das DSGVO-Protokoll. |
| Shop-Liste | `loadShopRows`, admin.tsx 139–201 | Die Vereinigung aus Session, ShopInstallState und AISettings ist wiederverwendbar. Danach folgen pro Shop 5 Zählungen plus eine SQL-Summe über Volltexte, also 6N Abfragen. Das muss vor jedem Ausbau weg. |
| DSGVO-Bereich | `loadAuditRows`, admin.tsx 106–137 | Schickt Kunden-E-Mail und vollständigen Export mit jeder Seitenansicht an den Browser (bewusst seit R5-G1). Owner-Entscheid in §7. |
| «Zuletzt geöffnet» | `Session.lastActivityAt`, gesetzt in [activity-tracker.middleware.ts](../../app/middleware/activity-tracker.middleware.ts), aufgerufen aus [shopify.server.ts](../../app/shopify.server.ts) 279–310 | Nicht verlässlich. Abfragen offener Tabs (alle ~2 s) zählen als Aktivität. Der Wert geht bei der Deinstallation mit der Session verloren, und `@default(now())` stempelt neu angelegte Zeilen falsch. Jeder Aufruf ist ein `updateMany` ohne Index auf `shop`. |
| Tasks | `Task` | Werden nach 3 Tagen gelöscht ([sync-scheduler.service.ts](../../app/services/sync-scheduler.service.ts) 588–600). Ein 7- oder 30-Tage-Fenster geht daraus nicht. |
| KI- und Bild-Verbrauch | `AiUsageCounter`, `ImageOperationCounter` | Nur monatlich. `ManagedAiGlobalCounter` ist global, nicht pro Shop. |
| Speichern | — | Wird nirgends erfasst. |
| Webhooks | `WebhookLog`, `WebhookRetry` | Eine Zeile pro Produkt- oder Kollektions-Webhook. Verarbeitete Zeilen werden nach 24 h gelöscht. 401er kommen nie in `WebhookRetry`. |
| Token-Migration | `OfflineTokenMigration`, [offline-token-migration-store.server.ts](../../app/utils/offline-token-migration-store.server.ts) | Status `pending`, `needs_reauth` oder `failed`. Endgültig bei `failed` und 40 Versuchen, etwa 3,7 Tage. Bei Erfolg wird die Zeile gelöscht. Bei `needs_reauth` wird `Session.accessToken` geleert. |
| Installationsstatus | `ShopInstallState` | Kennt `uninstalledAt`, aber keinen Zeitpunkt der Installation oder Anmeldung. Wird durch `redactShopData` gelöscht. |
| 403 heute | [admin-client.server.ts](../../app/utils/admin-client.server.ts) 113–117, offline-admin.server.ts 556–558 | Nur der 403 «Non-expiring access tokens are no longer accepted» löst etwas aus. Andere 403 werden geloggt und weitergeworfen, kein Zugang wird geleert. **Ausnahme:** In der Token-Migration zählt ein 403 als vorübergehender Fehler pro Shop (1169–1176). Ein Ausfall der IP-Liste würde alle Shops in etwa 3,7 Tagen auf «aufgegeben» setzen. |
| Nachholen verpasster Änderungen | `reconcileWebhookBackedTypes` | Läuft nur alle 30 Zyklen bei durchgehender Aktivität. Ein kurzer Besuch nach der neuen Anmeldung holt nichts nach. Dieselbe Lücke besteht bei einer Neuinstallation innerhalb von 48 h. |
| Reaper | `src/services/shop-reaper.service.ts` 111–127 | Löscht über `redactShopData` erst, wenn `uninstalledAt` älter als 30 Tage ist **und** keine Session mehr besteht. Shops mit geleertem Zugang bleiben deshalb unberührt, was richtig ist. |
| DSGVO-Abdeckung | [gdpr.service.ts](../../app/services/gdpr.service.ts) `redactShopData`, Test `gdpr.service.test.ts` 230–275 | Der Test schlägt fehl, wenn ein neues Modell mit `shop`-Feld nicht gelöscht wird. |
| Layout | `/admin` ist nicht eingebettet | Die Breiten-Tokens aus `responsive.css` gelten dort nicht. Die Hydration-Regeln aus CLAUDE.md gelten trotzdem. |

---

## 2. Teil A — Verbindungszustand

### 2.1 Zustand pro Shop

Neue Felder auf `ShopInstallState` (eine additive Migration, alles nullable oder mit Default):

| Feld | Bedeutung |
|---|---|
| `connectionState` | `null` = kein bekanntes Problem. `needs_reauth` = Zugang widerrufen, abgelehnt oder leer; der Händler muss die App öffnen oder neu installieren. `access_denied` = Shop-spezifischer 403 über mindestens 24 h (endgültig). `shop_not_found` = 404 über mindestens 24 h (Shop gelöscht, endgültig). |
| `connectionStateSince`, `connectionStateReason` | Beginn und Grund als Code (`invalid_subject_token`, `admin_api_401`, `no_token`, `refresh_token_expired`, `token_endpoint_403`, `token_endpoint_404`, `backfill_…`). Nie ein Token. |
| `connectionClearedAt`, `connectionClearedCause` | Letzte Aufhebung (`reauth`, `reinstall`, `probe_ok`, `uninstalled`). Dient als Zaun: Ein Fehler aus einem Aufruf, der vor diesem Zeitpunkt begann, darf nicht neu sperren. |
| `resyncRequiredSince`, `droppedWebhookCount` | Seit wann verpasste Änderungen nachzuholen sind und wie viele Webhooks angenommen, aber nicht verarbeitet wurden. |
| `lastWebhookAt` | `X-Shopify-Triggered-At` des letzten Webhooks mit gültiger Signatur, höchstens alle 10 min geschrieben. Beleg für «installiert». |
| `lastProbeAt` | Letzte Probe einer 401-Sperre. |
| `uninstallSource`, `reinstallEvidenceAt` | Woher `uninstalledAt` stammt (`webhook`, `operator`, `stale_auto`), und ob danach noch Webhooks kamen. |
| `lastApiOkAt` (optional) | Letzter erfolgreicher Admin-API-Aufruf, höchstens einmal pro Stunde geschrieben. |

Auf `OfflineTokenMigration`: `failureKind` (`transient`, `forbidden`, `not_found`) und `failureKindSince`. Die bestehende Regel «endgültig bei `failed` und 40 Versuchen» bleibt, damit alle bisherigen Prüfungen unverändert funktionieren.

Neues Modul `app/utils/shop-connection-state.server.ts` als einzige Tür:
- `getConnectionBlock(shop)`, mit Cache von 30 s im Prozess (eine Instanz laut RAILWAY-SETUP).
- `markConnectionBlocked(shop, state, reason, { observedAt })` und `clearConnectionBlock(shop, cause)`. Beide wirken nur beim Zustandswechsel und loggen genau einmal. Abgesichert ist das in der Datenbank durch ein bedingtes `updateMany`, auch über Neustarts hinweg.
- `noteDroppedWebhook`, `recordWebhookSeen`, `invalidateConnectionCache`.
- `ShopConnectionBlockedError` (`code = "SHOP_CONNECTION_BLOCKED"`); die Meldung enthält «401», damit bestehende Prüfungen weiter greifen.

Reines Lesemodell `app/services/shop-connection-status.shared.ts` mit `deriveConnectionStatus`. Die erste zutreffende Regel gilt: `uninstalled`, `shop_not_found` oder `access_denied`, `needs_reauth`, `migration_gave_up`, `failing_transiently`, `valid_expiring`, `valid_non_expiring`, `no_session`. Dazu `presumedUninstalled`: gesperrt seit mindestens 30 Tagen (7 bei `shop_not_found`), ohne Webhook und ohne Besuch seit Beginn der Sperre.

### 2.2 Sperren

- **Migration meldet `needs_reauth`** (offline-admin.server.ts 1087–1094, 1144–1156): markieren, aber nur, wenn der Zugang geleert wurde oder seit Beginn des Laufs keine neue Anmeldung kam.
- **Zweiter 401 mit demselben gespeicherten Zugang**, sowohl im Raw-Client (admin-client.server.ts 127–133) als auch im Library-Client (offline-admin.server.ts 560–566): `needs_reauth` mit Grund `admin_api_401`. Die BLOCKED-Zeile ersetzt das bisherige Fehler-Log.
- **`no_token` beim Holen des Zugangs:** sperren. `refresh_failed` sperrt **nur**, wenn `refreshTokenExpires` vorbei ist oder der Fehler unverpackt `invalid_subject_token` lautet. Nie beim verpackten 500er, denn dahinter kann die IP-Liste stecken.
- **Schutz vor Massen-401:** Haben mindestens 3 verschiedene Shops innerhalb von 10 min einen 401, entsteht eine einzige laute Zeile `MASS_401`, und eine Stunde lang werden keine neuen 401-Sperren gesetzt.
- **Ist ein Shop gesperrt,** wirft `createAdminClientFromShop` sofort `ShopConnectionBlockedError`. Hintergrunddienste machen dann keinen Shopify-Aufruf mehr. Anfragen aus der App selbst bleiben ungesperrt, weil sie über `authenticate.admin` laufen. So kommt der Händler beim Öffnen immer zum Token-Austausch.

### 2.3 Webhooks

- Neu: `app/utils/webhook-auth.server.ts` mit `authenticateWebhookTolerant`. Fehler bei der Signaturprüfung (400, 401, 405) werden weitergeworfen. Jeder spätere Fehler stammt aus dem Auffrischen nach gültiger Signatur. In diesem Fall arbeitet der Wrapper mit den Kopfzeilen (`X-Shopify-Shop-Domain`, `-Topic`, `-Triggered-At`) weiter. Er hängt an der Reihenfolge in der Bibliothek, deshalb gibt es einen Kommentar und einen Test, der beim Update der Bibliothek erneut zu prüfen ist.
- Den Wrapper verwenden `webhooks.app-uninstalled.tsx` und `webhooks.compliance.tsx`, damit Deinstallation und Redact immer durchlaufen (§0.2), sowie `webhooks.products.tsx`, `webhooks.collections.tsx` und `webhooks.subscription.tsx`.
- **Webhook eines gesperrten Shops:** Er wird mit 200 bestätigt. Löschungen werden lokal ausgeführt, weil sie nur die Datenbank betreffen. Erstellen und Ändern zählen nur `droppedWebhookCount` hoch und setzen `resyncRequiredSince`. Es gibt dann keinen Admin-API-Aufruf, keine Wiederholung und kein Fehler-Log, nur `debug`.
- **`webhook-retry.service.ts`:** Für gesperrte Shops werden keine neuen Zeilen angelegt, und bestehende Zeilen werden beim Versuch gelöscht. Die Bereinigung bei Auth-Fehlern erkennt auch die beiden neuen Fehlercodes.

### 2.4 Aufheben und Nachholen

- **`afterAuth`** (shopify.server.ts 147–211): `clearConnectionBlock(shop, wasUninstalled ? "reinstall" : "reauth")`, mit genau einer Zeile UNBLOCKED samt Zahl der verpassten Webhooks. Als exportierte Hilfsfunktion, damit sie testbar ist.
- **Deinstallation:** Der Inhalt von `webhooks.app-uninstalled.tsx` wird nach `app/services/shop-uninstall.server.ts` ausgelagert (`markShopUninstalled(shop, { source })`). Die Funktion hebt zusätzlich die Sperre auf und setzt `resyncRequiredSince`. Das schliesst die 48-h-Lücke bei einer Neuinstallation.
- **Redact:** `invalidateConnectionCache` nach der Transaktion. Die Felder verschwinden mit der Zeile.
- **Nachholen:** Im Scheduler läuft vor der Inaktivitätsprüfung einmal `reconcileWebhookBackedTypes`, wenn `initialSyncCompletedAt` und `resyncRequiredSince` gesetzt sind und der Shop nicht gesperrt ist.
  - `reconcileWebhookBackedTypes` meldet dafür künftig pro Typ ein `ok`.
  - Das Flag wird nur aufgehoben, wenn alles `ok` ist. Das Aufheben erfolgt als Vergleichen-und-Löschen, damit ein Webhook, der während des Nachholens wegfällt, das Flag stehen lässt.
  - Pro Shop läuft höchstens ein solcher Lauf gleichzeitig.
  - Die Erstsynchronisation hebt das Flag ebenfalls auf.

### 2.5 403, IP-Liste und begrenzte Wiederholung

- Neu: `app/utils/shopify-forbidden.server.ts` mit `classifyForbidden`. Ergebnisse: `non_expiring_rejected` (die bestehende Erkennung), `ip_allowlist` (der Text verweist auf IP oder Allowlist), `ip_allowlist_suspected` (mehrere Shops bekommen 403, und es gab seit 10 min keinen Erfolg bei einem anderen Shop) oder `shop_specific`.
- **Ein 403 sperrt nie einen Shop und leert nie einen Zugang.** Bei einem Verdacht auf die IP-Liste gibt es eine laute Zeile `[ShopifyIP] IP_ALLOWLIST_403`, höchstens alle 5 min. Sie verweist auf den Hinweis zur IP-Liste in CLAUDE.md. Dazu kommt eine Ops-Meldung höchstens einmal pro Stunde.
- **Token-Migration:**
  - 404 setzt `failureKind = not_found`.
  - Ein Shop-spezifischer 403 setzt `forbidden`.
  - Pro Lauf gibt es dann nur einen Versuch. Endgültig ist der Shop bei gleicher Fehlerart seit mindestens 24 h und mindestens 3 Läufen. Danach folgt eine Zeile `MIGRATION_GAVE_UP` und die Sperre `shop_not_found` beziehungsweise `access_denied`.
  - Ein 403 mit Verdacht auf die IP-Liste setzt eine globale Pause von 30 min, ohne Versuche zu zählen.
  - `healIfMigrationCannotRun` aktiviert solche Datensätze nie wieder.

### 2.6 Verbindungs-Sweep

Neu: `app/services/shop-connection-sweep.service.ts`, alle 10 min, unabhängig von den Token-Schaltern.

1. **Einmaliges Nachtragen, idempotent und über eine Env-Variable abschaltbar:**
   - `needs_reauth`-Datensätze und Sessions mit leerem Zugang werden zu `needs_reauth`.
   - Datensätze mit 404 bekommen `failureKind = not_found`.
   - 403-Datensätze bleiben unberührt, denn sie könnten von der IP-Liste stammen.
   - Keine Datenbank-Eingriffe von Hand.
2. **Probe:** Für 401-Sperren gibt es alle 6 h einen `{ shop { id } }`-Aufruf. Ein 2xx hebt die Sperre auf, danach folgt das Nachholen.
3. **Tageszusammenfassung:** eine Zeile mit allen gesperrten Shops.
4. **Nachholen** für entsperrte Shops ohne laufenden Scheduler.
5. **Auswertung «vermutlich deinstalliert»:** nur lesend.

### 2.7 Veralteter Installationsstatus

- **Belege für «installiert»:** ein Webhook mit gültiger Signatur (nach Shopifys `triggeredAt`), ein authentifizierter Besuch oder ein erfolgreicher API-Aufruf.
- **Belege dagegen:** ein 404 ist ein starker Beleg. `invalid_subject_token` oder ein 401 ist ein schwacher Beleg, weil Deinstallation, Neuinstallation ohne Öffnen und Widerruf gleich aussehen.
- **Webhook nach der Deinstallation** (mindestens 5 min nach `uninstalledAt`): Er setzt `reinstallEvidenceAt` und hebt `uninstalledAt` auf. Ohne Session folgt die Sperre `needs_reauth`. Es gibt genau eine Zeile `REINSTALL_EVIDENCE`. Der Reaper überspringt Shops mit `lastWebhookAt > uninstalledAt`.
- **Als deinstalliert markieren:** immer über `markShopUninstalled`, also dasselbe wie der Webhook. Danach löscht der bestehende Reaper nach 30 Tagen über `redactShopData`. Es gibt keinen neuen Löschcode.
  - Standard ist ein Operator-Skript `scripts/mark-stale-uninstalled.ts --shop … --confirm`. Es verweigert, wenn der Shop nicht `presumedUninstalled` ist, zeigt die Belege und schreibt einen Audit-Eintrag.
  - Optional automatisch: `STALE_INSTALL_AUTO_MARK=true` nach 90 Tagen (14 bei 404), standardmässig aus.
- **Partner API:** jetzt nicht. Sie bräuchte einen neuen Zugang auf Organisationsebene. Die wenigen betroffenen Shops prüft der Owner einmal von Hand im Partner Dashboard.
- **DSGVO:**
  - Die Daten eines möglicherweise installierten Händlers zu behalten, ist zulässig.
  - Keine Verarbeitung während einer Sperre entspricht der Speicher- und Zweckbegrenzung.
  - Tote Zugänge früh zu löschen, ist zulässig und erwünscht.
  - Löschen auf ein einzelnes schwaches Signal hin ist nicht zulässig.
  - Das DSGVO-Protokoll behält seine 3 Jahre.
  - Die Fristen gehören in die Datenschutzerklärung (Owner, §7).

---

## 3. Teil B — Aktivitätsübersicht auf `/admin`

### 3.1 Vorher: Login härten

Bevor die Seite mehr zeigt, muss der Admin-Login gehärtet werden. Die konkreten Punkte liegen beim Owner und stehen bewusst nicht in diesem öffentlichen Repo. Ein Test deckt jeden Punkt ab.

### 3.2 Neue Daten

- **`ShopInstallState`:**
  - `lastActivityAt` wird zum dauerhaften Wert für «zuletzt geöffnet» und höchstens einmal pro 5 min geschrieben. Ein einmaliger Nachtrag kommt aus `Session`; er ist ungenau und wird so beschriftet.
  - `lastActionAt` und `lastActionArea`: Pfadbereich der letzten Anfrage, die kein GET war, zum Beispiel `app.products`. Nur der Pfad, nie die Query.
  - `lastAuthAt` wird in `afterAuth` gesetzt.
- **Neues Modell `ShopUsageDay`** (`shop`, `day` als UTC-Datum, `activeSlots`, `actions`, `tasksStarted`, `tasksFailed`, `aiCostMicros`, `aiTokens`; unique auf `shop` und `day`):
  - `trackActivity` zählt aktive 5-Minuten-Fenster ohne Polling-Pfade sowie Aktionen, also Anfragen ohne GET, höchstens einmal pro Request. Ein einziger Einhängepunkt statt 51 Aufrufstellen.
  - Ein stündlicher Rollup in `runDatabaseCleanup` überträgt die Tasks von heute, gestern und vorgestern, idempotent. Er läuft vor dem Löschen der Tasks und überschreibt die Zählungen von `trackActivity` nie.
  - Aufbewahrung 90 Tage. `redactShopData` löscht das Modell, der Abdeckungstest erzwingt das.
- **Indexe:** `WebhookLog` auf `shop` und `createdAt`. Optional `Session` auf `shop`, weil `trackActivity` heute bei jeder Anfrage die Tabelle durchsucht.
- **Datenschutz:** Die Seite enthält nie Tokens, verschlüsselte Werte, personenbezogene Daten aus der Session, `*ApiKey`, Webhook-Inhalte, Task-Prompt, -Ergebnis oder -Titel.

### 3.3 Loader

Er wird nach `app/services/admin/shop-overview.server.ts` ausgelagert. Die etwa 16 Abfragen laufen parallel, keine davon pro Shop:
- die Shop-Vereinigung, ergänzt um Shops, die nur im `WebhookLog` vorkommen;
- Session-Felder über eine schmale SQL-Abfrage (`expires`, `refreshTokenExpires`, «Zugang leer», «Refresh vorhanden») und nie den Token selbst;
- Migrationsdaten ohne die verschlüsselten Felder;
- Webhook-Zählungen der letzten 24 h, gruppiert;
- `WebhookRetry`;
- `ShopUsageDay` der letzten 30 Tage;
- KI und Bilder für diesen und den letzten Monat;
- die letzte Task pro Shop;
- die Inhaltszählungen per `groupBy`;
- `ManagedAiGlobalCounter`;
- die Felder aus Teil A.

Der Speicherverbrauch in MB wandert in die Detailansicht. Geschätzt liegt das bei unter 1 s für einige hundert Shops, gegenüber heute über 1800 Abfragen. Gemessen ist das nicht.

### 3.4 Ampel

Eine reine Funktion `computeShopStatus(input, now)` in `app/services/admin/shop-status.shared.ts` liefert Farbe, Token-Zustand und Gründe. Die Gründe stehen auf Deutsch im Tooltip und in der Detailansicht. Geprüft wird in dieser Reihenfolge:

- **Grau:** deinstalliert, ohne Webhook in 24 h und nicht `reinstallEvidenceAt`.
- **Rot:**
  - deinstalliert laut Datenbank, aber Webhooks kommen noch;
  - installiert laut Datenbank, aber `presumedUninstalled` oder `shop_not_found`;
  - ein unbrauchbarer Zugang aus `connectionState` oder dem Session-Zustand;
  - mindestens 10 Webhook-Fehler in 24 h bei mindestens 50 %;
  - ein Shop, der nur im `WebhookLog` vorkommt.
- **Gelb:**
  - länger als 14 Tage nicht geöffnet;
  - Refresh-Token läuft in weniger als 14 Tagen ab;
  - Migration länger als 24 h hängig;
  - noch nicht umgestellter Zugang ab 2026-12-01;
  - einzelne Webhook-Fehler;
  - Erstsynchronisation nicht abgeschlossen.
- **Grün:** alles andere, also in den letzten 14 Tagen geöffnet und mit brauchbarem Zugang.

Ein roter Shop mit `presumedUninstalled` bekommt zusätzlich den Hinweis «vermutlich deinstalliert, Abgleich ausstehend». Sortiert wird nach Rot, Gelb, Grün, Grau, darin nach «zuletzt geöffnet».

### 3.5 Oberfläche

- **Styles:** `TD`, `TH`, `PAGE` und die Farben wandern in `app/components/admin/admin-styles.ts`. Dort steht auch jede Breite der Admin-Seite. Die Tabelle nutzt die volle Breite.
- **Kopfbereich:**
  - Zähler pro Ampelfarbe, die zugleich als Filter dienen;
  - Webhooks der letzten 24 h;
  - Ausgaben für Managed AI in diesem Monat;
  - Suche nach Shop-Domain;
  - Schalter «nur installiert», «nur bezahlt» und «nur Token-Problem».
  - Filter und Sortierung bleiben im Client, damit der Loader nicht neu läuft.
- **Spalten:**
  - Status als Punkt plus Text, nie nur Farbe;
  - Shop;
  - Installation;
  - zuletzt geöffnet;
  - aktive Tage 7/30;
  - Aktionen 7/30;
  - Tasks 7/30 mit Fehlern;
  - KI im Monat;
  - Bilder im Monat;
  - Webhooks 24 h;
  - Token;
  - Plan;
  - Inhalte;
  - Aktionen («Details», «Alle Daten löschen…»).
- **Hydration:**
  - Relative Zeiten werden gegen das `now` des Loaders berechnet, nie gegen `Date.now()` im Render.
  - Sortiert wird mit `<`, nicht mit `localeCompare` ohne Locale.
- **Detailansicht:**
  - Sie klappt als Zeile unter dem Shop auf und wird per `useFetcher` über `GET /admin?detail=<shop>` geladen, ohne neue Route.
  - Inhalt:
    - Gründe;
    - Token- und Installationsfakten;
    - 30-Tage-Balken als einfache CSS-Kästchen;
    - Speicherverbrauch;
    - eine Zeitleiste mit höchstens 100 Einträgen aus Aktivität, Tasks, Webhook-Fehlern pro Stunde, Migration, Installation, Anmeldung, KI-Einwilligung und DSGVO-Ereignissen.
  - Fehlertexte werden auf 160 Zeichen gekürzt, tokenähnliche Zeichenfolgen maskiert.

---

## 4. Schnittstelle zwischen Teil A und Teil B

| Teil B braucht | Kommt aus Teil A |
|---|---|
| «Zugang abgelehnt seit» | `connectionState` und `connectionStateSince`, Grund in `connectionStateReason` |
| Installationsurteil | `uninstalledAt`, `uninstallSource`, `reinstallEvidenceAt`, `lastWebhookAt`, `presumedUninstalled` (aus `deriveConnectionStatus`) |
| «Webhooks pausiert» | `connectionState` ≠ `null` plus `droppedWebhookCount` und `resyncRequiredSince` |
| Migration | `OfflineTokenMigration` samt `failureKind` |

Zwei Abstimmungen:
- `presumedUninstalled` verwendet das dauerhafte `ShopInstallState.lastActivityAt` aus Teil B, nicht `Session.lastActivityAt`. Darum kommt der Writer aus Teil B (Schritt 9) vor der Auswertung «vermutlich deinstalliert» (Schritt 12).
- Webhooks gesperrter Shops schreiben keine `WebhookLog`-Zeile, sie werden nur gezählt (Owner-Entscheid in §7). Die Ampel stützt sich für «Zugang unbrauchbar» deshalb auf `connectionState` und nicht auf die Fehlerzahl im `WebhookLog`.

Alle neuen Felder liegen auf `ShopInstallState` beziehungsweise `OfflineTokenMigration`, die Übersicht braucht also keine zusätzliche Abfrage. Fehlt ein Wert, gilt er als «unbekannt».

---

## 5. Tests (Vitest, `tests/unit/`)

**Teil A**
- **Zustandsmodul:**
  - Sperren und Aufheben loggen genau einmal.
  - Der Zaun `observedAt < connectionClearedAt` verhindert ein erneutes Sperren.
  - Der Cache wird bei Sperre, Aufhebung und Redact aktualisiert.
- **Toter Zugang und viele Webhooks:**
  - Der erste Webhook erzeugt 2 `fetch`-Aufrufe und genau eine BLOCKED-Zeile.
  - Die nächsten 50 Webhooks erzeugen 0 `fetch`, kein `error` oder `warn` und keine `WebhookRetry`-Zeile; alle antworten 200.
  - Der Zähler steigt, `resyncRequiredSince` ist gesetzt.
  - Eine Löschung läuft lokal.
  - Dasselbe für Kollektionen.
- **Retry:** Ein `no_token`-Fehler erzeugt keine Zeile (Regression zu §0.1). Bestehende Zeilen eines gesperrten Shops werden gelöscht.
- **Aufheben und Nachholen:**
  - `afterAuth` hebt die Sperre auf und behält `resyncRequiredSince`.
  - Das Nachholen läuft genau einmal und hebt das Flag auf.
  - Ein Webhook, der während des Nachholens wegfällt, lässt das Flag stehen; ebenso ein fehlgeschlagener Typ.
- **Deinstallation:**
  - Hebt die Sperre auf und setzt `uninstallSource`.
  - Wirft `authenticate.webhook` einen 500, läuft die Bereinigung trotzdem und antwortet 200. Ein 401 der Signaturprüfung bleibt 401.
- **403:**
  - Ein 403 mit IP-Text, allgemeinem Text oder Scope-Text sperrt nie und speichert keine Session.
  - `IP_ALLOWLIST_403` wird gedrosselt geloggt.
  - `healIfMigrationCannotRun` leert bei einem anderen 403 nichts.
- **Begrenzte Wiederholung:**
  - 404 gibt einen Versuch pro Lauf und wird nach mindestens 3 Läufen und 24 h endgültig, mit `shop_not_found`.
  - Ein Shop-spezifischer 403 verhält sich gleich, mit `access_denied`.
  - Bei Verdacht auf die IP-Liste gibt es nur eine globale Pause.
  - Ein 5xx folgt dem alten 40er-Weg.
- **Sweep:** Das Nachtragen ist idempotent. Eine Probe mit 2xx hebt die Sperre auf.
- **Reaper und Neuinstallation:**
  - Bei `lastWebhookAt > uninstalledAt` überspringt der Reaper den Shop.
  - `REINSTALL_EVIDENCE` hebt `uninstalledAt` auf.
- **Lesemodell:** Reihenfolge und Fenster von `presumedUninstalled`.

**Teil B**
- **Login:** ein Test pro Härtungspunkt.
- **Ampel:** tabellengesteuert, ein Fall pro Regel. Eingeschlossen sind der Fall «installiert, Zugang abgelehnt» (rot), «vermutlich deinstalliert», ein veraltetes `uninstalledAt` mit Webhooks, Grau, Gelb nach 14 Tagen sowie die Daten 2026-12-01 und 2027-01-01.
- **Loader:**
  - **Die Zahl der Abfragen ist bei 1 und bei 200 Shops gleich.**
  - Shops, die nur im `WebhookLog` vorkommen, sind dabei.
  - **Datenschutz:** Jede sensible Spalte der Testdaten trägt einen Wächtertext. Weder `JSON.stringify(loaderData)` noch die Detaildaten dürfen einen davon enthalten, und nichts darf auf `shp[a-z]{2}_` passen.
- **`trackActivity`:**
  - Höchstens ein Schreibvorgang pro 5 min.
  - Polling zählt nicht als Fenster.
  - Eine Aktion zählt einmal pro Request.
  - Nur der Pfad wird gespeichert.
  - Die Funktion wirft nie.
- **Rollup:**
  - Idempotent.
  - Überschreibt die Zählungen von `trackActivity` nie.
  - Läuft vor dem Löschen der Tasks.
  - Entfernt Zeilen nach 90 Tagen.
- **DSGVO:** `shopUsageDay` wird beim Redact gelöscht.
- **Hydration:** Die Tabelle wird auf Server und Client in zwei Zeitzonen gerendert und muss gleich aussehen. Die Zeitzone wird gesetzt, nie durch Löschen von `TZ` zurückgestellt.

---

## 6. Reihenfolge der Commits

Jeder Schritt ist für sich prüfbar.

1. **Hotfix §0.1:** `OFFLINE_ADMIN_UNAVAILABLE` behandeln wie einen 401. Sofort auslieferbar.
2. **Login härten** (§3.1).
3. **Admin-Loader auslagern**, die N+1-Abfragen durch `groupBy` ersetzen und den Speicherverbrauch in die Detailansicht verschieben, ohne neue Daten. Test: Zahl der Abfragen.
4. **Eine Schema-Migration für beide Teile:**
   - die Felder aus §2.1 auf `ShopInstallState` und `OfflineTokenMigration`;
   - `lastActivityAt`, `lastActionAt`, `lastActionArea` und `lastAuthAt` samt Nachtrag;
   - `ShopUsageDay`, die Indexe und das Löschen in `redactShopData`.
5. **Toleranter Webhook-Auth-Wrapper** für Deinstallation und Redact (§2.3, erster Teil). Wenn der Owner unter §0.2 500er findet, kommt dieser Schritt direkt nach 1.
6. **Zustandsmodul und Lesemodell**, noch nicht verdrahtet (§2.1).
7. **Sperren und die Sperre in `createAdminClientFromShop`** (§2.2).
8. **Webhook-Routen und Retry-Dienst** mit der Sperre (§2.3).
9. **Writer für Teil B:** `trackActivity` und `lastAuthAt` in `afterAuth` (§3.2).
10. **Aufheben und Nachholen** (§2.4).
11. **403-Einordnung, IP-Liste und begrenzte Wiederholung** (§2.5).
12. **Verbindungs-Sweep:** Nachtragen, Probe, Zusammenfassung, Nachholen (§2.6).
13. **Veralteter Installationsstatus:** `REINSTALL_EVIDENCE`, Schutz im Reaper, `presumedUninstalled`, Operator-Skript und optionales automatisches Markieren (§2.7).
14. **Rollup und Aufbewahrung** von `ShopUsageDay` (§3.2).
15. **Ampel-Modul** (§3.4).
16. **Loader-Ausbau mit Datenschutztest** (§3.3).
17. **Tabelle** mit Ampel, Sortierung, Filtern und Kopfbereich (§3.5).
18. **Detailansicht** (§3.5).
19. **Doku:**
    - CLAUDE.md «Auth / boundaries» zu Sperre, Zaun, 403-Regel und tolerantem Webhook-Wrapper, dazu ein Hinweis auf die Datenquellen von `/admin`;
    - RAILWAY-SETUP mit Logzeilen, Operator-Skript und Env-Variablen;
    - KNOWN_ISSUES für Reste.

    Keine Änderung an der Anleitung für Händler, für sie ändert sich nichts Sichtbares.

---

## 7. Offene Fragen an den Owner

1. **Partner Dashboard:**
   - Gibt es seit 2026-11-06 500er auf `app/uninstalled` oder `shop/redact` (§0.2)?
   - Wie sieht die Installationsgeschichte der Shops mit «muss sich neu anmelden» aus?
   - Warum ist der Zugang des installierten Shops seit 2026-11-05 ungültig?
2. **DSGVO-Bereich auf `/admin`:** Kunden-E-Mail und Exporte nur auf Abruf laden? Empfohlen.
3. **Schwellen:**
   - Gelb nach 14 Tagen.
   - Rot ab 10 Fehlern und 50 %.
   - Aufbewahrung von `ShopUsageDay` 90 Tage.
   - «Vermutlich deinstalliert» nach 30 Tagen (7 bei 404).
   - Automatisches Markieren nach 90 Tagen (14 bei 404), standardmässig aus.
4. **Rechtliches:** Freigabe der Fristen und eines Satzes zu Nutzungsstatistiken auf Shop-Ebene (ohne personenbezogene Daten) in der Datenschutzerklärung.
5. **Discord-Meldungen:** auch bei jeder Sperre, oder nur bei IP-Liste und Massen-401?
6. **Webhooks gesperrter Shops:** nur zählen (empfohlen) oder weiter eine `WebhookLog`-Zeile schreiben?
7. **Partner API:** Ist «jetzt nicht, die wenigen Shops von Hand prüfen» in Ordnung?
8. **«Zuletzt geöffnet»:** Ein offener, ungenutzter Tab zählt als geöffnet. Die aktiven Fenster schliessen Polling aus, Navigationen zählen aber. Reicht das?

---

## 8. Risiken

- **Eine falsche Sperre lässt Webhooks fallen.** Abgefedert durch Nachholen bei jeder Aufhebung, die 6-stündliche Probe, den Schutz vor Massen-401 und den Zaun.
- **Der tolerante Wrapper hängt an der Reihenfolge in der Bibliothek.** Kommentar und Test; beim Update der Bibliothek erneut prüfen.
- **Die IP-Heuristik kann bei nur einem aktiven Shop falsch liegen.** Sie irrt dann in Richtung globale Pause, also in die sichere Richtung.
- **Das Markieren als deinstalliert führt über den Reaper zum Löschen von Daten.** Darum nur über das Operator-Skript mit Belegen, automatisch nur auf ausdrücklichen Wunsch.
- **Der Nachtrag von `lastActivityAt` ist ungenau.** Er wird so beschriftet.
- **Ein Rollup kurz nach einem Redact kann verwaiste `ShopUsageDay`-Zeilen hinterlassen.** Sie verschwinden nach 90 Tagen; der Rollup filtert auf bekannte Shops.
