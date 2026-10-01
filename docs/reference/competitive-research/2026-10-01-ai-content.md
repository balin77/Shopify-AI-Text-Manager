# Recherche Auftrag 3 – KI-Text-Apps (Shopify)

Prüfdatum: **2026-10-01**. Alle Angaben aus dem Rohtext (curl) der genannten Seiten. Shopify-App-Store-Seiten mit `?locale=en` geladen. „keine Angabe" = keine Primärquelle beantwortet es (nicht „Nein").

---

## 0. Auswahl der fünf Apps

Methode: Suchergebnisse von apps.shopify.com (Turbo-Frame `search_page`, Seiten 1–5) für „ai product description", „ai content generator", „ai blog writer", dazu „product description generator", „ai blog", „ai copywriter", „ai writer", „chatgpt", „ai text". Werbeplätze („search_ad") ausgeschlossen. Bewertungszahlen danach auf der jeweiligen App-Seite gegengeprüft.

| # | App (Entwickler) | Bewertung | Anzahl | URL |
|---|---|---|---|---|
| 1 | Avada Blog SEO AEO Content (Avada SEO Suite) – im Hilfe-Center „Avada AI Blog Builder" | 4.9 | 570 | https://apps.shopify.com/seoon-blog |
| 2 | AI Product Description‑ChatGPT (Profitonium) – Website-Name „ADG" | 4.9 | 530 | https://apps.shopify.com/automated-description-writing |
| 3 | Tapita GEO Studio & AI Blog (Tapita) – im Hilfe-Center „Tapita AI SEO Blog Builder" | 4.9 | 484 | https://apps.shopify.com/tapita-ai-seo-blog-builder |
| 4 | Essential AI SEO: AI Blog Post (Essential Apps) | 5.0 | 423 | https://apps.shopify.com/essential-seo-ai-blog-writer |
| 5 | ChatGPT‑AI Product Description (StoreYa) | 4.8 | 372 | https://apps.shopify.com/product-description-ai |

