/**
 * THE ROADMAP. One file, two readers.
 *
 * `.server.ts` is load-bearing: the internal entries carry pricing plans and
 * strategy notes, and the first cut imported this file from the route
 * COMPONENT, which put every one of them into the public JavaScript bundle —
 * "never rendered" was true of the DOM and false of the wire. With this
 * suffix a client-side import fails the build; the /roadmap loader reads the
 * file and returns only the public fields, in only the page's language.
 *
 * Development plans here — what is being built, what is next, what was
 * considered and dropped — and the public website renders the entries marked
 * `visibility: "public"` at /roadmap in three languages. There is no second
 * list anywhere: docs/ROADMAP.md is a pointer to this file, and the analyses
 * it used to carry (pricing, limits, JSON-LD decisions) live in
 * docs/reference/ as decision records, not as roadmap items.
 *
 * The rules, and why each one is a rule:
 *
 * - A PUBLIC entry carries title and body in all three site languages, and
 *   the type makes that mandatory: a merchant reading the Spanish site must
 *   not meet an English card. An INTERNAL entry is a one-liner plus notes and
 *   is never rendered, so it may say anything — infrastructure, prices,
 *   what a competitor charges.
 * - `status` is the ONLY thing that moves an entry between the website's
 *   sections. Shipping a feature is changing one word here, not editing a
 *   page. `shippedOn` is what sorts the "recently shipped" list.
 * - No promised dates on public entries unless one is really committed
 *   (`target`, free text like "2027"). The first roadmap carried quarters for
 *   everything and every one of them slipped; a public date that slips reads
 *   as a broken promise, while an ordered list reads as priorities.
 * - A DROPPED entry stays, with the reason in `notes`. The reason is the
 *   valuable part — it stops the same idea from being re-proposed without the
 *   argument that killed it (see content-templates).
 * - Order within a status is priority order: the website keeps it.
 */

export type RoadmapStatus = "shipped" | "in-progress" | "planned" | "considering" | "dropped";

export type RoadmapArea =
  | "ai"
  | "translations"
  | "bulk"
  | "seo"
  | "aeo"
  | "media"
  | "structure"
  | "platform"
  | "website";

export interface Localized {
  en: string;
  de: string;
  es: string;
}

interface RoadmapEntryBase {
  /** Stable id; also the anchor on the website. */
  id: string;
  status: RoadmapStatus;
  area: RoadmapArea;
  /** ISO date (YYYY-MM or YYYY-MM-DD). Sorts the shipped list; shown on the site. */
  shippedOn?: string;
  /** A committed date, free text ("2027"). Omit unless it is really committed. */
  target?: string;
  /** Development notes. Never rendered, in any language, for any visibility. */
  notes?: string;
  /** A document with the reasoning, relative to the repo root. Never rendered. */
  ref?: string;
}

export interface PublicRoadmapEntry extends RoadmapEntryBase {
  visibility: "public";
  title: Localized;
  body: Localized;
}

export interface InternalRoadmapEntry extends RoadmapEntryBase {
  visibility: "internal";
  title: string;
}

export type RoadmapEntry = PublicRoadmapEntry | InternalRoadmapEntry;

