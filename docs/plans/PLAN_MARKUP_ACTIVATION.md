# Markup-Auslieferung: erst messen, dann aktivieren — Plan (Phasen 1–3)

**Status:** Phasen 1 und 2 offen. **§3.3 ist vorab umgesetzt** (2026-08-18): der dreifach kopierte Video-URL-Parser liegt jetzt in einem gemeinsamen Snippet, was nebenbei einen Bug behoben und 1,9 KiB Budget freigemacht hat. Der Ist-Zustand unten ist gegen den Code UND gegen einen Live-Shop (`patis-universe.com`) verifiziert.

**Ziel:** `/app/seo/structured-data` soll einen Händler nicht mehr in eine Doppelaktivierung laufen lassen können. Heute steht die Aktivierung ganz oben und die Analyse darunter — also in der Reihenfolge, in der man den Fehler macht, bevor man ihn sehen kann.

**Auslöser (gemessen, nicht vermutet):** Am 2026-08-18 wurde auf `patis-universe.com` das Häkchen „Product (product pages)" gesetzt, während das Theme sein eigenes Produkt-Markup weiter auslieferte. Ergebnis im Rich Results Test: **12 ungültige Elemente** — eines pro Variante. Ursache war keine Regression, sondern die identische `@id`.

---

## 0. Ist-Zustand

### 0.1 Was die Sektion heute ist

[app.seo.structured-data.tsx](../../app/routes/app.seo.structured-data.tsx) (984 Zeilen) rendert von oben nach unten:

