# Recherche Auftrag 2 – Variantenbild-Apps

Prüfdatum: **2026-10-01**. Alle Angaben aus dem Rohtext (curl) der genannten Seiten; App-Store-Seiten jeweils mit `?locale=en` geladen. Preise in USD, Abrechnung laut App Store „every 30 days“.

## Kandidaten geprüft

Grundlage: App-Store-Kategorie „Product variants“ (https://apps.shopify.com/categories/selling-products-custom-products-product-variants/all?locale=en, 529 Apps, Seiten 1–23 per curl, 298 Karten mit Bewertungszahl ausgelesen) und „Image gallery“ (https://apps.shopify.com/categories/store-design-images-and-media-image-gallery/all?locale=en). Die Suchseite `apps.shopify.com/search?q=variant+images` liefert per curl keine Treffer („We are having trouble loading your results“) – daher Kategorien.

| App (Store-Name heute) | Bewertungen | Rang unter Apps mit Fokus „mehrere Bilder pro Variante“ |
|---|---|---|
| SA Variant Image Automator | 4.9 (766) | 1 |
| Rubik Variant Images & Swatch | 5.0 (486) | 2 |
| Variant Image Wizard + Swatch | 4.7 (224) | 3 |
| GG Product Page Image Slider | 4.8 (176) | 4 (Galerie-App, Kategorie „Image gallery“) |
| N Color Swatches Variant Image (früher „NS Color Swatch Variant Images“, NestScale) | 4.4 (143) | 5 |

Ergebnis: Alle fünf gehören weiterhin zu den größten Apps, die *mehrere Bilder pro Variante* als Kernfunktion bewerben. **Aber:** Es gibt größere Swatch-Apps mit Variantenbild-Filter, die NS, GG und VIW nach Bewertungszahl überholen:
- **OP Color Swatch Variant Images** (OPTIS) – 5.0 (798), Built for Shopify; Store-Text: „Variant images: show only the images of the option a shopper selects“ (https://apps.shopify.com/optis-color-swatch-variants?locale=en). **Empfehlung: Ersatz für NS** (kleinste Bewertungszahl, schwächste Note 4.4). Nicht recherchiert.
- GLO Color Swatch Variant Image (Globo) – 4.9 (1,867), und Color Swatch King (StarApps) – 5.0 (3,190): Schwerpunkt Swatches; nicht als „mehrere Bilder pro Variante“-App beworben (Swatch King ist laut StarApps-Hilfe ausdrücklich die Swatch-, nicht die Galerie-App). Nicht recherchiert.
- Name: Der Store-Titel von NS lautet jetzt „N Color Swatches Variant Image“, die Beschreibung nennt weiter „NS Color Swatch Variant Images“.

## Wichtigste Widersprüche (App Store vs. Anbieter)

1. **Rubik – KI-Kontingent Starter:** App Store „Auto-assign with AI (1k images monthly)“ vs. Website-Preisseite „500 AI images a month“ (https://rubikvariantimages.com/pricing/).
2. **SA – Testzeit:** App Store und Notion-Preisseite „30-day free trial“ / „Trial: 30 days“ vs. Hilfe-Center „Free trial: 14 days“ und „The app comes with a 14-day free trial“ (https://help.starapps.io/en/articles/15341195-variant-image-automator-pricing).
3. **SA – Bulk-Upload:** App-Store-Merkmalliste führt „Bulk upload“ und „Import and export“; Hilfe-Center: „It does not upload, edit, generate, or replace product images“.
4. **GG – Pläne:** App Store 4 Pläne (Free / Basic $5.99 / Grow $9.99 / Advanced & Plus $17.99, an den Shopify-Plan gekoppelt) vs. Website ein Bezahlplan „PRO $8.99 / month … 40% OFF if you are just starting a store“ (https://www.gigilabs.com/apps/product-page-slider/). Zudem Website-FAQ „Tag your product images to specific variants in Shopify's product editor“ vs. Doku: Zuordnung über Bildreihenfolge + Variantenbild (s. u.).
5. **NS – Bewertung und Add-on-Preis:** Website „4.9/5 ⭐ Shopify App Store rating“ (https://nestscale.com/product-variant) vs. Store 4.4 (143). Add-on Übersetzung: Plan-Artikel „Translation – $1.99/month“ vs. Übersetzungs-Artikel „Multi-Language Translation Add-on ($3.99/month)“; Store: „$3.99 additional charge for each add-on feature“. Planname „PROFESSIONAL“ (Store) vs. „Pro“/„Starter“ (Hilfe).

---

## 1. Rubik Variant Images & Swatch (Craftshift)

Quellen: Store https://apps.shopify.com/rubik-variant-images?locale=en · Preisseite https://rubikvariantimages.com/pricing/ · Startseite https://rubikvariantimages.com/ · Doku https://rubikvariantimages.com/documentation/ · FAQ https://rubikvariantimages.com/faq/ · Doku-Hub https://rubikvariant.com/docs/faq, https://rubikvariant.com/docs/overview, https://rubikvariant.com/docs/mcp

### A. Pläne

| Plan | Preis / Monat | Grenzen | KI-Bilderkennung / Monat | Test |
|---|---|---|---|---|
| Free | $0 | 1 Produkt („Set up total 1 product“), ohne Zeitlimit | 50 Bilder | – |
| Starter | $25 (oder $200/Jahr) | 100 Produkte | **Store: 1k** · **Website: 500** | 7 Tage |
| Advanced | $50 (oder $400/Jahr) | 1.000 Produkte | 5k (Store) / 5.000 (Website) | 7 Tage |
| Premium | $75 (oder $600/Jahr) | unbegrenzt | 50k / 50.000 | 7 Tage |

Website: „Paid plans differ in one thing only, how many products you can configure“ und „Every feature is on every plan … The one exception is showing swatches on products you have not configured, which needs a paid plan.“ Testzeit „once per shop“. Preis unabhängig vom Shopify-Plan.

### B. Funktionen

| # | Punkt | Antwort | ab Plan | Quelle |
|---|---|---|---|---|
| 1 | Mehrere Bilder pro Variante | Ja – „Assign multiple photos per variant“; bis Shopifys Limit „250 media on a product“ | Free (1 Produkt) | Store; https://rubikvariantimages.com/faq/ |
| 2 | Galerie zeigt nur Bilder der Variante | Ja – „choosing Blue leaves the blue ones on screen and hides the rest“; optional „hide unassigned images“ | Free | https://rubikvariantimages.com/ ; https://rubikvariantimages.com/faq/ |
| 3 | Kein Springen/Flackern beworben? | Nicht ausdrücklich. Beworben wird nur Geschwindigkeit: „no impact on page speed“, „No request reaches our servers while a shopper browses“ | – | Store; https://rubikvariantimages.com/ |
| 4 | Zoom und Vollbild/Lightbox | Teilweise – die App behält die Theme-Galerie („Preserve your theme’s variant image gallery“), Zoom/Lightbox kommen vom Theme; Store-Merkmalliste führt „Lightbox“, „Image zoom“ | Free | Store |
| 5 | Videos und 3D-Modelle | Ja – „Video, 3D model support“ in jedem Plan; „Videos and 3D models are assigned the same way“ | Free | Store; https://rubikvariantimages.com/ |
| 6 | Automatisch zuweisen – womit? | Ja – KI-Matcher liest „the product title, the option name, the option value, the filename and the alt text, and it looks at the picture itself“ (pro Produkt, KI-Kontingent); Bulk „by gallery order“ ohne KI; zusätzlich per MCP-Server über KI-Assistenten (Claude) | Free (KI-Kontingent je Plan) | https://rubikvariantimages.com/documentation/ ; https://rubikvariant.com/docs/mcp |
| 7 | Erzeugt Zuordnungs-Schlüssel/SKUs selbst? | keine Angabe (Zuordnung liegt in einem Produkt-Metafield, „The assignment lives in a Shopify metafield“; von Schlüsseln/SKUs ist keine Rede) | – | https://rubikvariantimages.com/ |
| 8 | Drag & Drop | Ja – „Drag images onto each option value“ | Free | https://rubikvariantimages.com/ |
| 9 | Massen-Upload | Nein in dieser App belegbar – kein Upload beschrieben; Anbieter führt separate App „Smart Bulk Image Upload“. (Bulk-*Zuweisung* gibt es: „Hundreds of products in the background“) | – | https://rubikvariantimages.com/faq/ (Footer „Our Apps“) |
| 10 | Swatches Produktseite | Ja – „image swatches, colour swatches or pill buttons“ | Free | https://rubikvariantimages.com/pricing/ |
| 11 | Swatches Kollektionsseiten | Ja – „Product card swatches … across collection, search and home listings“; für *nicht konfigurierte* Produkte nur in Bezahlplänen | Free (konfigurierte Produkte) / Starter (nicht konfigurierte) | https://rubikvariantimages.com/pricing/ |
| 12 | Combined listings / Aufteilen | Nicht in dieser App – Anbieter hat dafür die separate App „Rubik Combined Listings“ | – | https://rubikvariantimages.com/ (Footer) |
| 13 | Bilder komprimieren / WebP | keine Angabe | – | – |
| 14 | Alt-Texte per KI | keine Angabe (Alt-Text wird nur *gelesen* für die Zuordnung) | – | https://rubikvariantimages.com/documentation/ |
| 15 | Alt-Texte übersetzen | keine Angabe (Mehrsprachigkeit betrifft nur das Admin-UI: „The app dashboard is available in multiple languages“) | – | https://rubikvariant.com/docs/overview |

### C. Einordnung
Rubik ordnet Bilder, Videos und 3D-Modelle Optionswerten zu (gespeichert in einem Metafield, ausgeliefert per Theme-App-Extension) und filtert damit die vorhandene Theme-Galerie; dazu kommen Bild-/Farb-Swatches auf Produkt- und Produktkarten. Zuordnung per Hand, per KI-Matcher (Titel, Option, Dateiname, Alt-Text, Bildinhalt) oder per Bulk-Lauf nach Galerie-Reihenfolge, neuerdings auch über einen MCP-Server. Für Shops jeder Größe; Preis hängt nur an der Zahl konfigurierter Produkte, nicht am Shopify-Plan.
Stärken (Store): „Assign multiple photos per variant. Auto assign variant images with AI or MCP“ · „Works seamless with all themes & page builder apps with no impact on page speed“ · „Show variant picker with variant image swatches, color swatches, image variants“ · „Assign common images without duplication“.
Bewertung: **5.0 (486)** (Website nennt 484). **Built for Shopify: Ja** (Badge im Store-Kopf; Website/FAQ: „has earned the Built for Shopify badge“).

---

## 2. SA Variant Image Automator (StarApps)

Quellen: Store https://apps.shopify.com/variant-image-automator?locale=en · Preisseite (vom Store verlinkt, Notion) https://laser-comb-669.notion.site/SA-Variant-Image-Automator-Pricing-2a8ff378e63d80808db4e7099eaa064d · Hilfe-Center (Intercom) https://help.starapps.io/en/collections/11026936-sa-variant-image-automator-app, insbes. Feature-Breakdown https://help.starapps.io/en/articles/15322942-variant-image-automator-full-feature-breakdown-what-variant-image-automator-can-and-cannot-do, Pricing https://help.starapps.io/en/articles/15341195-variant-image-automator-pricing, Manage product media https://help.starapps.io/en/articles/15339702-variant-image-automator-manage-product-media, App settings https://help.starapps.io/en/articles/15341205-variant-image-automator-app-settings. Die Website www.starapps.studio löst per curl nicht auf (keine Antwort); variant-image-automator.starapps.studio ist nur die Login-Seite.

### A. Pläne
Preis richtet sich nach dem **Shopify-Plan** des Händlers; „All features are available on every plan“ (Hilfe) / „You get access to all the app's features in all the plans“ (Notion). Keine Produkt-/Bildgrenzen genannt.

| Plan | Preis / Monat | Grenzen | Test |
|---|---|---|---|
| Free | $0 | nur Shopify-Partner-, Staff- und Merchant-Trial-Stores | – |
| Pause & Build | $5 | Shops im Shopify-Plan „Pause and Build“ | keine Angabe |
| Shopify Basic (inkl. NPO) | $14.90 | keine | **Store/Notion: 30 Tage · Hilfe: 14 Tage** |
| Shopify / Grow & Custom (inkl. Professional) | $29.90 | keine | dto. |
| Shopify Advanced | $49.90 | keine | dto. |
| Shopify Plus | $99.90 | keine | dto. |

Zusatzkosten: einmalige Setup-Gebühr für Custom-Themes; „AI-generated themes and galleries“ werden nicht unterstützt. 30-Tage-Geld-zurück laut Hilfe.

### B. Funktionen
(„ab Plan“ = jeder Bezahlplan; der Plan bestimmt nur den Preis.)

| # | Punkt | Antwort | ab Plan | Quelle |
|---|---|---|---|---|
| 1 | Mehrere Bilder pro Variante | Ja – „letting you group multiple images under each variant“ | alle (ab Basic $14.90; Pause & Build $5) | Feature-Breakdown |
| 2 | Galerie zeigt nur Bilder der Variante | Ja – „filtering the gallery to show only the images that belong to the selected variant“; steuerbar, was vor Variantenwahl gezeigt wird | alle | Feature-Breakdown |
| 3 | Kein Springen/Flackern beworben? | Teilweise – beworben wird Theme-Treue und Tempo: „Variant image gallery apps often break themes. Ours keeps zoom, layout & speed“; kein ausdrückliches Anti-Flacker-Versprechen | alle | Store |
| 4 | Zoom und Vollbild/Lightbox | Teilweise – nur über das Theme: „Features like zoom, lazy loading, sliders, lightboxes … provided by your theme remain exactly as they are“ | alle | Feature-Breakdown |
| 5 | Videos und 3D-Modelle | Ja – „Videos and 3D models are filtered and displayed the same way as images“; Option „Move video to first position“ | alle | Feature-Breakdown; App settings |
| 6 | Automatisch zuweisen – womit? | Teilweise / Bildreihenfolge – Store: „Automatically assigns multiple images per variant with no manual image tagging“; Hilfe: Varianten werden automatisch nach Option gruppiert, die Zuordnung beruht auf der Reihenfolge der Produktmedien („Images for the same variant must be grouped together, and the first image of each group must be assigned to that variant in Shopify“). Keine KI erwähnt | alle | Store; Manage product media |
| 7 | Erzeugt Schlüssel/SKUs selbst? | keine Angabe | – | – |
| 8 | Drag & Drop | Ja – „drag and drop images into variant buckets“ | alle | Feature-Breakdown |
| 9 | Massen-Upload | **Widerspruch**: Store-Merkmalliste „Bulk upload“, „Import and export“ vs. Hilfe „It does not upload, edit, generate, or replace product images“ | – | Store; Feature-Breakdown |
| 10 | Swatches Produktseite | Nein – „It does not display variant swatches or replace the variant picker … that is a separate app — Swatch King“ | – | Feature-Breakdown |
| 11 | Swatches Kollektionsseiten | Nein (siehe 10) | – | Feature-Breakdown |
| 12 | Combined listings / Aufteilen | Nicht in dieser App (StarApps führt separat „SA Variants: Combined Listings“) | – | https://help.starapps.io/en/collections/10973518-sa-variants-combined-listings-app |
| 13 | Komprimieren / WebP | Nein – „It does not upload, edit, generate, or replace product images“ | – | Feature-Breakdown |
| 14 | Alt-Texte per KI | Nicht in dieser App (separate StarApps-App „Variant Alt Text King: SEO“) | – | https://help.starapps.io/en/collections/14188694-variant-alt-text-king-seo |
| 15 | Alt-Texte übersetzen | keine Angabe | – | – |

### C. Einordnung
SA filtert die vorhandene Theme-Galerie, ohne deren Aussehen zu ändern: Bilder werden im Dashboard per Drag & Drop in „Variant buckets“ gelegt, die App sortiert die Shopify-Medien danach um und erkennt die Gruppen über die Reihenfolge plus Shopify-Variantenbild. Bewusst schmal geschnitten – keine Swatches, kein Upload, keine Galerie-Funktionen (dafür Schwester-Apps). Für Händler mit Theme-Store-Themes, die keine Galerie-App wollen, sondern nur saubere Variantengalerien; Preis skaliert mit dem Shopify-Plan.
Stärken (Store): „Automatically assigns multiple images per variant with no manual image tagging“ · „Variant image grouping that keeps your 3D, video and zoom working.“ · „Image variants on any theme, page builder or custom build. No code needed.“ · „Show multiple variant images instantly on variant selection to boost conversion“.
Bewertung: **4.9 (766)**. **Built for Shopify: Ja** (Badge im Store-Kopf).

---

## 3. N Color Swatches Variant Image / NS Color Swatch Variant Images (NestScale)

> **Nicht eingetragen** (Nachtrag 2026-10-01): mit 4.4 (143) die kleinste der fünf; auf der Vergleichsseite durch **OP Color Swatch Variant Images** (Abschnitt 6) ersetzt. Abschnitt bleibt als Beleg stehen.

Quellen: Store https://apps.shopify.com/ns-product-variants-options?locale=en · Produktseite https://nestscale.com/product-variant · Hilfe-Center https://support.nestscale.com/nestscale-product-variants-knowledge-base/, insbes. Pläne https://support.nestscale.com/nestscale-product-variants/choose-your-suitable-plan/, Variant Images https://support.nestscale.com/nestscale-product-variants/variant-image/, Image Slider https://support.nestscale.com/nestscale-product-variants/ns-product-variants-image-slider/image-slider/, Übersetzung https://support.nestscale.com/nestscale-product-variants/multi-language-translation/, Einführung https://support.nestscale.com/nestscale-product-variants/introduction-to-nestscale-product-variants/

### A. Pläne

| Plan (Store / Hilfe) | Preis / Monat | Grenzen / Inhalt | Test |
|---|---|---|---|
| FREE / Starter | $0 | „Unlimited product variants“, Farb-/Text-/Bild-Swatches nur Produktseite | – |
| GROWTH / Growth | $7.99 | + Swatches auf Kollektionsseiten, „Auto-use variant images as swatches“, KI-Produktbeschreibung, Quick View; Pro-Funktionen als **Add-ons je $3.99/Monat** (Hilfe: Variant Images $3.99, Variant Split $3.99, Product Group $3.99, Variant Slider $3.99, Translation **$1.99** bzw. im Übersetzungsartikel **$3.99**); Add-ons ohne Testzeit | 7 Tage |
| PROFESSIONAL / Pro | $14.99 (oder $149.90/Jahr) | + Variant image gallery, „Multiple variant images & AI description“, Combined Listings unbegrenzt, Variant Split, Übersetzung, Image Slider | 7 Tage |

Keine Produktgrenzen genannt; Grenze für KI-Beschreibungen: keine Angabe.

### B. Funktionen

| # | Punkt | Antwort | ab Plan | Quelle |
|---|---|---|---|---|
| 1 | Mehrere Bilder pro Variante | Ja – „Multiple variant images & AI description“ | Pro ($14.99) oder Growth + Add-on ($7.99+$3.99) | Store; Pläne-Artikel |
| 2 | Galerie zeigt nur Bilder der Variante | Ja – „display only the specific images associated with each variant when customers select it“ | Pro / Growth + Add-on | Variant-Images-Artikel; Pläne-Artikel |
| 3 | Kein Springen/Flackern beworben? | keine Angabe | – | – |
| 4 | Zoom und Lightbox | Teilweise – Image Slider mit „Zoom on click“, „Zoom on hover“; Vollbild/Lightbox: keine Angabe | Pro / Growth + Add-on („Variant Slider“) | Image-Slider-Artikel |
| 5 | Videos und 3D | keine Angabe | – | – |
| 6 | Automatisch zuweisen | keine Angabe für die Galerie-Zuordnung (Hilfe beschreibt nur manuelles Anhaken je Variante: „tick all images you want to display for that variant“). Automatisch ist nur „Auto-use variant images as swatches“ | – (Swatch-Automatik ab Growth) | Variant-Images-Artikel; Store |
| 7 | Erzeugt Schlüssel/SKUs selbst? | keine Angabe | – | – |
| 8 | Drag & Drop | keine Angabe (Zuordnung per Häkchen im Edit-Dialog) | – | Variant-Images-Artikel |
| 9 | Massen-Upload | keine Angabe („Bulk Edit“ heißt dort: Bilder für Einzel- und kombinierte Varianten zuweisen, kein Upload) | – | Variant-Images-Artikel |
| 10 | Swatches Produktseite | Ja – Farbe, Text, eigene Bilder | Free | Store |
| 11 | Swatches Kollektionsseiten | Ja – „Swatches on product/collection pages“ | Growth | Store; Pläne-Artikel |
| 12 | Combined listings / Aufteilen | Ja, beides – „Create combined listings by grouping products as variants with unique URLs“, „Show variants as separate products on collection pages“ | Pro / Growth + Add-on | Store; Pläne-Artikel |
| 13 | Komprimieren / WebP | keine Angabe | – | – |
| 14 | Alt-Texte per KI | keine Angabe (KI nur für Produktbeschreibungen: „Bulk generate SEO-friendly AI product descriptions with custom brand voice“) | – | Store |
| 15 | Alt-Texte übersetzen | keine Angabe (Übersetzung betrifft Variantenbezeichnungen und setzt eine Drittanbieter-Übersetzungs-App voraus) | – | Übersetzungs-Artikel |

### C. Einordnung
Eine Swatch-App, die Variantenbilder, Combined Listings, Variant Split, Quick View und KI-Produktbeschreibungen als Bausteine anbietet; die Variantengalerie ist ein Pro-Feature bzw. Growth-Add-on. Bilder werden je Variante im App-Dialog angehakt, die Anzeige läuft über einen eigenen Image Slider mit Zoom. Für kleine Shops, die günstig Swatches plus Gruppierung wollen und Einzelfunktionen zubuchen.
Stärken (Store): „Create combined listings by grouping products as variants with unique URLs.“ · „Select various variant types: text/image/color swatch, dropdowns, buttons, etc.“ · „Show relevant images for the selected variant with image slider & zoom settings.“ · „Bulk generate SEO-friendly AI product descriptions with custom brand voice.“
Bewertung: **4.4 (143)** (Website behauptet „4.9/5“). **Built for Shopify: Nein** (kein Badge im Store-Kopf; „Built for Shopify“ erscheint nur bei anderen Apps unter „More apps like this“).

---

## 4. Variant Image Wizard + Swatch (ProductWiz Inc.)

Quellen: Store https://apps.shopify.com/variant-image-wizard?locale=en · Website https://productwiz.io (keine Preisseite) · Hilfe (GitBook, als .md geladen) https://help.productwiz.io/variant-wizard/faq/general, https://help.productwiz.io/variant-wizard/faq/product-options, https://help.productwiz.io/variant-wizard/faq/variant-images/general, https://help.productwiz.io/variant-wizard/faq/variant-images/import, https://help.productwiz.io/variant-wizard/faq/variant-images/bulk-edit, https://help.productwiz.io/variant-wizard/faq/link-variant-images-to-swatches

### A. Pläne

| Plan | Preis / Monat | Grenzen | Test |
|---|---|---|---|
| Free | $0 | Product options; „Variant images (up to 5 products)“; Produktgalerie; „Only Shopify free themes“ | – |
| Starter | $4.99 | „Variant images (unlimited products)“; „Only Shopify free themes“ | 14 Tage |
| Pro | $7.99 | + „Variant images bulk edit“, „Group Products As Swatches“, „Videos & models“, „All themes“ | 14 Tage |

### B. Funktionen

| # | Punkt | Antwort | ab Plan | Quelle |
|---|---|---|---|---|
| 1 | Mehrere Bilder pro Variante | Ja – „configure multiple images per variant“ | Free (5 Produkte) / Starter (unbegrenzt); Pro bei Nicht-Gratis-Themes | Store |
| 2 | Galerie zeigt nur Bilder der Variante | Ja – „show only the relevant product images for the selected variant“ | Free | Store |
| 3 | Kein Springen/Flackern beworben? | keine Angabe | – | – |
| 4 | Zoom und Lightbox | Ja – eigene Produktgalerie: „configure zoom & lightbox“; Store-Merkmale „Lightbox“, „Image zoom“ | Free („Product image gallery“) | https://productwiz.io ; Store |
| 5 | Videos und 3D | Ja – „Compatible with videos, 3D models“ | Pro („Videos & models“) | Store |
| 6 | Automatisch zuweisen | Teilweise – nur Import der vorhandenen Shopify-Variantenbilder („Import Shopify Variant Image“); sonst manuell | Free | Hilfe Import |
| 7 | Erzeugt Schlüssel/SKUs selbst? | keine Angabe | – | – |
| 8 | Drag & Drop | Ja – „elegant drag-and-drop user interface where you can configure multiple images per variant“ | Free | Store |
| 9 | Massen-Upload | Teilweise – Bilder lassen sich in der App hochladen („Your images are uploaded to your Product's media“); Bulk Edit kopiert/ergänzt/entfernt Medien über viele Varianten („Append“, „Prepend“, „Insert“, „Replace“, „Delete“); ein Massen-Upload ist nicht beschrieben | Bulk Edit: Pro | Hilfe General; Hilfe Bulk Edit |
| 10 | Swatches Produktseite | Ja – Bild-/Farb-Swatches, Buttons, Dropdowns, Tooltips | Free („Product options“) | Store; Hilfe Product Options |
| 11 | Swatches Kollektionsseiten | keine Angabe | – | – |
| 12 | Combined listings / Aufteilen | Teilweise – „Group Products as Swatches“ verknüpft Produkte als Swatches; Aufteilen nach Farbe: keine Angabe | Pro | Store |
| 13 | Komprimieren / WebP | keine Angabe | – | – |
| 14 | Alt-Texte per KI | Nein belegt nur indirekt: Hilfe verweist für Alt-Texte auf Shopifys eigenen Editor („How do I change an image, video or model's alt text?“ → help.shopify.com) – also keine App-Funktion; KI: keine Angabe | – | Hilfe Variant Images General |
| 15 | Alt-Texte übersetzen | keine Angabe (nur „Out of stock“ lässt sich übersetzen) | – | Hilfe Product Options |

### C. Einordnung
Kombination aus Swatch-Konfigurator (Bild/Farbe/Button/Dropdown mit Titeln, Tooltips, Hinweisen) und Variantengalerie mit eigener Galerie samt Zoom und Lightbox; Bilder werden per Drag & Drop je Variante zugeordnet, vorhandene Shopify-Variantenbilder importiert. Sehr günstig, aber Free/Starter nur für Shopifys Gratis-Themes; Videos/3D, Bulk Edit und Produktgruppen erst im Pro-Plan. Für kleine Shops mit Standard-Theme.
Stärken (Store): „Variant images: show only the relevant product images for the selected variant“ · „Customize product options as image and color swatch, buttons and dropdowns“ · „Add tooltips, titles, subtitles, alerts, etc. to your product options“ · „Easily link products together with our Group Products as Swatches feature“.
Bewertung: **4.7 (224)**. **Built for Shopify: Nein** (kein Badge im Store-Kopf).

---

## 5. GG Product Page Image Slider (Gigilabs)

Quellen: Store https://apps.shopify.com/product-gallery-slider?locale=en · Website/Preise https://www.gigilabs.com/apps/product-page-slider/ · Doku https://www.gigilabs.com/docs/product-page-slider/variant-images-guide/ , https://www.gigilabs.com/docs/product-page-slider/installation/ · Der vom Store verlinkte Artikel https://www.gigilabs.com/docs/product-page-slider/best-practices/ liefert „Page not found“.

### A. Pläne

| Plan (Store) | Preis / Monat | Grenzen | Test |
|---|---|---|---|
| Free | $0 | „Just the basic Slider“, keine Thumbnails, „No zoom“, „No video“ | – |
| Basic | $5.99 | „For stores on the Shopify Basic plan“; alle Optionen, Zoom, Video, „Multiple images per variant“ | 7 Tage |
| Grow | $9.99 | dto., für Shopify-Grow-Stores | 7 Tage |
| Advanced & Plus | $17.99 | dto., für Shopify Advanced/Plus | 7 Tage |

**Website abweichend:** nur Free und „PRO $8.99 / month … 40% OFF if you are just starting a store“, 7-day free trial.

### B. Funktionen

| # | Punkt | Antwort | ab Plan | Quelle |
|---|---|---|---|---|
| 1 | Mehrere Bilder pro Variante | Ja – „Multiple images per variant“ | Basic $5.99 (Store) / PRO $8.99 (Website) | Store; Website |
| 2 | Galerie zeigt nur Bilder der Variante | Ja – Option „Show only Selected Variant Images“; Website: „Paid plans unlock … variant-specific image filtering“ | Basic (Store) | Doku Variant Images; Website |
| 3 | Kein Springen/Flackern beworben? | Teilweise – beworben wird Ladeverhalten: „loads its own scripts asynchronously, so it never blocks your page from rendering“, Lazy Loading; kein ausdrückliches Anti-Flacker-Versprechen | – | Website |
| 4 | Zoom und Lightbox | Ja – „Hover-zoom on desktop and a fullscreen lightbox on any device“, Pinch-to-zoom | Basic (Free: „No zoom“) | Website; Store |
| 5 | Videos und 3D | Ja – MP4, YouTube, Vimeo; „displays them [3D models] as slides“ | Video: Basic (Free: „No video“); 3D: keine Planangabe | Website; Store |
| 6 | Automatisch zuweisen | Ja, über Bildreihenfolge – Bilder einer Variante zusammenhängend sortieren und „assign the very first Image of each Variant to its Featured Image“; gemeinsame Bilder an den Anfang. Keine KI. (Website-FAQ widerspricht: „Tag your product images to specific variants in Shopify's product editor“) | Basic | Doku Variant Images; Website |
| 7 | Erzeugt Schlüssel/SKUs selbst? | keine Angabe | – | – |
| 8 | Drag & Drop | Nein in der App – Reihenfolge wird im Shopify-Admin per Drag & Drop geändert („reorder Images in the Product Settings page by drag & dropping them“) | – | Doku Variant Images |
| 9 | Massen-Upload | Nein – „The app works with the media already attached to your products … No re-uploading“ | – | Website |
| 10 | Swatches Produktseite | keine Angabe | – | – |
| 11 | Swatches Kollektionsseiten | keine Angabe (für Kollektionen verweist die Website auf ein Quick-View-Feature) | – | Website |
| 12 | Combined listings / Aufteilen | keine Angabe | – | – |
| 13 | Komprimieren / WebP | Teilweise – „Shopify's CDN and the app handle resizing and optimization automatically“; Store-Merkmal „Image resizing“; keine Dateikomprimierung/WebP genannt | keine Planangabe | Website; Store |
| 14 | Alt-Texte per KI | keine Angabe | – | – |
| 15 | Alt-Texte übersetzen | keine Angabe | – | – |

### C. Einordnung
Eine Galerie-App, die die Produktgalerie des Themes durch einen eigenen Slider (horizontale/vertikale Thumbnails, Zoom, Lightbox, Video, 3D) ersetzt; das Variantenbild-Filtern ist eine Zusatzoption, die über eine Namenskonvention in den Shopify-Medien funktioniert (Bilder je Variante zusammenhängend, erstes als Variantenbild). Kein eigenes Zuordnungs-UI, keine Swatches. Für Händler, die vor allem eine bessere mobile Galerie wollen und Variantenbilder nebenbei.
Stärken (Store): „Product variant images - show only the selected variant in a slideshow“ · „Rich Media support - play product video and show product 3D model in AR“ · „Optimized for Mobile - swipe product images in a slide show“ · „Select image carousel type, arrows, colors, video player & image zoom“.
Bewertung: **4.8 (176)** (Website: „4.9 (150+ reviews)“). **Built for Shopify: Ja** (Badge im Store-Kopf).

---

## 6. OP Color Swatch Variant Images (OPTIS)

Ersetzt „NS Color Swatch Variant Images“ (NestScale) im Vergleich. Prüfdatum: **2026-10-01**. Alle Angaben aus dem Rohtext (curl) der genannten Seiten; App Store mit `?locale=en`. Preise in USD, laut App Store „billed every 30 days“.

Quellen: Store https://apps.shopify.com/optis-color-swatch-variants?locale=en · Preisseite (Store-Link „See all pricing options“) https://docs.optis.me/swatch/subscription-and-billing/pricing-plans · Preis-FAQ https://docs.optis.me/swatch/subscription-and-billing/pricing-plans-faqs · Website https://optis.me/optis-color-swatches-variants/ · Hilfe-Center (GitBook, alle Artikel des Bereichs „OPTIS Color Swatch“ laut https://docs.optis.me/llms.txt als Markdown geladen, alle HTTP 200) https://docs.optis.me/swatch · Changelog https://docs.optis.me/swatch/changelog
Anbieter: Store-Entwickler „OPTIS“ (Ha Noi, VN), Website-Footer „© 2026 BSS Commerce“. Gestartet laut Store „June 10, 2025“.
Schwester-Apps desselben Anbieters (Website-Navigation): **OPTIS Combined Listings** (https://optis.me/optis-combined-listings/ → https://apps.shopify.com/optis-combined-listings), OPTIS Product Options, Variant, OPTIS Contact Form Builder.

### A. Pläne

Der Preis hängt am **Shopify-Plan** des Shops, nicht am Funktionsumfang („Pricing automatically matches your Shopify plan. All features are included on every plan.“ – Store).

| Plan | Preis / Monat | Grenzen | Test |
|---|---|---|---|
| Free | $0 | **nur** für „Shopify Trial stores, Shopify Partner / Dev stores, Shopify Pause & Build stores, Shopify Staff stores“ – also kein Gratisplan für Live-Shops; „Unlimited color & image swatches“ | – |
| Basic (Shopify Basic) | $11.90 | keine Mengengrenzen genannt („Unlimited color & image swatches“) | 30 Tage (+ 72 h „Exploration Mode“ vor der Abo-Freigabe) |
| Grow (Shopify Grow) | $29.90 | wie Basic | 30 Tage |
| Advanced (Shopify Advanced) | $49.90 | wie Basic | 30 Tage |
| Plus (Shopify Plus) | $99.90 | wie Basic; Support „priority for Plus“ | 30 Tage |

Quellen: Store (Pricing-Block „PAY AS YOU GROW $11.90 / month … Shopify Basic: $11.90, Shopify Grow: $29.90, Shopify Advanced: $49.90, Shopify Plus: $99.90 … 30-day free trial“); Preisseite (Tabelle Shopify plan → App plan, „✅ Full features access to all plans“, „✅ 72h Exploration Mode“, „All paid plans come with a 30-day free trial“, „30-day money-back guarantee“). Keine Jahrespreise genannt. Wer vor dem 20.01.2026 installiert hat („grandfathered“), erhält „15% lifetime discount“ (Preis-FAQ).

### B. Funktionen

„ab Plan“: Da alle Bezahlpläne denselben Umfang haben, heißt „Basic“ = kleinster Bezahlplan für Live-Shops; „Free“ gilt nur für Entwicklungs-/Trial-Shops.

| # | Punkt | Antwort | ab Plan | Quelle |
|---|---|---|---|---|
| 1 | Mehrere Bilder pro Variante | Ja – „Each variant is linked to its own set of images“; Zuordnung über die Bildreihenfolge in Shopify („group images by variant and place the primary image first“), plus „Common Images“ für alle Varianten | Free (Dev-Shops) / Basic | https://docs.optis.me/swatch/variant-images/show-images-per-variant ; https://docs.optis.me/swatch/variant-images/advanced-settings ; Store (Free- und Bezahlplan führen „Variant images“) |
| 2 | Galerie zeigt nur Bilder der Variante | Ja – „Variant images: show only the images of the option a shopper selects“; „Images from other variants are hidden until selected“; seit 21.08.2026 auch auf Kollektionskarten („the card's image gallery updates to show only that variant's images“). Steuerbar je Produkt per Tag `op_vi_enabled` / `op_vi_disabled` | Free / Basic | Store; https://docs.optis.me/swatch/variant-images/show-images-per-variant ; https://docs.optis.me/swatch/variant-images/variant-images-on-collection-pages |
| 3 | Kein Springen/Flackern beworben? | Nein, nicht beworben. Hilfe-Center räumt im Gegenteil ein: „the initial Shopify variant may briefly appear before OPTIS swatches are displayed“ (betrifft die Swatches; auf Anfrage blendet der Support das visuell aus). Beworben wird nur Tempo („Faster swatch rendering on collection pages“ – Changelog) | – | https://docs.optis.me/swatch/variant-display/common-questions/why-do-i-briefly-see-the-initial-variant-before-the-swatches-load ; https://docs.optis.me/swatch/changelog |
| 4 | Zoom und Vollbild/Lightbox | keine Angabe (die App filtert die Galerie des Themes – „Updates the product gallery when a variant is selected“; Zoom/Lightbox werden nirgends erwähnt) | – | https://docs.optis.me/swatch/getting-started/core-features-overview |
| 5 | Videos und 3D-Modelle | keine Angabe (Doku spricht ausschließlich von „images“) | – | https://docs.optis.me/swatch/variant-images/show-images-per-variant |
| 6 | Automatisch zuweisen – womit? | Teilweise – nur nach **Bildreihenfolge**: das Variantenbild ist der Anker, die folgenden Bilder bis zum nächsten Variantenbild gehören zur Variante; Bilder vor der ersten Gruppe gelten als „Common Images“. Keine KI, kein Dateiname/Alt-Text. (Website: „automatically, no manual mapping“ – s. Widersprüche.) Getrennt davon: „Auto-assign swatch“ füllt **Swatch-Farben** aus Farb-Taxonomie-Metafeld, Wertname oder dominanter Farbe des Variantenbilds | Free / Basic | https://docs.optis.me/swatch/variant-images/show-images-per-variant ; https://docs.optis.me/swatch/variant-images/common-questions/how-can-i-set-common-images-for-all-variants ; https://docs.optis.me/swatch/variant-display/auto-assign-color-swatch |
| 7 | Erzeugt Zuordnungs-Schlüssel/SKUs selbst? | keine Angabe (die App nutzt Shopifys eigenes Variantenbild als Anker; „no new variants are created“; von Schlüsseln/SKUs keine Rede) | – | https://docs.optis.me/swatch/getting-started/core-features-overview |
| 8 | Drag & Drop | keine Angabe in der App – die Reihenfolge wird laut Anleitung „In Shopify Product admin“ festgelegt, also im Shopify-eigenen Medienbereich, nicht in der App | – | https://docs.optis.me/swatch/variant-images/show-images-per-variant |
| 9 | Massen-Upload | keine Angabe für Produktbilder. Vorhanden sind nur Massenfunktionen für Swatch-Werte („import and export swatch values in a spreadsheet with Bulk update“) und für Produktgruppen (Bulk create, CSV-Export) | – | https://docs.optis.me/swatch (readme) ; https://docs.optis.me/swatch/product-groups/bulk-create-product-groups |
| 10 | Swatches Produktseite | Ja – „color swatch, image swatch, swatch card, pill, button or dropdown“; Bild-Swatches automatisch aus den Variantenbildern („Auto image swatch“) oder eigene Bilder/Farben/Zweifarb-Split. Hinweis: Zweifarb-Swatch laut Changelog „a paid plan feature for new merchants“ | Free / Basic | Store; https://docs.optis.me/swatch/variant-display/auto-image-swatch ; https://docs.optis.me/swatch/changelog |
| 11 | Swatches Kollektionsseiten | Ja – „Collection pages show every color as a swatch, not one product image“; Bildwechsel bei Hover (nur Desktop) und Variantengalerie auf der Karte | Free / Basic | Store; https://docs.optis.me/swatch/variant-display/common-questions/can-i-show-swatch-on-collection-page ; https://docs.optis.me/swatch/frequently-asked-questions/how-to-change-image-on-hovering |
| 12 | Combined listings / Aufteilen | Kombinieren: Ja – „Product groups put related products on one page, each with its own URL“, inkl. Bulk create nach Namensmuster/Tag/Metafeld (max. 250 Produkte je Scan, 100 Gruppen je Lauf). Aufteilen nach Farbe: nicht in dieser App beschrieben; die Schwester-App **OPTIS Combined Listings** (gratis) nennt „split products“ | Free / Basic (Bestandskunden vor 20.01.2026: nur mit Upgrade) | Store; https://docs.optis.me/swatch/product-groups/show-separate-products-as-variants-with-product-groups ; https://docs.optis.me/swatch/product-groups/bulk-create-product-groups ; https://optis.me/optis-combined-listings/ |
| 13 | Bilder komprimieren / WebP | keine Angabe | – | – |
| 14 | Alt-Texte per KI | keine Angabe | – | – |
| 15 | Alt-Texte übersetzen | keine Angabe. Übersetzt werden nur Swatch-/Gruppen-Texte: Produktgruppen per „Auto translate“ in der App, Swatch-Labels über Shopify Translate & Adapt | – | https://docs.optis.me/swatch/product-groups/translate-product-group ; https://optis.me/optis-color-swatches-variants/ |

### C. Einordnung

OPTIS ist in erster Linie eine **Swatch-App**: Sie ersetzt das Varianten-Dropdown des Themes durch Farb-, Bild-, Karten-, Pill-, Button- oder Dropdown-Darstellungen auf Produkt- und Kollektionsseiten und setzt dabei auf Shopifys eigene Varianten und den Varianten-Picker des Themes auf (der aktiv bleiben muss). Die Variantenbild-Funktion filtert die Theme-Galerie; welche Bilder zu welcher Variante gehören, ergibt sich allein aus der Reihenfolge im Shopify-Admin (Variantenbild als erstes Bild jeder Gruppe) – es gibt keinen eigenen Zuordnungs-Editor, keine KI und keine Video-/3D-Angaben. Dazu kommen Produktgruppen (combined listings), Badges (ausverkauft, wenig Bestand, neu, Sale) und kostenlose Einrichtung durch den Support. Passend für Shops, die vor allem Swatches wollen und bereit sind, ihre Galerie nach Variante zu sortieren; Preis steigt mit dem Shopify-Plan, nicht mit der Katalogsgröße.
Stärken (Store): „Turn variant dropdowns into color and image swatches. Shoppers see only the images they pick.“ · „Collection pages show every color as a swatch, not one product image“ · „Product groups put related products on one page, each with its own URL.“ · „Free setup and theme fixes by our team, on 24/7 live chat, on any plan“.
Bewertung: **5.0 (798)** im Store (787 × 5 Sterne, 10 × 4, 1 × 2); Website „800+ reviews“. **Built for Shopify: Ja** (Badge im Store-Kopf; Website: „is a Built for Shopify app“).

### Widersprüche (App Store vs. Anbieter)

1. **„Alle Funktionen in jedem Plan“ vs. gesperrte Funktionen:** Store/Preisseite „All features are included on every plan“ / „Full features access to all plans“ vs. Hilfe-Center „Button without border (premium)“ (https://docs.optis.me/swatch/variant-display/common-questions/can-i-show-swatch-on-collection-page) und Changelog „2-color swatch is a paid plan feature for new merchants“. Auflösbar, wenn „Plan“ nur die Bezahlpläne meint – der Store führt Free aber ebenfalls als Plan.
2. **Bestandskunden:** Preis-FAQ: wer vor dem 20.01.2026 installiert hat, kann „continue using the app as usual“, aber Product Groups und Variant Images sind für ihn „locked“ bis zum Upgrade (https://docs.optis.me/swatch/subscription-and-billing/pricing-plans-faqs) – der Store kennt nur Free (Dev-Shops) und Bezahlplan.
3. **Free-Plan-Umfang:** Store-Free-Karte führt „Product groups / Combined listings“ und „Variant images“; die Website-Karte „DEV & TRIAL STORES $0“ nennt nur „Unlimited color & image swatches“ (https://optis.me/optis-color-swatches-variants/).
4. **Plus-Preis auf der Website:** Karte „ADVANCED & PLUS $49.90 / month“ mit Zusatzzeile „Shopify Plus stores: $99.90 / month“ (Website) vs. Store/Preisseite getrennt Advanced $49.90 / Plus $99.90.
5. **Zuordnung „automatisch“:** Website „automatically, no manual mapping or duplicated products required“ vs. Hilfe-Center: Bilder im Shopify-Admin nach Variante gruppieren und jedem Variantenbild die erste Bildgruppe zuordnen; Fehlerursache u. a. „Variant images are not grouped correctly in Shopify“ (https://docs.optis.me/swatch/variant-images/common-questions/why-isnt-my-variant-image-switching-correctly).
6. **Bewertungszahl:** Store 798 vs. Website „800+ reviews“ (gerundet). Eine Store-Bewertung (Aug. 2026) beklagt „It is marketing as free app and its so not“ – sachlich passend zu „Free to install“, Free-Plan aber nur für Dev-/Trial-Shops.

### Nicht belegbar / Lücken
Video/3D, Zoom/Lightbox, Bildkompression/WebP, Alt-Texte (KI/Übersetzung), Massen-Upload von Bildern, eigene Zuordnungsschlüssel: in keiner der geladenen Hilfe-Center-Seiten, weder auf Store noch Website erwähnt → „keine Angabe“. Die App-Store-Suche (`/search?q=optis`) liefert per curl keine Treffer; Schwester-App daher über die Website ermittelt.

Prüfdatum: **2026-10-01**

---

## Nicht belegbar / Lücken
- Punkt 7 (Zuordnungs-Schlüssel/SKUs selbst erzeugen): bei keiner App eine Angabe.
- Punkt 13/14/15 (Komprimierung/WebP, KI-Alt-Texte, Alt-Text-Übersetzung): bei keiner App als eigene Funktion belegt; StarApps bietet KI-Alt-Texte nur in der separaten App „Variant Alt Text King“.
- Punkt 3 (kein Flackern): keine App verspricht es ausdrücklich; SA und GG werben mit Theme-/Ladeverhalten.
- StarApps-Website (www.starapps.studio) per curl nicht erreichbar; Belege daher aus Store, Notion-Preisseite und Intercom-Hilfe.
- Gigilabs-Artikel „best-practices“ (im Store verlinkt) ist 404.
- App-Store-Suche per curl leer (JS); Kandidatenprüfung über Kategorielisten.

Prüfdatum: **2026-10-01**
