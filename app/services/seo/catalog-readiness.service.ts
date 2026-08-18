/**
 * Catalog readiness for AI channels.
 *
 * Since Shopify Spring '26 the platform syndicates eligible products to ChatGPT,
 * Microsoft Copilot, Google AI Mode, Gemini and the Shop app by itself — no app
 * makes a catalog "visible" any more. What decides whether a product is picked
 * up, compared and cited is the COMPLETENESS of its data: brand, category,
 * GTIN, a description and an image. That is what this report measures, from the
 * DB cache, with no live call.
 *
 * Deliberately narrow. It reports the five fields the AI-channel/feed
 * requirements share, and nothing that another section already owns:
 * SEO titles, meta descriptions and alt-text coverage belong to the store audit
 * (audit.service.ts), delivery belongs to the crawl. Repeating them here would
 * give the same product two different scores in two tabs.
 *
 * Two rules from the codebase carry the weight:
 *  - `attributesSyncedAt` is the discriminator for `vendor`/`categoryId`. On a
 *    row written by a pre-Phase-0 sync those columns hold migration defaults,
 *    which is indistinguishable from "the merchant left it empty" — so the
 *    brand/category half is reported as UNKNOWN and the UI offers a resync,
 *    never a red "missing" (attribute-sync.shared.ts).
 *  - ACTIVE products only. DRAFT is not published anywhere, and UNLISTED is
 *    deliberately reachable by direct link only — listing either as a
 *    syndication gap would report merchant intent as a defect. Same reasoning
 *    as the llms.txt catalog query.
 */

import { attributesKnown } from "../attribute-sync.shared";

/** Scan cap, mirroring analyzeStore's MAX_AUDIT_ITEMS_PER_TYPE. */
export const MAX_CATALOG_PRODUCTS = 1000;

/** Item refs carried per bucket, mirroring MAX_PROBLEM_BUCKET_ITEMS. */
export const MAX_CATALOG_BUCKET_ITEMS = 100;

/**
 * A description shorter than this (tags stripped) is treated as missing. Not a
 * quality judgement: a feed entry of a few words carries no attribute an
 * answer engine could compare on, and Google's feed spec rejects them too.
 */
export const MIN_DESCRIPTION_CHARS = 40;

export type CatalogReadinessCode =
  /** No vendor — the "brand" every shopping surface groups and filters by. */
  | "brandMissing"
  /** No Shopify taxonomy category — what puts the product in the right bucket. */
  | "categoryMissing"
  /** No variant carries a barcode (GTIN/EAN/UPC) — the identifier that lets an
   *  engine match this product across sources. */
  | "gtinMissing"
  /** No usable description text. */
  | "descriptionMissing"
  /** No image at all. */
  | "imageMissing";

export interface CatalogReadinessItem {
  id: string;
  title: string;
  handle: string;
}

export interface CatalogReadinessBucket {
  code: CatalogReadinessCode;
  count: number;
  /** Capped at MAX_CATALOG_BUCKET_ITEMS — `count` stays the true total. */
  items: CatalogReadinessItem[];
}

export interface CatalogReadinessReport {
  /** ACTIVE products scanned (after the cap). */
  scanned: number;
  /** ACTIVE products in the cache (before the cap). */
  available: number;
  capped: boolean;
  /**
   * False when any scanned row has no `attributesSyncedAt`: brand and category
   * are then UNKNOWN for the catalog, not missing. The two buckets are omitted
   * entirely in that state — a half-filled report is worse than an explained
   * gap.
   */
  attributeDataKnown: boolean;
  /**
   * Products with no finding at all — which means "none among the checks that
   * RAN". With `attributeDataKnown` false, brand and category were not checked,
   * so a product can be counted here without either being set. Anything
   * rendering this number has to qualify it in that state; the AEO section
   * switches to its "partly checked" wording rather than claiming completeness
   * for two fields nobody looked at.
   */
  ready: number;
  /** Worst bucket first. */
  buckets: CatalogReadinessBucket[];
}

interface ProductRow {
  id: string;
  title: string;
  handle: string;
  vendor: string | null;
  categoryId: string | null;
  descriptionHtml: string | null;
  featuredImageUrl: string | null;
  attributesSyncedAt: Date | null;
}

