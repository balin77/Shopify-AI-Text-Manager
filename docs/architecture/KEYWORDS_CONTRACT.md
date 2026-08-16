# Keywords-Contract

**Was das ist:** der aktive Architektur-Vertrag für das Keyword-System — Datenmodell (Keyword/Assignment/Gruppen), AI-Bridge in die Textgenerierung, GSC-Adopt, AI-Verteilung, Autocomplete-Recherche und Kannibalisierungs-/Intent-Regeln.

**Warum das existiert:** Die Invarianten hier sind nicht aus dem Schema ablesbar (App-Layer-Garantien, bewusste Architektur-Entscheidungen gegen Alternativen, Kosten-/Prompt-Semantik). Verstöße erzeugen leise Datenfehler (doppelte Primaries, stille Rollen-Downgrades, kaputte Client-Bundles), keine Testrot-Signale.

**Historie:** formuliert in `docs/plans/PLAN_KEYWORDS_EXPANSION.md` (Phasen 1–5), 2026-07-21/22 vollständig ausgeliefert (Commits `8abb48a`…`e7f9427`), zweifach agent-reviewed, Plan entfernt. **Code-Kommentare zitieren weiterhin „PLAN_KEYWORDS_EXPANSION.md §x"** — die §-Nummern hier entsprechen denen des Plans, die Referenzen bleiben also gültig. Die UI-Überarbeitung (`PLAN_KEYWORDS_UI_REWORK.md`, Phasen 0–6) wurde 2026-07-24 via PR #9 ausgeliefert und in §UI unten zusammengefasst; auch dieser Plan wurde nach Abschluss entfernt, Code-Kommentare zitieren „PLAN_KEYWORDS_UI_REWORK.md §x".

---

## §1–§2 Datenmodell

Vier Tabellen ([schema.prisma](../../prisma/schema.prisma)), Service: [keywords.service.ts](../../app/services/seo/keywords.service.ts):

- **`SeoKeyword`** ist ein eigenständiges shop-scoped Objekt — `@@unique([shop, keyword, locale])`, dazu `priority` (1/2/3) und `intent`. Keine Item-Bindung.
- **`SeoKeywordAssignment`** verbindet Keyword ↔ Item mit `role` (`primary`/`secondary`). **Die GSC-Metriken leben HIER** (nicht am Keyword), weil GSC (query, page)-Tupel liefert. `SeoKeywordSnapshot` (Ranking-Historie) hängt ebenfalls am Assignment.
- **`SeoKeywordGroup`/`-Membership`**: Gruppen sind reine Verwaltungs-Container (CSV-Import-Ziel, Verteilungs-Einstieg). Eine Gruppe wird **nie** als Ganzes einem Item zugewiesen — Zuweisung passiert immer pro Keyword. Seit dem UI-Rework sind Gruppen **locale-scoped** (`@@unique([shop, name, locale])`, `@@index([shop, locale])`); Details in §UI.

**Invarianten (App-Layer, nicht per Constraint erzwingbar):**

1. **Höchstens EIN `primary` pro (Item, Locale).** Die Locale hängt am Keyword → Prisma kann das nicht ausdrücken. `assignKeyword`/`promoteAssignment` machen Check+Swap in **SERIALIZABLE**-Transaktionen mit P2034-Retry (`serializableWithRetry`) — bei READ COMMITTED könnten zwei parallele Writer mit *verschiedenen* Keywords beide ein Primary anlegen (kein gemeinsames Row-Lock). Rest-Duplikate fängt die Konflikte-Karte (§7.1) sichtbar ab.
2. **Kein stilles Primary→Secondary-Downgrade durch automatisierte Pfade.** `assignKeyword({ role: "secondary", keepExistingPrimary: true })` erhält ein bestehendes Primary (genutzt von Distribution-Apply und Adopt-Fallback). Nur manuelle UI-Pfade dürfen Rollen explizit ändern.
3. **Cap:** `MAX_KEYWORDS_PER_ITEM = 5` (1 primary + 4 secondaries) pro (Item, Locale); bereits zugewiesene Keywords dürfen am Cap noch die Rolle wechseln.
4. **Orphan-Cleanup:** Ein Keyword ohne Assignments UND ohne Gruppen-Memberships wird beim letzten Entfernen gelöscht — es gäbe sonst unsichtbare Rows (keine Standalone-Keyword-Ansicht). CSV-importierte, bewusst unzugewiesene Keywords überleben über ihre Membership.
5. **Client-Bundle-Gotcha:** `keywords.service.ts` wird CLIENT-seitig importiert (ItemSidebar nutzt `analyzeOnPage`). Deshalb: **nur type-only `@prisma/client`-Imports**, Fehlercodes duck-typed (`(err as {code?})?.code === "P2002"`), Isolation-Level als String-Literal. Ein Value-Import bricht den vite-Build.
6. **Gruppe besitzt die Locale ihrer Keywords** (UI-Rework): `membership.keyword.locale === group.locale` ist invariant. Die Locale kommt beim Hinzufügen **aus der Gruppe**, nicht aus der CSV-Zeile/dem Formular — die CSV-Spalte `locale` wird ignoriert (nicht Fehler). Ein Keyword kann in mehreren Gruppen liegen, aber nur in solchen **derselben** Sprache. `SeoKeyword.locale` selbst bleibt unverändert (Teil des Unique-Keys, trägt Assignments/GSC/Kannibalisierung). Siehe §UI.

