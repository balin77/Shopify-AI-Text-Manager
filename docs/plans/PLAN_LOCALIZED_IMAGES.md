# Andere Bilder je Sprache — Plan

**Status:** **Geplant, nicht begonnen.** Roadmap-Einträge `localized-images` (geplant) und `image-translation` (Stufe 2, erwogen) in [roadmap.server.ts](../../app/config/roadmap.server.ts). Analyse vom 2026-09-30, gegen den Code geprüft. Plattform-Aussagen aus Shopify-Changelog und Drittquellen — **nicht gemessen**, deshalb ist Phase 0 eine Messung.

**Frage:** Kann ein Händler pro Sprache (und ggf. pro Markt) andere Bilder zeigen, wie es die Konkurrenz anbietet? Und später: kann die KI den Text in einem Bild übersetzen und ein neues Bild erzeugen?

**Antwort:** Ja, in zwei Hälften mit unterschiedlicher Plattform-Unterstützung.

---

## 1. Was Shopify nativ kann

| Bildtyp | Pro Sprache nativ? | Quelle / Status |
|---|---|---|
| Theme-Bilder (`image_picker` in Sektionen, JSON-Templates) | **Ja**, pro Sprache **und** pro Markt, über `translationsRegister`; Wert `shopify://shop_images/<datei>` | Shopify-Changelog „Online store media localizable to different languages/markets“ — **nicht gemessen** |
| Produktmedien / Galerie | **Nein** | `MediaImage` trägt nur den Schlüssel `alt` (gemessen, siehe CLAUDE.md „Image rows“); Translate & Adapt kann es ebenfalls nicht |
| Kollektions-/Artikelbild | **Nein**, nur `alt` | gemessen 2026-08 (CLAUDE.md) |
| `file_reference`-Metafelder | Laut Drittquellen **nein** (nur Text-Metafelder) | widersprüchliche Quellen — **messen** |

Die Konkurrenz (EZ Product Image Translate, LangShop, Transcy) tauscht Produktbilder im Storefront per Script aus.

## 2. Ist-Zustand im Code

- **Theme-Sync** ([background-sync.service.ts](../../app/services/background-sync.service.ts)) liest alle übersetzbaren Theme-Schlüssel ohne Filter nach Werttyp. Bildwerte, falls Shopify sie liefert, landen als normale Textfelder im Theme-Editor.
- **Mögliches Risiko heute:** [templates-translate-all.action.ts](../../app/actions/templates/templates-translate-all.action.ts) schickt jeden nicht-leeren Wert an die KI. `survivesValuePrompt` lässt eine `shopify://…`-URL durch. Liefert Shopify Bildwerte als übersetzbare Schlüssel, würde „Alles übersetzen“ Bildreferenzen von der KI umschreiben lassen. **In Phase 0 prüfen, ggf. sofort absichern.**
- **Resolver-Vorlage:** [app.seo.structured-data.tsx](../../app/routes/app.seo.structured-data.tsx) löst `shopify://shop_images/<datei>` (Logo) zu einer Datei auf.
- **Dateiauswahl:** `FilePickerModal` (Bibliothek + Staged Upload), wiederverwendet von `MetaobjectFileField`.
- **Storefront-Galerie:** [variant-gallery-embed.liquid](../../extensions/storefront/blocks/variant-gallery-embed.liquid) + `assets/variant-gallery-embed.js` blendet die native Galerie aus und rendert eine eigene, auch beim Variantenwechsel. Die Galerie verzweigt heute nicht nach Sprache.
- **`og:image` und JSON-LD** kommen aus unseren Blöcken (`social-meta.liquid`, `structured-data.liquid`).
- **Bildgenerierung:** keine im Code. Nur die Alt-Text-Vision (`generateImageAltText`, `vision-policy.shared.ts`). Roadmap: `image-generation`, `ad-suite` — eine gemeinsame Plumbing, eigener Key des Händlers, Anbieter austauschbar.
- **Scopes:** `read_files`/`write_files`, Metaobjekt-Definitionen und Metafelder sind vorhanden. **Keine neue Berechtigung, keine erneute Zustimmung nötig.**

## 3. Phasen

### Phase 0 — Messen (Probe unter Settings → Probes → Translation)

