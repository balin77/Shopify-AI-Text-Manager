# Recherche-Aufträge für die Vergleichsseiten SEO, KI-Texte und Variantenbilder

Stand: 2026-09-30. Die drei Themen sind im Code vorbereitet (`app/config/marketing-compare.ts`,
`SEO_ROWS`, `AI_CONTENT_ROWS`, `VARIANT_IMAGE_ROWS`) und **nicht veröffentlicht**. Die Werte der
Konkurrenz-Apps sind vorläufig aus `docs/reference/COMPETITIVE_ANALYSIS.md` §2.2–2.4 übernommen
(Stand 01–08/2026, ohne Planstufen). Die Seiten sind außerhalb der Produktion als Vorschau
erreichbar: `/de/compare/seo?preview`, `/de/compare/ai-content?preview`,
`/de/compare/variant-images?preview`.

**Veröffentlicht 2026-10-01:** alle drei Themen mit den recherchierten Werten eingetragen und `published: true` (live erst mit dem Merge nach `master`).

**Erledigt 2026-10-01:** alle drei Aufträge ausgeführt, Ergebnisse in
`docs/reference/COMPETITIVE_ANALYSIS.md` §2.2–2.4 und vollständig mit URL je Punkt unter
`docs/reference/competitive-research/2026-10-01-{seo,variant-images,ai-content}.md`. Abweichungen
von den Kandidatenlisten unten (Ersatz jeweils nachrecherchiert, gleicher Tag):

| Thema | wird eingetragen | wird NICHT eingetragen |
|---|---|---|
| SEO (`SEO_COMPETITORS`) | Avada AI SEO Image Optimizer, StoreSEO, SEOWILL, TinySEO (früher TinyIMG), Booster | Yoast (176 Bewertungen) |
| Variantenbilder (`VARIANT_IMAGE_COMPETITORS`) | Rubik, SA Variant Image Automator, OP Color Swatch Variant Images, Variant Image Wizard, GG Image Slider | NS / N Color Swatches (143) |
| KI-Texte (`AI_CONTENT_COMPETITORS`) | Avada Blog, Profitonium, Tapita AI Blog, Essential AI Blog, StoreYa | Smartli (64), WritePilot (25) |

Die Belege der nicht eingetragenen Apps bleiben in den Belegdateien (markiert). Offen bleibt das
Eintragen in `marketing-compare.ts` (IDs, `*_ROWS`, `byPlan`) und die i18n-Texte.

Jeder Auftrag unten ist in sich vollständig und kann einem Agenten einzeln gegeben werden. Die
Punkte in Teil B entsprechen **eins zu eins** den Tabellenzeilen – bitte die Nummerierung nicht
ändern, dann lassen sich die Antworten direkt übernehmen.

Nach den Antworten: Pläne und Antworten in `marketing-compare.ts` eintragen (Planleiter statt
`pending`, `byPlan` wo der Plan entscheidet), Texte pro App in `i18n/marketing/compare/{de,en,es}.ts`
schreiben, `published: true` setzen, `COMPETITIVE_ANALYSIS.md` nachführen.

---

## Gemeinsame Regeln (gelten für alle drei Aufträge)

> **Quellen:** nur Primärquellen – der Eintrag im Shopify App Store (apps.shopify.com), die
> Preisseite und das Hilfe-Center des Anbieters. Keine Vergleichsblogs, keine Affiliate-Seiten,
> keine KI-Zusammenfassungen. Lies die Seiten im Rohtext (z. B. per curl) und zitiere die Stelle.
> Zu **jeder** Angabe gehört die URL, auf der sie steht.
>
> **„keine Angabe" ist nicht „Nein".** Was keine Quelle klar beantwortet, markierst du als
> „keine Angabe" – nicht raten. „Nein" nur, wenn eine Quelle es ausschließt (oder der Plan-Vergleich
> des Anbieters es für diesen Plan mit ✕ führt).
>
> **Ab welchem Plan:** Zu jeder Funktion gehört der kleinste Plan, der sie enthält. Wenn sich
> App Store und Anbieter-Website widersprechen, beide nennen.
>
> **Pläne:** vom günstigsten zum teuersten; Monatspreis mit Währung (bei „nur jährlich" den
> Jahrespreis mit Vermerk; „auf Anfrage" als solches); die Grenzen im Maß des Anbieters (Produkte,
> Seiten, Bilder, Credits, Wörter – pro Monat oder einmalig?); Testzeit der Bezahlpläne in Tagen.
>
> **Ausgabe pro App:** Tabelle A (Pläne), Tabelle B (Punkt | Antwort | ab Plan | Quelle-URL),
> Text C. Am Ende das Prüfdatum.