export const ROADMAP: RoadmapEntry[] = [
  // ── In progress ───────────────────────────────────────────────────────
  {
    id: "website-media",
    visibility: "public",
    status: "in-progress",
    area: "website",
    title: {
      en: "Screenshots and walkthrough videos on this site",
      de: "Screenshots und Video-Rundgänge auf dieser Website",
      es: "Capturas y vídeos guiados en esta web",
    },
    body: {
      en: "Every image position on this site is a placeholder today. The screenshots and five short videos are being produced.",
      de: "Jede Bildposition auf dieser Website ist heute ein Platzhalter. Die Screenshots und fünf kurze Videos entstehen gerade.",
      es: "Cada posición de imagen de esta web es hoy un marcador. Las capturas y cinco vídeos cortos se están produciendo.",
    },
    notes: "Slots in app/config/marketing-images.ts and marketing-videos.ts; the alt texts there are the shooting brief.",
  },

  // ── Planned (priority order) ──────────────────────────────────────────
  {
    id: "tone-presets",
    visibility: "public",
    status: "planned",
    area: "ai",
    title: {
      en: "Tone presets",
      de: "Tonalitäts-Vorlagen",
      es: "Ajustes de tono predefinidos",
    },
    body: {
      en: "Today the writing style is a sentence you write yourself. Presets — factual, warm, premium — give you a tested starting point to pick instead.",
      de: "Heute ist der Schreibstil ein Satz, den Sie selbst formulieren. Vorlagen — sachlich, warm, hochwertig — geben einen erprobten Ausgangspunkt zum Auswählen.",
      es: "Hoy el estilo de redacción es una frase que usted mismo escribe. Los ajustes — objetivo, cercano, premium — ofrecen un punto de partida probado para elegir.",
    },
    notes: "The shop-wide free-text style already exists and every generation reads it: AIInstructions.writingStyleInstructions (AIInstructionsTabs.tsx, getWritingStyleInstructions). What is missing is only the picker — the old body ('instead of repeating the instruction per field') described a problem that no longer exists.",
  },
  {
    id: "scheduled-translations",
    visibility: "public",
    status: "planned",
    area: "translations",
    title: {
      en: "Scheduled translation runs",
      de: "Zeitgesteuerte Übersetzungsläufe",
      es: "Traducciones programadas",
    },
    body: {
      en: "Fill the missing translations of a filter set on a schedule, so a catalogue that grows daily is never behind in a language.",
      de: "Die fehlenden Übersetzungen einer Auswahl nach Zeitplan ergänzen, damit ein täglich wachsender Katalog in keiner Sprache hinterherhinkt.",
      es: "Completar las traducciones que faltan de una selección según un horario, para que un catálogo que crece a diario nunca se quede atrás en un idioma.",
    },
    notes: "Building blocks exist: the manual 'add missing translations' run (/app/bulk/translate, task bulkEditorTranslate) and a daily sweep (translation-drift-auto-run.service.ts). The sweep only acts on CHANGED primary text; a new product or never-translated, unchanged content is not picked up. This entry is the schedule on top of the manual run.",
  },
  {
    id: "translation-dashboard",
    visibility: "public",
    status: "planned",
    area: "translations",
    title: {
      en: "Translation coverage dashboard",
      de: "Übersetzungs-Dashboard",
      es: "Panel de cobertura de traducciones",
    },
    body: {
      en: "One view of how complete every language is, per content type — what is missing, what went stale, what was refreshed.",
      de: "Eine Ansicht, wie vollständig jede Sprache pro Inhaltstyp ist — was fehlt, was veraltet war, was erneuert wurde.",
      es: "Una vista de lo completo que está cada idioma por tipo de contenido — qué falta, qué quedó obsoleto, qué se renovó.",
    },
    notes: "Partial precursors: the hreflang audit's LocaleCoverage (hreflang.service.ts — products/collections/articles/pages only, 'translated' = any of 4 keys, no stale dimension), the per-selection missing list on /app/bulk/translate, and the missing-translation dots in item lists. No per-language overview exists.",
  },
  {
    id: "deepl",
    visibility: "public",
    status: "planned",
    area: "translations",
    title: {
      en: "DeepL as a translation provider",
      de: "DeepL als Übersetzungsanbieter",
      es: "DeepL como proveedor de traducción",
    },
    body: {
      en: "Use DeepL for translations beside the AI providers, with your own key like everything else in the app.",
      de: "DeepL neben den KI-Anbietern für Übersetzungen nutzen — mit eigenem Schlüssel, wie alles andere in der App.",
      es: "Usar DeepL para las traducciones junto a los proveedores de IA, con su propia clave como todo lo demás en la aplicación.",
    },
  },
  {
    id: "version-history",
    visibility: "public",
    status: "planned",
    area: "structure",
    title: {
      en: "Version history",
      de: "Versionsverlauf",
      es: "Historial de versiones",
    },
    body: {
      en: "See what a field said before a save — yours or the AI's — and put it back.",
      de: "Sehen, was ein Feld vor einer Speicherung enthielt — von Ihnen oder der KI — und es zurückholen.",
      es: "Ver lo que decía un campo antes de guardar — suyo o de la IA — y restaurarlo.",
    },
  },
  {
    id: "seo-score-tracking",
    visibility: "public",
    status: "planned",
    area: "seo",
    title: {
      en: "SEO score over time",
      de: "SEO-Score im Zeitverlauf",
      es: "Puntuación SEO a lo largo del tiempo",
    },
    body: {
      en: "Keep the crawl results as a series, so a change to the shop shows up as a line and not as a number you have to remember.",
      de: "Die Crawl-Ergebnisse als Verlauf behalten, damit eine Änderung am Shop als Linie sichtbar wird und nicht als Zahl, die man sich merken muss.",
      es: "Conservar los resultados del rastreo como serie, para que un cambio en la tienda aparezca como una línea y no como un número que hay que recordar.",
    },
    notes: "The DATA is already there: SeoScoreSnapshot is written by the nightly audit with plan-based retention (plans.ts scoreHistoryDays: Pro 30, Max 365), and getAuditTrend() in audit.service.ts exists — with no caller. SeoKeywordSnapshot is likewise written and never displayed. The plan tab already SELLS 'Score-Verlauf: {days} Tage' (SettingsPlanTab.tsx), so this is owed, not optional: the chart is the whole remaining work. Crawl diff (two snapshots) is shipped separately.",
  },

  // ── Considering ───────────────────────────────────────────────────────
  {
    id: "brand-voice",
    visibility: "public",
    status: "considering",
    area: "ai",
    title: {
      en: "Brand voice from your own texts",
      de: "Markenstimme aus Ihren eigenen Texten",
      es: "Voz de marca a partir de sus propios textos",
    },
    body: {
      en: "Let the app derive a style guide from the texts you already wrote, instead of describing your tone by hand.",
      de: "Die App leitet einen Stil-Leitfaden aus den Texten ab, die Sie schon geschrieben haben, statt dass Sie Ihren Ton beschreiben.",
      es: "Que la aplicación derive una guía de estilo de los textos que ya escribió, en lugar de describir su tono a mano.",
    },
  },
  {
    id: "ab-suggestions",
    visibility: "public",
    status: "considering",
    area: "ai",
    title: {
      en: "Alternative versions to choose from",
      de: "Alternative Fassungen zur Auswahl",
      es: "Versiones alternativas entre las que elegir",
    },
    body: {
      en: "Two or three takes on a title or description side by side, rather than one suggestion to accept or regenerate.",
      de: "Zwei oder drei Fassungen eines Titels oder einer Beschreibung nebeneinander, statt eines Vorschlags zum Übernehmen oder Neu-Generieren.",
      es: "Dos o tres versiones de un título o descripción una junto a otra, en lugar de una sola sugerencia que aceptar o regenerar.",
    },
  },
  {
    id: "content-quality",
    visibility: "public",
    status: "considering",
    area: "seo",
    title: {
      en: "Content quality signals",
      de: "Qualitätssignale für Texte",
      es: "Señales de calidad del contenido",
    },
    body: {
      en: "Beyond readability and thin pages: similar phrasing across product descriptions, and fields nobody has ever filled in or reworked.",
      de: "Über Lesbarkeit und dünne Seiten hinaus: ähnliche Formulierungen über Produktbeschreibungen hinweg und Felder, die nie jemand ausgefüllt oder überarbeitet hat.",
      es: "Más allá de la legibilidad y las páginas escasas: frases similares entre descripciones de productos y campos que nadie ha rellenado ni revisado nunca.",
    },
    notes: "Already shipped and therefore removed from the body: readability (readability.ts), thin pages per resource type (onpage.service.ts findThinPages) and EXACT duplicate titles/meta descriptions (crawl.service.ts). Missing: fuzzy similarity across descriptions, and any record of whether a field was ever edited.",
  },
  {
    id: "approval-workflow",
    visibility: "public",
    status: "considering",
    area: "platform",
    title: {
      en: "Review before publish",
      de: "Freigabe vor der Veröffentlichung",
      es: "Revisión antes de publicar",
    },
    body: {
      en: "For shops where one person writes and another approves: AI output lands in a queue instead of in the field.",
      de: "Für Shops, in denen eine Person schreibt und eine andere freigibt: KI-Texte landen in einer Warteschlange statt im Feld.",
      es: "Para tiendas donde una persona escribe y otra aprueba: la salida de la IA llega a una cola en lugar de al campo.",
    },
  },
  {
    id: "multi-store",
    visibility: "public",
    status: "considering",
    area: "platform",
    title: {
      en: "Several shops in one account",
      de: "Mehrere Shops in einem Konto",
      es: "Varias tiendas en una cuenta",
    },
    body: {
      en: "Shared instructions, glossary and settings across the shops of one merchant or agency.",
      de: "Gemeinsame Anweisungen, Glossar und Einstellungen über die Shops eines Händlers oder einer Agentur hinweg.",
      es: "Instrucciones, glosario y ajustes compartidos entre las tiendas de un comerciante o agencia.",
    },
  },
  {
    id: "api-access",
    visibility: "public",
    status: "considering",
    area: "platform",
    title: {
      en: "API access",
      de: "API-Zugang",
      es: "Acceso por API",
    },
    body: {
      en: "Start translation and generation runs from your own systems.",
      de: "Übersetzungs- und Generierungsläufe aus eigenen Systemen anstoßen.",
      es: "Lanzar traducciones y generaciones desde sus propios sistemas.",
    },
  },
  {
    id: "regional-variants",
    visibility: "public",
    status: "considering",
    area: "translations",
    title: {
      en: "Regional variants of a language",
      de: "Regionale Varianten einer Sprache",
      es: "Variantes regionales de un idioma",
    },
    body: {
      en: "Swiss German without ß, Austrian vocabulary, Latin American Spanish — as translation targets, not as manual edits afterwards.",
      de: "Schweizer Deutsch ohne ß, österreichisches Vokabular, lateinamerikanisches Spanisch — als Übersetzungsziel, nicht als Handarbeit danach.",
      es: "Alemán suizo sin ß, vocabulario austriaco, español latinoamericano — como destino de traducción, no como retoques manuales después.",
    },
    notes: "Shopify Markets already carries a per-market layer; the question is whether a variant is a locale or a market override. See docs/reference/COMPETITIVE_ANALYSIS.md §4.3. Today market overrides are editable by hand (MarketSelector) but every AI translation writes the GLOBAL layer only (marketId: \"\").",
  },
  {
    id: "rtl",
    visibility: "public",
    status: "considering",
    area: "translations",
    title: {
      en: "Right-to-left languages",
      de: "Rechts-nach-links-Sprachen",
      es: "Idiomas de derecha a izquierda",
    },
    body: {
      en: "Arabic and Hebrew in the editor and the bulk grid.",
      de: "Arabisch und Hebräisch im Editor und im Bulk-Raster.",
      es: "Árabe y hebreo en el editor y en la cuadrícula masiva.",
    },
  },
  {
    id: "image-generation",
    visibility: "public",
    status: "considering",
    area: "media",
    title: {
      en: "Generated images",
      de: "Generierte Bilder",
      es: "Imágenes generadas",
    },
    body: {
      en: "Backgrounds and lifestyle scenes for products that only have a cut-out.",
      de: "Hintergründe und Szenen für Produkte, von denen es nur ein Freisteller-Foto gibt.",
      es: "Fondos y escenas para productos de los que solo hay un recorte.",
    },
  },
  {
    id: "integrations",
    visibility: "public",
    status: "considering",
    area: "platform",
    title: {
      en: "Notifications and automation hooks",
      de: "Benachrichtigungen und Automatisierungs-Hooks",
      es: "Notificaciones y ganchos de automatización",
    },
    body: {
      en: "The app already tells you inside Shopify when a long run is done. Next: the same message by email, and a hook other tools can listen to.",
      de: "Innerhalb von Shopify meldet die App schon heute, wenn ein langer Lauf fertig ist. Als Nächstes: dieselbe Nachricht per E-Mail und ein Hook, auf den andere Werkzeuge hören können.",
      es: "Dentro de Shopify la aplicación ya avisa cuando termina una ejecución larga. Lo siguiente: el mismo aviso por correo y un gancho al que otras herramientas puedan escuchar.",
    },
    notes: "Was 'Slack notifications' + 'Zapier' in the 2026-01 roadmap. Generic webhook first; a Slack app is a channel, not a feature. The in-app bell (MainNavigation NotificationIcon, api.recently-completed-tasks) is shipped; no email/Slack/outgoing webhook exists.",
  },
  {
    id: "annual-plans",
    visibility: "public",
    status: "considering",
    area: "platform",
    title: {
      en: "Annual plans",
      de: "Jahresabos",
      es: "Planes anuales",
    },
    body: {
      en: "Pay for a year at a time, at a lower rate.",
      de: "Ein Jahr auf einmal bezahlen, zu einem günstigeren Satz.",
      es: "Pagar un año de una vez, a un precio menor.",
    },
    notes: "billing.ts already types interval as 'EVERY_30_DAYS' | 'ANNUAL' and billing.server.ts passes it through; every plan is EVERY_30_DAYS and there is no monthly/yearly toggle.",
    ref: "docs/reference/PRICING_AND_LIMITS.md",
  },

  // ── Shipped (newest first) ────────────────────────────────────────────
  {
    id: "public-website",
    visibility: "public",
    status: "shipped",
    area: "website",
    shippedOn: "2026-09",
    title: { en: "This website", de: "Diese Website", es: "Esta web" },
    body: {
      en: "A public product page outside the Shopify admin, in three languages, with the roadmap you are reading.",
      de: "Eine öffentliche Produktseite außerhalb des Shopify-Admins, in drei Sprachen, mit der Roadmap, die Sie gerade lesen.",
      es: "Una página de producto pública fuera del panel de Shopify, en tres idiomas, con la hoja de ruta que está leyendo.",
    },
  },
  // Entries below were built before this file existed (2026-09-12) and were
  // back-filled on 2026-09-13 from a code + git-log audit; shippedOn is the
  // month of the feature's first commit. Features of the January base app
  // (the per-type editors, AI providers, theme translation, tasks) are not
  // listed: they are what the product IS, not news on a roadmap.
  {
    id: "content-creation",
    visibility: "public",
    status: "shipped",
    area: "structure",
    shippedOn: "2026-08",
    title: { en: "Create and delete content in the app", de: "Inhalte in der App anlegen und löschen", es: "Crear y eliminar contenido en la app" },
    body: {
      en: "New products, collections, pages, articles and metaobject entries — with the AI writing the fields you leave empty, a 'create like this one' copy, and rule-based collections built in a form.",
      de: "Neue Produkte, Kollektionen, Seiten, Artikel und Metaobjekt-Einträge — die KI schreibt die Felder, die Sie leer lassen, dazu ein „ähnlich wie dieses anlegen“ und regelbasierte Kollektionen per Formular.",
      es: "Nuevos productos, colecciones, páginas, artículos y entradas de metaobjetos — la IA escribe los campos que deje vacíos, con una copia «crear como este» y colecciones automáticas creadas desde un formulario.",
    },
    notes: "CreateItemModal.tsx, DuplicateItemModal.tsx, DeleteItemModal.tsx, CollectionRuleBuilder.tsx.",
  },
  {
    id: "commerce-panel",
    visibility: "public",
    status: "shipped",
    area: "structure",
    shippedOn: "2026-08",
    title: { en: "Stock, prices and sales channels", de: "Lagerbestand, Preise und Verkaufskanäle", es: "Stock, precios y canales de venta" },
    body: {
      en: "Stock per location, variant prices, SKU and barcode, cost and weight, and on which sales channels a product is actually visible — next to its texts, in one save.",
      de: "Bestand pro Standort, Variantenpreise, SKU und Barcode, Kosten und Gewicht, und auf welchen Verkaufskanälen ein Produkt wirklich sichtbar ist — neben den Texten, mit einem Speichern.",
      es: "Stock por ubicación, precios de variantes, SKU y código de barras, coste y peso, y en qué canales de venta es realmente visible un producto — junto a sus textos, en un solo guardado.",
    },
    notes: "api.product-commerce.tsx, CommerceField.tsx, CommerceVariantsSection.tsx. Stock is read live and written with compareQuantity (CLAUDE.md).",
  },
  {
    id: "product-attributes",
    visibility: "public",
    status: "shipped",
    area: "structure",
    shippedOn: "2026-08",
    title: { en: "Category, collections, tags and template", de: "Kategorie, Kollektionen, Tags und Vorlage", es: "Categoría, colecciones, etiquetas y plantilla" },
    body: {
      en: "The details around the text: product category, collection membership, vendor, tags, status and the theme template — chosen from the templates your theme really has.",
      de: "Die Angaben rund um den Text: Produktkategorie, Kollektionszugehörigkeit, Hersteller, Tags, Status und die Theme-Vorlage — ausgewählt aus den Vorlagen, die Ihr Theme wirklich hat.",
      es: "Los datos alrededor del texto: categoría de producto, pertenencia a colecciones, proveedor, etiquetas, estado y la plantilla del tema — elegida entre las que su tema tiene de verdad.",
    },
    notes: "TaxonomyField.tsx, CollectionsField.tsx, AttributeField.tsx, ThemeTemplateField.tsx.",
  },
  {
    id: "readability",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-08",
    title: { en: "Readability check", de: "Lesbarkeits-Prüfung", es: "Análisis de legibilidad" },
    body: {
      en: "Long sentences, long paragraphs and missing subheadings in every language, plus a reading-ease score where a validated formula exists (English, German, Spanish).",
      de: "Lange Sätze, lange Absätze und fehlende Zwischenüberschriften in jeder Sprache, dazu ein Lesbarkeitswert, wo es eine geprüfte Formel gibt (Englisch, Deutsch, Spanisch).",
      es: "Frases largas, párrafos largos y subtítulos ausentes en cualquier idioma, y una puntuación de facilidad de lectura donde existe una fórmula validada (inglés, alemán, español).",
    },
    notes: "app/utils/readability.ts.",
  },
  {
    id: "market-translations",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-07",
    title: { en: "Translations per market", de: "Übersetzungen pro Markt", es: "Traducciones por mercado" },
    body: {
      en: "Word a language differently for one Shopify market — German for Switzerland beside German for Germany — on content, metaobjects, theme texts and alt texts.",
      de: "Eine Sprache für einen Shopify-Markt anders formulieren — Deutsch für die Schweiz neben Deutsch für Deutschland — bei Inhalten, Metaobjekten, Theme-Texten und Alt-Texten.",
      es: "Redactar un idioma de otra forma para un mercado de Shopify — alemán para Suiza junto a alemán para Alemania — en contenidos, metaobjetos, textos del tema y textos alternativos.",
    },
    notes: "MarketSelector.tsx. Hand-edited only; AI translation writes the global layer (see regional-variants).",
  },
  {
    id: "seo-audit",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-07",
    title: { en: "SEO audit with AI fixes", de: "SEO-Audit mit KI-Korrekturen", es: "Auditoría SEO con correcciones por IA" },
    body: {
      en: "Missing and too-long titles, meta descriptions and alt texts across the shop, fixed with AI in bulk or one by one — in every language — plus an hreflang check of your translations.",
      de: "Fehlende und zu lange Titel, Meta-Beschreibungen und Alt-Texte im ganzen Shop, per KI gesammelt oder einzeln korrigiert — in jeder Sprache — dazu eine hreflang-Prüfung Ihrer Übersetzungen.",
      es: "Títulos, meta descripciones y textos alternativos ausentes o demasiado largos en toda la tienda, corregidos con IA en bloque o uno a uno — en cada idioma — y una revisión hreflang de sus traducciones.",
    },
    notes: "app.seo._index.tsx (2026-06), seo-bulk-fix.handler.ts ('Fix with AI', 2026-07), app.seo.hreflang.tsx.",
  },
  {
    id: "page-speed",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-07",
    title: { en: "Page speed from lab and real visitors", de: "Ladezeit aus Labor und echten Besuchen", es: "Velocidad desde laboratorio y visitas reales" },
    body: {
      en: "PageSpeed results with their history, and Core Web Vitals measured on your own storefront visitors — as a diagnosis; the app never edits your theme code.",
      de: "PageSpeed-Ergebnisse mit Verlauf und Core Web Vitals, gemessen an den echten Besuchern Ihrer Storefront — als Diagnose; die App verändert nie Ihren Theme-Code.",
      es: "Resultados de PageSpeed con su historial y Core Web Vitals medidos en los visitantes reales de su tienda — como diagnóstico; la app nunca modifica el código de su tema.",
    },
    notes: "app.seo.performance.tsx, extensions/storefront/blocks/web-vitals.liquid, proxy.web-vitals.tsx.",
  },
  {
    id: "internal-links-sitemap",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-07",
    title: { en: "Internal links and sitemap", de: "Interne Links und Sitemap", es: "Enlaces internos y sitemap" },
    body: {
      en: "Link suggestions between your own pages to accept or reject, and control over which pages stay out of the sitemap and search.",
      de: "Link-Vorschläge zwischen Ihren eigenen Seiten zum Annehmen oder Ablehnen, und Kontrolle darüber, welche Seiten aus Sitemap und Suche herausbleiben.",
      es: "Sugerencias de enlaces entre sus propias páginas para aceptar o rechazar, y control sobre qué páginas quedan fuera del sitemap y de la búsqueda.",
    },
    notes: "app.seo.internal-links.tsx, app.seo.sitemap.tsx.",
  },
  {
    id: "social-meta",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-07",
    title: { en: "Social sharing previews", de: "Vorschauen beim Teilen", es: "Vistas previas al compartir" },
    body: {
      en: "Open Graph and X/Twitter tags for every page, and a crawl check that shows where your theme or another app already outputs them twice.",
      de: "Open-Graph- und X/Twitter-Tags für jede Seite, und eine Crawl-Prüfung, die zeigt, wo Theme oder eine andere App sie schon doppelt ausgeben.",
      es: "Etiquetas Open Graph y X/Twitter para cada página, y una comprobación del rastreo que muestra dónde su tema u otra app ya las emite por duplicado.",
    },
    notes: "extensions/storefront/blocks/social-meta.liquid; crawl check 2026-08.",
  },
  {
    id: "keywords",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-06",
    title: { en: "Keywords per language", de: "Keywords pro Sprache", es: "Palabras clave por idioma" },
    body: {
      en: "Research, group and prioritise keywords per language, see where two pages compete for the same term, and let the AI work a keyword into a text.",
      de: "Keywords pro Sprache recherchieren, gruppieren und priorisieren, sehen, wo zwei Seiten um denselben Begriff konkurrieren, und die KI ein Keyword in einen Text einarbeiten lassen.",
      es: "Investigar, agrupar y priorizar palabras clave por idioma, ver dónde dos páginas compiten por el mismo término, y dejar que la IA integre una palabra clave en un texto.",
    },
    notes: "app.seo.keywords.tsx, keyword-distribution.handler.ts, keyword-insert.handler.ts.",
  },
  {
    id: "search-console-indexnow",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-06",
    title: { en: "Google Search Console and IndexNow", de: "Google Search Console und IndexNow", es: "Google Search Console e IndexNow" },
    body: {
      en: "Your Search Console data inside the app with the quick wins picked out, and changed pages reported to Bing and other engines the moment they change.",
      de: "Ihre Search-Console-Daten in der App mit herausgesuchten Quick Wins, und geänderte Seiten werden Bing und anderen Suchmaschinen gemeldet, sobald sie sich ändern.",
      es: "Sus datos de Search Console dentro de la app con las mejoras rápidas destacadas, y las páginas modificadas notificadas a Bing y otros buscadores en cuanto cambian.",
    },
    notes: "app.seo.search-console.tsx, app.seo.index-now.tsx.",
  },
  {
    id: "redirect-manager",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-06",
    title: { en: "Redirects and 404 tracking", de: "Weiterleitungen und 404-Erfassung", es: "Redirecciones y registro de 404" },
    body: {
      en: "See which addresses visitors hit that no longer exist, redirect them, and bring existing redirects in by CSV from other SEO tools.",
      de: "Sehen, welche nicht mehr existierenden Adressen Besucher aufrufen, sie weiterleiten, und bestehende Weiterleitungen per CSV aus anderen SEO-Werkzeugen übernehmen.",
      es: "Ver qué direcciones que ya no existen visitan sus clientes, redirigirlas, e importar redirecciones existentes por CSV desde otras herramientas SEO.",
    },
    notes: "app.seo.redirects.tsx, proxy.seo-404.tsx, redirects-csv.ts (Yoast / SEOPress / Screaming Frog formats).",
  },
  {
    id: "direct-translations",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-06",
    title: { en: "Translate any text on your storefront", de: "Jeden Text der Storefront übersetzen", es: "Traducir cualquier texto de su tienda" },
    body: {
      en: "Texts that come from apps or hard-coded theme strings are collected while you browse your shop, and translated like everything else.",
      de: "Texte aus Apps oder fest im Theme hinterlegte Zeichenketten werden gesammelt, während Sie durch Ihren Shop klicken, und wie alles andere übersetzt.",
      es: "Los textos que vienen de apps o de cadenas fijas del tema se recogen mientras navega por su tienda, y se traducen como todo lo demás.",
    },
    notes: "app.direct-translations.tsx, proxy.collect-strings.tsx. Max plan.",
  },
  {
    id: "translate-whole-shop",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-06",
    title: { en: "Metafields and the rest of the shop", de: "Metafelder und der Rest des Shops", es: "Metacampos y el resto de la tienda" },
    body: {
      en: "Metafields — including those other apps created — option names and values, policies, filters, selling plans and the cookie banner, translated in the same editor.",
      de: "Metafelder — auch die von anderen Apps angelegten —, Optionsnamen und -werte, Richtlinien, Filter, Abo-Pläne und das Cookie-Banner, übersetzt im selben Editor.",
      es: "Metacampos — también los creados por otras apps —, nombres y valores de opciones, políticas, filtros, planes de suscripción y el banner de cookies, traducidos en el mismo editor.",
    },
    notes: "SettingsMetafieldsTab.tsx, MetafieldsField.tsx, app.selling-plans.tsx, app.cookie-banner.tsx, app.online-store-extras.tsx, app.policies.tsx.",
  },
  {
    id: "image-manager",
    visibility: "public",
    status: "shipped",
    area: "media",
    shippedOn: "2026-05",
    title: { en: "Image manager and variant galleries", de: "Bildverwaltung und Varianten-Galerien", es: "Gestor de imágenes y galerías por variante" },
    body: {
      en: "A gallery per variant with images, videos and 3D models, bulk upload that assigns files by their name, WebP conversion, and a storefront gallery that follows the selected variant.",
      de: "Eine Galerie pro Variante mit Bildern, Videos und 3D-Modellen, Massen-Upload mit Zuordnung über den Dateinamen, WebP-Umwandlung und eine Storefront-Galerie, die der gewählten Variante folgt.",
      es: "Una galería por variante con imágenes, vídeos y modelos 3D, subida masiva que asigna los archivos por su nombre, conversión a WebP y una galería en la tienda que sigue a la variante elegida.",
    },
    notes: "VariantImageManager.tsx, BulkImageUploadPanel.tsx (2026-04), video/3D 2026-05, extensions/storefront/blocks/variant-gallery.liquid.",
  },
  {
    id: "locale-switcher",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-05",
    title: { en: "Language and currency switcher", de: "Sprach- und Währungsumschalter", es: "Selector de idioma y moneda" },
    body: {
      en: "A switcher with flags for your storefront, added as a theme block without touching your theme code.",
      de: "Ein Umschalter mit Flaggen für Ihre Storefront, als Theme-Block eingefügt, ohne Ihren Theme-Code anzufassen.",
      es: "Un selector con banderas para su tienda, añadido como bloque del tema sin tocar el código de su tema.",
    },
    notes: "extensions/storefront/blocks/locale-switcher.liquid.",
  },
  {
    id: "menu-editor",
    visibility: "public",
    status: "shipped",
    area: "structure",
    shippedOn: "2026-08",
    title: { en: "Full menu editor", de: "Vollständiger Menü-Editor", es: "Editor de menús completo" },
    body: {
      en: "Rename, reorder, re-nest and retarget navigation items — with their translations kept across a move.",
      de: "Navigationspunkte umbenennen, umsortieren, verschachteln und umhängen — die Übersetzungen überstehen einen Umzug.",
      es: "Renombrar, reordenar, anidar y reapuntar elementos de navegación — conservando sus traducciones al moverlos.",
    },
  },
  {
    id: "metaobjects-editor",
    visibility: "public",
    status: "shipped",
    area: "structure",
    shippedOn: "2026-08",
    title: { en: "Metaobject entries", de: "Metaobjekt-Einträge", es: "Entradas de metaobjetos" },
    body: {
      en: "Edit, create, translate and delete metaobject entries, including taxonomy fields like colour and pattern.",
      de: "Metaobjekt-Einträge bearbeiten, anlegen, übersetzen und löschen — inklusive Taxonomie-Feldern wie Farbe und Muster.",
      es: "Editar, crear, traducir y eliminar entradas de metaobjetos, incluidos campos de taxonomía como color y patrón.",
    },
  },
  {
    id: "auto-retranslate",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-08",
    title: {
      en: "Translations refreshed when the source changes",
      de: "Übersetzungen werden erneuert, wenn sich der Ausgangstext ändert",
      es: "Traducciones renovadas cuando cambia el original",
    },
    body: {
      en: "Edit a text anywhere — in the app, the Shopify admin or an import — and its translations are re-made or removed, never left describing text that no longer exists.",
      de: "Einen Text irgendwo ändern — in der App, im Shopify-Admin oder per Import — und seine Übersetzungen werden neu gemacht oder entfernt, nie stehen gelassen.",
      es: "Edite un texto en cualquier sitio — en la app, en el panel de Shopify o por importación — y sus traducciones se rehacen o se eliminan, nunca quedan describiendo un texto que ya no existe.",
    },
  },
  {
    id: "aeo",
    visibility: "public",
    status: "shipped",
    area: "aeo",
    shippedOn: "2026-08",
    title: { en: "Readable by AI assistants", de: "Lesbar für KI-Assistenten", es: "Legible para asistentes de IA" },
    body: {
      en: "agents.md and llms.txt generated from your catalogue, a robots.txt check for AI crawlers, structured data including video, catalogue readiness, and visits from AI assistants counted without cookies.",
      de: "agents.md und llms.txt aus Ihrem Katalog, eine robots.txt-Prüfung für KI-Crawler, strukturierte Daten inklusive Videos, Katalog-Bereitschaft und Besuche von KI-Assistenten — ohne Cookies gezählt.",
      es: "agents.md y llms.txt generados desde su catálogo, una revisión de robots.txt para rastreadores de IA, datos estructurados incluidos los vídeos, preparación del catálogo y visitas desde asistentes de IA contadas sin cookies.",
    },
  },
  {
    id: "storefront-crawl",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-08",
    title: { en: "Crawl of your own storefront", de: "Crawl der eigenen Storefront", es: "Rastreo de su propia tienda" },
    body: {
      en: "On-page report, broken links, redirect chains, indexability — measured on the live shop, not guessed from the database.",
      de: "On-Page-Bericht, defekte Links, Weiterleitungsketten, Indexierbarkeit — am echten Shop gemessen, nicht aus der Datenbank geraten.",
      es: "Informe on-page, enlaces rotos, cadenas de redirección, indexabilidad — medidos en la tienda real, no adivinados desde la base de datos.",
    },
  },
  {
    id: "handle-redirects",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-08",
    title: { en: "Redirects for renamed handles", de: "Weiterleitungen bei geänderten Handles", es: "Redirecciones al cambiar un handle" },
    body: {
      en: "Change a URL handle — in any language — and the 301 from the old address is written for you.",
      de: "Ein URL-Handle ändern — in jeder Sprache — und die 301-Weiterleitung von der alten Adresse wird für Sie angelegt.",
      es: "Cambie un handle de URL — en cualquier idioma — y la redirección 301 desde la dirección antigua se crea por usted.",
    },
  },
  {
    id: "glossary",
    visibility: "public",
    status: "shipped",
    area: "ai",
    shippedOn: "2026-07",
    title: { en: "Glossary", de: "Glossar", es: "Glosario" },
    body: {
      en: "Terms the AI must keep, translate a fixed way, or never touch — applied to every generation and translation.",
      de: "Begriffe, die die KI behalten, fest übersetzen oder nie anfassen darf — angewendet auf jede Generierung und Übersetzung.",
      es: "Términos que la IA debe conservar, traducir de una forma fija o no tocar nunca — aplicados a cada generación y traducción.",
    },
  },
  {
    id: "bulk-editor",
    visibility: "public",
    status: "shipped",
    area: "bulk",
    // app.seo.bulk-meta.tsx landed 2026-07-06, the /app/bulk grid 2026-07-22 — "2026-06" was a month early.
    shippedOn: "2026-07",
    title: { en: "Bulk editor", de: "Bulk-Editor", es: "Editor masivo" },
    body: {
      en: "A spreadsheet over the whole shop with CSV in and out, and a pass that fills only the missing translations.",
      de: "Eine Tabelle über den ganzen Shop mit CSV-Export und -Import, und ein Durchgang, der nur die fehlenden Übersetzungen ergänzt.",
      es: "Una hoja sobre toda la tienda con CSV de entrada y salida, y una pasada que rellena solo las traducciones que faltan.",
    },
  },
  {
    id: "alt-text-vision",
    visibility: "public",
    status: "shipped",
    area: "media",
    shippedOn: "2026-06",
    title: { en: "Alt texts that describe the actual picture", de: "Alt-Texte, die das echte Bild beschreiben", es: "Textos alternativos que describen la imagen real" },
    body: {
      en: "With image understanding switched on, the AI looks at the photo before it writes — and the alt text is translated like any other field.",
      de: "Mit eingeschaltetem Bildverständnis sieht die KI das Foto, bevor sie schreibt — und der Alt-Text wird übersetzt wie jedes andere Feld.",
      es: "Con la comprensión de imágenes activada, la IA mira la foto antes de escribir — y el texto alternativo se traduce como cualquier otro campo.",
    },
  },

  // ── Dropped (kept as the record of why) ───────────────────────────────
  {
    id: "content-templates",
    visibility: "internal",
    status: "dropped",
    area: "ai",
    title: "Content templates with {{variables}}",
    notes:
      "Dropped 2026-07-19 after a two-day test: {{variables}} gave the AI nothing it did not already get from the per-field instruction lines. Re-enter only with variables that carry NEW information from Shopify ({{brand}}, {{price}}, {{tags}}). See docs/reference/COMPETITIVE_ANALYSIS.md §3.1 point 5.",
  },
  {
    id: "currency-converter",
    visibility: "internal",
    status: "dropped",
    area: "platform",
    title: "Own currency conversion",
    notes:
      "Shopify Markets + Shopify Payments convert natively at checkout, display and refund. The only residual is a display-only switcher with rounding rules for shops without Shopify Payments — small, and it must say 'display only, charged in shop currency'. Decision 2026-06-18: not building a converter. Reconsider only as the display-only variant.",
    ref: "docs/reference/COMPETITIVE_ANALYSIS.md",
  },

  // ── Internal: platform, infrastructure, security, pricing ─────────────
  {
    id: "team-roles",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "Several users per shop with roles",
    notes: "Prerequisite for approval-workflow and multi-store. Shopify staff accounts already exist; the question is whether the app needs its own roles or reads Shopify's.",
  },
  {
    id: "enterprise-tier",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "Enterprise tier (custom pricing, >2500 products, multi-store, API, SLA)",
    target: "2027",
    ref: "docs/reference/PRICING_AND_LIMITS.md",
  },
  {
    id: "pricing-v2",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "Pricing v2 (Basic 14.90 / Pro 29.90 / Max 79.90, grandfathering)",
    notes: "Decision 2026-05: do NOT lower prices broadly; invest the AI-free margin in more value per tier. Launch traction via a limited promo for the first customers, not permanently lower prices.",
    ref: "docs/reference/PRICING_AND_LIMITS.md",
  },
  {
    id: "white-label",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "White-label option for agencies",
  },
  {
    id: "sso",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "SSO / SAML",
    notes: "Only meaningful with team-roles and an enterprise tier.",
  },
  {
    id: "jsonld-product-group",
    visibility: "internal",
    status: "planned",
    area: "aeo",
    title: "Decide Product vs ProductGroup before growing the theme schema",
    notes: "Changes entity identity in Google's index; visible only weeks later in Search Console. Decide deliberately, not while building something else.",
    ref: "docs/reference/JSONLD_BACKLOG.md",
  },
  {
    id: "jsonld-merchant-listing",
    visibility: "internal",
    status: "considering",
    area: "aeo",
    title: "hasMerchantReturnPolicy + shippingDetails in the Product markup",
    notes: "Only as explicit merchant input with an EMPTY default — Google checks these against Merchant Center and withdraws rich results on mismatch. Never parsed from a policy page. Search Console warnings are the chosen price until then.",
    ref: "docs/reference/JSONLD_BACKLOG.md",
  },
  {
    id: "job-queue",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "Background job queue for long runs",
    notes: "Today: detached promises inside the web process with heartbeat reaping (see CLAUDE.md, orphan-run-recovery). A queue is the answer if a redeploy killing a run becomes a real merchant problem rather than a restartable one.",
  },
  {
    id: "redis-cache",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "Redis cache in front of Postgres",
    notes: "No measured need yet. Measure before building.",
  },
  {
    id: "multi-region",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "EU + US deployment",
  },
  {
    id: "security-audit",
    visibility: "internal",
    status: "planned",
    area: "platform",
    title: "External security audit",
    notes: "Internal audit trail lives in docs/architecture/SECURITY_IMPROVEMENTS.md.",
  },
  {
    id: "soc2",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "SOC 2 (Type 1, then Type 2)",
    notes: "Enterprise requirement; only with an enterprise tier.",
  },
  {
    id: "apm",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "APM / performance monitoring beside Sentry",
  },
  {
    id: "custom-model-training",
    visibility: "internal",
    status: "considering",
    area: "ai",
    title: "Per-shop fine-tuned model",
    notes: "brand-voice (a derived style guide in the prompt) gets most of the value at none of the cost. Revisit only if that proves insufficient.",
  },
  {
    id: "video-subtitles",
    visibility: "internal",
    status: "considering",
    area: "media",
    title: "Generated video descriptions / subtitles",
  },
  {
    id: "text-to-speech",
    visibility: "internal",
    status: "considering",
    area: "media",
    title: "Text-to-speech for accessibility",
  },
  {
    id: "affiliate",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "Affiliate programme",
  },
  {
    id: "shopify-plus-features",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "Shopify Plus-only features",
  },
  {
    id: "mobile-app",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "Mobile app",
    notes: "The embedded app already renders in the Shopify mobile admin. No case for a native one yet.",
  },
  {
    id: "chrome-extension",
    visibility: "internal",
    status: "considering",
    area: "platform",
    title: "Chrome extension",
  },
];

/** The entries the website renders, in file order (= priority within a status). */
export function publicRoadmap(): PublicRoadmapEntry[] {
  return ROADMAP.filter((entry): entry is PublicRoadmapEntry => entry.visibility === "public");
}
