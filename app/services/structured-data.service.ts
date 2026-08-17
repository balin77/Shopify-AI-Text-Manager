/**
 * Structured Data (JSON-LD) Service
 *
 * Pure, dependency-free builders that turn the app's existing
 * Product / Collection / Article / shop data into schema.org JSON-LD for
 * rich snippets (Product, BreadcrumbList, Article, Organization, optional
 * AggregateRating/Review).
 *
 * Kept pure (no DB, no network, no server imports) so it is fully unit
 * testable and can be reused both by the SEO sidebar (copyable code block +
 * validation feedback) and any server route. The storefront also emits the
 * same shapes automatically via the `structured-data` theme app extension
 * (built from native Liquid objects) — this service is the in-app mirror.
 */

export type JsonLd = Record<string, unknown>;

const SCHEMA_CTX = "https://schema.org";

/** Google's Rich Results Test, keyed with a storefront URL (Phase 5 batch
 *  audit + the existing live-preview page both deep-link here). Centralized
 *  so the two callers can't drift on the endpoint. */
export const GOOGLE_RICH_RESULTS_TEST = "https://search.google.com/test/rich-results";

/**
 * Slugifies a display string into a URL-safe handle segment. Used to derive
 * an Article's blog handle from `Article.blogTitle` (the DB cache only
 * stores the blog's display title, not its handle) — shared by the
 * structured-data preview route and the Phase 5 batch audit so both build
 * the same `/blogs/<handle>/<handle>` URL from the same input.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Strips HTML tags + collapses whitespace; truncates to a sane length. */
