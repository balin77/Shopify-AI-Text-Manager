/**
 * Which products carry a video that lives ONLY in a variant gallery, and which
 * of those can produce a video rich result at all.
 *
 * Why this is a live sweep and not a DB read: the two metafields that hold
 * these videos — `custom.variant_gallery_order` (json, entries with
 * `kind == "url"`) and `custom.variant_external_videos` (list.url) — are not
 * mirrored anywhere. `ProductVariant.galleryJson` holds FILE gids, so an
 * external URL leaves no trace in the cache. Caching them would mean a column
 * on four product write paths plus a discriminator for rows written before it;
 * a bounded sweep inside an already-detached task is the cheaper honest answer.
 *
 * What it is for: `uploadDate` is a REQUIRED property of Google's video rich
 * result. For product media the sync fills it from `File.createdAt`; a gallery
 * entry is a URL with no `File` behind it, so the ONLY source is the merchant's
 * own `custom.video_upload_date` — and without it the storefront block omits
 * the property rather than inventing one. That is the right call and it used to
 * be invisible: nothing in the app said which products were affected, or that
 * any were. This is that measurement.
 *
 * Two facts it reports separately, because they need different actions:
 *  - a YouTube gallery video WITHOUT a date → markup is emitted but can never
 *    become a rich result. One metafield fixes it.
 *  - a VIMEO gallery video → the block emits NOTHING for it at all (the rich
 *    result needs a thumbnail and none can be derived from a Vimeo link), so no
 *    date would help. Reporting the two as one number would send a merchant to
 *    set a date that changes nothing.
 *
 * The usual known-vs-empty rule applies to the whole thing, in THREE places:
 * a task result written before this existed carries no `galleryVideos` key at
 * all; a sweep that threw returns `null`; and a sweep that was refused before
 * it read a single variant ALSO returns `null` rather than a zero — a zero
 * there would render as "no gallery videos found", which is a confident false
 * negative from a query that never ran. Only a sweep that actually looked
 * reports a count, and if it broke off part-way it carries `capped` next to it.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { logger } from "~/utils/logger.server";
import {
  parseExternalVideoUrl,
  externalVideoKey,
  type ExternalVideoHost,
} from "./external-video-url.shared";

/** Variants per page. Flat over `productVariants` rather than nested inside
 *  `products`, because a nested connection multiplies the query cost by its
 *  parent's page size and throttles a catalogue of any size. */
const VARIANTS_PER_PAGE = 100;
/** Hard bound on the sweep. 20 × 100 = 2000 variants; past that the report
 *  says so instead of silently describing a prefix as the whole shop. */
const MAX_VARIANT_PAGES = 20;
/** Products listed by name in the report. The COUNTS above stay complete. */
const MAX_LISTED_PRODUCTS = 25;
/** Products per `custom.video_upload_date` lookup page. */
const DATE_LOOKUP_CHUNK = 50;

const VARIANT_SWEEP_QUERY = `#graphql
  query seoGalleryVideoSweep($cursor: String) {
    productVariants(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        product { id title handle }
        galleryOrder: metafield(namespace: "custom", key: "variant_gallery_order") { value }
        externalVideos: metafield(namespace: "custom", key: "variant_external_videos") { value }
      }
    }
  }
`;

const UPLOAD_DATE_QUERY = `#graphql
  query seoGalleryVideoDates($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        uploadDate: metafield(namespace: "custom", key: "video_upload_date") { value }
      }
    }
  }
`;

export interface GalleryVideoProduct {
  /** Product GID — the editor deep-link (`?select=<GID>`). */
  id: string;
  title: string;
  handle: string;
  /** DISTINCT YouTube videos, deduplicated product-wide exactly as the
   *  storefront block deduplicates them (`"<host>|<id>"`). */
  youtube: number;
  /** DISTINCT Vimeo videos. The block emits nothing for these. */
  vimeo: number;
  /** Whether `custom.video_upload_date` is set on the product. */
  hasUploadDate: boolean;
}

export interface GalleryVideoAudit {
  generatedAt: string;
  /** Variants actually looked at. */
  scannedVariants: number;
  /** True when the sweep stopped at MAX_VARIANT_PAGES — a prefix, not the shop. */
  capped: boolean;
  /** Products carrying at least one external gallery video, capped for display. */
  products: GalleryVideoProduct[];
  /** TRUE total of such products — never capped. */
  totalProducts: number;
  /** …of which have a YouTube gallery video but no `custom.video_upload_date`:
   *  markup is emitted and can never become a rich result. */
  missingDate: number;
  /** …of which carry ONLY Vimeo gallery videos: nothing is emitted for them at
   *  all, and a date would not change that. */
  vimeoOnly: number;
}

/** Every external video URL a variant's two metafields hold. */
function urlsOfVariant(node: any): string[] {
  const out: string[] = [];

  // `variant_gallery_order` is a json metafield holding [{kind, value}]. It
  // arrives as a STRING here (the Admin API returns `metafield.value` raw),
  // unlike Liquid where `.value` is already parsed.
  const rawOrder = node?.galleryOrder?.value;
  if (typeof rawOrder === "string" && rawOrder.trim()) {
    try {
      const parsed = JSON.parse(rawOrder);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && entry.kind === "url" && typeof entry.value === "string") out.push(entry.value);
        }
      }
    } catch {
      // A hand-edited metafield can hold anything. An unreadable one is not a
      // finding about videos — it simply contributes none.
    }
  }

  // `variant_external_videos` is list.url — a JSON array of strings.
  const rawList = node?.externalVideos?.value;
  if (typeof rawList === "string" && rawList.trim()) {
    try {
      const parsed = JSON.parse(rawList);
      if (Array.isArray(parsed)) {
        for (const u of parsed) if (typeof u === "string") out.push(u);
      }
    } catch {
      /* same as above */
    }
  }

  return out;
}

