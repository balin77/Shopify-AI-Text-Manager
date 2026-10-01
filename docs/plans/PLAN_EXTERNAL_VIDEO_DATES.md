# Datum für Videos aus externen Quellen — Plan (optional, nicht beschlossen)

**Status:** **Optional.** Nichts davon ist umgesetzt oder zugesagt. Der Ist-Zustand unten ist am 2026-08-19 gegen den Code verifiziert.

**Frage, die dieser Plan beantwortet:** Kann ein Händler das Upload-Datum eines verlinkten Videos (YouTube in einer Varianten-Galerie) in der App setzen, statt ein Metafeld zu suchen, das er nie findet?

**Antwort:** Ja — aber nicht über das Metafeld, das dafür naheliegt. Der naheliegende Weg zerstört Daten. §1 ist der Grund, warum dieser Plan existiert; §2 ist der Vorschlag.

**Heutiger Stand ohne diesen Plan:** Die Oberfläche nennt kein Metafeld mehr. Sie stellt fest, dass Videos aus externen Quellen **ohne Datum ausgeliefert werden** und Google sie deshalb unter Umständen nicht als Rich Result akzeptiert. Das ist ehrlich und vollständig — dieser Plan ist eine Verbesserung, keine Reparatur.

---

## 0. Ist-Zustand

### 0.1 Die drei Datenquellen für `uploadDate`

| Quelle | Besitzer | Schlüssel | Gilt für |
|---|---|---|---|
| `custom.video_upload_dates` | **App** (Produkt-Sync) | numerische Media-ID | Videos in `product.media` |
| `custom.video_upload_date` | Händler | — | **produktweit, überschreibt alles** |
| — | — | — | **verlinkte Videos: gar nichts** |

Der Sync schreibt die erste Map aus `File.createdAt` ([video-schema.shared.ts](../../app/services/seo/video-schema.shared.ts)), diff-gesteuert gegen den Spiegel `Product.videoSchemaJson`. Der Block liest Override zuerst, dann die Map, und lässt die Property sonst weg — nie geraten ([structured-data.liquid](../../extensions/storefront/blocks/structured-data.liquid), Invariante 3).

Ein Galerie-Eintrag ist eine **URL**. Es gibt keine Datei bei Shopify, also kein `File.createdAt`, also keine automatische Quelle. Das ist keine Lücke in der Umsetzung, sondern eine Eigenschaft des Datenmodells.

### 0.2 Wo die Links heute gepflegt werden

Der Image Manager verwaltet sie bereits — `custom.variant_external_videos` (`list.url`) und die URL-Einträge in `custom.variant_gallery_order`, geschrieben über [api.update-variant-galleries.tsx](../../app/routes/api.update-variant-galleries.tsx). Ein Datumsfeld an der Video-Kachel wäre also kein neuer Ort, sondern derselbe.

---

## 1. Warum der naheliegende Weg ausscheidet

`custom.video_upload_date` ist **produktweit**. Ein „Datum setzen"-Feld, das dieses Metafeld schreibt, ersetzt bei einem Produkt mit drei hochgeladenen Videos und einem YouTube-Link **drei exakte `File.createdAt`-Zeitstempel durch ein geschätztes Datum**.

Das ist kein hypothetisches Risiko: Der Galerie-Befund zählt Medien- und Galerie-Videos genau deshalb getrennt, und [gallery-video-audit.server.ts](../../app/services/seo/gallery-video-audit.server.ts) trägt die Warnung im Code — der Befund meldet ein Medien-Video bewusst **nicht** als „Datum fehlt", weil der Händler sonst zu genau dieser Zerstörung gedrängt würde.

**Ein Feld, das ein Datum setzt, muss deshalb genau ein Video treffen.**

---

## 2. Vorschlag: ein Datum pro Video, in einem eigenen Metafeld

### 2.1 Speicher

Ein neues Produkt-Metafeld `custom.video_upload_dates_manual` (`json`), das der Sync **nie** anfasst:

```
{ "youtube|cIXm3rlFSXg": "2026-05-03" }
```

Der Block liest für ein Galerie-Video dann: produktweiter Override → manuelle Map → weglassen. Für ein Medien-Video unverändert: Override → App-Map → weglassen.

