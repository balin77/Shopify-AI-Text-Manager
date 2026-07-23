# Keywords-Section — UI-Überarbeitung (Phasen 0–6)

**Status:** Entwurf, Umsetzung nicht begonnen (2026-07-22).
**Baut auf:** der ausgelieferten Keywords-Section ([app.seo.keywords.tsx](../../app/routes/app.seo.keywords.tsx), [keywords.service.ts](../../app/services/seo/keywords.service.ts), [keyword-distribution.service.ts](../../app/services/seo/keyword-distribution.service.ts), [keyword-suggestions.service.ts](../../app/services/seo/keyword-suggestions.service.ts)).
**Section-Contract:** [SEO_SECTION_CONTRACT.md](../architecture/SEO_SECTION_CONTRACT.md) — dieser Plan führt **keine** neue Section ein. Descriptor und `analyze()`/Findings bleiben unverändert; Service-Contract, Route-Shell, i18n, GDPR, Telemetrie und Tasks gelten weiter.
**Ziel:** Aus sechs flach gestapelten Cards wird eine zweigeteilte Section — **Bibliothek** (Keywords beschaffen, gruppieren, priorisieren) und **Zuordnungen** (welches Item zielt worauf, wie gut ist es optimiert) — mit **Sprache als oberster Dimension** und einem Item-Picker aus Mini-Navbar + horizontalem Kachel-Slider statt Dropdowns.

---

## 0. Ist-Zustand (verifiziert gegen den Code, 2026-07-22)

### 0.1 Was die Section heute rendert

Eine Route mit **2031 Zeilen** und sechs `<Card>`s untereinander:

| # | Card | Inhalt |
|---|---|---|
| 1 | Kannibalisierungs-Konflikte | Banner-Liste aus `findCannibalizationConflicts` |
| 2 | Keyword hinzufügen | Typ-`Select` + Item-`Autocomplete` + Keyword + Sprache-`Select` + Rolle-`Select` |
| 3 | Verfolgte Keywords | `IndexTable`, **10 Spalten**, eine Zeile pro Assignment |
| 4 | Keyword-Gruppen | Textfeld „Neue Gruppe" + Button-Wolke aller Gruppen |
| 5 | Keyword-Recherche | Seed + Sprache → Google-Autocomplete-Vorschläge, Import in Gruppe |
| 6 | Gruppendetail | nur bei `?group=<id>`, **ganz unten**: Keyword-Tabelle, Bulk-Priorität, Einzel-Add, CSV-Textarea, AI-Verteilung + Vorschau |

**Warum das unübersichtlich ist:** Keywords entstehen an **vier** Orten (Card 2, Card 6 Einzel-Add, Card 6 CSV, Card 5 Import). Card 3 und Card 6 zeigen dasselbe Objekt aus zwei Blickwinkeln. Das Gruppendetail steht unterhalb der Recherche, obwohl die Recherche in die Gruppe hineinschreibt. Die Sprache ist ein Feld an *jedem* Formular statt ein globaler Zustand.

### 0.2 Datenmodell heute ([schema.prisma:1003-1120](../../prisma/schema.prisma#L1003))

```
SeoKeyword            @@unique([shop, keyword, locale])   locale, priority, intent
SeoKeywordAssignment  @@unique([shop, keywordId, resourceId])
                      resourceType, resourceId, role, gscPosition/Clicks/Impressions/Ctr
SeoKeywordGroup       @@unique([shop, name])              ← KEIN locale
SeoKeywordGroupMembership  @@unique([groupId, keywordId])
SeoKeywordSnapshot    @@unique([assignmentId, capturedAt])
```

### 0.3 Harte Grenzen, die erhalten bleiben müssen