1. eine **Aktivierungs-Card** mit zwei Schaltflächen ([:580-604](../../app/routes/app.seo.structured-data.tsx#L580-L604)) — JSON-LD-Embed und Open Graph, beide über `openEmbedSettings` nach `/app/settings?tab=setup` ([:446-447](../../app/routes/app.seo.structured-data.tsx#L446-L447))
2. zwei `StepTile`s ([:611-627](../../app/routes/app.seo.structured-data.tsx#L611-L627)) — Schritt 1 „Auslieferung" (was die Storefront wirklich serviert) und Schritt 2 „Datenqualität"
3. den Inhalt des gewählten Schritts

Die Reihenfolge ist damit **Aktivieren → Messen**. Der Kommentar bei den Tiles benennt die richtige Reihenfolge bereits („markup has to reach the page before its data quality means anything"), zieht die Aktivierung aber nicht mit hinein.

### 0.2 Was der Crawl heute schon misst — mehr als erwartet

Das ist die gute Nachricht: Die Messmechanik existiert und ist sauber gebaut.

- `SeoCrawlPage.jsonLdTypes` — alle `@type`-Werte, **Wiederholungen erhalten** („Product,Product" = zwei Blöcke). Genau das macht Doppel-Markup überhaupt erkennbar.
- `SeoCrawlPage.jsonLdAppTypes` — die Teilmenge, die **unser** Block emittiert hat, erkannt am `data-contentpilot`-Attribut ([crawl.service.ts:644-646](../../app/services/seo/crawl.service.ts#L644-L646)). Ein Data-Attribut ist für JSON-LD-Konsumenten inert, kostet also nichts und beantwortet die eine Frage, die das ausgelieferte HTML sonst nicht beantwortet: **welche der doppelten Kopien ist unsere.**
- [json-ld-audit.service.ts](../../app/services/seo/json-ld-audit.service.ts) liefert bereits `duplicates` mit `appIsOneCopy` ([:383-395](../../app/services/seo/json-ld-audit.service.ts#L383-L395)) — die Zahl der Seiten, auf denen **wir** eine der Kopien sind. Der Kommentar dort trifft den Kern: Wo wir *nicht* beteiligt sind, würde „schalte unseren Schalter aus" nicht helfen und wäre der falsche Rat.
- `notMeasured` ([:547](../../app/services/seo/json-ld-audit.service.ts#L547)) und `appEmbedDetected: boolean | null` unterscheiden „nichts gefunden" von „konnte nichts finden".

**Fazit:** Die Analyse kann die Frage bereits beantworten. Sie **zieht daraus nur keine Empfehlung**, und sie steht an der falschen Stelle der Seite.

### 0.3 Was komplett fehlt: Open Graph / Twitter Cards

`SeoCrawlPage` hat **keine** Spalte für `og:*` oder `twitter:*`, und [crawl.service.ts](../../app/services/seo/crawl.service.ts) parst sie nicht. Für Social-Meta gibt es damit weder eine Auslieferungs- noch eine Doppelerkennung — obwohl [social-meta.liquid](../../extensions/storefront/blocks/social-meta.liquid) dieselbe Falle stellt: Die meisten Themes setzen `og:title`/`og:image` selbst, und zwei `og:image` auf einer Seite sind für Facebook/LinkedIn dasselbe Problem wie zwei `Product`-Knoten für Google.

Der Block emittiert `og:title`, `og:description`, `og:url`, `og:type`, `og:image` sowie `twitter:card|title|description|image` ([:62-78](../../extensions/storefront/blocks/social-meta.liquid#L62-L78)) und trägt **kein Erkennungsmerkmal** — die Entsprechung zu `data-contentpilot` fehlt.

### 0.4 Warum die Doppelaktivierung ungültiges Markup erzeugt, nicht nur doppeltes

Unser Block nutzt Dawns `@id`-Schema **absichtlich** ([structured-data.liquid:78-80](../../extensions/storefront/blocks/structured-data.liquid#L78-L80)): „so removing the theme's schema later does not change the identity of anything". Der Block ist als **Ersatz** des Theme-Schemas gedacht, nicht als Ergänzung.

Laufen beide, verschmilzt Google die Knoten über die gleiche `@id` zu **einem** Knoten — mit jedem beidseitig gelieferten Feld doppelt: gemessen `brand`, `availability`, `sku`. Das Design ist stimmig; es hat nur keinen Riegel gegen den einen Zustand, für den es nicht gedacht ist.

### 0.5 Videos, die nicht in `product.media` liegen

Der `VideoObject`-Zweig iteriert ausschließlich `product.media` ([structured-data.liquid:483](../../extensions/storefront/blocks/structured-data.liquid#L483)) und deckt dort Shopify-Videos **und** externe (`external_video` → `embedUrl`) ab.

Auf `patis-universe.com` liegt das YouTube-Video jedoch **gar nicht** in `product.media`, sondern in zwei **Varianten-Metafeldern**, die der Variant-Gallery-Block liest:

| Quelle | Form | Fundstelle |
|---|---|---|
| `variant.metafields.custom.variant_gallery`, Eintrag mit `kind == 'url'` | URL innerhalb der sortierten Galerie | [variant-gallery-embed.liquid:153-205](../../extensions/storefront/blocks/variant-gallery-embed.liquid#L153-L205) |
| `variant.metafields.custom.variant_external_videos` | `list.url`, ans Ende angehängt | [:300-330](../../extensions/storefront/blocks/variant-gallery-embed.liquid#L300-L330) |

Messung: Über **alle 41 Produkte** des Shops hat **kein einziges** ein natives `product.media`-Video. Das `VideoObject`-Feature hatte dort also null Abdeckung, bis für den Test eines hochgeladen wurde.

---

## 1. Phase 1 — Reihenfolge umdrehen und den Riegel einziehen

Reine UI-Arbeit, **keine neuen Daten nötig** — §0.2 liefert alles.

### 1.1 Aktivierung wird Schritt 3

Die Card aus §0.1 wandert unter die Schritt-Tiles und bekommt eine eigene Kachel. Neue Reihenfolge: **1 Auslieferung → 2 Datenqualität → 3 Aktivieren**. Die drei Tiles rücken damit in dieselbe Form, die die AEO-Sektion schon nutzt.

### 1.2 Der Riegel

Schritt 3 bewertet pro Schalter, was Schritt 1 gemessen hat:

| Zustand aus Schritt 1 | Anzeige in Schritt 3 |
|---|---|
| Typ wird **nicht** ausgeliefert | grün, „kann aktiviert werden" |
| Typ wird ausgeliefert, `appIsOneCopy == 0` | **rote Warnung**: Dein Theme liefert das bereits. Aktivieren erzeugt doppeltes Markup. |
| Typ doppelt, `appIsOneCopy > 0` | **rote Warnung mit Handlung**: Wir sind eine der Kopien — Schalter ausschalten behebt es. |
| `notMeasured` / kein Crawl | grau, „erst Schritt 1 ausführen" — **niemals** grün |

Die dritte Zeile ist die, die man leicht falsch baut: Wo wir *nicht* beteiligt sind, darf die Empfehlung **nicht** „schalte unseren Schalter aus" lauten. `appIsOneCopy` existiert genau dafür und trägt den Kommentar bereits.

Die vierte Zeile ist die Kernregel des Repos, hier erneut: **eine fehlende Messung ist kein Freibrief.** Ohne Crawl gibt es keine Empfehlung, nur die Aufforderung, Schritt 1 zu fahren.

### 1.3 Warnung am Schalter selbst

Der Info-Text von `enable_product` ([structured-data.liquid:656](../../extensions/storefront/blocks/structured-data.liquid#L656)) spricht heute ausschließlich über `priceValidUntil`. Er bekommt einen führenden Satz, dass die meisten Themes Produkt-Markup selbst ausliefern und beides zusammen ungültiges Markup erzeugt.

**Offene Produktentscheidung:** ob `enable_product` seinen Default von `true` auf `false` zieht. Das ändert bestehende Installationen und gehört nicht nebenbei entschieden — **im Zweifel nein**, und stattdessen der Riegel aus §1.2.

**Aufwand:** UI + i18n in drei Sprachen (`de`/`en`/`es`, je ~4390 Zeilen). Kein Schema, kein Crawl, keine Migration.

---

## 2. Phase 2 — Open Graph / Twitter in dieselbe Messung

### 2.1 Neue Spalten auf `SeoCrawlPage`

Streng nach dem Vorbild von `metaRobots`/`indexabilityKnown`, das die Regel im Repo bereits gesetzt hat:

```
ogTags       String  @default("")   // gefundene og:*-Properties, Wiederholungen ERHALTEN
twitterTags  String  @default("")   // dito für twitter:*
ogAppTags    String  @default("")   // Teilmenge, die UNSER Block gesetzt hat
socialKnown  Boolean @default(false)
```

`socialKnown` ist nicht optional: `""` bedeutet sonst zwei nicht unterscheidbare Dinge — nichts ausgeliefert **oder** Zeile vor Einführung der Spalte geschrieben. Genau die Falle, die CLAUDE.md für `metaRobots`, `jsonLdTypes` und `translatableContent` bereits dreimal dokumentiert.

Wiederholungen müssen **erhalten** bleiben, sonst ist Doppelung nicht erkennbar — dieselbe Begründung wie bei `jsonLdTypes`.

### 2.2 Extraktion

Eine Funktion neben `extractJsonLdTypes` in [crawl.service.ts](../../app/services/seo/crawl.service.ts), gesetzt in derselben Zeile wie `record.jsonLdTypes` ([:1703](../../app/services/seo/crawl.service.ts#L1703)).

### 2.3 Unseren Block markierbar machen

`social-meta.liquid` bekommt `data-contentpilot="og"` auf jedes emittierte `<meta>`. `data-*` ist auf `<meta>` valides HTML und für jeden Konsumenten inert — dieselbe Begründung wie beim JSON-LD-Marker, und es ist die einzige Möglichkeit, „welche Kopie ist unsere" zu beantworten.

**Randbedingung:** Solange ein Shop eine ältere Version des Blocks ausliefert, ist die Markierung leer. Das ist **unbekannt**, nicht „aus" — exakt die Lesart, die `appEmbedDetected: boolean | null` schon vorgibt.

### 2.4 Audit + UI

Ein `social-audit.service.ts` in der Form von `json-ld-audit.service.ts` (`typeCounts`, `duplicates` mit `appIsOneCopy`, `notMeasured`). Schritt 1 und 2 zeigen JSON-LD und Social nebeneinander; Schritt 3 riegelt den OG-Schalter nach denselben vier Regeln aus §1.2 ab.

**Aufwand:** Migration + Crawl + Service + UI + i18n×3. Die größte der drei Phasen.

---

## 3. Phase 3 — Externe Videos ins JSON-LD

### 3.1 Was dazukommt

`VideoObject` liest zusätzlich die beiden Metafelder aus §0.5. Weil beide **pro Variante** liegen, muss über `product.variants` iteriert und **produktweit dedupliziert** werden: Dieselbe YouTube-URL hängt typischerweise an mehreren Varianten, und pro Variante ein `VideoObject` wäre exakt das Doppel-Markup, gegen das Phase 1 antritt. Der Gallery-Block dedupliziert bereits über ein `cp_seen_urls`-Set — dieselbe Technik.

### 3.2 Das `uploadDate`-Problem, das nicht lösbar ist

Ein URL-Eintrag hat **keinen `File`-Record** und damit kein `File.createdAt`. Der ganze Sync-Pfad über `custom.video_upload_dates` greift für diese Videos **nicht**.

Damit bleibt nur der Merchant-Override `custom.video_upload_date`. Fehlt er, wird `uploadDate` **weggelassen** — nicht geschätzt. Das ist Invariante 3 des Blocks („Nothing in this entity may be INVENTED") und die Lehre aus `priceValidUntil`. Ein YouTube-Video hat zwar ein öffentliches Veröffentlichungsdatum, aber das steht nur über die YouTube-Data-API zur Verfügung — eigener Provider, eigener Key, eigene Quota. **Ausdrückliches Nicht-Ziel dieses Plans.**

Folge, die in die UI gehört: Für Gallery-Videos ist das Video-Rich-Result ohne manuell gesetztes Datum nicht vollständig.

### 3.3 Die Budget-Frage — erledigt, vorab umgesetzt (2026-08-18)

Der URL→Host/ID-Parser (youtube watch / youtu.be / embed / shorts / vimeo) existierte in `variant-gallery-embed.liquid` **dreimal**. Beim Zusammenlegen kam heraus, dass die Kopien bereits **auseinandergelaufen** waren: zwei behandelten `youtube.com/embed/` und `youtube.com/shorts/`, die dritte — der Pfad fuer `custom.variant_external_videos` — nicht. Eine Shorts-URL wurde dort **stillschweigend verworfen**. Das war kein Aufraeumen mehr, sondern ein Bugfix.

Ergebnis:

- **`snippets/` funktioniert.** Theme-App-Extensions akzeptieren das Verzeichnis; `contentpilot-ai-dev-99` ist damit sauber released. Der Parser lebt jetzt in [snippets/cp-external-video.liquid](../../extensions/storefront/snippets/cp-external-video.liquid), die drei Aufrufstellen rendern ihn.
- **`{% render %}` ist scope-isoliert** — ein Snippet kann nichts an den Aufrufer zurueckschreiben. Die Antwort reist deshalb als gedruckter Text `"<host>|<id>"`, den der Aufrufer per `capture` einsammelt und splittet. Das `| strip` danach ist Pflicht: `capture` behaelt jedes Whitespace-Byte, und eine ID mit fuehrendem Zeilenumbruch baut eine kaputte Embed-URL.
- **Der Budget-Check zaehlt Snippets mit.** [minify-liquid-blocks.mjs](../../scripts/minify-liquid-blocks.mjs) scannte nur `blocks/`; ohne die Erweiterung haette er "passt" gemeldet, waehrend der Deploy am Limit scheitert. Er scannt jetzt `LIQUID_DIRS` und weist die Dateien als `blocks/…` bzw. `snippets/…` aus.
- **Budget:** 94,3 → **92,4 KiB**, Reserve 5,7 → **7,6 KiB**. Netto ~1,9 KiB gewonnen, trotz Erklaerkopf im Snippet.

Damit ist Phase 3 die Erweiterung um die Metafeld-Quellen (§3.1) plus die Auslassung des Datums (§3.2) — der teure Teil ist weg.

**Offen:** Der Parser-Pfad ist zur Laufzeit **nicht** verifiziert. Nach dem Refactor rendert die Galerie-Insel fehlerfrei (12 Varianten, 50 Eintraege, valides JSON), aber der Shop hat derzeit **keine** externe Video-URL mehr, seit das YouTube-Video fuer den VideoObject-Test entfernt wurde. Der Beweis braucht eine wieder eingetragene URL.

## 4. Reihenfolge und Nicht-Ziele

**Reihenfolge:** Phase 1 zuerst — sie verhindert den bereits eingetretenen Schaden, braucht keine Migration und ist in sich fertig. Danach Phase 3 vor Phase 2, wenn die Video-Abdeckung wichtiger ist als die OG-Doppelerkennung; sonst 2 vor 3.

**Nicht-Ziele:**

- **Kein Eingriff in den Theme-Code.** Das Produkt-Schema des Themes abzuschalten bleibt eine Handlung des Händlers im Theme-Editor. Die App benennt den Konflikt, sie löst ihn nicht durch fremden Code.
- **Kein automatisches Umschalten unserer eigenen Blöcke** aufgrund eines Crawl-Befunds. Der Befund empfiehlt; der Händler entscheidet.
- **Kein geschätztes `uploadDate`** (§3.2).
- **Keine YouTube-Data-API** in diesem Plan.
- **`enable_product`-Default bleibt vorerst `true`** (§1.3), solange nicht ausdrücklich anders entschieden.
