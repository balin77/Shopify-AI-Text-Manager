# Markup-Auslieferung: erst messen, dann aktivieren — Plan (Phasen 1–3)

**Status:** **Alle drei Phasen umgesetzt** (2026-08-18). §3.3 lag vorab schon fertig (der dreifach kopierte Video-URL-Parser liegt jetzt in einem gemeinsamen Snippet, was nebenbei einen Bug behoben und 1,9 KiB Budget freigemacht hat). Der Ist-Zustand unten beschreibt den Stand VOR der Umsetzung und ist gegen den Code UND gegen einen Live-Shop (`patis-universe.com`) verifiziert; er bleibt als Begründung stehen. Was tatsächlich gebaut wurde, steht in §5.

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


---

## 5. Was umgesetzt wurde (2026-08-18)

Drei Commits, in der Reihenfolge des Plans.

### 5.1 Phase 1

- Die Aktivierungs-Card ist die **dritte Step-Kachel** geworden: 1 Auslieferung → 2 Datenqualität → 3 Aktivieren. Dieselbe Form wie die drei Schritte der AEO-Sektion.
- Der Riegel liegt in [markup-activation.shared.ts](../../app/services/seo/markup-activation.shared.ts) — rein und client-safe, damit er in Component-Scope laufen kann, ohne Prisma ins Client-Bundle zu ziehen.
- `summarizeLiveJsonLd` liefert dafür `typeStats` je **kanonischem** Typ (Seiten, App-Seiten, Doppel-Seiten, `appIsOneCopy`, `repeatable`). Die beiden Schleifen über die Crawl-Zeilen sind dabei zu einer geworden.
- Aus den vier Zeilen der Tabelle in §1.2 sind **neun Urteile** geworden. Die vier des Plans sind alle darunter; die fünf zusätzlichen sind Zustände, die die Tabelle zusammenfasst, obwohl sie verschiedene Ratschläge verlangen:
  - `appOnly` — ausgeliefert, jede Kopie unsere, keine Doppelung. Der Zielzustand, und nicht dasselbe wie „wird ausgeliefert, also Warnung".
  - `mixed` — auf manchen Seiten unsere, auf anderen die des Themes. Kommt bei theme-vorlagenabhängigem Markup vor.
  - `originUnknown` — ein Crawl **vor** der Herkunftserkennung meldet für alles `appPages: 0`, was von „Embed ist aus" nicht zu unterscheiden ist. Das als `foreignOnly` zu zeigen wäre exakt die Verwechslung, die §1.2 Zeile 3 verbietet, nur eine Ebene tiefer.
  - `repeatableUnjudged` — für `VideoObject`/`ImageObject` schweigt die Doppelregel absichtlich (drei Produktvideos sind drei VideoObjects). Eine 0 heißt dort **„nicht geprüft"**, nicht „geprüft und sauber", und der Riegel sagt das, statt ein verifiziert aussehendes Urteil zu fällen.
  - `duplicateForeign` — die Doppelung, die unser Schalter nicht behebt.
- `enable_product` trägt den Warnsatz jetzt im Info-Text des Blocks selbst; der Kopf-Paragraph verweist auf Schritt 3.
- **Default bleibt `true`** (§1.3), wie im Plan festgelegt.

### 5.2 Phase 2

- Vier Spalten auf `SeoCrawlPage`, Migration `20260822000000_seo_crawl_social_tags`, exakt in der Form aus §2.1.
- `extractSocialTags` in [crawl.service.ts](../../app/services/seo/crawl.service.ts), aus demselben geparsten HTML wie `extractJsonLdTypes`. Zwei Entscheidungen, die der Plan offenließ: **beide Attribut-Schreibweisen** werden gelesen (OG ist auf `property=` definiert, Twitter auf `name=`, aber Themes mischen das dauernd und beides funktioniert — nach dem Attribut zu gehen hieße, ein ausgeliefertes Tag wegen einer Schreibweise als fehlend zu melden), und der **NAMESPACE** entscheidet den Bucket. Ein Tag mit leerem `content` zählt nicht als ausgeliefert.
- `data-contentpilot="og"` auf jedem Tag in [social-meta.liquid](../../extensions/storefront/blocks/social-meta.liquid).
- [social-audit.service.ts](../../app/services/seo/social-audit.service.ts) in der Form von `json-ld-audit.service.ts`.
- **Abweichung, ausdrücklich:** §2.4 verlangt „Schritt 1 und 2 zeigen JSON-LD und Social nebeneinander". Umgesetzt ist das für **Schritt 1**; Schritt 2 bleibt der Katalog-Audit und bekommt **keine** Social-Hälfte. Was in `og:title` und `og:image` landen kann, ist der SEO-Titel, die Meta-Description und das Produktbild — alle drei prüfen `analyzeStore` und der JSON-LD-Batch-Audit bereits, und zwei Bewertungen für ein Produkt in zwei Tabs helfen niemandem (dieselbe Regel, der `catalog-readiness.service.ts` folgt). Die Live-Messung in Schritt 1 beantwortet die Frage ohnehin besser als eine Cache-Schätzung.
- Die **Coverage-Tabelle** deckt `product`/`collection`/`article`/`page` ab, nicht `policy`/`unknown` — dieselbe Verengung wie auf der JSON-LD-Seite. Die **Duplikaterkennung** ist nicht verengt: ein doppeltes `og:image` auf der Startseite wird gemeldet.
- Beide Hälften tragen ihre **eigene** Gemessenheit: die Social-Spalten sind jünger, ein Snapshot kann die eine kennen und die andere nicht. Ein gemeinsames Banner würde Wissen für eine Hälfte behaupten, in die niemand geschaut hat.