1. **`MAX_KEYWORDS_PER_ITEM = 5`** pro (Item, Sprache) — [keywords.service.ts:235](../../app/services/seo/keywords.service.ts#L235), geprüft in `assignKeyword`.
2. **Genau ein `role='primary'`** pro (Item, Sprache) — in der App-Schicht per Check+Swap **innerhalb einer Transaktion** durchgesetzt (Prisma kann es nicht ausdrücken, weil das Locale am Keyword hängt).
3. **`MAX_KEYWORD_LENGTH = 120`**, `normalizeKeyword` = lowercase + single-space.
4. **`PICKER_CAP = 250`** — der Loader lädt heute nur 250 Items **pro Typ** ohne Suchparameter.
5. **AI-Verteilung ist Pro-gegated** (Loader, Route-Action **und** `/api/ai`-Handler).
6. **Die AI-Prompt-Brücke**: `text-generation.handler.ts` filtert Assignments auf `(shop, resourceId)` **ohne** `resourceType` — der Index `@@index([shop, resourceId])` trägt genau diese Query. Nicht wegoptimieren.
7. **Sekundäre Keywords haben keinen Score** (`score: null`) — der 0-100-Wert ist presence-gewichtet für *ein* Zielkeyword.
8. **GDPR:** alle fünf Tabellen sind in `redactShopData` erfasst ([gdpr.service.ts](../../app/services/gdpr.service.ts)); der Schema-Coverage-Guard verlangt eine `shop`-Spalte pro Tabelle.

### 0.4 Bildquellen für den Kachel-Slider

| Typ | Feld im DB-Cache | vorhanden? |
|---|---|---|
| Product | `featuredImageUrl` + `featuredImageAlt` | ✅ |
| Collection | `imageUrl` + `imageAltText` | ✅ |
| Article | `imageUrl` + `imageAltText` | ✅ |
| **Page** | — | ❌ **kein Bildfeld im Modell** |

→ Seiten bekommen eine **reine Textkachel** (Titel, kein Bildbereich, gleiche Kachelbreite). Kein Schema-Change; Shopify-Seiten haben ohnehin kein Feature-Bild.

---

## 1. Entschiedene Punkte

| # | Frage | Entscheidung |
|---|---|---|
| 1 | Gruppe zuordnen | **Variante A (Snapshot)** — expandiert sofort zu N `SeoKeywordAssignment`-Zeilen, kein neues Modell |
| 2 | Pseudo-Gruppen | **Ja** — „Alle" und „Ohne Gruppe" in der linken Liste |
| 3 | Slider-Kacheln | **Bild + gekürzter Titel**; Seiten (kein Bildfeld) als reine Textkachel |
| 4 | Zuordnungen-Tab | **Aufklappbar, item-gruppiert** |
| 5 | Manuelle Verteilung ohne AI | **Ja** — kein Plan-Gate |
| 6 | Sprache | **Oberste Dimension** — Sprachwahl ganz oben, jede Sprache hat ihre **eigenen** Keyword-Gruppen. **Kein** Markt-Konzept |

---

## 2. Zielbild

### 2.1 Tab „Bibliothek"

```
┌ SEO ▸ Keywords ────────────────────────────────────────────────────────┐
│  Sprache:  [ Deutsch ] [ English ] [ Français ]        ← Locale-Navbar │
│  [ Bibliothek ]   Zuordnungen                          ← SubNavBar     │
├────────────────────────────────────────────────────────────────────────┤
│ 🔍 RECHERCHE                                              [einklappen] │
│    Seed [ vase            ]                       [Vorschläge holen]   │
│    (Sprache folgt der Auswahl oben — kein eigener Selector)            │
│    ┌──────────────────────────────────────────────────────────────┐    │
│    │ Direkt   ☑ vase gross  ☑ vase glas  ☐ vase weiss  ☐ …        │    │
│    │ Fragen   ☐ welche vase für tulpen  ☐ …                        │    │
│    │ A–Z      ☐ vase amazon  ☐ vase bauhaus  ☐ …                   │    │
│    │ 12 gewählt → [In „Vasen 2026" übernehmen] [In neue Gruppe …]  │    │
│    │              [Direkt zuordnen …]                              │    │
│    └──────────────────────────────────────────────────────────────┘    │
├──────────────────┬─────────────────────────────────────────────────────┤
│  GRUPPEN (DE)    │  Vasen 2026                          ✏ umbenennen 🗑│
│                  │  ─────────────────────────────────────────────────  │
│  ▸ Alle    (312) │  ┌ Keywords einfügen ──────────────────────────┐    │
│  ▸ Ohne Gr.  (8) │  │ vase gross                                  │    │
│  ─────────────── │  │ vase glas klar                              │    │ 1 Zeile = 1 KW
│  • Vasen    (42) │  │ keramikvase handgemacht,1,commercial        │    │ optionale Spalten
│  • Töpfe    (17) │  │                                             │    │ prio,intent
│  • Deko     (61) │  └─────────────────────────────────────────────┘    │
│  • Winter   (23) │   Priorität [2 ▾]              [312 einfügen]       │
│                  │                                                     │
│  [ + Gruppe ]    │  [⚡ Ganze Gruppe verteilen]   [Prio für alle ▾]    │
│                  │                                                     │
│                  │  ☐  Keyword                Prio  Intent  Zugeordnet │
│                  │  ☑  vase gross              1    comm.   3 Items  ⋯ │
│                  │  ☑  vase glas klar          2     –       –       ⋯ │
│                  │  ────────────────────────────────────────────────   │
│                  │  2 gewählt: [Zuordnen…] [Verschieben nach ▾] [🗑]   │
└──────────────────┴─────────────────────────────────────────────────────┘
```

### 2.2 Zuordnen-Panel (`<ItemPicker>` — ersetzt alle Item-Dropdowns)

Wird an **drei** Stellen aufgerufen: „Ganze Gruppe verteilen", „Auswahl zuordnen", „Recherche direkt zuordnen".

```
┌ Zuordnen — 12 Keywords aus „Vasen 2026" (DE) ──────────────────────────┐
│   Produkte  │  Collections  │  Seiten  │  Blogartikel   ← Mini-Navbar  │
│  ──────────────────────────────────────────────────────────────────────│
│   Filter [ vase________ ]   Produkttyp [ Alle ▾ ]        23 von 412     │
│                                                                         │
│  ◀ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ▶            │
│    │  IMG   │ │  IMG   │ │  IMG   │ │  IMG   │ │        │              │
│    │Vase Ar…│ │Vase Bl…│ │Vase Cl…│ │Vase De…│ │Versand │  ← Seiten:   │
│    │   ✓    │ │        │ │   ✓    │ │        │ │  & Ret…│    nur Text  │
│    └────────┘ └────────┘ └────────┘ └────────┘ └────────┘              │
│   Gewählt: Vase Arles, Vase Clara         [alle sichtbaren wählen]      │
│  ──────────────────────────────────────────────────────────────────────│
│   Verteilmodus                                                          │
│     (•) 🤖 AI verteilt sinnvoll — je Item 1 Primär + max [3 ▾] Sekundär │
│     ( ) ⬛ Alle Keywords auf jedes gewählte Item                        │
│   Rolle (nur manuell): ( ) Primär   (•) Sekundär                        │
│   ☐ Bestehende Primär-Keywords ersetzen (zu Sekundär abstufen)          │
│                                                                         │
│   ⚠ 12 Keywords × 2 Items — Limit ist 5 pro Item. 14 würden abgewiesen. │
│   ⓘ ~4 AI-Calls, ca. $0.06        [Abbrechen]  [Verteilen ⚡]           │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Tab „Zuordnungen"

```
┌  Sprache: [ Deutsch ] …                                                 │
│  Bibliothek │ [ Zuordnungen ] ─────────────────────────────────────────┐
│ ⚠ 2 Konflikte — „vase glas" ist Primär auf 3 Produkten     [anzeigen]  │
│  Produkte │ Collections │ Seiten │ Blogartikel                          │
│  Filter [____]   Intent [alle ▾]   Score [< 50 ▾]                       │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ ▾ Vase Arles · Produkt                Score 82 ▓▓▓▓▓▓▓░  GSC ⌀ 12.4 │ │
│ │      ★ vase glas gross    T H1 M SEO B   1.8%   12.4   ⋯            │ │
│ │        vase deko          T ·  M ·   B   0.9%   24.1   ⋯            │ │
│ │        [+ Keyword]                                                  │ │
│ │ ▸ Vase Blanca · Produkt               Score 41 ▓▓▓░░░░░  GSC –      │ │
│ │ ▸ Winterdeko · Collection             Score 67 ▓▓▓▓▓░░░  GSC ⌀ 8.2  │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

**Was „Zuordnungen" beantwortet** (heute „Verfolgte Keywords" — der Name führte in die Irre): welches Item zielt auf welches Keyword, steht das Keyword überhaupt im Text (Presence T·H1·Meta·SEO·Body + Dichte + Score), wie rankt es real (GSC), und welche Keywords kannibalisieren sich. Zusätzlich ist es die **Datenquelle der AI-Textgenerierung** — die Assignments landen im Generierungs-Prompt.

