# Railway Development & Production Setup

## Übersicht
Dieses Projekt nutzt zwei Railway Environments für eine saubere Trennung:
- **Production**: Läuft auf dem `master` Branch
- **Development**: Läuft auf dem `develop` Branch

## 0. Service-Einstellungen — `.railway/railway.ts`

Die Service-Einstellungen leben auf Railway selbst. Die Datei
[.railway/railway.ts](.railway/railway.ts) (Railway „Infrastructure as Code“)
dokumentiert sie versioniert. Railway liest sie beim Deploy **nicht**; sie wirkt
nur, wenn sie pro Environment angewendet wird. Die früheren Config-as-Code-Dateien
(`railway.json`, `railway.dbbackup.json`, `railway.dbalert.json`) liest Railway ab
2026-12-01 nicht mehr und sie sind entfernt.

Änderung anwenden (aus `.railway/`, nach `npm ci` dort), je Environment:

```
railway config plan  --environment <env>
railway config apply --environment <env>
```

Die Datei wählt über `ctx.environment` aus: `production` → Branch `master`,
`Development` → Branch `develop`. Variablen verwaltet die Datei nicht. Unter
Windows ruft das SDK `railway --version` ohne Shell auf; dafür muss die
Umgebungsvariable `_` auf die echte `railway.exe` zeigen
(`npm
ode_modules\@railway\cliinailway.exe`).

| Service | Ressource in `railway.ts` | Inhalt |
|---|---|---|
| Web (production **und** development) | `Contentpilot` | Dockerfile-Builder, `npm run start:production`, Healthcheck `/health` (Timeout 900 s, damit ein langer Index-Build beim Start nicht abgebrochen wird), `drainingSeconds` 15, Neustart bei Fehler `ON_FAILURE`, höchstens 10-mal (siehe unten) |
| Db Space Checker (Cron, nur production) | `Db Space Checker` | Dockerfile-Builder, `node scripts/db-alert.mjs`, alle 15 Min, kein Restart |
| Db Backup (Cron, production **und** development) | `Db Backup` | Dockerfile-Builder, `node scripts/db-backup.mjs`, täglich 02:00 UTC, kein Restart |

**Neustart-Regel des Web-Services (`restartPolicyType: ON_FAILURE`, `restartPolicyMaxRetries: 10`).** Das ist
Railways Standard; er bleibt in `railway.ts` bewusst implizit (Railway speichert den Standard als „nicht gesetzt“ und würde sonst dauerhaft einen Unterschied zeigen). Ein niedrigerer
Wert wurde erwogen und verworfen: Der Zähler gilt auch für Abstürze im **laufenden Betrieb** (z. B. Speichermangel), und
wann Railway ihn nach einem gesunden Lauf zurücksetzt, ist nicht gemessen. Ein kleiner Wert könnte die Produktion nach
einer Absturzserie dauerhaft stehen lassen. Gewonnen wäre wenig: Ein fehlgeschlagenes Deploy ersetzt den alten Container
nie (er läuft weiter) und ist durch das Healthcheck-Timeout von 900 s ohnehin begrenzt. Das betrifft auch den Fall aus der
Migrationsprüfung: Baut ein anderer Container gerade einen Index dieses Images, gilt er als ungültig, der Start bricht ab
und der Neustart prüft erneut. Die beiden Cron-Services behalten `NEVER`.

Beide Web-Environments sind bis auf Branch und Domain gleich konfiguriert; Abweichungen
gehören in `railway.ts` (Verzweigung über `ctx.environment`), nicht nur ins Dashboard.

**Alle vier Services bauen mit dem [Dockerfile](Dockerfile).** Der `CMD` darin
(`npm run start`, **ohne** Migrationen) wird vom `startCommand` oben überschrieben —
der Dockerfile ist also nicht die Antwort darauf, wie die App startet.

Früher lagen hier zusätzlich ein `Procfile` und eine `nixpacks.toml`, die einen
Build-Pfad beschrieben, den Railway nie genommen hat. Beide sind gelöscht: drei
Dateien mit drei verschiedenen Start-Befehlen, von denen keine galt, haben
nachweislich zu falschen Annahmen geführt. Neue Deploy-Einstellungen gehören in
die Config-Dateien oben, nicht in eine weitere Parallelquelle.

Der Cron-Service hat im Dashboard zusätzlich ein *Custom Build Command*
(`npm ci && npx prisma generate`). Das steht bewusst nicht in der Config-Datei:
unter dem Dockerfile-Builder bestimmt der Dockerfile den Build, und der führt
`npm ci` und `npx prisma generate` ohnehin selbst aus. Der Eintrag im Dashboard
ist also im besten Fall redundant und kann geleert werden.

**Achtung: was die Datei überschreibt.** Jedes Feld, das hier steht, sticht den
Dashboard-Wert. Felder, die *nicht* hier stehen (z. B. Restart-Policy des Web-Service,
Replicas, Region), bleiben Dashboard-Sache. Beim Ergänzen also immer erst den
Ist-Wert im Dashboard ablesen, sonst ändert der nächste Deploy stillschweigend
das Laufzeitverhalten.

**Was NICHT hier hineinkann** und darum weiterhin nur im Dashboard existiert:
Environment-Variablen und Secrets, die Postgres-Datenbank, Volumes und deren Größe,
Domains, sowie die Branch-Zuordnung eines Environments.

### Der Web-Service läuft mit EINER Instanz — das ist eine Zusage, keine Einstellung

`Replicas` steht oben in der Liste der Dashboard-Werte, und bei genau diesem
Feld ist das Schweigen der Config-Datei gefährlich: **Production läuft heute
mit einer einzigen Web-Instanz, und mehrere Teile der App sind darauf
angewiesen.** Wer die Zahl im Dashboard erhöht, bekommt keine Fehlermeldung —
sondern doppelte Arbeit, doppelte Kosten und gelegentlich eine überschriebene
Übersetzung.

Vier Zustände leben **im Prozess**, nicht in der Datenbank (mit Managed AI
kommt der Breaker als fünfter dazu — siehe unten):

| Was | Wo | Was bei zwei Instanzen passiert |
|---|---|---|
| AI-Queue: Singleton, Concurrency-Deckel, Rate-Limit-Fenster pro Provider | [src/services/ai-queue.service.ts](src/services/ai-queue.service.ts) | jede Instanz hält ihr eigenes Fenster und ihren eigenen `AI_QUEUE_CONCURRENCY`-Deckel → gegen dasselbe Provider-Limit läuft doppelt so viel, die Folge sind 429er statt eines sauberen Wartens |
| „Merchant hat gerade gespeichert" (`recentSaves`) | [app/utils/translation-save-lock.server.ts](app/utils/translation-save-lock.server.ts) | der Schutz gilt nur in dem Prozess, der den Save bekam. Ein Webhook auf der anderen Instanz sieht die Markierung nicht und überschreibt die frisch gespeicherte Übersetzung mit dem, was Shopify wegen Eventual Consistency gerade noch liefert — **echter Datenverlust**, genau der Fall, für den das Modul existiert |
| Deduplizierung der detached Re-Translation-Läufe (`retranslationsInFlight`) | [app/services/translations/stale-translation-sync.server.ts](app/services/translations/stale-translation-sync.server.ts) | derselbe Lauf startet zweimal: jede Sprache wird doppelt übersetzt und doppelt registriert — auf dem KI-Key des Merchants auch doppelt bezahlt |
| Fünf `setInterval`-Sweeps (Audit, Crawl, Translation-Drift, llms.txt, IndexNow) | gestartet in [app/shopify.server.ts](app/shopify.server.ts) | sie laufen pro Prozess. Der DB-Stempel (`lastAutoRunAt` & Co.) fängt das meiste ab, aber nicht alles: zwischen „Shop als fällig lesen" und „Stempel schreiben" liegt ein Fenster, in dem beide Instanzen denselben Shop greifen |

Dazu kommt eine **Seriensperre pro Produkt**
([app/utils/keyed-serial-lock.server.ts](app/utils/keyed-serial-lock.server.ts)):
`savePrimarySubResources` (Optionen und Metafelder eines Produkts) läuft pro
Shop+Produkt nacheinander, weil der Browser einen Request aufgeben kann
(Zeitlimit, Verbindungsabbruch), den der Server noch abarbeitet, und ein älteres
`metafieldsSet` sonst nach dem neueren landen könnte. Die Sperre ist
prozesslokal und ihre Wartezeit auf 5 Minuten begrenzt: mit einer zweiten Instanz
(oder im kurzen Deploy-Overlap) fällt sie auf das alte Verhalten zurück, sie
blockiert nie dauerhaft.

Ehrlichkeitshalber die Gegenliste — **nicht** betroffen ist alles, was seinen
Zustand in Postgres hält: die Single-Flight-Logik des Crawls samt
Orphan-Recovery, der atomare Verbrauch von `ImageOperationCounter`, und die
`Task`-Zeilen.

**Regel:** Soll horizontal skaliert werden, ziehen diese vier Zustände
**vorher** nach Postgres oder Redis um, nicht danach. Alle Symptome sind still,
also würde die Ursache erst Wochen später gesucht.

### Zwei Hintergrund-Jobs sind Prozess-Singletons — und der Deploy-Overlap

Zusätzlich zu den Zuständen oben laufen im Web-Prozess zwei Jobs, die **genau
einmal** laufen dürfen (gestartet in [server.js](server.js)):

- **WebP-Prozessor** ([webp-processor.service.js](webp-processor.service.js)):
  holt wartende `imageWebpConversionItem`-Zeilen aus der `Task`-Tabelle und
  ersetzt das Original des Merchants auf Shopify (neues Medium anlegen, Original
  löschen). Zwei Prozessoren auf derselben Zeile = doppelt konvertiert, doppelt
  hochgeladen, doppelt gelöscht, verwaiste oder doppelte Medien am Produkt.
