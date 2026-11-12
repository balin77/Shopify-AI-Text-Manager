# Fehlende Übersetzungen ergänzen: Paketierung, höhere Limits, Caching, Batch-API — Plan

**Status:** GEPLANT (2026-11-12), Recherche auf Branch `fix/pre-prod-hardening` (= `origin/develop` 9a85dd66). Nichts davon ist gebaut. **Revision 2 (2026-11-12, nach Re-Review; massgeblich ist §19, es überschreibt ältere Absätze, wo beide etwas anderes sagen)**, davor Revision 1 (2026-11-12) nach unabhängigem Opus-Review: Reihenfolge und Phasen umgebaut (§11), Review-Rails neu (§17, mit Prüfung jedes Befunds gegen den Code in §17.0), Restrisiken und Altlasten neu (§18), Owner-Entscheide in §16 festgehalten. Auftrag vom Owner (genehmigt): die bestehende Seite `/app/bulk/translate` ([app.bulk_.translate.tsx](../../app/routes/app.bulk_.translate.tsx)) so günstig wie möglich machen. Es gibt KEINE neue Route und KEINEN neuen Task-Typ (Working Agreement); alles hängt an `/api/ai` (`bulkEditorTranslate`), der Seite selbst und dem bestehenden Task `bulkEditorTranslate`.

> Hinweis: Zeilennummern gelten für 9a85dd66; bei Änderungen nach Symbol neu verankern. Wo etwas **GEMESSEN** heisst, ist es aus dem Code oder aus dem installierten SDK in `node_modules` abgelesen, nicht aus einem Live-Lauf. Was eine Provider-API tut, lässt sich aus dieser Sandbox nicht messen (siehe §8).

---

## 0. Kurzfassung

