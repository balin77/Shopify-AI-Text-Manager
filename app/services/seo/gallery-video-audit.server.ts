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
 * the property rather than inventing one. That used to be invisible: nothing
 * said which products were affected, or that any were.
 *
 * **"ONLY in a gallery" is a real condition, not a figure of speech, and
 * getting it wrong makes this feature actively harmful.** The storefront block
 * seeds its dedup set from the product's own media before the gallery pass runs
 * (structured-data.liquid, `v_seen_ids`), so a video that is BOTH product media
 * and a gallery link is emitted once — from the media loop, with the automatic
 * date. Reporting it as "missing a date" would push the merchant to set
 * `custom.video_upload_date`, which is the product-WIDE override: it replaces
 * the accurate `File.createdAt` stamp of every media video on that product with
 * one guessed date. So the media keys are subtracted before anything is
 * counted, exactly as the block subtracts them.
 *
 * Two facts it reports separately, because they need different actions:
 *  - a YouTube gallery video WITHOUT a date → markup is emitted but can never
 *    become a rich result. One metafield fixes it.
 *  - a VIMEO gallery video → the block emits NOTHING for it (the rich result
 *    needs a thumbnail and none can be derived from a Vimeo link), so no date
 *    would help. Reporting the two as one number would send a merchant to set a
 *    date that changes nothing.
 *
 * The known-vs-empty rule applies in FOUR places, and none of them may render
 * as "no gallery videos found": a task result written before this existed
 * carries no `galleryVideos` key; a sweep that threw returns `null`; a sweep
 * refused before reading a single variant returns `null`; and a sweep that read
 * nothing at all returns `null` too — a zero there would be a confident false
 * negative from a query that never ran. Only a sweep that actually looked
 * reports a count, and one that broke off part-way carries `capped` beside it.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { logger } from "~/utils/logger.server";
import { parseExternalVideoUrl } from "~/utils/mediaKind";

/** Variants per page. Flat over `productVariants` rather than nested inside
 *  `products`, because a nested connection multiplies the query cost by its
 *  parent's page size and throttles a catalogue of any size. */
const VARIANTS_PER_PAGE = 100;
/** Hard bound on the sweep. 20 × 100 = 2000 variants; past that the report
 *  says so instead of silently describing a prefix as the whole shop. */
const MAX_VARIANT_PAGES = 20;
/** Products listed by name in the report. The COUNTS stay complete. */
const MAX_LISTED_PRODUCTS = 25;
/** Products per follow-up lookup page. */
const PRODUCT_LOOKUP_CHUNK = 50;
/** Media window of the follow-up lookup — the block's own cap is 5 emitted
 *  videos, so a window this wide cannot miss a colliding one in practice. */
const PRODUCT_MEDIA_WINDOW = 50;
/**
 * The storefront block stops after 5 emitted VideoObjects per product
 * (`v_printed >= 5`), counting media videos FIRST. A product already at the cap
 * from its own media prints nothing for its gallery links, so telling the
 * merchant to date them would be advice about markup that never appears.
 */
const BLOCK_VIDEO_CAP = 5;
/** Throttle retries per page before the sweep gives up on it. */
const MAX_THROTTLE_RETRIES = 4;

const VARIANT_SWEEP_QUERY = `#graphql
  query seoGalleryVideoSweep($cursor: String, $first: Int!) {
    productVariants(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        product { id title status }
        galleryOrder: metafield(namespace: "custom", key: "variant_gallery_order") { value }
        externalVideos: metafield(namespace: "custom", key: "variant_external_videos") { value }
      }
    }
  }
`;

// `uploadDates` is the per-media map the product sync writes from
// File.createdAt. A media video whose numeric id is missing there gets NO
// uploadDate on the storefront -- the block omits it rather than inventing
// one, which is the whole point of asking for it here.
//
// The explanation lives OUTSIDE the template on purpose: a `#graphql`
// document is sent to Shopify verbatim and must carry no comments (CLAUDE.md;
// three comment lines once took /app/blog down with a bogus syntax error).
const PRODUCT_LOOKUP_QUERY = `#graphql
  query seoGalleryVideoProducts($ids: [ID!]!, $mediaWindow: Int!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        uploadDate: metafield(namespace: "custom", key: "video_upload_date") { value }
        uploadDates: metafield(namespace: "custom", key: "video_upload_dates") { value }
        media(first: $mediaWindow) {
          nodes {
            mediaContentType
            ... on Video { id }
            ... on ExternalVideo { id originUrl }
          }
        }
      }
    }
  }
`;

