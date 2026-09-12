/**
 * THE ROADMAP. One file, two readers.
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
      en: "Pick a writing style once — factual, warm, premium — and every generation follows it, instead of repeating the instruction per field.",
      de: "Einen Schreibstil einmal wählen — sachlich, warm, hochwertig — und jede Generierung folgt ihm, statt die Anweisung pro Feld zu wiederholen.",
      es: "Elija un estilo una vez — objetivo, cercano, premium — y cada generación lo sigue, en lugar de repetir la instrucción campo a campo.",
    },
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
      en: "Beyond readability: thin descriptions, duplicated phrasing across products, fields that were never touched.",
      de: "Über Lesbarkeit hinaus: dünne Beschreibungen, gleiche Formulierungen über Produkte hinweg, nie angefasste Felder.",
      es: "Más allá de la legibilidad: descripciones escasas, frases repetidas entre productos, campos nunca tocados.",
    },
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
    notes: "Shopify Markets already carries a per-market layer; the question is whether a variant is a locale or a market override. See docs/reference/COMPETITIVE_ANALYSIS.md §4.3.",
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
      en: "A message when a long run finishes, and a hook other tools can listen to.",
      de: "Eine Nachricht, wenn ein langer Lauf fertig ist, und ein Hook, auf den andere Werkzeuge hören können.",
      es: "Un aviso cuando termina una ejecución larga, y un gancho al que otras herramientas puedan escuchar.",
    },
    notes: "Was 'Slack notifications' + 'Zapier' in the 2026-01 roadmap. Generic webhook first; a Slack app is a channel, not a feature.",
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
      en: "agents.md and llms.txt generated from your catalogue, structured data, catalogue readiness, and visits from AI assistants counted without cookies.",
      de: "agents.md und llms.txt aus Ihrem Katalog, strukturierte Daten, Katalog-Bereitschaft und Besuche von KI-Assistenten — ohne Cookies gezählt.",
      es: "agents.md y llms.txt generados desde su catálogo, datos estructurados, preparación del catálogo y visitas desde asistentes de IA contadas sin cookies.",
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
    shippedOn: "2026-06",
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