- **Stale-Image-Cleanup** ([stale-image-cleanup.service.js](stale-image-cleanup.service.js)):
  periodischer Lauf über die lokalen `ProductImage`-Cache-Zeilen. Er löscht nur
  den App-eigenen Cache, nie etwas auf Shopify; zwei Läufe gleichzeitig erzeugen
  doppelte Shopify-Abfragen und Löschversuche, keinen Datenverlust.

Beide haben **keine** Leader-Wahl (siehe den Kommentarblock in `server.js`):
ein zweiter Replica würde beide doppelt starten. Das ist dieselbe Zusage wie
„eine Instanz“ oben.

**Auch mit einer Instanz gibt es zwei Prozesse — beim Deploy.** Railway
deployt ohne Downtime: der neue Container bootet und startet seine Jobs, während
der alte noch bis zum Drain weiterläuft. Für den WebP-Prozessor ist das genau
die Lage von oben, nur kurz. Behandelt wird sie so:

1. **Atomarer Claim.** Der Prozessor setzt eine Zeile per
   `updateMany … where { id, status in (pending, queued) }` auf `running`; bei
   `count: 0` gehört sie schon jemand anderem und wird übersprungen.
2. **Heartbeat.** Solange die Schritte eines Items laufen (auch nachdem der
   Prozessor aufgehört hat, auf sie zu *warten*), stempelt er alle 15 s
   `updatedAt` (`WEBP_ITEM_HEARTBEAT_MS` in [app/config/webp-tasks.js](app/config/webp-tasks.js)).
3. **Boot-Recovery fasst nur stille Zeilen an.** `recoverRunningWebpTasks`
   setzt eine `running`-Zeile nur zurück, wenn `updatedAt` älter als 90 s ist
   (`WEBP_RUNNING_STALE_MS`, sechs Heartbeats); das Zurücksetzen prüft das noch
   einmal im selben Statement. Eine frische Zeile gehört einem lebenden Worker
   des alten Containers.
4. **Laufende Nachprüfung.** Ist der alte Container irgendwann nach dem Boot
   gestorben, war seine Zeile beim ersten Durchlauf noch „frisch“. Der
   5-Minuten-Monitor für hängende Tasks ruft `recoverRunningWebpTasks` deshalb
   bei **jedem** Tick vor dem Reaper auf; dann wird die Zeile regulär
   eingeordnet (unter 70 % neu starten, ab 70 % zur manuellen Prüfung) statt vom
   10-Minuten-Reaper mit Rückerstattung als Fehler markiert. Lebende Zeilen
   bleiben frisch und werden übersprungen, die Wiederholung ist also sicher.
5. **Shutdown wartet kurz** (bis 4 s, `drain`, parallel zum Drain der
   AI-Queue von bis zu 8 s) auf laufende Konvertierungen. `gracefulShutdown`
   beendet den Prozess nach 10 s hart. Damit dieses Fenster überhaupt existiert,
   steht in [.railway/railway.ts](.railway/railway.ts) `drainingSeconds: 15` (das
   Feld ist im Railway-Schema definiert als Zeit zwischen SIGTERM und SIGKILL
   des alten Deploys; dass der Standard 0 ist, steht in Railways Doku, nicht im
   Schema. Im Manifest stand `null`, d. h. SIGKILL folgte sofort und
   weder dieser Drain noch der der AI-Queue bekam Zeit). Der Wert muss über der
   10-s-Grenze in `server.js` bleiben.
6. **Der Heartbeat ist gedeckelt** (`WEBP_HEARTBEAT_MAX_MS`, 75 min, über der
   Worst-Case-Dauer von rund 59 min: 100 Varianten × 30 s = 50 min, dazu etwa
   6 min Download/Konvertierung/Upload davor und etwa 2,5 min danach): ein
   Schritt, der nie zurückkehrt, wird irgendwann still. Danach schließt der
   10-Minuten-Reaper die Zeile (fehlgeschlagen + Rückerstattung). Die Recovery
   fasst Zeilen, die dieser Prozess noch in Arbeit hat, nie an (sie fragt den
   Worker nach seinen laufenden IDs); die Aufgabe wird also nie auf „pending“
   zurückgesetzt und nie ein zweites Mal konvertiert. Dasselbe gilt für einen
   Postgres-Ausfall von mehr als 90 s mitten in einer Konvertierung: die Zeile
   bleibt unangetastet.

Restrisiko: Der Claim schützt vor *gleichzeitigem Annehmen*, nicht vor einem
Worker, der mitten in der Konvertierung hart beendet wird — das fängt weiterhin
die Fortschrittsgrenze (70 %) der Recovery ab. Und: der Heartbeat läuft im
Prozess; hängt dessen Event-Loop länger als 90 s, sähe ein Nachbar die Zeile als
tot. Bei einer Instanz ist das kein realer Fall.

Für das Managed-AI-Key-Modell
([docs/plans/PLAN_MANAGED_AI_KEY.md](docs/plans/PLAN_MANAGED_AI_KEY.md)) kommen
zwei weitere Gründe dazu, und sie sind nicht mehr geplant, sondern gebaut.
Erstens ist die Instanzzahl direkt ein Kostenfaktor: die Obergrenze dafür, wie
weit ein Shop sein Budget überziehen kann, ist `AI_QUEUE_CONCURRENCY ×
Instanzen`. Zweitens ist der Circuit Breaker des Failovers ein **fünfter**
prozesslokaler Zustand — zwei Instanzen probieren einen ausgefallenen Anbieter
doppelt so oft und zahlen die Fehlversuche doppelt.

### `/admin` (Shop-Übersicht) — Betrieb

Keine neuen Env-Variablen und keine neuen Logzeilen. Die Seite braucht weiter `ADMIN_PASSWORD` (mindestens 16 Zeichen) und `SHOPIFY_API_SECRET`; ein Passwortwechsel macht alle Sitzungen ungültig. Erfolgreiche Anmeldungen erscheinen als `[ADMIN] Erfolgreiche Anmeldung` (mit Client-IP), Fehlversuche als `[ADMIN] Falsches Passwort`. Die Tabelle liest aus der Datenbank mit einer festen Zahl von Abfragen; die Detailansicht und die DSGVO-Einträge laden erst auf Klick.

### Env-Variablen für Managed AI

Alle sind **optional**: ohne `MANAGED_AI_ENABLED=true` ist das Feature aus, und
BYO funktioniert unverändert. `scripts/validate-env.js` prüft sie beim Start
und verweigert eine halbe Konfiguration.

| Variable | Bedeutung |
|---|---|
| `MANAGED_AI_ENABLED` | Der Kill-Switch, **opt-in**: nur `"true"` schaltet an. Alles andere (auch unset) ist AUS — die umgekehrte Lesart würde das Feature in jeder Umgebung anschalten, die einen Key hat und keine Meinung zum Flag, also auch in einer Staging-Box mit kopierter Production-Env. |
| `MANAGED_AI_PROVIDER` / `_MODEL` / `_API_KEY` | Das Operator-Credential. Werden als EINHEIT gelesen: eine halbe Konfiguration ergibt gar keine, weil ein Modell oder Key des falschen Anbieters ein Request an den falschen Endpunkt mit fremdem Secret im Header ist. Das Modell muss in `app/config/ai-pricing.ts` bepreist sein, sonst wird das Budget gegen eine Schätzung durchgesetzt. |
| `MANAGED_AI_FALLBACK_*` | Dasselbe für den Ausweichanbieter. Fehlt er, startet die App trotzdem — aber ein Ausfall des Default-Anbieters ist dann ein Ausfall. |
| `MANAGED_AI_TPM` / `_RPM` (+ `_FALLBACK_`) | Das Rate-Limit-Fenster **unseres** Kontos. Ohne sie gelten die App-Defaults, die für EINEN Merchant-Account gedacht sind: Anthropics Default (5 RPM / 40 000 TPM) ließe app-weit etwa vier Calls pro Minute zu. |
| `MANAGED_AI_POOL_MICROS` / `_TASTER_POOL_MICROS` | Die globale Monatsobergrenze in Mikro-Euro, **zwei Töpfe**. Pro-Shop-Budgets begrenzen, was ein Merchant kosten kann; diese begrenzen, was ein BUG kosten kann. Zwei Töpfe, weil ein Ansturm freier Installationen sonst am 18. den Deckel reißt und jedem ZAHLENDEN Merchant 503 antwortet. Unset heißt kein Deckel — eine Entscheidung, keine Voreinstellung, in die man hineinrutscht. Der Zähler läuft pro **Kalendermonat** und ist bewusst NICHT der Shop-Schlüssel: nach dem Abrechnungszeitraum des Shops gekeyed zerfiel er in eine Zeile pro Vertragsende, jede mit dem vollen Limit. |
| `MANAGED_AI_FAILOVER_POOL_MICROS` | Das globale Ausfall-Budget (§3a Regel 4), ebenfalls pro Kalendermonat. Der Ausweichanbieter kostet ~14x und der Merchant zahlt den Preis des Default-Modells — die Differenz tragen wir, und das ist die Obergrenze dafür. Aufgebraucht, schlägt ein Call mit dem Fehler seines eigenen Anbieters fehl statt 14x zu kosten. Unset heißt kein Deckel; die Pro-Shop-Obergrenze bleibt davon unberührt. |

Der Operator-Key wird von genau einem Modul gelesen
(`app/services/ai/ai-credentials.server.ts`), das zugleich Einwilligung,
Kill-Switch und Budget prüft; ein Test hält das fest. Im Dev-/Custom-App-Build
wird er grundsätzlich nicht ausgeliefert — AUSSER mit dem Test-Schalter unten.