---

## 3. Datenmodell-Änderungen

### 3.1 Sprache als Gruppen-Dimension (Punkt 6) — **einzige Migration**

```prisma
model SeoKeywordGroup {
  id          String  @id @default(cuid())
  shop        String
  name        String
  locale      String  @default("")   // NEU — "" = Primärsprache (SeoKeyword-Konvention)
  description String?
  ...
  @@unique([shop, name, locale])     // war: @@unique([shop, name])
  @@index([shop, locale])            // NEU — trägt listGroups(shop, locale)
}
```

Migration `2026xxxx_seo_keyword_group_locale`:
1. `ALTER TABLE "SeoKeywordGroup" ADD COLUMN "locale" TEXT NOT NULL DEFAULT '';`
2. alten Unique-Index droppen, neuen auf `(shop, name, locale)` anlegen, Index auf `(shop, locale)`.

Bestandsdaten sind unkritisch: alle heutigen Gruppen bekommen `locale = ""` (Primärsprache), was ihrem tatsächlichen Gebrauch entspricht.

**Neue Invariante:** `membership.keyword.locale === group.locale`. Durchgesetzt in `addKeywordsToGroup` — das Locale kommt ab sofort **aus der Gruppe**, nicht mehr aus der CSV-Zeile oder dem Formular. Ein Keyword kann weiterhin in mehreren Gruppen sein, aber nur in Gruppen **derselben** Sprache.

