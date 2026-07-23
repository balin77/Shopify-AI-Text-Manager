# Bulk-Editor-Ausbau — Plan (Phasen 1–6)

**Status:** Entwurf, Umsetzung nicht begonnen (2026-07-22).
**Baut auf:** dem ausgelieferten Bulk-Meta-Editor ([app.seo.bulk-meta.tsx](../../app/routes/app.seo.bulk-meta.tsx), [bulk-meta.service.ts](../../app/services/seo/bulk-meta.service.ts), [bulk-meta.shared.ts](../../app/services/seo/bulk-meta.shared.ts), Task `seoBulkMeta` in [seo-bulk-meta.handler.ts](../../app/routes/api-ai-handlers/seo-bulk-meta.handler.ts)).
**Section-Contract:** [SEO_SECTION_CONTRACT.md](../architecture/SEO_SECTION_CONTRACT.md) — dieser Plan führt **keine** neue Section ein, sondern baut eine bestehende aus. Punkt 1 (Descriptor) und Punkt 2 (`analyze()`/Findings) entfallen; Punkte 3–8 (Service-Contract, Route-Shell, i18n, GDPR, Telemetrie, Tasks) gelten unverändert.
**Ziel:** Aus dem „Meta-Editor für 4 Typen × 9 Feldern" wird **der** tabellarische Editor für alles, was ContentPilot kennt — inklusive Produkt-Metafeldern, Optionen, Varianten samt **Preis**, Alt-Texten, weiteren Ressourcentypen und der **Fremdsprachen-Dimension**.

---

## 0. Ist-Zustand (verifiziert gegen den Code, 2026-07-22)

### 0.1 Was der Bulk-Editor heute kann