export interface GalleryVideoProduct {
  /** Product GID — the editor deep-link (`?select=<GID>`). */
  id: string;
  title: string;
  /** DISTINCT YouTube videos that the gallery contributes and the product's own
   *  media do NOT already carry — deduplicated product-wide as the block is. */
  youtube: number;
  /** DISTINCT Vimeo videos from the gallery. The block emits nothing for them. */
  vimeo: number;
  /**
   * Videos in the product's OWN media that the storefront emits WITHOUT an
   * uploadDate. Independent of the gallery numbers above: the usual cause is a
   * video uploaded after the last product sync, so `custom.video_upload_dates`
   * has no entry for it yet — and a resync fixes it without anyone typing a
   * date. That is why it is counted separately from the gallery case, where no
   * sync can ever help.
   */
  mediaMissingDate: number;
  /** Whether `custom.video_upload_date` is set on the product. */
  hasUploadDate: boolean;
}

export interface GalleryVideoAudit {
  generatedAt: string;
  /** Variants actually looked at. */
  scannedVariants: number;
  /** True when the sweep stopped early — a prefix of the shop, not the shop. */
  capped: boolean;
  /** Products carrying at least one gallery-only video, capped for display. */
  products: GalleryVideoProduct[];
  /** TRUE total of such products — never capped. */
  totalProducts: number;
  /** …of which have a YouTube gallery video but no `custom.video_upload_date`:
   *  markup is emitted and can never become a rich result. */
  missingDate: number;
  /**
   * Products whose OWN media videos are emitted without an uploadDate. A
   * separate number from `missingDate`, because the remedy is a different one:
   * here a product sync fills the date in by itself, while a gallery video has
   * no file behind it and needs the merchant's own date.
   */
  mediaMissingDate: number;
  /** …of which carry at least one VIMEO gallery video: nothing is emitted for
   *  those at all, whatever the date says. Overlaps `missingDate` on purpose —
   *  one product can have both problems and needs to hear about both. */
  withVimeo: number;
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

/** `"<host>|<id>"` — the identity the storefront block's dedup set uses, so the
 *  audit counts the videos the block would emit rather than the URLs a merchant
 *  happened to paste. */
function keyOf(url: string): string | null {
  const parsed = parseExternalVideoUrl(url);
  return parsed ? `${parsed.host}|${parsed.externalId}` : null;
}

const isThrottled = (body: any): boolean =>
  Array.isArray(body?.errors) &&
  body.errors.some((e: any) => e?.extensions?.code === "THROTTLED");

/** Seconds to wait before retrying a throttled page, from Shopify's own
 *  bucket state when it sends one and a plain back-off otherwise. */
function throttleDelayMs(body: any, attempt: number): number {
  const status = body?.extensions?.cost?.throttleStatus;
  const requested = body?.extensions?.cost?.requestedQueryCost;
  if (
    status &&
    typeof status.currentlyAvailable === "number" &&
    typeof status.restoreRate === "number" &&
    status.restoreRate > 0 &&
    typeof requested === "number"
  ) {
    const deficit = Math.max(0, requested - status.currentlyAvailable);
    return Math.min(10_000, Math.ceil((deficit / status.restoreRate) * 1000) + 250);
  }
  return Math.min(10_000, 1000 * 2 ** attempt);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sweep the shop's variants for gallery videos, then resolve each affected
 * product's upload-date metafield and its own media.
 *
 * Never throws: this runs inside the JSON-LD batch task, whose main report must
 * survive a throttled or refused sweep. A failure yields `null`, which the UI
 * reads as "not checked".
 */
export async function runGalleryVideoAudit(
  admin: AdminApiContext,
  shop: string,
): Promise<GalleryVideoAudit | null> {
  try {
    /** productGid → { title, keys } — keys are `"<host>|<id>"`, so one video
     *  hanging on twelve variants counts once, exactly as the block dedupes. */
    const byProduct = new Map<string, { title: string; keys: Set<string> }>();
    /**
     * Every ACTIVE product the sweep passed, gallery or not. The media-date
     * check needs it: a product whose only video is its own media never has a
     * gallery URL, so `byProduct` would never contain it and the whole class
     * of "video emitted without a date" stayed invisible. The variant sweep is
     * already capped at MAX_VARIANT_PAGES x VARIANTS_PER_PAGE, so this set is
     * bounded by the same number rather than by the catalogue.
     */
    const activeProducts = new Map<string, string>();

    let cursor: string | null = null;
    let pages = 0;
    let scannedVariants = 0;
    let capped = false;

    sweep: while (pages < MAX_VARIANT_PAGES) {
      let conn: any = null;

      // Shopify reports throttling as HTTP 200 with a THROTTLED entry in
      // `errors`, which the transport does not retry — without this loop the
      // sweep gives up on the first busy moment, and a shop big enough to have
      // variant galleries is exactly a shop big enough to throttle.
      for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt += 1) {
        const res: Response = await admin.graphql(VARIANT_SWEEP_QUERY, {
          variables: { cursor, first: VARIANTS_PER_PAGE },
        });
        const body: any = await res.json();
        if (body?.data?.productVariants) {
          conn = body.data.productVariants;
          break;
        }
        if (isThrottled(body) && attempt < MAX_THROTTLE_RETRIES) {
          await sleep(throttleDelayMs(body, attempt));
          continue;
        }
        logger.warn("[gallery-video-audit] variant sweep returned no data", {
          context: "SEO",
          shop,
          errors: JSON.stringify(body?.errors ?? null).slice(0, 500),
        });
        capped = true;
        break sweep;
      }
      if (!conn) {
        capped = true;
        break;
      }

      for (const node of conn.nodes ?? []) {
        scannedVariants += 1;
        const productGid: string | undefined = node?.product?.id;
        if (!productGid) continue;
        // A DRAFT or ARCHIVED product has no storefront page, so "its video
        // cannot become a rich result" reports merchant intent as a defect —
        // the rule catalog-readiness.service.ts already follows.
        if (node?.product?.status !== "ACTIVE") continue;
        if (!activeProducts.has(productGid)) activeProducts.set(productGid, node.product?.title ?? "");
        for (const url of urlsOfVariant(node)) {
          const key = keyOf(url);
          if (!key) continue;
          const entry = byProduct.get(productGid) ?? {
            title: node.product?.title ?? "",
            keys: new Set<string>(),
          };
          entry.keys.add(key);
          byProduct.set(productGid, entry);
        }
      }

      pages += 1;
      if (!conn.pageInfo?.hasNextPage) break;
      // A missing cursor with hasNextPage set would restart the sweep from the
      // beginning and count the first page twenty times.
      if (!conn.pageInfo?.endCursor) {
        capped = true;
        break;
      }
      cursor = conn.pageInfo.endCursor;
      if (pages >= MAX_VARIANT_PAGES) capped = true;
    }

    // Nothing looked at: we learned NOTHING, and a zero here would render as
    // "no gallery videos found" — a confident false negative from a sweep that
    // never read a row. An empty shop is the same answer for the same reason.
    if (scannedVariants === 0) return null;

    const productGids = [...activeProducts.keys()];
    const context = await fetchProductContext(admin, productGids, shop);

    const products: GalleryVideoProduct[] = [];
    for (const id of productGids) {
      const e = byProduct.get(id);
      const ctx = context.get(id);
      const mediaMissingDate = ctx?.mediaMissingDate ?? 0;

      let youtube = 0;
      let vimeo = 0;
      if (e) {
        // The block prints the product's OWN media videos first and skips any
        // gallery link it already emitted — so those are not gallery-only, and
        // they already carry an automatic date. And once the media alone fill
        // the block's 5-video cap, no gallery video prints at all, whatever
        // its date.
        const capped5 = (ctx?.mediaVideoCount ?? 0) >= BLOCK_VIDEO_CAP;
        if (!capped5) {
          for (const key of [...e.keys].filter((k) => !ctx?.mediaKeys.has(k))) {
            if (key.startsWith("vimeo|")) vimeo += 1;
            else youtube += 1;
          }
        }
      }

      // Two independent reasons to appear here, and a product can have both:
      // a gallery video the block emits without a date, or a MEDIA video in
      // the same state. Neither implies the other.
      if (youtube === 0 && vimeo === 0 && mediaMissingDate === 0) continue;
      products.push({
        id,
        title: activeProducts.get(id) ?? e?.title ?? "",
        youtube,
        vimeo,
        mediaMissingDate,
        hasUploadDate: ctx?.hasUploadDate === true,
      });
    }

    const withVimeo = products.filter((p) => p.vimeo > 0).length;
    const missingDate = products.filter((p) => p.youtube > 0 && !p.hasUploadDate).length;
    const mediaMissingDate = products.filter((p) => p.mediaMissingDate > 0).length;

    return {
      generatedAt: new Date().toISOString(),
      scannedVariants,
      capped,
      // Worst first: the ones a merchant can fix, then the rest.
      products: [...products]
        .sort(
          (a, b) =>
            Number(a.hasUploadDate) - Number(b.hasUploadDate) ||
            b.mediaMissingDate - a.mediaMissingDate ||
            b.youtube - a.youtube ||
            a.title.localeCompare(b.title),
        )
        .slice(0, MAX_LISTED_PRODUCTS),
      totalProducts: products.length,
      missingDate,
      mediaMissingDate,
      withVimeo,
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

interface ProductContext {
  hasUploadDate: boolean;
  /** `"<host>|<id>"` of the product's OWN external-video media. */
  mediaKeys: Set<string>;
  /** Video media of any kind — what the block's 5-video cap counts first. */
  mediaVideoCount: number;
  /**
   * Media videos the storefront emits WITHOUT an uploadDate — Google lists the
   * property as required for the video rich result, so those blocks are served
   * and cannot become one. The usual cause is mundane: the video was uploaded
   * after the last product sync, so `custom.video_upload_dates` has no entry
   * for its id yet. Nothing reported this before; the gallery sweep next door
   * covers only videos that are NOT product media.
   */
  mediaMissingDate: number;
}

async function fetchProductContext(
  admin: AdminApiContext,
  gids: string[],
  shop: string,
): Promise<Map<string, ProductContext>> {
  const out = new Map<string, ProductContext>();
  for (let i = 0; i < gids.length; i += PRODUCT_LOOKUP_CHUNK) {
    const chunk = gids.slice(i, i + PRODUCT_LOOKUP_CHUNK);
    try {
      const res: Response = await admin.graphql(PRODUCT_LOOKUP_QUERY, {
        variables: { ids: chunk, mediaWindow: PRODUCT_MEDIA_WINDOW },
      });
      const body: any = await res.json();
      for (const node of body?.data?.nodes ?? []) {
        if (!node?.id) continue;
        const mediaKeys = new Set<string>();
        let mediaVideoCount = 0;
        let mediaMissingDate = 0;
        const override =
          typeof node.uploadDate?.value === "string" && node.uploadDate.value.trim() !== "";
        // The map is `{ "<numeric media id>": "<ISO timestamp>" }`. It arrives
        // as a raw STRING from the Admin API, and a hand-edited metafield can
        // hold anything -- an unreadable one contributes no dates rather than
        // throwing the whole sweep.
        const dated = new Set<string>();
        const rawDates = node.uploadDates?.value;
        if (typeof rawDates === "string" && rawDates.trim()) {
          try {
            const parsed = JSON.parse(rawDates);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === "string" && v.trim()) dated.add(k);
              }
            }
          } catch {
            // Same rule as the gallery metafield above.
          }
        }
        for (const m of node.media?.nodes ?? []) {
          if (m?.mediaContentType !== "VIDEO" && m?.mediaContentType !== "EXTERNAL_VIDEO") continue;
          mediaVideoCount += 1;
          if (typeof m.originUrl === "string") {
            const key = keyOf(m.originUrl);
            if (key) mediaKeys.add(key);
          }
          // The product-wide override wins for every video, exactly as the
          // block reads it, so one date set by hand clears the whole product.
          if (override) continue;
          // Only a video the block would actually PRINT can be missing a date
          // on a live page: past the 5-video cap nothing is emitted.
          if (mediaVideoCount > BLOCK_VIDEO_CAP) continue;
          const numeric = typeof m.id === "string" ? (m.id.split("/").pop() ?? "") : "";
          if (!/^[0-9]+$/.test(numeric) || !dated.has(numeric)) mediaMissingDate += 1;
        }
        out.set(node.id, {
          hasUploadDate: override,
          mediaKeys,
          mediaVideoCount,
          mediaMissingDate,
        });
      }
    } catch (err: unknown) {
      // Leave the chunk unset. `hasUploadDate` then reads false and no media
      // key is subtracted, so a product may be reported that is actually fine —
      // the milder error: it sends a merchant to look, never tells them nothing
      // is wrong.
      logger.warn("[gallery-video-audit] product lookup failed", {
        context: "SEO",
        shop,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