---

## Auftrag 1 – SEO-Apps

> Recherchiere für diese fünf Shopify-SEO-Apps den aktuellen Stand: **Yoast SEO for Shopify**,
> **StoreSEO**, **SEOWILL** (früher SEOAnt), **TinyIMG** (TinyIMG SEO & Image Optimizer) und
> **Booster SEO & Image Optimizer**. Falls eine davon nicht mehr zu den großen SEO-Apps im
> Shopify App Store gehört (gemessen an der Zahl der Bewertungen), sag das und nenne die App,
> die an ihre Stelle gehört – ohne sie mitzurecherchieren.
>
> [Gemeinsame Regeln oben einfügen]
>
> **A. Pläne** – je Plan: Name, Monatspreis, Grenzen (Produkte/Seiten/Bilder, KI-Credits pro
> Monat), Testzeit.
>
> **B. Funktionen** – „Ja", „Teilweise" (mit Kurzbegründung), „Nein" oder „keine Angabe", jeweils
> mit „ab Plan":
> 1. SEO-Titel und Meta-Beschreibungen per KI schreiben
> 2. Massen-Editor / Tabelle für Titel, Meta, Alt-Texte über den ganzen Katalog
> 3. Alt-Texte für Bilder per KI
> 4. Strukturierte Daten (JSON-LD) – welche Typen (Product, Breadcrumb, FAQ, Article, Organization …)?
> 5. Shop-Audit mit SEO-Score
> 6. SEO in übersetzten Sprachen: prüft oder korrigiert die App auch Titel/Meta der Übersetzungen?
> 7. Live-Crawl der Storefront (echte Seiten abrufen)
> 8. Kaputte Links finden – intern, extern?
> 9. 404-Erkennung und Weiterleitungen (automatisch?)
> 10. Interne Verlinkung (Vorschläge oder automatisch?)
> 11. Sitemap steuern (Seiten ausschließen, HTML-Sitemap)
> 12. Ladezeit messen (PageSpeed, echte Nutzerdaten)
> 13. Ladezeit automatisch verbessern (Lazy-Load, Minify, Eingriffe in den Theme-Code)
> 14. Bilder komprimieren / WebP
> 15. Google Search Console angebunden
> 16. Keyword-Tracking
> 17. Keyword-Suchvolumen / Difficulty
> 18. IndexNow / Instant Indexing
> 19. Local SEO (LocalBusiness-Schema, Standorte) und Backlink-Analyse
> 20. llms.txt und/oder agents.md
> 21. KI-Crawler in robots.txt steuern (GPTBot, OAI-SearchBot, PerplexityBot …)
> 22. Besuche aus KI-Assistenten messen (ChatGPT-, Perplexity-Referrals) oder Sichtbarkeit in KI-Antworten
> 23. Katalog-Check für KI-Shopping (fehlende GTIN, Marke, Kategorie)
>
> **C. Einordnung:** 3–4 Sätze, wie die App funktioniert und für wen; 3–4 Stärken mit Zitat aus
> dem Store-Eintrag; aktuelle Bewertung und Zahl der Bewertungen.

---

## Auftrag 2 – Variantenbild-Apps

> Recherchiere für diese fünf Shopify-Apps für mehrere Bilder pro Variante den aktuellen Stand:
> **Rubik Variant Images & Swatch**, **SA Variant Image Automator**, **NS Color Swatch Variant
> Images**, **Variant Image Wizard + Swatch** und **GG Product Page Image Slider**. Falls eine davon
> nicht mehr zu den großen Apps dieser Kategorie gehört (gemessen an der Zahl der Bewertungen), sag
> das und nenne die App, die an ihre Stelle gehört – ohne sie mitzurecherchieren.
>
> [Gemeinsame Regeln oben einfügen]
>
> **A. Pläne** – je Plan: Name, Monatspreis, Grenzen (Produkte, Bilder, KI-Bilderkennungen …),
> Testzeit.
>
> **B. Funktionen** – „Ja", „Teilweise" (mit Kurzbegründung), „Nein" oder „keine Angabe", jeweils
> mit „ab Plan":
> 1. Mehrere Bilder pro Variante
> 2. Galerie zeigt beim Variantenwechsel nur die Bilder dieser Variante
> 3. Kein Springen / Flackern beim Laden (wird das beworben?)
> 4. Zoom und Vollbild / Lightbox
> 5. Videos und 3D-Modelle in der Variantengalerie
> 6. Bilder automatisch zuweisen – womit? (KI-Bilderkennung, Dateiname, Alt-Text, Bildreihenfolge)
> 7. Erzeugt die App Zuordnungs-Schlüssel oder SKUs für die Varianten selbst?
> 8. Zuweisen per Drag & Drop
> 9. Massen-Upload von Bildern
> 10. Farb- oder Bild-Swatches auf der Produktseite
> 11. Swatches auf Kollektionsseiten
> 12. Produkte kombinieren (combined listings) oder nach Farbe aufteilen
> 13. Bilder komprimieren / WebP
> 14. Alt-Texte per KI
> 15. Alt-Texte in mehrere Sprachen übersetzen
>
> **C. Einordnung:** 3–4 Sätze, wie die App funktioniert und für wen; 3–4 Stärken mit Zitat aus
> dem Store-Eintrag; aktuelle Bewertung und Zahl der Bewertungen; „Built for Shopify" ja/nein.