| | Heute |
|---|---|
| Typen | `product`, `collection`, `article`, `page` ([bulk-meta.shared.ts:34](../../app/services/seo/bulk-meta.shared.ts#L34)) |
| Felder | 9 flach: `title`, `seoTitle`, `seoDescription`, `handle`, `descriptionHtml`, `productType`, `status`, `body`, `summary` ([bulk-meta.shared.ts:23-46](../../app/services/seo/bulk-meta.shared.ts#L23-L46)), per-Typ-Allowlist in `BULK_META_FIELDS_BY_TYPE` |
| Read-only-Spalten | `image` (Thumbnail + „Im Editor öffnen"-Overlay), `blogTitle` |
| Sprache | **ausschließlich Primärsprache** — kein Locale-/Markt-Selektor, `ContentTranslation` wird nie geschrieben |
| Laden | `loadBulkMetaPage` liest **nur den DB-Cache**, `select`-minimiert, `orderBy: {title:'asc'}`, Offset-Paging à 100 ([bulk-meta.service.ts:41](../../app/services/seo/bulk-meta.service.ts#L41)) |
| Filtern/Suchen | **nichts** — Loader kennt nur `type` + `page` ([app.seo.bulk-meta.tsx:102-106](../../app/routes/app.seo.bulk-meta.tsx#L102-L106)) |
| Speichern | Diff-only (`computeDiff` → `groupDiffByRow` → eine Mutation pro Zeile), ≤ `MAX_SYNC_SAVE` (25) synchron, darüber Task `seoBulkMeta` (Cap 500 Zeilen) |
| Spaltenwahl | Modal + `localStorage` pro Typ (`contentpilot:bulkMeta:columns`) |
| Grid | CSS-Grid (kein `<table>`) mit ARIA-Rollen, auto-wachsende Textareas, `overflow-x` ([app.seo.bulk-meta.tsx:604](../../app/routes/app.seo.bulk-meta.tsx#L604)) |
| Plan-Gate | `meetsPlan(plan,'basic')` in Loader, Action **und** Handler |

### 0.2 Bestehende Qualitäten, die erhalten bleiben müssen

Diese Eigenschaften sind teuer erkauft und dürfen beim Ausbau nicht verloren gehen:

1. **Diff-only.** Nur getippte Zellen werden geschrieben; getrimmt verglichen, ein bewusstes Leeren zählt als echte Änderung ([bulk-meta.shared.ts:156](../../app/services/seo/bulk-meta.shared.ts#L156)).
2. **Zeilenweises Gruppieren.** Mehrere geänderte Zellen einer Zeile = **eine** Shopify-Mutation.
3. **Partial-SEO-Clobber-Guard.** Wird nur eine SEO-Hälfte geändert, wird die andere aus dem Cache nachgeladen und mitgesendet ([bulk-meta.service.ts:244-266](../../app/services/seo/bulk-meta.service.ts#L244-L266)) — siehe CLAUDE.md-Gotcha.
4. **Zwei Validierungsstellen.** Client-Diff wird sowohl in der Route-Action als auch im `/api/ai`-Handler gegen GID-Form + Feld-Allowlist geprüft (der Handler ist direkt per POST erreichbar).
5. **Fehlertoleranz pro Zeile.** Eine fehlgeschlagene Zeile bricht den Batch nicht ab; Edits fehlgeschlagener Zeilen bleiben im Formular stehen ([app.seo.bulk-meta.tsx:308-326](../../app/routes/app.seo.bulk-meta.tsx#L308-L326)).
6. **Single-flight pro Shop** für den Task-Pfad ([seo-bulk-meta.handler.ts:77](../../app/routes/api-ai-handlers/seo-bulk-meta.handler.ts#L77)).
7. **Nativer App-Bridge-Save-Bar** statt eigener Buttons (Built-for-Shopify-Anforderung).

### 0.3 Datenlage im Cache — was schon da ist und was fehlt

| Entität | Modell | Für den Editor nutzbar? |
|---|---|---|
| Produkt-Basisfelder | [`Product`](../../prisma/schema.prisma#L369) | ja (alle 7 heutigen Felder) |
| Produkt-Bilder + Alt-Text | [`ProductImage`](../../prisma/schema.prisma#L399) (`altText`, `mediaId`, `altTextModifiedAt`) | ja, aber im Grid nur Thumbnail |
| Produkt-Optionen | [`ProductOption`](../../prisma/schema.prisma#L454) (`name`, `values` JSON) | ja, ungenutzt |
| Produkt-Metafelder | [`ProductMetafield`](../../prisma/schema.prisma#L467) (`namespace`,`key`,`value`,`type`) | ja, ungenutzt — Freischaltung über [`EnabledMetafieldDefinition`](../../prisma/schema.prisma#L149) |
| Varianten | [`ProductVariant`](../../prisma/schema.prisma#L480) (`title`, `sku`, `position`, `galleryJson`) | teilweise — **`price` fehlt komplett** |
| Kollektion / Seite / Artikel | [`Collection`](../../prisma/schema.prisma#L574) / [`Page`](../../prisma/schema.prisma#L618) / [`Article`](../../prisma/schema.prisma#L594) | ja |
| Richtlinien | [`ShopPolicy`](../../prisma/schema.prisma#L638) (`title`, `body`) | ja, ungenutzt |
| Menüs | [`Menu`](../../prisma/schema.prisma#L655) (`items` JSON) | ja, ungenutzt |
| Metaobjekte | [`Metaobject`](../../prisma/schema.prisma#L814) (`fields` JSON) | ja, ungenutzt |
| Blogs (Container) | **kein Modell** — live aus Shopify ([app.blog.tsx:67](../../app/routes/app.blog.tsx#L67)) | nur mit Live-Fetch |
| Übersetzungen | [`ContentTranslation`](../../prisma/schema.prisma#L670) (+`marketId`), [`MetaobjectTranslation`](../../prisma/schema.prisma#L832), [`ProductImageAltTranslation`](../../prisma/schema.prisma#L435) | ja, ungenutzt |
| Vendor, Tags, `publishedAt`, Template-Suffix, Collection-`sortOrder`, Artikel-Autor | **nirgends** | erst nach Schema+Sync-Erweiterung |

### 0.4 Bekannte Inkonsistenz (unabhängig vom Ausbau zu beheben)

Der Editor gated pauschal auf `basic`, bietet aber `article` an — `PLAN_CONFIG.basic.contentTypes` enthält **keine** `articles`/`blogs` ([plans.ts:123](../../app/config/plans.ts#L123)). Ein Basic-Shop sieht damit eine Artikel-Tabelle, obwohl der Artikel-Content für ihn nicht synchronisiert wird (Tabelle bleibt leer bzw. veraltet). **Fix (Phase 1, klein):** die Typ-Liste des Selektors gegen `PLAN_CONFIG[plan].contentTypes` schneiden.

---

## 1. Zielbild und die fünf Grundsatz-Entscheidungen

**Zielsatz:** *Alles, was ContentPilot einzeln bearbeiten kann, ist auch tabellarisch über den ganzen Katalog bearbeitbar — in jeder Sprache, für jeden Markt.*

### 1.1 Der Editor verlässt die SEO-Section und wird ein eigener Hauptnav-Eintrag

**Entscheidung:** neue Route `/app/bulk`, alter Pfad `/app/seo/bulk-meta` bleibt als **Redirect** bestehen; der SEO-Sub-Nav-Eintrag bleibt und zeigt auf die neue Route.

Begründung: Sobald Preise, Metafelder, Varianten und Übersetzungen drin sind, ist das kein SEO-Werkzeug mehr. Ein Merchant, der Preise pflegen will, sucht sie nicht unter „SEO". Der Redirect kostet zehn Zeilen und rettet Lesezeichen, Deep-Links aus dem SEO-Dashboard und die Verweise in [PLAN_SEO_SUITE_COMPLETION.md](./PLAN_SEO_SUITE_COMPLETION.md).

**Konsequenzen:**
- i18n-Namespace wandert von `t.seo.bulkMetaPage.*` nach `t.bulkEditor.*` (einmalige Key-Migration in de/en/es, **de zuerst** — sie definiert den `Translation`-Typ).
- Die Shell `SeoSectionLayout` entfällt; der Plan-Gate-Upsell kommt über die vorhandene [`PlanAccessGate`](../../app/components/PlanAccessGate.tsx), die Navigation über `useAppNavigation()` (Pflicht, sonst gehen `host`/`shop`/`embedded` verloren).
- Task-Typ bleibt `seoBulkMeta` — Umbenennen bräche laufende Tasks und `LONG_RUNNING_TASK_TYPES`. Nur das i18n-Label unter `t.tasks.taskType.*` wird angepasst.

**Verworfene Alternative:** in der SEO-Section bleiben. Spart die Migration, zementiert aber eine falsche Einordnung genau in dem Moment, in dem der Funktionsumfang sie widerlegt.

### 1.2 Spalten werden zu Deskriptoren — die flache Feld-Union trägt nicht mehr

Heute ist eine Spalte ein String aus einer 9-elementigen Union. Metafelder (pro Shop verschieden), Optionen (pro Produkt verschieden), Varianten (Kindzeilen) und Sprachen (zweite Dimension) passen da nicht hinein.

**Entscheidung:** eine Spalte ist ein **Deskriptor-Objekt** mit stabiler `id`, und der Client-Edit-Map-Schlüssel bekommt die Sprach-/Markt-Dimension:

```ts
// bulk-editor.shared.ts (Nachfolger von bulk-meta.shared.ts)
export type ColumnKind = "field" | "metafield" | "option" | "variant" | "image" | "readonly";

export interface ColumnDescriptor {
  /** Stabile, kollisionsfreie Id. Kein ":" — GIDs enthalten selbst welche. */
  id: string;              // "field.title" | "mf.<definitionGid>" | "var.price" | "img.alt"
  kind: ColumnKind;
  /** i18n-Key ODER (bei Metafeldern) der vom Shop vergebene Anzeigename. */
  label: string;
  editable: boolean;
  translatable: boolean;   // steuert, ob die Spalte in Fremdsprache editierbar ist
  inputType: "text" | "textarea" | "select" | "money" | "number" | "boolean";
  minWidth: number;
}
```

**Edit-Map-Key:** `${rowId}|${locale}|${marketId}|${columnId}`.
Trennzeichen ist `|`, **nicht** `:` — der heutige `lastIndexOf(":")`-Trick ([bulk-meta.shared.ts:161](../../app/services/seo/bulk-meta.shared.ts#L161)) existiert nur, weil GIDs Doppelpunkte enthalten; mit vier Segmenten ist er nicht mehr haltbar. `|` kommt in GIDs, Locales und Markt-Ids nicht vor.

**Migrationspflicht:** [tests/unit/seo-bulk-meta.service.test.ts](../../tests/unit/seo-bulk-meta.service.test.ts) testet genau dieses Key-Format (u. a. „splits on the LAST colon"). Der Test wandert mit und wird um die Locale-/Markt-Segmente erweitert — er ist der Regressionsschutz für den gesamten Diff-Pfad.

### 1.3 Sprache ist eine Dimension der Tabelle, kein zweiter Editor

**Entscheidung:** Locale- und Markt-Selektor in der Toolbar; die Tabelle zeigt die Werte der gewählten Sprache. In einer Fremdsprache steht der Primärwert als **Ghost-Platzhalter** in der leeren Zelle, damit sichtbar bleibt, was übersetzt werden soll. Nur `translatable: true`-Spalten sind dort editierbar; alles andere (Status, Preis, Handle-Regeln, Metafeld-Typen ohne Übersetzbarkeit) rendert read-only mit Tooltip.

Begründung: Eine zweite Route „Bulk-Übersetzen" würde Grid, Spaltenwahl, Filter, Diff-Pipeline und CSV-Pfad ein zweites Mal bauen. Die Sprache ist eine Achse der gleichen Matrix — genau wie im Einzel-Editor, wo `LocaleNavigationButtons` dieselbe Feldliste umschaltet.

**Unverhandelbare Invarianten aus [CLAUDE.md](../../CLAUDE.md)** (sonst baut man bekannte Bugs nach):
- Ein Speichern gilt nur als erfolgreich, wenn Shopify die Keys **zurückspiegelt** — `userErrors: []` allein genügt nicht.
- Beim Leeren einer Übersetzung wird die lokale Zeile **nur dann** gelöscht, wenn `translationsRemove` die Entfernung bestätigt.
- Digests sind Pflicht für `translationsRegister`, aber **nicht** für den DB-Spiegel — fehlt ein Digest, wird die Zelle als Fehler gemeldet, nicht still übersprungen.

### 1.4 Varianten sind ein eigener Zeilentyp, keine Produktspalten

**Entscheidung:** neuer Typ `variant` im Typ-Selektor („Produktvarianten"). Eine Zeile = eine Variante; Produkt-Titel und Produktbild stehen als read-only Kontextspalten links.

Begründung: Ein Produkt mit 40 Varianten lässt sich nicht in Spalten falten, und der häufigste Bulk-Wunsch („alle Preise um 5 % erhöhen", „SKUs nachtragen") ist variantenzentriert. Shopifys eigener Bulk-Editor macht es genauso.

**Folge für die Speicher-Pipeline:** Die heutige Regel „eine Zeile = eine Mutation" wird zu **„eine Mutation pro Zielobjekt"**. `productVariantsBulkUpdate` ist produktbezogen, also werden Variantenzeilen desselben Produkts zu **einem** Aufruf zusammengefasst. `groupDiffByRow` bekommt dafür einen Geschwister-Schritt `groupDiffByMutationTarget`.

### 1.5 Was nicht ins Grid kommt

Bewusst ausgeschlossen (Details und Begründung in §11):
- **Lagerbestand** — braucht `read_inventory`/`write_inventory`; ein Scope-Zuwachs erzwingt Re-Consent aller Merchants.
- **Vertriebskanäle/Publishing** — braucht `write_publications`, gleiches Argument.
- **Markt-Preislisten** (`priceList`) — Plus-Feature, eigene Semantik, gehört nicht in dieselbe Zelle wie der Basispreis.
- **Theme-Inhalte** — Key/Value-Struktur mit Theme- **und** Markt-Dimension ([ThemeTranslation](../../prisma/schema.prisma#L759)); der spezialisierte Theme-Editor ist dafür das bessere Werkzeug.
- **Bild-Upload / Reihenfolge** — bleibt im Bild-Manager.

---

## 2. UI-Konzept

```
┌ Bulk-Editor ────────────────────────────────────────────────────────────┐
│ [Typ ▾ Produkte] [Sprache ▾ Deutsch (Primär)] [Markt ▾ Alle]           │
│ [🔍 Suche…] [Filter ▾ (3)] [Spalten wählen] [Export ▾] [Import]         │
│ ─────────────────────────────────────────────────────────────────────── │
│ Bild │ Titel        │ Preis  │ SKU     │ mf: Material │ SEO-Titel  │ ⋯  │
│ [▣]  │ Sommerkleid  │ 49,90  │ SK-001  │ Leinen       │ Sommer…    │ ✎  │
│ [▣]  │ Leinenhemd   │ 39,90  │ LH-002  │ ▒Leinen▒     │ (leer)     │ ✎  │
│ ─────────────────────────────────────────────────────────────────────── │
│ 1-100 von 2.431            [Nur geänderte] [◀ Zurück] [Weiter ▶]        │
└─────────────────────────────────────────────────────────────────────────┘
   ▒grau▒ = Primärwert als Platzhalter (in Fremdsprache noch nicht übersetzt)
```

**Bausteine:**

| Element | Verhalten |
|---|---|
| Typ-Selektor | `product`, `variant`, `collection`, `article`, `page`, `blog`, `policy`, `metaobject` — gefiltert auf `PLAN_CONFIG[plan].contentTypes` (§0.4) |
| Sprach-Selektor | aus `shopLocales` (Primärsprache zuerst, markiert); Wechsel setzt ungespeicherte Edits **nicht** zurück, sondern hält sie pro `locale`-Segment im Key |
| Markt-Selektor | aus `markets` (nur `status === 'ACTIVE'`, siehe CLAUDE.md); „Alle Märkte" = `marketId ""` |
| Suche | serverseitig auf `title` + `handle` (`contains`, `insensitive`) |
| Filter | Mehrfachauswahl: fehlender SEO-Titel / zu lange Meta-Description / fehlender Alt-Text / **fehlende Übersetzung in gewählter Sprache** / Status / Produkttyp / Blog |
| Spaltenwahl | Modal mit **Gruppen** (Basis · SEO · Metafelder · Bilder · Optionen · Varianten); Suchfeld im Modal, weil Shops mit 40 Metafeld-Definitionen sonst unbedienbar sind |
| Sticky-Spalten | Bild + Titel bleiben beim horizontalen Scrollen stehen |
| „Nur geänderte" | Client-Filter auf die Zeilen mit Diff — die Kontrollansicht vor dem Speichern |
| Tastatur | Tab/Shift-Tab zwischen Zellen, Enter = Zeile runter, Esc = Zelle zurücksetzen |
| Einfügen aus Excel | TSV-Block in eine Zelle einfügen füllt das Rechteck ab dieser Zelle (§8) |
| Zellzustände | unverändert · geändert (gelb) · Fehler (rot + Meldung) · read-only (grau + Tooltip) · nicht übersetzt (Ghost) |

**Barrierefreiheit:** Das bestehende ARIA-Grid (`role="table"/"row"/"cell"/"columnheader"`, visually-hidden `<caption>`) bleibt; neu hinzu kommen `aria-sort` auf sortierbaren Kopfzellen, `aria-invalid` + `aria-describedby` auf Fehlerzellen und ein `aria-live`-Bereich für „x Zeilen gespeichert".

---

## 3. Phase 1 — Fundament (Spalten-Deskriptoren, Route, Filter)

**Ziel:** Der Editor kann beliebig viele, beliebig geartete Spalten tragen und wird bei 2.000 Zeilen bedienbar. Noch keine neuen Datenquellen — reiner Umbau plus Filter/Suche/Sortierung. Dieser Umbau ist die Voraussetzung für **jede** folgende Phase; ohne ihn wird jede neue Spaltenart ein Sonderfall im Grid.

### 3.1 Umbenennung und Dateilayout

| Alt | Neu |
|---|---|
| `app/routes/app.seo.bulk-meta.tsx` | `app/routes/app.bulk.tsx` (Shell + Grid) — der alte Pfad bleibt als 302-Redirect-Route bestehen |
| `app/services/seo/bulk-meta.shared.ts` | `app/services/bulk-editor/columns.shared.ts` (Deskriptoren, Diff, Keys) — **client-safe halten**, der Grund steht im Dateikopf: Server-Importe brechen `remix vite:build` |
| `app/services/seo/bulk-meta.service.ts` | `app/services/bulk-editor/load.server.ts` (Zeilen laden) + `app/services/bulk-editor/apply.server.ts` (Diff schreiben) |
| — | `app/components/bulk-editor/` — `BulkGrid.tsx`, `BulkCell.tsx`, `ColumnPickerModal.tsx`, `FilterBar.tsx` (die Route hat heute >900 Zeilen; sie wird sonst unwartbar) |

`app/routes/api-ai-handlers/seo-bulk-meta.handler.ts` und der Task-Typ `seoBulkMeta` bleiben **namensgleich** (§1.1).

### 3.2 Diff-Pipeline mit vier Segmenten

```ts
export interface BulkDiffEntry {
  rowId: string;        // GID der Zeile (Produkt, Variante, Metaobjekt …)
  rowType: BulkRowType;
  locale: string;       // "" = Primärsprache
  marketId: string;     // "" = global
  columnId: string;     // ColumnDescriptor.id
  value: string;
}

export function computeDiff(
  rows: BulkRow[],
  columns: ColumnDescriptor[],
  edits: Record<string, string>,
): BulkDiffEntry[]
```

Regeln, die aus der heutigen Implementierung **wörtlich übernommen** werden (§0.2): getrimmter Vergleich, bewusstes Leeren zählt als Änderung, unbekannte/stale Keys werden verworfen, Spalte muss für den Zeilentyp erlaubt sein. Neu: Spalte muss für `locale !== ""` auch `translatable` sein.

### 3.3 Serverseitiges Filtern, Suchen, Sortieren

`loadBulkRows(db, shop, { type, locale, marketId, search, filters, sort, skip, take })`:

- **Suche:** `where.OR = [{title: {contains, mode:'insensitive'}}, {handle: {contains, mode:'insensitive'}}]`.
- **Sortierung:** nur über DB-Spalten (`title`, `handle`, `status`, `productType`, `price`, `lastSyncedAt`). Spalten ohne DB-Rückhalt (Metafelder, Optionen) sind **nicht** sortierbar — der Spaltenkopf zeigt dann keinen Sortier-Affordanz statt still nichts zu tun.
- **Filter „fehlt":** `{ seoTitle: null } OR { seoTitle: "" }`.
- **Filter „Übersetzung fehlt":** Anti-Join über `ContentTranslation` — die Ids mit vorhandener Übersetzung für `(locale, marketId, key)` werden vorab per `findMany({select:{resourceId:true}})` geholt und als `id: { notIn }` angehängt. Bei sehr großen Katalogen wird die `notIn`-Liste gedeckelt (10.000) und der Filter mit einem Hinweisbanner als „angenähert" markiert, statt eine unbegrenzte Liste in die Query zu schieben.
- **Seitengröße** wählbar 50 / 100 / 250 (Default bleibt 100). Alles darüber bleibt gesperrt: die Zeilen tragen Textareas, nicht Text.

Alle Parameter stehen in der URL (`?type=&locale=&market=&q=&f=&sort=&page=`), damit Zustand teilbar und über `useAppNavigation()` navigierbar bleibt.

### 3.4 Plan-Gate korrigieren

Typ-Liste = Schnittmenge aus den unterstützten Zeilentypen und `PLAN_CONFIG[plan].contentTypes` (§0.4). Der Gate-Check bleibt an **allen drei** Stellen (Loader, Route-Action, `/api/ai`-Handler) — der Handler ist direkt per POST erreichbar.

### 3.5 Abnahme Phase 1

- Alle bestehenden Bulk-Meta-Funktionen arbeiten unverändert, nur unter neuem Pfad; `/app/seo/bulk-meta` leitet weiter.
- 2.000-Produkte-Shop: Suche, Filter, Sortierung, Seitenwechsel je < 1 s Loader-Zeit.
- Unit-Tests für `computeDiff`/`groupDiffByMutationTarget` grün, inklusive der neuen Locale-/Markt-Segmente.

---

## 4. Phase 2 — Produktdaten: Metafelder, Optionen, Alt-Texte

Alle drei Datenquellen liegen **bereits vollständig im Cache**; es fehlt ausschließlich die Anbindung an Grid und Speicher-Pipeline. Das ist die günstigste Phase mit dem größten sichtbaren Zuwachs.

### 4.1 Metafeld-Spalten

**Spaltenquelle.** Nicht „alle Metafelder", sondern genau die, die der Merchant in den Einstellungen freigeschaltet hat: `getEnabledMetafieldKeySet(db, shop)` ([metafield-enablement.server.ts:168](../../app/services/metafield-enablement.server.ts#L168)) geschnitten mit `TRANSLATABLE_METAFIELD_TYPES` ([:16](../../app/services/metafield-enablement.server.ts#L16) — `single_line_text_field`, `multi_line_text_field`, `rich_text_field`, `list.single_line_text_field`). Exakt dieselbe Filterung nutzt heute der Produkt-Loader ([app.products.tsx:211-216](../../app/routes/app.products.tsx#L211-L216)) — der Bulk-Editor darf hier **keine eigene** Logik erfinden, sonst zeigen die beiden Oberflächen verschiedene Felder.

**Spalten-Id:** `mf.<namespace>.<key>` (nicht die Metafeld-GID — die ist pro Produkt verschieden; die Spalte ist definitionsbezogen, die Zelle produktbezogen).

**Zell-Auflösung:** `ProductMetafield`-Zeilen des Produkts nach `namespace`+`key` gemappt. Fehlt die Zeile, ist die Zelle leer — und beim Speichern ein **Anlegen**, kein Update (§4.4).

**Rendering nach Typ:**

| Metafeld-Typ | Zelle |
|---|---|
| `single_line_text_field` | einzeilige Textarea |
| `multi_line_text_field` | mehrzeilige Textarea |
| `list.single_line_text_field` | Textarea, Werte durch `\|` getrennt; Parsing zurück nach JSON-Array beim Speichern, Validierung „kein Wert leer" |
| `rich_text_field` | **read-only** mit „Im Editor öffnen" — Shopifys Rich-Text-JSON in eine Grid-Zelle zu quetschen erzeugt genau die Normalisierungs-Divergenz, die im Theme-Richtext-Pfad schon einmal teuer war ([THEME_RICHTEXT_HANDLING.md](../architecture/THEME_RICHTEXT_HANDLING.md)) |

### 4.2 Options-Spalten

Zwei Spalten pro Optionsposition: `opt.<position>.name` und `opt.<position>.values`. Position statt GID, weil die Spalte über alle Produkte hinweg dieselbe sein muss („Option 1", „Option 2").

- Werte werden als `Rot | Blau | Grün` dargestellt und beim Speichern positionsweise auf die vorhandenen Wert-GIDs gemappt. **Hinzufügen oder Löschen von Werten ist im Grid nicht möglich** — die Anzahl muss übereinstimmen, sonst Zellfehler mit Klartextmeldung. Begründung: Wert-Anlage/-Löschung zieht Varianten-Konsequenzen nach sich, die im Einzeleditor bewusst geführt werden.
- **Metaobjekt-verknüpfte Optionen** (`ProductOption.linkedMetafieldKey`): nur der Name ist editierbar, Werte read-only — identisch zur Regel im Einzeleditor ([OptionsField.tsx:223-293](../../app/components/unified/OptionsField.tsx#L223-L293)).
- Shopifys synthetische „Title/Default Title"-Option wird wie überall über `isDefaultTitleOption` ausgeblendet.
- Legacy-Format: `values` kann ein einfaches String-Array statt `[{id,name}]` sein — beide Formen parsen, wie es [sub-resources.action.ts:805-808](../../app/actions/content/sub-resources.action.ts#L805-L808) bereits tut.

### 4.3 Alt-Text-Spalte

Spalte `img.alt` = Alt-Text des **Hauptbilds** (`featuredImage`/Position 0). Für alle Bilder eines Produkts bleibt der Bild-Manager zuständig; eine Tabelle mit N Bildspalten pro Zeile ist nicht bedienbar.

Schreibpfad: `productUpdateMedia` mit `{productId, media:[{id: mediaId, alt}]}` — derselbe wie in [update.actions.ts:261-308](../../app/actions/product/update.actions.ts#L261-L308). **`mediaId` ist Pflicht**; Zeilen ohne `ProductImage.mediaId` rendern die Zelle read-only mit Hinweis „Bild neu synchronisieren".

**Pflicht beim DB-Spiegel:** `altTextModifiedAt: new Date()` mitschreiben. Der Produkt-Sync bewahrt Alt-Texte, die jünger als `PRESERVE_WINDOW_MS` (5 min) sind ([product-sync.service.ts:1539-1564](../../app/services/product-sync.service.ts#L1539-L1564)) — ohne den Stempel überschreibt der vom eigenen Schreibvorgang ausgelöste `products/update`-Webhook den frisch gesetzten Wert wieder.

### 4.4 Speicher-Pipeline: von „eine Zeile = eine Mutation" zu Ziel-Gruppen

`persistRow` bekommt Unter-Zweige. Pro Produktzeile können jetzt bis zu vier Aufrufe nötig sein — die Reihenfolge ist festgelegt, damit Teilfehler nachvollziehbar bleiben:

1. `productUpdate` — Basisfelder (unverändert, inkl. Partial-SEO-Guard)
2. `metafieldsSet` — **alle** geänderten Metafelder des Produkts in **einem** Aufruf (Shopify erlaubt 25 pro Call; bei mehr wird gechunkt)
3. `productOptionUpdate` — ein Aufruf **pro** geänderter Option (API-bedingt)
4. `productUpdateMedia` — Alt-Text

**Metafeld-Anlage vs. -Update.** Der heutige Einzeleditor sendet `[{id, value}]`, also nur Updates für bereits existierende Metafelder ([sub-resources.action.ts:837-844](../../app/actions/content/sub-resources.action.ts#L837-L844)). Im Grid ist eine leere Zelle der Normalfall, also braucht der Bulk-Pfad die `{ownerId, namespace, key, type, value}`-Form. **Leeren einer Metafeld-Zelle = `metafieldsDelete`**, nicht `metafieldsSet` mit `""` (dieselbe Falle wie bei `title_tag`/`description_tag`, siehe CLAUDE.md).

**Teilfehler-Semantik.** Eine Zeile ist ab jetzt nicht mehr „ganz gespeichert oder ganz gescheitert". `BulkFailure` bekommt daher `columnId?` und die UI markiert **die Zelle** rot, nicht die Zeile. Der bestehende Mechanismus („Edits fehlgeschlagener Zeilen bleiben stehen") wird auf Zell-Granularität verfeinert.

### 4.5 Abnahme Phase 2

- Ein Shop mit 10 freigeschalteten Metafeld-Definitionen sieht 10 wählbare Metafeld-Spalten; Speichern legt fehlende Metafelder an und löscht geleerte.
- Optionsname-Änderung über 50 Produkte in einem Task, Fehler pro Zelle sichtbar.
- Alt-Text-Änderung überlebt den unmittelbar folgenden `products/update`-Webhook (Regressionstest gegen das Preserve-Fenster).

---

## 5. Phase 3 — Varianten und Preise

### 5.1 Das Kernproblem: `ProductVariant` ist kein verlässlicher Cache

`ProductVariant`-Zeilen entstehen heute **ausschließlich** beim Öffnen eines Produkts im Bild-Manager ([api.product-variants.tsx:292](../../app/routes/api.product-variants.tsx#L292), fire-and-forget) — und weder `syncAllProducts` noch `syncProduct` schreiben sie. Ein Preis-Grid auf dieser Tabelle wäre je nach Klick-Historie des Merchants zufällig leer.

**Entscheidung: Varianten in den regulären Produkt-Sync aufnehmen.** In `getProductsBulk` ([product-sync.service.ts:171-237](../../app/services/product-sync.service.ts#L171-L237)) und `getProduct` ([:1172-1233](../../app/services/product-sync.service.ts#L1172-L1233)) kommt hinzu:

```graphql
variants(first: 100) {
  nodes { id title sku price compareAtPrice position barcode image { url } }
}
```

und in `writeProduct`/`saveToDatabase` ein `productVariant`-Upsert analog zu Optionen/Bildern. **Kein `deleteMany`+`createMany`** wie bei Bildern — `galleryJson` und `imageKey` stammen aus dem Bild-Manager und dürfen nicht mitgelöscht werden; also gezielter Upsert auf `id` plus Löschen der von Shopify nicht mehr gelieferten Ids.

**Deckel:** Produkte mit > 100 Varianten werden mit `hasMoreVariants` markiert; die Zeilen sind sichtbar, aber die Seite weist darauf hin, dass die Restmenge im Shopify-Admin liegt. Paginieren würde den Voll-Sync über große Kataloge erheblich verteuern — ein Nachladen pro Produkt on demand ist der bessere Zeitpunkt (Phase 3b, optional).

### 5.2 Schema

```prisma
model ProductVariant {
  // … bestehend: id, shopifyGid, productId, title, sku, imageKey, position, galleryJson, updatedAt
  price          Decimal? @db.Decimal(12, 2)
  compareAtPrice Decimal? @db.Decimal(12, 2)
  barcode        String?
  @@index([productId])
}
```

`Decimal(12,2)` statt `Float` — Geldbeträge als Float sind ein Rundungsfehler mit Ansage. Shopify liefert `Money` als String; die Umwandlung geschieht an genau einer Stelle im Loader.

Die Währung ist **shop-weit** (`shop.currencyCode`) und wird als Spalten-Suffix angezeigt, nicht pro Zelle gespeichert. Markt-abhängige Preislisten sind explizit ausgeschlossen (§11).

### 5.3 Zeilentyp `variant`

| Spalte | Editierbar |
|---|---|
| Produktbild, Produkttitel | nein (Kontext, sticky) |
| Variantentitel | nein (ergibt sich aus den Optionswerten) |
| SKU | ja |
| Preis | ja |
| Vergleichspreis | ja |
| Barcode | ja |
| Position | nein |

Filter zusätzlich: nach Produkt (Suchfeld greift auf Produkt- **und** Variantentitel), „ohne SKU", „ohne Preis", „Vergleichspreis ≤ Preis" (klassischer Datenfehler).

### 5.4 Schreibpfad — validiert gegen Admin-API 2025-10

Eine Mutation pro **Produkt**, nicht pro Variante:

```graphql
mutation bulkEditorVariantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price compareAtPrice }
    userErrors { field message }
  }
}
```

Gegen die Schema-Validierung von 2025-10 geprüft: **benötigte Scopes `read_products` + `write_products`** — beide sind bereits vergeben ([shopify.app.prod.toml:9](../../shopify.app.prod.toml#L9)). **Kein neuer Scope, kein Merchant-Re-Consent.**

Input je Variante: `{ id, price, compareAtPrice, barcode, inventoryItem: { sku } }`. Die SKU liegt am `InventoryItem`, nicht an der Variante — genau so macht es der bestehende SKU-Pfad ([api.update-variant-match-key.tsx:49-60](../../app/routes/api.update-variant-match-key.tsx#L49-L60)). `inventoryQuantity` wird **nicht** angefasst (§11).

**Fehlerbehandlung:** `productVariantsBulkUpdate` liefert `ProductVariantsBulkUpdateUserError` mit `field`-Pfad wie `variants.2.price` → daraus wird die betroffene **Zelle** aufgelöst und rot markiert. Der bestehende `collectErrors`-Helfer ([api.update-variant-match-key.tsx:37](../../app/routes/api.update-variant-match-key.tsx#L37)), der Top-Level-`errors` und `userErrors` zusammenführt, wird wiederverwendet.

### 5.5 Geldwerte richtig parsen (der unterschätzte Teil)

Die App ist dreisprachig; deutsche und spanische Merchants tippen `1.299,90`, englische `1,299.90`. Ein naives `parseFloat` macht daraus `1.299` bzw. `1`.

**Regeln (in `parseMoney`, unit-getestet):**
1. Whitespace und Währungssymbole entfernen.
2. Ist das letzte Trennzeichen ein Komma und stehen danach 1–2 Ziffern → Komma ist der Dezimaltrenner, Punkte sind Tausendertrenner. Sonst umgekehrt.
3. Ergebnis auf 2 Nachkommastellen normalisieren, negativ = Fehler, leer = **Preis unverändert lassen** (Preis ist bei Shopify nicht nullbar — Leeren ist keine gültige Operation und wird als Zellfehler gemeldet). `compareAtPrice` **darf** geleert werden → `null`.
4. Ausgabe immer in der Anzeigesprache formatiert, gespeichert wird der normalisierte Punkt-Wert.

### 5.6 Rechen-Aktionen auf der Auswahl

Ein Preis-Grid ohne Massenoperation ist ein halbes Werkzeug. Auf der aktuellen (gefilterten) Auswahl:

- Preis **± X %** / **± X (absolut)**
- Preis auf **X** setzen
- `compareAtPrice` = aktueller Preis setzen (Aktionsvorbereitung), danach Preis reduzieren
- Rundung auf `,00` / `,90` / `,95`

Wichtig: Diese Aktionen schreiben **nicht** direkt, sondern füllen die Edit-Map. Der Merchant sieht das Ergebnis im Grid, kann korrigieren, und speichert über denselben Diff-Pfad. Damit gilt die Vorschau-, Fehler- und Task-Mechanik unverändert — und ein Rechenfehler ist vor dem Schreiben sichtbar.

### 5.7 Abnahme Phase 3

- Frischer Shop, nie im Bild-Manager gewesen: Varianten-Tab ist nach dem regulären Sync vollständig gefüllt.
- „Alle Preise +10 %" auf 300 gefilterte Varianten füllt das Grid, „Nur geänderte" zeigt 300 Zeilen, Speichern läuft als Task mit Fortschritt.
- `1.299,90` und `1,299.90` ergeben beide `1299.90`; `-5` und `abc` sind Zellfehler.

---

## 6. Phase 4 — Sprachen und Märkte

Die wertvollste und heikelste Phase. ContentPilot ist eine Übersetzungs-App ohne tabellarisches Übersetzen — das ist die auffälligste Lücke im ganzen Produkt.

### 6.1 Was es schon gibt (und was daraus folgt)

| Baustein | Fundstelle | Konsequenz für den Bulk-Editor |
|---|---|---|
| `translationsRegister` ist **pro `resourceId`** | [content.mutations.ts:3](../../app/graphql/content.mutations.ts#L3) | Eine Tabelle über N Zeilen = N Mutationen. Kein Batch-Write möglich — nur Digests sind bündelbar. |
| Gebündelte Digest-Abfrage `loadTranslatableDigests(gateway, ids, key)` | [seo-bulk-fix.handler.ts:2014](../../app/routes/api-ai-handlers/seo-bulk-fix.handler.ts#L2014) | **Wiederverwenden**, nicht neu bauen: aliasierte `a0..aN`-Sub-Selektionen, `DIGEST_BATCH_CHUNK = 50`, dedupliziert, Fallback pro Item bei Chunk-Fehler. Muss auf **mehrere Keys pro Ressource** erweitert werden. |
| Feld→Shopify-Key-Map | [shopify-content.service.ts:748-758](../../src/services/shopify-content.service.ts#L748-L758) **und** [:1236-1246](../../src/services/shopify-content.service.ts#L1236-L1246) | Existiert **doppelt**. Vor dem Ausbau in eine exportierte Konstante zusammenführen — ein dritter Abzug wäre der Bug, der später auffällt. Mapping: `title→title`, `description\|body→body_html`, `handle→handle`, `seoTitle→meta_title`, `metaDescription→meta_description`, `productType→product_type`, `summary→summary_html`. |
| Markt-Faltung | `marketId` wird pro `TranslationInput` gefaltet; Löschen über `marketIds: marketId ? [marketId] : null` | Global (`""`) und markt-spezifisch sind getrennte Zeilen; ein Markt-Löschen lässt die globale Zeile stehen. Shopify **spiegelt `marketId` nicht zurück** ([:804](../../src/services/shopify-content.service.ts#L804)) — die Zuordnung führt die App selbst. |
| Echo-Prüfung | nur in [templates-update.action.ts:294](../../app/actions/templates/templates-update.action.ts#L294) (Register) und [:378](../../app/actions/templates/templates-update.action.ts#L378) (Remove) sowie [seo-bulk-fix.handler.ts:2289](../../app/routes/api-ai-handlers/seo-bulk-fix.handler.ts#L2289) | Alle anderen Pfade prüfen nur `userErrors` — also genau das Muster, das laut CLAUDE.md schon dreimal zu stillen No-Ops geführt hat. Der Bulk-Editor **muss** echo-prüfen. |
| Webhook-Schutz `markTranslationSaved(resourceId)` | [translation-save-lock.server.ts:23](../../app/utils/translation-save-lock.server.ts#L23), 60 s | Nach **jedem** erfolgreichen Schreiben aufrufen, sonst überschreibt der ausgelöste Produkt-Webhook die Übersetzung wieder. |

### 6.2 Zwei Helfer, die dieser Plan neu einzieht

Beide gehören in `app/services/bulk-editor/translations.server.ts` und werden anschließend **auch** von den Alt-Pfaden benutzt (kein vierter Abzug derselben Logik):

```ts
/** Digests für viele Ressourcen × mehrere Keys, gechunkt und dedupliziert. */
export async function loadDigestsForRows(
  gateway: ShopifyApiGateway,
  resourceIds: string[],
  keys: string[],
): Promise<Map<string, Map<string, string>>>;   // resourceId → key → digest

/** Ein Register-Aufruf für EINE Ressource, mit Echo-Prüfung.
 *  Rückgabe: welche Keys Shopify bestätigt hat — nur diese dürfen in die DB. */
export async function registerAndVerify(
  gateway: ShopifyApiGateway,
  resourceId: string,
  inputs: TranslationInput[],
): Promise<{ confirmedKeys: Set<string>; userErrors: UserError[] }>;
```

`registerAndVerify` ist die Verallgemeinerung von [templates-update.action.ts:294-315](../../app/actions/templates/templates-update.action.ts#L294-L315). Analog `removeAndVerify` für das Leeren von Zellen: Keys, deren Entfernung Shopify **nicht** bestätigt, werden lokal **nicht** gelöscht (CLAUDE.md-Invariante).

### 6.3 Regel für fehlende Digests — eine einzige, strikte

Heute verhalten sich neun Aufrufstellen unterschiedlich (DB-only mit Warnung / Ablehnen / Werfen / stilles Überspringen). Für den Bulk-Editor gilt **eine** Regel:

> Kein Digest ⇒ ein Re-Fetch der Ressource ⇒ immer noch kein Digest ⇒ **Zellfehler**. Kein Shopify-Schreiben, **kein** DB-Schreiben.

Begründung: Ein DB-Only-Schreiben erzeugt genau die Divergenz, die später als „Speichern tut nichts" zurückkommt — im Einzeleditor ist das mit einem Warnbanner noch vertretbar, bei 250 Zeilen sieht das niemand.

### 6.4 UI-Verhalten

- Sprach- und Marktwechsel behalten ungespeicherte Edits (der Locale steckt im Key), zeigen aber einen Hinweis „Änderungen in 2 weiteren Sprachen ungespeichert".
- **Speichern schreibt alle Sprachen** der Edit-Map, nicht nur die sichtbare — sonst gehen unsichtbare Änderungen still verloren.
- Leere Zelle in Fremdsprache = Primärwert als Ghost. Tippen erzeugt eine Übersetzung, Leeren einer vorhandenen Übersetzung erzeugt ein `translationsRemove`.
- Nicht übersetzbare Spalten (Status, Preis, SKU, Metafeld-Typen außerhalb `TRANSLATABLE_METAFIELD_TYPES`) sind in Fremdsprachen grau mit Tooltip.
- Markt-Auswahl „Alle Märkte" schreibt globale Zeilen (`marketId: ""`); ein konkreter Markt schreibt die Markt-Ebene und zeigt den globalen Wert als Ghost darunter — dieselbe Semantik wie im Einzeleditor.

### 6.5 „Fehlende übersetzen" — AI im Grid

Aktion über der Tabelle: **Spalte + Zielsprache wählen → alle leeren Zellen der aktuellen Filtermenge übersetzen.**

- Läuft immer als **Task** (Contract §8), Typ `bulkEditorTranslate`, eingetragen in `LONG_RUNNING_TASK_TYPES` ([task-recovery.service.js:34](../../task-recovery.service.js#L34)), Single-flight pro Shop, Fortschritt nach jeder Zeile.
- AI-Arbeit **muss** über `AIQueueService.enqueue()` laufen (Contract §8, Muster 4) — anders als der reine Schreib-Task `seoBulkMeta`, der bewusst an der AI-Queue vorbeigeht.
- Kurzfelder (`title`, `seoTitle`, `handle`, `productType`) gehen über den bestehenden Batch-Pfad `translateShortFieldsBatch`; Langfelder pro Zeile.
- `productType` läuft zwingend über den `GroupedFieldTranslation`-Cache ([schema.prisma:509](../../prisma/schema.prisma#L509)) — sonst zerfällt eine Google-Merchant-Kategorie in mehrere Varianten.
- Ergebnis landet **nicht** direkt in Shopify, sondern als Vorschlag in der Edit-Map, wenn der Merchant „Vorschau" wählt; „Übersetzen & speichern" schreibt durch. Default ist Vorschau — AI-Text ohne Sichtprüfung über 250 Zeilen zu schreiben ist der teurere Fehler.

### 6.6 Markt-Lücke in den AI-Pfaden

`translateAllContent`, `translateMetaobjectEntries`, `saveImageAltTextTranslation` und sämtliche `api-ai-handlers`-Schreiber setzen `marketId: ""` **hart**. Solange das so ist, kann „Fehlende übersetzen" nur global arbeiten. **Entscheidung:** Phase 4 liefert markt-**bewusstes manuelles** Übersetzen und global-only AI-Übersetzen; das Durchreichen von `marketId` in die AI-Pfade ist ein eigener, klar abgegrenzter Schritt (Phase 4b) — und er berührt Code, den alle anderen Oberflächen mitbenutzen, gehört also nicht in dieselbe Auslieferung.

**4b-Folgearbeiten** — ✅ **erledigt** (Commit „finish Phase 4b …"):

1. ✅ `marketId` in den „Fehlende übersetzen"-AI-Pfad durchgereicht — markt-bewusst: Client sendet den Markt nur, wenn die Modal-Zielsprache = die Sprache, für die der Markt gewählt wurde; Handler validiert via `findInvalidLocaleOrMarket`, liest die leere Zelle im aktuellen (locale, market)-Layer, `pushSuggestion` schreibt mit `marketId`. Der verifizierte Schreibpfad (`registerAndVerify`/`persistTranslationRow`) war schon markt-fähig.
2. ✅ **Bulk-Primär-Saves invalidieren jetzt veraltete Fremdübersetzungen** (Review-Finding 8): `invalidateStaleForeignTranslations` in `apply.server.ts` entfernt beim Ändern eines primären übersetzbaren Feldes dessen Fremdübersetzungen auf Shopify **und** lokal — wie der Einzeleditor, aber über den **echo-verifizierten** `removeAndVerifyAcrossLocales` (kein stiller `translationsRemove`-No-Op). Nur globale Zeilen (`marketId ""`); Markt-Overrides überleben. In allen drei Primär-Pfaden verdrahtet (Produkt-Basis, Single-Mutation-Typen, Metaobjekt). Best-effort: ein Fehler loggt und behält die stale Zeilen, statt die Zelle rot zu machen. `foreignLocales` reichen die Aufrufer rein (kein Extra-Fetch in `applyBulkDiff`).

**Feldfarben** (Parität mit „Inhalt", zusätzlich zu 4b): Gelb (`#fff4e5`) wenn die gewählte Sprache keinen Feldwert hat; Blau (`#e0f2fe`, nur Primär-Ansicht) wenn der Primärwert existiert, aber eine Fremdsprache die Übersetzung fehlt. Loader flaggt Blau pro Zeile (`untranslatedColumnIds`) aus `ContentTranslation`; Gelb wird client-seitig aus dem Zellwert berechnet (Live-Update beim Tippen). Klasse am Zell-Wrapper, damit Dirty/Error-Zustände Vorrang behalten.

### 6.7 Abnahme Phase 4

- 100 Produkte × Spalte „Meta-Description" × Sprache FR: manuelles Ausfüllen, Speichern, Reload zeigt die Werte — **und** Shopifys Übersetzungsansicht ebenfalls (Echo-Prüfung greift).
- Leeren einer übersetzten Zelle entfernt sie in Shopify **und** lokal; schlägt `translationsRemove` fehl, bleibt die lokale Zeile stehen und die Zelle wird rot.
- Ein Produkt ohne Digest für `meta_description` erzeugt einen Zellfehler, keine stille DB-Zeile.

---

## 7. Phase 5 — Die fehlenden Ressourcentypen

| Typ | Quelle | Spalten | Aufwand |
|---|---|---|---|
| **Blog-Container** | **kein DB-Cache** — live über `getBlogs` ([content-sync.service.ts:774](../../app/services/content-sync.service.ts#L774)); Container-Felder heute nur im Einzeleditor (`BLOG_CONTAINER_FIELDS`, [content-fields.config.tsx:187](../../app/config/content-fields.config.tsx#L187)) | Titel, Handle, SEO-Titel, Meta-Description | klein — Blogs sind zweistellig; ein Live-Fetch im Loader ist vertretbar. Schreibt über `updateBlog` ([shopify-content.service.ts:245](../../src/services/shopify-content.service.ts#L245)) |
| **Richtlinien** | `ShopPolicy` | Titel (read-only), Text | klein — `updateShopPolicy(type, body)` ([:501](../../src/services/shopify-content.service.ts#L501)); Titel ist bei Shopify nicht setzbar |
| **Metaobjekte** | `Metaobject.fields` (JSON) | dynamisch pro `MetaobjectDefinition` — eine Spalte je Feld-Key, Typ-Filter wie bei Metafeldern; zusätzlicher Typ-Filter in der Toolbar (Metaobjekte sind pro `type` schemagleich) | mittel — Übersetzungen in `MetaobjectTranslation` (`shop_metaobjectId_key_locale_marketId`), drei bestehende Schreibstellen sollten vorher auf **eine** reduziert werden |
| **Menüs** | `Menu.items` (JSON-Baum) | — | **verworfen**: ein Baum ist keine Tabelle. Bleibt im Menü-Editor. |

Für Metaobjekte gilt dieselbe Regel wie bei Metafeldern: `rich_text`-artige Felder bleiben read-only mit „Im Editor öffnen".

---

## 8. Phase 6 — Import, Export und Tastaturbedienung

Das ist der Punkt, an dem der Editor für große Kataloge von „nett" auf „unverzichtbar" springt.

### 8.1 CSV-Export

Exportiert **die aktuelle Ansicht**: Typ, Sprache, Markt, Filter, Spaltenauswahl. Erste Spalte immer `id` (GID), zweite `handle` — beides als Wiedererkennung beim Re-Import. UTF-8 **mit BOM** (sonst zerlegt Excel deutsche Umlaute), `;` als Trenner in de/es, `,` in en.

Über `BULK_META_PAGE_SIZE` hinaus: Export läuft über **alle** Treffer des Filters, nicht nur die sichtbare Seite; > 5.000 Zeilen als Task mit Download-Link im Aufgaben-Tab.

### 8.2 CSV-Import

Der Import erzeugt **keinen** eigenen Schreibpfad, sondern genau denselben Diff wie das Tippen im Grid:

1. Datei parsen, Spaltenköpfe auf `ColumnDescriptor.id` mappen (unbekannte Spalten werden gemeldet, nicht ignoriert).
2. Zeilen über `id` auflösen, ersatzweise über `handle` (mehrdeutige Handles → Fehler, kein Raten).
3. Diff gegen die DB-Werte berechnen → **Vorschau-Tabelle** „X Zeilen, Y Zellen ändern sich" mit den ersten 50 Änderungen im Klartext.
4. Erst danach Speichern über die bekannte Pipeline (synchron ≤ 25 Zeilen, sonst Task).

Harte Grenzen: 5 MB Datei, 10.000 Zeilen, nur Spalten, die der Merchant laut Plan und Zeilentyp auch im Grid ändern dürfte. Der Import ist der gefährlichste Eingang der ganzen App — die Validierung ist dieselbe wie im Grid, nur einmal mehr.

### 8.3 Einfügen aus Excel / Google Sheets

Beim Einfügen in eine Zelle wird der Zwischenablage-Inhalt auf `\t`/`\n` geprüft. Enthält er beides, wird er als Rechteck ab der Zielzelle verteilt (nur über sichtbare, editierbare Spalten und geladene Zeilen), sonst normal eingefügt. Ein Toast meldet „12 × 3 Zellen eingefügt" mit Rückgängig-Aktion.

### 8.4 Tastatur und Rückgängig

- Tab/Shift-Tab, Enter (Zeile runter), Esc (Zelle zurücksetzen)
- Strg+Z auf Zellebene (Edit-Map-Historie, nicht Browser-Undo)
- „Nur geänderte" als Kontrollansicht vor dem Speichern

---

## 9. Felder, die zusätzlich Schema und Sync brauchen

Diese sind bewusst **nicht** in den Phasen 1–6 enthalten: Sie kosten je eine Prisma-Migration plus eine Erweiterung beider Produkt-Queries ([product-sync.service.ts:171](../../app/services/product-sync.service.ts#L171) und [:1172](../../app/services/product-sync.service.ts#L1172)) und sind erst danach eine Grid-Spalte.

| Feld | Was fehlt | Besonderheit |
|---|---|---|
| `vendor` | Query + `Product.vendor` + `input.vendor` | Es gibt bereits Code-Kommentare, die „kein Vendor-Feld" voraussetzen ([keyword-distribution.handler.ts:131](../../app/routes/api-ai-handlers/keyword-distribution.handler.ts#L131), [app.seo.keywords.tsx:345](../../app/routes/app.seo.keywords.tsx#L345)) — mit anpassen. `GroupedFieldTranslation.fieldKey` wurde ausdrücklich für `vendor`/`tag` vorgesehen ([schema.prisma:506-508](../../prisma/schema.prisma#L506-L508)). |
| `tags` | Query + Spalte + Zelltyp | `[String!]`, also kein String-Skalar. Braucht einen Tag-Editor in der Zelle und eine Entscheidung „ersetzen vs. ergänzen" beim Bulk-Setzen. |
| `publishedAt` / Kanäle | Query + Spalte + **neuer Scope** | `publishablePublish` braucht `write_publications` → Re-Consent. Siehe §11. |
| Artikel-`author`, -`tags`, `publishedAt` | Query + `Article`-Spalten | Autor ist bei Shopify ein Freitext-Objekt, kein Nutzerbezug. |
| `templateSuffix` (Produkt/Seite/Artikel/Collection) | Query + Spalte | Nur sinnvoll als Select über die vorhandenen Theme-Templates. |
| Collection-`sortOrder` | Query + Spalte | Enum; für Smart Collections teilweise gesperrt. |

**Empfehlung:** `vendor` und `tags` zuerst — sie sind die häufigsten Bulk-Wünsche nach dem Preis und beide über `productUpdate` schreibbar, also ohne neue Mutation.

---

## 10. Querschnittsthemen

### 10.1 Durchsatz, Limits und Rate-Limiting

Der heutige Deckel ist zeilenbasiert (`MAX_BULK_META_TASK_ITEMS = 500`). Sobald eine Zeile bis zu vier Mutationen auslöst (§4.4), misst diese Zahl nichts mehr.

**Entscheidung: Deckel auf geschätzte Aufrufe statt Zeilen.**

```ts
export const MAX_SYNC_SAVE   = 25;     // unverändert: Zeilen im Vordergrund
export const MAX_TASK_CALLS  = 2000;   // neu: geschätzte Shopify-Aufrufe pro Task-Lauf
export function estimateCalls(diff: BulkDiffEntry[]): number;
```

Überschreitet ein Speichern das Budget, meldet die UI es **vorher** („Diese Änderung braucht ca. 2.400 Aufrufe — bitte in zwei Schritten speichern oder den Filter enger ziehen") statt nach 20 Minuten zu scheitern.

**Alle** Schreibvorgänge laufen über `ShopifyApiGateway` — 10 Anfragen/s, 20 ms Abstand, THROTTLED-Erkennung, 3 Wiederholungen ([shopify-api-gateway.service.ts:42](../../app/services/shopify-api-gateway.service.ts#L42)). Das ist heute schon so für `applyBulkMetaDiff` ([bulk-meta.service.ts:358](../../app/services/seo/bulk-meta.service.ts#L358)) und gilt ausdrücklich auch für die neuen Varianten- und Übersetzungspfade, die in ihren bestehenden Einzelfall-Implementierungen am Gateway **vorbei** gehen.

Bekannte Schwäche, die dieser Plan **nicht** behebt: Das Gateway zählt Anfragen, nicht Kosten (`extensions.cost` wird nicht gelesen). Bei teuren Queries wie `variants(first:100)` kann Shopify trotz Einhaltung der 10 req/s drosseln. Die THROTTLED-Wiederholung fängt das ab; ein kostenbewusstes Gateway ist ein eigenes, größeres Thema.

### 10.2 Browser-Last

100 Zeilen × 30 Spalten = 3.000 Textareas. Das ist die Grenze, an der der heutige Aufbau (jede Zelle eine echte Textarea) kippt.

**Maßnahmen in Phase 1:** maximal 20 gleichzeitig sichtbare Spalten (der Spaltenwähler verweigert die 21. mit Hinweis), Zellen rendern als leichter `<div>` und tauschen erst beim Fokus gegen die Textarea. **Erst wenn das nicht reicht**, kommt Zeilen-Virtualisierung — sie verträgt sich schlecht mit `display:contents`-Grid und Sticky-Spalten und ist deshalb kein Startpunkt.

### 10.3 Webhook-Rückschlag

Jeder eigene Schreibvorgang löst `products/update` aus, was `syncProduct` startet — und der macht `deleteMany`+Neuanlage auf `ProductImage`/`ProductOption` ([product-sync.service.ts:1766-1767](../../app/services/product-sync.service.ts#L1766-L1767)). Pflicht daher:

- Alt-Text: `altTextModifiedAt` setzen (5-Minuten-Fenster, §4.3).
- Übersetzungen: `markTranslationSaved(resourceId)` nach jedem bestätigten Schreiben (60 s).
- Für die neuen Varianten-Spalten gibt es **keinen** solchen Schutz — er ist auch nicht nötig, weil der Webhook die Werte frisch von Shopify liest und Shopify nach unserem Schreiben die Wahrheit ist. Wichtig ist nur, dass der Varianten-Upsert im Sync `galleryJson`/`imageKey` nicht mitlöscht (§5.1).

Für Seiten und Artikel gibt es **keine** Shopify-Webhooks ([webhook-registration.service.ts:74](../../app/services/webhook-registration.service.ts#L74)) — dort ist der DB-Spiegel nach dem Schreiben die einzige Aktualisierung bis zum nächsten Hintergrund-Sync. Umso wichtiger, dass der Spiegel **nur** bestätigte Werte übernimmt.

### 10.4 i18n

Alle neuen Strings unter `t.bulkEditor.*`, Reihenfolge **de → en → es** (de definiert den `Translation`-Typ). Betroffen: Spaltennamen (inkl. dynamischer Metafeld-Labels, die aus Shopify kommen und **nicht** übersetzt werden), Filter, Zellfehler, Rechen-Aktionen, CSV-Dialoge, Task-Labels unter `t.tasks.taskType.bulkEditorTranslate`.

### 10.5 Telemetrie

Debug-Namespace `bulk` über das vorhandene [debug.ts](../../app/utils/debug.ts)-Muster (`bulk:load`, `bulk:diff`, `bulk:save`). Keine Feldwerte loggen — Produkttexte sind Merchant-Daten. Zusammenfassungen (`{rows, cells, calls, failures}`) sind erlaubt und für Support-Fälle das eigentlich Nützliche.

### 10.6 GDPR

Der Plan führt **kein neues shop-scoped Modell** ein: Die neuen Spalten hängen an `ProductVariant`, das über `Product` bereits per Cascade in `redactShopData` fällt. **Falls** später gespeicherte Ansichten („meine Preis-Ansicht") dazukommen, gilt Contract §6: neues Modell mit eigener `shop`-Spalte, `deleteMany({where:{shop}})` in [gdpr.service.ts](../../app/services/gdpr.service.ts) **und** Eintrag im Kommentarblock — der Drift-Guard-Test prüft das.

### 10.7 Plan-Gating

| Fähigkeit | Ab Plan |
|---|---|
| Grid, Basisfelder, Filter, Export | Basic |
| Metafelder, Optionen, Alt-Texte | Basic (der Cache dafür ist ab Basic an: `cacheEnabled.productOptions/productMetafields`, [plans.ts:130](../../app/config/plans.ts#L130)) |
| Varianten + Preise | Basic |
| Übersetzungs-Dimension | Basic (Sprachen sind auf allen Tarifen unbegrenzt) |
| „Fehlende übersetzen" (AI) | Pro — es ist Fan-out-AI-Arbeit, gleiche Logik wie beim SEO-Bulk-Fix |
| CSV-Import | Pro — der destruktivste Eingang gehört nicht auf den Einstiegstarif |

Der Typ-Selektor bleibt zusätzlich auf `PLAN_CONFIG[plan].contentTypes` beschränkt (§3.4). Gate-Prüfung weiterhin an allen drei Stellen.

---

## 11. Nicht-Ziele (bewusst verworfen)

| Thema | Grund |
|---|---|
| **Lagerbestand** | `inventorySetQuantities` braucht `read_inventory`/`write_inventory`. Ein Scope-Zuwachs zwingt **jeden** installierten Merchant zur erneuten Zustimmung — das ist ein Deployment-Ereignis, kein Feature-Detail. Erst sinnvoll, wenn Inventar ein eigenes Produktziel wird. |
| **Vertriebskanäle / Veröffentlichen** | `publishablePublish` braucht `write_publications`. Gleiches Argument. `Product.status` (Aktiv/Entwurf/Archiviert) deckt den häufigsten Fall bereits ab und ist schon Bulk-Feld. |
| **Markt-Preislisten** (`priceList`) | Plus-Feature mit eigener Semantik (Aufschläge/Abschläge statt absoluter Preise). Gehört nicht in dieselbe Zelle wie der Basispreis. |
| **Menü-Baum** | Ein Baum ist keine Tabelle; der Menü-Editor ist das richtige Werkzeug. |
| **Theme-Inhalte** | Key/Value über Theme- **und** Markt-Dimension ([ThemeTranslation](../../prisma/schema.prisma#L759)), plus Richtext-Normalisierung und Datei-Routing pro Ressourcentyp. Das im Grid nachzubauen heißt, die Fehlerklassen aus `templates-update.action.ts` ein zweites Mal zu bauen. |
| **Bild-Upload / Bildreihenfolge** | Bleibt im Bild-Manager; eine Tabelle ist kein Datei-Manager. |
| **Rich-Text-Metafelder editieren** | Shopifys Rich-Text-JSON in einer Grid-Zelle erzeugt Normalisierungs-Divergenz zwischen DB und Shopify — dieselbe Klasse Fehler wie im Theme-Richtext-Pfad. Read-only mit „Im Editor öffnen". |
| **Option-Werte anlegen/löschen** | Zieht Varianten-Konsequenzen nach sich, die eine geführte Oberfläche braucht. Umbenennen ja, Struktur ändern nein. |

---

## 12. Tests

**Unit (Vitest, rein und schnell — der eigentliche Regressionsschutz):**

- `computeDiff` / `groupDiffByMutationTarget` — Migration von [tests/unit/seo-bulk-meta.service.test.ts](../../tests/unit/seo-bulk-meta.service.test.ts): alle bestehenden Fälle plus Locale-/Markt-Segment, plus „Spalte in Fremdsprache nicht übersetzbar → verworfen", plus Gruppierung mehrerer Varianten desselben Produkts zu **einem** Ziel.
- `parseMoney` — `1.299,90` / `1,299.90` / `1299` / `-5` / `""` / `abc` / `1.2.3`.
- Spalten-Auflösung — Metafeld-Spalte ohne `ProductMetafield`-Zeile ⇒ leer; `rich_text_field` ⇒ nicht editierbar; verknüpfte Option ⇒ nur Name editierbar.
- `estimateCalls` — Zeile mit Basis+2 Metafeldern+1 Option+Alt-Text ⇒ 4.
- CSV: Kopf-Mapping, unbekannte Spalte, mehrdeutiges Handle, Trenner-/BOM-Erkennung.

**Mit Mock-Gateway:**

- `registerAndVerify`: Shopify antwortet ohne `userErrors`, spiegelt aber nur 2 von 3 Keys ⇒ nur 2 DB-Zeilen, Rückgabe meldet die dritte als Fehler. *Das ist der Test, der die teuerste Fehlerklasse dieser App abdeckt.*
- `removeAndVerify`: keine Bestätigung ⇒ lokale Zeile bleibt.
- `productVariantsBulkUpdate` mit `userErrors[].field = "variants.1.price"` ⇒ Fehler landet auf der richtigen Zelle.
- Fehlender Digest ⇒ Zellfehler, **kein** DB-Schreiben.

**Manuell vor jedem Phasen-Abschluss:** Speichern → Shopify-Admin öffnen → Wert prüfen → App neu laden → Wert prüfen. Ein grüner Banner ist in dieser Codebasis wiederholt keine Garantie gewesen.

---

## 13. Reihenfolge, Aufwand, Risiken

| Phase | Inhalt | Aufwand | Nutzen | Risiko |
|---|---|---|---|---|
| 1 | Fundament: Deskriptoren, Key-Format, Route, Filter/Suche/Sortierung | **L** | mittel (sofort spürbar bei großen Katalogen) | Umbau ohne sichtbares Feature — muss in einem Rutsch fertig werden |
| 2 | Metafelder, Optionen, Alt-Texte | **M** | **hoch** — Daten liegen bereits im Cache | Teilfehler-Semantik pro Zelle |
| 3 | Varianten + Preise | **L** | **sehr hoch** — der meistgenannte Bulk-Wunsch | Sync-Kosten der Varianten-Query; Geld-Parsing |
| 4 | Sprachen/Märkte | **L** | **sehr hoch** — schließt die auffälligste Produktlücke | Stille No-Ops ohne Echo-Prüfung; Digest-Beschaffung |
| 5 | Blogs, Richtlinien, Metaobjekte | **S–M** | mittel | Blogs brauchen Live-Fetch |
| 6 | CSV-Import/Export, Excel-Einfügen, Tastatur | **M** | hoch für große Shops | Import ist der destruktivste Eingang → Vorschau ist Pflicht |
| — | vendor/tags (§9) | **M** | hoch | Migration + zwei Query-Erweiterungen |

**Empfohlene Auslieferungsreihenfolge:** 1 → 2 → 4 → 3 → 6 → 5.

Begründung für den Tausch von 3 und 4: Phase 4 (Sprachen) nutzt das Fundament aus Phase 1 unmittelbar, braucht **keine** Prisma-Migration und schließt die Lücke, die am ehesten als Produktmangel wahrgenommen wird. Phase 3 (Preise) ist wertvoll, hängt aber an einer Schema-Änderung **und** an einer Erweiterung des Voll-Syncs — das ist die Phase mit dem größten Betriebsrisiko und profitiert davon, auf einem bereits stabilisierten Fundament zu laufen.

**Die drei größten Risiken, benannt:**

1. **Stille No-Op-Speicherungen bei Übersetzungen.** Historisch die teuerste Fehlerklasse dieser Codebasis (App-Embed, CookieBanner, ThemeContent — alle in CLAUDE.md dokumentiert). Gegenmaßnahme: `registerAndVerify`/`removeAndVerify` sind **die einzigen** erlaubten Schreibwege in Phase 4, mit Mock-Test.
2. **Sync-Kosten der Varianten-Query.** `variants(first:100)` in einer Query, die heute 100 Produkte pro Batch holt, kann die Kostengrenze reißen — und der Sync läuft am (ohnehin nicht kostenbewussten) Gateway vorbei. Gegenmaßnahme: vor dem Merge auf einem Shop mit vielen Varianten messen und `PRODUCT_BATCH_SIZE` gegebenenfalls senken.
3. **Der Umbau in Phase 1 ohne sichtbaren Nutzen.** Ein halb migrierter Editor mit zwei Key-Formaten wäre schlimmer als der heutige Zustand. Gegenmaßnahme: Phase 1 wird nicht ausgeliefert, bevor die migrierten Unit-Tests grün sind und der alte Funktionsumfang vollständig unter dem neuen Pfad läuft.

---

## 14. API-Verifikation gegen shopify.dev (2026-07-22) — verbindliche Korrekturen

Die API-Annahmen der §§4–7 wurden gegen die offiziellen Shopify-Docs (Admin GraphQL, latest/2025-10+) verifiziert. Ergebnis: Kernannahmen bestätigt, sieben Präzisierungen sind **bei der Umsetzung verbindlich**:

1. **`userErrors.field` ist ein Array von Pfadsegmenten** (`["variants","2","price"]`), kein Dot-String. Die Zell-Auflösung in §5.4 arbeitet auf dem Array (bzw. `field.join('.')`), nicht auf einem erwarteten String.
2. **Kein Varianten-Limit pro `productVariantsBulkUpdate`-Aufruf dokumentiert.** Faktische Grenzen: Varianten-Limit pro Produkt und dynamische Query-Cost. Kein künstliches 250er-Chunking einbauen; THROTTLED-Handling des Gateways genügt.
3. **Alt-Text: bewusst bei `productUpdateMedia` bleiben.** Die Mutation ist deprecated (Nachfolger `fileUpdate`), existiert aber in latest und ist der bestehende Schreibpfad der App. `fileUpdate` braucht den Scope `write_files` → Re-Consent aller Merchants → verstößt gegen §11. Wechsel auf `fileUpdate` erst, wenn ohnehin ein Scope-Ereignis ansteht; bis dahin Kommentar an der Schreibstelle.
4. **Metafeld-Löschen ausschließlich über `metafieldsDelete`** mit `MetafieldIdentifierInput` (`ownerId`+`namespace`+`key`) — das ältere `metafieldDelete` (per GID) wurde mit 2025-01 entfernt. `metafieldsSet` mit `""` wird von Shopify abgelehnt („Value can't be blank"). `type` beim `metafieldsSet` immer mitsenden (nullable, aber Pflicht bei Neuanlage ohne Definition).
5. **Metaobjekt-verknüpfte Optionen (`linkedMetafield`): auch der Options-Name wird im Grid nicht editiert** (abweichend von §4.2). Wertnamen kommen dort aus Metaobjects (`linkedMetafieldValue`), und `productOptionUpdate` kennt eigene Fehlercodes für Linked-Konflikte. Die Zelle rendert vollständig read-only mit Tooltip; Umbenennen bleibt Sache des Einzeleditors.
6. **`TranslatableResourceType`-Enum heißt `PAGE`, `ARTICLE`, `BLOG`, `COLLECTION`** (nicht `ONLINE_STORE_*` — mit 2024-10 entfernt). Der App-Code ist bereits konsistent; neue Aufrufe verwenden die neuen Namen. Keys: PAGE/COLLECTION `title|body_html|handle|meta_title|meta_description`, ARTICLE zusätzlich `summary_html`, BLOG ohne body. `meta_title`/`meta_description` haben nur dann einen Digest, wenn das SEO-Feld primär überschrieben wurde — fehlender Digest ist dort ein erwartbarer Zustand und läuft in die Regel aus §6.3.
7. **`translationsRegister`-Echo: `market` ist ein Objekt.** Die Selektion muss `translations { key locale value market { id } }` anfordern; ein flaches `marketId` gibt es in der Antwort nicht. Die Markt-Zuordnung führt weiterhin die App (§6.1).

Außerdem bestätigt: `metafieldsSet` max. 25 pro Aufruf mit Upsert-Semantik (atomar); `shopPolicyUpdate(shopPolicy: {type, body})` ohne `title`-Feld, Scope `write_legal_policies` (in [shopify.app.prod.toml](../../shopify.app.prod.toml#L9) bereits vergeben — verifiziert); `blogUpdate` ohne natives SEO-Feld (SEO über `global.title_tag`/`description_tag`-Metafelder); `translationsRemove` mit `marketIds`; `compareAtPrice: null` leert, `price` ist nicht nullbar; Scope für `productVariantsBulkUpdate` ist `write_products`.

---

## 15. Was dieser Plan ausdrücklich nicht anfasst

- Das AI-Bulk-Fix im SEO-Dashboard („Fix with AI") — es bleibt, wo es ist, und wird nicht in den Bulk-Editor gefaltet. Beide teilen sich künftig die Digest- und Echo-Helfer, sonst nichts.
- Den Einzeleditor. Er bleibt die Oberfläche für alles Geführte (Rich-Text, Bilder, Optionsstruktur, Metaobjekt-Definitionen). Der Bulk-Editor ist die Ergänzung, nicht der Ersatz — jede Zeile behält deshalb ihren „Im Editor öffnen"-Sprung.