/**
 * Sweep the shop's variants for external gallery videos, then resolve the
 * upload-date metafield for the products that have any.
 *
 * Never throws: this runs inside the JSON-LD batch task, whose main report must
 * survive a throttled or refused sweep. A failure yields `null`, which the UI
 * reads as "not checked" — the same rule as a task result written before this
 * existed.
 */
export async function runGalleryVideoAudit(
  admin: AdminApiContext,
  shop: string,
): Promise<GalleryVideoAudit | null> {
  try {
    /** productGid → { title, handle, keys } — keys are `"<host>|<id>"`, so one
     *  video hanging on twelve variants counts once, exactly as the storefront
     *  block deduplicates it. */
    const byProduct = new Map<
      string,
      { title: string; handle: string; keys: Set<string>; hosts: Map<string, ExternalVideoHost> }
    >();

    let cursor: string | null = null;
    let pages = 0;
    let scannedVariants = 0;
    let capped = false;

    while (pages < MAX_VARIANT_PAGES) {
      const res: Response = await admin.graphql(VARIANT_SWEEP_QUERY, {
        variables: { cursor },
      });
      const body: any = await res.json();
      const conn = body?.data?.productVariants;
      if (!conn) {
        // A top-level GraphQL error (throttle, permission) — report what we
        // have as capped rather than claiming a complete scan.
        logger.warn("[gallery-video-audit] variant sweep returned no data", {
          context: "SEO",
          shop,
          errors: JSON.stringify(body?.errors ?? null).slice(0, 500),
        });
        capped = true;
        break;
      }

      for (const node of conn.nodes ?? []) {
        scannedVariants += 1;
        const productGid: string | undefined = node?.product?.id;
        if (!productGid) continue;
        for (const url of urlsOfVariant(node)) {
          const ref = parseExternalVideoUrl(url);
          if (!ref) continue;
          const entry =
            byProduct.get(productGid) ??
            {
              title: node.product?.title ?? "",
              handle: node.product?.handle ?? "",
              keys: new Set<string>(),
              hosts: new Map<string, ExternalVideoHost>(),
            };
          const key = externalVideoKey(ref);
          entry.keys.add(key);
          entry.hosts.set(key, ref.host);
          byProduct.set(productGid, entry);
        }
      }

      pages += 1;
      if (!conn.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
      if (pages >= MAX_VARIANT_PAGES) capped = true;
    }

    // Nothing looked at AND the sweep broke off: we learned NOTHING, and
    // returning a zero here would render as "no gallery videos found" — a
    // confident false negative from a query that never ran. `null` is the
    // honest answer and the UI reads it as "not checked". The partial case
    // (some variants scanned, then throttled) keeps its numbers and carries
    // `capped`, which the UI shows alongside them.
    if (capped && scannedVariants === 0) return null;

    const productGids = [...byProduct.keys()];
    const dates = await fetchUploadDates(admin, productGids, shop);

    const products: GalleryVideoProduct[] = productGids.map((id) => {
      const e = byProduct.get(id)!;
      let youtube = 0;
      let vimeo = 0;
      for (const key of e.keys) {
        if (e.hosts.get(key) === "vimeo") vimeo += 1;
        else youtube += 1;
      }
      return {
        id,
        title: e.title,
        handle: e.handle,
        youtube,
        vimeo,
        hasUploadDate: dates.get(id) === true,
      };
    });

    // A product with only Vimeo videos gets nothing emitted at all, so a date
    // would not help it — counted apart from the ones a date actually fixes.
    const vimeoOnly = products.filter((p) => p.youtube === 0 && p.vimeo > 0).length;
    const missingDate = products.filter((p) => p.youtube > 0 && !p.hasUploadDate).length;

    return {
      generatedAt: new Date().toISOString(),
      scannedVariants,
      capped,
      // Worst first: the ones a merchant can fix, then the rest.
      products: [...products]
        .sort(
          (a, b) =>
            Number(a.hasUploadDate) - Number(b.hasUploadDate) ||
            b.youtube - a.youtube ||
            a.title.localeCompare(b.title),
        )
        .slice(0, MAX_LISTED_PRODUCTS),
      totalProducts: products.length,
      missingDate,
      vimeoOnly,
    };
  } catch (err: unknown) {
    logger.warn("[gallery-video-audit] sweep failed", {
      context: "SEO",
      shop,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** productGid → whether `custom.video_upload_date` holds a non-empty value. */
async function fetchUploadDates(
  admin: AdminApiContext,
  gids: string[],
  shop: string,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (let i = 0; i < gids.length; i += DATE_LOOKUP_CHUNK) {
    const chunk = gids.slice(i, i + DATE_LOOKUP_CHUNK);
    try {
      const res: Response = await admin.graphql(UPLOAD_DATE_QUERY, { variables: { ids: chunk } });
      const body: any = await res.json();
      for (const node of body?.data?.nodes ?? []) {
        if (!node?.id) continue;
        out.set(node.id, typeof node.uploadDate?.value === "string" && node.uploadDate.value.trim() !== "");
      }
    } catch (err: unknown) {
      // Leave the chunk unset. `hasUploadDate` then reads false, which shows a
      // product as needing a date it may already have — the milder error: it
      // sends a merchant to look, never tells them nothing is wrong.
      logger.warn("[gallery-video-audit] upload-date lookup failed", {
        context: "SEO",
        shop,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