| Variable (nur Development) | Bedeutung |
|---|---|
| `ALERT_WEBHOOK_URL` (Web-Dienst) | Derselbe Discord-/Slack-Webhook wie beim DB-Alarm. Die enthaltene KI meldet dorthin: ein Modell oder Schlüssel, der beim Start oder bei der täglichen Prüfung nicht antwortet (und wann es wieder geht), den Wechsel auf den Ausweichanbieter, einen gesperrten Anbieter, das Ausfall-Budget bei 50 / 90 / 100 % und ein Gesamtbudget ab 50 %. Höchstens eine Meldung pro Ursache und Stunde; die Umgebung steht in jeder Meldung. Fehlt er, wird nur geloggt. |
| `MANAGED_AI_ALLOW_DEV_BUILD` | Nur `"true"` und nur im Dev-Build (Dev-Client-ID, `APP_ENV` ≠ `production`): Managed AI darf dort zum **Testen** laufen. Hebt zwei Regeln auf, die genau diesen Build betreffen: die Sperre des Operator-Keys im Dev-Build und die Regel „zahlt nichts ⇒ nur Schnupperkontingent" (Entwicklungsshops, Test-Abos, Dev-Plan-Override, Trial) — sonst wäre ein „+ KI"-Plan dort nie testbar. Da der Dev-Build keine Billing-API hat, gilt die „+ KI"-Wahl im Planwechsel als Kauf (`AISettings.devForcedManagedAi`), mit einem einmal gesetzten Abrechnungsende, das wie eine echte Verlängerung alle 30 Tage weiterläuft. `validate-env` verweigert den Start, wenn dabei `MANAGED_AI_POOL_MICROS`, `MANAGED_AI_TASTER_POOL_MICROS` oder `MANAGED_AI_FAILOVER_POOL_MICROS` fehlt (und zur Laufzeit bleibt der Schalter ohne alle drei wirkungslos, auch unter `npm run dev`) — jeder Cent hier ist Ausgabe ohne Umsatz. In jedem anderen Build ist die Variable wirkungslos (und `validate-env` warnt). |

### Env-Variablen für ablaufende Offline-Tokens (Shopify „expiring offline access tokens")

Shopify stellt Apps auf **ablaufende Offline-Tokens** um (~1 h gültig, dazu ein
rotierender Refresh-Token). Die App ist dafür vorbereitet
([app/utils/offline-admin.server.ts](app/utils/offline-admin.server.ts)): jeder
Hintergrund-Aufruf (Webhooks, Scheduler, Sweeps, detached Tasks, WebP-Worker)
holt sich sein Token pro Aufruf, die Library erneuert es kurz vor Ablauf, und
ein 401 wird einmal mit frisch geladener Session wiederholt. Beides ist per
Env-Variable geschaltet und **standardmäßig AUS** — ohne die Variablen verhält
sich die App exakt wie vorher.

| Variable | Bedeutung |
|---|---|
| `SHOPIFY_EXPIRING_OFFLINE_TOKENS` | Nur `"true"` schaltet an. Setzt `future.expiringOfflineAccessTokens`: neue Token-Exchanges (Installation, Re-Auth, abgelaufene Session) bekommen ablaufende Offline-Tokens, und alle Langläufer nutzen den sich selbst erneuernden Client statt des Clients ihres Requests. Bestehende, NICHT ablaufende Tokens bleiben unverändert und funktionieren weiter. |
| `SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS` | Nur `"true"`, und **nur wirksam, solange die erste Variable an ist**. Tauscht das bestehende, nicht ablaufende Offline-Token eines Shops gegen ein ablaufendes — pro Shop, **nur im Hintergrund**, nie im Request selbst (ein laufender Request hält das alte Token noch, und ein 401 darauf würde das migrierte Paar überschreiben). Zwei Auslöser: (1) der Sync-Zyklus eines Shops, dessen Merchant die App geöffnet hat — frühestens eine Minute nach Scheduler-Start und nur in einer ruhigen Phase (seit mindestens 20 s kein authentifizierter Request); (2) der **Offline-Token-Sweep** für Shops, die die App nie öffnen (siehe unten). Wichtig: Die App zu öffnen migriert einen Shop **nicht** von selbst — ein nicht ablaufendes Token gilt der Library immer als „aktiv", es findet kein Token-Exchange statt. Ohne den Sweep würde ein Shop, der die App nie öffnet, **am 2027-01-01 ausfallen** (ab dann lehnt Shopify nicht ablaufende Offline-Tokens für die Admin API mit HTTP 403 ab: „Non-expiring access tokens are no longer accepted for the Admin API."). Single-flight pro Shop, wirft nie in den Request. Shopify widerruft das alte Token mit der Migration sofort (Doku; keine Übergangsfrist). Restrisiko: ein Request, der genau während der Migration noch läuft, schlägt für den Merchant fehl (401 ohne Retry-Header, kein automatischer Neuversuch); der nächste Request legt die Session per Token-Exchange neu an, bis dahin scheitern Hintergrund-Aufrufe (`no_token`). |
| `SHOP_BLOCK_ON_ADMIN_401` | Nur `"true"` schaltet an, **standardmässig AUS**. Erlaubt, einen Shop nach einem zweiten 401 mit demselben gespeicherten Zugang als «muss sich neu anmelden» zu sperren (Hintergrunddienste überspringen ihn dann). Die 6-stündliche Probe des Verbindungs-Sweeps (siehe unten) hebt eine falsche Sperre wieder auf, **die Schalter darf also eingeschaltet werden**; der Owner entscheidet, wann. Die Sperren aus eindeutigen Belegen (leerer Zugang, abgelaufenes Auffrischungs-Token, abgelehnte Migration, 404/403 des Token-Endpunkts über 24 h) sind davon unabhängig immer aktiv. |

Beim Start loggt die App `[SHOPIFY.SERVER] Expiring offline tokens: ON|OFF … migration …: ON|OFF`.

**Reihenfolge beim Rollout — nicht abkürzen:**

1. Deploy des Codes (beide Variablen ungesetzt). Nichts ändert sich; prüfen, dass
   die Startzeile `Expiring offline tokens: OFF` zeigt.
2. `SHOPIFY_EXPIRING_OFFLINE_TOKENS=true` setzen (erst Development, dann
   Production). Nur Shops, deren Session neu ausgestellt wird, bekommen
   ablaufende Tokens.
3. **Beobachten** — mindestens einige Stunden, besser einen Tag: keine 401 in
   Webhooks / Sweeps / Tasks, im Log `[OfflineAdmin]`-Zeilen nur als seltene
   Refreshs, keine `Offline token unavailable`-Fehler. Ein Fehlerbild hier heißt:
   Variable wieder entfernen — bereits ausgestellte ablaufende Tokens werden
   dann allerdings NICHT mehr erneuert, betroffene Shops müssen die App einmal
   öffnen (Token-Exchange stellt ein neues aus).
4. Erst dann `SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS=true` setzen. Danach im Log auf
   `Migrated offline token to an expiring one`, `Token migration failed` und
   `NEEDS_REAUTH` achten (Details im Abschnitt unten). Die Migration ist
   einseitig — einen migrierten Shop zurück auf ein nicht ablaufendes Token
   bringt nur ein Re-Install. **Spätestens vor dem 2027-01-01 muss dieser Schritt
   durch sein**, sonst fallen alle noch nicht migrierten Shops aus.
5. Nach dem Deploy der Tabelle `OfflineTokenMigration` (Prisma-Migration
   `20261030000000_offline_token_migration`, läuft über `prisma migrate deploy` in
   `scripts/run-all-migrations.js`/`start:production`) gibt es nichts weiter zu tun.

Grenze, ehrlich benannt: das Single-Flight um den Refresh gilt pro **Prozess**
(passt zur EINEN Web-Instanz oben). Shopify entwertet einen Refresh-Token nicht
in dem Moment, in dem er benutzt wird (jeder Refresh liefert ein NEUES Access- +
Refresh-Paar; der vorgelegte Refresh-Token bleibt benutzbar, bis die App den
neueren nutzt, ein neuer Token erworben wird, 30 Tage nach erster Nutzung oder
bis zu seinem 90-Tage-Ablauf). Der echte Konflikt ist, einen Token zu **erwerben**
(Token-Exchange) und gleichzeitig zu **erneuern**: jedes macht das Ergebnis des
anderen unbrauchbar. Bei mehreren Instanzen könnte das passieren; die App liest
nach einem gescheiterten Refresh einmal die gespeicherte Session neu, was den
Fall meist auffängt, aber nicht garantiert. Ein Refresh, der endgültig scheitert
(Shopify antwortet 401 `invalid_request` = Re-Auth nötig; die Library macht daraus
ein nacktes HTTP 500), wird pro Shop 60 s lang gemerkt: Aufrufer scheitern in der
Zeit sofort, statt bei Shopify erneut anzufragen. Ein neuer Token-Exchange
(afterAuth) hebt das sofort auf.

#### Hintergrund-Sweep, Wiederherstellung und `needs_reauth`

**Offline-Token-Sweep** ([app/services/offline-token-sweep.service.ts](app/services/offline-token-sweep.service.ts)):
läuft nur, wenn `SHOPIFY_EXPIRING_OFFLINE_TOKENS` an ist (sonst startet kein Timer;
der Migrationsteil braucht zusätzlich `SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS`, das
Keep-alive nicht), prozesslokal (die EINE Web-Instanz), beim Boot gestartet und alle
10 min. Pro Lauf höchstens 5 Shops je Art, nacheinander, mit 5 s Pause dazwischen
(`OFFLINE_TOKEN_SWEEP_BATCH_SIZE` ≥ 1, `OFFLINE_TOKEN_SWEEP_PAUSE_MS` ≥ 0,
`OFFLINE_TOKEN_SWEEP_INTERVAL_MS` ≥ 60000; ungültige Werte fallen auf den Standard
zurück; komplett abschaltbar mit `OFFLINE_TOKEN_SWEEP_DISABLED=true`).