1. Heute kostet jede Zeile eigene KI-Aufrufe (`translateShortFieldsBatch` + `translateFieldsToLocalesChunked` + je Zelle Sonderwege). 100 Produkte mit vier Feldern in drei Sprachen sind rund 200 Aufrufe, jeder mit Anweisungen und Glossar. Auf einem Claude-Schlüssel mit den Standardgrenzen (5 Anfragen und 40 000 Token pro Minute, [ai-queue.service.ts](../../src/services/ai-queue.service.ts) L216-219) braucht das über 40 Minuten, **weil die Queue jeden Aufruf mit pauschal 8192 Ausgabe-Token zählt** ([ai.service.ts](../../src/services/ai.service.ts) L2557), nicht wegen der echten Menge.
2. Ziel Phase 1: gleichartige Felder vieler Einträge in ein Paket (ID-gemappt, einzeln verifiziert, Fehlendes in kleineren Paketen nachgeholt), Ausgabegrenze je Modell statt fix 8192, Ergebnisse laufend schreiben statt am Ende, Kostenvorschau vor dem Start, Prompt-Caching dort, wo es sich rechnet.
3. Ziel Phase 2: Batch-API („günstiger, Ergebnis bis zu 24 h") für Anthropic und OpenAI; der Händler wählt im Start-Dialog. Zustand liegt im bestehenden Task (`status = waiting_batch`, JSON in `Task.result`), eingesammelt von einem Tick nach dem Muster von `TranslationDriftAutoRunService`. Kein Schema-Umbau für die Batch-Daten.
4. Limit-Entscheid: `MAX_TRANSLATE_UNITS` 2000 -> **10 000** (erst nach gemessener Blockzeit, §11), `MAX_TRANSLATE_CANDIDATE_ITEMS` bleibt **500**, `MAX_TASK_CALLS` bleibt 2000, gilt aber **je Schreib-Block**, nicht je Lauf (§7). Voraussetzung: laufendes Schreiben (Phase 1c).
5. Ehrlich vorab: Bei **langen** Feldern (Beschreibungen) bringt Paketierung wenig, weil die Ausgabe-Token der Hauptkostenpunkt sind und bleiben. Die grossen Hebel dort sind Batch-API (halber Preis) und das gewählte Modell. Paketierung lohnt bei kurzen Feldern, Metafeldern, Optionswerten und beim Wegfall der wiederholten Anweisungen/Glossare.

---

## 1. Ist-Zustand (aus dem Code gemessen)

### 1.1 Ablauf eines Laufs

| Schritt | Ort |
|---|---|
| Seite: Start-Button, kein Dialog, keine Kostenangabe; Zusammenfassung „n Übersetzungen ausgewählt" | [app.bulk_.translate.tsx](../../app/routes/app.bulk_.translate.tsx) `handleStart` L356, Ergebnis-Poll L390-396, Karte mit Start-Button L610-625 |
| Plan Pro im Loader und im Handler; `/api/ai` prüft Inhaltstyp-Plan und `aiRefusalFor` | Loader L131-137; Handler [bulk-editor-translate.handler.ts](../../app/routes/api-ai-handlers/bulk-editor-translate.handler.ts) L113-117; [api.ai.tsx](../../app/routes/api.ai.tsx) L133-158 |
| Zielsprachen = ALLE nicht-primären Shop-Sprachen, veröffentlicht oder nicht (der Handler filtert nur `!l.primary`, L139-141; sein Kommentar sagt "published", der Code nicht; die Seite sagt es ausdrücklich, L160-163); Spalten = `translateCandidateColumns` über das serverseitige Spaltenuniversum | Handler L129-174 |
| Single-Flight je Shop (`pending`/`running`) | Handler L177-191; Seite L190-193 |
| Erneuter Scan (`scanMissingTranslations`, `withSources`), Auswahl darüber gelegt, `buildJobs` mit Kappung | Handler L195-209, `buildJobs` L280-335 |
| Task `bulkEditorTranslate`, `status: running`, `total: units`, `expiresAt = getTaskExpirationDate()` (3 Tage) | Handler L211-224 |
| Detached `runBulkEditorTranslate`, Heartbeat-Timer 15 s (`BULK_TRANSLATE_HEARTBEAT_MS` L405, `beat` L507) | Handler L226-251, L408 ff. |
| **Eine Schleife über die Zeilen**: je Zeile Gruppen `short`, `long`, `grouped` (productType), `sub` (Metafelder/Optionen) | L513-697 |
| Alle Ergebnisse landen in EINEM `diff`; **ein einziges `applyBulkDiff` ganz am Ende** | L744-760 |
| Terminalstatus bedingt (`updateMany where status: running`), Fehlercodes `rows_failed:<n>` / `managed_ai_refused:<grund>` | L799-824 |

### 1.2 KI-Aufrufe je Zeile (Kostentreiber)

- **Kurz** (`title`, `seoTitle`, `handle`; Zeile 85 `SHORT_FIELDS`): `translateShortFieldsBatch(payloadOf(short), primary, unionLocales(short), contentType, instructionsFor(...))` ([ai.service.ts](../../src/services/ai.service.ts) L1262). EIN Aufruf pro Zeile. Der Prompt trägt Anweisungen und Glossar jedes Mal (L1330-1347). Kein Stop-Reason-Check, Vollständigkeit nur über `assertNestedComplete`.
- **Lang** (alles übrige, Beschreibungen, mehrzeilige Metafelder, Metaobjekt-Text): `translateFieldsToLocalesChunked` (L2397): passt die Zeile in `CHUNK_THRESHOLD_CHARS` (= floor(8192 x 3 x 0.85) = 20 889 Zeichen, [constants.ts](../../app/config/constants.ts) L148-206, `fitsOneRequest`), ein Aufruf; sonst Sprach-Chunks, Feldgruppen und je Sprache `translateContent` für ein einzelnes Riesenfeld (L2455-2480). Bis zu `MAX_CONCURRENCY` = 3 parallel (L237).
- **productType**: einmal je verschiedenem Quelltext pro Lauf über `GroupedFieldTranslationService` (L859-927, eigener Cache `productTypeCache`); Aufruf = `translateShortFieldsBatch` mit einem Feld.
- **Metafelder/Optionen** (`isBatchSubResourceColumn`, L354): `translateBatchValuesToLocales` ([ai.service.ts](../../src/services/ai.service.ts) L1504) je Zeile und Sprach-Signatur; nummerierte Liste, Obergrenze `VALUE_BATCH_MAX_ITEMS = 40` (constants.ts L231), Abbildung nach Index. Optionswerte-Zellen sind EINE Zelle über N Werte (`LIST_DISPLAY_SEPARATOR`, `mergeExistingListValues` L366).
- **Zeilenübergreifend wird nirgends gebündelt.** Nur productType hat einen Lauf-Cache.

### 1.3 Ausgabegrenze, Timeout, Queue

- `TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS = 8192` für ALLE Provider und Modelle ([constants.ts](../../app/config/constants.ts) L148, Begründung L152-172: schwächstes wählbares Modell, `gpt-4-turbo` 4096). Verwendet in jedem Provider-Zweig ([ai.service.ts](../../src/services/ai.service.ts) L3502-3679). Modelle sind live listbar ([ai-models.config.ts](../../app/config/ai-models.config.ts): `CURATED_MODELS` nur Fallback, `api.ai-models` holt live), ein Händler kann also JEDE Modell-ID wählen; eine Fähigkeitstabelle muss mit "unbekannt" umgehen.
- Backstop-Timeout `AI_REQUEST_TIMEOUT_MS = 120_000` (ai.service.ts L152), SDK-`maxRetries = 2`. **Das begrenzt die nutzbare Paketgrösse ebenso wie `max_tokens`**: bei ~50-80 Token/s sind 120 s etwa 6-10k Ausgabe-Token. Eine höhere Ausgabegrenze ohne höheres Timeout liefert Zeitüberschreitungen, die der Zähler als Worst-Case-Kosten bucht (`meteredAttempt`, L2960 ff.).
- Queue: Schätzung = Prompt/4 + **flat 8192** (`estimateTokens`, L2553-2559). Standard-Buckets: Claude 5 RPM / 40 000 TPM, OpenAI 500 / 200 000, Gemini 15 / 1 000 000, Grok/DeepSeek 60 / 100 000 (ai-queue.service.ts L208-230; pro Händler aus `*MaxTokensPerMinute` überschreibbar, L294-324). `canExecute` lässt eine Anfrage nur zu, wenn `usage + estimate <= maxTokensPerMinute` (L483-499): **eine Schätzung grösser als das Minutenlimit würde nie zugelassen**. Paketgrösse muss also unter dem TPM-Limit des Buckets bleiben (Rail, §3.2). NICHT geprüft: wie `enqueue` einen solchen Fall behandelt; in Phase 1a gezielt nachlesen/testen.

### 1.4 Prompt-Aufbau und Caching

- Jeder Prompt ist EINE User-Message (`messages: [{role:'user', content: prompt}]`, ai.service.ts L3586-3600), **Reihenfolge: Felder zuerst, dann Anweisungen, Glossar, JSON-Skelett** (L1330-1347, L2323-2338). Es gibt keinen stabilen Präfix; weder Anthropic-`cache_control` noch `system` wird irgendwo gesetzt. Der Code sagt es selbst: „This app uses no prompt caching; adopting it means adding them here or silently under-counting" (L3610-3612).
- Das Glossar wird PRO AUFRUF aus den Quelltexten gefiltert (`getGlossaryDirective` -> `buildGlossaryDirective(rules, sourceTexts, locales)`, [glossary.service.ts](../../src/services/glossary.service.ts) L328; Begrenzung `MAX_TERMS_IN_PROMPT`). Folge: ein Präfix wäre nie zwischen Aufrufen identisch.
- SDK-Stände (installiert, `node_modules`): `@anthropic-ai/sdk` 0.71.2, `openai` 6.17.0, `@google/generative-ai` 0.24.1, `@huggingface/inference` ^4.13.5. Anthropic: `cache_control: { type: 'ephemeral', ttl? '5m'|'1h' }` und `usage.cache_creation_input_tokens` / `cache_read_input_tokens` vorhanden (messages.d.ts L67-89, L323-327, L738-742). OpenAI: `usage.prompt_tokens_details.cached_tokens` vorhanden (completions.d.ts L144).

### 1.5 Zähler und Preise (managed Budget)

- `AiCallUsage = { inputTokens, outputTokens, model, source }` ([ai.service.ts](../../src/services/ai.service.ts) L10-18), Claude liest `message.usage.input_tokens/output_tokens` (L3606-3612; **diese schliessen Cache-Token aus**), OpenAI-artige `prompt_tokens/completion_tokens` (`reportChat` L3478-3492). Gemini `usageMetadata`.
- `priceCall(provider, model, in, out)` kennt nur zwei Sätze, Aufrunden auf Mikro-Euro, unbekanntes Modell = Provider-Obergrenze ([ai-pricing.ts](../../app/config/ai-pricing.ts) L142-167, L116-124). `UNPRICED_PROVIDERS = {huggingface}`.
- `recordAiUsage` ([usage-meter.server.ts](../../app/services/ai/usage-meter.server.ts) L203 ff.) upsertet `AiUsageCounter` (Schlüssel `shop, period, source, provider, model, feature, estimated`), addiert `taskId`-Summen und, für `managed`, den globalen Pool. Spalten: `calls, inputTokens, outputTokens, costMicros, billedMicros` (schema.prisma L1796-1815). **Keine Cache-Spalten, kein Batch-Tarif.**
- Managed-Gate pro Aufruf: `managedPreflight` ([ai-credentials.server.ts](../../app/services/ai/ai-credentials.server.ts) L654 ff.) prüft vor JEDEM Aufruf Einwilligung, Kill-Switch, Periodenbudget, globalen Pool. Überschiessen ist begrenzt durch "ein Aufruf darf nur STARTEN, solange Restbudget > 0" x Parallelität x teuerster Aufruf. **Diese Eigenschaft gilt für Batch NICHT** (tausende Anfragen starten gleichzeitig), siehe §6.3.
- Managed-Provider heute: nur OpenAI und Anthropic (`CONSENTED_MANAGED_PROVIDERS`, managed-ai.shared.ts L45). Batch ist für beide technisch vorhanden (§5.1).

### 1.6 Schreibseite und Wiederanlauf

- `applyBulkDiff` ist der einzige Schreibweg; fremde Locales laufen über `registerAndVerify` (Echo-Prüfung, Digest, DB-Spiegel, `markTranslationSaved`). Eine Fremdsprach-Gruppe `(Zeile, Locale)` = 1 `translationsRegister` (+ Digest-Batch); Sub-Resource-Zellen kosten je Ziel-Ressource ein Register ([columns.shared.ts](../../app/services/bulk-editor/columns.shared.ts) `estimateCalls` L2209-2345).
- `buildJobs` zählt Aufrufe PRO ZELLE und Sprache (L312: `locales.length * shopifyTargetsPerLocale`) — das ist strenger als `estimateCalls`, das nach Gruppen zählt. Praktisch gilt also nur das Einheiten-Limit (2000 Einheiten = 2000 Aufrufe), ausser bei Optionswerten.
- `MAX_TRANSLATE_UNITS = 2000`, Kandidatenfenster `MAX_TRANSLATE_CANDIDATE_ITEMS = 500`, Scan `MAX_TRANSLATE_SCAN_ROWS = 5000` ([translate-missing.shared.ts](../../app/services/bulk-editor/translate-missing.shared.ts) L34-46). Bei 6 Feldern x 3 Sprachen sind 2000 Einheiten ~110 Einträge: **das Einheiten-Limit, nicht das Item-Fenster, ist die bindende Grenze.**
- Der CSV-Import läuft als `seoBulkMeta`-Task in **Blöcken**, die je in die zwei Grid-Kappen (`MAX_BULK_TASK_ITEMS` 500 Zellen, `MAX_TASK_CALLS` 2000) passen (`chunkImportDiff`, [csv-import-run.server.ts](../../app/services/bulk-editor/csv-import-run.server.ts) L63-98), und dokumentiert sich selbst als wiederaufnehmbar. Der Übersetzungslauf schreibt dagegen alles am Ende: ein Neustart während der KI-Phase verliert **alles Übersetzte** (CLAUDE.md: "Translations produced but not yet written are lost").
- Orphan-Rails: `bulkEditorTranslate` ist `BOOT_ORPHAN_TASK_TYPES` ([orphan-run-recovery.js](../../orphan-run-recovery.js) L74): beim Boot nur bei 90 s Stille und `createdBefore` Prozessstart, im laufenden Betrieb Reaper nach 5 min Heartbeat-Stille, Fehler `task_interrupted`. Sie betreffen nur `status = running`. Tasks werden nach `expiresAt` an DREI Stellen gelöscht, nicht an einer: [task-cleanup.service.js](../../task-cleanup.service.js) L64-96, [sync-scheduler.service.ts](../../app/services/sync-scheduler.service.ts) L633, [scripts/cleanup-database.js](../../scripts/cleanup-database.js) L38. Das Nachziehen von `expiresAt` (§5.2) muss alle drei abdecken; ein Test nennt alle drei.
- Hintergrund-Ticks: Singleton-Dienste mit `start()` aus [shopify.server.ts](../../app/shopify.server.ts) L286/L389 (`TranslationDriftAutoRunService`, `OfflineTokenSweepService`): Intervall-Timer, Env-Schalter zum Abschalten, Per-Tick-Kappe, Backoff-Stempel.

---

## 2. Ziel

- Kosten je Übersetzung deutlich senken, ohne eine Schreibregel zu lockern: nur leere Werte füllen, nie überschreiben, jeder Eintrag einzeln verifiziert, nichts Falsches schreiben, Handle-Regeln (Opt-in, Slug-Normalisierung, Duplikatschutz), Managed-Stand-down, Heartbeat, bedingte Terminal-Updates bleiben.
- Der Händler sieht VOR dem Start, was ein Lauf ungefähr kostet, und kann „sofort" oder „günstiger, Ergebnis bis zu 24 h" wählen.
- Ein Neustart verliert höchstens den laufenden Schreib-Block, nie den ganzen Lauf; ein Batch beim Provider überlebt den Neustart.
- Nicht-Ziele: kein neuer Task-Typ, keine neue Route, kein Markt-Support (bleibt global, wie heute), keine Änderung der Scan-Regeln, kein Überschreiben vorhandener Übersetzungen, kein automatischer/geplanter Lauf (Roadmap-Eintrag existiert separat).

---

## 3. Design Phase 1 (sofort-Modus)

### 3.1 Paketierung über Einträge hinweg

**Neues, reines Modul** `app/services/bulk-editor/translate-packages.shared.ts` (importfrei bis auf Konstanten, damit Client und Server es für die Vorschau teilen):

- Eingang: die `TranslateJob[]` aus `buildJobs`, Zielsprachen, ein Callback `instructionsFor(fieldKeys)`, `ModelLimits` (§3.2).
- Zerlegung der Zellen in **Einträge** `{entryId, rowId, columnId, fieldKey, kind, source, locales, slice?}`:
  - `kind = short`: `title`, `seoTitle`, `handle` (eigene Gruppe wegen Slug-Regel), productType (eigene Gruppe, weiter über `GroupedFieldTranslation`: erst nur die verschiedenen Quelltexte des Laufs, Cache-Treffer entfallen, nur Fehlende ins Paket, danach `upsertMany`).
  - `kind = value`: einzeilige Metafeld-/Optionswerte (Optionswerte-Zellen werden in ihre Teile zerlegt, `slice` merkt Start/Länge; `mergeExistingListValues` bleibt).
  - `kind = long`: Beschreibungen/HTML, mehrzeilige Metafelder, Metaobjekt-Text.
- **Gruppenschlüssel** = `(kind, instructionsFor([fieldKey]), Sprach-Signatur)`. Das ist die Regel "Pakete gruppieren nach Anweisungssatz": `instructionsFor` hängt von den SEO-Kappen je Feldschlüssel ab (`buildTranslateInstructions`, Handler L437-443); zwei Felder mit anderer Kappe dürfen nie in einem Paket liegen, sonst gilt eine Anweisung für ein Feld, das sie nicht meint. Die Sprach-Signatur wie bisher bei `sub` (Scan antwortet pro Zelle, Zeilen können unterschiedliche Sprachen fehlen); ein Paket übersetzt nie in eine Sprache, die kein Eintrag braucht. Fragmentierung wird geloggt; eine spätere Zusammenführung kleiner Gruppen über die Vereinigung ist erlaubt, solange der zusätzliche Output <= 25 % bleibt (Stellschraube, nicht Teil von 1b).
- **Packen**: Einträge einer Gruppe in Scan-Reihenfolge, Paket voll bei (a) Ausgabeschätzung `sum(estimateOutputChars(source, locales))` > Ausgabebudget, (b) Eingabeschätzung > Eingabebudget, (c) Anzahl > `PACKAGE_MAX_ITEMS` (Start 40 für short/value wie `VALUE_BATCH_MAX_ITEMS`; lange Felder haben durch (a) ohnehin 1-6 Einträge). Ein Eintrag, der allein nicht passt, bekommt ein Einzelpaket und läuft über den bestehenden Einzelweg (`translateContent` je Sprache). Das Limit 40 ist der Erfahrungswert des bestehenden Wertepfads, NICHT neu gemessen; Telemetrie (Retry-Quote je Gruppe) steuert die Nachjustierung.
- **Anweisungen einmal je Gruppe im Präfix, Glossar je Paket im variablen Teil (M1, gegenüber der ersten Fassung korrigiert).** Ein Gruppen-Glossar aus hunderten Quelltexten wäre falsch: `buildGlossaryDirective` ist auf `MAX_TERMS_IN_PROMPT` (200) Begriffe begrenzt, der Shop darf mehr speichern (500), und ein Gruppen-Glossar würde die Begriffe des einzelnen Pakets verdrängen. Das Glossar wird deshalb je Paket aus den Quelltexten DIESES Pakets gebaut und steht im variablen Teil. Gecacht wird nur der stabile Teil: Regeln + Anweisungen des Händlers (§3.5). Glossar-Caching entfällt bewusst.

**Prompt-Form** (neue Methode `AIService.translatePackage(group, entries, locales, opts)`; die alten Methoden bleiben für Einzelweg und die Editoren unverändert):

```
[stabiler Präfix]  Aufgabe + Regeln (HTML-Regel, Slug-Regel, "jeder Eintrag in jede Sprache")
                   + Anweisungen des Händlers
[variabler Teil]   Glossar dieses Pakets +
                   {"items":[{"id":"k1","text":"..."},{"id":"k2","text":"..."}]}
Antwort            {"k1":{"de":"...","fr":"..."},"k2":{...}}
```

- IDs sind paketlokale kurze Schlüssel (`k1..kN`), NICHT Indexe und nicht Zeilen-GIDs; die Abbildung auf `(rowId, columnId, Slice)` bleibt im Aufrufer. Doppelte Quelltexte werden vor dem Packen dedupliziert (gleicher Text, gleiche Sprachen -> ein Eintrag, Ergebnis wird auf alle Zellen verteilt), analog zum productType-Cache.
- Der stabile Präfix (Regeln, Anweisungen) steht ZUERST, damit OpenAI-Prefix-Caching und Anthropic-`cache_control` greifen können (§3.5).

**Verifikation je Eintrag** (neues Modul `translate-package-verify.shared.ts`, rein, voll testbar):

1. Alle IDs und alle verlangten Locales vorhanden, Werte sind nicht-leere Strings; unbekannte Zusatz-IDs oder -Locales werden verworfen.
2. Kurz/Wert: kein Zeilenumbruch, Länge im Verhältnis zur Quelle plausibel (Obergrenze z. B. 4 x Quelle + 20), geschützte Tokens (`{{...}}`, `%s`, Shortcodes `[...]`, wie sie in der Quelle stehen) bleiben gleich; Handle: `handlesByLocale` wird zu Laufbeginn je Ziel-Locale aus den gespiegelten Handle-Übersetzungen des Shops (`ContentTranslation key=handle`) **vorbelegt** (H6; heute beginnt die Menge leer, der Duplikatschutz gilt nur innerhalb des Laufs); ein Handle-Eintrag wird mit dem Titel derselben Zeile in dasselbe Paket gepackt (M7: der Titel gibt der Slug-Übersetzung Kontext); danach unverändert die bestehende Normalisierung (`normalizeTranslatedHandle`, `dedupeHandle`, Gleich-wie-Primär -> `skippedHandles`).
3. Lang/HTML: HTML-Skelett-Vergleich: Multiset der Tag-Namen gleich, `href`/`src`/`id`/`class`-Werte unverändert erhalten, Zeilenzahl bei mehrzeiligen Nicht-HTML-Feldern gleich. Das ist strenger als der heutige Pfad (der nur "Prompt sagt: Tags beibehalten" hat) und deshalb der Ort, wo Paketierung eine neue Fehlerklasse (vertauschte Einträge) abfangen muss.
3b. **Vertauschte Einträge bei ähnlichen kurzen Feldern (H3):** je Eintrag Multiset-Vergleich von Ziffern/Zahlen, SKU-artigen Tokens und geschützten Tokens zwischen Quelle und Übersetzung (andere Zahlen als in der Quelle = verdächtig, Nachholleiter); jede Quelle läuft vor dem Packen durch `sanitizePromptInput`; die Retry-Quote je Gruppe wird gezählt und geloggt. Gestandener Rest: zwei Einträge mit gleichen Zahlen und ähnlichem Wortlaut, deren Übersetzungen vertauscht zurückkommen, sind nicht erkennbar (§18).
4. Der bestehende Echo-Schutz: lange Einträge (>= `ECHO_FAILURE_MIN_CHARS` = 200) unverändert zurück = verworfen; kurze identische bleiben (Eigennamen).
5. **Abgeschnittene Antwort** wird erkannt: Anthropic `stop_reason === 'max_tokens'`, OpenAI-artig `finish_reason === 'length'`, Gemini `finishReason === MAX_TOKENS`. Heute prüft der Code das nirgends (nur "leer"). Ein abgeschnittenes Paket zählt als Ganzes fehlgeschlagen, auch wenn der JSON-Anfang parst.

**Nachholleiter** (nie falsch schreiben): Paket fehlerhaft oder unvollständig -> fehlende/ungültige Einträge als **halbiertes** Paket erneut (max. Tiefe 2), danach einzeln über den bisherigen Einzelweg (`translateShortFieldsBatch`/`translateContent`), danach Zellfehler `AI returned no translation.` mit Sprache. Provider-Schlüssel abgelehnt (`isRunAbortingAIError`) und Managed-Verweigerung (`isManagedRefusal`, `isAIQueueShuttingDown`) brechen wie heute den Lauf ab bzw. stehen den Lauf herunter, nie als "Eintrag fehlgeschlagen" behandeln. Quelle nie als Übersetzung einsetzen (bestehende Regel, Handler L664-669).

**Ablauf im Handler**: Die Zeilenschleife (L513) wird ersetzt durch: (1) Pakete planen, (2) Pakete mit `MAX_CONCURRENCY` = 3 Workern durch die Queue schicken (jeder Worker prüft `managedRefusal` vor dem nächsten Paket), (3) Ergebnisse je Paket verifizieren und in einen Schreib-Puffer legen. `failGroup`/`failedColumnIds`/`failedCellLocales` werden zu "Fehler je Eintrag und Sprache".

### 3.2 Pro-Lauf-Ausgabegrenze je Provider/Modell

- Neues, clientsicheres Modul `app/config/ai-model-limits.ts` (Schwester von `ai-pricing.ts`, gleiche Regel "unbekannt = vorsichtig"): `maxOutputTokensFor(provider, model): number` aus einer datierten Tabelle (`LIMITS_CHECKED_ON`), Standard bei unbekanntem Modell = **heutiger Wert 8192** (nicht höher: ein Händler kann beliebige Live-Modelle wählen, eine zu hohe Annahme ist eine abgeschnittene Antwort). Erste Tabelle (RECHERCHE-STAND, vor Einbau gegen die Provider-Dokumentation zu prüfen, nicht aus der Sandbox verifizierbar): Claude Haiku/Sonnet 4.x grosse Ausgabe (>= 32k), `gpt-4o`/`gpt-4o-mini` 16 384, `gpt-4-turbo` 4096, `gpt-5*`/`o3-mini` grosse Werte (zählen Reasoning mit, `openAiChatParams` setzt `reasoning_effort: 'minimal'` für gpt-5), Gemini 2.0 Flash(-Lite) 8192, 2.5 Flash/Pro 65 536, `deepseek-chat` 8192, HuggingFace/Grok: Standard 8192. Jeder Eintrag trägt eine Quelle/ein Datum.
- Paket-Ausgabebudget (Tokens) = `min(maxOutputTokensFor(...) x 0.6, PACKAGE_OUTPUT_CAP)` mit Sicherheitsmarge 0.6 (das Projekt rechnet bewusst pessimistisch mit 3 Zeichen/Token, `CHARS_PER_OUTPUT_TOKEN`). `PACKAGE_OUTPUT_CAP`: **Sofort-Modus ~5 000 Token** (Dauer-Dimensionierung 120-180 s, siehe H5 unten), **Batch-Modus 32 000** (kein Timeout-Thema; Qualität grosser Pakete nicht gemessen). Die früher genannten 16 000 für Sofort gelten NICHT mehr.
  - Warum nur ~5 000 im Sofort-Modus: der Timeout (120-s-Backstop, §1.3; SDK-`maxRetries` 2; app-weite Queue-Slots, siehe H5) begrenzt die Paketgrösse stärker als die Modellgrenze. Die Anthropic-SDK-Schutzprüfung für nicht gestreamte Aufrufe mit sehr hohem `max_tokens` (aus dem Gedächtnis, NICHT gemessen) spielt bei ~5 000 keine Rolle. Timeout pro Anfrage: `timeoutMs = clamp(plannedOutputTokens / 30 tok/s + 30 s, 120 s, 240 s)` (30 Token/s bewusst pessimistisch, NICHT gemessen), als SDK-Request-Option. Backstop in `meteredAttempt` und Worst-Case-Buchung (`worstCaseUsage`) verwenden das gesendete `max_tokens`.
  - Batch-Modus: kein Timeout-Thema, daher 32 000; Qualität grosser Pakete NICHT gemessen, Retry-Quote steuert.
- **TPM-Rail**: Paket-Gesamtschätzung (Eingabe + geplante Ausgabe) <= 0.8 x `maxTokensPerMinute` des Buckets (ai-queue `rateLimits`), sonst würde das Paket nie zugelassen (§1.3). Auf dem Claude-Standard (40 000 TPM) heisst das: Pakete bis ~32k gesamt, praktisch 1 Anfrage pro Minute, und das ist **immer noch** um Grössenordnungen besser als ~4 pauschal geschätzte 8192-Aufrufe pro Minute.
- **Queue-Schätzung korrigieren**: `askAI` bekommt optionale `{ plannedOutputTokens }`; `estimateTokens` nimmt dann `prompt/4 + plannedOutputTokens x 1.1` statt flat 8192. Das ist der eigentliche Durchsatzgewinn auf kleinen Schlüsseln. Unterschätzen ist hier nicht gefährlich (der Provider zählt echt, 429 werden von der Queue wiederholt), aber nie unter die echte Eingabe.
- **Timeout-Rechnung korrigiert (H5).** Die erste Fassung hob den Timeout auf bis 600 s. Der Anthropic-Client hat `maxRetries: 2` (ai.service.ts L153, L720): ein Aufruf kann dreimal den Timeout verbrauchen, ein globaler Queue-Slot wäre ~30 min belegt, und `AI_QUEUE_CONCURRENCY` (Standard 4, ai-queue.service.ts L118-131) gilt app-weit für ALLE Shops. Neu: **Sofort-Pakete werden auf eine erwartete Dauer von ~120-180 s dimensioniert** (geplante Ausgabe ~4 000-6 000 Token bei der pessimistischen Annahme 30 Token/s, NICHT gemessen); die 16 000 aus dem Absatz oben gilt nur für den Batch-Modus (32 000) und nicht mehr für Sofort. Je Shop läuft **höchstens EINE lange Anfrage** gleichzeitig (Worker-Pool 1 für `kind=long`, bis 3 für kurze). Der Timeout wird als **SDK-Request-Option** je Anfrage gesetzt (`{ timeout }` an `create`), `maxRetries` für Paketaufrufe auf 0 (die Nachholleiter §3.1 übernimmt das Wiederholen). Streaming bleibt eine spätere Option. `meteredAttempt`/`worstCaseUsage` buchen bei Zeitüberschreitung den Worst Case mit dem **tatsächlich gesendeten** `max_tokens`.
- **Queue-Rails (H4, Phase 1a).** (i) Eine Schätzung über dem TPM-Limit des Buckets wird nie zugelassen, und `enqueue` hat keinen Zulassungs-Timeout (Altlast, §18): die Anfrage hängt unbegrenzt. Paketplanung hält die Schätzung unter 0.8 x TPM, und `enqueue` bekommt einen Zulassungs-Timeout mit klarem Fehler; passt selbst ein Einzeleintrag nicht, wird er gesplittet oder als Zellfehler `request_too_large` gemeldet. (ii) BYO-Buckets sind **global je Anbieter** (`byo:<provider>`, ai-queue.service.ts L91-93), nicht je Händler: zwei Shops mit eigenem Claude-Schlüssel teilen 5 RPM/40k TPM. Das ist heute so, wird hier nicht geändert und steht in §18; die TPM-Rail kennt die Auslastung durch andere Shops nicht. (iii) Höchstens ein grosses Paket (> 25 % des TPM-Limits) je Shop gleichzeitig in der Queue.
- **Failover**: ein Aufruf kann auf dem Failover-Modell landen (`runOnFailover`, ai.service.ts L3040 ff.). Dessen Grenze kann kleiner sein; `max_tokens` wird auf `min(angefragt, maxOutputTokensFor(servedProvider, servedModel))` geklemmt. Eine dadurch abgeschnittene Antwort ist ein Verify-Fehler (Stop-Reason), kein Schreiben.
- **`savePromptToTask` begrenzen**: die Methode liest die gesamte Prompt-Historie des Tasks, hängt jeden Prompt an und schreibt alles zurück (ai.service.ts L2679 ff.); mit grossen Paketen wächst `Task.prompt` auf viele MB und jeder Aufruf schreibt es komplett neu (quadratisch). Für Paketaufrufe wird nur ein gekürzter Eintrag (erste ~2 000 Zeichen + Länge) gespeichert, die Historie auf die letzten 20 Einträge begrenzt.
- Weiterreichen: `AIService._executeAIRequestInner` bekommt `options = { maxOutputTokens, system, cachePrefix }`; alle bestehenden Aufrufer ohne Optionen verhalten sich byte-gleich (Test).

### 3.3 Laufendes Schreiben statt Schreiben am Ende

- Schreib-Puffer wird in **Blöcken** an `applyBulkDiff` gegeben: sobald `>= 250` Zellen oder `>= 60 s` seit dem letzten Schreiben, jeweils nach Zeile sortiert, und jeder Block passt in die zwei Grid-Kappen (Wiederverwendung von `chunkImportDiff`, nach `bulk-editor/diff-chunks.server.ts` verschieben und aus dem CSV-Import importieren, damit es nicht zwei Kopien gibt). `handlesByLocale` überlebt die Blöcke (Lauf-Zustand).
- Eine Zeile kann über zwei Blöcke verteilt sein (ihre Zellen kommen aus verschiedenen Paketen). Das ist korrekt (jeder Block ist eine eigene Fremdsprach-Gruppe), kostet höchstens einen zusätzlichen Register-Aufruf je Zeile und Locale; die Block-Sortierung nach Zeile hält das klein.
- Fortschritt: `processed` zählt Einheiten, deren Ergebnis feststeht UND geschrieben oder als Fehler gebucht ist; Fortschritt 0-99 % bis zum Ende (kein getrenntes 80/20-Fenster mehr). Heartbeat-Timer bleibt unverändert (unabhängig vom Fortschritt, weil ein Paket Minuten dauern kann).
- Folge für den Neustart: bereits geschriebene Blöcke sind geschrieben; ein Neustart des Laufs findet sie im Scan nicht mehr (nur Leeres wird gefüllt) = Wiederaufnahme ohne Checkpoint-Tabelle, wie beim CSV-Import.
- Ergebnis-JSON bleibt `{saved, failed, skippedHandles, failures[]}` (Einheiten), zusätzlich `mode: "sync"`, `packages`, `requests` (Anzahl echter Anfragen), `retries`. Der Summariser ([task-details.shared.ts](../../app/services/tasks/task-details.shared.ts) L373) liest unbekannte Felder nicht, bleibt kompatibel; neue Zeilen "Anfragen" kommen mit i18n dazu.
- Terminalstatus unverändert bedingt (`updateMany where status: running`).

### 3.4 Kostenvorschau und Start-Dialog

- **Kein neuer Endpunkt**: `handleBulkEditorTranslate` bekommt `estimateOnly=true`. Es läuft bis nach `buildJobs`, plant die Pakete (gleiche Funktion wie der echte Lauf, deshalb dieselbe Zahl) und antwortet `{ success, estimate }`, **ohne Task**, ohne KI-Aufruf. Plan- und Sprach-/Spalten-Validierung sind dieselben Zeilen vor dem Abzweig. **`estimateOnly` läuft hinter `aiRefusalFor`** ([api.ai.tsx](../../app/routes/api.ai.tsx) L151): ein Shop ohne KI-Schlüssel (und ohne Taster) bekommt auch die Vorschau nicht, sondern die übliche Verweigerung; die Seite zeigt die vorhandene Schlüssel-Meldung statt einer Zahl (kein Sonderweg, bewusst). (Quelltexte gehen nie zum Browser, die Seite kennt sie nicht, darum muss die Schätzung serverseitig entstehen.)
- `estimate = { units, requests, inputTokens, outputTokens, costMicros | null, costMicrosBatch | null, budget?: { remainingMicros, wouldExceed }, skippedOverCap, batchAvailable, unpriced }`. Token mit der pessimistischen 3-Zeichen-Regel (Ausgabe `estimateOutputChars`), Preis über `priceCall` (Aufrunden, bei unbekanntem Modell Provider-Obergrenze -> Anzeige "bis zu"). HuggingFace: nur Token, kein Preis. Immer als "ca." und "Schätzung" beschriftet.
- **Seite**: Start-Button öffnet einen Bestätigungsdialog (Polaris `Modal`, Zweit-Button statt `window.confirm`, siehe Regeln in CLAUDE.md) mit: Anzahl Übersetzungen, Anfragen, geschätzte Token, geschätzte Kosten (managed: Anteil am Restbudget; BYO: Listenpreis, "Ihr Anbieter rechnet ab"), Hinweis auf `skippedOverCap`, und (ab Phase 2) die Moduswahl **"Sofort" (vorausgewählt) / "Günstiger, Ergebnis bis zu 24 Stunden"** nur wenn `batchAvailable`. Zweiter Aufruf `handleStart` mit `mode=batch|sync` startet den Lauf. Zwischen Vorschau und Start kann sich der Shop ändern: der echte Start scannt wie bisher neu; eine abweichende Zahl wird nicht verschwiegen (Ergebnisbanner nennt die tatsächliche Zahl).
- Managed: ist die Schätzung grösser als das Restbudget, sagt der Dialog es und der Start im sofort-Modus bleibt erlaubt (der Aufruf-Preflight stoppt den Lauf sauber mit Stand-down, bereits Geschriebenes bleibt), im Batch-Modus wird er **verweigert** (§6.3).
- Warnung vor Bestätigung ersetzt keine Regel: `MAX_TRANSLATE_UNITS` und Plan bleiben serverseitig.

### 3.5 Prompt-Caching

- Voraussetzung ist der stabile Präfix aus §3.1. Ohne ihn ist alles andere wirkungslos.
- **Anthropic**: Präfix als `system`-Block mit `cache_control: { type: 'ephemeral' }` (5 min TTL reicht, die Pakete einer Gruppe laufen hintereinander). Nur setzen, wenn (a) die Präfix-Schätzung >= Mindestlänge ist (je Modell zwischen ~1024 und ~4096 Token; **NICHT gemessen**: Konstante vorsichtig bei 4096 gesetzt, bis ein Probe-Lauf anderes zeigt) UND (b) die Gruppe >= 3 Pakete hat (Schreib-Aufschlag amortisiert). Sonst ohne Marker; kein Schaden, kein Aufschlag.
- **OpenAI** (und Grok/DeepSeek, OpenAI-kompatibel): automatisches Prefix-Caching ab >= 1024 Token; nichts zu markieren, nur die Reihenfolge (Präfix zuerst) und das Auslesen von `prompt_tokens_details.cached_tokens` (DeepSeek: `prompt_cache_hit_tokens`).
- **Gemini**: nur implizit; Ausbau (explizites Caching) in diesem Plan nicht vorgesehen.
- **Ehrliche Erwartung**: Der Präfix ist (Aufgabe + Regeln + Anweisungen; das Glossar gehört nicht dazu, §3.1). Bei Händlern ohne lange Anweisungen liegt er unter der Mindestlänge und es passiert nichts. Der Hauptgewinn der Phase ist die Paketierung, Caching ist ein Zusatz für Händler mit langen Anweisungen. Deshalb steht Caching in Phase 1d, nach dem Messen von 1c.
- **Zähler**: siehe §3.6. Cache-Lese- und Schreib-Token DÜRFEN NIE unterschlagen werden; ein unbekannter Rabatt wird als voller Preis gezählt (zu viel, nie zu wenig).

### 3.6 Zähler und Preise bei Cache und Batch

- `AiCallUsage` bekommt optional `cacheReadTokens`, `cacheWriteTokens` (und `tier: 'standard' | 'batch'`). **`inputTokens` bleibt die Summe aller Eingabe-Token** (ungecacht + Lese + Schreib), damit "Eingabe-Token" überall dasselbe heisst.
  - Anthropic: `input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (der Code-Kommentar L3610 warnt genau davor), Cache-Anteile separat.
  - OpenAI-artig: `prompt_tokens` enthält die gecachten schon; `cached_tokens` separat.
  - Fehlt die Meldung, gilt wie heute die Schätzung.
- `ModelPrice` bekommt optionale Faktoren `cacheReadMult`, `cacheWriteMult`, und Provider/Modell `batchMult` (alle datiert, wie die Preise, `PRICES_CHECKED_ON`). Grundlage (Recherche-Stand, vor Einbau gegen die Preislisten zu prüfen): Anthropic Lesen 0.1x, Schreiben 1.25x (5 min) / 2x (1 h), Batch 0.5x; OpenAI Cache-Lesen modellabhängig (0.5x bis 0.1x), Batch 0.5x; **jeder unbekannte Faktor = 1.0** (voller Preis). `priceCall(provider, model, in, out, { cacheRead, cacheWrite, tier })` rechnet: `(in - cacheRead - cacheWrite) x p_in + cacheRead x p_in x readMult + cacheWrite x p_in x writeMult + out x p_out`, dann `x batchMult` (**M4: nur auf die Nicht-Cache-Anteile**; ob und wie Cache-Komponenten im Batch rabattiert werden, ist NICHT gemessen; bis dahin voller Cache-Faktor ohne Batch-Rabatt = zu viel, nie zu wenig), aufgerundet auf Mikro-Euro, `clampMicros` wie bisher. Ein Test pinnt: mit allen Faktoren 1.0 ist das Ergebnis identisch mit dem heutigen `priceCall` (keine Regression für bestehende Aufrufer).
- **Batch-Tarif an den Händler weitergeben**: `billedMicros = costMicros` (die Regel gilt schon heute; nur das Failover weicht ab). Der Batch-Rabatt senkt also das, was vom Budget abgeht. Das hält die Marge unverändert (Kosten = verrechnet) und ist genau das, was "günstiger" für den Händler heisst; Entscheid, siehe §11.
- **Schema (additiv, Phase 1a)**: `AiUsageCounter.cacheReadTokens BigInt @default(0)`, `cacheWriteTokens BigInt @default(0)`. Unique-Schlüssel unverändert. Begründung: ohne sie ist die Behauptung "Caching spart" nie überprüfbar, und der Meter zeigt `inputTokens` ohne Aufschlüsselung. Alternative (kein Schema): Cache-Token nur in `inputTokens` einfalten und Kosten exakt rechnen, aber Trefferquote bliebe unsichtbar. Gewählt: die zwei Spalten, eine Migration, beide Default 0, nichts liest sie vorher. `Task.inputTokens/outputTokens/costMicros` (Int32) bleiben.
- `shop-overview`/`/admin` zeigt weiter Gesamtwerte; Aufschlüsselung dort optional und nicht Teil dieses Plans.

---

## 4. Phase-1-Rails (Zusammenfassung)

- **Nie überschreiben, nie gegen alten Text registrieren (Revision, C1).** Die erste Fassung behauptete, `applyBulkDiff` fülle nur Leeres. **Das stimmt nicht**: der Pfad für Fremdsprach-Gruppen (`persistForeignRowGroup`, apply.server.ts L2978 ff.) hat keine Leer-Regel; die Leer-Garantie lag bisher allein im Scan, der unmittelbar vor dem Schreiben lief. Zwei Lücken, die bei Blockschreiben und erst recht bei Batch (Minuten bis Stunden zwischen Scan und Schreiben) real werden:
  1. Scan und ein `sourceHash` des Cache-Textes sehen Änderungen im Shopify-Admin nicht (der Cache hinkt bis zum nächsten Webhook/Sync), und der DB-Spiegel sieht Übersetzungen nicht, die im Shopify-Editor entstanden sind.
  2. Der Schreibweg nimmt beim Registrieren einen FRISCHEN Digest der aktuellen Quelle: eine Übersetzung des alten Textes würde gegen den neuen Digest akzeptiert und als frisch gespeichert (die Digest-Regel schützt hier nicht, weil der Digest zum Schreibzeitpunkt gelesen wird).

  **Pflicht-Fix (Phase 1a/1b, nicht optional):** (a) Beim Planen/Einreichen wird je `(Ressource, Schlüssel)` der **Shopify-`translatableContent`-Digest** gelesen (aliasierte Reads, gebündelt wie `DIGEST_BATCH_CHUNK`) und als `expectedDigest` im Eintrag geführt (Sofort-Modus im Speicher, Batch im Manifest; er ersetzt den `sourceHash` aus §5.2, der Cache-Text-Hash entfällt als alleinige Prüfung). (b) `BulkDiffEntry` bekommt optional `expectedDigest`; der Schreibweg vergleicht mit dem frisch gelesenen Digest und verwirft bei Abweichung als `skippedChanged`, nie als Fehler. (c) **Vor dem Registrieren jedes Blocks** (Batch-Einsammeln UND lange Sofort-Läufe) ein **Live-Read** `translations(locale:)` je Block-Ressource und Locale (aliasiert); ist dort bereits ein Wert (nicht `null`), wird der Eintrag verworfen (`skippedFilled`). Ein nicht beantworteter Read verwirft die Einträge des Blocks ebenfalls (unbekannt = nichts schreiben). (d) Der lokale Re-Scan je Block ist das gezielte `recheckMissing(db, rowIds, columns, locales)` (nur diese Zeilen, ein Query) als zweite, billige Schranke. Tests: Quelle nach dem Scan im Shopify-Admin geändert; Übersetzung nach dem Scan im Shopify-Editor eingetragen; in beiden Fällen darf nichts geschrieben werden.
- Handle-Opt-in unverändert (`TRANSLATE_DEFAULT_OFF_COLUMN_IDS`).
- Managed: `standsDown` bleibt der einzige Ort; Stand-down heisst: keine neuen Pakete, bis dahin Verifiziertes wird noch geschrieben, Task-Fehler `managed_ai_refused:<grund>`, `failed` nur wenn nichts gespeichert wurde.
- Paketfehler sind Eintragsfehler, nie Laufabbruch; nur Schlüssel-/Managed-/Queue-Fehler stoppen.
- Nichts im Paketpfad liest `process.env` oder `MANAGED_AI_*` (`ai-key-source-isolation.test.ts` bleibt grün); alle Anbieter-Clients bleiben in `AIService`.

---

## 5. Design Phase 2: Batch-API

### 5.1 Was die Provider hergeben (installierte SDKs: GEMESSEN am Typ, Verhalten NICHT)

| Provider | SDK-Stand | Batch | Bewertung |
|---|---|---|---|
| Anthropic (`claude`) | 0.71.2 | `client.messages.batches.create/retrieve/results/cancel` vorhanden (`resources/messages/batches.d.ts`); Anfrage `{custom_id, params}`; Status `processing_status: in_progress|canceling|ended`, `request_counts`, `expires_at`; Einzelergebnis `succeeded|errored|expired|canceled`; `usage.service_tier` kennt `'batch'` | **Phase 2a.** Managed UND BYO. |
| OpenAI (`openai`, auch `grok`/`deepseek` laufen über diesen Client, aber ohne deren Batch) | 6.17.0 | `files.create(purpose: 'batch')` + `batches.create({ input_file_id, endpoint: '/v1/chat/completions', completion_window: '24h' })`, `retrieve`, `output_file_id`/`error_file_id`, `request_counts`, `expires_at` (`resources/batches.d.ts`) | **Phase 2b.** Managed UND BYO. Reasoning-Modelle brauchen `max_completion_tokens` (`openAiChatParams`, schon vorhanden). |
| Gemini | `@google/generative-ai` 0.24.1 hat nur `batchEmbedContents`, keine Batch-Generierung | Ein Batch bräuchte eine neue Abhängigkeit oder rohes REST | **Kein Batch (Owner-Entscheid 2026-11-12): Gemini bleibt Sofort-only, keine neue Abhängigkeit.** |
| Grok (xAI) | OpenAI-Client mit anderer `baseURL` | Ob xAI einen kompatiblen Batch-Endpunkt hat, ist hier NICHT belegt | nicht angeboten |
| DeepSeek | OpenAI-Client | Kein Batch-Modus bekannt (nur zeitabhängige Preise) | nicht angeboten |
| HuggingFace | `@huggingface/inference` | keiner | nicht angeboten |

Die Dokumentationsangaben (50 % Rabatt, 24 h Fenster, Anthropic: bis ~100 000 Anfragen/256 MB je Batch und Ergebnisse ~29 Tage abrufbar, `custom_id`-Muster `[A-Za-z0-9_-]{1,64}`, OpenAI: 50 000 Zeilen/200 MB je Datei, eigene Token-Warteschlangen-Limits je Modell und Tarifstufe) sind Recherche-Stand und werden im Plan NICHT als gemessen behandelt. Das Einbauen ist so geschrieben, dass keine dieser Zahlen vorausgesetzt wird (§8).

Verfügbarkeit: `batchSupportFor(provider, credentialSource)` (`ai-batch-support.shared.ts`, rein): `claude`/`openai` ja (BYO und managed), alle anderen nein. Taster-Shops (managed ohne bezahltes Budget) bekommen **kein** Batch (Spend-Vorabprüfung wäre gegen ein Mini-Budget sinnlos; sofort-Modus bleibt). Der Dialog zeigt die Moduswahl nur bei `batchAvailable`, der Server prüft es beim Start erneut (direkt POST-erreichbar).

### 5.2 Wo der Zustand lebt (kein Schema-Umbau)

- **Task `bulkEditorTranslate`, neuer Status-Wert `waiting_batch`** (Status ist ein freier String; neu ist nur ein Wert). Er ist weder `running` noch `pending`, wird also NICHT vom Reaper (`NON_TERMINAL` = running/pending/queued, [task-recovery.service.js](../../task-recovery.service.js) L125) noch vom Boot-Recovery (`status: "running"`, [orphan-run-recovery.js](../../orphan-run-recovery.js) L131-138) angefasst. Das ist der springende Punkt: ein Batch beim Provider darf nicht als "verwaist" gelten, nur weil die App neu startet.
- **Zustand: eigene kleine Zeile statt `Task.result` (Revision 2, H-4).** Siehe §19.4: additive Tabelle `BulkTranslateBatch` (Manifest, Lease-Token, Zustand, Reservierung, `period`/`pool`, Fehlerzähler). `Task.result` bleibt im Wartezustand leer. Die frühere Beschreibung eines JSON-Manifests in `Task.result` gilt nicht mehr; das Manifest-Inhaltsschema (Anfragen -> Einträge mit `rowId`, `columnId`, `fieldKey`, `locales`, `slice`, `expected` je Ziel-Ressource, `metered`-Liste) bleibt, liegt aber in der neuen Zeile.
  - **Keine Quelltexte im Manifest**, nur `expected` (Shopify-Digest je Ziel-Ressource, §19.1/§19.2). Das ersetzt den früheren `sourceHash`; der Cache-Text-Hash entfällt, weil er Änderungen im Shopify-Admin nicht sieht. Das Manifest bleibt klein (~100-300 Byte je Zelle), liegt aber in einer eigenen Zeile mit genau einem Schreiber (dem Lease-Halter), nicht im Task.
  - `Task.provider`/`Task.aiModel` (vorhandene Recovery-Spalten) werden mitgesetzt.
  - Am Ende überschreibt das normale Ergebnis-JSON (`{saved, failed, skippedHandles, failures, mode:"batch", ...}`) das Manifest.
- **`expiresAt`**: beim Einreichen = Batch-`expires_at` + 3 Tage, bei jedem Tick eines wartenden Tasks nachgezogen, sonst löscht einer der DREI Cleanups (§1.6) den Task samt Manifest mitten im Warten.
- **Single-Flight**: Handler L177, Seiten-Loader L190 und die beiden Listen-Routen (`api.running-tasks-list`, `api.running-field-tasks`, beide nach `["pending","queued","running"]` gefiltert) müssen `waiting_batch` mitzählen. Die Seite liest `Task.status` im Poll (`task-result`) und behandelt `waiting_batch` als "läuft noch" (Banner "Wartet auf den Anbieter", `tm.waitingBatch`). Eine Tasks-Tab-Beschriftung und der Navigations-Badge (aktive Aufgaben) kommen dazu. Vor dem Einbau per Grep alle Stellen finden, die auf `"running"` filtern (hier nur die oben gefundenen Treffer geprüft, die Vollliste gehört in 2a Schritt 0).
- **Manifest nie ausliefern (M2).** `Task.result` trägt im Wartezustand das Manifest. `/api/task-result` ([api.task-result.tsx](../../app/routes/api.task-result.tsx) L49-70) liefert `result` bzw. `resultSummary`, der Tasks-Tab-Loader und die Summariser lesen `result` ebenfalls: im Zustand `waiting_batch` wird das Manifest an allen drei Stellen entfernt (der Summariser liefert nur "wartet, n Anfragen, eingereicht am"). Der Seiten-Poll (app.bulk_.translate.tsx L390) pollt im Zustand `waiting_batch` langsam (60 s) und behandelt `cancelled` als beendet (heute nur `completed`/`failed`).
- **Atomares Single-Flight (M5).** Heute `findFirst` dann `create` (Handler L177-224): zwei gleichzeitige Starts können beide durchkommen. Neu: erst `create` mit Status `pending`, dann `findFirst` nach einem **älteren** Task desselben Shops und Typs in `pending|running|submitting|waiting_batch`; gibt es einen, wird der eigene Task gelöscht und `ALREADY_RUNNING` geantwortet (Gleichstand nach `id`). Gilt für beide Modi.
- **Index/Scan (M6):** der Poll-Tick fragt `status = 'waiting_batch'` über alle Shops; der vorhandene Index `[shop, status]` hilft ohne Shop-Prädikat nicht, die Tabelle ist durch den 3-Tage-Cleanup klein. Entscheid: **kein neuer Index** in 2a, die Abfrage wird als Scan benannt und mit `take` begrenzt; zeigt die Messung etwas anderes, kommt ein additiver Index als eigene Migration (eine Anweisung je Datei, kein `CONCURRENTLY` in Mehrfach-Statement-Dateien).
- Warum nicht eine neue Tabelle: Der Owner wollte Task-Felder; ein Manifest je Task ist kurzlebig (Tasks verfallen ohnehin), hat keinen Abfragebedarf ausser "wartende Tasks aller Shops" (der Index `[shop, status]` reicht, ein Tick fragt `status = waiting_batch` über alle Shops: wenige Zeilen) und teilt das Schicksal des Tasks (GDPR-Löschung, Cleanup) ohne Zusatzarbeit.

### 5.3 Einreichen

1. Ablauf wie sofort bis `buildJobs` und Paketplanung (Batch-Grenzen, §3.2).
2. Anbieter-Vorabprüfung: `batchSupportFor`, Schlüssel/Einwilligung über den normalen Resolver (`createAIService`), Managed: Budget-Reservierung (§6.3).
3. **Task zuerst anlegen** mit Status `submitting` (zählt für Single-Flight; der Heartbeat-Timer läuft während Hochladen/Einreichen, und `submitting` bekommt denselben Heartbeat-Stall-Reaper wie `running`, d. h. Reaper-Liste und Boot-Recovery-Typen werden um diesen Status ergänzt), dann Anfragen bauen (`custom_id = p<Index>`, Anthropic-Muster; OpenAI-JSONL-Zeile `{custom_id, method:"POST", url:"/v1/chat/completions", body}`), einreichen, Batch-ID **unbedingt** in `Task.result` schreiben (ein `update` ohne Statusbedingung, damit ein zwischenzeitlich verändertes Task-Objekt die ID nicht verliert), danach Status `waiting_batch` bedingt auf `submitting`. **Ist der Task inzwischen nicht mehr unser** (gelöscht, `cancelled`, durch Recovery `failed`), wird der Batch sofort beim Anbieter abgebrochen (C4). **Verwaisten-Sweep:** die `custom_id` jeder Anfrage trägt die Task-ID (z. B. `t<taskId>_p<Index>`, das Provider-Muster/die Längenregel ist NICHT gemessen und wird in 2a Schritt 0 geprüft; OpenAI zusätzlich `metadata.taskId`). Der Verwaisten-Sweep ist in §19.5 neu gefasst (`batches.list` liefert nur Batch-IDs; es werden nie dieser DB unbekannte Batches abgebrochen, nur solche mit terminalem Task). Für BYO-Schlüssel gibt es ohne den Schlüssel keine Auflistung; dort bleibt ein Rest gestanden (§18).
4. Mehrere Batches (OpenAI-Grenzen, grosser Lauf): nacheinander einreichen, jede ID sofort speichern; scheitert einer (Limit, Modell nicht unterstützt), laufen die bereits eingereichten weiter, die nicht eingereichten Pakete werden als `notStarted` gemeldet (Einheiten bleiben leer, nächster Lauf holt sie) — nichts geht verloren, nichts wird doppelt eingereicht. Scheitert schon der erste: Task `failed` mit Code `batch_submit_refused`, nichts gebucht, die Seite bietet "Sofort" an.
5. Antwort an die Seite: `{ taskId, total, mode: "batch" }`; Banner "Eingereicht, Ergebnis kommt bis zu 24 Stunden".

### 5.4 Einsammeln (Tick)

- **Neuer Dienst** `BulkTranslateBatchPollService` (`bulk-translate-batch-poll.service.ts`, Singleton nach `TranslationDriftAutoRunService`): Start aus [shopify.server.ts](../../app/shopify.server.ts) neben den anderen (L389), Intervall 5 min (`BULK_TRANSLATE_BATCH_POLL_INTERVAL_MS`), Abschalter `BULK_TRANSLATE_BATCH_POLL_DISABLED`, Kappe je Tick, Backoff-Stempel auf jedem Pfad. Er ist auf einer Instanz ausgelegt wie die anderen (Mehrinstanz-Verhalten: siehe Lease).
- Je wartendem Task: Provider-Status abfragen (`retrieve`). `in_progress`/OpenAI `validating|in_progress|finalizing` -> `updatedAt` und `expiresAt` nachziehen, fertig. `ended`/`completed|failed|expired|cancelled` -> **einsammeln**.
- **Lease statt Orphan-Recovery (Revision 2, H-4):** `Task.updatedAt` ist `@updatedAt` und bewegt sich bei JEDEM Schreibzugriff (jede andere Schreibquelle verlängerte eine `updatedAt`-Lease). Neu: die Lease sitzt auf der `BulkTranslateBatch`-Zeile als **Token mit Compare-and-Swap** (`updateMany where { id, OR[leaseUntil null, leaseUntil < now] } data { leaseToken, leaseUntil: now + 2 min }`, `count === 1` = Besitzer); der Besitzer verlängert per `updateMany where { id, leaseToken }`. Details §19.4. Stirbt der Besitzer, läuft die Lease ab, der nächste Tick sammelt erneut: neustart-sicher ohne Sonderfall im Boot-Recovery.
- Das Einsammeln nutzt exakt den Schreibweg von Phase 1c (Verifikation -> Blöcke -> `applyBulkDiff`), nur mit den Paketergebnissen aus dem Batch statt aus Live-Aufrufen.

### 5.5 Ergebnisse verarbeiten

Je `custom_id`:

- `succeeded`: Text und `usage` lesen. **Abgeschnitten** (`stop_reason max_tokens` / `finish_reason length`) = Paket als Ganzes ungültig. Sonst Verifikation je Eintrag wie §3.1.
- `errored` / `expired` / `canceled` / Zeile in OpenAI-Fehlerdatei: alle Einträge des Pakets gelten als nicht geliefert.
- **Nachholen**: Einträge, die an der Verifikation scheitern oder nicht geliefert wurden, gehen — begrenzt — **synchron** in kleinen Paketen (Halbierungsleiter §3.1) durch den normalen `AIService`. Kostendeckel für diese Nachholer: `min(20 Anfragen, 10 % der Pakete)`; darüber hinaus bleibt der Eintrag leer und wird mit Code `batch_entry_not_delivered` (Sprache, Zelle) gemeldet, der Händler startet bei Bedarf erneut (der Scan findet ihn). Ein abgelaufener Batch ist ein ganzer Lauf ohne Ergebnis: Status `failed` mit `batch_expired`, nichts wird automatisch neu eingereicht (Entscheid: kein stiller zweiter Aufwand auf dem Schlüssel des Händlers).
- **Nichts doppelt schreiben**: der Schreibweg selbst trägt die Vorbedingung (`fillOnly` im `ApplyContext`, §19.2): je Ziel-Ressource `expected`-Digest-Vergleich und Live-Leer-Prüfung vor dem Registrieren; geänderte Quelle -> `skippedChanged`, bereits gefüllt -> `skippedFilled` (eigene Zähler in `BulkApplyResult` und im Ergebnis, kein Fehler: Seitenregel "nur leere Werte füllen"). Ein zweites Einsammeln nach Absturz ist dadurch idempotent.
- **Provider-Kosten buchen** (§6.4) einmal je `custom_id`; **M3:** Ledger-Buchung und `metered`-Markierung im Manifest geschehen in EINER Datenbank-Transaktion und VOR dem Schreiben der Übersetzungen (`recordAiUsage` bekommt dafür eine Transaktionsvariante); damit gibt es nach einem Absturz weder Doppel- noch Nicht-Buchung. Die Reservierung (§6.3) wird in derselben Transaktion freigegeben. Die Restaussage "höchstens doppelt" der ersten Fassung entfällt.
- Abschluss: Ergebnis-JSON mit `mode:"batch"`, Anzahl Anfragen, `retries`, `skippedChanged`, `notStarted`; Terminalstatus bedingt auf `waiting_batch`; Benachrichtigung über den bestehenden `bulkEditorTranslateCompleted`-Pfad (MainNavigation.tsx L53).

### 5.6 Abbrechen (Revision, H1)

- **Kein Weg über `/api/ai`**: ein Shop ohne gültigen Schlüssel (Schlüssel gelöscht, Einwilligung entzogen) scheiterte dort an `aiRefusalFor` und könnte nie abbrechen. Stattdessen wird der **bestehende Abbrechen-Knopf in [app.tasks.tsx](../../app/routes/app.tasks.tsx)** erweitert (dort existiert der Status `cancelled`); keine neue Tür. Die Aktion setzt `cancelRequested` im Manifest, `waiting_batch` bleibt bis zum Einsammeln.
- Ablauf: nächster Tick -> Provider-`cancel` über den Abwicklungs-Zugriff (§6.1) -> **einsammeln** (fertige Teilergebnisse sind bezahlt und werden geschrieben) -> `cancelled`/`completed`. Solange ein Batch offen ist, wird der Task **nicht gelöscht**: der Löschknopf des Tasks-Tabs ist für `waiting_batch`/`submitting` ausgeblendet und serverseitig verweigert.
- **Vorhandener Fehler im Sofort-Lauf (§18):** der Sofort-Runner prüft den Task-Status nirgends, ein abgebrochener Task läuft einfach weiter. Neu: Worker prüfen den Status vor **jedem Paket und jedem Schreib-Block** (ein billiger Read, höchstens alle 5 s) und stoppen bei `cancelled`; schon Verifiziertes wird noch geschrieben, Unverifiziertes verworfen.

---

## 6. Managed-AI und Schlüssel im Batch

1. **Schlüssel (C2, überarbeitet)**: Batch-Aufrufe sind neue Methoden von `AIService`. Zusätzlich gibt es in [ai-credentials.server.ts](../../app/services/ai/ai-credentials.server.ts) (dem EINEN Leser der Operator-Schlüssel) einen **eigenen, protokollierten Abwicklungs-Zugriff** `settlementCredentialsFor(shop, manifest)`: er erlaubt ausschliesslich `retrieve`/`results`/`cancel` (und Datei-Löschen) für eine im Manifest des Shops genannte Batch-ID unter der im Manifest festgehaltenen Quelle (`managed` oder `byo`), **ohne** Einwilligung, Kill-Switch oder Budget zu prüfen, mit einer Log-Zeile je Nutzung (Shop, Task, Aktion). Er gibt keinen Schlüssel heraus, nur einen eingeschränkten Transport. `ai-key-source-isolation.test.ts` bleibt grün (kein `process.env` ausserhalb dieses Moduls) und prüft zusätzlich, dass der Zugriff nichts anderes erlaubt. Warum nötig: sonst gäbe es nach Einwilligungsentzug/Kill-Switch/Schlüsselwechsel keinen Weg mehr, einen laufenden Batch abzubrechen oder das schon Bezahlte zu buchen.
2. **Einwilligung/Kill-Switch/Verfügbarkeit entscheiden nur über das SCHREIBEN, nie über Abrufen und Buchen.** Beim Einsammeln wird IMMER abgerufen und gebucht (der Aufwand ist beim Anbieter entstanden). Ob geschrieben wird, entscheidet das normale Gate (`resolveAiCredentials`): Einwilligung entzogen oder Kill-Switch an -> nicht schreiben, Task `failed` mit `managed_ai_refused:<grund>`, Ergebnisse verworfen. **Bei Entzug/Kill-Switch wird der laufende Batch sofort beim Anbieter abgebrochen**: der Poll-Tick prüft das bei jedem Lauf für jeden wartenden Task, nicht erst am Ende. Ein ERSCHÖPFTES Budget stoppt weder Abruf noch Schreiben. Wechsel von Anbieter/Schlüssel im Warten: der Abwicklungs-Zugriff nutzt die Quelle aus dem Manifest; fehlt ein BYO-Schlüssel inzwischen, Task `failed` mit `ai_key_missing` (der Batch läuft beim Anbieter aus, §18). **Ausnahme Einwilligungsentzug (Owner-Entscheid, §16):** abbrechen, nichts abrufen, die reservierte Obergrenze wird gebucht.
3. **Vorabreservierung als persistierter Zähler (C3, überarbeitet)**: tausende Anfragen starten gleichzeitig, die Überschiess-Grenze des Einzelaufruf-Gates gilt nicht, und eine reine Prüfung beim Einreichen sähe zwei gleichzeitige Batches oder parallele Sofort-Läufe nicht. **Revision 2 (§19.5): die Reservierung wirkt in BEIDEN Zählern (`AiUsageCounter` nur `billedMicros`, zusätzlich `ManagedAiGlobalCounter`), beide über `usage-meter.server.ts`; die folgende Beschreibung nennt nur die Shop-Hälfte.** Neu: beim Einreichen wird eine **Reservierung als geschätzte Zählerzeile** in `AiUsageCounter` geschrieben (eigenes `feature`, z. B. `bulkEditorTranslate:reserved`, `estimated = true`, kein neues Schema, innerhalb des bestehenden Unique-Schlüssels), die `managedBudgetStatus` UND der globale Pool (`globalPoolStatus`) zur genutzten Summe zählen; sie wird beim Einsammeln/Abbrechen/Fehlschlag **freigegeben** (in der Transaktion aus §5.5). Worst Case = `Σ (Eingabeschätzung + gesendetes max_tokens) x Preis x batchMult` über alle Pakete (das gesendete, nicht das geplante `max_tokens`). Reicht `remaining` nicht: Verweigerung (`budgetExceeded`). Gate-Richtungen bleiben (Shop-Budget unlesbar = verweigern, Pool unlesbar = erlauben). Der Poll-Dienst gibt Reservierungen von Tasks frei, die nicht mehr `waiting_batch` sind (Sweep), sonst bliebe Budget gesperrt. Ein Test pinnt Schlüssel, Zählung und Freigabe.
4. **Buchen** beim Einsammeln: je `custom_id` ein `AiCallUsage` mit `tier: 'batch'` (§3.6), `source` = `managed`/`byo`, `feature = "bulkEditorTranslate"`, `taskId`; **Periode und Pool werden beim Einreichen bestimmt und im Manifest festgehalten (`period`, `pool`); gebucht wird unter diesen Schlüsseln** (C3): `recordAiUsage` fällt ohne Angabe auf den Kalendermonat `m:` zurück (`currentAiUsagePeriod`), und das Budget, das unter `b:`/`taster` liest, sähe die Buchung nie. Die Reservierung lag unter demselben Schlüssel, die Buchung hebt sie also sauber auf. Ein Test pinnt, dass `recordAiUsage` mit dem Manifest-Schlüssel aufgerufen wird. (Die Vorgabe "Periode zum Einsammeln" der ersten Fassung entfällt.) Anthropic meldet pro Ergebnis `usage`, OpenAI in den Ergebniszeilen `usage`; fehlt es, Schätzung wie heute (`estimated: true`).
5. **Eigener Schlüssel (BYO)**: kein Budgetgate, Abrechnung beim Anbieter des Händlers; die Vorschau zeigt Listenpreise. Der Händler kann bei seinem Anbieter Batch-Limits haben (OpenAI-Tarifstufe); ein Refuse beim Einreichen wird als `batch_submit_refused` mit der Anbieter-Meldung gezeigt.
6. **Taster**: kein Batch (§5.1).
7. **Löschen/Deinstallation (H2)**: `redactShopData` und das App-Deinstallieren (siehe CLAUDE.md, per-Shop-Löschpfade) brechen offene Batches des Shops zuerst beim Anbieter ab und löschen Provider-Dateien (best effort, protokolliert, ein Fehler stoppt die Löschung nicht), erst dann werden Tasks/Manifest gelöscht. OpenAI-Eingabe-/Ausgabe-/Fehlerdateien werden nach dem Einsammeln **immer** gelöscht. Der Poll-Dienst überspringt deinstallierte/blockierte Shops (Verbindungsstatus wie bei den anderen Sweeps) und holt Zugriff nur über `getOfflineAdmin`/`backgroundAdmin` (kein gehaltenes Token, keine Roh-Token-Lesung).

---

## 7. Limit-Entscheid (Aufgabe 6)

**Entscheid:**

| Konstante | Heute | Neu | Wo |
|---|---|---|---|
| `MAX_TRANSLATE_UNITS` | 2000 | **10 000** (beide Modi) | translate-missing.shared.ts L34 |
| `MAX_TRANSLATE_CANDIDATE_ITEMS` | 500 | **500 (unverändert, M8)** | L46 |
| `MAX_TRANSLATE_SCAN_ROWS` | 5000 | 5000 (unverändert) | L45 |
| `MAX_TASK_CALLS` | 2000 | 2000, aber **je Schreib-Block** (applyBulkDiff-Aufruf), nicht je Lauf; Lauf-Obergrenze für Shopify-Aufrufe = 5 x `MAX_TASK_CALLS` | `buildJobs` L294/L313 |

**Begründung** (aus der Schreibseite, nicht aus der KI-Seite):

- Shopify-Seite: Pro Lauf ist das Limit heute `Einheiten = Aufrufe` (§1.6) und überzählt Gruppen deutlich (3 Zellen je Zeile = 3x so viele "Aufrufe" wie `estimateCalls` rechnet). Die Kappe diente, weil ein Lauf alles in EIN `applyBulkDiff` am Ende kippte. Mit Blöcken fällt dieser Grund weg: der CSV-Import beweist, dass `applyBulkDiff` blockweise stundenlang arbeiten darf (er dokumentiert "a two-hour import is never reaped"), und die einzelnen Aufrufe bleiben in den Grid-Kappen, für die der Pfad gebaut wurde.
- Laufzeit: 10 000 Einheiten sind bei 3 Zellen je Zeile ~3 300 Gruppen, grob 3 300 Register + Digest-Batches. Die tatsächliche Schreibgeschwindigkeit ist NICHT gemessen (Gateway ist ein serieller Verbraucher); Phase 1c loggt Zeit je Block, und die Obergrenze 10 000 ist so gewählt, dass ein Lauf im ungünstigen Fall im Bereich weniger Stunden bleibt, nicht Tage. Heartbeat (15 s, Timer unabhängig vom Fortschritt) und Orphan-Rails tragen das; ein Neustart verliert höchstens den laufenden Block (§3.3).
- KI-Seite: unbeaufsichtigte Ausgaben auf dem Schlüssel des Händlers sind durch Kostenvorschau und Bestätigung begrenzt (§3.4), bei Managed zusätzlich durch das Budget. Das Einheiten-Limit ist kein Kostenlimit mehr, sondern ein Laufzeit- und Speicherlimit. Speicher: Quellen aller Kandidaten liegen im Prozess (Grössenordnung 30 MB Spitze bei vielen langen Feldern); das Kandidatenfenster 500 begrenzt das.
- Ein Limit nur für Batch zu erhöhen wurde verworfen: ein Händler würde zwei verschiedene Zahlen sehen, und die Schreibseite ist in beiden Modi dieselbe. Eine gemeinsame Zahl bleibt erklärbar.
- Wirkung auf die Seite: `MAX_TRANSLATE_UNITS` wird vom Client importiert (app.bulk_.translate.tsx L52, L455, L496, L616), die Hinweise passen sich an; Guide-Text mit "2000" (falls vorhanden) wird angepasst.
- **Kandidatenfenster (M8, geändert):** die erste Fassung hob es auf 1000. Das verdoppelt den Scan des Seiten-LOADERS (er läuft bei jedem Seitenaufruf und jedem Sprachwechsel, nicht nur beim Start) und den Speicher des Laufs. Entscheid: bleibt 500; 10 000 Einheiten sind bei ~10 Einheiten je Eintrag dennoch erreichbar, bei weniger Sprachen/Feldern ist 500 Einträge die Grenze und die Seite meldet den Rest wie heute (`scanTruncated`). Eine spätere Anhebung nur zusammen mit einem Loader-Scan, der keine Quellen lädt.
- **Reihenfolge (M9):** die Erhöhung auf 10 000 geschieht erst NACH gemessener Blockzeit (§11, Schritt 1c); bis dahin bleibt 2000.
- Gegenprobe: Wenn die Messung in Phase 1c ein Schreibtempo zeigt, bei dem 10 000 Einheiten > 4 h dauern, wird die Konstante gesenkt (eine Zeile). Die Konstanten bleiben bewusst benannt und in einer Datei.

---

## 8. GEMESSEN / NICHT GEMESSEN

**Aus Code und SDK abgelesen (sicher):** alle Zeilenverweise in §1; die Batch-Methoden und Typen der installierten SDKs (Anthropic 0.71.2, OpenAI 6.17.0); die Cache-Felder in den SDK-Typen; `@google/generative-ai` 0.24.1 kennt keine Batch-Generierung; die Queue-Standardgrenzen; der 120-s-Backstop; dass Cache-Token heute nirgends gezählt werden.

**NICHT gemessen und aus dieser Sandbox nicht messbar (alle ausserhalb von Tests als "unbestätigt" behandeln):**

- Verhalten der Batch-APIs live: Dauer typischer Batches, Rabatt, Limits je Batch/Tarifstufe, Ablauf, Ergebnis-Aufbewahrung, `custom_id`-Regeln, ob Modelle des Händlers Batch unterstützen, ob Caching im Batch greift, Fehlerarten bei `errored`.
- Maximale Ausgabe-Token je Modell (Tabelle §3.2 ist Recherche-Stand); SDK-Schutzprüfung für nicht gestreamte Aufrufe mit grossem `max_tokens`; Token/s je Modell (Grundlage des Timeouts).
- Cache-Mindestlängen je Modell, Cache-Rabatte je Modell, ob ein Präfix tatsächlich trifft.
- Qualität/Zuverlässigkeit grosser Pakete (Garbling-Quote) und die beste Paketgrösse; Schreibtempo von `applyBulkDiff` bei 3 000+ Gruppen; die Wirkung der korrigierten Queue-Schätzung auf kleinen Schlüsseln; wie `AIQueueService.enqueue` eine Schätzung über dem TPM-Limit behandelt.
- Ob ein Provider im Batch dieselben `usage`-Felder liefert wie live.

**Wie das gemessen wird:** ein **Probe-Lauf** unter Einstellungen -> Probes (bestehender Probe-Bereich, [api.translation-probe.tsx](../../app/routes/api.translation-probe.tsx) bzw. sein Muster), der auf Wunsch eines Operators auf einem Test-Shop (a) ein Mini-Batch (3 Einträge) einreicht und einsammelt, (b) einen Cache-Treffer provoziert (zwei Pakete mit gemeinsamem Präfix über Mindestlänge) und die gemeldeten Cache-Token anzeigt, (c) die Ausgabegrenze eines gewählten Modells durch einen absichtlich grossen Auftrag prüft. Kein Einbau hängt davon ab, dass die Probe schon gelaufen ist: unbekannt = vorsichtiger Standard (Grenze 8192, kein Cache-Marker, voller Preis).

---

## 9. Fehlerfälle und Rails (Übersicht)

| Fall | Verhalten |
|---|---|
| Paket unvollständig/garbled/abgeschnitten | Halbieren (max. 2 Stufen), dann einzeln, dann Zellfehler; nie Quelle als Übersetzung, nie unverifizierter Wert |
| Einzelner Eintrag falsch (HTML-Skelett, geschützte Tokens, Echo) | Eintrag wird ersetzt wie oben, Rest des Pakets bleibt gültig |
| Provider-Schlüssel abgelehnt | Lauf bricht ab (wie heute `isRunAbortingAIError`), bis dahin Geschriebenes bleibt |
| Managed verweigert/Budget leer (sofort) | Stand-down wie heute, Verifiziertes wird geschrieben, `managed_ai_refused:<grund>` |
| Queue-Shutdown | `server_shutting_down`, Verifiziertes wird geschrieben |
| Prozess stirbt (sofort) | Heartbeat-Recovery wie bisher; geschriebene Blöcke bleiben, Wiederstart füllt nur den Rest |
| Prozess stirbt (Batch wartend) | Nichts passiert (Status `waiting_batch`); der nächste Tick sammelt ein |
| Prozess stirbt (Batch, beim Einsammeln) | Lease-Token läuft ab, nächster Tick sammelt erneut; idempotent durch `fillOnly`; Buchung und `metered` in einer Transaktion, also weder doppelt noch nie (§6.4) |
| Inhalt zwischen Einreichen und Ergebnis geändert | `expected`-Digest je Ziel-Ressource + Live-Leer-Prüfung im Schreibweg: nur noch leere Zellen mit unveränderter Quelle werden gefüllt, Rest `skippedChanged`/`skippedFilled` |
| Batch abgelaufen/abgebrochen | Teilergebnisse werden verwendet, Rest gemeldet (`batch_expired`/`batch_entry_not_delivered`), kein automatischer Neustart |
| Einreichen teilweise gescheitert | Eingereichtes läuft, Rest `notStarted` |
| Modell/Tarif lässt Batch nicht zu | `batch_submit_refused`, nichts gebucht, "Sofort" bleibt möglich |
| Händler wechselt Anbieter/Schlüssel im Warten | Das Einsammeln benutzt den Anbieter und das Modell aus dem Manifest, nicht die aktuellen Einstellungen; fehlt der passende Schlüssel inzwischen, Task `failed` mit `ai_key_missing` und Hinweis (Batch-Ergebnis bleibt beim Anbieter) |
| Zwei Läufe gleichzeitig | Single-Flight zählt `waiting_batch` mit |

---

## 10. Testplan (vitest, `tests/unit/`, keine `zz-*`)

Neue Dateien, je Phase:

- Phase 1a-meter: `ai-pricing-cache-batch.test.ts` (alle Faktoren 1.0 = altes Ergebnis; Anthropic Lese/Schreib; Batch 0.5 nur auf Nicht-Cache-Anteile; Aufrunden; unbekannter Faktor = voller Preis; `assertCeilingsCoverTable` bleibt grün), `ai-usage-meter.test.ts` erweitern (Cache-Spalten, `inputTokens` = Summe; Claude-Usage mit `cache_*`), Migration additiv/Default 0.
- Phase 1a-write: siehe §19.9 (`fill-only-apply.test.ts`, `bulk-translate-blocks.test.ts`, `bulk-translate-cancel.test.ts`, `bulk-translate-single-flight.test.ts`, `bulk-translate-handle-prefill.test.ts`).
- Phase 1b: `ai-model-limits.test.ts` (Tabelle, unbekannt = 8192, Schnitt mit Cap/Marge), `bulk-translate-queue-rails.test.ts` (TPM-Sofortablehnung, grosses Paket gesplittet, höchstens ein grosses je Shop).
- Phase 1b: `bulk-translate-packages.test.ts` (Gruppierung nach Anweisungssatz/Sprach-Signatur, Packgrenzen Zeichen/Tokens/Anzahl, Einzelpaket für Riesenfeld, Deduplizierung, Optionswerte-Slices, productType-Cache, Handle-Gruppe), `bulk-translate-package-verify.test.ts` (fehlende ID/Locale, Zusatz-ID, Umbruch bei Kurz, HTML-Skelett, href-Erhalt, geschützte Tokens, Echo >= 200, Stop-Reason `max_tokens`, vertauschte Einträge), `ai-service-package.test.ts` (Prompt-Reihenfolge Präfix zuerst, Mapping per ID, Nachholleiter Halbieren -> Einzeln -> Fehler, Managed-Refusal/Schlüssel/Shutdown brechen ab statt als Eintragsfehler, Optionen = byte-gleiche Altaufrufe).
- Phase 1c: `bulk-editor-translate-handler.test.ts` erweitert (Mock-`AIService`): Blockschreiben mit Zwischen-Abbruch (Neustart-Simulation), Managed-Stand-down schreibt Verifiziertes (`bulk-editor-translate-managed-refusal.test.ts` bleibt grün), Fortschritt/Terminalstatus bedingt, `estimateOnly` liefert dieselbe Paketzahl wie der Lauf und legt KEINE Zeile an, Plan-Gate (Free/Basic 403 auch bei `estimateOnly`). **Der Test "Limit 10 000" (`buildJobs`) gehört in 1c und läuft erst mit der gemessenen Blockzeit; bis dahin gilt 2000** (M9).
- Phase 1d: `ai-service-prompt-caching.test.ts` (Marker nur ab Mindestlänge und >= 3 Pakete; Anthropic-Usage mit Cache-Feldern wird vollständig gebucht; OpenAI `cached_tokens`).
- Phase 2: `bulk-translate-batch-manifest.test.ts` (Manifest ohne Quelltexte, Grösse, `expected` je Ziel-Ressource), `bulk-translate-batch-poll.test.ts` (Lease-Token-CAS: genau ein Besitzer bei zwei Ticks, Ablauf, Verlängerung nur mit Token, `expiresAt` wird nachgezogen und alle drei Cleanups schliessen `submitting`/`waiting_batch`/`cancel_requested` aus, Status-Übergänge bedingt, Abbruch), `ai-batch-anthropic.test.ts` und `ai-batch-openai.test.ts` (gemockte SDK-Antworten: succeeded/errored/expired/canceled, abgeschnitten, fehlende Zeilen, Fehlerdatei), `bulk-translate-batch-managed.test.ts` (Reservierung verweigert, Einwilligung beim Einsammeln entzogen = Stand-down ohne Abruf, Budget leer beim Einsammeln bucht trotzdem, Buchung unter der Manifest-Periode und dem Manifest-Pool aus dem Einreichen (nicht Einsammelzeitpunkt), Buchung+`metered` atomar, Reservierung in beiden Tabellen freigegeben), `bulk-translate-batch-resume.test.ts` (Prozess stirbt nach dem Einreichen, vor dem Speichern, beim Einsammeln), `bulk-translate-batch-single-flight.test.ts` (alle `running`-Filter zählen `waiting_batch`).
- Wächter-Tests: `ai-key-source-isolation.test.ts` bleibt grün (kein `process.env`-Zugriff in neuen Modulen); `translation-write-guard.test.ts` bleibt grün (Schreiben nur über `applyBulkDiff`); `graphql-document-hygiene.test.ts` unberührt; ein Test, dass die Seite im Ergebnis-Poll `waiting_batch` nicht als Abschluss liest.
- Merchant-sichtbar: i18n-Typprüfung (`de/en/es.ts`) erzwingt alle drei Sprachen; Guide-Typ erzwingt `de/en/es`.
- Zum Schluss je Phase: `npm run typecheck`, `npm run lint:hooks`, volle Suite, `npm run build`.

---

## 11. Commit-Reihenfolge (Revision 2)

Arbeitsweise laut CLAUDE.md (Sonnet programmiert, Opus prüft, Schleife bis kein kritischer Befund bleibt). Die Sicherheits-Grundlagen kommen vor Paketierung und Batch, weil sie auch den bestehenden Zeilenpfad verbessern.

**Phase 1:**

1. **1a-write** (Zeilenpfad, kein neuer Prompt): `fillOnly` im `ApplyContext` mit `expected` je Ziel-Ressource und Live-Leer-Prüfung (§19.1-§19.3), `BulkApplyResult.skippedChanged/skippedFilled`, `recheckMissing`, Blockschreiben (`chunkImportDiff` in ein gemeinsames Modul), Abbruch wird geachtet (Statusprüfung vor Schritt/Block, Tasks-Tab verzweigt nach Status), `handlesByLocale`-Vorbelegung (§19.8), atomares Single-Flight (§19.7). Limits unverändert (2000), keine Pakete.
2. **1a-meter** (Zähler): `priceCall`-Optionen, `AiCallUsage`-Cache-Felder, zwei additive Spalten, Reservierungs-Filter in `getAiUsage`/`ai:usage` (§19.5). Keine Verhaltensänderung bestehender Aufrufer.
3. **1b Paketierung** hinter Schalter `BULK_TRANSLATE_PACKAGES` (Standard aus): `translate-packages.shared.ts`, `translate-package-verify.shared.ts`, `AIService.translatePackage` mit Nachholleiter, Glossar je Paket, Timeout-Rechnung, `ai-model-limits.ts`, Queue-Rails (§19.6: Sofortablehnung über dem TPM-Limit, grosse Pakete splitten, höchstens ein grosses je Shop), `plannedOutputTokens`, `savePromptToTask` begrenzt, Stop-Reason-Erkennung NUR auf dem Paketpfad. Messen (Retry-Quote, Anfragen), dann Standard an.
4. **1c Dialog und Limit**: `estimateOnly` (legt keine Zeile an), Bestätigungsfenster, i18n, Guide. **`MAX_TRANSLATE_UNITS` 10 000 erst nach gemessener Blockzeit.**
5. **1d Caching**: Anthropic-Marker (bedingt, nur Regeln+Anweisungen), OpenAI-Reihenfolge/Auslesen, Probe.

**Phase 2** erst, wenn §19.3-§19.7 (Abwicklungs-Zugriff, `BulkTranslateBatch`, Reservierung in BEIDEN Tabellen, `submitting`/Absichtseintrag, Cleanup-Ausschlüsse, `batch_unreachable`, Orphan-Recovery-Anpassung) gebaut und geprüft sind:

6. **2a Anthropic**: Schritt 0 = Vollliste der `"running"`-Filter und Cleanups + Probe des `custom_id`-Musters; Transport, Zustandstabelle, Statusübergänge (bedingte `updateMany`), Poll-Dienst, Einsammeln, Abbruch, Reservierung/Buchung, Seiten-Moduswahl, Tasks-Tab (Cancel/Delete je Status), Guide, Probe (Mini-Batch).
7. **2b OpenAI**: Transport (Dateien, JSONL, immer löschen), Mehrfach-Batches.
8. **Gemini: kein Batch** (Owner-Entscheid).

Nach jeder Phase: Review-Pass, Doku (CLAUDE.md-Invarianten, KNOWN_ISSUES laut §18), Merge nach `develop` nur bei grünem Stand.

---

## 12. Guide-Update (Händlersicht)

Betroffen: Thema `bulk-translate` ([marketing-guide.ts](../../app/config/marketing-guide.ts) L115 hat den Video-Slot bereits; Text in [app/i18n/marketing/guide/](../../app/i18n/marketing/guide/) `de.ts` L684-706, `en.ts`, `es.ts`), Thema `translating`/`ai-instructions` nur bei Bedarf. Was sich für den Händler ändert:

- **Vor dem Start erscheint ein Bestätigungsfenster** mit Anzahl Übersetzungen, Anzahl KI-Anfragen und einer ungefähren Kostenangabe (Schätzung; bei der App-eigenen KI im Verhältnis zum Restguthaben). Phase 1c.
- **Mehr pro Lauf**: bis zu 10 000 statt 2000 Übersetzungen (erst nach der Messung in Phase 1c); was nicht mehr hineinpasst, bleibt für den nächsten Lauf (Text mit der Zahl anpassen). Phase 1c.
- **Schneller und günstiger**, weil gleichartige Felder vieler Produkte gemeinsam übersetzt werden; unveränderte Regeln: nur leere Übersetzungen werden gefüllt, Anweisungen und Glossar gelten wie bisher. Kein neuer Bedienschritt. Phase 1c.
- **Ergebnisse werden laufend gespeichert**: Wird die App während des Laufs neu gestartet, ist bereits Gespeichertes erhalten (der bisherige Absatz "Was dabei noch nicht gespeichert war, wurde nicht geschrieben" wird präzisiert: es geht höchstens der zuletzt laufende Block verloren). Phase 1c.
- **Moduswahl "Sofort" oder "Günstiger, Ergebnis bis zu 24 Stunden"** (nur bei Anbietern, die das können: Anthropic/Claude und OpenAI; bei den anderen erscheint die Wahl nicht). Im Modus "Günstiger, Ergebnis bis zu 24 Stunden" steht die Aufgabe im Reiter "Aufgaben" als "Wartet auf den Anbieter", sie ist abbrechbar, die App darf in der Zwischenzeit neu starten, und Ergebnisse werden eingetragen, sobald sie da sind; Übersetzungen, die inzwischen von Hand ausgefüllt wurden oder deren Originaltext sich geändert hat, werden übersprungen und gezählt. Nicht für die Probierguthaben-Nutzung. Phase 2.
- Neue Meldungen im Ergebnis (Anzahl Anfragen, "übersprungen, weil geändert", "vom Anbieter nicht geliefert") in `de/en/es` der Task-Anzeige (`app/i18n`), Fehlercodes `batch_*` in `taskErrorText`.
- Alles ohne technische Begriffe: kein Wort zu API, Manifest, Lease, Echo.

---

## 13. Risiken

- **Verifikation zu streng oder zu lasch** (HTML-Skelett, geschützte Tokens): zu streng = viele Nachholer (Kosten), zu lasch = falsche Werte. Gegenmittel: Retry-Quote und Gründe loggen, Regeln in einem reinen, getesteten Modul, Fehlerfälle immer als Zellfehler statt Schreiben.
- **Paketgrösse**: zu gross = Garbling/Abschneiden, zu klein = kaum Ersparnis. Startwerte konservativ, per Telemetrie nachjustieren.
- **Timeout/Ausgabegrenze**: ein falsch angenommenes Modelllimit liefert abgeschnittene Antworten (erkannt über Stop-Reason, kostet aber die Ausgabe). Standard 8192 für Unbekannte.
- **Queue-Verhalten bei grossen Schätzungen** (§1.3): vor Phase 1c im Code verifizieren; sonst Pakete, die nie zugelassen werden.
- **Statuswert `waiting_batch`** ist ein neuer Wert in einem freien String; jede unbekannte Stelle, die auf `running` filtert, übersieht ihn (Single-Flight!). Gegenmittel: Grep-Liste in 2a Schritt 0 und Test, der alle Filter benennt.
- **Verwaister Batch** beim Prozesstod zwischen Einreichen und Speichern (§5.3): bleibt ein Rest, der Geld kosten kann; bei OpenAI per `metadata` auffindbar.
- **Buchung** beim Wiederholen des Einsammelns: Ledger-Buchung und `metered`-Markierung in EINER Transaktion (§6.4); keine Doppelbuchung nach Absturz.
- **Managed-Budget**: Reservierung ist eine Obergrenze-Schätzung; parallele Ausgaben im Warten können das Budget überschreiten (begrenzt, gestanden).
- **Grössere Läufe = grössere Wirkung eines Fehlers im Schreibpfad**: deshalb blockweises Schreiben, Re-Scan je Block, Opus-Review der Schreibregeln.
- **Preisangaben/Fähigkeiten veralten**: Tabellen tragen Datum und werden wie `PRICES_CHECKED_ON` gepflegt.

---

## 14. Entscheide in diesem Plan (Zusammenfassung)

| Frage | Entscheid |
|---|---|
| Laufgrenzen | Einheiten 10 000 (nach Messung), Kandidaten 500, Scan 5000, `MAX_TASK_CALLS` je Block (§7) |
| Zustand des Batches | Task-Zeile (Status `submitting`/`waiting_batch`/`cancel_requested`) + additive Tabelle `BulkTranslateBatch` (Manifest, Lease-Token, Reservierung), `expected`-Digest statt Quelltext/Hash (§19.4) |
| Wiederanlauf | Lease-Token-CAS auf der Batch-Zeile, nicht Orphan-Recovery; Einsammeln idempotent durch `fillOnly` |
| Anbieter Batch | Anthropic (2a), OpenAI (2b); Gemini bleibt Sofort-only (Owner-Entscheid); Grok/DeepSeek/HuggingFace nicht |
| Batch-Preis | an den Händler weitergegeben (`billedMicros = costMicros`) |
| Moduswahl | Dialog, "Sofort" vorausgewählt; Batch nicht für Taster |
| Schema | nur zwei additive Zähler-Spalten (Cache), Phase 1a; Reservierung als Zählerzeile im bestehenden Schema |
| Plan | Pro bleibt, alle Tore bestätigt (§15) |

## 15. Tore (Plan-Stufe bleibt Pro)

Bestätigt aus dem Code, bleibt unverändert und gilt für **beide** Modi und `estimateOnly`: (1) Seite: Loader sperrt unter Pro (`gated: true`, app.bulk_.translate.tsx L131-137); (2) `/api/ai`: `planGateRefusal` nach Inhaltstyp und `aiRefusalFor` (api.ai.tsx L133-158); (3) Handler: `meetsPlan(plan, "pro")` L113-117 und Inhaltstyp-Plan L119-127; (4) Zeilentypen/Spalten kommen aus dem serverseitigen Universum. Neu dazu: der Abbruch-Intent und `estimateOnly` laufen durch dieselben Zeilen vor dem Abzweig (Test), und die Batch-Verfügbarkeit wird serverseitig erneut geprüft. Das Einsammeln im Poll-Dienst hat keine Anfrage und damit kein Request-Tor: es liest den Plan des Shops frisch (`AISettings.subscriptionPlan`). Bei einem Abstieg unter Pro wird ein bereits eingereichter Batch trotzdem eingesammelt und mit den üblichen Schreibregeln geschrieben (Entscheid: bezahlt ist bezahlt); neu einreichen kann nur, wer Pro hat.

## 16. Owner-Entscheide (entschieden 2026-11-12) und offene Fragen

**Entschieden:**

1. **Gemini bleibt Sofort-only**: kein Batch, keine neue Abhängigkeit (`@google/genai`), kein rohes REST. Phase 2c entfällt.
2. **Der Batch-Rabatt wird an Händler mit der App-eigenen KI weitergegeben** (`billedMicros = costMicros`, §3.6).
3. **Dialogtext "Günstiger, Ergebnis bis zu 24 Stunden" ist genehmigt**; wir versprechen keine kürzere Zeit.

**Entschieden (Owner, 2026-11-12, H-3):** Wird die Einwilligung entzogen, während ein Batch wartet, wird er SOFORT beim Anbieter abgebrochen; es wird NICHTS mehr abgerufen und nichts geschrieben. Gebucht wird die bei der Einreichung reservierte, vorsichtig geschätzte Obergrenze (§6.3/§19: Σ Eingabeschätzung + gesendetes `max_tokens` x Preis) statt der tatsächlichen Kosten: die Reservierung wird in beiden Tabellen in eine Buchung umgewandelt statt freigegeben. Begründung: wer die Einwilligung zurückzieht, erwartet, dass nichts mehr verarbeitet wird; der Fall ist selten, und der Händler wird eher zu hoch als zu tief belastet. Kill-Switch und Plan-Ende werden NICHT so behandelt (dort gilt weiter: abrufen, buchen, Schreiben am normalen Gate). Alles Übrige ist entschieden (§14) oder steht als gestandener Rest in §18.

**Koordinator-Entscheid, vom Owner zu bestätigen (Leitregel für jede Reservierung):** Sobald ein Batch beim Anbieter existieren KANN (die Anlage wurde gesendet und nicht eindeutig abgelehnt, oder eine Batch-Kennung ist gespeichert), wird eine Reservierung NIE einfach freigegeben. Sie wird entweder (a) aus Belegen gebucht: tatsächliche Nutzung aus den Ergebnissen, oder anteilig aus `request_counts` der Statusabfrage (erfolgreiche Anfragen x die reservierte Obergrenze genau dieser Anfragen, wobei die teuersten angenommen werden, damit nie unter den Kosten gebucht wird; die Zähler zu lesen holt keinen Inhalt und ist deshalb auch beim Einwilligungsentzug und bei der Löschung erlaubt), oder (b) auf die reservierte Obergrenze umgewandelt, wenn sich nichts lesen lässt (Anbieter nicht erreichbar, Schlüssel weg, Schalter aus, Batch beim letzten Blick noch nicht beendet). Freigegeben wird nur, wenn der Status des Anbieters beweist, dass nichts verarbeitet wurde (beendet mit `succeeded === 0`), oder die Anlage eindeutig abgelehnt wurde (4xx mit Antwortkörper). Ein bestätigter Abbruch ist kein Beleg: er wirkt beim Anbieter verzögert, und ein schon beendeter Batch lief. Das gilt für jeden Endpfad (absolutes Ende, nicht erreichbar, verwaister Eintrag, Deinstallation und Löschung, Einwilligungsentzug, ein Einreichen, dessen Aufgabe verloren ging), und die Reservierung wird immer VOR dem Schliessen der Zeile abgewickelt. Eine Anlage mit unbekanntem Ausgang (Zeitfehler, Abbruch, Verbindungsabbruch, 5xx/529) behält die Reservierung: die Zeile wartet als `create_unknown`, der Poller sucht den Batch über die Kennung der eigenen Anfragen und übernimmt ihn, und erst das absolute Ende wandelt in die Obergrenze um. Eigene Konfigurationsverweigerungen (Schalter, Entwicklungs-Build, fehlender oder gewechselter Betreiber-Schlüssel) zählen nicht als Fehlversuche: die Zeile wartet bis zum absoluten Ende. Der Einwilligungsentzug bleibt «sofort abbrechen, keinen INHALT abrufen, nichts schreiben», gebucht wird anteilig aus den Zählern, sonst die Obergrenze (nie unter den Kosten). Ein Wechsel der Einwilligungsversion ist KEIN Entzug: die Zeile wird gehalten (nichts abgebrochen, abgerufen oder geschrieben), bis der neue Text bestätigt wird oder das absolute Ende erreicht ist.

---

## 17. Review-Rails (Revision 1)

### 17.0 Befunde des Reviews, gegen den Code geprüft

| Befund | Geprüft | Ergebnis |
|---|---|---|
| C1 `applyBulkDiff` hat keine Leer-Regel | apply.server.ts (Fremdsprach-Gruppe L2978 ff., keine Leer-Prüfung gefunden); Digest wird beim Schreiben gelesen (`fetchDigestsForResource`, verified-translations.server.ts L50-90) | **bestätigt**, erste Fassung war falsch; §4 |
| C2-C4, H1, H2 | Abwicklung ohne Gate gibt es nicht; `recordAiUsage` fällt auf `m:` (usage-meter.server.ts L122/L203); Task-Cleanups an drei Stellen; Abbrechen läuft heute über app.tasks.tsx | **bestätigt**; §5.3, §5.6, §6 |
| H3 | Prompt/Mapping per ID verhindert nicht vertauschte Inhalte | **bestätigt**, Gegenmassnahme §3.1, Rest §18 |
| H4 | `canExecute` (ai-queue L483-499), Bucket `byo:<provider>` global (L91-93); `enqueue` ohne Zulassungs-Timeout (im Code der Eintragung keine Zeitprüfung gefunden) | **bestätigt** (Altlast); §3.2, §18 |
| H5 | `maxRetries: 2` (ai.service.ts L153), `AI_QUEUE_CONCURRENCY` app-weit (L118-131) | **bestätigt**; Timeout-Rechnung korrigiert |
| H6 | `handlesByLocale` beginnt leer (Handler L466) | **bestätigt** |
| M1 | Glossar-Kappe `MAX_TERMS_IN_PROMPT` 200 | **bestätigt**; Glossar je Paket |
| M2 | `/api/task-result` liefert `result`/`resultSummary` (L49-70) | **bestätigt** |
| M7, M8 | Loader-Scan läuft bei jedem Seitenaufruf | **bestätigt**; Kandidatenfenster bleibt 500 |
| Faktenfehler | Zielsprachen = alle nicht-primären (Handler L139-141); Reaper `NON_TERMINAL` L125; `expiresAt`-Löschungen an drei Stellen; Seitenzeilen `handleStart` L356 / Poll L390; `estimateOnly` hinter `aiRefusalFor` | **bestätigt**, korrigiert |
| Nicht bestätigt / eingeschränkt | Die genaue Wirkung "kein Zulassungs-Timeout" auf den Betrieb wurde nur aus dem Lesen der Zulassungsschleife abgeleitet, nicht in einem Lauf nachgestellt; Phase 1a enthält einen Test dafür. Die Provider-Aussagen (Musterlängen der `custom_id`, Cache-Rabatte im Batch) bleiben unbestätigt, §8. | |

Wo der Review und der Code abwichen: nirgends im Kern; die erste Fassung von §4 und §6 war schlicht falsch bzw. unvollständig.

### 17.1 Zusammenfassung der neuen Rails

- Schreiben nur mit `expectedDigest`-Treffer, Live-Read leer und Re-Scan leer (C1).
- Abrufen/Buchen/Abbrechen eines Batches braucht keine Einwilligung; Schreiben schon (C2). Ausnahme: nach Einwilligungsentzug nur noch Abbrechen und Buchen der Reservierung, kein Abruf (§16).
- Reservierung ist persistiert und zählt in Shop-Budget und Pool; Buchung unter Manifest-Periode/-Pool in einer Transaktion (C3, M3).
- Phase `submitting`, unbedingtes Speichern der Batch-ID, Abbruch bei verlorenem Task, Verwaisten-Sweep (C4).
- Abbruch über den Tasks-Tab, nie Löschen bei offenem Batch, Worker achten `cancelled` (H1).
- Redact/Deinstallation brechen Batches ab und löschen Provider-Dateien; Poll-Dienst respektiert Shop-Status (H2).

---

## 18. Gestandene Reste und Altlasten (an den Owner und nach KNOWN_ISSUES, deutsch, ohne Sicherheitsdetails)

Nach der Umsetzung wandern diese Punkte in [KNOWN_ISSUES.md](../reference/KNOWN_ISSUES.md) (Abschnitt je nach Art) und werden dem Owner als Liste vorgelegt:

**Altlasten, schon heute vorhanden (nicht durch diesen Plan verursacht):**

1. **Queue ohne Zulassungs-Timeout**: eine Anfrage, deren Schätzung nie unter das Minutenlimit passt, wartet unbegrenzt. Plan behebt es in Phase 1a (Timeout), die Ursache der zu grossen Schätzungen entfällt mit der korrigierten Schätzung. Schwere: mittel; Aufwand klein.
2. **Sofort-Runner ignoriert Abbrechen**: ein im Tasks-Tab abgebrochener `bulkEditorTranslate`-Lauf läuft weiter. Behoben in Phase 1a. Schwere: mittel; Aufwand klein.
3. **BYO-Rate-Limit-Buckets sind global je Anbieter**, nicht je Händler (zwei Shops mit eigenem Schlüssel desselben Anbieters teilen sich 5 Anfragen/Minute beim Claude-Standard). Nicht Teil dieses Plans. Schwere: mittel bei vielen Shops; Aufwand mittel (Bucket je Schlüssel).
4. **`savePromptToTask` schreibt die ganze Historie je Aufruf neu**: begrenzt für Paketaufrufe in Phase 1a, für alle anderen Aufrufer unverändert. Schwere: klein.

**Gestandene Reste dieses Plans:**

5. Vertauschte Übersetzungen zweier ähnlicher kurzer Einträge mit gleichen Zahlen sind nicht erkennbar (H3).
6. Verwaiste Batches bei Prozesstod zwischen Einreichen und Speichern, bzw. bei BYO ohne Auflistungsmöglichkeit, bleiben beim Anbieter bis zum Ablauf und können Geld kosten (C4).
7. Parallele Ausgaben anderer Funktionen im Warten werden von der Reservierung nicht vorab gesehen, nur die Reservierung selbst; Überschreiten ist durch die Batch-Grösse begrenzt (C3).
8. BYO-Händler, die im Warten ihren Schlüssel löschen, verlieren die Ergebnisse (der Batch läuft aus).
9. Qualität grosser Pakete, Paketgrösse, Cache-Mindestlängen und Batch-Rabatt auf Cache-Anteile sind nicht gemessen (§8); bis dahin vorsichtige Standardwerte.
10. Bei einem Abstieg unter Pro wird ein bereits eingereichter Batch trotzdem eingesammelt und geschrieben (bezahlt ist bezahlt).

---

## 19. Revision 2 (Re-Review): massgebliche Designs

Jeder Punkt des Re-Reviews wurde gegen den Code geprüft. Bestätigt, mit Ort: C-1 (`ManagedAiGlobalCounter` in managed-global-pool.server.ts L82-190, `AiUsageCounter` getrennt; shop-overview summiert `costMicros`, L338-351/L465; `getAiUsage` gibt je `feature` eine Zeile), H-3 (`isManagedAiEnabled()` L128 und der Dev-Guard `isDevAppBuild()`/`managedDevTestingEnabled()` L213-216 in ai-credentials.server.ts), H-4 (`app.tasks.tsx` L238-245 `update` ohne Statusbedingung; Cancel-Knopf nur für `pending`/`running`, L556), `orphan-run-recovery.js` mit `status: "running"` an vier Stellen (L136, L194, L208, L221), `DIGEST_BATCH_CHUNK = 50` und `loadDigestsForRows` (L108), `groupDiffByRow` fasst Zellen je Gruppe zusammen (columns.shared.ts L2185), `loadTranslatedLocales`/`loadSubResourceTranslatedLocales` in missing-translations.server.ts (L365, L418). **Keine Abweichung vom Review in der Sache.** Eine Einschränkung: Die Reaper-Wirkung auf einen Task mit persistierter Batch-ID (Low-Befund) ist aus dem Lesen von `orphan-run-recovery.js` abgeleitet, nicht in einem Lauf gezeigt.

### 19.1 Digest beim Planen (H-1)

Der Planungs-Read läuft im detached Lauf (Sofort) bzw. beim Einreichen (Batch), gebündelt in der bestehenden Digest-Vorabholung (`loadDigestsForRows`, Chunks à `DIGEST_BATCH_CHUNK`, aliasiert) und fragt `translatableContent { key value digest }`. **Annahme "Digest = Hash des Textes" wird nirgends getroffen.** Entscheid bei Abweichung zwischen dem LIVE-Wert (`value`) und dem gecachten Quelltext des Scans: **der Eintrag wird verworfen** (`skippedChanged`, Zähler im Ergebnis), nicht mit dem Live-Wert übersetzt. Begründung: Der Scan, die Seitenauswahl und die Vorschau haben den gecachten Text gezeigt; stillschweigend etwas anderes zu übersetzen wäre eine Handlung auf Text, den der Händler nie gesehen hat, und der Cache heilt sich beim nächsten Sync, danach nimmt ihn der nächste Lauf mit. Gleicht der Live-Wert dem Cache-Text, wird der Digest als `expected` für diese `(Ressource, Schlüssel)` festgehalten.

### 19.2 `expected` je Zelle und `fillOnly` im Schreibweg (H-2)

- Eine einzelne `expectedDigest` auf `BulkDiffEntry` kann Sub-Resource-Zellen nicht ausdrücken (eine Optionswerte-Zelle umfasst N `ProductOptionValue`-Ressourcen; `groupDiffByRow` fasst Zellen in `group.cells` zusammen). Neu: `BulkDiffEntry.expected?: Record<targetResourceId, digest>` (Schlüssel: die Ziel-Ressource, bei Zeilenfeldern die Zeile selbst, bei Metafeld das Metafeld-GID, bei Optionswerten je Wert-GID, bei Featured-Alt die Bild-GID). `groupDiffByRow` führt `expected` je Zelle bis `group.cells` durch (neues Feld `group.expected[columnId]`).
- Die **Live-Leer-Prüfung liegt INNERHALB von `applyBulkDiff`** als `ApplyContext`-Option `fillOnly: true` und gilt auf allen drei Pfaden (Zeile, Sub-Resource, Featured-Alt): vor dem Registrieren je Ziel-Ressource und Locale `translations(locale:)` (hat einen Wert -> `skippedFilled`), danach Digest-Vergleich `expected` gegen den ohnehin frisch gelesenen Digest (Abweichung -> `skippedChanged`). Es ist eine **Vorbedingung auf dem bestehenden Schreibweg, kein zweiter Schreiber** (der `translation-write-guard.test.ts` bleibt unberührt). Für die **zusammengeführte Optionswerte-Liste** gilt die Prüfung je Ziel-Ressource: ein Wert mit vorhandener Übersetzung bleibt (wie heute durch `mergeExistingListValues`), die Live-Prüfung macht das auch gegen Änderungen seit dem Scan.
- `BulkApplyResult` bekommt `skippedChanged` und `skippedFilled` (Zahlen je Zelle/Einheit), der Handler und der Summariser führen sie im Ergebnis. Ohne `fillOnly` (Grid-Speichern, CSV-Import) bleibt das Verhalten byte-gleich.

### 19.3 Abwicklungs-Zugriff (H-3)

- `settlementCredentialsFor(shop, manifest)` in `ai-credentials.server.ts` bleibt, mit Korrektur: er verlangt **`isManagedAiEnabled()` und den Dev-Build-Guard** (`isDevAppBuild() && !managedDevTestingEnabled()` = nichts tun), damit ein Staging mit zurückgespielter Produktions-DB nie mit dem Operator-Schlüssel auf produktive Batches zugreift. Übersprungen werden NUR die Prüfungen pro Shop: Einwilligung, Budget, Pool. Die **Rolle** (`default`/`failover`) des Schlüssels, unter dem eingereicht wurde, steht im Manifest; der Zugriff verwendet genau diesen Schlüssel.
- Er baut innerhalb des Moduls einen **eingeschränkten Transport** (Schlüssel in einer Closure), der ausschliesslich `retrieve`, `results`, `cancel` und `deleteFile` anbietet; der Schlüssel verlässt das Modul nie. `ai-key-source-isolation.test.ts` bleibt grün und prüft den Transport auf genau diese Methoden.
- **Entschieden (§16): Einwilligungsentzug = sofort abbrechen, nichts abrufen, nichts schreiben, reservierte Obergrenze buchen.** Die früher als A/B entworfenen Varianten sind damit erledigt. Für Kill-Switch und Plan-Ende bleibt es beim Abrufen und Buchen der tatsächlichen Nutzung, Schreiben am normalen Gate.

### 19.4 Zustand: additive Tabelle `BulkTranslateBatch` (H-4)

Begründung für das Schema: `Task.updatedAt` ist `@updatedAt` und bewegt sich bei jeder Schreibung (Lease, Heartbeat, Cancel, Fortschritt), und ein bis zu ~2 MB grosses Manifest von mehreren Schreibern lesend-ändernd-schreibend im Task zu halten verliert Schreibvorgänge. Deshalb (additiv, eine Migration, Tabelle neu, nichts liest sie vorher): `BulkTranslateBatch { id, taskId @unique, shop, state ('submitting','waiting','cancel_requested','collecting','done'), provider, model, source, role, period, pool, batchIds Json, reservedMicros Int, reservedPoolMicros Int, manifest Text, leaseToken String?, leaseUntil DateTime?, failedTicks Int, cancelRequestedAt DateTime?, createdAt, updatedAt, @@index([state]), @@index([shop]) }`.
- **Schreiber-Regel:** das Manifest schreibt nur der Lease-Halter; kleine Zustandsübergänge laufen als **bedingte `updateMany`** (`state: 'waiting' -> 'cancel_requested'` durch den Tasks-Tab, ohne das Manifest anzufassen). Buchung je Block gebündelt (nicht je `custom_id`).
- **Lease:** Token-CAS wie in §5.4 (Revision 2): übernehmen mit `updateMany where { id, OR[{leaseUntil: null},{leaseUntil < now}] } data { leaseToken: <neu>, leaseUntil: now+2min }`; verlängern/abschliessen nur `where { id, leaseToken }`. Die Buchungstransaktion (§6.4) liest die Zeile `FOR UPDATE` (Raw-Query) und prüft das Token; verlorenes Token = Rollback.
- **Task-Zeile** trägt nur Status (`submitting`, `waiting_batch`, `cancel_requested`) für Single-Flight, Listen und Anzeige; `Task.result` bleibt im Wartezustand leer (löst auch den Manifest-Ausschluss M2). Löschpfade: `redactShopData`, Deinstallation (§6.7) und Task-Löschen berücksichtigen die Tabelle.
- **`batch_unreachable` (H-6):** nach `N = 12` aufeinanderfolgenden fehlgeschlagenen Ticks (404/403, rotierter Schlüssel, Anbieter nicht erreichbar mit Antwort) wird die Zeile terminal (`done`, Task `failed` mit `batch_unreachable`), die Reservierung wird in BEIDEN Tabellen freigegeben. `failedTicks` wird bei jedem Erfolg auf 0 gesetzt.
- **Cleanup-Ausschlüsse (H-6):** alle DREI `expiresAt`-Löschungen (§1.6) schliessen Tasks mit Status `submitting`, `waiting_batch`, `cancel_requested` AUS (Filter, nicht nur Nachziehen von `expiresAt`); ein Test deckt alle drei ab.
- **`orphan-run-recovery.js`** hat `status: "running"` an vier Stellen (L136, L194, L208, L221); `submitting` braucht Anpassung: die Recovery eines `submitting`-Tasks mit **persistierter Batch-ID** (Zeile existiert, `batchIds` nicht leer) setzt ihn auf `waiting_batch`, **nicht** auf `failed`; ohne Batch-ID nach Absichtseintrag (§19.5) auf `failed` wie bisher.
- **Tasks-Tab:** Cancel-Knopf (heute nur `pending`/`running`, L556) wird für die neuen Status angeboten; die Cancel-Aktion (L238-245, heute `update` ohne Statusbedingung) verzweigt nach Status: `pending/running` wie bisher (bedingt), `waiting_batch` -> `cancel_requested` (bedingte `updateMany`), alle anderen Status unverändert/abgelehnt; der **Server verweigert Löschen** für `submitting`/`waiting_batch`/`cancel_requested`.

### 19.5 Reservierung in BEIDEN Zählern (C-1), Einreichen/Absichtseintrag, Verwaiste (H-5)

- **Reservierung in zwei Tabellen:** (1) `AiUsageCounter`-Zeile `feature = "bulkEditorTranslate:reserved"` mit **nur `billedMicros`** (nie `costMicros`: `shop-overview` und der Pool summieren Kosten, die Reservierung ist keine Ausgabe), `estimated = true`; (2) `ManagedAiGlobalCounter` des **beim Einreichen festgehaltenen Pool-Schlüssels** wird für die Reservierung hochgezählt und beim Freigeben heruntergezählt (nie unter 0, Klemmung im Statement). **Beide Schreibzugriffe laufen über `usage-meter.server.ts`** (der einzige Schreiber von `AiUsageCounter`; neue Funktionen `reserveBudget`/`releaseBudget`, die auch den Pool-Zähler bedienen, damit niemand anders schreibt). Der Freigabe-Sweep deckt BEIDE Tabellen (nicht mehr `waiting`-Zeilen, z. B. `done`/`failed`).
- **`getAiUsage` / `ai:usage`** kennzeichnen die `:reserved`-Zeile (eigene Spalte "reserviert") und rechnen sie nicht in Gesamt-Kosten. Ein Test pinnt alle drei Leser: (a) `managedBudgetStatus` zählt `billedMicros` der Reservierung, (b) `globalPoolStatus` zählt den Pool-Zähler, (c) `shop-overview`/`getAiUsage` zählen sie NICHT als Kosten.
- **Absichtseintrag vor `create` (H-5):** vor dem Einreichen wird in der Batch-Zeile `state = 'submitting'` mit `custom_id`-Präfix und der Task-ID geschrieben. Der Anthropic-`batches.list` liefert **Batch-IDs, nicht `custom_id`s**: der Verwaisten-Sweep bricht deshalb **nie** Batches ab, die dieser Datenbank unbekannt sind, und nur solche, deren erfasste Task-ID zu einem **terminalen** Task gehört. Das Zeitfenster zwischen `create` und dem Speichern der Batch-ID bei Prozesstod bleibt ein **gestandener Rest** (§18): ein Batch ohne Verweis läuft beim Anbieter aus.

### 19.6 Queue-Rails (M-2), Live-Read gebündelt (M-3), `recheckMissing` (M-4)

- **Queue (M-2, 1b):** eine Schätzung über dem TPM-Limit des Buckets wird **sofort** beim `enqueue` abgelehnt (typisierter Fehler `request_too_large`), nicht über einen app-weiten Timer-Timeout. Ein auf dem globalen BYO-Bucket ausgehungertes grosses Paket wird **gesplittet**, nicht fehlgeschlagen. Höchstens ein grosses Paket je Shop. (`plannedOutputTokens` und die TPM-Rail wandern von 1a nach 1b.)
- **Live-Read (M-3):** nicht als eigener Pfad, sondern als `translations(locale:)`-Aliase in der **bestehenden aliasierten Digest-Vorabholung** (`loadDigestsForRows`, Chunk 50), **Chunkgrösse geteilt durch die Sprachanzahl** (sonst `MAX_COST_EXCEEDED`, wie beim Drift-Scan). Er wird in `estimateCalls` mitgezählt und gilt auf diesem Pfad **unbedingt**. Gestandener Rest: zwischen Live-Read und dem Registrieren liegt ein Fenster von Sekunden.
- **`recheckMissing(db, rowIds, columns, locales)` (M-4)** ist eine NEUE Funktion, die `loadTranslatedLocales`/`loadSubResourceTranslatedLocales` (missing-translations.server.ts L365/L418) wiederverwendet, nicht den ganzen Scan.

### 19.7 Single-Flight (M-6) und Handles (M-5)

- **Single-Flight:** `create(pending)` dann `findFirst` älterer Task; Reihenfolge `createdAt`, dann `id`. Eine nach Absturz liegen gebliebene `pending`-Zeile würde sonst für immer blocken: `pending` älter als 10 min ohne Heartbeat zählt nicht (und wird vom bestehenden `resetPendingTasks`/Reaper behandelt). **`estimateOnly` legt keine Zeile an.**
- **Handle-Vorbelegung (M-5, auch H6):** je **Ressourcentyp und Ziel-Locale** (ein Produkt-Handle und ein Seiten-Handle konkurrieren nicht), aus den gespiegelten Handle-Übersetzungen. Im Shopify-Editor gesetzte, noch nicht gespiegelte Handles sind unbekannt: kollidiert die Übersetzung dort, wird die Zelle als **Zellfehler** gemeldet (gestandener Rest).

### 19.8 Zusammenfassung der Verschiebungen

- 1a ist geteilt (1a-write, 1a-meter, §11); TPM-Rail, Grosspaket-Limit, `plannedOutputTokens`, `savePromptToTask` für Pakete und `ai-model-limits.ts` sind in 1b; Stop-Reason-Erkennung nur auf dem Paketpfad.
- Reihenfolge-Widersprüche der Revision 1 sind bereinigt (§3.2 5 000 Token Sofort, `sourceHash`-Reste entfernt, "höchstens doppelt" entfernt, §10 Limit-Test in 1c).

### 19.9 Zusätzliche Tests (Phase 1a-write und 2)

`fill-only-apply.test.ts` (alle drei Pfade, Optionswerte-Liste je Ziel-Ressource, `skippedChanged`/`skippedFilled`, Verhalten ohne `fillOnly` byte-gleich), `bulk-translate-blocks.test.ts`, `bulk-translate-cancel.test.ts` (Worker stoppen, Tasks-Tab verzweigt nach Status), `bulk-translate-single-flight.test.ts` (liegen gebliebene `pending`-Zeile, Tie-Break, `estimateOnly` ohne Zeile), `bulk-translate-handle-prefill.test.ts` (je Typ und Locale), `ai-reservation-readers.test.ts` (drei Leser), `settlement-access.test.ts` (Dev-Guard, `isManagedAiEnabled`, Rolle, nur vier Methoden), `bulk-translate-batch-lease.test.ts` (Token-CAS, `FOR UPDATE`-Transaktion), `bulk-translate-batch-unreachable.test.ts`, `task-expiry-cleanups.test.ts` (alle drei Löschungen), `orphan-recovery-submitting.test.ts` (Batch-ID persistiert -> `waiting_batch`), `tasks-tab-cancel-delete.test.ts`.

### 19.10 Zusätzliche gestandene Reste (nach §18)

11. Zeitfenster Live-Read -> Registrieren (Sekunden). 12. Verwaister Batch zwischen `create` und Speichern der Batch-ID. 13. Einwilligungsentzug (§16): gebucht wird die geschätzte Obergrenze, nicht die tatsächlichen Kosten; der Händler wird in diesem seltenen Fall eher zu hoch belastet. 14. Ein im Shopify-Editor gesetzter, nicht gespiegelter Handle kollidiert erst beim Schreiben (Zellfehler).