### 5.3 Phase 3

- Gelesen werden `custom.variant_gallery_order` (Einträge mit `kind == 'url'`) und `custom.variant_external_videos`. Der Plan nennt in §0.5 `custom.variant_gallery`; das Metafeld mit den `{kind, value}`-Einträgen heißt tatsächlich `variant_gallery_order` (`variant_gallery` ist die `list.file_reference`-Galerie daneben).
- Beide Quellen fließen zuerst in **einen** url-kodierten, kommagetrennten String und werden von **einer** Schleife ausgegeben. Zwei Ausgabe-Rümpfe für zwei Quellen sind genau der Weg, auf dem der URL-Parser dreimal existierte und dann auseinanderlief (§3.3).
- Dedupliziert wird produktweit über **`"<host>|<id>"`**, nicht über die URL: dasselbe Video kommt als watch-Link, als `youtu.be`-Kurzlink und als natives `external_video` an. Der Dedup-Satz umfasst auch die nativen `product.media`-Videos, sonst würde ein Video, das in beiden liegt, zweimal ausgezeichnet — das doppelte Markup, gegen das Phase 1 antritt.
- `uploadDate` kommt ausschließlich aus `custom.video_upload_date` und wird sonst **weggelassen** (§3.2). Die YouTube-Data-API bleibt Nicht-Ziel.
- **Vimeo-Galerie-Links drucken gar nichts.** Das Rich Result braucht `thumbnailUrl`, und aus einem Vimeo-Link lässt sich keines ableiten; das Produktbild einzusetzen hieße, „wie sieht dieses Video aus" mit einem Bild von etwas anderem zu beantworten — Invariante 3. Der Galerie-Block selbst kommt an derselben Stelle zum selben Schluss.
- **§3.3 „Offen" ist damit erledigt:** der Parser-Pfad ist gegengeprüft, wenn auch nicht auf dem Live-Shop, sondern mit einem `liquidjs`-Render außerhalb des Repos. Geprüft: watch-, `youtu.be`- und `shorts`-Schreibweise derselben ID auf zwei Varianten ergeben **ein** VideoObject; ein natives `external_video` derselben ID unterdrückt den Galerie-Eintrag; ein zweites Video kommt eigenständig durch; Vimeo fällt raus; der Merchant-Override landet in beiden Blöcken; das JSON ist valide. Was weiterhin **unbestätigt** ist: dass Google die Galerie-Videos ohne `uploadDate` überhaupt als Rich Result akzeptiert (die Eigenschaft ist als REQUIRED geführt) — der Plan sagt bewusst, dass das Datum dann fehlt, nicht, dass das Ergebnis vollständig bleibt.

### 5.4 Was der Review-Durchgang gefunden hat

Ein unabhängiger Review-Agent über den Diff hat zwei ernste Fehler gefunden, beide vom selben Typ — und beide genau der, gegen den dieser Plan antritt:

