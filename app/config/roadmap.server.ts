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
 * - ON-REQUEST is not a weaker "considering": it is a decision. The thing is
 *   understood, it is buildable, and it is not being built speculatively —
 *   somebody has to ask for it. Saying so publicly is better than parking it
 *   under "considering", where a merchant reads it as "coming eventually" and
 *   waits instead of writing in.
 * - A DROPPED entry stays, with the reason in `notes`. The reason is the
 *   valuable part — it stops the same idea from being re-proposed without the
 *   argument that killed it (see content-templates).
 * - Order within a status is priority order: the website keeps it.
 */

export type RoadmapStatus =
  | "shipped"
  | "in-progress"
  | "planned"
  | "considering"
  | "on-request"
  | "dropped";

export type RoadmapArea =
  | "ai"
  | "translations"
  | "bulk"
  | "seo"
  | "aeo"
  | "media"
  | "ads"
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
  // ── Planned (priority order) ──────────────────────────────────────────
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
      en: "Every nightly check is already stored. It will read as a line, so a change to the shop is visible without remembering last week's number.",
      de: "Jede nächtliche Prüfung wird bereits gespeichert. Sie wird als Linie lesbar, damit eine Änderung am Shop sichtbar wird, ohne sich die Zahl der Vorwoche zu merken.",
      es: "Cada revisión nocturna ya se guarda. Se leerá como una línea, para que un cambio en la tienda se vea sin recordar el número de la semana pasada.",
    },
    notes: "FIRST in this list 2026-09-17: it is the only entry here that is already SOLD. The DATA is already there: SeoScoreSnapshot is written by the nightly audit with plan-based retention (plans.ts scoreHistoryDays: Pro 30, Max 365), and getAuditTrend() in audit.service.ts exists — with no caller. SeoKeywordSnapshot is likewise written and never displayed. The plan tab already SELLS 'Score-Verlauf: {days} Tage' (SettingsPlanTab.tsx), so this is owed, not optional: the chart is the whole remaining work. No chart library is needed or wanted — an inline SVG line stays hydration-safe. Crawl diff (two snapshots) is shipped separately.",
  },
  {
    id: "managed-ai-key",
    visibility: "public",
    status: "planned",
    area: "ai",
    title: {
      en: "Use the AI without your own API key",
      de: "KI nutzen ohne eigenen API-Schlüssel",
      es: "Usar la IA sin su propia clave API",
    },
    body: {
      en: "Today every AI feature needs a key you first fetch from a provider. A plan with AI included becomes selectable instead: a fixed monthly volume, no key, no separate provider invoice. Your own key stays available — unlimited, and at no extra charge.",
      de: "Heute braucht jede KI-Funktion einen Schlüssel, den Sie zuerst beim Anbieter holen. Stattdessen wird ein Tarif mit enthaltener KI wählbar: ein festes Monatsvolumen, ohne Schlüssel und ohne separate Anbieterrechnung. Ihr eigener Schlüssel bleibt verfügbar — unbegrenzt und ohne Aufpreis.",
      es: "Hoy cada función de IA necesita una clave que usted obtiene antes en un proveedor. En su lugar podrá elegir un plan con IA incluida: un volumen mensual fijo, sin clave y sin factura aparte del proveedor. Su propia clave sigue disponible, ilimitada y sin recargo.",
    },
    notes: "Added 2026-09-17, deliberately SECOND in this list: it is the only entry here that removes an obstacle standing BEFORE the first use of the product. Bring-your-own-key was never a product decision — it was the cheapest fix for compliance finding B4, which names a second acceptable fix (an explicit, logged consent gate) that nobody has built. Everything hard about this is on the internal entries: metering (the app does not know today what one operation costs — every SDK's `usage` object is discarded in `_executeAIRequestInner`), the price ladder, and the rails a SHARED key needs that a merchant key never did. What is PUBLIC here is only the promise, and the promise deliberately keeps BYO first-class: a heavy shop is cheaper on its own key and must never be pushed off it. Free gets a one-time taster sized at one full pass over what the tier entitles (~350 actions) — not a monthly allowance, which at the proposed 2 EUR/month would have out-granted paid Basic.",
    ref: "docs/plans/PLAN_MANAGED_AI_KEY.md",
  },
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
      en: "Changed texts are already refreshed on their own. This finds what was NEVER translated — a product added yesterday — and fills it on a schedule.",
      de: "Geänderte Texte werden bereits von selbst aufgefrischt. Dies findet, was NIE übersetzt wurde — ein gestern angelegtes Produkt — und ergänzt es nach Zeitplan.",
      es: "Los textos modificados ya se renuevan solos. Esto encuentra lo que NUNCA se tradujo — un producto añadido ayer — y lo completa según un horario.",
    },
    notes: "Deliberately distinct from the Max auto-translation: that one is triggered by a CHANGED primary text (translation-drift-auto-run.service.ts + reconcileAfterPrimarySave), so content that was never translated and never changed is invisible to it forever. This is the manual /app/bulk/translate run (task bulkEditorTranslate, the candidate scan in missing-translations.server.ts) on a schedule. Store the FILTER, never the row ids, or the run never reaches the products that did not exist when it was set up. Needs its own cost cap: unattended AI calls on the merchant's key.",
  },
  {
    id: "translation-dashboard",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-09",
    title: {
      en: "What exactly is still missing per language",
      de: "Was pro Sprache genau noch fehlt",
      es: "Qué falta exactamente en cada idioma",
    },
    body: {
      en: "The language coverage now says what is behind the percentage — per content type and per field — and a field is only counted as missing where the original actually has text.",
      de: "Die Sprachabdeckung sagt jetzt, was hinter dem Prozentwert steckt — pro Inhaltstyp und Feld — und ein Feld gilt nur dort als fehlend, wo das Original wirklich Text hat.",
      es: "La cobertura por idioma ahora dice qué hay detrás del porcentaje — por tipo de contenido y por campo — y un campo solo cuenta como ausente cuando el original tiene texto.",
    },
    notes: "Shipped 2026-09-17 as a DEEPENING of the hreflang audit, not a second page (two numbers for one product in two tabs is the catalog-readiness/analyzeStore mistake). hreflang-coverage.shared.ts holds the arithmetic; one grouped read per locale still answers both dimensions, scoped to the scanned ids. Two things changed meaning: 'translated' is now EVERY key that has primary text rather than ANY of four, so a shop's percentage can read lower than before, and a never-synced type reads as unknown instead of complete. Still outside the scan, deliberately: metafields, option values, theme texts, metaobjects, policies and menus. The stale dimension went to its own entry (translation-stale-view) — it needs a column that does not exist.",
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

  // ── Considering ───────────────────────────────────────────────────────
  {
    id: "ad-suite",
    visibility: "public",
    status: "considering",
    area: "ads",
    title: {
      en: "Advertising, written where your texts already live",
      de: "Werbung, dort geschrieben, wo Ihre Texte schon liegen",
      es: "Publicidad, escrita donde ya viven sus textos",
    },
    body: {
      en: "A section of its own for campaign texts and generated images, published to Meta, TikTok and Google Ads — in every language your shop already sells in, from the product texts you already wrote.",
      de: "Ein eigener Bereich für Kampagnentexte und generierte Bilder, veröffentlicht auf Meta, TikTok und Google Ads — in jeder Sprache, in der Ihr Shop schon verkauft, aus den Produkttexten, die Sie schon geschrieben haben.",
      es: "Una sección propia para textos de campaña e imágenes generadas, publicada en Meta, TikTok y Google Ads — en cada idioma en el que ya vende, a partir de los textos de producto que ya escribió.",
    },
    notes:
      "The biggest thing on this list: a TAB of its own, not a feature inside an existing one. Three independent halves, and they should be judged separately rather than as one project. (1) GENERATION — ad copy per locale and per market is the app's existing strength turned outward, and image generation (Higgsfield and others) follows the same rule as every AI provider here: the merchant's own key, providers rotate, so no single vendor may be wired into the core. (2) DISTRIBUTION — Meta, TikTok and Google Ads are three separate OAuth flows, three ad-account permission models, three app-review processes and three ad-policy regimes; none of them is 'an API call'. Real money is spent through them, which raises a question this app has never had to answer: what happens when an unattended run is wrong. (3) SCOPE against Shopify — the native Google/Meta/TikTok sales channels already push the CATALOG, so this must be additive and must never produce a second competing product feed for one shop. Overlaps the existing image-generation entry: that one is catalogue imagery (a background for a cut-out), this one is campaign creatives. Keep them apart or fold one in deliberately — do not let both grow half an implementation.",
  },
  {
    id: "product-feeds",
    visibility: "public",
    status: "considering",
    area: "ads",
    title: {
      en: "The right variant image in every ad feed",
      de: "Das richtige Variantenbild in jedem Werbe-Feed",
      es: "La imagen de variante correcta en cada feed publicitario",
    },
    body: {
      en: "The galleries you assign per variant reach Google, Meta and TikTok as additional images — so an ad for the blue one shows the blue one, from every angle you uploaded.",
      de: "Die Galerien, die Sie je Variante zuordnen, erreichen Google, Meta und TikTok als zusätzliche Bilder — damit die Anzeige für das blaue Modell auch das blaue zeigt, aus jedem Blickwinkel, den Sie hochgeladen haben.",
      es: "Las galerías que asigna por variante llegan a Google, Meta y TikTok como imágenes adicionales — para que el anuncio de la azul muestre la azul, desde cada ángulo que subió.",
    },
    notes:
      "MEASURED before writing this (api.update-variant-galleries.tsx:700-715): position 0 of a variant gallery already becomes the NATIVE variant.image, so the FIRST image per variant reaches every sales channel today — the card must not claim otherwise. The gap is the REST of the gallery: positions 1..n live in the custom.variant_gallery_order / custom.variant_external_videos metafields, which no channel feed reads, and Google's additional_image_link (up to 10) is exactly the field they belong in. So the smallest honest version of this is an ADDITIONAL feed beside Shopify's own channel, never a replacement — two full feeds for one shop means duplicate products at the network. Worth checking first whether Shopify's channel apps can be fed the metafield directly, which would make this a mapping rather than a feed. Smaller and far more certain than ad-suite; the two are listed together only because they share an audience.",
  },
  {
    id: "translation-stale-view",
    visibility: "public",
    status: "considering",
    area: "translations",
    title: {
      en: "See which translations describe older text",
      de: "Sehen, welche Übersetzungen älteren Text beschreiben",
      es: "Ver qué traducciones describen un texto anterior",
    },
    body: {
      en: "The app already refreshes a translation when its source changes. This would list the ones that are waiting for it, beside what is missing entirely.",
      de: "Die App frischt eine Übersetzung bereits auf, wenn sich ihr Ausgangstext ändert. Dies würde die auflisten, die noch darauf warten — neben dem, was ganz fehlt.",
      es: "La aplicación ya renueva una traducción cuando cambia su original. Esto mostraría las que aún esperan, junto a lo que falta por completo.",
    },
    notes: "Split out of translation-dashboard when that shipped 2026-09-17, so the deferral stays visible instead of being forgotten. The reason it was deferred is a schema fact: ContentTranslation has a `digest` column but NO `outdated` one (ThemeTranslation and MetaobjectTranslation do), so staleness is not derivable from the cache — findStaleTranslations needs Shopify data. The coverage read is DB-cache-first by contract, and a live sweep per page view would break it. The only sound route is persisting a marker where the digest comparison already proves staleness (stale-translation-sync.server.ts), i.e. a migration plus a write-path change. Worth it only if merchants ask what is outdated rather than what is missing.",
  },
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
    // NOT "ab-suggestions": that id read as A/B TESTING, which this is not —
    // there is no traffic split and no conversion measurement behind it.
    id: "alternative-versions",
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
    id: "user-roles",
    visibility: "public",
    status: "considering",
    area: "platform",
    title: {
      en: "Users and permissions",
      de: "Benutzer und Berechtigungen",
      es: "Usuarios y permisos",
    },
    body: {
      en: "Tell the people working in one shop apart, and give them different rights — who may generate, who may translate, who may publish.",
      de: "Die Personen unterscheiden, die in einem Shop arbeiten, und ihnen unterschiedliche Rechte geben — wer generieren, wer übersetzen und wer veröffentlichen darf.",
      es: "Distinguir a las personas que trabajan en una tienda y darles derechos distintos — quién puede generar, quién traducir y quién publicar.",
    },
    notes: "Own entry as of 2026-09-17, and it comes BEFORE approval-workflow rather than inside it. Today the app knows a SHOP, not a person: an embedded session says 'somebody with access opened this', there is no user table, and no write path records who acted. So a review queue could not even name its approver. Open question kept from the old internal entry: own roles, or read Shopify's staff accounts. Also a prerequisite for multi-store.",
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
      en: "For shops where one person writes and another approves: AI output waits in a queue instead of landing in the field. Needs users and permissions first.",
      de: "Für Shops, in denen eine Person schreibt und eine andere freigibt: KI-Texte warten in einer Warteschlange, statt im Feld zu landen. Setzt Benutzer und Berechtigungen voraus.",
      es: "Para tiendas donde una persona escribe y otra aprueba: la salida de la IA espera en una cola en lugar de llegar al campo. Requiere antes usuarios y permisos.",
    },
    notes: "Blocked on user-roles. Two further decisions before any code: the editor's resolve() chain would gain a 'waiting for approval' source that every reader has to handle, and the unattended auto-translation has to be either exempt (then 'nothing goes live unreviewed' is false) or a queue producer (then the automation files daily homework). Decide both before starting.",
  },
  {
    id: "regional-variants",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-05",
    title: {
      en: "Regional variants of a language",
      de: "Regionale Varianten einer Sprache",
      es: "Variantes regionales de un idioma",
    },
    body: {
      en: "Swiss German, Brazilian Portuguese, Latin American Spanish: publish the variant in Shopify and it is translated as that variant — the model is told the region, not just the language.",
      de: "Schweizer Deutsch, brasilianisches Portugiesisch, lateinamerikanisches Spanisch: Variante in Shopify veröffentlichen, und es wird in genau diese Variante übersetzt — das Modell erfährt die Region, nicht nur die Sprache.",
      es: "Alemán suizo, portugués de Brasil, español latinoamericano: publique la variante en Shopify y se traduce como esa variante — el modelo recibe la región, no solo el idioma.",
    },
    notes:
      "Shipped 2026-05 (LOCALE_NAMES + localeName in src/services/ai.service.ts: every batch prompt sends `Swiss German (de-CH)`, name AND full code), VERIFIED end to end 2026-09-17: shop-locale cache passes regional codes through untouched, Intl.DisplayNames names them, the translation tables take them, and theme files resolve under the filename Shopify returns. Two holes were found in that audit and closed the same day (36de017a): isValidLocale rejected es-419 and zh-Hans outright, so those shops could not translate at all, and a glossary rule stored under `de` never reached a de-CH translation. What the app deliberately does NOT have is regional KNOWLEDGE of its own — no ß->ss transform, no per-region vocabulary layer; the model is told the variant and the merchant's glossary decides the rest. Market-specific wording is the neighbouring feature (market-translations), and it stays hand-written: the AI writes the global layer only.",
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
    notes: "CATALOGUE imagery — the picture on the product page. The ad-suite entry also generates images, but those are campaign creatives. If both are ever built, one image-generation plumbing serves both; decide that once, not twice.",
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

  // ── On request (built when a merchant asks, not speculatively) ────────
  {
    id: "rtl",
    visibility: "public",
    status: "on-request",
    area: "translations",
    title: {
      en: "Right-to-left languages",
      de: "Rechts-nach-links-Sprachen",
      es: "Idiomas de derecha a izquierda",
    },
    body: {
      en: "Arabic and Hebrew read right to left, and the editor would have to turn around with them. If you sell in one of those languages, tell us — that is what decides it.",
      de: "Arabisch und Hebräisch werden von rechts nach links gelesen, und der Editor müsste sich mitdrehen. Wenn Sie in einer dieser Sprachen verkaufen, sagen Sie es uns — davon hängt es ab.",
      es: "El árabe y el hebreo se leen de derecha a izquierda, y el editor tendría que girarse con ellos. Si vende en uno de esos idiomas, díganoslo — de eso depende.",
    },
    notes:
      "Moved to on-request 2026-09-17 on a MEASURED assessment, not a guess. The blocker is not our code: @shopify/polaris 13.9.5 ships 229 physical left/right declarations and ZERO [dir=rtl] selectors, so every card, icon slot, popover arrow and select chevron stays mirrored whatever we set. Unblocking that is either a major Polaris upgrade or an override sheet against a vendor stylesheet. Our own share is a few days: root.tsx emits no `dir` at all (documentLang is hardcoded 'en' for admin routes), ~26 physical declarations in app/styles/*.css and ~190 inline-style occurrences over 44 components, of which only BulkGrid's sticky-column `left:` pinning is structurally hard — the two content editors and the formatting toolbar are already direction-neutral and need `dir=\"auto\"`. Three NON-visual findings worth keeping even if the UI never turns around: sanitizer.ts and richtext-normalize.server.ts strip `dir` and `lang` from pasted HTML (a merchant's own RTL markup is silently removed before it reaches Shopify), and readability.ts:155 splits sentences on Latin terminators only, so an Arabic text is one sentence and fires a false 'long sentences' finding on every item. Those are cheap and independent of the Polaris question.",
  },
  {
    id: "api-access",
    visibility: "public",
    status: "on-request",
    area: "platform",
    title: {
      en: "API access",
      de: "API-Zugang",
      es: "Acceso por API",
    },
    body: {
      en: "Start translation and generation runs from your own systems. Built for the shop that needs it — write to us and tell us what you want to trigger.",
      de: "Übersetzungs- und Generierungsläufe aus eigenen Systemen anstoßen. Wird für den Shop gebaut, der es braucht — schreiben Sie uns, was Sie auslösen möchten.",
      es: "Lanzar traducciones y generaciones desde sus propios sistemas. Se construye para la tienda que lo necesita — escríbanos y cuéntenos qué quiere activar.",
    },
    notes: "No merchant tokens exist today — every route authenticates as an embedded Shopify session. This is auth, rate limiting, versioning and documentation, i.e. a product of its own; it is not started without a named shop asking for it.",
  },
  {
    id: "multi-store",
    visibility: "public",
    status: "on-request",
    area: "platform",
    title: {
      en: "Several shops in one account",
      de: "Mehrere Shops in einem Konto",
      es: "Varias tiendas en una cuenta",
    },
    body: {
      en: "Shared instructions, glossary and settings across the shops of one merchant or agency. If you run several shops, tell us — that is what decides whether this gets built.",
      de: "Gemeinsame Anweisungen, Glossar und Einstellungen über die Shops eines Händlers oder einer Agentur hinweg. Wenn Sie mehrere Shops betreiben, sagen Sie es uns — davon hängt ab, ob das gebaut wird.",
      es: "Instrucciones, glosario y ajustes compartidos entre las tiendas de un comerciante o agencia. Si gestiona varias tiendas, díganoslo — de eso depende que se construya.",
    },
    notes: "Every row in the database is scoped by a single shop string and there is no account or organisation model. Needs user-roles as well. Not speculative work.",
  },
  {
    id: "integrations",
    visibility: "public",
    status: "on-request",
    area: "platform",
    title: {
      en: "Notifications outside the app",
      de: "Benachrichtigungen außerhalb der App",
      es: "Avisos fuera de la aplicación",
    },
    body: {
      en: "Inside Shopify the app already tells you when a long run is done. By email, or as a hook your own tools can listen to, it is built for whoever asks — tell us which one you need.",
      de: "Innerhalb von Shopify meldet die App schon heute, wenn ein langer Lauf fertig ist. Per E-Mail oder als Hook für eigene Werkzeuge entsteht es für den, der fragt — sagen Sie uns, was Sie brauchen.",
      es: "Dentro de Shopify la aplicación ya avisa cuando termina una ejecución larga. Por correo, o como gancho para sus propias herramientas, se construye para quien lo pida — díganos cuál necesita.",
    },
    notes: "Was 'Slack notifications' + 'Zapier' in the 2026-01 roadmap; moved to on-request 2026-09-17. The in-app bell (MainNavigation NotificationIcon, api.recently-completed-tasks) is shipped; no email, Slack or outgoing webhook exists. EMAIL is the smaller and more useful half — the Task table already knows its terminal states, so the trigger point exists; what is missing is a sending service, a sender domain with DNS and an unsubscribe path. The outgoing WEBHOOK is the bigger one (URL + secret per shop, signed payloads, retries, a delivery view); the app only does the incoming direction today. A Slack app stays a channel, not a feature.",
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
    title: { en: "The last corners of the shop", de: "Die letzten Ecken des Shops", es: "Los últimos rincones de la tienda" },
    body: {
      en: "Filters, selling plans, the cookie banner, delivery and shop metadata — the texts nobody thinks about until a customer reads them in the wrong language.",
      de: "Filter, Abo-Pläne, das Cookie-Banner, Versand und Shop-Metadaten — die Texte, an die niemand denkt, bis ein Kunde sie in der falschen Sprache liest.",
      es: "Filtros, planes de suscripción, el banner de cookies, envío y metadatos de la tienda — los textos en los que nadie piensa hasta que un cliente los lee en el idioma equivocado.",
    },
    notes: "Re-scoped 2026-09-17: metafields and option values are NOT this card, they shipped 2026-02 (sub-resource-translations). June is the long tail — app.selling-plans.tsx, app.cookie-banner.tsx, app.online-store-extras.tsx, app.delivery.tsx, app.shop-metadata.tsx — plus the metafield SCAN settings (SettingsMetafieldsTab.tsx), which is the discovery half, not the translating half.",
  },
  {
    id: "image-manager",
    visibility: "public",
    status: "shipped",
    area: "media",
    shippedOn: "2026-04",
    title: { en: "Image manager and variant galleries", de: "Bildverwaltung und Varianten-Galerien", es: "Gestor de imágenes y galerías por variante" },
    body: {
      en: "A gallery per variant, bulk upload that assigns files by their name, drag and drop between galleries, WebP conversion, and a storefront gallery that follows the selected variant.",
      de: "Eine Galerie pro Variante, Massen-Upload mit Zuordnung über den Dateinamen, Ziehen und Ablegen zwischen Galerien, WebP-Umwandlung und eine Storefront-Galerie, die der gewählten Variante folgt.",
      es: "Una galería por variante, subida masiva que asigna los archivos por su nombre, arrastrar y soltar entre galerías, conversión a WebP y una galería en la tienda que sigue a la variante elegida.",
    },
    notes: "Re-dated 2026-05 -> 2026-04 on the git record: the manager and the first theme app extension both landed 2026-04-20/21 (VariantImageManager.tsx, extensions .../variant-gallery.liquid), and that week is also when the app first changed the SHOPPER-facing store rather than the admin. Video/3D media and the match-key generator followed through May.",
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
      en: "agents.md and llms.txt generated from your catalogue, a robots.txt check for AI crawlers, a check of the markup your storefront really serves, catalogue readiness, and visits from AI assistants counted without cookies.",
      de: "agents.md und llms.txt aus Ihrem Katalog, eine robots.txt-Prüfung für KI-Crawler, eine Prüfung des Markups, das Ihre Storefront wirklich ausliefert, Katalog-Bereitschaft und Besuche von KI-Assistenten — ohne Cookies gezählt.",
      es: "agents.md y llms.txt generados desde su catálogo, una revisión de robots.txt para rastreadores de IA, una comprobación del marcado que su tienda sirve de verdad, preparación del catálogo y visitas desde asistentes de IA contadas sin cookies.",
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
      en: "A spreadsheet over the whole shop: paste a block from Excel, undo with Ctrl+Z, import a CSV with a preview of what would change, and fill only the missing translations in one pass.",
      de: "Eine Tabelle über den ganzen Shop: einen Block aus Excel einfügen, mit Strg+Z zurücknehmen, eine CSV mit Vorschau der Änderungen importieren und in einem Durchgang nur die fehlenden Übersetzungen ergänzen.",
      es: "Una hoja sobre toda la tienda: pegue un bloque desde Excel, deshaga con Ctrl+Z, importe un CSV con vista previa de lo que cambiaría y rellene en una pasada solo las traducciones que faltan.",
    },
  },
  {
    id: "alt-text-vision",
    visibility: "public",
    status: "shipped",
    area: "media",
    shippedOn: "2026-02",
    title: { en: "Alt texts that describe the actual picture", de: "Alt-Texte, die das echte Bild beschreiben", es: "Textos alternativos que describen la imagen real" },
    body: {
      en: "With image understanding switched on, the AI looks at the photo before it writes — and the alt text is translated like any other field.",
      de: "Mit eingeschaltetem Bildverständnis sieht die KI das Foto, bevor sie schreibt — und der Alt-Text wird übersetzt wie jedes andere Feld.",
      es: "Con la comprensión de imágenes activada, la IA mira la foto antes de escribir — y el texto alternativo se traduce como cualquier otro campo.",
    },
    notes: "Re-dated 2026-06 -> 2026-02 on the git record: 'Send Image to AI' for vision-capable models landed 2026-02-10 (alt-text generation itself 2026-01-11, translation of alt texts 2026-01-13). What 2026-08 added was making it ONE shop-wide setting the server answers (vision-policy.shared.ts) instead of three disagreeing checkboxes — a correction, not the feature's arrival.",
  },

  // ── The first four months ─────────────────────────────────────────────
  // Back-filled 2026-09-17 from the git record (first commit 2026-01-08) so the
  // list shows the whole way here and not just the last quarter. January alone
  // is 836 commits and carries the entire core product; February to April are
  // breadth, the storefront and App-Store readiness. Dates are the month of the
  // first commit that made the thing real, never the month it was polished.
  {
    id: "unified-editor",
    visibility: "public",
    status: "shipped",
    area: "structure",
    shippedOn: "2026-01",
    title: { en: "One editor for everything the shop says", de: "Ein Editor für alles, was der Shop sagt", es: "Un editor para todo lo que dice la tienda" },
    body: {
      en: "Products, collections, pages, blogs, articles and policies in one place, with every translatable field beside its translation — not six different screens.",
      de: "Produkte, Kollektionen, Seiten, Blogs, Artikel und Richtlinien an einem Ort, jedes übersetzbare Feld neben seiner Übersetzung — statt sechs verschiedener Masken.",
      es: "Productos, colecciones, páginas, blogs, artículos y políticas en un solo lugar, con cada campo traducible junto a su traducción — no seis pantallas distintas.",
    },
    notes: "The per-type editors landed 2026-01-09/12 and were folded into one on 2026-01-14 ('Implement unified content editor system'), which is still the rule today: one handler, no parallel ones.",
  },
  {
    id: "ai-providers",
    visibility: "public",
    status: "shipped",
    area: "ai",
    shippedOn: "2026-01",
    title: { en: "Six AI providers, your own key", de: "Sechs KI-Anbieter, Ihr eigener Schlüssel", es: "Seis proveedores de IA, su propia clave" },
    body: {
      en: "Claude, Gemini, OpenAI, Grok, DeepSeek or Hugging Face — you bring the key, you see the bill, and you are not tied to whoever we picked.",
      de: "Claude, Gemini, OpenAI, Grok, DeepSeek oder Hugging Face — Sie bringen den Schlüssel mit, Sie sehen die Rechnung, und Sie hängen nicht an dem Anbieter, den wir ausgesucht haben.",
      es: "Claude, Gemini, OpenAI, Grok, DeepSeek o Hugging Face — usted pone la clave, usted ve la factura, y no depende del proveedor que hayamos elegido nosotros.",
    },
    notes: "Four providers in the initial commit 2026-01-08 (Hugging Face was the default), Grok and DeepSeek on 2026-01-09. Own-key-only has been the rule since day one and every later AI feature inherits it.",
  },
  {
    id: "translations-to-shopify",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-01",
    title: { en: "Translations that land in Shopify itself", de: "Übersetzungen, die in Shopify selbst landen", es: "Traducciones que llegan a Shopify mismo" },
    body: {
      en: "Every translation is written into Shopify's own translation layer, where your theme and your other apps read it — and mirrored locally so the lists open instantly.",
      de: "Jede Übersetzung wird in Shopifys eigene Übersetzungsebene geschrieben, wo Theme und andere Apps sie lesen — und lokal gespiegelt, damit die Listen sofort aufgehen.",
      es: "Cada traducción se escribe en la propia capa de traducción de Shopify, donde la leen su tema y sus otras apps — y se refleja localmente para que las listas abran al instante.",
    },
    notes: "translationsRegister from the initial commit, made reliable the next day with the required translatableContentDigest; the Postgres mirror and the webhooks arrived 2026-01-10/11. The echo rule that governs every write path in this app grew out of this week.",
  },
  {
    id: "language-bar",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-01",
    title: { en: "See which language is still missing what", de: "Sehen, welcher Sprache noch was fehlt", es: "Ver a qué idioma le falta qué" },
    body: {
      en: "The language buttons mark themselves when a field is still empty in that language, down to which field it is — so nothing is found by a customer first.",
      de: "Die Sprachschaltflächen markieren sich selbst, wenn in dieser Sprache noch ein Feld leer ist, bis hinunter zu welchem — damit es nicht der Kunde zuerst findet.",
      es: "Los botones de idioma se marcan solos cuando un campo sigue vacío en ese idioma, hasta decir cuál — para que no lo descubra antes un cliente.",
    },
    notes: "Locale buttons 2026-01-12, field-level detection and the pulsing marker 2026-01-13, the item-list dots 2026-02-25.",
  },
  {
    id: "seo-sidebar",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-01",
    title: { en: "An SEO score while you type", de: "Ein SEO-Score beim Tippen", es: "Una puntuación SEO mientras escribe" },
    body: {
      en: "Title length, meta description, keyword use and what is missing — updated as you write, not after a scan you have to remember to start.",
      de: "Titellänge, Meta-Beschreibung, Keyword-Einsatz und was fehlt — aktualisiert beim Schreiben, nicht nach einem Scan, den man erst starten muss.",
      es: "Longitud del título, meta descripción, uso de palabras clave y qué falta — actualizado mientras escribe, no tras un análisis que hay que acordarse de lanzar.",
    },
    notes: "SeoSidebar.tsx 2026-01-09, live updates the same day. It learned foreign locales in 2026-04 and readability in 2026-08.",
  },
  {
    id: "tasks-page",
    visibility: "public",
    status: "shipped",
    area: "platform",
    shippedOn: "2026-01",
    title: { en: "Every AI run, on the record", de: "Jeder KI-Lauf, nachvollziehbar", es: "Cada ejecución de IA, registrada" },
    body: {
      en: "A page listing what ran, how long it took, what the AI was asked and what it answered — and where a run failed, which items and which languages it was.",
      de: "Eine Seite mit dem, was gelaufen ist, wie lange es gedauert hat, was die KI gefragt wurde und was sie geantwortet hat — und wo ein Lauf scheiterte, welche Artikel und welche Sprachen es waren.",
      es: "Una página con lo que se ejecutó, cuánto tardó, qué se le pidió a la IA y qué respondió — y donde una ejecución falló, qué artículos y qué idiomas fueron.",
    },
    notes: "app.tasks.tsx 2026-01-09, expandable prompt/answer 2026-01-14, the model name on each task 2026-03-23. The 2026-08-23 pass is what the body's second half describes: a partly failed run no longer ends silently, the translation family names the locales that failed, and the counts are phrased in the merchant's own language rather than as '3 of 40 row(s) failed'.",
  },
  {
    id: "security-foundation",
    visibility: "public",
    status: "shipped",
    area: "platform",
    shippedOn: "2026-01",
    title: { en: "Your keys encrypted, your data deletable", de: "Schlüssel verschlüsselt, Daten löschbar", es: "Sus claves cifradas, sus datos borrables" },
    body: {
      en: "API keys are stored encrypted, Shopify's data-deletion webhooks are answered, and the app queues its calls so a big run never runs your shop into a rate limit.",
      de: "API-Schlüssel werden verschlüsselt gespeichert, Shopifys Lösch-Webhooks werden beantwortet, und die App reiht ihre Aufrufe ein, damit ein großer Lauf Ihren Shop nie ins Limit fährt.",
      es: "Las claves de API se guardan cifradas, se responden los webhooks de borrado de Shopify, y la app encola sus llamadas para que una ejecución grande nunca lleve su tienda al límite.",
    },
    notes: "AES-256-GCM key encryption, the mandatory GDPR webhooks and the rate-limited Shopify API gateway all landed 2026-01-13/14 — before the first merchant, not after the first incident.",
  },
  {
    id: "plans-billing",
    visibility: "public",
    status: "shipped",
    area: "platform",
    shippedOn: "2026-01",
    title: { en: "Plans, trial and billing", de: "Pläne, Testphase und Abrechnung", es: "Planes, prueba y facturación" },
    body: {
      en: "Free, Basic, Pro and Max with a seven-day trial: choose, upgrade or downgrade inside Shopify, and see what a tier unlocks before paying for it.",
      de: "Free, Basic, Pro und Max mit sieben Tagen Testphase: in Shopify wählen, wechseln oder herabstufen — und vor dem Bezahlen sehen, was eine Stufe freischaltet.",
      es: "Free, Basic, Pro y Max con siete días de prueba: elegir, subir o bajar de plan dentro de Shopify, y ver qué desbloquea cada nivel antes de pagarlo.",
    },
    notes: "Added 2026-09-17: the whole commercial surface was missing from this list although half the later features reference plan gating. Four tiers 2026-01-13, billing routes 01-14, trial banner 01-27; matured 2026-05 (the advertised 7-day trial through appSubscriptionCreate with a trial-once guard, and upgrade/downgrade without duplicate subscriptions).",
  },
  {
    id: "content-cache",
    visibility: "public",
    status: "shipped",
    area: "platform",
    shippedOn: "2026-01",
    title: { en: "Lists that open instantly", de: "Listen, die sofort aufgehen", es: "Listas que abren al instante" },
    body: {
      en: "Your catalogue is mirrored locally, so lists and languages open without waiting on Shopify. Edits made in Shopify arrive by webhook, and a reload button covers the rest.",
      de: "Ihr Katalog wird lokal gespiegelt, damit Listen und Sprachen ohne Wartezeit aufgehen. Änderungen aus Shopify kommen per Webhook an, für den Rest gibt es eine Neu-laden-Schaltfläche.",
      es: "Su catálogo se refleja localmente, así las listas y los idiomas abren sin esperar a Shopify. Los cambios hechos en Shopify llegan por webhook, y un botón de recarga cubre el resto.",
    },
    notes: "Added 2026-09-17. Cache + webhooks 2026-01-10, reload buttons 01-14, incremental sync on page load 02-12. In 2026-05 the initial import was decoupled from the browser and given a progress bar with counts, plus plan-aware sync and an automatic re-sync on upgrade.",
  },
  // LAST among the 2026-01 entries on purpose: the shipped list sorts by month
  // and keeps file order within one, so this renders at the very bottom — the
  // oldest thing on the page, which is where a beginning belongs.
  {
    id: "project-start",
    visibility: "public",
    status: "shipped",
    area: "platform",
    shippedOn: "2026-01",
    title: { en: "The project starts", de: "Start des Projekts", es: "Comienza el proyecto" },
    body: {
      en: "8 January 2026, first commit: an empty app with a Shopify session. Everything listed above was built after that date.",
      de: "8. Januar 2026, erster Commit: eine leere App mit einer Shopify-Sitzung. Alles, was darüber steht, entstand danach.",
      es: "8 de enero de 2026, primer commit: una aplicación vacía con una sesión de Shopify. Todo lo que está arriba se construyó después.",
    },
    notes: "First commit 2026-01-08, 'Initial commit: Shopify AI Text Manager'. Deliberately carries no commit count: a number in a public body goes stale the same week. Its position is the one thing to preserve when editing this block — see the comment above it.",
  },
  {
    id: "three-languages",
    visibility: "public",
    status: "shipped",
    area: "platform",
    shippedOn: "2026-02",
    title: { en: "The app itself in three languages", de: "Die App selbst in drei Sprachen", es: "La aplicación misma en tres idiomas" },
    body: {
      en: "English, German and Spanish — the tool that translates your shop is not itself English-only.",
      de: "Englisch, Deutsch und Spanisch — das Werkzeug, das Ihren Shop übersetzt, ist nicht selbst nur auf Englisch.",
      es: "Inglés, alemán y español — la herramienta que traduce su tienda no está ella misma solo en inglés.",
    },
    notes: "DE/EN from 2026-01-09, Spanish 2026-02-04, followed by a sweep of the hard-coded strings through mid-February. Every feature since ships in all three or it does not ship.",
  },
  {
    id: "mobile-ui",
    visibility: "public",
    status: "shipped",
    area: "platform",
    shippedOn: "2026-02",
    title: { en: "Usable on a phone", de: "Auf dem Handy benutzbar", es: "Usable en el móvil" },
    body: {
      en: "The editor, the language bar and the bulk actions work in the Shopify mobile admin, not just on a desktop screen.",
      de: "Editor, Sprachleiste und Massenaktionen funktionieren im mobilen Shopify-Admin, nicht nur am Schreibtisch.",
      es: "El editor, la barra de idiomas y las acciones masivas funcionan en el panel móvil de Shopify, no solo en un escritorio.",
    },
    notes: "2026-02-04 to 02-09: hamburger navigation, MobileToolbar, mobile dropdowns for language/operations/item selection, alongside the Shopify design-guideline pass for the App Store.",
  },
  {
    id: "model-choice",
    visibility: "public",
    status: "shipped",
    area: "ai",
    shippedOn: "2026-02",
    title: { en: "Pick the model, see the prompt", de: "Modell wählen, Prompt sehen", es: "Elija el modelo, vea el prompt" },
    body: {
      en: "Not just which provider but which model — and afterwards you can read the exact instruction it was given and the exact answer it returned.",
      de: "Nicht nur welcher Anbieter, sondern welches Modell — und hinterher lesen Sie die genaue Anweisung und die genaue Antwort.",
      es: "No solo qué proveedor, sino qué modelo — y después puede leer la instrucción exacta y la respuesta exacta.",
    },
    notes: "Dynamic model selection 2026-02-12; full prompts and every response stored on the task 2026-02-09/22. The shop-wide writing style arrived with it (2026-02-21) — the field tone-presets will build a picker on top of.",
  },
  {
    id: "sub-resource-translations",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-02",
    title: { en: "Options and metafields translate too", de: "Optionen und Metafelder werden mitübersetzt", es: "Las opciones y los metacampos también se traducen" },
    body: {
      en: "Size and Colour, every option value, and the metafields your other apps created — the parts of a product page that stay in the wrong language everywhere else.",
      de: "Größe und Farbe, jeder Optionswert und die Metafelder Ihrer anderen Apps — die Teile einer Produktseite, die sonst überall in der falschen Sprache bleiben.",
      es: "Talla y Color, cada valor de opción, y los metacampos que crearon sus otras apps — las partes de una ficha de producto que en todas partes se quedan en el idioma equivocado.",
    },
    notes: "2026-02-18, with paginated metafield queries on 02-22 so a product with sixty of them still loads. These ride on their OWN Shopify resource (Metafield / ProductOption / ProductOptionValue GIDs), which is why they were their own piece of work and not a field in the editor.",
  },
  {
    id: "theme-primary-edit",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-02",
    title: { en: "Theme texts, in the original language too", de: "Theme-Texte, auch in der Originalsprache", es: "Textos del tema, también en el idioma original" },
    body: {
      en: "Buttons, labels and section headings from your theme became editable in the primary language, not only translatable into the others.",
      de: "Schaltflächen, Beschriftungen und Abschnittstitel aus Ihrem Theme wurden in der Hauptsprache bearbeitbar, nicht nur in die anderen übersetzbar.",
      es: "Botones, etiquetas y títulos de sección de su tema pasaron a ser editables en el idioma principal, no solo traducibles a los demás.",
    },
    notes: "Theme content viewer 2026-01-12, primary-language writes through themeFilesUpsert 2026-02-16. The app writes only files it owns — it never edits the merchant's theme code.",
  },
  {
    id: "metaobjects-translate",
    visibility: "public",
    status: "shipped",
    area: "structure",
    shippedOn: "2026-02",
    title: { en: "Metaobjects become content", de: "Metaobjekte werden zu Inhalt", es: "Los metaobjetos pasan a ser contenido" },
    body: {
      en: "The entries behind size charts, care instructions and colour swatches got their own tab — listed, synced and translatable in one pass like any other content.",
      de: "Die Einträge hinter Größentabellen, Pflegehinweisen und Farbmustern bekamen einen eigenen Reiter — aufgelistet, synchronisiert und in einem Durchgang übersetzbar wie jeder andere Inhalt.",
      es: "Las entradas tras las guías de tallas, las instrucciones de cuidado y las muestras de color tuvieron su propia pestaña — listadas, sincronizadas y traducibles de una vez como cualquier otro contenido.",
    },
    notes: "Added 2026-09-17 to correct a mis-dating: metaobjects arrived 2026-02-23/24 (tab, DB sync, full CRUD, Translate All, Pro/Max gating). The 2026-08 metaobjects-editor card is the REWORK — every field editable rather than just the label, taxonomy references, type deletion — not the arrival.",
  },
  {
    id: "silent-failures",
    visibility: "public",
    status: "shipped",
    area: "ai",
    shippedOn: "2026-03",
    title: { en: "A failure that says so", de: "Ein Fehlschlag, der es auch sagt", es: "Un fallo que lo dice" },
    body: {
      en: "A translation that did not save, an AI that answered nothing, a result arriving for the item you already left — all three used to look like success. Now they report themselves.",
      de: "Eine Übersetzung, die nicht gespeichert wurde, eine KI, die nichts geantwortet hat, ein Ergebnis für den Artikel, den Sie längst verlassen haben — alle drei sahen vorher wie Erfolg aus. Jetzt melden sie sich.",
      es: "Una traducción que no se guardó, una IA que no respondió nada, un resultado que llega para el artículo que ya abandonó — los tres parecían éxito. Ahora se anuncian.",
    },
    notes: "March was 11 commits, almost all of them this: surfacing silent failures in Translate All (03-11), empty AI responses across every provider (03-23), and binding a result strictly to the item that asked for it (03-11). The quietest month on the record and the one the echo rules came out of.",
  },
  {
    id: "seo-every-language",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-04",
    title: { en: "SEO tools in every language", de: "SEO-Werkzeuge in jeder Sprache", es: "Herramientas SEO en cada idioma" },
    body: {
      en: "The score, the improve button and the character limits stopped being a primary-language privilege — and the title counter now includes the shop name Shopify appends.",
      de: "Score, Verbessern-Schaltfläche und Zeichengrenzen sind kein Privileg der Hauptsprache mehr — und der Titelzähler rechnet den Shop-Namen mit, den Shopify anhängt.",
      es: "La puntuación, el botón de mejorar y los límites de caracteres dejaron de ser privilegio del idioma principal — y el contador de títulos ya incluye el nombre de tienda que Shopify añade.",
    },
    notes: "2026-04-07 for foreign-locale AI and scoring, 2026-04-04 for the SEO settings tab and the shop-name suffix in the counter. A German meta description being judged by an English-only sidebar was the complaint behind it.",
  },
  {
    id: "copy-to-locale",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-04",
    title: { en: "Copy a value into a language", de: "Einen Wert in eine Sprache übernehmen", es: "Copiar un valor a un idioma" },
    body: {
      en: "Not everything should be translated — a brand name, a model number, a SKU. One button copies the original across instead.",
      de: "Nicht alles gehört übersetzt — ein Markenname, eine Modellnummer, eine SKU. Eine Schaltfläche übernimmt stattdessen das Original.",
      es: "No todo debe traducirse — un nombre de marca, un número de modelo, un SKU. Un botón copia el original tal cual.",
    },
    notes: "2026-04-18, extended to product options and alt texts within two days. The blue marking of primary fields whose translation is missing came in the same change, and AI translation errors started showing on the field instead of in a banner.",
  },

  // Added 2026-09-17 by a gap analysis against the git log. File position
  // inside the shipped block carries no meaning — the page sorts by month —
  // so these sit together rather than being threaded in by date.
  {
    id: "structured-data",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-05",
    title: { en: "Rich results without touching the theme", de: "Rich Results, ohne das Theme anzufassen", es: "Resultados enriquecidos sin tocar el tema" },
    body: {
      en: "Product, breadcrumb and organisation markup delivered by an app block, so a search result can carry price, availability and ratings.",
      de: "Produkt-, Breadcrumb- und Organisations-Markup über einen App-Block ausgeliefert, damit ein Suchtreffer Preis, Verfügbarkeit und Bewertungen tragen kann.",
      es: "Marcado de producto, migas de pan y organización entregado por un bloque de la app, para que un resultado de búsqueda pueda llevar precio, disponibilidad y valoraciones.",
    },
    notes: "Added 2026-09-17: structured-data.service.ts and its own theme extension landed 2026-05-18, three months before the AEO section, and the aeo card had been carrying the credit. FAQ, Review and GTIN followed 2026-07; the crawl-based check of what the storefront REALLY serves is 2026-08-09.",
  },
  {
    id: "media-video-3d",
    visibility: "public",
    status: "shipped",
    area: "media",
    shippedOn: "2026-05",
    title: { en: "Videos, 3D models and YouTube per variant", de: "Videos, 3D-Modelle und YouTube pro Variante", es: "Vídeos, modelos 3D y YouTube por variante" },
    body: {
      en: "A variant's gallery is not only photographs: upload a video or a 3D model, or paste a YouTube or Vimeo link, and the storefront gallery shows it with the rest.",
      de: "Die Galerie einer Variante besteht nicht nur aus Fotos: Video oder 3D-Modell hochladen oder einen YouTube- oder Vimeo-Link einfügen — die Storefront-Galerie zeigt es mit.",
      es: "La galería de una variante no es solo fotos: suba un vídeo o un modelo 3D, o pegue un enlace de YouTube o Vimeo, y la galería de la tienda lo muestra con lo demás.",
    },
    notes: "Added 2026-09-17, split out of image-manager (April), whose card promised these although they arrived 2026-05-20 — uploads, per-variant YouTube/Vimeo, 3D via a parallel metafield, media-type thumbnails, lightbox 05-21. Their VideoObject markup for Google is 2026-08-18.",
  },
  {
    id: "theme-picker",
    visibility: "public",
    status: "shipped",
    area: "translations",
    shippedOn: "2026-07",
    title: { en: "Work on any theme, not just the live one", de: "An jedem Theme arbeiten, nicht nur am aktiven", es: "Trabajar en cualquier tema, no solo en el activo" },
    body: {
      en: "Prepare the texts of an unpublished redesign while the shop keeps running on the current theme — with a guard that stops a write landing in the wrong one.",
      de: "Die Texte eines unveröffentlichten Redesigns vorbereiten, während der Shop auf dem aktuellen Theme weiterläuft — mit einer Sperre, die einen Schreibvorgang im falschen Theme verhindert.",
      es: "Preparar los textos de un rediseño sin publicar mientras la tienda sigue con el tema actual — con una protección que evita que una escritura acabe en el tema equivocado.",
    },
    notes: "Added 2026-09-17. 2026-07-06: merchant-selectable theme with theme-scoped enumeration and sync, plus the cross-theme write guard; the published theme is pinned to the top of the picker (07-08).",
  },
  {
    id: "accessibility-audit",
    visibility: "public",
    status: "shipped",
    area: "seo",
    shippedOn: "2026-07",
    title: { en: "Accessibility and best practices, measured", de: "Barrierefreiheit und Best Practices, gemessen", es: "Accesibilidad y buenas prácticas, medidas" },
    body: {
      en: "The run that measures speed also reports accessibility and best-practice scores — and the missing alt texts it finds go straight to the AI that writes them.",
      de: "Der Lauf, der die Geschwindigkeit misst, meldet auch Barrierefreiheit und Best Practices — und die fehlenden Alt-Texte, die er findet, gehen direkt an die KI, die sie schreibt.",
      es: "La ejecución que mide la velocidad informa también de accesibilidad y buenas prácticas — y los textos alternativos que faltan van directos a la IA que los escribe.",
    },
    notes: "Added 2026-09-17. 2026-07-22 fetches both from the same PSI run, 07-23 surfaces the checks PSI leaves grey, 07-24 adds app-native alt-text coverage warnings wired to alt-text generation.",
  },
  {
    id: "media-library-alt",
    visibility: "public",
    status: "shipped",
    area: "media",
    shippedOn: "2026-08",
    title: { en: "An alt text for every file", de: "Ein Alt-Text für jede Datei", es: "Un texto alternativo para cada archivo" },
    body: {
      en: "Collection images, article images and everything else in your file library became editable and translatable — not only the photos that hang on a product.",
      de: "Kollektionsbilder, Artikelbilder und alles andere in Ihrer Dateibibliothek wurden bearbeitbar und übersetzbar — nicht nur die Fotos, die an einem Produkt hängen.",
      es: "Imágenes de colección, de artículo y todo lo demás en su biblioteca de archivos pasaron a ser editables y traducibles — no solo las fotos que cuelgan de un producto.",
    },
    notes: "Added 2026-09-17. 2026-08-13: a cache and sync for the shop's MediaImage library, the read_files/write_files scope that made every alt text writable, and the whole library in the bulk editor's image rows; collection and article image alt texts 08-14.",
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
    id: "ai-usage-metering",
    visibility: "internal",
    status: "planned",
    area: "platform",
    title: "Real AI token metering (both key modes) — the prerequisite for everything priced",
    notes: "Phase 0 of the managed-key plan and worth shipping ALONE: `_executeAIRequestInner` reduces every provider response to a string and throws the `usage` object away, so the app has never known what one generation or one batch translation actually costs. `estimateTokens` is not that number — it exists for the rate limiter and over-counts output by ~10x (prompt/4 + a flat 8192). Capture real usage in executeAIRequest/_executeAIRequestInner — NOT in askAI, which replayRequest (task recovery) bypasses — price it through a single micro-EUR table, write AiUsageCounter per (shop, period, source). Rules: an absent usage object estimates UP and is COUNTED as estimated (under-counting is the direction that costs us money); an unknown model is priced at its provider's most expensive entry, never as free; integers in micro-EUR, never BigInt — the logger and Task paths JSON.stringify their values and a BigInt throws there. The rule that must ship WITH enforcement, not after it: a budget refusal inside the detached repair (stale-translation-sync.server.ts) must be an ABORT, never an entry in outcome.failed — mayPurge is `purgeOnPrimaryChange || autoTranslateExternalChanges`, i.e. always true on exactly the shops managed mode serves, so a refusal that looks like 'the AI could not deliver' sends translationsRemove and DELETES the merchant's storefront translations because our prepaid budget ran out, unrecoverably (the digest baseline has already advanced). Metering BYO too is not scope creep: it is the measurement the price ladder is derived from, and it answers for BYO shops what AI_PROVIDER_BALANCE_FEASIBILITY.md concluded no provider answers uniformly.",
    ref: "docs/plans/PLAN_MANAGED_AI_KEY.md",
  },
  {
    id: "managed-ai-pricing",
    visibility: "internal",
    status: "planned",
    area: "platform",
    title: "Managed-AI plan variants (Basic 21.90 / Pro 39.90 / Max 99.90), per-tier budget, margin guard",
    notes: "The commercial half of managed-ai-key. Shape: entitlements stay 4-valued, key source is a SECOND axis — no eight plans. Each paid tier gets a managed variant with its own Shopify subscription NAME and PRICE (getPlanFromSubscription resolves by name then price, so no two variants may share a price). Provisional 2026-09-17: surcharge 12/20/40 EUR against a per-BILLING-PERIOD PROVIDER-cost budget of 1.50/2.50/5.00 EUR, i.e. a ~14.7% cost share after taking Shopify's revenue share at its worst case (15%, though it is 0% below $1M today). The budgets are what the guard ALLOWS, not round numbers: with the buffer the effective ceiling is 16% of net, and the plan's first draft (1.50/3.00/6.00 against 10/20/40) read as 17.6% and failed its own test — which is the point of having it as a test. Basic is 21.90 and not 19.90 because 19.90 is PRO's price today and getPlanFromSubscription falls back to a price match: a renamed Basic+AI subscription would have resolved to Pro. Four things the first draft had no answer for, each found in review and each free money for somebody: the 7-day trial grants a full budget for zero revenue (and redact restores eligibility), a partner dev store holds a Shopify-verified test:true subscription that charges nothing, a calendar-month counter against EVERY_30_DAYS billing grants two budgets to a sign-up on the 31st (35% cost share, 1.76x the guard) and makes upgrade-spend-cancel a ~4.87 EUR/shop loop, and a refunded charge does not refund the spent tokens. The guard is a TEST, not a promise: budget x 1.25 (FX + list-price + overshoot buffer) <= surchargeNet x 0.20, plus the ladder rule taster <= 0.25 x smallest paid budget — raising a budget or cutting a price without the other then fails the build. Every number is provisional until ai-usage-metering has measured the real average call; the table is built so one measured constant updates it. Model is PINNED in managed mode (cost control a customer can switch off is not cost control) and several model ids in the repo are already stale (DEFAULT_MODELS carries deepseek-chat and gemini-2.0-flash-lite; CURATED_MODELS adds gemini-1.5-*, gpt-4-turbo, o3-mini and an invalid claude-opus-4-0 id) — harmless for BYO, an outage for a PINNED managed model. Retirement dates are external facts, re-checkable but not verifiable from the repo. Deliberately not in v1: Shopify usage-based overage (appUsagePricing + cappedAmount) — the right instrument, a second line item, the first follow-up. Provider terms checked 2026-09-18 and they permit this shape: building an application for end users is granted, reselling account/API access is not — so the offer is worded as 'a plan with AI included, fair-use volume', never as a token quantity, which is also the unit the codebase cannot hold stable. Production runs a SINGLE instance (owner, 2026-09-18), which is what makes the overshoot bound and the in-memory queue/rate-window/ticks sound — load-bearing, and the day it is scaled to two every one of them doubles or races. PRICING_AND_LIMITS.md argues its limits from 'AI costs us nothing' — true for BYO, false for managed, and that document is qualified in the same change rather than left as a second, contradicting answer.",
    ref: "docs/plans/PLAN_MANAGED_AI_KEY.md",
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
    notes: "Only meaningful with user-roles and an enterprise tier.",
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