**Warum ein getrenntes Metafeld und keine gemeinsame Map.** Der Sync schreibt `video_upload_dates` diff-gesteuert gegen `Product.videoSchemaJson` und baut sie ausschließlich aus den Medien. Ein Händler-Eintrag dort wäre beim nächsten Sync weg. Ein Merge ginge, kostet aber pro Produkt einen zusätzlichen Lesevorgang und macht die Diff-Logik fehleranfällig — zwei Metafelder mit klarem Besitzer können nicht kollidieren.

**Warum `host|id` als Schlüssel und keine indexparallele Liste.** `host|id` ist die Form, mit der der Block ohnehin dedupliziert. Damit ist derselbe Link an zwölf Varianten *ein* Video mit *einem* Datum, und es spielt keine Rolle, ob er aus `variant_external_videos` oder aus `variant_gallery_order` stammt. Eine indexparallele Liste nach dem Vorbild von `variant_3d_previews` leistet beides nicht: sie bricht beim Umsortieren und deckt nur eine der zwei Quellen ab.

### 2.2 Format

Metafeld-Typ `date` (kein `date_time`): im Admin handhabbar, und der Block hängt wie beim produktweiten Override `T12:00:00Z` an. Mittag UTC ist der einzige Stempel, der in jeder realen Zeitzone auf dem gewählten Tag landet — Mitternacht läse sich westlich von Greenwich als Vortag und gäbe damit eine Händlerangabe falsch wieder.

Da die Map ein `json`-Metafeld ist, steht dort ein `YYYY-MM-DD`-String; die Zeit hängt der Block an, nicht der Speicher.

### 2.3 Was zu bauen ist

1. **Metafeld-Definition** in [api.product-variants.tsx](../../app/routes/api.product-variants.tsx), wo die anderen schon angelegt werden.
2. **UI**: Datumsfeld an der Video-Kachel im [VariantImageManager](../../app/components/image-manager/VariantImageManager.tsx), gespeichert über den bestehenden Galerie-Save.
3. **Block**: eine zweite Lookup-Zeile im Galerie-Zweig. Budget unkritisch — der Block passt derzeit „mit Reserve".
4. **Audit**: [gallery-video-audit.server.ts](../../app/services/seo/gallery-video-audit.server.ts) muss die manuelle Map mitlesen, sonst meldet der Befund weiter etwas, das der Händler gerade gesetzt hat.
5. Tests und i18n×3.

### 2.4 Reihenfolge

Audit zuletzt, aber **im selben Release**: ein Datumsfeld, dessen Wirkung der Befund nicht sieht, erzeugt genau die Verwirrung, die dieser Plan beseitigen soll.

---

## 3. Nicht-Ziele

- **Kein Vorbelegen aus der YouTube-Data-API.** Das öffentliche Veröffentlichungsdatum wäre der richtige Wert, ist aber nur über einen eigenen Provider mit eigenem Key und eigener Quota erreichbar. Bleibt Nicht-Ziel, wie schon in [PLAN_MARKUP_ACTIVATION.md](PLAN_MARKUP_ACTIVATION.md) §3.2.
- **Kein geschätztes Datum.** Weder „heute" noch das Anlagedatum des Produkts. Invariante 3 des Blocks gilt unverändert: nichts in dieser Entität wird erfunden.
- **Kein Ersatz für `custom.video_upload_date`.** Der produktweite Override bleibt, wo er ist, und wird vom Block weiterhin zuerst gelesen. Er wird nur nicht mehr empfohlen.
- **Kein Datum für Vimeo-Galerie-Links.** Für die emittiert der Block ohnehin nichts, weil kein Vorschaubild ableitbar ist — ein Datum änderte daran nichts.

---

## 4. Wenn dieser Plan nicht gebaut wird

Dann bleibt es beim heutigen Zustand, und der ist vertretbar: Verlinkte Videos erscheinen im JSON-LD mit `name`, `thumbnailUrl`, `description` und `embedUrl`, nur ohne `uploadDate`. Google akzeptiert das unter Umständen nicht als Rich Result — die Oberfläche sagt das, benennt die betroffenen Produkte im Befund und verspricht keine Abhilfe, die es nicht gibt.

Der Preis ist eine fehlende Funktion, kein falscher Zustand.