export function plainText(html: string | null | undefined, max = 5000): string {
  if (!html) return "";
  const text = String(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Removes null/undefined/"" entries so the JSON-LD stays clean. */
function compact<T extends JsonLd>(obj: T): T {
  const out: JsonLd = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as T;
}

function normalizeBase(domain: string): string {
  const d = (domain || "").trim().replace(/\/+$/, "");
  if (!d) return "";
  return /^https?:\/\//i.test(d) ? d : `https://${d}`;
}

export function absoluteUrl(domain: string, path: string): string {
  const base = normalizeBase(domain);
  if (!base) return "";
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

// ─────────────────────────── inputs ────────────────────────────────────────

export interface ShopInfo {
  /** Primary storefront domain, e.g. "shop.com" or "https://shop.com". */
  domain: string;
  name: string;
  logoUrl?: string | null;
  /** Social / external profile URLs for Organization.sameAs. */
  sameAs?: string[];
}

export interface ProductInput {
  title: string;
  descriptionHtml?: string | null;
  handle: string;
  seoDescription?: string | null;
  featuredImageUrl?: string | null;
  vendor?: string | null;
  sku?: string | null;
  price?: number | string | null;
  currency?: string | null;
  available?: boolean | null;
  ratingValue?: number | null;
  ratingCount?: number | null;
  /** Upper bound of the rating scale (Shopify's standard `reviews.rating`
   *  metafield stores this as `.value.scale_max`); mirrored into
   *  AggregateRating.bestRating, defaulting to 5 like the storefront Liquid
   *  block (plan §C2). */
  ratingScaleMax?: number | null;
  /** Raw barcode (UPC/EAN/ISBN/JAN) — mapped to gtin8/12/13/14 via gtinProps(). */
  gtin?: string | null;
  mpn?: string | null;
  /** Brand homepage/profile URL, added to Brand.url when set. */
  brandUrl?: string | null;
  /** Defaults to "https://schema.org/NewCondition" when an Offer is built. */
  itemCondition?: string | null;
  /** ISO date string; only emitted on the Offer when the caller provides one.
   *  Never synthesized from a clock: a made-up date would tell Google and
   *  shoppers the price is guaranteed until then, which no store datum backs
   *  (App Store requirement 1.1.4, "use only factual information"). The
   *  storefront Liquid block follows the same rule and reads the merchant's
   *  `custom.price_valid_until` product metafield. */
  priceValidUntil?: string | null;
}

export interface CollectionInput {
  title: string;
  descriptionHtml?: string | null;
  handle: string;
  seoDescription?: string | null;
}

export interface ArticleInput {
  title: string;
  body?: string | null;
  summary?: string | null;
  handle: string;
  blogHandle: string;
  imageUrl?: string | null;
  author?: string | null;
  publishedAt?: string | Date | null;
  updatedAt?: string | Date | null;
}

export interface BreadcrumbItem {
  name: string;
  /** Absolute or root-relative path. */
  url: string;
}

// ─────────────────────────── builders ──────────────────────────────────────

export function buildOrganizationJsonLd(shop: ShopInfo): JsonLd {
  const url = normalizeBase(shop.domain);
  const jsonLd: JsonLd = compact({
    "@context": SCHEMA_CTX,
    "@type": "Organization",
    name: shop.name,
    url,
    logo: shop.logoUrl || undefined,
  });
  // sameAs is deliberately set OUTSIDE compact() (§ fix 11): compact() drops
  // empty arrays, which would erase the distinction between "checked, found
  // none" (shop.sameAs === []) and "never checked" (shop.sameAs ===
  // undefined) that validateJsonLd's orgNoSameAs gate below relies on.
  if (shop.sameAs !== undefined) {
    jsonLd.sameAs = shop.sameAs.filter(Boolean);
  }
  return jsonLd;
}

/**
 * Maps a raw barcode (UPC/EAN/ISBN/JAN) to the correct schema.org gtin*
 * property: strips everything but digits, then picks gtin8/12/13/14 by
 * length, falling back to the generic `gtin` for any other non-empty
 * length. Returns {} for an empty/non-digit barcode so callers can spread
 * the result straight into a JSON-LD object without an extra branch.
 */
export function gtinProps(barcode: string | null | undefined): Record<string, string> {
  const digits = String(barcode ?? "").replace(/\D/g, "");
  if (!digits) return {};
  const key =
    digits.length === 8
      ? "gtin8"
      : digits.length === 12
      ? "gtin12"
      : digits.length === 13
      ? "gtin13"
      : digits.length === 14
      ? "gtin14"
      : "gtin";
  return { [key]: digits };
}

export function buildProductJsonLd(p: ProductInput, shop: ShopInfo): JsonLd {
  const url = absoluteUrl(shop.domain, `/products/${p.handle}`);
  const description =
    plainText(p.seoDescription, 400) || plainText(p.descriptionHtml, 400);

  let offers: JsonLd | undefined;
  if (p.price !== null && p.price !== undefined && p.price !== "") {
    // schema.org wants a dot-decimal numeric string; normalize and drop a
    // non-numeric / locale-comma value rather than emitting garbage.
    const priceNum = Number(String(p.price).replace(",", "."));
    offers = compact({
      "@type": "Offer",
      price: Number.isFinite(priceNum) ? priceNum.toFixed(2) : undefined,
      priceCurrency: p.currency || undefined,
      availability:
        p.available == null
          ? undefined
          : p.available
          ? "https://schema.org/InStock"
          : "https://schema.org/OutOfStock",
      url: url || undefined,
      // AEO/shopping-feed completeness (plan §C1): default to "new" rather
      // than omitting — Google/AI shopping surfaces treat a missing
      // itemCondition as a data-quality flag.
      itemCondition: p.itemCondition || "https://schema.org/NewCondition",
      priceValidUntil: p.priceValidUntil || undefined,
    });
  }

  // Mirrors the storefront Liquid block's `reviews.rating`/`reviews.rating_count`
  // read (plan §C2): only Shopify's standard rating metafields (populated by
  // Judge.me/Loox/etc. review apps that write them) are covered — an app's
  // proprietary namespace (e.g. `loox.avg_rating`) is a known, documented
  // limit and is not read here or in the theme extension.
  let aggregateRating: JsonLd | undefined;
  if (
    p.ratingValue != null &&
    p.ratingCount != null &&
    p.ratingCount > 0 &&
    p.ratingValue > 0
  ) {
    aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: p.ratingValue,
      bestRating: p.ratingScaleMax ?? 5,
      reviewCount: p.ratingCount,
    };
  }

  // Built manually (not compact()) so the shape is byte-identical to before
  // when brandUrl is absent: just { "@type": "Brand", name }.
  let brand: JsonLd | undefined;
  if (p.vendor || shop.name) {
    brand = { "@type": "Brand", name: p.vendor || shop.name };
    if (p.brandUrl) brand.url = p.brandUrl;
  }

  return compact({
    "@context": SCHEMA_CTX,
    "@type": "Product",
    name: p.title,
    description,
    image: p.featuredImageUrl || undefined,
    sku: p.sku || undefined,
    url: url || undefined,
    ...gtinProps(p.gtin),
    mpn: p.mpn || undefined,
    brand,
    offers,
    aggregateRating,
  });
}

export function buildCollectionJsonLd(
  c: CollectionInput,
  shop: ShopInfo,
): JsonLd {
  const url = absoluteUrl(shop.domain, `/collections/${c.handle}`);
  return compact({
    "@context": SCHEMA_CTX,
    "@type": "CollectionPage",
    name: c.title,
    description:
      plainText(c.seoDescription, 400) || plainText(c.descriptionHtml, 400),
    url: url || undefined,
  });
}

function toIso(d: string | Date | null | undefined): string | undefined {
  if (!d) return undefined;
  const date = d instanceof Date ? d : new Date(d);
  return isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function buildArticleJsonLd(a: ArticleInput, shop: ShopInfo): JsonLd {
  const url = absoluteUrl(
    shop.domain,
    `/blogs/${a.blogHandle}/${a.handle}`,
  );
  return compact({
    "@context": SCHEMA_CTX,
    "@type": "BlogPosting",
    headline: a.title,
    description: plainText(a.summary, 400) || plainText(a.body, 400),
    image: a.imageUrl || undefined,
    datePublished: toIso(a.publishedAt),
    dateModified: toIso(a.updatedAt) || toIso(a.publishedAt),
    author: a.author
      ? { "@type": "Person", name: a.author }
      : { "@type": "Organization", name: shop.name },
    publisher: compact({
      "@type": "Organization",
      name: shop.name,
      logo: shop.logoUrl
        ? { "@type": "ImageObject", url: shop.logoUrl }
        : undefined,
    }),
    mainEntityOfPage: url || undefined,
    url: url || undefined,
  });
}

export function buildBreadcrumbJsonLd(
  items: BreadcrumbItem[],
  shop: ShopInfo,
): JsonLd | null {
  const valid = items.filter((i) => i.name && i.url);
  if (valid.length === 0) return null;
  return {
    "@context": SCHEMA_CTX,
    "@type": "BreadcrumbList",
    itemListElement: valid.map((item, idx) => ({
      "@type": "ListItem",
      position: idx + 1,
      name: item.name,
      item: /^https?:\/\//i.test(item.url)
        ? item.url
        : absoluteUrl(shop.domain, item.url),
    })),
  };
}

export interface FaqEntry {
  question: string;
  answer: string;
}

/**
 * FAQPage JSON-LD (plan §C2) from a list of {question, answer} pairs — the
 * shape stored in the product metafield `custom.faq` (type `json`). Entries
 * with an empty/blank question or answer are filtered out; returns `null`
 * when nothing valid remains so callers can skip rendering entirely (same
 * convention as buildBreadcrumbJsonLd).
 */
export function buildFaqJsonLd(entries: FaqEntry[] | null | undefined): JsonLd | null {
  const valid = (entries || []).filter(
    (e) => e && String(e.question ?? "").trim() !== "" && String(e.answer ?? "").trim() !== "",
  );
  if (valid.length === 0) return null;
  return {
    "@context": SCHEMA_CTX,
    "@type": "FAQPage",
    mainEntity: valid.map((e) => ({
      "@type": "Question",
      name: e.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: e.answer,
      },
    })),
  };
}

// ─────────────────────────── validation ────────────────────────────────────

/** Stable, translation-friendly identifier for every warning validateJsonLd
 *  can emit. The UI uses this to look up localized copy + optional fix-up
 *  hints (deep-links to Settings → Brand, sample-product admin URL, etc.).
 *  `message` remains the fallback English copy for callers without i18n. */
export type JsonLdWarningCode =
  | "noStructuredData"
  | "missingContext"
  | "missingType"
  | "productMissingName"
  | "productNoImage"
  | "productNoDescription"
  | "productNoOffer"
  | "offerNoCurrency"
  | "offerNoAvailability"
  | "productNoGtinMpn"
  | "ratingNoValue"
  | "ratingNoReviewCount"
  | "faqNoQuestions"
  | "articleMissingHeadline"
  | "articleNoImage"
  | "articleNoDatePublished"
  | "orgNoLogo"
  | "orgNoSameAs";

export interface JsonLdWarning {
  severity: "error" | "warning" | "info";
  message: string;
  code: JsonLdWarningCode;
}

export interface ValidateJsonLdOptions {
  /** In-editor preview mode: the caller cannot supply data that lives outside
   *  the editor (product Offer built from variant price, Article.publishedAt,
   *  Organization.logo from shop brand). The storefront Liquid block still
   *  emits these from native/metafield/shop-brand data, so warning here would
   *  be a false positive. Off by default so the standalone preview page and
   *  audits keep flagging genuinely missing data.
   *
   *  Phase 5 batch audit (json-ld-audit.service.ts) also sets this to `true`:
   *  the DB content cache has no `availableForSale`/inventory column and no
   *  `Article.publishedAt` column at all (verified against schema.prisma), so
   *  running the batch with previewMode `false` would flag `offerNoAvailability`
   *  / `articleNoDatePublished` on essentially every scanned item — noise, not
   *  signal. The storefront Liquid block still emits both from live/native
   *  data, so suppressing here is not a false "all clear", it's an honest
   *  "we can't check this from the cache". */
  previewMode?: boolean;
}

/**
 * Lightweight schema.org sanity check for the SEO sidebar. Reports missing
 * required/recommended fields (the same things Google's Rich Results test
 * flags) without pulling in a heavy validator.
 */
export function validateJsonLd(
  jsonLd: JsonLd | null,
  options: ValidateJsonLdOptions = {},
): JsonLdWarning[] {
  const w: JsonLdWarning[] = [];
  if (!jsonLd) {
    return [{ severity: "error", code: "noStructuredData", message: "No structured data generated." }];
  }
  const type = jsonLd["@type"];
  if (!jsonLd["@context"]) {
    w.push({ severity: "error", code: "missingContext", message: "Missing @context." });
  }
  if (!type) {
    w.push({ severity: "error", code: "missingType", message: "Missing @type." });
  }

  if (type === "Product") {
    if (!jsonLd.name)
      w.push({ severity: "error", code: "productMissingName", message: "Product is missing a name." });
    if (!jsonLd.image)
      w.push({
        severity: "warning",
        code: "productNoImage",
        message: "Product has no image — Google strongly recommends one.",
      });
    if (!jsonLd.description)
      w.push({
        severity: "warning",
        code: "productNoDescription",
        message: "Product has no description.",
      });
    const offers = jsonLd.offers as JsonLd | undefined;
    if (!offers) {
      if (!options.previewMode) {
        w.push({
          severity: "warning",
          code: "productNoOffer",
          message: "No Offer (price/availability) — required for price snippets.",
        });
      }
    } else {
      if (!offers.priceCurrency) {
        w.push({
          severity: "warning",
          code: "offerNoCurrency",
          message: "Offer is missing priceCurrency.",
        });
      }
      // Gated by previewMode too (unlike offerNoCurrency): availability is
      // exactly the kind of data "the caller cannot supply" that previewMode
      // exists for — see ValidateJsonLdOptions.previewMode. The single-item
      // preview page always live-fetches the sample product's first-variant
      // availability (fetchProductPreviewData in app.seo.structured-data.tsx)
      // and calls this with previewMode left at its false default, so this
      // change doesn't affect it.
      if (!offers.availability && !options.previewMode) {
        w.push({
          severity: "warning",
          code: "offerNoAvailability",
          message: "Offer is missing availability.",
        });
      }
    }
    if (
      !jsonLd.gtin &&
      !jsonLd.gtin8 &&
      !jsonLd.gtin12 &&
      !jsonLd.gtin13 &&
      !jsonLd.gtin14 &&
      !jsonLd.mpn
    ) {
      w.push({
        severity: "warning",
        code: "productNoGtinMpn",
        message:
          "Product has no GTIN/MPN — reduces matchability in Google/AI shopping results.",
      });
    }
    // Rating is genuinely optional (plan §C2) — no warning for its plain
    // absence, only when it's present but malformed/incomplete.
    const aggregateRating = jsonLd.aggregateRating as JsonLd | undefined;
    if (aggregateRating) {
      if (!aggregateRating.ratingValue) {
        w.push({
          severity: "warning",
          code: "ratingNoValue",
          message: "AggregateRating is missing ratingValue.",
        });
      }
      const reviewCount = aggregateRating.reviewCount as number | undefined;
      if (reviewCount == null || reviewCount <= 0) {
        w.push({
          severity: "warning",
          code: "ratingNoReviewCount",
          message: "AggregateRating has no reviewCount (or it is 0).",
        });
      }
    }
  }

  if (type === "FAQPage") {
    const mainEntity = jsonLd.mainEntity as unknown[] | undefined;
    if (!mainEntity || mainEntity.length === 0) {
      w.push({
        severity: "error",
        code: "faqNoQuestions",
        message: "FAQPage has no questions (mainEntity is empty).",
      });
    }
  }

  if (type === "BlogPosting") {
    if (!jsonLd.headline)
      w.push({ severity: "error", code: "articleMissingHeadline", message: "Article is missing a headline." });
    if (!jsonLd.image)
      w.push({
        severity: "warning",
        code: "articleNoImage",
        message: "Article has no image — recommended for rich results.",
      });
    if (!jsonLd.datePublished && !options.previewMode)
      w.push({
        severity: "warning",
        code: "articleNoDatePublished",
        message: "Article has no datePublished.",
      });
  }

  if (type === "Organization" && !jsonLd.logo && !options.previewMode) {
    w.push({
      severity: "warning",
      code: "orgNoLogo",
      message: "Organization has no logo — recommended for knowledge panel.",
    });
  }

  // Phase 5 (§7.1): social-profile links strengthen Google's knowledge-panel
  // confidence but are genuinely optional — info severity, not a warning.
  // Not gated by previewMode: sameAs is set via the storefront theme block's
  // `social_urls` setting (extensions/storefront/blocks/structured-data.liquid),
  // which neither this preview route nor the batch audit currently reads back
  // (it lives in theme app-embed block settings, not `settings_data.json`'s
  // documented `current.*` shape the way the logo/`current.logo` is) — so
  // `shop.sameAs` is never populated by any caller today. That's an
  // intentional, documented gap (§11), not a bug — BUT emitting the warning
  // unconditionally on that basis would make it a permanent false positive
  // for every shop forever (§ fix 11). `buildOrganizationJsonLd` only sets
  // `jsonLd.sameAs` (even to `[]`) when the caller actually supplied
  // `shop.sameAs` — `undefined` means "never checked", so only emit once
  // there is something to actually be empty.
  if (type === "Organization" && jsonLd.sameAs !== undefined && (jsonLd.sameAs as unknown[]).length === 0) {
    w.push({
      severity: "info",
      code: "orgNoSameAs",
      message: "Organization has no sameAs (social profile links) — recommended for a stronger knowledge panel.",
    });
  }

  return w;
}

/** Serializes JSON-LD for a <script type="application/ld+json"> block. */
export function renderJsonLdScript(jsonLd: JsonLd | JsonLd[]): string {
  // `<` is escaped so a value containing "</script>" cannot break out of the
  // surrounding script element when injected into HTML.
  return JSON.stringify(jsonLd, null, 2).replace(/</g, "\\u003c");
}