**Migrations-Trick (einmalig, dokumentiert für Forensik):** `20260721150000_seo_keyword_assignments` ließ jedes Assignment die **id der Legacy-SeoKeyword-Zeile** übernehmen (Legacy-Zeile ≈ genau ein Primary-Assignment) — dadurch blieben die Snapshot-FKs über einen bloßen Spalten-Rename `keywordId→assignmentId` gültig.

## §2.2/§3.2 AI-Bridge (Textgenerierung)

[text-generation.handler.ts](../../app/routes/api-ai-handlers/text-generation.handler.ts):

- Lookup: `getItemKeywords(db, shop, itemId, "")` — Locale `""` (Primary-Sprache), primary zuerst, secondaries nach Priorität. Der Index `@@index([shop, resourceId])` existiert genau für diese Query (ohne `resourceType`).
- Prompt: Primary als Pflicht-Keyword („do not stuff"), Secondaries als Kann-Liste („never more than one per sentence"), Intent-Hint wenn klassifiziert.
- **Stuffing-Guard ist feldtyp-abhängig** — eine globale Density-Schwelle funktioniert nicht (5-Wort-SEO-Titel mit 2-Wort-Keyword ≈ 40 % Density):
  - Long-Content (`description`): Density > 3 % → Regenerate
  - Kurzfelder (`title`/`seoTitle`/`metaDescription`): Occurrences > 1 → Regenerate
  - Max **1 Retry**, danach akzeptieren + `keywordStuffingWarning: true` in der Response. **Der konsumierende Pfad ist der raw-fetch-Callback in [useFieldHandlers.ts](../../app/hooks/useFieldHandlers.ts)** (`submitAIAction`), NICHT der Fetcher-Branch in useUnifiedContentEditor (der ist Fallback für den unified-content-Pfad, der das Flag heute nicht setzt).

## §4 GSC-Adopt

[app.seo.search-console.tsx](../../app/routes/app.seo.search-console.tsx):

- **EINE** `(query,page)`-dimensionierte GSC-Query (rowLimit 5000) speist Top-Queries (via `aggregateQueryPageRows`: Summen, **impression-gewichtete** Position, Top-Page pro Query) UND Quick-Wins. **Die Vorperiode MUSS durch dieselbe Aggregation laufen** — GSCs query-dimensionierte Position ist mit der selbstgewichteten nicht vergleichbar; sonst entstehen erfundene Positions-Deltas für Multi-Page-Queries.
- Adopt (`adoptKeyword`): Page→Handle→Item-Auflösung (`resolveGscPagePath` liefert auch das Locale-Prefix als **validierten** Locale-Vorschlag), GSC-Metriken werden sofort aufs Assignment gestempelt (`assignKeyword`-`gsc`-Option), Rolle primary mit Auto-Fallback auf secondary bei bestehendem Primary. Item nicht auflösbar → `unresolved` → Item-Picker-Modal.

## §5 Gruppen, CSV, AI-Verteilung