- **Migration** (beide Variablen): installierte Shops, deren Offline-Session ein Token,
  aber kein `expires` hat, ohne authentifizierten Request seit mindestens 30 min
  (oder unbekannt — ein fehlgeschlagener Aktivitäts-Lookup zählt NICHT als ruhig)
  und ohne laufenden Scheduler. Läuft durch dasselbe Single-Flight
  `maybeMigrateToExpiringToken` wie der Scheduler-Auslöser (der bleibt bestehen).
  Shops mit Status `needs_reauth` sowie `failed`-Shops innerhalb ihres Backoffs oder
  nach dem Aufgeben werden schon in der Abfrage ausgeschlossen.
- **Keep-alive** (nur `SHOPIFY_EXPIRING_OFFLINE_TOKENS`): Shops mit ablaufender Session, deren `refreshTokenExpires` in
  weniger als 14 Tagen liegt (und die ruhig sind), werden über `getOfflineAdmin`
  angesprochen, wodurch die Library den Token erneuert — sonst stirbt der
  Refresh-Token eines schlafenden Shops nach 90 Tagen. **Annahme, nicht belegt:**
  dass ein Refresh die 90 Tage neu startet (Shopify-Doku: „90 days when issued;
  using it to refresh can shorten it"). Jeder Keep-alive loggt
  `refreshTokenExpiresBefore/After` — der erste echte Lauf zeigt, ob sich der
  Ablauf verschiebt. Ein Shop wird höchstens alle 6 h angefasst.

**Wiederherstellung einer halb gelaufenen Migration.** Shopify widerruft das alte
Token sofort; seit 2026-09-29 liefert eine Wiederholung desselben Exchanges mit
demselben alten Token **7 Tage lang dasselbe Paar** (endet nach 7 Tagen, nachdem
die App dieses Paar erneuert hat, oder nach einem neuen Token-Erwerb für den Shop).
Dafür muss die App das alte Token noch haben. Deshalb wird es **vor** dem Exchange
verschlüsselt (AES-256-GCM, derselbe Helfer wie für Session-Tokens) in der Tabelle
`OfflineTokenMigration` abgelegt (Status `pending|needs_reauth|failed`,
`attempts`, `lastError` ohne Geheimnisse) und die **ganze Zeile wird gelöscht, sobald
das neue Paar gespeichert ist** (es gibt keine „migrated"-Zeilen). Vor jedem
Schreiben liest die Migration die gespeicherte Session neu: hat inzwischen ein
Token-Exchange eine Session mit `expires` gespeichert (Merchant öffnet die App
während eines Wiederherstellungs-Laufs), ist der Shop deinstalliert oder hat ein
anderes Token, bricht der Lauf ab und überschreibt/erzeugt nichts. Damit gilt:

- Transiente Fehler (Netzwerk, 5xx/429, Antwort ohne ablaufendes Token,
  `storeSession` liefert `false`/wirft) werden **sofort** wiederholt (nach 2 s,
  5 s, 15 s), nicht erst nach einer Stunde. Reicht das nicht, bleibt das Token
  gespeichert (Status `failed`) und der Shop wird nach einem **exponentiellen,
  in der Zeile (`attempts`, `updatedAt`) persistierten** Backoff erneut versucht:
  10 min, 20 min, 40 min … bis höchstens 24 h, auch nach einem Neustart. Nach 40
  Versuchen (ca. 3 Tage) gibt die App auf: einmal Logzeile `MIGRATION_GAVE_UP`,
  danach kein automatischer Neuversuch mehr (Status bleibt `failed`; der
  verschlüsselte alte Token wird dabei **gelöscht**, der Fingerabdruck bleibt;
  Rücksetzen siehe unten). Ausnahme, einmalig: Meldet Shopify später für genau
  dieses Token den Stichtags-403 (ein 403, kein 401 — das Token ist also nicht
  widerrufen und noch migrierbar), erlaubt die App **einen** weiteren
  Migrationslauf pro Token und Prozess (Logzeile „ONE more migration run"), statt
  das letzte Token sofort zu leeren. Schlägt auch dieser Lauf fehl (Shop wieder
  aufgegeben), wird das tote gespeicherte Token **doch geleert**: die Library zählt eine
  Session mit Token immer als aktiv und würde nie einen Token-Exchange machen, auch
  nicht beim Öffnen der App. Jeder weitere 403 leert erneut, ohne neuen Lauf.
  Zeilen jenseits der 7-Tage-Frist, deren Session kein Token mehr hat, verlieren
  ihren Ciphertext im Sweep (nichts mehr wiederherzustellen). Ein Lauf, der mit einer
  Exception endet (z. B. Datenbankfehler), zählt als fehlgeschlagener Lauf.
- Hat die gespeicherte Session ihr Token verloren (die Library speichert nach einem
  401 auf das widerrufene Token eine Session mit `accessToken: undefined`), wiederholt
  die App den Exchange mit dem gespeicherten alten Token — nur innerhalb von 7 Tagen
  ab dem ersten Versuch.
- Eine Zeile pro Shop liegt nur, solange etwas offen ist; sie wird bei
  `app/uninstalled` (**immer**, auch bei ausgeschalteten Variablen — nach einem
  Rollback kann noch ein verschlüsseltes Token liegen), im GDPR-`shop/redact`
  (`redactShopData`, immer) und bei jedem neuen Token-Exchange (afterAuth, nur wenn
  `SHOPIFY_EXPIRING_OFFLINE_TOKENS` an ist) gelöscht. Bei ausgeschalteten Variablen
  macht die Migration selbst keinen DB-Zugriff; die beiden Löschungen oben sind die
  Ausnahme.

**404 und 403 des Token-Endpunkts.** Ein 404 (Shop weg) und ein Shop-spezifischer 403
bekommen **einen** Versuch pro Lauf (`failureKind` = `not_found` / `forbidden` auf der
Zeile), Neuversuch etwa alle 4 Stunden. Endgültig ist der Shop, wenn **dieselbe**
Fehlerart seit mindestens 24 Stunden und über mindestens 3 Läufe anhält **und** eine
direkte Probe `{ shop { id } }` mit dem gespeicherten Zugang eindeutig zeigt, dass der Zugang
tot ist (HTTP 401 oder 404, eine Antwort mit `shop: null` ohne Fehler, ein Shop-spezifischer
403 ausser bei Zeilen, die schon `forbidden` sind, ein Stichtags-403 ausser bei Zeilen mit
`not_found`, weil er beweist, dass der Shop existiert). Antwortet der Shop, oder ist das
Ergebnis unklar (429, 5xx, Netzwerk, GraphQL-Fehler wie `THROTTLED`, ein 403 mit IP-Liste,
ein leeres gespeichertes Token), wird der Shop weder endgültig noch gesperrt, nichts wird
gelöscht, der Neuversuch folgt in 4 Stunden und der Lauf zählt nicht Richtung
40-Versuche-Grenze. Ebenso wird das Endgültig-Werden zurückgehalten, solange mindestens drei
**andere** Shops dieselbe Fehlerart mit Beginn in den letzten 48 Stunden tragen (aus der
Datenbank gelesen, übersteht also einen Neustart; die Versuche laufen weiter). Drei Shops mit
derselben Fehlerart innerhalb von 30 Minuten erzeugen ausserdem die Logzeile
`TOKEN_ENDPOINT_MASS` und höchstens einmal pro Stunde eine Meldung an Discord (jeder Shop zählt
dafür nur bei seinem ersten Fehler dieser Art). Token-Endpunkt-403 zählen nicht für den
Verdacht auf die IP-Liste der Admin-API. Wird ein Shop endgültig: einmal
Logzeile `MIGRATION_GAVE_UP`, die Zeile gilt als aufgegeben (alter Token gelöscht),
und der Shop bekommt die Sperre `shop_not_found` beziehungsweise `access_denied`
(eindeutiger Beleg, nicht hinter `SHOP_BLOCK_ON_ADMIN_401`; eine neue Anmeldung hebt
sie auf). Wechselt die Fehlerart, beginnen beide Uhren neu. Ein 403, der nach der IP-Liste
aussieht (der Text nennt sie, oder mindestens drei Shops bekommen gleichzeitig 403 und kein
anderer Shop hatte Erfolg; 403 von Proben bereits gesperrter Shops zählen dafür nicht), zählt **keinen** Versuch und setzt nur eine globale Pause von
30 Minuten (je Vorfall insgesamt höchstens 2 Stunden) für Migration und Probe. Ein 403 sperrt nie einen Shop und leert nie einen
Zugang. Die Logzeile `[ShopifyIP] IP_ALLOWLIST_403` (höchstens alle 5 Minuten) verweist
auf den Hinweis zur IP-Liste in CLAUDE.md; dazu kommt höchstens einmal pro Stunde eine
Meldung an `ALERT_WEBHOOK_URL` (Discord). Dieselbe Meldung gibt es einmal pro Stunde bei
`MASS_401` (mehrere Shops bekommen gleichzeitig einen 401). Pro Sperre gibt es bewusst
keine Meldung.

**Verbindungs-Sweep** (`shop-connection-sweep.service.ts`, alle 10 Minuten, unabhängig
von den Token-Schaltern; abschaltbar mit `SHOP_CONNECTION_SWEEP_DISABLED=true`,
Intervall `SHOP_CONNECTION_SWEEP_INTERVAL_MS` ≥ 60000, Pause zwischen Shops
`SHOP_CONNECTION_SWEEP_PAUSE_MS`): (1) einmal pro Prozessstart ein Nachtrag aus
vorhandenen Belegen (`needs_reauth`-Zeilen und Sessions mit leerem Zugang werden zu
`needs_reauth`, 404-Zeilen bekommen ihre Fehlerart; 403-Zeilen bleiben unberührt;
abschaltbar mit `SHOP_CONNECTION_BACKFILL_DISABLED=true`); (2) alle 6 Stunden eine
Probe `{ shop { id } }` mit dem gespeicherten Zugang für jeden gesperrten, nicht
deinstallierten Shop (höchstens 5 pro Durchlauf; nicht während der IP-Pause und nicht
beim globalen Konfigurationsstopp): Erfolg hebt die Sperre auf (Ursache `probe_ok`),
ein 403 oder 401 ändert nichts ausser `lastProbeAt`; (3) Nachholen verpasster
Webhook-Änderungen für entsperrte Shops, deren Scheduler nicht läuft (höchstens 2 pro
Durchlauf); (4) einmal am Tag die Zeile `[ConnectionSweep] SUMMARY blocked=… presumedUninstalled=… owingCatchUp=…`
(`presumedUninstalled` nur zur Anzeige: nichts wird deswegen markiert oder gelöscht).

**Veralteter Installationsstatus** (`app/services/stale-install.server.ts`). Kommt der
Webhook `app/uninstalled` nie an, steht ein Shop ohne `uninstalledAt` da; Markieren führt
über den Reaper nach 30 Tagen zum Löschen der Daten und geschieht deshalb nur mit Belegen.

- `[ConnectionState] REINSTALL_EVIDENCE shop=… source=webhook`: ein als deinstalliert
  markierter Shop hat danach (mehr als 5 Minuten nach `uninstalledAt`) einen signierten
  **Produkt- oder Kollektions**-Webhook geschickt (der Abo-Webhook zählt nicht: ihn löst die
  Deinstallation selbst aus). Genau eine Zeile; es wird nur `reinstallEvidenceAt`
  gesetzt, `uninstalledAt` bleibt (aufgehoben wird es erst durch eine echte Neuanmeldung).
  Der Reaper löscht einen Shop mit solchem Beleg höchstens 30 Tage lang nicht (mit Session
  schützt ihn ohnehin die Session-Regel); danach ist er wieder löschbar. Die Zeile
  `Shop reap: skipping … REINSTALL_EVIDENCE` erscheint einmal pro Shop und Prozess.
- **Operator-Skript** `scripts/mark-stale-uninstalled.ts`. Es läuft **nicht im
  Production-Image** (App-Quellen und `tsx` sind dort nicht enthalten), sondern aus einem
  lokalen Checkout (`npm install`), mit der Production-`DATABASE_URL` nur vorübergehend in
  der Shell gesetzt (nie in eine Datei oder ein Commit):
  `npx tsx scripts/mark-stale-uninstalled.ts --shop <name>.myshopify.com` ist ein
  **Trockenlauf**: er zeigt die Belege (letzter Webhook, letzter API-Erfolg, letzter
  Besuch/Anmeldung, Verbindungszustand und Grund, Sessions und Token, Migration) und ändert
  nichts. Erst mit `--apply` wird über `markShopUninstalled(…, "operator")` markiert, und
  nur, wenn sich der Zustand seit der Prüfung nicht geändert hat (bedingte Markierung vor
  dem Löschen der Sessions). Das Skript verweigert (Exit 2), wenn der Shop nicht
  «vermutlich deinstalliert» ist (seit mindestens 30 Tagen gesperrt, 7 bei «Shop nicht
  gefunden», ohne Webhook, Besuch, Anmeldung, API-Erfolg oder Beleg seit Beginn der Sperre),
  unbekannt oder schon deinstalliert ist, oder wenn noch eine Session ein Token hält
  (dann nur mit `--force-with-token`). Fehlen die App-Quellen, meldet es das klar.
  **Dieselbe Prüfung gibt es als Knopf** in `/admin` (Details eines Shops → «Als deinstalliert
  markieren»): aktiv nur mit Beleg, zeigt vorher die Belege, verlangt die exakt getippte
  Shop-Domain und liest die Fakten auf dem Server neu. Ein Shop, dessen Session noch ein
  Token hält, lässt sich dort **nicht** markieren (nur per Skript mit `--force-with-token`).
- **Automatisches Markieren** `STALE_INSTALL_AUTO_MARK`: nur der exakte Wert `true` schaltet
  an, **standardmässig AUS**. Der Verbindungs-Sweep prüft dann höchstens stündlich und
  markiert (Quelle `stale_auto`) Shops, die seit mindestens 90 Tagen (14 bei «Shop nicht
  gefunden») gesperrt sind, ohne Webhook, Besuch, Anmeldung, API-Erfolg oder Beleg seit
  Beginn der Sperre und ohne noch vorhandenes Token. Grenzen: höchstens 5 Markierungen pro
  UTC-Tag (nur im Prozess gezählt, ein Neustart setzt den Zähler zurück); sind mehr als 10
  Shops gleichzeitig berechtigt, wird **nichts** markiert und es gibt genau eine laute Zeile
  `[StaleInstall] AUTO_MARK_ABORTED` (vermutlich eine systemische Ursache). Jede Markierung
  ist eine Zeile `[StaleInstall] AUTO_MARKED_UNINSTALLED shop=…`. Empfehlung: aus lassen und
  den Weg über das Skript gehen.

**`needs_reauth`.** Antwortet Shopify auf die Migration mit 400 `invalid_subject_token`,
ist das endgültig: das Token lässt sich nicht mehr tauschen (z. B. schon migriert und
die 7 Tage sind um). Der Shop bekommt Status `needs_reauth`, es gibt **keinen**
automatischen Neuversuch (Sweep und Scheduler überspringen ihn) und genau eine
Fehlerzeile im Log: `[OfflineAdmin] NEEDS_REAUTH — Shopify refused the token migration
permanently …`. Zusätzlich wird das tote, gespeicherte Token in der Session geleert
(wie `invalidateAccessToken` der Library), sodass der nächste `authenticate.admin` des
Shops direkt einen Token-Exchange macht, statt einen Request mit 401 scheitern zu
lassen. Der Merchant muss die App also einmal öffnen (oder neu installieren); danach
räumt afterAuth den Datensatz auf und der Shop gilt als migriert. Bis dahin scheitern
Hintergrund-Aufrufe dieses Shops mit `no_token`.

**`invalid_requested_token_type` und `invalid_client` (400/401) sind etwas anderes:**
sie sagen, dass *unsere Anfrage* nicht stimmt (Client-ID/-Secret, Token-Typ, API-Version), nicht dass ein Shop verloren
ist — es würde alle Shops treffen. Annahme: `invalid_client` betrifft die ganze App
(Client-ID/-Secret sind für alle Shops gleich). Könnte ein einzelner Shop es aus
shop-spezifischem Grund auslösen, hielte er alle Shops 6 h an — die Logzeile nennt den
auslösenden Shop. Eine „erst bei zwei Shops"-Regel wurde bewusst verworfen: bei nur
einem installierten Shop würde falsche Konfiguration nie halten und der Shop seine 40
Versuche für einen fremden Fehler verbrennen. Deshalb wird **kein** Shop als `needs_reauth`
markiert und kein Token gelöscht; stattdessen eine laute Logzeile `CONFIG ERROR` und
**6 h Pause für alle Migrationen** (prozesslokal; Konfiguration korrigieren und neu
starten, dann geht es sofort weiter). Betroffene Shops finden:

```sql
SELECT shop, "lastError", attempts, "updatedAt"
FROM "OfflineTokenMigration"
WHERE status = 'needs_reauth'
ORDER BY "updatedAt";
```

bzw. im Log nach `NEEDS_REAUTH` suchen. Hängende Fälle (`pending`/`failed`) zeigt
dieselbe Abfrage mit `status IN ('pending','failed')`; aufgegebene (`MIGRATION_GAVE_UP`)
sind `status = 'failed' AND attempts >= 40`.

**Veraltete Zeilen.** Jede Zeile trägt einen Fingerabdruck (SHA-256, 16 Hex-Zeichen,
nie das Token) des Tokens, für den sie geschrieben wurde. Hält der Shop inzwischen ein
ANDERES Token (z. B. Rollback der Variablen, Merchant öffnet die App, Token-Exchange
stellt ein neues nicht ablaufendes Token aus, afterAuth löscht wegen der ausgeschalteten
Variable nicht), gilt die Zeile als veraltet: `runMigration` und der Sweep verwerfen
sie und behandeln den Shop als neu — Status, Backoff und `needs_reauth` einer Zeile
sperren nur das Token, für das sie galten.

**Aufgegebene Zeilen** (40 Versuche) verlieren beim Aufgeben ihren verschlüsselten
alten Token (der Fingerabdruck bleibt). Ein Reset funktioniert dort nur, solange die
Session des Shops noch genau dieses Token hält — der Lauf nimmt dann das Token der
Session; ist die Session inzwischen ohne Token, gibt es nichts mehr zu retten und der
Shop braucht einen Token-Exchange (Merchant öffnet die App).

**Operator-Reset** (nach Behebung der Ursache; der Sweep nimmt die Shops dann beim
nächsten Lauf wieder auf, auch ohne Neustart: ein In-Process-Backoff, den die
Datenbank nicht mehr stützt, wird für jeden Sweep-Kandidaten verworfen. Nur die
globale 6-h-Konfigurationspause hebt allein ein Neustart auf). Ein `needs_reauth`-Shop, der die App nie öffnet, hat keinen
brauchbaren Token mehr — die Zeile nur löschen, wenn er ein neues Token bekommen hat
(sonst landet er sofort wieder in `needs_reauth`):

```sql
-- aufgegebene / hängende Migration erneut versuchen
UPDATE "OfflineTokenMigration" SET status = 'pending', attempts = 0
WHERE status = 'failed';

-- needs_reauth-Zeile eines Shops verwerfen (z. B. nachdem er die App neu installiert hat)
DELETE FROM "OfflineTokenMigration" WHERE shop = 'example.myshopify.com' AND status = 'needs_reauth';
```

**Nach dem Stichtag (2027-01-01).** Eine Admin-API-Antwort 403 mit „Non-expiring
access tokens are no longer accepted" erkennt die App an der Meldung (ein 403 wegen
fehlendem Scope wird nicht so behandelt): `createRefreshingAdmin` loggt eine
spezifische Warnung, stößt — bei beiden Variablen an — die Migration an und wirft
den ursprünglichen Fehler weiter (kein blindes Wiederholen mit demselben Token). Der
nächste Aufruf sieht das neue Paar. Kann für den Shop **keine** Migration mehr laufen
(`needs_reauth`), leert die App selbst das abgelehnte gespeicherte Token (nur wenn es noch
genau das abgelehnte ist, Fingerabdruck passt) — die Library würde es nach einem 403
nie tun —, damit der nächste Request des Merchants einen Token-Exchange auf ein
ablaufendes Paar macht. Bei einem **aufgegebenen** Shop wird zuerst NICHT geleert (der
403 beweist, dass das Token nicht widerrufen ist): es wird einmalig ein weiterer
Migrationslauf erlaubt und erst geleert, wenn der fehlschlägt (siehe oben). Nie geleert wird bei der 6-h-Konfigurationspause,
bei einem Shop ohne Zeile und solange der Lauf selbst noch entscheiden kann (`failed`,
Session hält das Token noch). Der Schritt ist pro Shop auf einmal je Minute begrenzt. Ausnahme von „Variablen aus = unverändert": der Roh-Client
liest bei jedem 403 den Body (ein Klon), um die Stichtags-Meldung zu erkennen.

Bekannte Restgrenze: der In-Process-Verdikt-Check (`needs_reauth`, Backoff) in
`maybeMigrateToExpiringToken` läuft vor dem Fingerabdruck-Vergleich; der Sweep räumt
veraltete Zeilen dennoch über die Datenbank ab (siehe oben).

Der Roh-Client (`admin-client.server.ts`) erkennt den 403 ebenso. Dieser Auslöser wartet
bewusst **nicht** auf die ruhige Phase: das alte Token ist ab dem Stichtag für die Admin
API ohnehin unbrauchbar, ein laufender Request damit kann nicht schlimmer scheitern.

Veraltete Deinstallationsmarke: Sagt nur `ShopInstallState.uninstalledAt` „deinstalliert",
obwohl eine Session existiert und in diesem Prozess nichts neu ausgestellt wurde (z. B.
weil afterAuths Upsert nach einer Neuinstallation fehlschlug), pausiert die Migration
(Backoff 10 min, Warnung „uninstall marker looks stale") und löscht den
Wiederherstellungs-Datensatz NICHT.

Das pausiert die Migration dieses Shops dauerhaft und still, denn beim Öffnen der App
läuft afterAuth nicht, solange die Session ein nicht ablaufendes Token hat. Die App
loggt es deshalb einmal je Shop und Prozess auf ERROR (`STALE_UNINSTALL_MARKER`) und
räumt die Marke **nicht** selbst auf (ein später 401 kann nach einer echten
Deinstallation eine leere Session-Zeile neu anlegen; „Aktivität nach der Marke" wäre also
kein sicherer Beleg). Reset durch den Operator, wenn der Shop installiert ist:

```sql
UPDATE "ShopInstallState" SET "uninstalledAt" = NULL WHERE shop = 'example.myshopify.com';
```

Rennen mit dem Merchant: Pro Shop zählt die App mit, wie oft eine neue Session
ausgestellt wurde bzw. der Shop deinstalliert wurde (afterAuth / `app/uninstalled`), und
prüft vor jedem Schreiben zusätzlich die Deinstallationsmarke. Ein Lauf, der das
verpasst hat, schreibt nichts — eine leere Session danach stammt dann womöglich von
einem späten 401 auf einer NEUEN Session, nicht vom eigenen Exchange.

### Env-Variablen des Cron-Service `Db Space Checker`

[scripts/db-alert.mjs](scripts/db-alert.mjs) misst `pg_database_size` + WAL und
schlägt Alarm, bevor das Railway-Volume voll läuft. Erforderlich:

| Variable | Bedeutung |
|---|---|
| `DATABASE_URL` | von Railway injiziert (`${{Postgres.DATABASE_URL}}`) |
| `VOLUME_LIMIT_MB` | **die real provisionierte Volume-Größe in MB** (z. B. `5120` für 5 GB) |
| `ALERT_PCT` | Schwelle in Prozent, Default `70` |
| `ALERT_WEBHOOK_URL` | Slack-/Discord-kompatibler Incoming-Webhook; fehlt er, wird nur geloggt |

`VOLUME_LIMIT_MB` gehört bewusst **nicht** ins Repo: der Wert muss dem Dashboard
folgen. Wird das Volume vergrößert, muss er dort mitgezogen werden — sonst feuert
der Alarm bei der falschen Schwelle.

Testlauf mit garantiertem Webhook-Post: `node scripts/db-alert.mjs --test`.
Im Cron-Modus postet das Skript nur bei Überschreitung und beendet sich dann mit
Exit-Code 2 — der Lauf erscheint in Railway also absichtlich als fehlgeschlagen.
Genau deshalb steht die Restart-Policy auf `NEVER`: bei `ON_FAILURE` würde Railway
den Container nach jedem Alarm neu starten und der Webhook liefe in eine Schleife.

### Env-Variablen des Cron-Service `Db Backup`

[scripts/db-backup.mjs](scripts/db-backup.mjs) zieht nachts einen `pg_dump` und
legt ihn in einem Cloudflare-R2-Bucket ab. Railways eigene Snapshots bleiben als
Grundsicherung bestehen — sie sind aber ein Service-Rollback: kein frei wählbarer
Zeitpunkt und kein Weg, eine *einzelne* Tabelle zurückzuholen. Genau das braucht
man vor einer destruktiven Migration, und dafür ist dieser Service da.

| Variable | Bedeutung |
|---|---|
| `DATABASE_URL` | von Railway injiziert (`${{Postgres.DATABASE_URL}}`) |
| `R2_ACCOUNT_ID` | Cloudflare-Account-ID; daraus wird `https://<id>.r2.cloudflarestorage.com` gebaut |
| `R2_ENDPOINT` | optional, überschreibt `R2_ACCOUNT_ID`. **Pflicht bei EU-Jurisdiction** (siehe unten) |
| `R2_BUCKET` | Ziel-Bucket |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2-**Account**-API-Token (kein User-Token, s. u.). **Nur „Object Read & Write" auf genau diesen Bucket** — der Token liegt in einem Container, der sonst nichts mit R2 zu tun hat |
| `BACKUP_PREFIX` | Key-Präfix und Dateiname-Stamm, Default `contentpilot` |
| `BACKUP_RETENTION_DAYS` | ältere Dumps werden gelöscht, Default `30`, `0` = nie löschen |
| `BACKUP_KEEP_MINIMUM` | die N neuesten Dumps werden **nie** gelöscht, Default `3` |
| `ALERT_WEBHOOK_URL` | derselbe Slack-/Discord-Webhook wie beim Space Checker; fehlt er, wird nur geloggt |

**Zwei Environments, zwei Buckets, zwei Tokens.** Production und development
haben je eine eigene Postgres — also läuft der Backup-Service in beiden, und
jedes Environment schreibt in seinen **eigenen** Bucket mit einem Token, das
**nur** auf diesen Bucket berechtigt ist:

| | production | development |
|---|---|---|
| Bucket | `contentpilot-backups-prod` | `contentpilot-backups-dev` |
| `R2_BUCKET` | `contentpilot-backups-prod` | `contentpilot-backups-dev` |
| `BACKUP_RETENTION_DAYS` | `30` | `7` |
| `BACKUP_KEEP_MINIMUM` | `3` | `2` |
| R2-Token | eigenes, nur auf den prod-Bucket | eigenes, nur auf den dev-Bucket |

Der Punkt der Trennung ist der **Token**, nicht der Bucket: ein einziges Token
über beide Buckets würde bedeuten, dass ein Leak aus der Dev-Umgebung — die
naturgemäß mehr angefasst und weniger streng behandelt wird — die
Produktions-Backups löschen kann. Genau davor schützt die Aufteilung. Ein
gemeinsamer Bucket mit zwei `BACKUP_PREFIX`-Werten wäre billiger, gäbe diese
Eigenschaft aber auf.

Der Service `Db Backup` ist in `railway.ts` für beide Environments gleich definiert — die Unterschiede oben
sind ausschließlich Environment-Variablen, und die sind in Railway ohnehin pro
Environment gesetzt.

Der Ablauf bricht bei jedem Schritt ab, statt ein halbes Backup als Erfolg zu
melden: Versionscheck → `pg_dump -Fc` → **`pg_restore --list` auf das Ergebnis**
→ Upload → Retention. Der Verifikationsschritt ist der Punkt, an dem ein
abgeschnittener oder leerer Dump auffällt — im Backup-Fenster, nicht in dem
Moment, in dem man ihn unter Druck zurückspielen will.

Zwei Sicherheitseigenschaften der Retention, die bewusst so gebaut sind: die
`BACKUP_KEEP_MINIMUM` neuesten Dumps überleben **jedes** Alter (läuft der Cron
monatelang nicht, darf der nächste Lauf nicht „alle sind alt" als „alle löschen"
lesen), und gelöscht wird nur, was auf `.dump` endet — was sonst noch unter dem
Präfix liegt, gehört der Retention nicht. Beides ist in
[tests/unit/db-backup.test.ts](tests/unit/db-backup.test.ts) festgenagelt.

**Account-Token, nicht User-Token.** Cloudflare bietet beim Anlegen beide Typen
an. Ein User-Token hängt an einer Person — an deren Account-Mitgliedschaft und
deren Rechten. Ändert sich daran etwas, hört das Backup auf zu laufen, nachts und
unbeaufsichtigt; also genau die stille Sorte Ausfall, gegen die dieser Service
gebaut ist. Ein Account-Token gehört dem Account und überlebt Personalwechsel.
Beide liefern dasselbe Access-Key-Paar, die Bucket-Einschränkung gilt für beide —
es gibt also nichts zu gewinnen und etwas zu verlieren.

**EU-Jurisdiction ändert den Endpoint.** Die Dumps enthalten Shop-Daten und
Session-PII, EU-Residenz ist also naheliegend — aber Cloudflare trennt zwei
Dinge, die im Anlege-Dialog nebeneinander stehen: ein *Location Hint* ist eine
unverbindliche Platzierungs-Empfehlung und lässt den Endpoint unverändert, eine
*Jurisdiction* `European Union` ist die harte Zusage und verschiebt den
S3-Endpoint auf `https://<account>.eu.r2.cloudflarestorage.com`. Für einen
Jurisdiction-Bucket reicht `R2_ACCOUNT_ID` daher **nicht** — das Skript würde
den Endpoint ohne `.eu` zusammenbauen und ins Leere greifen. Dann `R2_ENDPOINT`
explizit setzen. Die Jurisdiction ist beim Anlegen zu wählen und später nicht
mehr änderbar.

**Postgres-Client-Version.** `pg_dump` verweigert den Dump eines *neueren*
Servers. Das [Dockerfile](Dockerfile) installiert Alpines Default-`postgresql-client`;
wird Railways Postgres später hochgezogen, scheitert der Lauf mit genau dem
Paketnamen, den man dort pinnen muss (`postgresql17-client` o. ä.) — statt still
ein unbrauchbares Backup abzulegen.

Erste Inbetriebnahme, in dieser Reihenfolge:

```bash
# 1. Nur Dump + Verifikation, ohne Bucket und ohne Credentials:
node scripts/db-backup.mjs --dry-run
# 2. Vollständiger Lauf, der auch bei Erfolg in den Webhook postet:
node scripts/db-backup.mjs --test
```

Im Cron-Modus meldet sich der Service **nur bei Fehlern** (Exit-Code 1 plus
Webhook-Post). Restart-Policy `NEVER` aus demselben Grund wie beim Space Checker.

Ein Backup, das nie zurückgespielt wurde, ist kein Backup — der Restore-Weg:

```bash
pg_restore -d "$ZIEL_URL" --no-owner --no-privileges backup.dump
# nur eine einzelne Tabelle (das ist der Grund fuer das custom format):
pg_restore -d "$ZIEL_URL" --no-owner --no-privileges -t Shop backup.dump
```

## 1. Railway Project Setup

### Schritt 1: Environments einrichten

1. Öffne dein Railway Dashboard: https://railway.app/dashboard
2. Wähle dein Project "compassionate-love"
3. Klicke auf das **Environment Dropdown** oben (da wo du zwischen Environments wechseln kannst)
4. Du solltest aktuell eine Environment sehen (wahrscheinlich "production")

### Schritt 2: Development Environment erstellen

1. Klicke auf das Environment Dropdown
2. Wähle **"New Environment"**
3. Name: `development`
4. Base Environment: `production` (optional, um Settings zu kopieren)
5. Erstelle die Environment

### Schritt 3: Deployment-Trigger konfigurieren

#### Production Environment:
1. Wähle "production" Environment aus dem Dropdown
2. Klicke auf dein **Service** (wahrscheinlich heißt es wie dein Repo)
3. Gehe zu **Settings** → **Source**
4. Bei **Branch**: Wähle `master`
5. Bei **Automatic Deployments**:
   - **Deaktiviere** "Deploy on every push" (für mehr Kontrolle)
   - ODER lasse es aktiv wenn du automatische Deployments willst

#### Development Environment:
1. Wähle "development" Environment aus dem Dropdown
2. Klicke auf dein Service
3. Gehe zu **Settings** → **Source**
4. Bei **Branch**: Wähle `develop`
5. Bei **Automatic Deployments**: **Aktiviere** "Deploy on every push" ✓
6. Root Directory: `/` (oder dein Project-Root)
7. Build Command: `npm run build`
8. Start Command: `npm run start`

## 2. Separate Datenbanken einrichten

### Production Database (bereits vorhanden):
1. In "production" Environment
2. Du solltest bereits eine PostgreSQL Database haben

### Development Database (neu erstellen):
1. Wechsle zu "development" Environment
2. Klicke auf **"+ New"** → **"Database"** → **"Add PostgreSQL"**
3. Railway erstellt automatisch eine neue Datenbank
4. Die `DATABASE_URL` wird automatisch als Environment Variable gesetzt

## 3. Environment Variables konfigurieren

### Für BEIDE Environments musst du folgende Variablen setzen:

#### Production Environment Variables:
```
NODE_ENV=production
SHOPIFY_API_KEY=<dein-production-api-key>
SHOPIFY_API_SECRET=<dein-production-api-secret>
SHOPIFY_API_VERSION=2025-10
SHOPIFY_SCOPES=read_legal_policies,write_legal_policies,read_locales,write_locales,read_markets,write_markets,read_online_store_navigation,write_online_store_navigation,read_online_store_pages,write_online_store_pages,read_product_listings,write_product_listings,read_products,write_products,read_content,write_content,read_themes,write_themes,read_translations,write_translations
SHOPIFY_APP_URL=${{RAILWAY_PUBLIC_DOMAIN}} oder deine Custom Domain
AI_PROVIDER=huggingface
HUGGINGFACE_API_KEY=<dein-key>
GOOGLE_API_KEY=<dein-key>
ENCRYPTION_KEY=<dein-encryption-key>
DATABASE_URL=${{Postgres.DATABASE_URL}} (automatisch gesetzt)
```

> **Hinweis**: Shop-Name und Access-Token werden automatisch aus der Datenbank-Session geladen (Multi-Tenant SaaS).

> **Öffentliche Website (SEO)**: Optional `PUBLIC_SITE_URL=https://<deine-domain>` nur in **Production** setzen. Canonical-Links, hreflang, Sitemap, robots.txt, llms.txt und strukturierte Daten zeigen dann immer auf diese eine Adresse, egal über welchen Host eine Seite aufgerufen wird. Ohne die Variable wird die aufgerufene Adresse verwendet. In **Development** `APP_ENV=development` gesetzt lassen: Dann schickt der Server auf jede Antwort `X-Robots-Tag: noindex`, damit die Dev-Kopie der Website nicht bei Google landet.

#### Development Environment Variables:
```
NODE_ENV=development
SHOPIFY_API_KEY=<dein-dev-api-key oder gleich wie prod>
SHOPIFY_API_SECRET=<dein-dev-api-secret oder gleich wie prod>
SHOPIFY_API_VERSION=2025-10
SHOPIFY_SCOPES=<gleiche wie oben>
SHOPIFY_APP_URL=${{RAILWAY_PUBLIC_DOMAIN}}
AI_PROVIDER=huggingface
HUGGINGFACE_API_KEY=<dein-key>
GOOGLE_API_KEY=<dein-key>
ENCRYPTION_KEY=<dein-encryption-key>
DATABASE_URL=${{Postgres.DATABASE_URL}} (automatisch von dev-database)
```

### Variables setzen:
1. Wähle die Environment aus dem Dropdown
2. Klicke auf dein Service
3. Gehe zu **Variables** Tab
4. Klicke **"New Variable"**
5. Füge alle Variablen hinzu

**Wichtig**: `DATABASE_URL` wird automatisch gesetzt wenn du die Postgres Database hinzufügst!

## 4. Domains einrichten

### Production Domain:
1. In "production" Environment
2. Gehe zu deinem Service → **Settings** → **Networking**
3. Klicke **"Generate Domain"** für Railway Domain
4. ODER füge eine **Custom Domain** hinzu
5. Diese URL verwendest du dann für `SHOPIFY_APP_URL` in Shopify Partners

### Development Domain:
1. In "development" Environment
2. Gehe zu deinem Service → **Settings** → **Networking**
3. Klicke **"Generate Domain"** für eine separate Railway Domain
4. Diese URL ist für Testing gedacht

### Öffentliche Webseite: `contentpilot-ai.com` (eingerichtet 2026-10-02)

Die Marketing-Seite läuft im Production-Service `Contentpilot`; die Domain ist
bei Infomaniak registriert und der DNS liegt dort (Infomaniak Manager →
Domains → `contentpilot-ai.com` → DNS-Zone). Mail (`info@contentpilot-ai.com`)
läuft ebenfalls über Infomaniak — deren MX/SPF/DKIM-Einträge in der Zone nicht
löschen.

| Railway Custom Domain | Port |
|---|---|
| `www.contentpilot-ai.com` | 8080 (wie `contentpilotai.up.railway.app`) |

DNS-Einträge bei Infomaniak (Name ohne Domain-Suffix):

| Typ | Name | Wert |
|---|---|---|
| CNAME | `www` | `pi3g5r7t.up.railway.app` |
| TXT | `_railway-verify.www` | `railway-verify=b85dc7fad0930d0d50ae74175ed4cfdf925e6cba31a82d9ec455a605daf1d41d` |

Die Hauptdomain ohne `www` hängt NICHT an Railway (das bräuchte ALIAS oder
CNAME-Flattening, und Infomaniaks DNS bietet kein ALIAS): sie ist bei
Infomaniak eine Web-Weiterleitung (Domain → Web-Weiterleitungen, 301) auf
`https://www.contentpilot-ai.com` — OHNE das Häkchen „auch www weiterleiten“,
das den CNAME oben überschreiben würde. Nach der Verbindung
`PUBLIC_SITE_URL=https://www.contentpilot-ai.com` im Production-Service
setzen (Sitemap- und Canonical-URLs der Webseite). Die App-URL in
`shopify.app.prod.toml` bleibt bewusst auf `contentpilotai.up.railway.app`.

## 5. Shopify App Configuration

### Production App:
- In Shopify Partners → Dein Production App
- App URL: Deine Production Railway Domain
- Allowed redirection URL(s): `https://<production-domain>/api/auth/callback`

### Development App (Optional aber empfohlen):
- Erstelle eine **separate Shopify App** für Development
- App URL: Deine Development Railway Domain
- Allowed redirection URL(s): `https://<development-domain>/api/auth/callback`
- Nutze die Dev-App Credentials in Development Environment

**Oder**: Nutze die gleiche App für beide Environments (weniger sauber aber einfacher)

## 6. Workflow Übersicht

### Entwicklung:
```bash
# Lokal arbeiten auf develop branch
git checkout develop

# Änderungen machen
# ... code änderungen ...

# Committen und pushen
git add .
git commit -m "feat: neue feature"
git push origin develop

# → Railway deployed automatisch zu Development Environment
# → Testen auf https://<dev-domain>
```

### Production Release:
```bash
# Nach erfolgreichem Test auf Development
git checkout master
git merge develop
git push origin master

# → Railway deployed zu Production Environment (je nach Config)
# → Oder manuell triggern im Railway Dashboard
```

### Manuelles Deployment triggern:
1. Gehe zu Railway Dashboard
2. Wähle Environment (production oder development)
3. Klicke auf dein Service
4. Klicke **"Deploy"** Button
5. Oder nutze: `railway up` (wenn CLI verbunden)

## 7. CLI Setup (Optional)

Falls du Railway CLI nutzen möchtest:

```bash
# Project verbinden (im Project-Root)
railway link

# Zu Development Environment wechseln
railway environment development

# Deploy manuell triggern
railway up

# Logs anschauen
railway logs

# Variables anzeigen
railway variables
```

## 8. Monitoring und Debugging

### Logs checken:
1. Railway Dashboard → Environment wählen → Service
2. **"View Logs"** Button
3. Oder: `railway logs` im Terminal

### Database verbinden:
```bash
# Zu Environment wechseln
railway environment development  # oder production

# Database Shell öffnen
railway connect Postgres
```

## Best Practices

1. **Niemals direkt auf master pushen** - immer erst auf develop testen
2. **Separate API Keys** für Dev/Prod wenn möglich (für Tracking)
3. **Database Backups** regelmäßig machen (Railway macht automatisch Snapshots)
4. **Environment Variables** niemals im Code committen
5. **Testing** immer zuerst auf Development Environment
6. **Production Deployments** nur nach erfolgreichem Testing
7. **Rollback**: Bei Problemen in Railway auf vorherige Deployment Version zurück

## Troubleshooting

### Fehlgeschlagene Migration beheben

`scripts/run-all-migrations.js` läuft vor dem Serverstart (`npm run start:production`), also bei **jedem** Containerstart. Schlägt
`prisma migrate deploy` fehl (typisch: P3009 nach einem abgebrochenen `CREATE INDEX CONCURRENTLY`), gilt:

- Verbindungsfehler (P1001, P1002, ECONNREFUSED) werden bis zu 3-mal mit Wartezeit wiederholt, andere Fehler nie.
- Sind **alle** Migrationen des Images trotzdem sauber angewendet (die fehlgeschlagene gehört zu einem neueren Image),
  startet der Container trotzdem und loggt `MIGRATE_DEPLOY_FAILED_BUT_SCHEMA_CURRENT` mit dem Namen der fehlgeschlagenen
  Migration. Der alte Container läuft also weiter, solange seine eigenen Migrationen angewendet sind, und gerät nach einem
  fehlgeschlagenen Deploy nicht in eine Absturzschleife.
  Achtung: Ist die neuere Migration nur zum Teil durchgelaufen, arbeitet der alte Container auf einem teilweise
  geänderten Schema. Das ist nur sicher, solange Migrationen rückwärtsverträglich sind (erst hinzufügen, später entfernen).
- Zusätzlich prüft der Start `pg_index` auf **ungültige Indizes** (nur im aktuellen Schema, mit blossem Indexnamen). Nur ein
  ungültiger Index, den eine **Migration dieses Images** anlegt (Name kommt in einem lokalen `migration.sql` als
  `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] <name>` vor, Gross-/Kleinschreibung egal), bricht den Start ab
  (Log: `MIGRATE_DEPLOY_FAILED_INVALID_INDEX` mit den Namen): eine von Hand mit `--applied` markierte Zeile kann auf einem
  kaputten Index sitzen. Ein Index, den ein **anderer Container gerade aufbaut**, erscheint ebenfalls als ungültig; gehört er
  zu diesem Image, wird das bewusst als Abbruch behandelt (sichere Richtung: der alte Container bleibt aktiv, der Neustart
  prüft erneut). Jeder **andere** ungültige Index (Index einer neueren Migration, anderer Besitzer, Rest eines
  `REINDEX CONCURRENTLY`) blockiert nicht: Der Start läuft weiter und loggt `MIGRATE_INVALID_INDEX_NOT_OURS names=...`.
  Sonst würde der alte Container nach einem abgebrochenen `CREATE INDEX CONCURRENTLY` eines neueren Deploys («Redeploy
  previous») dauerhaft abstürzen. Lässt sich `pg_index` nicht lesen: Gehört die fehlgeschlagene Migration zu einem neueren
  Image, läuft der Start weiter (Log `MIGRATE_INVALID_INDEX_UNKNOWN`), sonst gilt «nicht feststellbar» als Abbruch.
  Der Notfall-Schalter `ALLOW_DB_PUSH_FALLBACK` hebt die Abbruchprüfung nicht auf, denn `db push` repariert keinen
  ungültigen Index.
- Baut eine neuere Migration einen Index unter demselben Namen neu, den auch eine ältere Migration anlegt (`DROP INDEX CONCURRENTLY` + `CREATE INDEX CONCURRENTLY`), und wird sie abgebrochen, gilt der ungültige Index für das alte Image als eigener: Es bricht bei jedem Neustart ab. Vor «Redeploy previous» muss dann der ungültige Index entfernt und neu angelegt (oder die Migration aufgelöst) werden. Neue Migrationen sollten neu gebaute Indizes deshalb unter einem neuen Namen anlegen.
- Fehlt dem Image eine Migration, ist sie fehlgeschlagen oder lässt sich der Stand nicht lesen, bricht das Deploy mit
  Exit-Code 1 ab (Log: `MIGRATE_DEPLOY_FAILED`) und der alte Container bleibt aktiv.

Die Migrationen laufen beim Containerstart **genau einmal**: `npm run start:production` setzt für `start.js` die Variable
`MIGRATIONS_ALREADY_RUN=1` (direkt im Script, weil Umgebungsvariablen nicht zwischen den mit `&&` verketteten Prozessen
weitergegeben werden), und `start.js` überspringt dann `scripts/run-migration.js`. Dieses zweite Skript gibt es nur noch für
andere Startwege (`npm start`, Dockerfile-`CMD`); es nutzt dieselbe Entscheidung wie `run-all-migrations.js`
(`scripts/migrate-deploy-decision.js`): nach einem fehlgeschlagenen `migrate deploy` ist `db push` ohne
`ALLOW_DB_PUSH_FALLBACK=true` nirgends erreichbar, auch nicht bei aktuellem Schema.

Es gibt bewusst **keinen** stillen Wechsel auf `prisma db push`: der liesse ungültige (INVALID) Indizes und
fehlgeschlagene Migrationszeilen für immer stehen, würde spätere SQL-Backfills überspringen und spätere Indizes ohne
`CONCURRENTLY` bauen.

Manuelle Behebung (die Befehle laufen gegen die Produktionsdatenbank, z. B. mit `railway run <befehl>` aus dem
verknüpften Projekt oder mit gesetztem produktivem `DATABASE_URL`):

1. Fehlgeschlagene Migration finden:
   `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;`
2. Ungültigen Index finden: `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`
   Achtung: Die Abfrage listet auch einen Index, der **gerade aufgebaut wird**. Nichts löschen, solange ein Deploy oder
   eine Migration läuft. Danach den ausgegebenen Namen unverändert (ohne zusätzliche Anführungszeichen) verwenden:
   `DROP INDEX CONCURRENTLY IF EXISTS <ausgegebener_name>;` (ausserhalb einer Transaktion).
3. Enthält die Migration mehrere Statements mit `CONCURRENTLY`, bleiben die früheren Statements angewendet. Vor dem
   erneuten Lauf prüfen, was schon existiert, und Reste löschen; die Migration sollte `IF NOT EXISTS` verwenden.
4. Migration als zurückgerollt markieren:
   `npx prisma migrate resolve --rolled-back <migrationsname>`
5. Neu deployen (Redeploy), die Migration läuft dann erneut.

Notfall-Schalter: `ALLOW_DB_PUSH_FALLBACK=true` (genau dieser Wert) erlaubt nach einem
fehlgeschlagenen `migrate deploy` mit unvollständigem Schema den Fallback auf `prisma db push`. Nur setzen, wenn bewusst
in Kauf genommen wird, dass die oben genannten Altlasten bleiben; danach wieder entfernen.

### Build Fails:
- Checke Logs im Railway Dashboard
- Prüfe ob alle Environment Variables gesetzt sind
- Prüfe `package.json` scripts

### Database Connection Error:
- Prüfe ob `DATABASE_URL` korrekt gesetzt ist
- Prüfe ob Postgres Database läuft
- Prüfe ob Migrations gelaufen sind

### Shopify Auth Error:
- Prüfe `SHOPIFY_APP_URL` stimmt mit Railway Domain überein
- Prüfe Allowed Redirect URLs in Shopify Partners
- Prüfe API Keys sind korrekt

## Nächste Schritte

1. ☐ Railway Environments wie oben beschrieben einrichten
2. ☐ Development Database erstellen
3. ☐ Environment Variables für beide Environments setzen
4. ☐ Domains generieren
5. ☐ Deployment-Trigger konfigurieren
6. ☐ Test-Deployment auf Development machen
7. ☐ Nach erfolgreichem Test, Production deployen

---

Bei Fragen oder Problemen, checke die Railway Docs: https://docs.railway.app/