**Folgen:**
- Die CSV-Spalte `locale` wird **ignoriert** (nicht Fehler) — die Zeile wird importiert, und der Import-Report meldet „Spalte `locale` ignoriert, Sprache ergibt sich aus der Gruppe". `parseKeywordsCsv` bleibt abwärtskompatibel.
- Der Sprach-`Select` in der Recherche entfällt; `hl` folgt der globalen Auswahl.
- Der Sprach-`Select` im Add-Formular und im Gruppen-Add entfällt.
- `SeoKeyword.locale` bleibt **unverändert** — es ist Teil des Unique-Keys und trägt Assignments, GSC-Enrichment und die Kannibalisierungs-Analyse.

### 3.2 Gruppe löschen löscht die Keywords mit (Punkt 2, entschieden)

`deleteGroup` löscht heute nur die Keywords mit, die nach dem Löschen **weder** Assignments **noch** eine andere Gruppe haben ([keywords.service.ts:693](../../app/services/seo/keywords.service.ts#L693)).

**Neu:** Die Gruppe ist der Besitzer ihrer Keywords — `deleteGroup` löscht **alle** Mitglieder-Keywords, unabhängig von Assignments. Deren `SeoKeywordAssignment`- und `SeoKeywordSnapshot`-Zeilen kaskadieren weg (`onDelete: Cascade` ist bereits gesetzt). Ein Keyword, das in **einer weiteren** Gruppe liegt, überlebt — sonst würde das Löschen von Gruppe A stillschweigend Gruppe B ausräumen.

Der Lösch-Dialog nennt die Folgen explizit:

> „Vasen 2026" und **42 Keywords** löschen. **17 Zuordnungen** zu Produkten und Collections gehen dabei verloren, inklusive ihrer Ranking-Historie. 3 Keywords bleiben erhalten, weil sie auch in anderen Gruppen liegen.

**„Ohne Gruppe"** enthält damit nur noch Keywords, die nie in einer Gruppe waren — typischerweise über `+ Keyword` direkt am Item im Zuordnungen-Tab angelegt.

### 3.3 Kein neues Modell

Variante A (Punkt 1) braucht **keine** Tabelle: „Gruppe verteilen" expandiert zu N `SeoKeywordAssignment`-Zeilen. Score, GSC-Enrichment, Kannibalisierungs-Check und die AI-Prompt-Brücke funktionieren unverändert weiter. Preis: eine spätere Gruppen-Erweiterung wirkt nicht rückwirkend → dafür der Button **„Gruppe erneut verteilen"**, der nur die noch nicht zugeordneten Keywords anbietet.

Da keine neue Tabelle entsteht, ist **keine GDPR-Anpassung** nötig — `redactShopData` deckt alle fünf Tabellen bereits ab.

---

## 4. Neue Serverbausteine

### 4.1 `assignMany` (Route-Action)

Heute gibt es nur `setKeyword` für genau **ein** (Keyword × Item). Neu:

```ts
assignMany({
  keywordIds: string[],
  targets: { resourceType: KeywordResourceType; resourceId: string }[],
  role: "primary" | "secondary",
  demoteExisting: boolean,
}) -> {
  applied: number,
  skipped: { keywordId, resourceId, reason: "limitReached" | "primaryExists" | "duplicate" }[],
}
```

Muss `assignKeyword`s Garantien **pro Paar** einhalten (5er-Limit, Ein-Primär-Regel, Check+Swap in der Transaktion) und statt hart abzubrechen einen **Skip-Report** liefern. Der Client zeigt den Report als Banner.

**Vorab-Prüfung** (eigener leichter Endpoint oder Teil desselben Requests mit `dryRun: true`), damit das Panel *vor* dem Klick sagen kann: „12 Keywords × 2 Items — 14 würden das 5er-Limit reissen."

### 4.2 Item-Picker-Endpoint

`PICKER_CAP = 250` macht Client-Filterung unbrauchbar (Item 300 ist unauffindbar). Neu:

`GET /api/seo/item-picker?type=Product&q=vase&productType=&cursor=&locale=de`

- serverseitige `contains`-Suche auf `title` im DB-Cache, `take: 60`, Cursor-Paging
- liefert `{ id, title, imageUrl | null }`
- bei `locale !== ""`: Titel aus `ContentTranslation` überlagern (die Loader-Bausteine `buildTranslatedContentInput` / `TRANSLATED_CONTENT_KEYS` existieren bereits)
- Debounce 250 ms im Client

Damit fällt der `pickers`-Block aus dem Loader weg — spart bei jedem Seitenaufruf vier `findMany` à 250 Zeilen.

### 4.3 Service-Signaturen mit Locale

```ts
listGroups(db, shop, locale)                       // + locale
createGroup(db, shop, name, locale, description?)  // + locale
addKeywordsToGroup(db, shop, groupId, entries)     // Locale aus der Gruppe, nicht aus entries
countUngrouped(db, shop, locale)                   // NEU — „Ohne Gruppe"-Badge
listUngrouped(db, shop, locale)                    // NEU
```

`renameGroup` prüft Duplikate künftig gegen `(shop, name, locale)`.

---

## 5. Phasen

| Phase | Inhalt | Berührt | Risiko |
|---|---|---|---|
| **0** | Schema + Migration + Service-Signaturen mit `locale`; Invariante in `addKeywordsToGroup`; `deleteGroup` löscht Mitglieder-Keywords (§3.2); `countUngrouped`/`listUngrouped` | `schema.prisma`, neue Migration, `keywords.service.ts`, `keyword-distribution.service.ts` | **mittel** — Migration |
| **1** | Route-Split: `app.seo.keywords.tsx` → Shell + `components/seo/keywords/*`. Locale-Navbar + SubNavBar (Bibliothek/Zuordnungen), URL-State `?loc=&tab=&group=`. **Funktion sonst unverändert** | Route + neue Komponenten | niedrig |
| **2** | Bibliothek: `NavigationList` links inkl. „Alle"/„Ohne Gruppe"; Gruppen-Editor rechts; **eine** Bulk-Paste-Textarea ersetzt CSV-Feld + Einzel-Add; Recherche nach oben, einklappbar, Sprache folgt global | `keywords/LibraryTab.tsx`, `GroupSidebar.tsx`, `KeywordPaste.tsx`, `ResearchPanel.tsx` | niedrig |
| **3** | `<ItemPicker>`: Mini-Navbar + horizontaler Kachel-Slider + Textfilter + Serversuche; Page-Initialen-Fallback | neuer Endpoint `api.seo.item-picker.tsx`, `keywords/ItemPicker.tsx` | mittel |
| **4** | `assignMany` + Dry-Run; Verteil-Panel mit **beiden** Modi (manuell frei, AI Pro-gegated); „Gruppe erneut verteilen" | Route-Action, `keywords.service.ts`, `keywords/AssignPanel.tsx` | mittel |
| **5** | Zuordnungen-Tab: item-gruppiert + aufklappbar, Konflikte als Kopfzeile statt eigene Card, Typ-Navbar + Filter | `keywords/AssignmentsTab.tsx`, Loader-Aggregation | mittel |
| **6** | i18n (`de`/`en`/`es` → `t.seo.keywordsPage`), Tests, Aufräumen toter Strings/Handler | `app/i18n/*.ts`, `*.test.ts` | niedrig |

Phase 0 und 1 sind unabhängig voneinander und können parallel laufen; ab Phase 2 gilt die Reihenfolge.

---

## 6. Was wegfällt

- Typ-`Select` + Item-`Autocomplete` im Add-Formular → `<ItemPicker>`
- Sprach-`Select` an drei Stellen (Add-Formular, Gruppen-Add, Recherche) → eine Locale-Navbar
- Separates „CSV importieren"-Textfeld → dieselbe Bulk-Paste-Textarea
- Separates „Keyword zu Gruppe hinzufügen"-Feld → dieselbe Bulk-Paste-Textarea
- Eigene Konflikt-Card → Kopfzeile im Zuordnungen-Tab
- `pickers` im Loader (vier `findMany` à 250) → Endpoint on demand
- `PICKER_CAP`-Hinweistext („nur die ersten 250 …")

## 7. Was unverändert bleibt

`analyzeOnPage` und die Score-Berechnung · `SeoKeywordAssignment` samt GSC-Enrichment und Snapshots · `findCannibalizationConflicts` · Intent-Klassifikation · die AI-Verteilung selbst (`keyword-distribution.service.ts`, nur der Einstieg wird umgebaut) · die Google-Autocomplete-Recherche · der `SeoSectionLayout`-Shell und das Plan-Gating · `redactShopData`.

---

## 8. Offene Punkte / Risiken

1. **Sprachen-Navbar bei vielen Locales.** Ein Shop mit 12 publizierten Sprachen sprengt eine horizontale Navbar. → Fallback: ab n > 6 ein `Select` statt Navbar, oder horizontal scrollbar wie `SubNavBar` es ohnehin schon kann.
2. **Bestandsdaten-Sprachen — geklärt.** Heutige Keywords mit `locale = "fr"` können in einer Gruppe liegen, die nach der Migration `locale = ""` hat, und verletzen dann die Invariante. Da die App noch in Entwicklung ist und Keyword-Verlust akzeptiert wird: die Migration **löscht** solche Memberships ersatzlos (`DELETE FROM "SeoKeywordGroupMembership" m USING "SeoKeyword" k WHERE m."keywordId" = k.id AND k.locale <> ''`). Kein Gruppen-Klonen, keine Rückfrage. Vor Produktivstart ist das erledigt.
3. **AI-Verteilung und Locale.** `keyword-distribution.service.ts` hängt das Locale heute als Attribut an jedes Keyword im Prompt ([Zeile 97](../../app/services/seo/keyword-distribution.service.ts#L97)). Mit locale-reinen Gruppen ist das redundant, und der Prompt sollte stattdessen die **übersetzten** Item-Titel/Beschreibungen dieser Sprache sehen. Sonst matcht die AI deutsche Keywords gegen englische Produkttexte.
4. **Bestätigungsdialoge bei Bulk-Zuordnung.** Heute kann *ein* `setKeyword` zwei Rückfragen auslösen ([app.seo.keywords.tsx:700-745](../../app/routes/app.seo.keywords.tsx#L700)):
   - `primaryExists` — „Das Item hat schon ein Primär-Keyword. Abstufen und dieses zum neuen Primär machen?"
   - `cannibalization` — „Das Keyword ist bereits Primär bei »Vase Arles«. Zwei Items auf dasselbe Keyword konkurrieren bei Google gegeneinander. Trotzdem?"

   Der Client zeigt den Dialog, holt ein OK und schickt dieselbe Anfrage nochmal mit `demoteExisting` bzw. `acceptCannibalization`. Für ein Keyword ist das gut; bei 12 Keywords × 5 Items als Primär wären es bis zu **60 Dialoge hintereinander**. Der neue Bulk-Pfad muss deshalb *vor* dem Schreiben alle Kollisionen einsammeln (Dry-Run) und **einen** Dialog zeigen: „3 der 12 Keywords sind schon anderswo Primär: … [Trotzdem zuordnen] [Diese überspringen]". Der Einzel-Pfad im Zuordnungen-Tab behält seine heutigen Dialoge.
5. **Slider-Performance.** Bei `take: 60` pro Seite und Bild-Thumbnails: `loading="lazy"` und feste Kachelmasse (kein Layout-Shift). Bildgrössen aus dem Cache sind ungetrimmte Shopify-CDN-URLs → `?width=120` anhängen.
6. **`?group=`-Deeplinks** aus bestehenden Bookmarks müssen weiter funktionieren; die Gruppe bestimmt dann implizit die aktive Sprache.
7. **Mobile.** Zweispaltiges Bibliothek-Layout braucht unter ~768 px einen Kollaps (Gruppenliste als `Select` oder Drawer). `SubNavBar` trägt bereits `desktop-only`.

---

## 9. Umsetzungs-Status & offene Review-Punkte (2026-07-23)

Phasen 0–6 sind ausgeliefert und committet (typecheck 0, volle Test-Suite grün, Build ok). Ein unabhängiger Review-Agent hat den Gesamt-Diff geprüft: **keine Blocker, keine Major-Defekte**; die risikobehaftete Logik (`assignMany`/`planItemAssignments`, Mandanten-Scoping, Migration, Sentinel-/Pseudo-Gruppen-Routing, Client-Safety) wurde als korrekt bestätigt.

Direkt behoben nach dem Review:
- **Shared-Fetcher-Race** im `AssignPanel`: ein noch anstehender Dry-Run konnte einen echten Apply auf demselben Fetcher überschreiben → Timer wird beim echten Apply gecancelt.
- **`createGroup` validiert das Locale** jetzt gegen die publizierten Shop-Sprachen (wie `setKeyword`/`importCsv`), damit keine Gruppe unter einer nicht-publizierten (unsichtbaren) Sprache entsteht.

Bewusst als Follow-up zurückgestellt (kein Merge-Blocker):
- **§8.3 KI-Verteilung nutzt Primärsprach-Text.** `loadTargetItems` liest Basis-Titel/Beschreibung; für locale-reine Sekundär-Gruppen sollten die **übersetzten** Item-Texte (`buildTranslatedContentInput`/`TRANSLATED_CONTENT_KEYS`) in den Prompt. Zuweisungen landen bereits in der richtigen Sprache — nur die KI-Vorschlagsqualität betrifft es.
- **Bulk-Sekundär-Zuweisung** kann ein bestehendes Primär still zu Sekundär abstufen (mirror der Einzel-`assignKeyword`-Semantik); der Dry-Run sollte eine `demoted`-Zahl ausweisen, damit das Panel warnt.
- **Nits:** `ItemPicker`-„Gewählt"-Zusammenfassung zählt nur geladene Items (kosmetisch); AI-Modus verarbeitet nur den gewählten Ziel-Typ einer typ-gemischten Auswahl (Manual verarbeitet alle).