- **CSV-Import** ([keywords-csv.ts](../../app/services/seo/keywords-csv.ts)): `keyword[,priority][,intent][,locale]`, nutzt die Grid-/Delimiter-Helfer aus redirects-csv, Cap 2000/Request. **Fehlende Priorität ist `undefined`, nicht Default 2** — ein Re-Import ohne Prioritäts-Spalte darf Bestandswerte nicht resetten. `addKeywordsToGroup` ist gebatcht (findMany/createMany + ein updateMany pro Werte-Kombination).
- **Verteilung** ([keyword-distribution.service.ts](../../app/services/seo/keyword-distribution.service.ts) + [.handler.ts](../../app/routes/api-ai-handlers/keyword-distribution.handler.ts)):
  - **Batch-LLM statt Embeddings** (bewusste Entscheidung): jeder Call sieht ALLE Keywords der Gruppe + einen Item-Chunk (`ITEMS_PER_BATCH` 15, schrumpft bei >~300 Keywords). Embedding-Vorstufe nur bauen, wenn 5000+-Produkt-Kataloge empirisch klagen — nicht spekulativ.
  - Task `distributeKeywords`, Stages `suggest`/`apply`, Single-Flight über BEIDE Stages, Item-Cap 2000, Pro-Gate. Vorschläge landen als JSON auf `Task.result`; Apply stempelt `appliedAt` in den Suggest-Task (Preview verschwindet).
  - **Kein Auto-Apply, nie.** Die Preview-Tabelle ist der Qualitäts-Gate; Confidence-Werte über Batch-Grenzen sind **unkalibrierte Heuristik** (Tie-Breaker im Merge, Default-Accept-Schwelle 0.6 — kein Ranking).
  - `maxSecondaries` begrenzt Secondary-**Items pro Keyword** (nicht Secondary-Keywords pro Item — Letzteres deckelt der 5er-Cap). Cap greift auch beim Merge-Erstinsert (Ein-Batch-Läufe).
  - **Sanitizer-Echo:** Prompts sanitisieren Keyword-Text; die Antwort-Validierung MUSS gegen die sanitisierte Form matchen und auf den Rohtext zurückmappen (sonst blockieren Sanitizer-Treffer dauerhaft ihren Batch-Slot). Gilt identisch für den Intent-Klassifikator.
  - **Cost-Preview MUSS Output-Tokens mitrechnen** (Output ist der teurere Posten). Die Mathematik lebt CLIENT-safe in [keyword-distribution.shared.ts](../../app/services/seo/keyword-distribution.shared.ts) — der Service selbst zieht den Prompt-Sanitizer → `logger.server` und darf nie in den Client-Bundle.
  - **Nicht umsetzbar:** Vendor-Facette als Verteilungs-Filter — das gecachte Product-Modell hat keine `vendor`-Spalte (nur `productType`).

## §6 Autocomplete-Recherche

[keyword-suggestions.service.ts](../../app/services/seo/keyword-suggestions.service.ts) + [api.keyword-suggestions.tsx](../../app/routes/api.keyword-suggestions.tsx):