1. **Ein Crawl ohne gemessene Seite meldete grünes Licht.** `notMeasured` war eine LEERE-Prüfung (`served.length > 0 && served.every(leer)`), keine WISSENS-Prüfung. Zwei erreichbare Eingaben machten daraus „nichts wird ausgeliefert, du kannst einschalten": (a) ein Crawl ohne eine einzige ausgelieferte Seite — passwortgeschützte Storefront, Wartungsmodus, Bot-Shield — bei dem die linke Bedingung `notMeasured` auf **false** setzt; (b) 2xx-Zeilen, deren Body nie geparst wurde (jenseits von `CRAWL_BFS_MAX_DEPTH`, 3xx innerhalb des 200–399-Fensters, cheerio-Fehler). Ein Shop, dessen Produktseiten tief hinter Paginierung liegen, bekam für `enable_product` „kann gefahrlos an", während das Theme es nachweislich ausliefert. Behoben über [crawl-markup-rows.server.ts](../../app/services/seo/crawl-markup-rows.server.ts): `indexabilityKnown` ist der Diskriminator (im Crawl in derselben Zeilengruppe gesetzt wie `jsonLdTypes` und `socialKnown`, und die älteste der drei Flags, deckt also die meisten Snapshots ab), gewertet wird nur über geparste Zeilen, und `notMeasured` fängt jetzt auch die leere Menge.
2. **Bei ausgeschaltetem Embed — dem Zustand jedes Händlers, der gerade einschalten will — kam die Warnung aus §1.2 Zeile 2 nie.** `appEmbedDetected` ist nur dann `true`, wenn irgendeine Seite das Merkmal trug; ist das Embed aus, kann keine es tragen, also ist `originKnown` dauerhaft falsch und jeder theme-ausgelieferte Typ landete auf `originUnknown` statt `foreignOnly` — mit Ton `info` und einem Rat („starte einen neuen Crawl"), den kein Crawl einlösen kann. Genau der Händler aus der Auslöser-Geschichte dieses Plans sah damit den mildesten Zustand. Behoben, ohne etwas zu behaupten, was die Daten nicht hergeben: `originUnknown` nennt jetzt **beide** Ursachen und gibt den Schluss, der unter beiden gilt („nicht neu einschalten; ist er schon an, ändere nichts vor dem nächsten Crawl"), und rangiert so laut wie eine echte Warnung.

Dazu fünf kleinere:

3. **`FAQPage` bekam ein falsches `foreignOnly`.** Die Statistik war shop-weit, die Blöcke sind seiten-scoped: unser `FAQPage` liegt nur auf Produktseiten, das `FAQPage` eines Themes auf `/pages/faq` — zwei Markups, die sich nie begegnen. Die Statistik ist jetzt nach (kanonischem Typ, `resourceType`) gebucketet, und jeder Schalter deklariert seine `scopes`, gespiegelt aus den `request.page_type`-Guards des Blocks. Betraf auch `enable_breadcrumb`.
4. **Die Schritt-1-Kachel nannte „nie gemessen" = „Lücken".** Die Social-Spalten kommen mit dieser Version, also wäre bei JEDEM installierten Shop die sichtbarste Kachel der Seite auf ein Warnschild mit dem Text „Lücken" gesprungen — ein Falschbefund. Eigener Zustand `badgePartlyMeasured`.
5. **Zwei Snapshot-Lookups und zwei volle Zeilen-Scans**, bei einem Kommentar, der das Gegenteil behauptete. Beide Hälften lesen jetzt durch `loadCrawlMarkupPages`; das schließt auch die Lücke, dass ein zwischen beiden Abfragen fertig gewordener Crawl zwei Berichte über zwei Läufe nebeneinander gestellt hätte.
6. Eine tote Union-Schleife in `summarizeLiveJsonLd` und eine doppelt geführte Map in `social-audit.service.ts` — beide entfernt.
7. Der Test `guards the uploadDate emission` pinnte „genau eine Zeile" und war an Phase 3 rot geworden; die Behauptung „Tests grün" in einer früheren Fassung dieses Abschnitts stimmte für keinen der drei Commits. Behoben in `63e91c9`, zusammen mit vier neuen Regeln für den Galerie-Pfad.

**Offen gelassen, bewusst:** Der Reviewer empfiehlt, die Galerie-`VideoObject`s nur bei gesetztem `custom.video_upload_date` auszugeben, weil `uploadDate` bei Google REQUIRED ist und ein Eintrag ohne Datum in der Search Console als Fehler erscheint — auf einem Schalter, der `default: true` ist. Das Argument ist gut (§0.4s eigene Lehre lautet: ungültiges Markup ist schlimmer als keines), widerspricht aber §3.2 dieses Plans ausdrücklich, der das Weglassen des Datums als akzeptierte Folge beschreibt. Die Umsetzung folgt dem Plan; die Änderung wäre eine Zeile (`{%- if v_upload_override != blank -%}` um die Galerie-Ausgabe) und gehört entschieden, nicht nebenbei gemacht.

### 5.5 Budget und Prüfungen

- Extension-Liquid: 90,9 → **94,2 KiB** von 100 (Ziel < 96), Reserve 5,8 KiB. Die drei Phasen haben zusammen ~3,3 KiB gekostet, davon der größte Teil die Phase-3-Ausgabe.
- `npm run typecheck` und `npm run test` grün (3085 Tests); 42 neue Tests in [markup-activation.shared.test.ts](../../tests/unit/markup-activation.shared.test.ts), [seo-social-audit.service.test.ts](../../tests/unit/seo-social-audit.service.test.ts) und `seo-json-ld-audit.service.test.ts`.