**Nicht aufgenommen (mit Grund):**
- **Smartli** (Store-Name „ChatGPT: 9 AI Tools, 1 App!", Entwickler „Innovation Labs.") – **3.8 Sterne, 64 Bewertungen** (https://apps.shopify.com/smartli-ai-product-description). Gehört thematisch dazu, liegt aber weit hinter Platz 5 (372). Taucht in keiner der Suchen auf den ersten Seiten organisch auf; nur als „More apps like this" auf der Profitonium-Seite.
- **WritePilot ChatGPT AI Content** (Amasty) – **4.0 Sterne, 25 Bewertungen** (https://apps.shopify.com/ai-content-generator-by-amasty). Thematisch passend (Produkttexte in Masse), aber zu wenige Bewertungen.
- Mehr Bewertungen, aber Hauptzweck nicht KI-Text: SEO-Suiten mit KI-Funktionen (SEOWILL „AI SEO & AI Blog Post" 1.810, Booster 5.487, Avada SEO Suite 4.681, SEOLab 2.779, Tapita AI SEO Optimizer 2.626, TinySEO 2.520, SearchPie 2.440 u. a.) → Auftrag 1 / SEO-Audit; Übersetzungs-Apps (T Lab 1.035, Hextom 1.238) → ausgeschlossen. „Shopify Magic for product descriptions" ist eine eingebaute Shopify-Funktion, keine App.
- Nächste Kandidaten nach Platz 5: Bloggle 337 (Blog-Baukasten/Design, nicht KI-Text als Hauptzweck), GPTLab 284 (AEO/KI-Sichtbarkeit), AI Blog Agent 228, Avada AI Product Description 137 (Schwester-App von #1), Auto Blogs Agent 123, autoBlogger 88.

Hinweis: Drei der fünf sind **Blog-Apps** (Avada, Tapita, Essential), zwei **Produkttext-Apps** (Profitonium, StoreYa). Für die Vergleichszeile „Produktbeschreibungen" sind nur #2 und #5 echte Konkurrenten.

---

## 1. Avada Blog SEO AEO Content (Avada AI Blog Builder)

Store: https://apps.shopify.com/seoon-blog?locale=en · Preise: https://docs.avada.io/blog/pricing/ (Link „See all pricing options" im Store) · Hilfe-Center: https://docs.avada.io/blog/ (help.seoon.io leitet dorthin um)

### A. Pläne

| Plan | Preis | Grenzen | Testzeit | KI-Modell |
|---|---|---|---|---|
| Free | 0 USD | „Unlimited blog posts", „200,000 AI tokens (non-recurring)", 3 Autoren, laut Preisseite „10 SEO audits", „3 Youtube to blog posts" | – | keine Planangabe |
| Pro | 14,90 USD/Monat oder 149 USD/Jahr | „1,000,000 AI tokens per month" (Text nach Ausgabelänge, „Each generated image costs a flat 10,000 tokens"), unbegrenzte Autoren/SEO-Audits/mehrsprachige Posts | „7-day free trial" (nur erstes Abo) | keine Planangabe |
| All-in-one bundle | 49 USD/Monat oder 499 USD/Jahr | Pro in Blog Builder + SEO Suite + Product Copy; „There is no free trial" | keine | (Product Copy: „GPT-4.1 and Claude Sonnet 4") |
| Token-Packs (einmalig) | 9,90 / 19,50 / 39,90 USD | 0,5 / 1,5 / 5 Mio. Tokens, „never expire", auch im Free-Plan | – | – |

KI-Modell: Changelog Jan. 2026 „Updated the default AI model to GPT-5.1 … Merchants can also choose Claude 3.7 Sonnet … Credit costs vary by model"; Feb. 2026 „Added support for ChatGPT 5.2 as an AI model option"; Mai 2026 „moved the blog AI writer and AI assistant onto a new unified AI engine" (ob die Modellwahl danach besteht, sagt keine Quelle). Bilder: „powered by Replicate". Quelle: https://docs.avada.io/blog/changelog/ , https://docs.avada.io/blog/tools/ai-image-generator/
Preisänderung Aug. 2026: alte Pläne Basic 9,90 / Pro 24,90 / Advanced 49,90 USD entfallen (Changelog).

### B. Funktionen

| # | Punkt | Antwort | ab Plan | Quelle |
|---|---|---|---|---|
| 1 | Wahl KI-Anbieter/-Modell | Ja (Stand Changelog Jan./Feb. 2026): GPT-5.1 Standard, Claude 3.7 Sonnet wählbar, GPT-5.2 als Option. Aktueller Stand nach „unified AI engine" (Mai 2026) unklar | keine Planangabe | https://docs.avada.io/blog/changelog/ |
| 2 | Eigener API-Schlüssel | keine Angabe. (MCP-Anbindung eigener Assistenten: „Work you ask an assistant to do does not spend your AI tokens" – das ist kein API-Key in der App) | MCP: Pro | https://docs.avada.io/blog/mcp/ |
| 3 | KI-Nutzung im Preis | Ja: Tokens (Free 200.000 einmalig, Pro 1 Mio./Monat) + Zukauf-Packs | Free | https://docs.avada.io/blog/pricing/ |
| 4 | Eigene Anweisungen/Tonalität/Markenstimme | Ja: „Special instruction", „Writing tone", „Audience" im AI Writer; Knowledge Base mit „Tone & Voice", „Brand Vocabulary", die „the AI reads every time it generates a blog post" | Free (AI Writer „available for all users") | https://docs.avada.io/blog/ai-writer/ai-writer/ , https://docs.avada.io/blog/settings/ |
| 5 | Produktbeschreibungen | keine Angabe in dieser App (Produkttexte sind die separate App „Avada Product Copy", siehe Bundle) | – | https://docs.avada.io/blog/all-in-one-bundle/ |
| 6 | SEO-Titel und Meta | Teilweise: nur für Blogposts – AI Assistant erzeugt „SEO Title" und „SEO Description" | Pro (AI assistant im Pro-Plan; Doku: „in beta") | https://docs.avada.io/blog/ai-writer/ai-assistant/ , https://docs.avada.io/blog/pricing/ |
| 7 | Alt-Texte für Bilder | keine Angabe (nur manuelle „alt text management" im Bild-Element) | – | https://docs.avada.io/blog/changelog/ |
| 8 | Blogartikel | Ja: Quick mode + Full mode (Gliederung, Keywords), „Video to Blog" aus YouTube | Free (Video-to-Blog: Free 3, Pro unbegrenzt) | https://docs.avada.io/blog/ai-writer/ai-writer/ , https://docs.avada.io/blog/pricing/ |
| 9 | Text aus Produktbild | keine Angabe (Kontext per PDF-Upload und Produktdaten „title, description, features") | – | https://docs.avada.io/blog/ai-writer/ai-writer/ |
| 10 | Bilder erzeugen | Ja: AI Image Generator („powered by Replicate"), 1–4 Bilder je Anfrage, Featured Image automatisch, optional „one image per H2 section" | keine Planangabe (kostet 10.000 Tokens je Bild) | https://docs.avada.io/blog/tools/ai-image-generator/ |
| 11 | Werbetexte/E-Mails/Social | keine Angabe | – | – |
| 12 | Massen-Generierung | Teilweise: nur TL;DR-Zusammenfassungen „can be generated in bulk for all posts"; keine Massen-Erzeugung von Artikeln dokumentiert | Pro (AI Summary „available for Pro users") | https://docs.avada.io/blog/section/ai-summary-tl-dr/ |
| 13 | Neue Produkte anlegen | keine Angabe | – | – |
| 14 | Übersetzen / Shopify-Übersetzungen | Ja (Übersetzen): „translate blog posts into multiple languages using AI" (Changelog Juni 2025), Pro: „Unlimited multilingual blog posts". Ob in Shopifys Übersetzungen geschrieben wird: keine Angabe (Store-Datenzugriff nennt „Edit other data: Locales, translations") | Pro (Free laut Changelog-Fix „AI translate exclusion for free plan" ausgenommen) | https://docs.avada.io/blog/changelog/ , https://docs.avada.io/blog/pricing/ , Store |

### C. Einordnung
Blog-Baukasten im Shopify-Admin mit KI-Schreiber: Ein Prompt oder ein geführter 3-Schritte-Ablauf (Einstellungen → Gliederung → Artikel) erzeugt einen Blogpost, der im eigenen Editor mit Elementen (Produktkarten, Inhaltsverzeichnis, Countdown …) gestaltet und mit Shopify-Blogs synchronisiert wird. Dazu SEO-Score/Checkliste, Keyword-Recherche (Google Ads API), Bildgenerator und MCP-Zugang für ChatGPT/Claude. Für Händler, die regelmäßig Blog-Content für Google und KI-Suchen produzieren wollen – nicht für Produkttexte.
Stärken (Store): „Our AI content generator delivers smart topic suggestions, full-post drafts, and real-time SEO tips"; „Blog writer: Generate AI SEO articles in multiple languages"; „Keyword research: Find the perfect keywords to bring more organic traffic"; „Blog management: Manage, add, delete and sync blog posts to Shopify blogs".
Bewertung: **4.9 (570)**, „Built for Shopify" laut Store.

---

## 2. AI Product Description‑ChatGPT (Profitonium, „ADG")

Store: https://apps.shopify.com/automated-description-writing?locale=en · Website/Preise: https://copywriter.so/pricing , https://copywriter.so/features · Hilfe-Center: kein öffentliches gefunden (Website: Hilfe „inside the app", Setup-Call „from Help")

### A. Pläne

| Plan | Preis | Grenzen | Testzeit | KI-Modell |
|---|---|---|---|---|
| Free (Store-Name „Free Trial") | 0 USD | „100 Credits every month" | – | keine Planangabe |
| Basic | 19 USD/Monat oder 190 USD/Jahr | 2.000 Credits/Monat; Zusatz-Credits „$1 per 100" | keine Angabe | keine Planangabe |
| Standard | 49 USD/Monat oder 399 USD/Jahr | 11.000 Credits/Monat | keine Angabe | Website: „Additional AI model choices" |
| Catalog (nur im Store-Text unter Standard) | 129 USD/Monat oder 1.188 USD/Jahr | 40.000 Credits; „Stores with 5,000+ products can switch to Catalog" | keine Angabe | keine Angabe |
| Pro | 249 USD/Monat oder 1.990 USD/Jahr | 110.000 Credits/Monat, „Priority Video Call Support" | keine Angabe | wie Standard („Everything in Standard") |

Credits = Generierungsguthaben, Verbrauch modellabhängig: „Credits are a generation allowance, not a fixed number of completed product pages. The AI model, image inputs, web search, and the content you generate affect usage." (https://copywriter.so/pricing). Modelle: Website „GPT, Claude, and Gemini options, with availability depending on the plan and generation tool"; Store „Works with: Claude, Gemini, gpt 5 mini, GPT-5, grok" und „You can use ChatGPT, Gemini and Claude Models as required."
Widerspruch: Website-Preisseite zeigt Jahrespreise (15,83 / 33,25 / 165,83 USD effektiv/Monat) und **keinen Catalog-Plan**; Store nennt Catalog. Grok nur im Store, nicht auf der Website.

### B. Funktionen

| # | Punkt | Antwort | ab Plan | Quelle |
|---|---|---|---|---|
| 1 | Wahl KI-Anbieter/-Modell | Ja: „Choose an available model" – GPT, Claude, Gemini (Store zusätzlich grok) | Free/Basic mit Grundauswahl (nicht genau benannt); weitere Modelle ab Standard („Additional AI model choices") | https://copywriter.so/features , https://copywriter.so/pricing , Store |
| 2 | Eigener API-Schlüssel | keine Angabe | – | – |
| 3 | KI-Nutzung im Preis | Ja: Credits/Monat (100 bis 110.000), Zukauf 1 USD/100 | Free | Store, https://copywriter.so/pricing |
| 4 | Anweisungen/Tonalität/Markenstimme | Ja: „Tell the app how to structure the description, which details to emphasize, and what to leave out", Vorlagen; Store: „Tone and style", „Prompt templates" | Basic („Custom instructions & languages" auf der Website erst bei Basic) | https://copywriter.so/features , https://copywriter.so/pricing |
| 5 | Produktbeschreibungen | Ja | Free (Website: „Try product content generation"; Store listet „Product Descriptions" ab Basic) | https://copywriter.so/pricing , Store |
| 6 | SEO-Titel und Meta | Ja: „SEO titles & meta descriptions" | Store: „Product Meta Descriptions" ab Basic | https://copywriter.so/features , Store |
| 7 | Alt-Texte | Ja: „Describe product images with the dedicated alt-text tool"; Store „Image SEO: Add SEO friendly alt text to thousands of product images" | keine Planangabe | https://copywriter.so/features , Store |
| 8 | Blogartikel | keine Angabe (nur JSON-LD für „articles") | – | https://copywriter.so/features |
| 9 | Text aus Produktbild | Ja: „include product images as input"; Store: „can analyze product images" | Store nennt es unter „Pro Features: Use product images, metadata and web search" – Website: „with supported model and generation options" (kein Plan) | Store, https://copywriter.so/guides/generate-product-descriptions-from-images |
| 10 | Bilder erzeugen | keine Angabe (nur Bildkompression „available on Standard and Pro") | – | https://copywriter.so/features |
| 11 | Werbetexte/E-Mails/Social | keine Angabe | – | – |
| 12 | Massen-Generierung | Ja: „Select products or a collection"; Automatik bei neuen Produkten; Shopify-Flow-Aktion „Generate Content" | Basic („Bulk product content", „Automatic content on import") | https://copywriter.so/pricing , https://copywriter.so/features |
| 13 | Neue Produkte anlegen | keine Angabe (nur Texte für neu importierte Produkte: „automatic generation runs when new products are added") | – | https://copywriter.so/pricing |
| 14 | Übersetzen / Shopify-Übersetzungen | Teilweise: „Generate content in 30+ languages"; Store: „can translates into multiple local languages". Schreiben in Shopifys Übersetzungen: keine Angabe (Website-Ratgeber verweist auf „Translate & Adapt and compatible translation apps"; Store-Datenzugriff nennt Schreibrecht auf „translations") | Basic („Custom instructions & languages") | Store, https://copywriter.so/features , https://copywriter.so/guides/translate-product-descriptions-multiple-languages |

### C. Einordnung
Katalog-Werkzeug für Produkttexte: Produkte oder Kollektionen auswählen, Felder (Beschreibung, Titel, SEO-Titel/Meta, Tags, Alt-Text, Kollektionsbeschreibung) und Sprache wählen, eigene Anweisungen hinterlegen, Credit-Schätzung prüfen, generieren, prüfen und speichern. Modelle GPT/Claude/Gemini wählbar, optional mit Produktbild und Websuche als Kontext; Automatik für neue Produkte und Shopify Flow. Dazu Nebenfunktionen wie SEO-Audit, JSON-LD und Bildkompression. Für Händler mit großen oder häufig wechselnden Katalogen (Dropshipping, Lieferanten-Importe).
Stärken (Store): „Bulk Generation: Create product descriptions, titles, and SEO metadata in bulk"; „Customization & Languages: Create content in 30+ languages and custom templates"; „Automation: Auto generate product content instantly when you add new products"; „You can use ChatGPT, Gemini and Claude Models as required."
Bewertung: **4.9 (530)**, „Built for Shopify" laut Store.

---

## 3. Tapita GEO Studio & AI Blog (Tapita AI SEO Blog Builder)

Store: https://apps.shopify.com/tapita-ai-seo-blog-builder?locale=en · Preise (Website): https://tapita.io/pages/ai-blog-builder · Hilfe-Center (Zoho Desk, per Portal-API gelesen): https://tapita0.zohodesk.com/portal/en/kb/tapita-ai-seo-blog-builder (6 Artikel, Kategorie „Introduction")

### A. Pläne

| Plan | Preis | Grenzen | Testzeit | KI-Modell |
|---|---|---|---|---|
| Store | „Free" – **keine Plankarten** im Store | – | – | keine Angabe |
| Free (Website) | 0 USD; „+$5 Grow plan, +$30 Advanced plan, +$60 Shopify Plus" | „Unlimited blog posts", „50 AI credits (non-recurring)" | – | keine Angabe |
| Pro (Website) | 9,99 USD/Monat oder 101,89 USD/Jahr; dieselben Aufschläge je Shopify-Plan | „250 AI credits/month (more credits available)", Planung, Content-Strategie, mehrsprachige Posts | keine Angabe | keine Angabe |
| Credits (Hilfe-Center) | „Every 50 AI credit will cost $1, and the minimum value is $2 for 100 AI credit - maximum value … $200 for 10,000 AI credit" | Titel 1 Credit, Gliederung 3 Credits | – | – |

Widersprüche: Store zeigt nur „Free"; Website zeigt Pro 9,99 USD (+ Aufschlag nach Shopify-Plan; widersprüchlich auch zum Free-Plan, der ebenfalls „+$5 Grow plan …" trägt). Hilfe-Center-Changelog (17/9/2025): „Content strategy feature is now available from **Starter** plan" – einen Starter-Plan nennt keine Preisseite. Changelog 16/04/2025: „Free version is available for all users with origin 100 credits" vs. Website 50 Credits. Website-Seite trägt noch den alten Namen „AI SEO Blog Builder"; der Store beschreibt inzwischen „GEO Studio" (GEO-Score, KI-Sichtbarkeit), die in keiner Preisquelle vorkommen.

### B. Funktionen

| # | Punkt | Antwort | ab Plan | Quelle |
|---|---|---|---|---|
| 1 | Wahl KI-Anbieter/-Modell | keine Angabe | – | – |
| 2 | Eigener API-Schlüssel | keine Angabe | – | – |
| 3 | KI-Nutzung im Preis | Ja: Credits (Free 50 einmalig, Pro 250/Monat), Zukauf | Free | https://tapita.io/pages/ai-blog-builder , https://tapita0.zohodesk.com/portal/en/kb/articles/getting-started-with-tapita-ai-seo-blog-builder |
| 4 | Anweisungen/Tonalität/Markenstimme | Ja: „Writing Style … over 18 different writing styles", „Voice Tone … more than 40 different tones", „Business description", „Target customer" | keine Planangabe | https://tapita0.zohodesk.com/portal/en/kb/articles/how-to-create-a-blog-post-using-ai |
| 5 | Produktbeschreibungen | keine Angabe (Produkte nur in Blogposts einbinden: „Insert Product into AI Post") | – | https://tapita0.zohodesk.com/portal/en/kb/articles/changelog-tapita-ai-seo-blog-builder |
| 6 | SEO-Titel und Meta | Teilweise: nur Blog – „generate blog attributes using AI: excerpt, tags, SEO description"; Titel per „Generate Title" | keine Planangabe | Changelog (s. o.), How-to-create-Artikel |
| 7 | Alt-Texte | keine Angabe (Store-Kategorie-Tags „Alt tags"/„ALT text" ohne Beschreibung einer KI-Funktion) | – | Store |
| 8 | Blogartikel | Ja; Store zusätzlich „FAQs, buyer's guides, how-tos and trust pages" | Free | Store, How-to-create-Artikel |
| 9 | Text aus Produktbild | keine Angabe | – | – |
| 10 | Bilder erzeugen | Ja: „Generate image" für Featured Images; „Generate with AI for Image elements" | keine Planangabe | How-to-create-Artikel, Changelog |
| 11 | Werbetexte/E-Mails/Social | keine Angabe | – | – |
| 12 | Massen-Generierung | Ja: Content-Strategie „Bulk Generate" schreibt und plant mehrere Posts | Website: Pro („Content strategy"); Changelog: „from Starter plan" | https://tapita0.zohodesk.com/portal/en/kb/articles/how-to-schedule-blog-posts-in-content-strategy-tapita-seo-speed , Website |
| 13 | Neue Produkte anlegen | keine Angabe | – | – |
| 14 | Übersetzen / Shopify-Übersetzungen | Ja (Übersetzen): „One-click multi-language AI translations"; ob in Shopifys Übersetzungen: keine Angabe (Store-Datenzugriff nennt Schreibrecht auf „translations") | Pro | https://tapita.io/pages/ai-blog-builder , Changelog (17/9/2025) |

### C. Einordnung
Blog- und Content-Studio im Shopify-Admin: Formular mit Sprache, Stil, Ton, Geschäftsbeschreibung, Zielgruppe, Keywords, Titel und Gliederung → KI-Artikel, im Drag-and-drop-Editor nachbearbeiten, Featured Image per KI, veröffentlichen oder planen. Eine Content-Strategie schlägt Themenpläne vor und erzeugt/plant Posts in Masse; der Store bewirbt zusätzlich GEO-Score und KI-Sichtbarkeit. Für Händler, die Blog/Ratgeber-Inhalte für Google und KI-Suchmaschinen aufbauen wollen.
Stärken (Store): „Get cited by ChatGPT, Gemini & AI engines and reach shoppers ready to buy"; „Rank higher on Google with SEO-optimized blogs created in minutes"; „Plan a content calendar and schedule posts to publish on autopilot"; „Track your GEO score and AI visibility, and refresh posts to keep ranking".
Bewertung: **4.9 (484)**, „Built for Shopify" laut Store.

---

## 4. Essential AI SEO: AI Blog Post (Essential Apps)

Store: https://apps.shopify.com/essential-seo-ai-blog-writer?locale=en · Website: https://essential-apps.com/ai-blog-writer · Hilfe-Center (Help Scout): https://essentials-docs.helpscoutdocs.com/collection/104-essential-ai-seo-ai-blog-post (4 Artikel)

### A. Pläne

| Plan | Preis | Grenzen | Testzeit | KI-Modell |
|---|---|---|---|---|
| Free | 0 USD | „3 monthly blog post generations", „All Premium features" | – | keine Angabe |
| Starter | 9,99 USD/Monat oder 95,88 USD/Jahr | 30 Blogpost-Generierungen/Monat, „Create articles in bulk", „Generate AI images" | keine Angabe | keine Angabe |
| Essential | 29,99 USD/Monat oder 287,88 USD/Jahr | 100/Monat | keine Angabe | keine Angabe |
| Professional | 99,99 USD/Monat oder 959,88 USD/Jahr | 300/Monat | keine Angabe | keine Angabe |

KI-Modell: Store nur „harnesses the latest in artificial intelligence technology (like chatgpt blog writer)", „Works with: … Chat GPT". Kein Modell pro Plan.
**Widerspruch:** Website: „The Essential Shopify AI Blog Writer is completely free" und FAQ „How much does it cost? … completely free, with no paid plan required" – Store listet drei Bezahlpläne, Hilfe-Center hat Artikel „How to update your Essential AI Blog Post plan" (Monat/Jahr, Bezahlpläne). Ebenso: Store „generate & auto post SEO friendly blog articles" vs. Website-FAQ „Does it publish blog posts automatically? No, every post is generated as a hidden draft" vs. Hilfe-Center „Visibility – Determines if the post is published immediately (Visible) or saved as a draft (Hidden)". Free-Plan „All Premium features" vs. „Create articles in bulk"/„Generate AI images" erst ab Starter aufgeführt.

### B. Funktionen

| # | Punkt | Antwort | ab Plan | Quelle |
|---|---|---|---|---|
| 1 | Wahl KI-Anbieter/-Modell | keine Angabe | – | – |
| 2 | Eigener API-Schlüssel | keine Angabe | – | – |
| 3 | KI-Nutzung im Preis | Ja: Blogpost-Generierungen pro Monat (3/30/100/300) | Free | Store |
| 4 | Anweisungen/Tonalität/Markenstimme | Teilweise: „Tone … to match your brand's voice", Keywords, eigene Gliederung, Länge; keine freie Marken-/Stilanweisung dokumentiert | Free | https://essentials-docs.helpscoutdocs.com/article/122-how-to-generate-the-ai-blog-post |
| 5 | Produktbeschreibungen | Nein: Store-Datenzugriff nur „Edit Online Store: Online Store pages" – kein Produktzugriff | – | Store (Data access) |
| 6 | SEO-Titel und Meta | keine Angabe (nur „SEO optimized articles") | – | Store |
| 7 | Alt-Texte | keine Angabe | – | – |
| 8 | Blogartikel | Ja, 13 Sprachen | Free | Store, Website |
| 9 | Text aus Produktbild | keine Angabe | – | – |
| 10 | Bilder erzeugen | Ja: „Generate featured image … uses AI to create a unique visual" | Store: „Generate AI images" ab Starter (Free: „All Premium features" – widersprüchlich) | Help-Artikel 122, Store |
| 11 | Werbetexte/E-Mails/Social | keine Angabe | – | – |
| 12 | Massen-Generierung | Ja: „Bulk blog generator", „Create articles in bulk" | Starter | Store |
| 13 | Neue Produkte anlegen | Nein: kein Produktzugriff (s. Punkt 5) | – | Store (Data access) |
| 14 | Übersetzen / Shopify-Übersetzungen | Teilweise: Artikel direkt in 13 Sprachen erzeugen; Übersetzen bestehender Texte / Schreiben in Shopifys Übersetzungen: keine Angabe, Datenzugriff enthält keine „translations" | Free | Store, Website |

### C. Einordnung
Schlanker KI-Blogschreiber: Thema, Keywords, Ton, Länge und Gliederung eingeben, Artikel (optional mit KI-Titelbild) generieren lassen; der Post landet als Shopify-Blogartikel (standardmäßig verborgen) und funktioniert mit jedem Blog-Baukasten. Kein eigener Editor, keine Produkttexte. Für Händler, die günstig regelmäßig SEO-Blogposts produzieren wollen.
Stärken (Store): „Generate AI blog posts in 13 languages - start blogging in multiple languages!"; „Bulk blog generator - generative ai auto blog copywriter & smart SEO manager."; „Essential SEO AI Blog app is compatible with blog builders & seo optimizer!"
Bewertung: **5.0 (423)**, „Built for Shopify" laut Store (Website: „350+" Bewertungen, „5,300+ active stores").

---

## 5. ChatGPT‑AI Product Description (StoreYa, „Product Description AI Wizard")

Store: https://apps.shopify.com/product-description-ai?locale=en · Website: https://www.storeya.com/public/ProductDescriptionWizard (keine eigene Preisseite; https://www.storeya.com/public/pricing verlinkt „View Pricing" ins Leere, `href="#"`) · Hilfe-Center (Zendesk, öffentlich): Sektion mit **einem** Artikel https://storeya.zendesk.com/hc/en-us/articles/15125566496530-Why-should-you-use-Product-Description-Wizard (Stand 2023)

### A. Pläne

| Plan | Preis | Grenzen | Testzeit | KI-Modell |
|---|---|---|---|---|
| Free | 0 USD | „Add up to 120 descriptions manually", „A one-time blog post generation" | – | keine Planangabe |
| Starter | 15 USD/Monat | „2,500 credits every month", „Bulk generate 2.5K product descriptions", „8 blog posts, images and newsletter copy" | keine Angabe | keine Planangabe |
| Pro | 30 USD/Monat | 12.000 Credits/Monat, 16 Blogposts | keine Angabe | keine Planangabe |
| Elite | 100 USD/Monat | 120.000 Credits/Monat, 30 Blogposts | keine Angabe | keine Planangabe |

KI-Modell: Store „Works with: ChatGPT, ChatGPT-4.1, ChatGPT-4.5, ChatGPT-4o, GPT-5, GPT-5 mini"; keine Zuordnung zu Plänen. Kein Jahrespreis angegeben.

### B. Funktionen

| # | Punkt | Antwort | ab Plan | Quelle |
|---|---|---|---|---|
| 1 | Wahl KI-Anbieter/-Modell | keine Angabe (mehrere GPT-Modelle unter „Works with", aber keine Wahl beschrieben; nur OpenAI genannt) | – | Store |
| 2 | Eigener API-Schlüssel | keine Angabe | – | – |
| 3 | KI-Nutzung im Preis | Ja: Credits/Monat (Free: 120 Beschreibungen manuell) | Free | Store |
| 4 | Anweisungen/Tonalität/Markenstimme | Teilweise: Tonwahl („friendly …, fast shipping, affordability …, humorous tone"); Store-Tags „Prompt templates", „Tone and style"; freie Anweisungen nicht beschrieben | keine Planangabe | Store, Zendesk-Artikel |
| 5 | Produktbeschreibungen | Ja | Free (manuell, bis 120) | Store |
| 6 | SEO-Titel und Meta | Ja: „Generate meta titles & meta descriptions" | Starter | Store |
| 7 | Alt-Texte | keine Angabe | – | – |
| 8 | Blogartikel | Ja | Free (einmalig), Starter 8/Monat, Pro 16, Elite 30 | Store |
| 9 | Text aus Produktbild | keine Angabe | – | – |
| 10 | Bilder erzeugen | Teilweise/unklar: „Generate blog posts, including post images" – ob KI-erzeugt, sagt keine Quelle | Starter („blog posts, images and newsletter copy") | Store |
| 11 | Werbetexte/E-Mails/Social | Teilweise: Newsletter („newsletter copy", Website: „email newsletters"); Werbe-/Social-Texte keine Angabe | Starter | Store, https://www.storeya.com/public/ProductDescriptionWizard |
| 12 | Massen-Generierung | Ja: „Bulk generate 2.5K product descriptions" | Starter | Store |
| 13 | Neue Produkte anlegen | keine Angabe | – | – |
| 14 | Übersetzen / Shopify-Übersetzungen | Teilweise: „Generate descriptions in any language"; Schreiben in Shopifys Übersetzungen: Datenzugriff enthält keine „translations" (nur Produkte, Inventar, Kollektionen, Seiten, Files, Navigation) | Free | Store (Pricing + Data access) |

Zusatz: „Get found on ChatGPT & more with LLM.txt" in allen Plänen (Store).

### C. Einordnung
Einfacher Produkttext-Generator eines Werbeanbieters (StoreYa, sonst Google-/Facebook-Ads): Ton wählen, Produktbeschreibungen einzeln oder in Masse erzeugen, Meta-Titel/-Beschreibungen ab Starter, dazu eine kleine Zahl Blogposts mit Bildern und Newsletter-Texte pro Monat sowie eine llms.txt. Dokumentation ist sehr dünn (ein Hilfeartikel von 2023, keine eigene Preisseite). Für kleine Shops, die günstig und schnell Produkttexte wollen.
Stärken (Store): „Automate product description creation and save your time and money"; „Generate blog posts, including post images and newsletter copy"; „Improve your SEO by adding meta titles, Meta descriptions and Blog posts"; „Customize tone, generate in bulk, and preview before publishing."
Bewertung: **4.8 (372)**, „Built for Shopify" laut Store.

---

## Wichtigste Widersprüche (App Store vs. Website/Hilfe)

1. **Essential AI Blog:** Website „completely free, with no paid plan required" – Store: drei Bezahlpläne (9,99 / 29,99 / 99,99 USD), Hilfe-Center beschreibt Planwechsel. Auch Veröffentlichung: Store „auto post", Website „No, every post is generated as a hidden draft", Hilfe-Center: Sichtbarkeit wählbar.
2. **Tapita:** Store nur „Free" ohne Plankarten – Website Pro 9,99 USD/Monat mit Aufschlägen je Shopify-Plan; Hilfe-Center-Changelog spricht von einem „Starter plan" und 100 Start-Credits (Website: 50).
3. **Profitonium:** Store nennt einen Catalog-Plan (129 USD/Monat, 40.000 Credits) und „grok", die Website-Preisseite nicht. Bildanalyse im Store als „Pro Features" bezeichnet, Website ohne Plan.
4. **Avada:** Store-Free-Plan ohne „10 SEO audits"/„3 Youtube to blog posts", die die Preisseite nennt; Modellwahl (GPT-5.1/Claude 3.7 Sonnet/GPT-5.2) nur aus Changelogs vor der „unified AI engine" (Mai 2026) belegt.
5. **StoreYa:** Website-Preisseite verlinkt die App mit „View Pricing", Link führt ins Leere (`#`); einzige Preisquelle ist der Store.

## Nicht belegbar
- Eigener API-Schlüssel (Punkt 2): bei keiner der fünf eine Angabe.
- KI-Modell pro Plan: nur Profitonium nennt eine Planabhängigkeit („Additional AI model choices" ab Standard); Tapita und Essential nennen gar kein Modell konkret (Essential nur „like chatgpt").
- Testzeit der Bezahlpläne: nur Avada (7 Tage) belegt; bei den anderen keine Angabe.
- Schreiben in Shopifys Übersetzungen (Punkt 14): bei keiner App ausdrücklich beschrieben; nur Indizien über die Datenzugriffs-Angaben im Store (Avada, Profitonium, Tapita: Schreibrecht „translations"; Essential, StoreYa: keins).
- Profitonium hat kein öffentliches Hilfe-Center; StoreYa nur einen Hilfeartikel von 2023.

Prüfdatum: 2026-10-01 (alle Seiten an diesem Tag per curl geladen).
