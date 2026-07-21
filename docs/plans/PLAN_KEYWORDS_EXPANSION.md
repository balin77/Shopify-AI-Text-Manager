# Keyword-Feature Ausbau — Vollständiger Plan (Phasen 1–5)

**Status:** Entwurf / umsetzungsbereit
**Baut auf:** vorhandener Keywords-Tab ([app.seo.keywords.tsx](app/routes/app.seo.keywords.tsx)) + Search-Console-Integration ([app.seo.search-console.tsx](app/routes/app.seo.search-console.tsx)) — beide bereits produktiv.
**Section-Contract:** siehe [SEO_SECTION_CONTRACT.md](../architecture/SEO_SECTION_CONTRACT.md) — dieser Plan **erfüllt denselben Vertrag**, führt keine neue Section ein (Keywords-Tab bleibt Container, GSC-Tab bleibt separater Verbindungs-Tab).

---

## 0. Ist-Zustand (mit Zeilen)

**Datenmodell** ([schema.prisma:1007-1028](prisma/schema.prisma#L1007-L1028)):
- `SeoKeyword`: **1 Keyword pro `(shop, resourceId, locale)`** — Unique-Constraint macht Mehrfach-Zuweisung unmöglich.
- GSC-Enrichment-Felder (`gscPosition/Clicks/Impressions/Ctr/UpdatedAt`) hängen direkt an dieser Zeile.

**UI** ([app.seo.keywords.tsx](app/routes/app.seo.keywords.tsx)):
- Tabelle: Item · Keyword · Locale · Score · Density · Presence · GSC-Position · Aktionen.
- Add-Form: Typ · Item · Keyword · Locale.
- On-Page-Analyse pur, DB-first ([keywords.service.ts:111-198](app/services/seo/keywords.service.ts#L111-L198)).

**AI-Bridge** ([text-generation.handler.ts:153-186](app/routes/api-ai-handlers/text-generation.handler.ts#L153-L186)):
- Bei `title/seoTitle/metaDescription/description` liest der Handler _das_ `SeoKeyword` (locale `""`) und hängt genau **einen** Satz an den Prompt: `Naturally include the target keyword "…" (do not stuff it).`

**Search-Console** ([app.seo.search-console.tsx](app/routes/app.seo.search-console.tsx)):
- Top-Queries (28 Tage) und Quick-Wins (Position 4–20, CTR-schwach) rendern als reine Anzeige-Tabellen — kein Weg von einer GSC-Zeile in den Keyword-Tracker.

**GDPR** ([gdpr.service.ts:200-422](app/services/gdpr.service.ts#L200-L422)):
- `SeoKeyword` in `SHOP_SCOPED_MODELS` + `redactShopData` per `deleteMany`. Für **jedes** neu eingeführte shop-scoped Modell in diesem Plan gilt dieselbe Pflicht.

**Bekannte Grenzen (Anlass dieses Plans):**
1. Merchant kann pro Item nur _ein_ Keyword tracken — realistisch wollen sie 3–5.
2. GSC-Erkenntnisse sind sichtbar, aber nicht handlungsfähig (kein „als getracktes Keyword übernehmen").
3. Kein Sammel-Import (100 Vasen-Keywords aus dem Google-Keyword-Planner landen nirgendwo sinnvoll).
4. Keine Recherche-Funktion — der Merchant muss außerhalb der App suchen.
5. Nichts warnt vor Kannibalisierung (zwei Produkte auf dasselbe Keyword).

---

## 1. Zielbild

Ein **Keyword** ist ab jetzt ein eigenständiges shop-scoped Objekt (nicht mehr eine `Item`-Property). Es kann:

- **mehreren Items** zugewiesen sein, mit einer expliziten Rolle `primary` / `secondary` pro `(Item, Locale)`;
- **in mehreren Gruppen** liegen (Gruppen = Tags);
- **eine Priorität** tragen (1 = hoch, 2 = mittel, 3 = niedrig);
- **eine Search-Intent-Klassifikation** haben (informational / commercial / transactional / navigational) — optional, per LLM einmalig gesetzt;
- **GSC-Metriken pro `(Keyword, Item)`** halten (weil GSC seine Daten als `(query, page)`-Tupel liefert — dieselbe Query kann auf zwei Items ranken).

**Gruppen** sind ausschließlich Verwaltungs-Container:
- Bulk-Import (CSV) landet in einer Gruppe.
- Filter/Sortier-Facette in der Tabelle.
- Entry-Point für die **AI-Verteilung** (§4).
- **Nie** wird eine Gruppe als Ganzes einem Item zugewiesen — Zuweisung passiert immer pro einzelnem Keyword. Das entzieht der Kannibalisierungs-Falle die Grundlage.

**AI-Verteilung** (die Auszahlung des Modells): Merchant lädt 100 Vasen-Keywords in Gruppe „Vasen 2026" → Button _„Auf Produkte verteilen"_ → Embedding-Shortlist pro Keyword (Top-5 semantisch nächste Produkte) → LLM-Feinranking → **Preview-Tabelle** mit Vorschlägen → Merchant akzeptiert/ändert → Batch-Zuweisung als Task.

---

## 2. Datenmodell-Migration

**Neue Modelle** (alle shop-scoped, in `SHOP_SCOPED_MODELS` + `redactShopData` eintragen — Drift-Guard-Test schlägt sonst fehl).

```prisma
model SeoKeyword {
  id       String  @id @default(cuid())
  shop     String
  keyword  String  // lowercased, single-spaced (normalizeKeyword)
  locale   String  @default("") // "" = primary
  priority Int     @default(2)  // 1/2/3
  intent   String? // "informational" | "commercial" | "transactional" | "navigational"

  assignments SeoKeywordAssignment[]
  groups      SeoKeywordGroupMembership[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([shop, keyword, locale])
  @@index([shop, priority])
  @@index([shop, keyword])
}

model SeoKeywordAssignment {
  id           String @id @default(cuid())
  shop         String
  keywordId    String
  resourceType String // "Product" | "Collection" | "Article" | "Page"
  resourceId   String // Shopify GID
  role         String // "primary" | "secondary"

  // GSC-Enrichment wandert HIERHIN (per-(Keyword,Item), nicht per-Keyword),
  // weil GSC (query, page)-Tupel liefert.
  gscPosition    Float?
  gscClicks      Int?
  gscImpressions Int?
  gscCtr         Float?
  gscUpdatedAt   DateTime?

  keyword SeoKeyword @relation(fields: [keywordId], references: [id], onDelete: Cascade)

  createdAt DateTime @default(now())

  // Höchstens EIN primary pro (Item, Locale) — via App-Layer sichergestellt,
  // Prisma kann das nicht direkt ausdrücken (Locale hängt am Keyword). Der
  // Assignment-Writer liest die Locale des Keywords und prüft/tauscht.
  @@unique([shop, keywordId, resourceId])
  @@index([shop, resourceType, resourceId])
  @@index([shop, keywordId])
}

model SeoKeywordGroup {
  id          String @id @default(cuid())
  shop        String
  name        String
  description String?

  memberships SeoKeywordGroupMembership[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([shop, name])
  @@index([shop])
}

model SeoKeywordGroupMembership {
  id        String @id @default(cuid())
  shop      String
  groupId   String
  keywordId String

  group   SeoKeywordGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  keyword SeoKeyword      @relation(fields: [keywordId], references: [id], onDelete: Cascade)

  @@unique([groupId, keywordId])
  @@index([shop])
}
```

### 2.1 Backfill-Migration (Alt-Daten retten)

Die alte `SeoKeyword`-Zeile war effektiv „Keyword + primary Assignment + GSC-Daten in einem". Die Migration muss:

1. Neuen Namen für die neue Tabelle wählen: **Umbenennung** ist die sauberste Variante — `SeoKeyword` bleibt der Name der neuen Keyword-Tabelle, die alte wird in `_SeoKeywordLegacy` umbenannt, in derselben Migration ausgelesen, und dann gedroppt.
2. Für jede alte Zeile:
   - `INSERT INTO SeoKeyword(shop, keyword, locale)` mit `upsert` (Duplikate zusammenfassen — dieselbe Merchant-Keyword-Kombination kann auf mehreren Items existiert haben);
   - `INSERT INTO SeoKeywordAssignment(...)` mit `role='primary'`, GSC-Feldern kopiert;
3. Alte Tabelle droppen.

**Rollback-Sicherheit:** Prisma-Migrations sind hier explizit als `-- SQL` mit `BEGIN … COMMIT` zu schreiben (kein `prisma migrate` Automagic-Rename), damit ein Fehler nichts halb hinterlässt. Datenverlust-Risiko ist real → **vorher Snapshot auf Railway erzwingen** und die Migration hinter einem `MAINTENANCE_MODE`-Flag laufen lassen (Merchant-Traffic pausiert).

### 2.2 API-Kompatibilität

Der AI-Handler ([text-generation.handler.ts:153-157](app/routes/api-ai-handlers/text-generation.handler.ts#L153-L157)) liest heute `db.seoKeyword.findUnique({ where: { shop_resourceId_locale }})`. Nach der Migration lautet die Query:

```ts
db.seoKeywordAssignment.findMany({
  where: { shop, resourceId: itemId, keyword: { locale: "" } },
  include: { keyword: true },
  orderBy: [{ role: "asc" }, { keyword: { priority: "asc" } }], // primary first
});
```

Das ergibt `[{ role:'primary', keyword:{…} }, { role:'secondary', … }, …]`. Prompt-Erweiterung siehe Phase 1.

### 2.3 GDPR (Pflicht, sonst Test rot)

Neu in `SHOP_SCOPED_MODELS` und `redactShopData` ([gdpr.service.ts:200](app/services/gdpr.service.ts#L200)):
- `SeoKeyword` (Name bleibt, Struktur neu)
- `SeoKeywordAssignment` (Cascade über `keyword.shop` würde reichen — trotzdem explizit per `deleteMany({ where: { shop } })` löschen, weil der Drift-Guard-Test _shop-Feld_ prüft, nicht Cascades)
- `SeoKeywordGroup`
- `SeoKeywordGroupMembership`

---

## 3. Phase 1 — Mehrere Keywords pro Item (primary + secondaries)

**Ziel:** Ein Item kann `1 primary` + `N secondaries` haben (Empfehlung: `N ≤ 4`, hart im Backend gecapped auf 5). Der Merchant fügt sie in der Keywords-Tabelle ODER in der SEO-Sidebar des Editors hinzu.

### 3.1 UI-Änderungen

**Keywords-Tab** ([app.seo.keywords.tsx](app/routes/app.seo.keywords.tsx)):
- Tabellen-Umbau: Zeilen sind ab jetzt **Assignments** (nicht Keywords). Zusatzspalte „Rolle" (`primary`/`secondary`) mit Badge; Sortierung Item → Rolle → Keyword.
- Add-Form bekommt einen zusätzlichen Radio: _„Als Primary hinzufügen"_ (default) / _„Als Secondary"_. Wenn der Merchant „Primary" wählt und schon ein Primary existiert → Confirm-Dialog (via [ConfirmContext](app/contexts/ConfirmContext.tsx)): „Bestehendes Primary-Keyword `X` zu Secondary machen und `Y` als neues Primary setzen?"
- Sekundär-Zeilen zeigen keinen eigenen Score — nur Primary trägt den 0-100 Score, Secondaries zeigen nur ihre Presence-Badges. (Rationale: Score ist heute presence-gewichtet und würde bei mehreren Keywords entweder verwässern oder falsch summieren.)

**SEO-Sidebar** ([SeoSidebar.tsx](app/components/SeoSidebar.tsx), [UnifiedContentEditor.tsx](app/components/UnifiedContentEditor.tsx)):
- Aktuelles Single-Keyword-Feld wird zu einer kompakten Liste (Chips + „+ Keyword"-Button, max 5).
- Erstes Chip = primary (mit Stern), Rest = secondary. Drag um Reihenfolge/Rolle zu wechseln oder Kontextmenü.

### 3.2 AI-Prompt (kritisch, weil Stuffing-Risiko)

Ersatz für die Zeile in [text-generation.handler.ts:184-186](app/routes/api-ai-handlers/text-generation.handler.ts#L184-L186):

```ts
if (primary) {
  prompt += `\n- Naturally include the target keyword "${primary}" (do not stuff it).`;
}
if (secondaries.length) {
  prompt += `\n- If it fits naturally, you may also mention: ${secondaries.map(s=>`"${s}"`).join(", ")}. Only use those that flow with the sentence; skip any that would sound forced or repetitive. Never use more than one per sentence.`;
}
```

**Hart erzwungene Regel im Handler (nicht nur Prompt):** Nach der Generation läuft ein Post-Check über `analyzeOnPage` — wenn Density > 3 % für _irgendein_ Keyword → **Regenerate mit Warnung** an das Model („previous output stuffed keyword X, rewrite with lower density"). Max 1 Retry, danach akzeptieren und Warn-Banner im UI. Verhindert offensichtliche Stuffing-Regressionen.

### 3.3 On-Page-Analyse

`analyzeOnPage` ([keywords.service.ts:111](app/services/seo/keywords.service.ts#L111)) bleibt strukturell wie sie ist — sie analysiert _ein_ Keyword. Neu: eine `analyzeMultiKeyword(item, keywords[]): PerKeywordResult[]` als dünner Wrapper, die pro Keyword den Bestandsanalyzer aufruft und zusätzlich eine **Cross-Keyword-Warnung** ausgibt, wenn die _gemeinsame_ Density > 5 % ist (Stuffing-Aggregat).

### 3.4 Deliverables Phase 1

- Migration + Backfill (§2)
- Handler-Umstellung + Retry-Logik
- Keywords-Tab Zeilen-Umbau + Rolle-Spalte + Confirm-Flow
- Sidebar Multi-Chip-UI
- `analyzeMultiKeyword` + Aggregat-Warnung
- i18n: `t.seo.keywordsPage.role.primary/secondary`, `t.seo.keywordsPage.tooManySecondaries`, Prompt-Snippets

---

## 4. Phase 2 — GSC „Als Keyword übernehmen" (1-Klick)

**Ziel:** In der Top-Queries- und Quick-Wins-Tabelle ([app.seo.search-console.tsx:492-528](app/routes/app.seo.search-console.tsx#L492-L528)) bekommt jede Zeile einen Button _„Als Keyword tracken"_.

### 4.1 Item-Auflösung

- **Top-Queries** liefern kein `page` (die aktuelle Query dimensioniert nur `query`). Zwei Optionen:
  - a) Zusatz-Query beim Loader mit `dimensions: ["query","page"]` (haben wir für Quick-Wins bereits — die Ergebnisse zusammenführen und pro Query die _Top-Page_ als Vorschlag anbieten).
  - b) Für Zeilen ohne Page: Merchant öffnet einen Item-Picker (wie im aktuellen Add-Form).
- **Quick-Wins** haben `page` direkt → Item-Auflösung über die vorhandene URL→Item-Map (siehe [redirects.service.ts](app/services/seo/redirects.service.ts) für das URL-Parsing-Muster — Path → `/products/handle` → `db.product.findFirst({ where:{ handle }})`).

### 4.2 Aktion

Neuer `actionType` in [app.seo.search-console.tsx](app/routes/app.seo.search-console.tsx):
```
actionType=adoptKeyword
  query: string, page?: string, role: 'primary'|'secondary'
```
Der Handler:
1. Resolviert `page → resourceType/resourceId` (falls page dabei ist).
2. Legt `SeoKeyword` an (upsert nach `(shop, keyword, locale='')`).
3. Legt `SeoKeywordAssignment` mit `role` und mit den GSC-Metriken _sofort befüllt_ an — die 4 Werte liegen ja bereits im aktuellen Loader-Result vor.

### 4.3 UI-Feedback

- Zeile bekommt nach Erfolg ein `"getrackt"`-Badge (bleibt bis zum nächsten Reload).
- Wenn Item nicht aufgelöst werden konnte → Modal mit Item-Picker öffnen (dieselbe Autocomplete wie im Keywords-Add-Form, [app.seo.keywords.tsx:396-421](app/routes/app.seo.keywords.tsx#L396-L421)).

### 4.4 Deliverables Phase 2

- URL→Item-Resolver-Utility (`resolvePageToItem(shop, pageUrl)`) — testbar, DB-only.
- Loader-Konsolidierung: eine `dimensions:['query','page']`-Query, deren Ergebnisse sowohl Top-Queries (aggregiert) als auch Quick-Wins (raw) speisen — spart einen GSC-Call.
- Adopt-Aktion + UI-Buttons + Modal.

---

## 5. Phase 3 — Gruppen, Priorität, CSV-Import, AI-Verteilung

**Das Herzstück.** Priorität und Gruppen sind Voraussetzung; AI-Verteilung ist die Auszahlung.

### 5.1 Gruppen-CRUD (Basis)

Neue Route `app.seo.keywords.groups.tsx` — oder integriert als Tab-Panel innerhalb `app.seo.keywords.tsx` (Empfehlung: Panel, nicht Sub-Route, um den Merchant nicht zwei Ebenen tief zu ziehen). Enthält:

- Gruppen-Liste (Name · Beschreibung · Anzahl Keywords · Anzahl zugewiesener Assignments).
- Create/Rename/Delete (Delete cascadet Memberships, nicht Keywords).
- Detail-Ansicht: Alle Keywords der Gruppe + Bulk-Aktionen (Priorität setzen, verteilen, entfernen).

### 5.2 Priorität pro Keyword

- Feld `priority Int (1/2/3)` auf `SeoKeyword` (siehe §2).
- UI: Inline-Select in der Keywords-Tabelle (Zelle „Priorität"), Filter oberhalb der Tabelle.
- **AI-Wirkung**: Der Prompt (§3.2) sortiert Primary+Secondaries nach `priority` — bei mehreren Primary-Kandidaten (theoretisch pro Item nur einer, aber pro Feld-Kombination denkbar) wird das mit höchster Priorität bevorzugt. Priorität schlägt auch in die zukünftige Score-Aggregation ein (Phase 5 §7).

### 5.3 CSV-Import

Neuer Aktions-Endpunkt `actionType=importCsv` (auf der Gruppen-Detail-Seite):
- Format wie beim vorhandenen Redirects-Import ([redirects-csv.ts](app/services/seo/redirects-csv.ts)) — der User kennt die UX schon.
- Erwartet Spalten: `keyword` (Pflicht), `priority` (optional 1/2/3), `intent` (optional), `locale` (optional).
- **Kein** `resourceId` in der CSV — Zuweisung passiert danach über AI-Verteilung oder manuell.
- Upsert pro Zeile nach `(shop, keyword, locale)`; alle importierten Keywords landen in der Zielgruppe (Membership-Insert).
- Cap 2000 Zeilen pro Import (dokumentiert im UI); alles darüber → Task-basiert (siehe [SEO_SECTION_CONTRACT.md](../architecture/SEO_SECTION_CONTRACT.md) §8).

### 5.4 AI-Verteilung (der neue Flow)

**Trigger:** Button _„Auf Produkte verteilen"_ in der Gruppen-Detail-Ansicht. Modal:
- Ziel-Resourcetyp (Product / Collection / Article / Page) — default Product.
- Optional: Filter auf einen bestimmten Produkt-Type oder Vendor oder Collection (nutzt vorhandene Product-Facetten).
- Regeln:
  - Max Secondaries pro Item (default 3).
  - Nur Items ohne bereits vorhandenes Primary in diesem Locale überschreiben? (default: **nein — leer lassen**, damit neue Primaries nicht bestehende überschreiben).
  - Locale (default: Locale der Keywords, meist primary).

**Kernentscheidung: Batching by Product, ALL Keywords per Call.** Statt einer Embedding-Vorstufe schickt jeder Call **alle Keywords** der Gruppe zusammen mit einem Batch von Produkten in _einem_ Request und lässt das LLM entscheiden. Grund: für den typischen Store (50–300 Produkte) ist die Simplizität dieses Ansatzes billiger als eine Embedding-Pipeline aufzubauen — kein Cache, keine Cosine-Math, keine Provider-Zusatzabhängigkeit. Das LLM sieht außerdem mehr Kontext und trifft dadurch tendenziell bessere Zuweisungen.

**Context-Mathematik (Grundlage der Batch-Größe):**
- 100 Keywords ≈ 800 Input-Tokens
- 15 Produkte × (Titel + 300-Token-Snippet aus `seoTitle`/`descriptionHtml`) ≈ 4.500 Tokens
- Prompt-Gerüst + Regeln ≈ 500 Tokens
- **Input pro Call ≈ 5.800 Tokens** — komfortabel unter jedem Kontext-Limit
- Output-JSON pro Batch: ~15 Items × ~100 Tokens = 1.500 Output-Tokens

`ITEMS_PER_BATCH` startet bei **15** und wird dynamisch reduziert, wenn `(keywordCount * 8 + itemCount * 320 + 500) > MODEL_INPUT_BUDGET` (Budget je Provider konfiguriert, konservativ z. B. 100k für Sonnet). Bei sehr vielen Keywords (>300) sinkt die Batch-Größe automatisch, damit die Summe passt.

**Ablauf (Task, damit UI frei bleibt und Recovery greift):**

1. **Item-Menge bestimmen.** Aus DB-Cache (`db.product.findMany` mit den Merchant-Filtern aus dem Modal). Nur `id`, `title`, `seoTitle`, `descriptionHtml[0..2000]`.

2. **In `ITEMS_PER_BATCH`-Blöcke splitten** und pro Batch _einen_ LLM-Call:
   ```
   Input:
     - Full list of ALL keywords (with priority + intent if set)
     - Chunk of N products (id, title, snippet)
     - Rules (max secondaries per item, primary-uniqueness preference, "primaryItemId=null if nothing fits")
   Output-JSON:
     [
       { "keyword": "grüne keramikvase",
         "primaryItemId": "gid://…/Product/123" | null,
         "secondaryItemIds": ["gid://…/Product/456"],
         "confidence": 0.83,
         "rationale": "kurz, 1 Satz" }
     ]
   ```
   **Anti-Kannibalisierungs-Regel im Prompt** ist Pflicht: „Weise jedes Keyword höchstens einem Primary in diesem Batch zu."

3. **Merge über Batches.** Weil jeder Batch nur seine Produkte sieht, kann dasselbe Keyword in mehreren Batches ein Primary bekommen. Merge-Regel: für jedes Keyword das Primary mit **höchster Confidence** gewinnt; alle anderen Primaries werden zu Secondaries **oder** verworfen (wenn die Cap der Secondaries erreicht ist). Diese Cross-Batch-Auflösung passiert deterministisch im Service, kostet kein weiteres LLM.

4. **Preview-Tabelle** rendern — _keine_ Auto-Anwendung.
   - Spalten: Keyword · vorgeschlagenes Primary · vorgeschlagene Secondaries · Konfidenz · Begründung (aufklappbar).
   - Konflikte hervorheben (rotes Icon): „Keyword `X` würde `Produkt Y` als Primary bekommen, aber `Produkt Y` hat bereits `Keyword Z` als Primary — behalte Z oder ersetze durch X?"
   - Merchant kann pro Zeile: akzeptieren (default für confidence ≥ 0.6), verschieben (anderes Item wählen), ablehnen, oder als Secondary abstufen.
   - „Alle akzeptieren"-Button (mit Confirm).

5. **Batch-Anwenden** (zweite Task-Phase oder derselbe Task mit `stage:'apply'`).
   - Iteriert die akzeptierten Vorschläge; pro Zeile: upsert Assignment mit Rolle. Bei Primary-Konflikten die vorher gewählte Konflikt-Regel anwenden.
   - Fortschritt pro 10 Items via `Task.progress` (Heartbeat-Pflicht — siehe [SEO_SECTION_CONTRACT.md](../architecture/SEO_SECTION_CONTRACT.md) §8).

**Task-Typ registrieren** in `LONG_RUNNING_TASK_TYPES` ([task-recovery.service.js:34](task-recovery.service.js#L34)): `distributeKeywords`. i18n-Label in `t.tasks.taskType.distributeKeywords`. Fortschritt = `processed / totalBatches` während §5.4-Schritt 2, dann `applied / accepted` während Schritt 5.

**Randfälle:**
- **Nur ein Batch nötig** (Store hat ≤ `ITEMS_PER_BATCH` Produkte) → Merge-Schritt entfällt, direkt in die Preview. Für einen typischen kleinen Shop bleibt es damit tatsächlich bei **einem** LLM-Call, wie du es beschrieben hast.
- **Sehr großer Store** (>1000 Produkte in Zielmenge): das Modal warnt vorher („Diese Verteilung wird ~67 LLM-Calls auslösen, geschätzt ~1,20 €. Fortfahren?"). Cost-Preview kommt aus einer trivialen Vorab-Rechnung, nicht aus einem Test-Call.
- **Kein passendes Item für ein Keyword** → `primaryItemId=null` aus dem LLM → Zeile in der Preview als „keine Zuweisung" markiert, Merchant kann das Keyword manuell zuweisen oder ignorieren.

**Optionaler Fallback (Phase 6, nicht jetzt bauen):** Wenn Merchants mit sehr großen Katalogen (5000+ Produkte) systematisch klagen, kann eine **optionale** Embedding-Vorstufe pro Keyword die Zielmenge auf Top-50 Produkte reduzieren und die Batch-Anzahl senken. Erst dann bauen, wenn der Bedarf empirisch da ist — nicht spekulativ.

### 5.5 Kosten-/Rate-Realismus

- Ein durchschnittlicher Store mit 200 Produkten und 100 Keywords: 200/15 ≈ 14 Batches × ~6k Input-Tokens + ~1.5k Output-Tokens ≈ 100k Input + 20k Output. Bei Claude Sonnet Pricing ($3/MTok in, $15/MTok out) ≈ **60 ¢ pro Verteilung**.
- Ein Store mit 50 Produkten: 4 Batches ≈ 20 ¢. Ein Store mit 15 Produkten: 1 Batch ≈ 5 ¢.
- **Pro-gaten** trotzdem (dieselben `meetsPlan(plan, "pro")`-Gates wie bei GSC), sonst wird der Feature-Wert entwertet und die Kosten-Zurechnung wird schwierig.
- Absicherung gegen Missbrauch: `distributeKeywords` max **1 laufender Task pro Shop** (dieselbe Single-flight-Regel wie andere Bulk-Tasks — siehe [SEO_SECTION_CONTRACT.md](../architecture/SEO_SECTION_CONTRACT.md) §8). Zweiter Aufruf zeigt Banner mit Link zum Aufgaben-Tab.
- Cost-Preview im Modal (siehe Randfälle oben) verhindert Überraschungen bei großen Katalogen.

### 5.6 Deliverables Phase 3

- Group-CRUD-UI + Aktionen
- Priorität-Spalte + Prompt-Sortierung
- CSV-Importer (klein → sync, groß → Task)
- LLM-Verteiler (`app/services/seo/keyword-distribution.service.ts`) — Batch-Splitting, Prompt-Bau, JSON-Parsing, Cross-Batch-Merge
- Cost-Preview-Utility (rein rechnerisch, kein Netz-Call)
- Task-Runner `runDistributeKeywords` + Recovery-Registrierung
- Preview-UI + Bulk-Apply-UI
- i18n (viele neue Strings — vor allem Preview-Tabelle + Konflikt-Meldungen + Cost-Preview)
- Pro-Gate

---

## 6. Phase 4 — Kostenlose Keyword-Recherche (Autocomplete)

**Ziel:** Ein Recherche-Panel im Keywords-Tab, das aus einem Seed-Keyword Vorschläge liefert — ohne bezahlte API.

### 6.1 Datenquelle

- **Google Autocomplete-Endpoint:** `https://suggestqueries.google.com/complete/search?client=firefox&hl=<locale>&gl=<country>&q=<seed>`
- Antwort ist JSON `[query, [suggestions...]]` — pro Aufruf ~10 Vorschläge.
- Erweiterungs-Muster (aus etablierter SEO-Praxis):
  - `<seed> a`, `<seed> b`, … `<seed> z` → 26 Calls → 100–200 Long-Tail-Vorschläge.
  - `<question-word> <seed>` (wie/was/wo/…) → Fragen-Vorschläge (gut für Blog-Ideen).
- Rate: Google droßelt bei > ~5 QPS. Serverseitig sequentiell mit ~200 ms delay + `p-limit` (bereits im repo verwendet?). Pro Seed 30 Sekunden Laufzeit → **synchron akzeptabel**, kein Task nötig.

### 6.2 UI

- Recherche-Panel oben im Keywords-Tab (neuer Card): Seed-Input + Locale/Country-Select (default aus Shop-Locales) + „Vorschläge holen"-Button.
- Ergebnis: gruppierte Liste („Direkte Vorschläge", „Alphabet-Erweiterungen", „Fragen"). Jeder Vorschlag hat Checkbox + „In Gruppe importieren"-Aktion (öffnet Gruppen-Picker).
- Anti-Missbrauch: max 3 Seeds pro Minute pro Shop (in-memory Rate-Limiter reicht — bei Bedarf DB-basierten Bucket wie `ImageOperationCounter`).

### 6.3 Rechtliches

Google's Autocomplete-Endpoint hat keine offizielle API und keine dokumentierten Nutzungsbedingungen für automatisierte Abfrage. Praxis: gängig im SEO-Bereich, geringe Volumina unproblematisch. Trotzdem:
- Nur bei _expliziter_ Merchant-Aktion (kein automatischer Prefetch).
- User-Agent klar setzen (`ContentPilot-SEO/1.0`).
- Bei 429/403 → freundliche Fehlermeldung, keine Retry-Bombe.
- **Escape-Hatch dokumentieren:** wenn Google jemals abschaltet, ist Phase 4 alleinstehend abschaltbar — kein anderer Teil der App hängt davon ab.

### 6.4 Deliverables Phase 4

- `keyword-suggestions.service.ts` (Autocomplete-Fetcher + Alphabet-Erweiterung + Question-Modifier)
- Rate-Limiter
- Recherche-Panel-UI
- „In Gruppe importieren"-Modal (nutzt Group-CRUD aus Phase 3)
- i18n

---

## 7. Phase 5 — Kannibalisierung + Search-Intent

Beides sind **Qualitäts-Features** obendrauf, sinnvoll erst wenn Phasen 1–3 stehen.

### 7.1 Kannibalisierung

Nach der Umstellung auf Assignments ist die Erkennung trivial:

```sql
SELECT keywordId, resourceType, COUNT(*) c
FROM SeoKeywordAssignment
WHERE shop=? AND role='primary'
GROUP BY keywordId, resourceType HAVING c > 1;
```

- Neue Karte im Keywords-Tab: _„Konflikte"_ mit einer Liste dieser Duplikate.
- Findings-Codes im SEO-Dashboard (siehe [SEO_SECTION_CONTRACT.md](../architecture/SEO_SECTION_CONTRACT.md) §2) — kannibalisierte Keywords fließen in den Store-weiten Score ein.
- Zusätzlich Warnung im Assignment-Writer, wenn der Merchant _manuell_ ein Primary anlegt, das schon woanders primary ist (Confirm-Dialog).

**Achtung `Product` ≠ `Collection`:** Ein Keyword darf durchaus einmal als Primary auf einem Produkt und einmal auf einer Kategorie-Collection existieren (Kategorie-Seite rankt für „Vasen", Produkt für „grüne Keramikvase") — das ist _kein_ Konflikt. Deshalb `GROUP BY keywordId, resourceType`, nicht nur `keywordId`.

### 7.2 Search-Intent

- Neues Feld `intent` auf `SeoKeyword` (§2 bereits enthalten).
- Batch-Klassifikator: nach Import oder auf Merchant-Anfrage („Alle nicht-klassifizierten klassifizieren") — 50 Keywords pro LLM-Call, Response strukturiert JSON.
- UI: farbliches Badge in der Tabelle + Filter.
- **Wirkung auf AI-Generierung**: Der Prompt bekommt Kontext („Zielintention dieses Keywords: transactional — betone Kauf, Vorteil, Verfügbarkeit"). Kleine, aber messbare Qualitätsverbesserung besonders bei Meta-Descriptions.
- **Wirkung auf Distribution-Vorschläge**: Blog-Artikel bekommen bevorzugt `informational`-Keywords, Produkte `transactional`/`commercial` — als Regel im LLM-Verteiler-Prompt.

### 7.3 Deliverables Phase 5

- Kannibalisierungs-Query + Konflikt-Karte + Confirm-Guard im Writer
- Findings-Integration (nur wenn Dashboard-Score sie zulässt — Code-Konvention wie in `t.seo.findings.*`)
- Intent-Klassifikator (`keyword-intent.service.ts`) + Batch-Aktion
- Intent-Badge + Filter
- Prompt-Erweiterung (Handler)

---

## 8. Reihenfolge, Aufwand, Abhängigkeiten

| Phase | Aufwand (grob) | Abhängigkeit                    | Freigeschaltet für |
|-------|----------------|----------------------------------|--------------------|
| 1     | 1–1.5 Wochen   | §2 Migration                     | alle Pläne         |
| 2     | 3–5 Tage       | Phase 1 (Assignment-Model)       | Pro (wie GSC)      |
| 3     | 2–2.5 Wochen   | Phase 1                          | Pro                |
| 4     | 3–5 Tage       | Phase 3 (Gruppen für Import)     | alle Pläne         |
| 5     | 4–6 Tage       | Phase 1 (Assignments); optional Phase 3 (Intent-Wirkung im Verteiler) | alle Pläne (Warnung), Pro (Intent-Batch) |

**Kritischer Pfad:** §2 → Phase 1 → alles andere parallelisierbar. Phase 3 (AI-Verteilung) ist der aufwendigste, aber demo-stärkste Punkt.

---

## 9. Tests (Pflicht pro Phase)

- **Unit** (Vitest, wie in [keywords.service.ts](app/services/seo/keywords.service.ts) getestet):
  - Migration: alte SeoKeyword → neuer Keyword+Assignment, inkl. Duplikat-Zusammenführung.
  - `analyzeMultiKeyword`: Cross-Keyword-Density.
  - CSV-Parser: Encoding, Header-Varianten (Reuse [redirects-csv.ts](app/services/seo/redirects-csv.ts) Test-Fixtures).
  - URL→Item-Resolver (Query-Params, Trailing-Slash, Locale-Prefix).
  - Autocomplete-Fetcher: Rate-Limit, 429-Handling, malformed JSON.
  - Embedding-Cache: Invalidierung bei contentHash-Änderung.
- **Integration:**
  - Distribution end-to-end mit gemocktem LLM-Provider (deterministische Zuweisungen prüfen).
  - Assignment-Writer: Primary-Konflikt löst Rolle-Swap aus, nicht Duplikat.
- **GDPR-Guard:** Bestehender Drift-Test muss alle 4 neuen Modelle akzeptieren (das ist automatisch — sobald sie in `SHOP_SCOPED_MODELS` sind).

---

## 10. Nicht-Ziele (explizit)

Damit der Scope nicht wächst:

- **Kein bezahltes Keyword-Volumen** in Phase 1–5. Wenn Bedarf da ist, kommt das als Phase 6 mit DataForSEO — separate Entscheidung.
- **Keine Rank-Tracking-Historie** außerhalb GSC. GSC liefert die letzten 16 Monate — das ist Datenquelle genug.
- **Kein Ahrefs-Klon.** Wer Backlink-Analyse braucht, nutzt Ahrefs — ContentPilot ist ein Content-Werkzeug, kein SEO-Suite-Ersatz.
- **Keine Auto-Anwendung** der AI-Verteilung. Preview + Merchant-Bestätigung ist Pflicht, um Vertrauen aufzubauen (und Support-Aufwand niedrig zu halten).
- **Keine Keyword-Clustering-Visualisierung** (Bubble-Charts, Graphen). Falls später gewünscht → eigenes Ticket.
- **Keine Embedding-Vorstufe in Phase 3.** Der batchweise LLM-Ansatz reicht für 99 % der Merchant-Stores. Embeddings bleiben als Phase-6-Option offen (§5.4 „Optionaler Fallback"), werden aber nur gebaut, wenn empirischer Bedarf entsteht.

---

## 11. Offene Fragen (für vor der Umsetzung)

1. **Group vs. Tag** — reicht ein `SeoKeywordGroup` oder soll ein Keyword _viele_ Gruppen tragen können (der Plan modelliert das schon per M:N — Bedarf noch bestätigen)?
2. **Locale bei Gruppen** — sollen Gruppen locale-scoped sein („Vasen DE" vs „Vases FR")? Empfehlung: **nein**, weil Keywords innerhalb der Gruppe schon ihre eigene Locale haben — Gruppe ist locale-agnostischer Container.
3. **Verteilungs-Batch-Größe (`ITEMS_PER_BATCH`)** — Startwert 15 basiert auf grober Kontext-Rechnung (§5.4). Bei ersten echten Läufen kalibrieren: bricht die JSON-Antwort ab? Wird die Zuweisungs-Qualität schlechter bei größeren Batches (weil das Modell die Übersicht verliert)? Feature-Flag oder Env-Var pro Deployment einbauen, damit ohne Redeploy justiert werden kann.
4. **Provider-Wahl für die Verteilung** — Claude Sonnet ist wegen JSON-Zuverlässigkeit ein guter Default. Gemini 2.x wäre billiger, hat aber historisch mehr Slop bei strukturiertem Output. Vorschlag: Sonnet als default, im `AISettings.aiProvider` überschreibbar (Merchant weiß dann selbst, was er tut).
5. **Sidebar-UI** — passt eine Chip-Liste in die aktuelle Sidebar-Breite, oder braucht es ein Modal? Zu prüfen bei Umsetzungsstart, nicht jetzt.