- Inoffizieller Google-Endpoint → das gesamte Feature ist **ersatzlos amputierbar**; nichts anderes hängt daran. 429/403 → codierte Fehler, keine Retries.
- Sequentiell mit ~200 ms Delay; Alphabet-Erweiterung (26 Calls) ist **opt-in** („Mehr laden"), damit die synchrone Action kurz bleibt. Rate-Limit 3 Seeds/min/Shop (in-memory — bei Scale-out auf DB-Bucket umstellen).
- **Availability-Probe = integrierter §6.1-Spike:** `getSuggestionsAvailability()` (vom Keywords-Tab-Loader aufgerufen) probt bei stale Verdict im Hintergrund (TTL 12 h ok / 15 min blocked / 5 min unknown), loggt `[KeywordSuggestions] availability probe: …` (Railway-Logs = Spike-Ergebnis) und blockt bei `blocked` das Panel. Echte Nutzungen füttern den Cache (`markSuggestionsAvailability`). Erstverdict Produktion 2026-07-22: **ok**. Volllast-Test manuell: `node scripts/spike-suggestqueries.mjs` (auf Railway ausführen).
- Echte Recherche nur bei expliziter Merchant-Aktion — kein Prefetch (die Probe ist ein Reachability-Check, kein Keyword-Fetch).

## §7 Kannibalisierung & Search-Intent

- **Konflikt = gleiches Keyword primary auf ≥2 Items desselben `resourceType`.** Product ≠ Collection ist bewusst KEIN Konflikt (Kategorie-Seite rankt „Vasen", Produkt „grüne Keramikvase"). `findCannibalizationConflicts` ist pure über die geladene Assignment-Liste.
- **Confirm-Guard nur für MANUELLE Primary-Anlage** (`findPrimaryElsewhere` + `acceptCannibalization`-Bypass in Keywords-Tab und Sidebar). Automatisierte Pfade (Adopt, Verteilung) überspringen ihn by design — dort gilt die Preview bzw. der Merge als Gate. Sidebar-Regel: Item-Wechsel invalidiert einen offenen Kannibalisierungs-Prompt (das gestashte „Trotzdem hinzufügen"-Payload darf nie aufs neue Item feuern).
- **Intent:** `classifyKeywordIntents` (Pro, 50 distinkte Texte pro Call, gleiche Klassifikation für alle Locale-Rows desselben Texts, Task-Typ `keywordIntent`). Wirkung: Intent-Hint im Generation-Prompt, Intent↔Item-Typ-Regel im Verteilungs-Prompt.

## §UI UI-Rework — Locale-scoped Gruppen, Bulk-Assign, Item-Picker (PLAN_KEYWORDS_UI_REWORK, Phasen 0–6, PR #9)

Aus sechs flach gestapelten Cards wurde eine zweigeteilte Section (Tabs **Bibliothek** + **Zuordnungen**) mit **Sprache als oberster Dimension**. Route [app.seo.keywords.tsx](../../app/routes/app.seo.keywords.tsx) ist jetzt eine Shell (URL-State `?loc=&tab=&group=`); die Tabs/Panels leben in [components/seo/keywords/](../../app/components/seo/keywords/). Analyze/Score/Descriptor/Section-Contract unverändert — kein neuer Section-Typ.

- **Gruppen locale-scoped (einzige Migration, `20260723090000_seo_keyword_group_locale`):** `SeoKeywordGroup.locale` (`""` = Primärsprache), Unique `(shop, name, locale)`, Index `(shop, locale)`. Bestandsgruppen wurden auf `locale=""` gesetzt; Memberships, deren Keyword eine Nicht-Leer-Locale hatte, hat die Migration **ersatzlos gelöscht** (Pre-Launch-Entscheidung, Keyword-Verlust akzeptiert). Invariante-Durchsetzung in `addKeywordsToGroup` (Locale aus der Gruppe). Service-Signaturen tragen `locale`: `listGroups`/`createGroup`/`renameGroup`/`countUngrouped`/`listUngrouped`.
- **`deleteGroup` = Besitzer-Löschung (ändert das §24-Orphan-Modell für den Gruppen-Pfad):** Löschen einer Gruppe löscht **alle** Mitglieder-Keywords **unabhängig von Assignments** (deren Assignments/Snapshots kaskadieren weg). Nur ein Keyword, das in **einer weiteren** Gruppe liegt, überlebt (`groups: { none: {} }`-Filter, shop-scoped gegen Cross-Tenant-Cleanup). Der §24-Orphan-Cleanup gilt weiterhin für den **Item-Entfernungs**-Pfad; die Gruppen-Löschung ist der aggressivere, bewusst gewählte Besitzer-Pfad.
- **Bulk-Zuweisung `assignMany(db, shop, { keywordIds, targets, role, demoteExisting?, dryRun? })` → `{ applied, skipped[] }`** ([keywords.service.ts](../../app/services/seo/keywords.service.ts)): der Bulk-Einstieg für „Ganze Gruppe verteilen" / „Auswahl zuordnen" / „Recherche direkt zuordnen". Hält `assignKeyword`s Garantien **pro (Item, Locale)-Paar** (5er-Cap, Ein-Primär-Check+Swap) und bricht **nicht** hart ab, sondern liefert einen Skip-Report mit `reason` ∈ `limitReached | primaryExists | duplicate`. `dryRun: true` schreibt nichts und speist die Vorab-Warnung des Panels („12 Keywords × 2 Items — 14 würden das 5er-Limit reissen"). Der Einzel-Inline-Pfad im Zuordnungen-Tab nutzt weiterhin `assignKeyword` mit seinen bestehenden Confirm-Dialogen (§7.1).
- **Item-Picker-Endpoint** [api.seo.item-picker.tsx](../../app/routes/api.seo.item-picker.tsx) (§4.2): `GET /api/seo/item-picker?type=&q=&productType=&cursor=&locale=` — serverseitige `contains`-Suche auf `title` im DB-Cache, `take: 60`, Cursor-Paging, `{ items:{id,title,imageUrl|null}, nextCursor, total }`. Bei `locale !== ""` überlagern `ContentTranslation`-`title`-Rows die Titel. **Ersetzt den alten `pickers`-Loader-Block** (vier `findMany` à `PICKER_CAP=250` pro Seitenaufruf) — der clientseitige 250er-Cap und sein Hinweistext sind weg. Pages haben kein Bildfeld → Initialen-Textkachel.
- **AI-Verteilung + Locale (Restrisiko, siehe alter Plan §8.3):** mit locale-reinen Gruppen ist das Per-Keyword-Locale-Attribut im Verteil-Prompt redundant; ideal sieht der Prompt die **übersetzten** Item-Titel/Beschreibungen dieser Sprache, sonst matcht die AI z. B. deutsche Keywords gegen englische Produkttexte.

## §10 Nicht-Ziele (weiterhin gültig)

Kein bezahltes Keyword-Volumen (falls je: DataForSEO als eigene Entscheidung), keine Rank-Historie außerhalb GSC, kein Ahrefs-Klon, **keine Auto-Anwendung der Verteilung**, keine Clustering-Visualisierung, keine Embedding-Vorstufe ohne empirischen Bedarf.