---

## Auftrag 3 – KI-Text-Apps

> Ermittle zuerst die **fünf Shopify-Apps mit den meisten Bewertungen**, deren Hauptzweck ist,
> Produktbeschreibungen, SEO-Texte oder Blogartikel mit KI zu schreiben (Suche im App Store u. a.
> nach „AI product description", „AI content generator", „AI blog writer"). Reine Übersetzungs- oder
> SEO-Audit-Apps zählen nicht. **Smartli** und **WritePilot** sind unsere bisherigen Kandidaten –
> nimm sie auf, wenn sie dazugehören, und sag es, wenn nicht. Nenne die fünf mit Bewertungszahl und
> recherchiere dann jede davon.

**Ergebnis 2026-10-01 — diese fünf werden eingetragen** (`AI_CONTENT_COMPETITORS` in
`marketing-compare.ts` ersetzt `smartli`/`writepilot` durch sie):

| App | Bewertung | App Store | Schwerpunkt |
|---|---|---|---|
| Avada Blog SEO AEO Content | 4.9 (570) | https://apps.shopify.com/seoon-blog | Blog |
| AI Product Description‑ChatGPT (Profitonium) | 4.9 (530) | https://apps.shopify.com/automated-description-writing | Produkttexte |
| Tapita GEO Studio & AI Blog | 4.9 (484) | https://apps.shopify.com/tapita-ai-seo-blog-builder | Blog / GEO |
| Essential AI SEO: AI Blog Post | 5.0 (423) | https://apps.shopify.com/essential-seo-ai-blog-writer | Blog |
| ChatGPT‑AI Product Description (StoreYa) | 4.8 (372) | https://apps.shopify.com/product-description-ai | Produkttexte |

**Nicht eingetragen:** Smartli (3.8, 64 Bewertungen) und WritePilot (4.0, 25) — thematisch
passend, aber weit hinter Platz 5. Ebenfalls nicht: SEO-Suiten mit KI-Funktion (SEOWILL, Booster,
Avada SEO Suite …, gehören zu Auftrag 1) und Übersetzungs-Apps. Nächste Kandidaten, falls eine
der fünf wegfällt: Bloggle (337, eher Blog-Baukasten), GPTLab (284, eher KI-Sichtbarkeit), AI Blog
Agent (228).
>
> [Gemeinsame Regeln oben einfügen]
>
> **A. Pläne** – je Plan: Name, Monatspreis, Grenzen (Produkte, Credits, Wörter, Generierungen –
> pro Monat oder einmalig?), Testzeit. Dazu: welches KI-Modell bzw. welcher Anbieter pro Plan.
>
> **B. Funktionen** – „Ja", „Teilweise" (mit Kurzbegründung), „Nein" oder „keine Angabe", jeweils
> mit „ab Plan":
> 1. Wahl des KI-Anbieters oder -Modells durch den Händler
> 2. Eigener API-Schlüssel des Händlers möglich
> 3. KI-Nutzung im Preis enthalten (Credits, Kontingent)
> 4. Eigene Anweisungen / Tonalität / Markenstimme
> 5. Produktbeschreibungen
> 6. SEO-Titel und Meta-Beschreibungen
> 7. Alt-Texte für Bilder
> 8. Blogartikel
> 9. Text aus dem Produktbild (die KI „sieht" das Bild)
> 10. Bilder erzeugen
> 11. Werbetexte, E-Mails, Social-Media-Beiträge
> 12. Viele Texte auf einmal (Massen-Generierung)
> 13. Neue Produkte mit KI anlegen (nicht nur bestehende beschreiben)
> 14. Generierte Texte in andere Sprachen übersetzen / in Shopifys Übersetzungen schreiben
>
> **C. Einordnung:** 3–4 Sätze, wie die App funktioniert und für wen; 3–4 Stärken mit Zitat aus
> dem Store-Eintrag; aktuelle Bewertung und Zahl der Bewertungen.