/** Visible text length of an HTML description. */
export function descriptionTextLength(html: string | null | undefined): number {
  if (!html) return 0;
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * Which checks a single product fails. Pure — the DB half lives in
 * `analyzeCatalogReadiness`, this is what the tests drive.
 *
 * `attributesKnown` is passed in rather than derived per row so the whole
 * report speaks with one voice: with the attribute block unsynced, NO product
 * gets a brand/category finding, instead of some rows looking complete purely
 * because they happen to have been resynced.
 */
export function findingsForProduct(
  product: {
    vendor: string | null;
    categoryId: string | null;
    descriptionHtml: string | null;
    featuredImageUrl: string | null;
  },
  opts: { attributesKnown: boolean; hasGtin: boolean },
): CatalogReadinessCode[] {
  const findings: CatalogReadinessCode[] = [];
  if (opts.attributesKnown) {
    if (!(product.vendor || "").trim()) findings.push("brandMissing");
    if (!(product.categoryId || "").trim()) findings.push("categoryMissing");
  }
  if (!opts.hasGtin) findings.push("gtinMissing");
  if (descriptionTextLength(product.descriptionHtml) < MIN_DESCRIPTION_CHARS) {
    findings.push("descriptionMissing");
  }
  if (!(product.featuredImageUrl || "").trim()) findings.push("imageMissing");
  return findings;
}

/** Bucket order: the fields an answer engine cannot work around come first. */
const BUCKET_ORDER: CatalogReadinessCode[] = [
  "imageMissing",
  "descriptionMissing",
  "gtinMissing",
  "brandMissing",
  "categoryMissing",
];

export async function analyzeCatalogReadiness(
  db: any,
  shop: string,
): Promise<CatalogReadinessReport> {
  const where = { shop, status: "ACTIVE" };

  const [available, products] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where,
      select: {
        id: true,
        title: true,
        handle: true,
        vendor: true,
        categoryId: true,
        descriptionHtml: true,
        featuredImageUrl: true,
        attributesSyncedAt: true,
      },
      orderBy: { handle: "asc" },
      take: MAX_CATALOG_PRODUCTS,
    }) as Promise<ProductRow[]>,
  ]);

  // One query for the whole GTIN question instead of pulling every variant of
  // every product: a product qualifies as soon as ONE variant carries a
  // barcode. `distinct` keeps the result one row per product.
  const withBarcode: Array<{ productId: string }> = products.length
    ? await db.productVariant.findMany({
        where: {
          productId: { in: products.map((p) => p.id) },
          barcode: { not: null },
          NOT: { barcode: "" },
        },
        select: { productId: true },
        distinct: ["productId"],
      })
    : [];
  const gtinProductIds = new Set(withBarcode.map((v) => v.productId));

  // One unsynced row makes the whole attribute half unreliable — see the
  // interface note. `every` over the scanned window, not over the cache.
  const attributeDataKnown =
    products.length > 0 && products.every((p) => attributesKnown(p));

  const byCode = new Map<CatalogReadinessCode, CatalogReadinessItem[]>();
  const counts = new Map<CatalogReadinessCode, number>();
  let ready = 0;

  for (const p of products) {
    const findings = findingsForProduct(p, {
      attributesKnown: attributeDataKnown,
      hasGtin: gtinProductIds.has(p.id),
    });
    if (findings.length === 0) {
      ready++;
      continue;
    }
    for (const code of findings) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
      const items = byCode.get(code) ?? [];
      if (items.length < MAX_CATALOG_BUCKET_ITEMS) {
        items.push({ id: p.id, title: p.title, handle: p.handle });
      }
      byCode.set(code, items);
    }
  }

  const buckets: CatalogReadinessBucket[] = BUCKET_ORDER.filter((code) => counts.has(code)).map(
    (code) => ({ code, count: counts.get(code) ?? 0, items: byCode.get(code) ?? [] }),
  );

  return {
    scanned: products.length,
    available,
    capped: available > products.length,
    attributeDataKnown,
    ready,
    buckets,
  };
}
