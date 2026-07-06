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
  /** Raw barcode (UPC/EAN/ISBN/JAN) — mapped to gtin8/12/13/14 via gtinProps(). */
  gtin?: string | null;
  mpn?: string | null;
  /** Brand homepage/profile URL, added to Brand.url when set. */
  brandUrl?: string | null;
  /** Defaults to "https://schema.org/NewCondition" when an Offer is built. */
  itemCondition?: string | null;
  /** ISO date string; only emitted on the Offer when the caller provides one
   *  (kept clock-free here for purity/testability — the storefront Liquid
   *  block defaults it to "now + 1 year" itself). */
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
  return compact({
    "@context": SCHEMA_CTX,
    "@type": "Organization",
    name: shop.name,
    url,
    logo: shop.logoUrl || undefined,
    sameAs:
      shop.sameAs && shop.sameAs.length > 0
        ? shop.sameAs.filter(Boolean)
        : undefined,
  });
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

// ─────────────────────────── validation ────────────────────────────────────

export interface JsonLdWarning {
  severity: "error" | "warning";
  message: string;
}

/**
 * Lightweight schema.org sanity check for the SEO sidebar. Reports missing
 * required/recommended fields (the same things Google's Rich Results test
 * flags) without pulling in a heavy validator.
 */
export function validateJsonLd(jsonLd: JsonLd | null): JsonLdWarning[] {
  const w: JsonLdWarning[] = [];
  if (!jsonLd) {
    return [{ severity: "error", message: "No structured data generated." }];
  }
  const type = jsonLd["@type"];
  if (!jsonLd["@context"]) {
    w.push({ severity: "error", message: "Missing @context." });
  }
  if (!type) {
    w.push({ severity: "error", message: "Missing @type." });
  }

  if (type === "Product") {
    if (!jsonLd.name)
      w.push({ severity: "error", message: "Product is missing a name." });
    if (!jsonLd.image)
      w.push({
        severity: "warning",
        message: "Product has no image — Google strongly recommends one.",
      });
    if (!jsonLd.description)
      w.push({
        severity: "warning",
        message: "Product has no description.",
      });
    const offers = jsonLd.offers as JsonLd | undefined;
    if (!offers) {
      w.push({
        severity: "warning",
        message: "No Offer (price/availability) — required for price snippets.",
      });
    } else {
      if (!offers.priceCurrency) {
        w.push({
          severity: "warning",
          message: "Offer is missing priceCurrency.",
        });
      }
      if (!offers.availability) {
        w.push({
          severity: "warning",
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
        message:
          "Product has no GTIN/MPN — reduces matchability in Google/AI shopping results.",
      });
    }
  }

  if (type === "BlogPosting") {
    if (!jsonLd.headline)
      w.push({ severity: "error", message: "Article is missing a headline." });
    if (!jsonLd.image)
      w.push({
        severity: "warning",
        message: "Article has no image — recommended for rich results.",
      });
    if (!jsonLd.datePublished)
      w.push({
        severity: "warning",
        message: "Article has no datePublished.",
      });
  }

  if (type === "Organization" && !jsonLd.logo) {
    w.push({
      severity: "warning",
      message: "Organization has no logo — recommended for knowledge panel.",
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