1. Kommen `image_picker`-Werte aus Sektionen und JSON-Templates als übersetzbare Schlüssel? In welchem Wertformat, mit welchem Schlüssel-Muster?
2. Wird `translationsRegister` mit einem anderen `shopify://shop_images/…` angenommen, per Echo bestätigt und im Storefront ausgeliefert? Auch mit `marketId`?
3. Ist ein `file_reference`-Metafeld übersetzbar (mit gefülltem Wert messen — Leerwert-Falle)?
4. Falls (1) ja: KI-Sperre für Bildwerte in allen Theme-Übersetzungspfaden (translate-all, translate-field, stale repair via `survivesValuePrompt`) sofort einbauen.

### Phase 1a — Theme-Bilder pro Sprache (nativ)

- Bildwerte im Theme-Editor erkennen und als Vorschaubild mit „Bild für diese Sprache wählen / zurücksetzen“ darstellen statt als Textbox.
- Schreiben über den bestehenden Theme-Speicherpfad, Echo-Regel, DB-Spiegel in `ThemeTranslation`.
- Nie an die KI.
- Markt-Ebene wie bei Theme-Texten.

### Phase 1b — Produktbilder pro Sprache (über unsere Galerie)

- **Datenmodell:** App-eigener Metaobjekt-Typ „lokalisiertes Bild“ mit Sprache, optionalem Markt, Originalmedium, Ersatzbild (`file_reference`), **Herkunft** (manuell/KI) und **Quell-Stempel** (Originaldatei + Stand). Referenziert vom Produkt über ein Metafeld. Liquid bekommt das Ersatzbild als echtes Bildobjekt, sodass `image_url` mit den bestehenden Breiten funktioniert.
- **Storefront:** Die JSON-Datenbasis der Galerie wird nach `request.locale` (und ggf. Markt) umgeschrieben. Logik in `assets/`, nicht in `blocks/` — das Liquid-Budget von 100 KiB ist knapp.
- **Server-seitig:** `og:image` und JSON-LD-Produktbild nutzen das Sprachbild. Reines Liquid, ohne Flackern, gut für SEO — ein Vorteil gegenüber reinem JS-Tausch.
- **Image Manager:** pro Bild ein Sprach-Umschalter, Ersatzbild hochladen/wählen, Übersicht „Sprache X: n Ersatzbilder“.
- **Grenzen offen benennen:** Kanal-Feeds (Google, Shop-App, KI-Kanäle) zeigen weiter das Originalbild. Wirkt nur mit aktivem App-Embed.

### Phase 2 — KI-Bildübersetzung (`image-translation`, mit der Bildgenerierung)

1. Vision-Vorprüfung: Ist überhaupt Text im Bild? Nur dann anbieten.
2. Bild-Edit mit Zielsprache und Glossar.
3. Vorschau, **Freigabe durch den Händler**. Nie unbeaufsichtigt: Preise, Größen, Logos und Rechtstexte im Bild sind genau das, was ein Modell falsch macht.
4. Staged Upload, als Ersatzbild der Sprache eintragen (`origin: ai`).
5. Wird das Original ersetzt, gilt das übersetzte Bild über den Quell-Stempel als veraltet.

## 4. Offene Entscheidungen (Owner)

1. Ersatzbilder nur pro Sprache oder auch pro Markt?
2. Tausch nur in der Produktgalerie, oder auch in Kollektionskacheln, Suche und Warenkorb (dort nur per JS über den Dateinamen: fragil, Flackern)?
3. Nur 1:1-Ersatz, oder dürfen Sprachen Bilder ausblenden bzw. zusätzliche bekommen?
4. Plan-Zuordnung (welcher Tarif, Mengenbegrenzung wie bei der Konkurrenz?).

## 5. Quellen

- Shopify Changelog: Online store media localizable to different languages/markets — https://shopify.dev/changelog/online-store-media-localizable-to-different-languages-markets
- Übersetzbare Section-Setting-Typen (inkl. `image_picker`) — https://joeybabcock.me/blog/shopify/shopify-translate-adapt-which-input-types-are-translatable/
- Translate & Adapt übersetzt keine Produktbilder — https://newcraft.dev/posts/shopify-translate-adapt-doesnt-translate-images-heres-what-does/
- Weglot: Grenzen von Translate & Adapt — https://www.weglot.com/blog/shopify-translate-adapt-limitations
- EZ Product Image Translate — https://apps.shopify.com/ez-product-image-translate
