/**
 * PLAN_CONTENT_CREATION Phase 4 — stock and sales channels of ONE product.
 *
 * ── Why this is a route of its own and not part of the product sync ─────────
 * Stock is VOLATILE. It changes from orders, returns and other apps between two
 * page loads, so a number mirrored during a nightly catalogue sync is a number
 * that is wrong by morning. Folding it into the bulk sync would also mean
 * touching all four product write paths (CLAUDE.md) for data whose whole point
 * is being current.
 *
 * So this reads LIVE on open. It also MIRRORS what it read, but be clear about
 * what that mirror is for: it is not a fallback and nothing reads it to render
 * this panel — a failed load says so rather than showing a stale number, which
 * for stock is the only defensible behaviour. The rows exist so the cache
 * agrees with Shopify for anything built on them later (a bulk stock column, a
 * completeness check), and so the GDPR purge has something coherent to delete.
 * If that never materialises, delete the tables rather than let a write-only
 * cache drift.
 *
 * ── Plan gate in the ROUTE ──────────────────────────────────────────────────
 * Directly GET/POST-reachable, so the gate lives here and not only in the UI —
 * the same class as the `/api/ai` handlers and the CSV exports.
 *
 * ── The write half never fails the content save ─────────────────────────────
 * It is a separate request, so there is nothing to take down with it; but for
 * the same reason it must report precisely. Every outcome is a warning CODE
 * (the app ships in three languages), and "not confirmed" is a distinct answer
 * from "failed" because only one of them means the merchant should look again.
 */

import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { logger } from "~/utils/logger.server";
import { getFormString } from "~/utils/form-data.utils";
import { meetsPlan } from "~/utils/planUtils";
import {
  INVENTORY_LEVEL_PAGE_SIZE,
  PUBLICATION_PAGE_SIZE,
  VARIANT_COMMERCE_PAGE_SIZE,
  VARIANT_COMMERCE_SELECTION,
  PRODUCT_PUBLICATIONS_SELECTION,
  PRODUCT_CATALOG_PUBLICATIONS_SELECTION,
  inventoryLevelRows,
  productPublicationRows,
  type PublicationCatalogKind,
  variantCommerceColumns,
  SHOP_LOCATION_PAGE_SIZE,
} from "~/services/commerce-sync.shared";
import {
  applyInventoryItemFields,
  applyPublicationChanges,
  applyStockChanges,
  parseQuantity,
  type CommerceWarning,
  type InventoryItemFields,
  type StockChange,
  applyVariantPrices,
  type VariantPriceFields,
} from "~/services/commerce-write.server";
import { unitPriceColumns } from "~/services/unit-price.shared";

/** Stock and channels are a Pro feature, like the other commerce surfaces. */
const REQUIRED_PLAN = "pro" as const;

export interface CommerceVariantView {
  id: string;
  gid: string;
  title: string;
  sku: string | null;
  /** ISBN, UPC, GTIN — Shopify's own label for the field. */
  barcode: string | null;
  /**
   * `DENY` or `CONTINUE`: whether Shopify keeps selling at zero stock.
   *
   * Only meaningful while the item is TRACKED — untracked, Shopify keeps no
   * count and there is no "out of stock" for the policy to apply to.
   */
  inventoryPolicy: string | null;
  /** The SELLING price — what a customer pays. Not `cost`, which is what the
   *  merchant pays and is the field that used to be alone in this panel. */
  price: string | null;
  compareAtPrice: string | null;
  /**
   * The Grundpreis, FLATTENED into four scalars.
   *
   * Not kept as the nested object Shopify answers with, because the panel's
   * whole bulk machinery — the value a group agrees on, the "different values"
   * placeholder, the rule that "" means untouched on a mixed field — works per
   * SCALAR field. A nested object would need its own copy of all three, and
   * the copy is where they drift.
   *
   * All four `null` together means no Grundpreis. Read live like `price`, and
   * mirrored nowhere: there is no cache column for it, so there is nothing
   * that can go stale.
   */
  unitQuantityValue: string | null;
  unitQuantityUnit: string | null;
  unitReferenceValue: string | null;
  unitReferenceUnit: string | null;
  /** Whether the storefront shows it. Independent of the measurement —
   *  measured: writing one does not switch this on. */
  showUnitPrice: boolean | null;
  inventoryItemId: string | null;
  /** null ⇒ never synced. false ⇒ Shopify keeps no count for this variant. */
  inventoryTracked: boolean | null;
  /** The InventoryItem's own settings. All nullable — see the sync's header. */
  cost: string | null;
  taxable: boolean | null;
  requiresShipping: boolean | null;
  weight: string | null;
  weightUnit: string | null;
  harmonizedSystemCode: string | null;
  countryCodeOfOrigin: string | null;
  /**
   * The variant's OWN image, or the product's featured one when it has none.
   *
   * Shown beside the picker so a merchant editing "Weiss / 20cm" can see which
   * thing that is. Not cached: `ProductVariant.imageKey` and `galleryJson`
   * belong to the image manager and mean something else (an assignment the
   * merchant made there), so reading them here would show one panel's state in
   * another's control.
   */
  imageUrl: string | null;
  imageAlt: string | null;
  /**
   * Which value of which option this variant is — `[{name: "Farbe", value:
   * "Weiss"}, …]`, exactly as Shopify reports it.
   *
   * The grouping the bulk scopes are built from. Derived from the TITLE it
   * could not be: a title is "Weiss / 20cm", and splitting it on " / " breaks
   * on any value that contains the separator.
   */
  selectedOptions: Array<{ name: string; value: string }>;
  levels: Array<{
    locationId: string;
    locationName: string;
    locationActive: boolean;
    onHand: number | null;
    available: number | null;
    /** Sold but not yet shipped. Shopify's admin calls this "Reserviert". */
    committed: number | null;
    /**
     * Damaged, quality control, safety stock — everything on hand that is
     * neither available nor committed.
     *
     * DERIVED as `on_hand − available − committed`, which is Shopify's own
     * definition, rather than summing four sub-buckets: each of those is a
     * separate quantity name, and one name Shopify ever renames would fail the
     * whole query at the schema level and take the panel with it. `null`
     * whenever any of the three inputs is unknown — a missing part cannot make
     * a total.
     */
    unavailable: number | null;
  }>;
  /** The location window was cut off — the totals below are not totals. */
  levelsTruncated: boolean;
}

export interface CommerceChannelView {
  publicationId: string;
  name: string;
  /**
   * "app" | "market" | "companyLocation" | "" — see `publicationCatalogKind`.
   * The client groups by it; "" keeps rendering with the sales channels.
   */
  catalogType: PublicationCatalogKind;
  isPublished: boolean;
  publishDate: string | null;
}

/**
 * Whether this shop's variant really carries that InventoryItem.
 *
 * Checked against the CACHE, which is the server's own state. A client that
 * pairs its own variant id with someone else's inventory item is not a client
 * this route has to serve.
 */
async function ownsInventoryItem(shop: string, variantId: string, inventoryItemId: string): Promise<boolean> {
  const row = await db.productVariant.findFirst({
    where: { id: variantId, product: { shop } },
    select: { inventoryItemId: true },
  });
  // Unknown to the cache ⇒ refused. A variant this app has never synced is one
  // it cannot vouch for, and the panel only ever offers ids it just loaded.
  return !!row && row.inventoryItemId === inventoryItemId;
}

async function requirePlan(shop: string): Promise<boolean> {
  const settings = await db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } });
  return meetsPlan((settings?.subscriptionPlan || "free") as never, REQUIRED_PLAN);
}

/**
 * `committed` per location, read off the live node.
 *
 * Not mirrored to the cache: it moves with every order, and a number that
 * stale is worse than no number. Read here rather than in
 * `inventoryLevelRows`, which builds the rows that DO get written.
 */
function committedByLocation(node: Record<string, unknown>): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const item = node.inventoryItem as
    | { inventoryLevels?: { nodes?: Array<Record<string, unknown>> } }
    | undefined;
  for (const level of item?.inventoryLevels?.nodes ?? []) {
    const locationId = (level.location as { id?: string } | undefined)?.id;
    if (!locationId) continue;
    const quantities = (level.quantities ?? []) as Array<{ name?: string; quantity?: number | null }>;
    const committed = quantities.find((q) => q?.name === "committed");
    out.set(locationId, committed ? committed.quantity ?? null : null);
  }
  return out;
}

/**
 * Every publication of one product, across all three catalog types.
 *
 * Its OWN query, not nested in the variant one, for the reason the locations
 * query is also separate: a per-product list multiplied by a paged variant
 * window is cost paid for the same rows over and over, and this one is now
 * three connections wide.
 *
 * `catalogsKnown: false` is the discriminator this whole read exists for.
 * `catalogType` is an ENUM — an unknown value fails at the SCHEMA level, which
 * Shopify returns as a top-level `errors` array with `data: null` — so the
 * market and B2B connections are asked for in a query that can be RETRIED
 * without them. What comes back then is the sales channels alone, reported as
 * "we could not ask" rather than as "this shop has no regions": the second is
 * a claim, and it is the exact claim this app made for months.
 */
async function loadProductPublications(
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> },
  shop: string,
  productId: string,
): Promise<{ connection: { pageInfo: { hasNextPage: boolean }; nodes: unknown[] } | null; catalogsKnown: boolean }> {
  type Connection = { pageInfo?: { hasNextPage?: boolean } | null; nodes?: unknown[] | null } | null | undefined;

  const run = async (withCatalogs: boolean) => {
    const response = await admin.graphql(
      `#graphql
        query productPublications($id: ID!) {
          product(id: $id) {
            ${PRODUCT_PUBLICATIONS_SELECTION}
            ${withCatalogs ? PRODUCT_CATALOG_PUBLICATIONS_SELECTION : ""}
          }
        }`,
      { variables: { id: productId } },
    );
    return (await response.json()) as {
      data?: {
        product?: {
          resourcePublicationsV2?: Connection;
          marketPublications?: Connection;
          companyLocationPublications?: Connection;
        } | null;
      };
      errors?: Array<{ message?: string }>;
    };
  };

  let catalogsKnown = true;
  let body = await run(true);
  if (body.errors?.length) {
    logger.warn("[Commerce] Catalog-typed publications refused — retrying without them", {
      context: "Commerce", shop, error: body.errors[0]?.message,
    });
    catalogsKnown = false;
    body = await run(false);
  }
  if (body.errors?.length || !body.data?.product) {
    logger.warn("[Commerce] Publications could not be read", {
      context: "Commerce", shop, error: body.errors?.[0]?.message,
    });
    // `null`, NOT an empty connection. An empty list would read as "published
    // nowhere" — the alarming state this panel exists to reveal — and it would
    // also reach `productPublicationRows` as a real answer, whose caller then
    // deletes the whole mirror. Nothing is claimed at all.
    return { connection: null, catalogsKnown: false };
  }

  const product = body.data.product;
  const parts = [product.resourcePublicationsV2, product.marketPublications, product.companyLocationPublications];
  const productNodes = parts.flatMap((part) => part?.nodes ?? []);
  let hasNextPage = parts.some((part) => part?.pageInfo?.hasNextPage === true);

  /**
   * The SHOP's publications are the universe; the product's are its state.
   *
   * MEASURED on a live shop (2026-08, Settings → Probes → Publications): the
   * product answered with 3 publications, the shop has 7. "Google & YouTube"
   * is one of the four the product never mentioned — so the picker could not
   * offer it, and a merchant simply could not publish that product to that
   * channel from this app. `resourcePublicationsV2` reports the publications
   * this product HAS A RECORD in, which is not the same set as the ones it
   * could be published to, and only the shop-level list knows the difference.
   *
   * The merge is one-directional: the shop list decides WHICH rows exist, the
   * product list decides their state. A row only the product knows about is
   * kept too — a publication removed from the shop between the two calls is
   * still a row this product sits in.
   */
  const shop_ = await loadShopPublications(admin, shop);
  // The merge only happens over a COMPLETE product answer. A merged row says
  // "not published", and that is a claim about the PRODUCT — one this side
  // cannot make when the catalog connections were refused or a window was cut
  // off, because the publication may be one of the rows that never arrived.
  // A product published to all three regions would otherwise be shown as
  // published to none of them.
  const productSideComplete = catalogsKnown && !hasNextPage;
  if (shop_ && productSideComplete) {
    const seen = new Set(
      productNodes.flatMap((node) => {
        const id = (node as { publication?: { id?: string } })?.publication?.id;
        return id ? [id] : [];
      }),
    );
    for (const node of shop_.nodes) {
      if (!node.publication?.id || seen.has(node.publication.id)) continue;
      seen.add(node.publication.id);
      // Never published, so no date and no published flag — the same shape the
      // product connection would have returned for it.
      productNodes.push({ isPublished: false, publishDate: null, publication: node.publication });
    }
    // A narrowed shop universe is a short list, not a finished one.
    if (!shop_.complete) hasNextPage = true;
  } else if (productSideComplete) {
    // The product side was complete but the shop side could not be asked, so
    // the list may be short. Said as truncation rather than passed off as
    // complete. (When the product side is already incomplete, `hasNextPage`
    // or `catalogsKnown` is carrying that news.)
    hasNextPage = true;
  }

  return {
    connection: {
      // ANY window cut off means the merged list is not the whole answer.
      pageInfo: { hasNextPage },
      nodes: productNodes,
    },
    catalogsKnown,
  };
}

/**
 * Every publication the SHOP has, across all three catalog types.
 *
 * `null` ⇒ could not ask. Never an empty list: "this shop has no channels" is
 * a claim, and the caller reports a short list as truncated instead of making
 * it. Same `catalogType` retry as the product read, for the same reason.
 */
async function loadShopPublications(
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> },
  shop: string,
): Promise<{
  nodes: Array<{ publication: { id: string; name: string | null; catalog: { __typename?: string; title?: string } | null } }>;
  /** False ⇒ the list is app catalogs only, or a window was cut off. */
  complete: boolean;
} | null> {
  const CONNECTION = `
            pageInfo { hasNextPage }
            nodes {
              id
              name
              catalog { __typename title }
            }`;
  type Node = { id?: string | null; name?: string | null; catalog?: { __typename?: string; title?: string } | null };
  type Connection = { pageInfo?: { hasNextPage?: boolean } | null; nodes?: Node[] | null } | null;
  type Body = {
    data?: {
      publications?: Connection;
      marketPublications?: Connection;
      companyLocationPublications?: Connection;
    };
    errors?: Array<{ message?: string }>;
  };

  const send = (withCatalogs: boolean) =>
    admin.graphql(
      `#graphql
        query shopPublications {
          publications(first: ${PUBLICATION_PAGE_SIZE}) {${CONNECTION}
          }
          ${withCatalogs ? `marketPublications: publications(first: ${PUBLICATION_PAGE_SIZE}, catalogType: MARKET) {${CONNECTION}
          }
          companyLocationPublications: publications(first: ${PUBLICATION_PAGE_SIZE}, catalogType: COMPANY_LOCATION) {${CONNECTION}
          }` : ""}
        }`,
    );

  try {
    let withCatalogs = true;
    let body = (await (await send(true)).json()) as Body;
    if (body.errors?.length) {
      withCatalogs = false;
      body = (await (await send(false)).json()) as Body;
    }
    if (body.errors?.length || !body.data?.publications) {
      logger.warn("[Commerce] Shop publications could not be read", {
        context: "Commerce", shop, error: body.errors?.[0]?.message,
      });
      return null;
    }
    const parts = [body.data.publications, body.data.marketPublications, body.data.companyLocationPublications];
    return {
      nodes: parts
        .flatMap((part) => part?.nodes ?? [])
        .flatMap((node) =>
          node?.id
            ? [{ publication: { id: node.id, name: node.name ?? null, catalog: node.catalog ?? null } }]
            : [],
        ),
      // The catalog-less fallback narrows the universe to app catalogs, which
      // is exactly as incomplete as a cut-off window — both must reach the UI
      // as "not the whole shop" rather than as a finished list.
      complete: withCatalogs && !parts.some((part) => part?.pageInfo?.hasNextPage === true),
    };
  } catch (error) {
    logger.warn("[Commerce] Shop publications failed", {
      context: "Commerce", shop, error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId") || "";

  if (!productId.startsWith("gid://shopify/Product/")) {
    return json({ success: false, error: "A product id is required." }, { status: 400 });
  }
  if (!(await requirePlan(session.shop))) {
    return json({ success: false, error: "planRequired", plan: REQUIRED_PLAN }, { status: 403 });
  }

  try {
    /**
     * Every variant, not the first page of them.
     *
     * The panel used to load one page of 25 and tell the merchant to edit the
     * rest in the Shopify admin -- on a product with 30 variants, which is an
     * ordinary product. The page SIZE stays 25 because each variant carries
     * its inventory levels and a large page is an expensive query; it is the
     * paging that was missing. The cap is 10 pages: Shopify allows up to 2048
     * variants, but this app already treats 100 as the point where a product
     * belongs in the bulk editor, so 250 is past every real case and still
     * bounded.
     */
    const variantNodes: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    let moreVariants = false;
    let product: Record<string, unknown> | null = null;

    for (let page = 0; page < 10; page++) {
    // The product-level block is read from the FIRST page only (`product =
    // product ?? pageProduct` below), so asking for it again on every further
    // page is cost paid for an answer that is thrown away.
    const productLevelSelection = page === 0
      ? `featuredMedia { preview { image { url altText } } }`
      : "";
    const response = await admin.graphql(
      `#graphql
        query productCommerce($id: ID!, $after: String) {
          product(id: $id) {
            id
            ${productLevelSelection}
            variants(first: ${VARIANT_COMMERCE_PAGE_SIZE}, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                title
                sku
                image { url altText }
                barcode
                unitPriceMeasurement {
                  quantityValue
                  quantityUnit
                  referenceValue
                  referenceUnit
                }
                showUnitPrice
                selectedOptions { name value }
                ${VARIANT_COMMERCE_SELECTION}
              }
            }
          }
        }`,
      { variables: { id: productId, after: cursor } },
    );

    const body = (await response.json()) as {
      data?: { product?: Record<string, unknown> | null };
      errors?: Array<{ message?: string }>;
    };

    // A schema-level error arrives as a top-level `errors` array with
    // `data: null`. Read as "no data" it would render an empty stock table for
    // a product that has stock.
    if (body.errors?.length) {
      logger.warn("[Commerce] Load schema-level error", {
        context: "Commerce", shop: session.shop, page, error: body.errors[0]?.message,
      });
      // A LATER page failing is not the same as the first one failing. Ten
      // back-to-back pages of variants-with-inventory-levels can exhaust the
      // cost bucket, and THROTTLED arrives exactly here — as a top-level
      // `errors` array. Discarding the pages that did load would turn a
      // partial answer into "could not be loaded" and nothing at all, on the
      // big catalogues that need this panel most. What loaded is kept and
      // flagged as incomplete, which is a state this UI already renders.
      if (page > 0 && variantNodes.length > 0) {
        moreVariants = true;
        break;
      }
      return json({ success: false, error: "The stock and channel data could not be loaded." }, { status: 502 });
    }
    const pageProduct = body.data?.product;
    if (!pageProduct) {
      // Same rule: gone on page 1 is a deleted product; gone on page 5 is a
      // failure mid-sweep, and what was read is still true.
      if (page > 0 && variantNodes.length > 0) {
        moreVariants = true;
        break;
      }
      return json({ success: false, error: "That product no longer exists in Shopify." }, { status: 404 });
    }
    // The first page carries the product-level fields; later ones only add
    // variants.
    product = product ?? pageProduct;
    const pageVariants = (pageProduct.variants as Record<string, unknown> | undefined) ?? {};
    variantNodes.push(...(((pageVariants.nodes ?? []) as Array<Record<string, unknown>>)));
    const pageInfo = pageVariants.pageInfo as { hasNextPage?: boolean; endCursor?: string | null } | undefined;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
    // Ran out of pages before Shopify ran out of variants — the ONE case where
    // the "more than were loaded" note is true, and it is now rare enough to
    // mean something.
    if (page === 9) moreVariants = true;
    }

    if (!product) {
      return json({ success: false, error: "That product no longer exists in Shopify." }, { status: 404 });
    }

    /**
     * The shop's OWN locations — deliberately a second query.
     *
     * `inventoryLevels` returns a level only where the item is ACTIVATED at a
     * location, so a merchant with three warehouses saw the one his variant
     * happened to be stocked at and concluded the panel was broken. It was not:
     * Shopify simply has nothing to report for the other two. Listing them as
     * "not stocked here" is the difference between a missing answer and an
     * answer of "none".
     *
     * Its own call because nesting it under the product would multiply into the
     * variant window's cost, and this list is per SHOP, not per variant. A
     * failure here degrades to the old behaviour rather than failing the load.
     */
    let shopLocations: Array<{ id: string; name: string; isActive: boolean }> = [];
    try {
      const locationsResponse = await admin.graphql(
        `#graphql
          query commerceShopLocations {
            locations(first: ${SHOP_LOCATION_PAGE_SIZE}, includeInactive: true) {
              nodes { id name isActive }
            }
          }`,
      );
      const locationsBody = (await locationsResponse.json()) as {
        data?: { locations?: { nodes?: Array<{ id: string; name: string; isActive: boolean }> } };
      };
      shopLocations = locationsBody.data?.locations?.nodes ?? [];
    } catch (error) {
      // Leaves `shopLocations` empty, which renders exactly what this route
      // showed before: the stocked locations only. LOGGED rather than
      // swallowed, because a silent empty list is indistinguishable from a shop
      // with one location — the very confusion this query exists to end.
      logger.warn("[Commerce] Shop locations could not be read", {
        context: "Commerce", shop: session.shop,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // `Product.id` is the FULL GID in this schema (unlike `ProductVariant.id`,
    // which is numeric). Using a numeric id here violated the FK on every
    // `ProductPublication` insert — swallowed by the `.catch` below, so the
    // loader silently never cached a single channel — and its `deleteMany`
    // then never cleared the GID-keyed rows the write path had created.
    // The product's featured image, as the fallback for a variant that has
    // none of its own. A product with one image and five variants is the
    // common case, and showing nothing there would make the picker look
    // broken for exactly the merchants with the simplest catalogue.
    const productPreview = (product.featuredMedia as { preview?: { image?: { url?: string; altText?: string } } } | null)
      ?.preview?.image;
    const productImageUrl = productPreview?.url ?? null;
    const productImageAlt = productPreview?.altText ?? null;

    const variants: CommerceVariantView[] = [];
    /** Every location seen across the variants, deduped — see the loop below. */
    const locationsToMirror = new Map<string, { id: string; shop: string; name: string; isActive: boolean; position: number }>();
    for (const node of variantNodes) {
      const gid = String(node.id ?? "");
      if (!gid) continue;
      const numericId = gid.replace("gid://shopify/ProductVariant/", "");
      const columns = variantCommerceColumns(node as never);
      const levels = inventoryLevelRows(session.shop, numericId, node as never);

      // Locations come back with the levels, so they are mirrored from here
      // rather than fetched separately — same data, one call. COLLECTED, not
      // written: a shop has a handful of locations and every variant reports
      // the same ones, so upserting inside this loop meant 250 variants times
      // N warehouses of identical writes on every panel open. They are written
      // once, after the loop.
      for (const location of levels?.locations ?? []) {
        if (!locationsToMirror.has(location.id)) locationsToMirror.set(location.id, location);
      }

      // The cache is refreshed from this LIVE read, so a later throttled load
      // still has something honest to show — with its own timestamp.
      // Scoped through the product, not by id alone. Shopify ids are globally
      // unique so an unscoped write is safe in practice — but "safe because of
      // an external invariant" is not the house rule, and a scoped query costs
      // nothing here.
      await db.productVariant
        .updateMany({ where: { id: numericId, product: { shop: session.shop } }, data: columns as never })
        .catch(() => undefined);
      if (levels) {
        await db.inventoryLevel
          .deleteMany({ where: { shop: session.shop, variantId: numericId } })
          .catch(() => undefined);
        if (levels.rows.length > 0) {
          await db.inventoryLevel.createMany({ data: levels.rows, skipDuplicates: true }).catch(() => undefined);
        }
      }

      const locationNames = new Map((levels?.locations ?? []).map((l) => [l.id, l] as const));
      // Built ONCE per variant. It used to be rebuilt inside the row mapper,
      // twice per level, for a result identical every time.
      const committed = committedByLocation(node);
      variants.push({
        id: numericId,
        gid,
        title: String(node.title ?? ""),
        sku: (node.sku as string | null) ?? null,
        barcode: (node.barcode as string | null) ?? null,
        inventoryPolicy: columns.inventoryPolicy ?? null,
        // Read straight off the node, NOT through `variantCommerceColumns`:
        // price is not part of the commerce block (the regular product sync
        // owns it), and folding it in would tie it to that block's
        // all-or-nothing presence rule.
        price: (node.price as string | null) ?? null,
        compareAtPrice: (node.compareAtPrice as string | null) ?? null,
        // Off the node like `price`, for the same reason: it is not part of
        // the commerce block and folding it in would tie it to that block's
        // all-or-nothing presence rule. An EMPTY measurement is reported as
        // four nulls, never as zeros — Shopify answers a zeroed struct for a
        // variant that has none, and rendering that as "0" would show every
        // variant in the shop a Grundpreis of nothing per nothing.
        ...unitPriceColumns(node.unitPriceMeasurement),
        showUnitPrice: (node.showUnitPrice as boolean | null) ?? null,
        inventoryItemId: columns.inventoryItemId ?? null,
        inventoryTracked: columns.inventoryTracked ?? null,
        cost: columns.cost ?? null,
        taxable: columns.taxable ?? null,
        requiresShipping: columns.requiresShipping ?? null,
        weight: columns.weight ?? null,
        weightUnit: columns.weightUnit ?? null,
        harmonizedSystemCode: columns.harmonizedSystemCode ?? null,
        countryCodeOfOrigin: columns.countryCodeOfOrigin ?? null,
        // The variant's own image, else the product's featured one. Read off
        // the node like `price`, not through the commerce block: it is not
        // part of that block and folding it in would tie it to the block's
        // all-or-nothing presence rule.
        imageUrl:
          ((node.image as { url?: string } | null)?.url ?? null) || productImageUrl,
        imageAlt:
          ((node.image as { altText?: string | null } | null)?.altText ?? null) || productImageAlt,
        selectedOptions: Array.isArray(node.selectedOptions)
          ? (node.selectedOptions as Array<{ name?: unknown; value?: unknown }>)
              .map((o) => ({ name: String(o?.name ?? ""), value: String(o?.value ?? "") }))
              .filter((o) => o.name && o.value)
          : [],
        levels: (levels?.rows ?? []).map((row) => ({
          locationId: row.locationId,
          locationName: locationNames.get(row.locationId)?.name ?? "",
          locationActive: locationNames.get(row.locationId)?.isActive !== false,
          onHand: row.onHand,
          available: row.available,
          committed: committed.get(row.locationId) ?? null,
          unavailable: (() => {
            const committedHere = committed.get(row.locationId) ?? null;
            if (row.onHand == null || row.available == null || committedHere == null) return null;
            return row.onHand - row.available - committedHere;
          })(),
        })),
        levelsTruncated: levels?.hasMore === true,
      });
    }

    // The deduped locations, once. See the collection point in the loop above.
    for (const location of locationsToMirror.values()) {
      await db.location
        .upsert({
          where: { shop_id: { shop: session.shop, id: location.id } },
          create: location,
          update: { name: location.name, isActive: location.isActive, position: location.position, syncedAt: new Date() },
        })
        .catch(() => undefined);
    }

    const { connection: publicationConnection, catalogsKnown } = await loadProductPublications(
      admin,
      session.shop,
      productId,
    );
    const publications = productPublicationRows(session.shop, productId, publicationConnection as never);
    // Rebuilt only from a COMPLETE answer. `productPublicationRows` returns
    // null for a response that carried nothing, and `catalogsKnown` is false
    // when only the app catalogs were re-read — rebuilding from that would
    // delete every market and B2B row the mirror already had, which is the
    // "wipe on a partial response" rule one level up.
    if (publications && catalogsKnown) {
      await db.productPublication.deleteMany({ where: { shop: session.shop, productId } }).catch(() => undefined);
      if (publications.rows.length > 0) {
        await db.productPublication.createMany({ data: publications.rows, skipDuplicates: true }).catch(() => undefined);
      }
    }

    return json({
      success: true,
      variants,
      // Every location the SHOP has, so the panel can show the ones this
      // variant is not stocked at as exactly that — see the query above.
      shopLocations,
      // Truncation is reported, never rounded down: a partial channel list read
      // as complete would say a product is off a channel it is on.
      variantsTruncated: moreVariants,
      channels: (publications?.rows ?? []).map((row) => ({
        publicationId: row.publicationId,
        name: row.publicationName,
        catalogType: row.catalogType,
        isPublished: row.isPublished,
        publishDate: row.publishDate ? row.publishDate.toISOString() : null,
      })) satisfies CommerceChannelView[],
      channelsTruncated: publications?.hasMore === true,
      // False ⇒ the market and B2B connections could not be asked for, so
      // their absence below is not evidence that the shop has none.
      catalogsKnown,
      limits: { levelsPerVariant: INVENTORY_LEVEL_PAGE_SIZE, channels: PUBLICATION_PAGE_SIZE },
    });
  } catch (error) {
    logger.error("[Commerce] Load failed", {
      context: "Commerce",
      shop: session.shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ success: false, error: "The stock and channel data could not be loaded." }, { status: 500 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  if (!(await requirePlan(session.shop))) {
    return json({ success: false, error: "planRequired", plan: REQUIRED_PLAN }, { status: 403 });
  }

  const formData = await request.formData();
  const intent = getFormString(formData, "intent");
  const productId = getFormString(formData, "productId");
  if (!productId.startsWith("gid://shopify/Product/")) {
    return json({ success: false, error: "A product id is required." }, { status: 400 });
  }

  const warnings: CommerceWarning[] = [];

  /**
   * Start stocking this item at a location it is not stocked at yet.
   *
   * Shopify reports an inventory LEVEL only where the item has been activated,
   * which is why a shop's other locations are absent rather than zero. This is
   * the way in — and it is a write, so it carries the same rules as the rest of
   * this route: ids validated here (the route is POST-reachable, and a bad
   * scalar fails at the SCHEMA level where `userErrors` never sees it), and the
   * result counted only when Shopify ECHOES the new level back.
   */
  if (intent === "activate") {
    const inventoryItemId = getFormString(formData, "inventoryItemId");
    const locationId = getFormString(formData, "locationId");
    if (!inventoryItemId.startsWith("gid://shopify/InventoryItem/")) {
      return json({ success: false, error: "That is not an inventory item." }, { status: 400 });
    }
    if (!locationId.startsWith("gid://shopify/Location/")) {
      return json({ success: false, error: "That is not a location." }, { status: 400 });
    }

    try {
      // The quantity rides along: `inventoryActivate` takes it, so starting to
      // stock an item at a location and saying how many there are is ONE call.
      // A merchant types a number into the row; they do not press "activate"
      // and then type.
      const quantity = parseQuantity(getFormString(formData, "quantity"));
      // The client only ever sends a non-empty value here, so `null` can only
      // mean "not a whole number". Activating at zero anyway and answering
      // success is how a mistyped "-5" becomes "stocked, none in the room" —
      // the stock intent refuses the same input, and so does this one.
      if (quantity === null) {
        return json({ success: false, error: "That is not a whole number." }, { status: 400 });
      }
      const response = await admin.graphql(
        `#graphql
          mutation commerceActivateInventory($inventoryItemId: ID!, $locationId: ID!, $onHand: Decimal) {
            inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, onHand: $onHand) {
              inventoryLevel { id location { id } }
              userErrors { field message }
            }
          }`,
        { variables: { inventoryItemId, locationId, onHand: String(quantity) } },
      );
      const activateBody = (await response.json()) as {
        data?: {
          inventoryActivate?: {
            inventoryLevel?: { id?: string; location?: { id?: string } } | null;
            userErrors?: Array<{ message?: string }>;
          };
        };
        errors?: Array<{ message?: string }>;
      };
      if (activateBody.errors?.length) {
        return json({ success: false, error: "The location could not be activated." }, { status: 502 });
      }
      const payload = activateBody.data?.inventoryActivate;
      // The echo rule: `userErrors: []` is not the answer. The level has to
      // come back, AND on the location that was asked for — otherwise the panel
      // would show a location it cannot write to.
      if (!payload?.inventoryLevel?.id || payload.inventoryLevel.location?.id !== locationId) {
        logger.warn("[Commerce] inventoryActivate not confirmed", {
          context: "Commerce", shop: session.shop, locationId,
          detail: payload?.userErrors?.map((e) => e.message).join("; ") || "no level returned",
        });
        // `success: true` WITH a warning, like the stock and channel intents:
        // `success: false` makes the client's `post()` throw, which discards
        // the payload and leaves the merchant with a generic fallback instead
        // of the reason.
        return json({ success: true, warnings: ["activateNotConfirmed"] satisfies string[] });
      }
      return json({ success: true });
    } catch (error) {
      logger.warn("[Commerce] inventoryActivate failed", {
        context: "Commerce", shop: session.shop,
        error: error instanceof Error ? error.message : String(error),
      });
      return json({ success: true, warnings: ["activateFailed"] satisfies string[] });
    }
  }

  if (intent === "price") {
    const variantId = getFormString(formData, "variantId");
    const variantGid = getFormString(formData, "variantGid");
    if (!variantGid.startsWith("gid://shopify/ProductVariant/")) {
      return json({ success: false, error: "That is not a variant." }, { status: 400 });
    }
    // The two have to name the SAME variant. The GID addresses Shopify and the
    // numeric id addresses the cache mirror, so a mismatched pair — this route
    // is directly POST-reachable — would write one variant's price onto
    // another's cached row.
    if (variantGid !== `gid://shopify/ProductVariant/${variantId}`) {
      return json({ success: false, error: "The variant ids do not match." }, { status: 400 });
    }
    const fields: VariantPriceFields = {};
    if (formData.has("price")) fields.price = getFormString(formData, "price");
    if (formData.has("compareAtPrice")) fields.compareAtPrice = getFormString(formData, "compareAtPrice");
    if (formData.has("barcode")) fields.barcode = getFormString(formData, "barcode");
    if (formData.has("inventoryPolicy")) fields.inventoryPolicy = getFormString(formData, "inventoryPolicy");
    if (formData.has("taxable")) {
      // Drop-and-report rather than coerce, the same rule `tracked` follows:
      // anything unrecognised would otherwise mean "not taxed".
      const raw = getFormString(formData, "taxable");
      if (raw === "true") fields.taxable = true;
      else if (raw === "false") fields.taxable = false;
      else warnings.push("priceInvalid");
    }
    // The four Grundpreis fields travel together or not at all: they are ONE
    // value on Shopify's side, and a client that sent three of them would be
    // describing a measurement nobody typed. All four present or none — a
    // partial set is refused here rather than half-applied, because this route
    // is directly POST-reachable.
    const unitKeys = [
      "unitQuantityValue",
      "unitQuantityUnit",
      "unitReferenceValue",
      "unitReferenceUnit",
    ] as const;
    const presentUnitKeys = unitKeys.filter((key) => formData.has(key));
    if (presentUnitKeys.length === unitKeys.length) {
      fields.unitPrice = {
        quantityValue: getFormString(formData, "unitQuantityValue"),
        quantityUnit: getFormString(formData, "unitQuantityUnit"),
        referenceValue: getFormString(formData, "unitReferenceValue"),
        referenceUnit: getFormString(formData, "unitReferenceUnit"),
      };
    } else if (presentUnitKeys.length > 0) {
      return json({ success: false, error: "An incomplete unit price was sent." }, { status: 400 });
    }
    if (formData.has("showUnitPrice")) {
      // Drop-and-report, like `taxable`: anything unrecognised would otherwise
      // mean "do not show it".
      const raw = getFormString(formData, "showUnitPrice");
      if (raw === "true") fields.showUnitPrice = true;
      else if (raw === "false") fields.showUnitPrice = false;
      else warnings.push("priceInvalid");
    }

    const warning = await applyVariantPrices(admin, db, session.shop, {
      productId,
      variantId,
      variantGid,
      fields,
    });
    if (warning) warnings.push(warning);
    // Same rule: the WARNING carries the failure, the envelope stays a success
    // so the client can read it.
    return json({ success: true, warnings });
  }

  if (intent === "stock") {
    const variantId = getFormString(formData, "variantId");
    let parsed: unknown;
    try {
      parsed = JSON.parse(getFormString(formData, "changes") || "[]");
    } catch {
      return json({ success: false, error: "The stock changes could not be read." }, { status: 400 });
    }
    if (!Array.isArray(parsed)) {
      return json({ success: false, error: "The stock changes could not be read." }, { status: 400 });
    }

    // Validated server-side because this route is directly POST-reachable, and
    // because a bad scalar fails at the SCHEMA level — which never reaches
    // `userErrors`, so the call would read as a success while nothing was
    // written.
    const changes: StockChange[] = [];
    for (const raw of parsed as Array<Record<string, unknown>>) {
      const inventoryItemId = String(raw.inventoryItemId ?? "");
      const locationId = String(raw.locationId ?? "");
      // REFUSED, not skipped. Dropping a malformed change and answering
      // `success: true` is the worst shape this route could take on a money
      // write: nothing written, nothing said. It also made the two validation
      // failures behave oppositely — a bad quantity 400s the batch while a bad
      // id vanished from it.
      if (!inventoryItemId.startsWith("gid://shopify/InventoryItem/")) {
        return json({ success: false, error: "A stock change named something that is not an inventory item." }, { status: 400 });
      }
      if (!locationId.startsWith("gid://shopify/Location/")) {
        return json({ success: false, error: "A stock change named something that is not a location." }, { status: 400 });
      }
      const quantity = parseQuantity(String(raw.quantity ?? ""));
      const compareQuantity = parseQuantity(String(raw.compareQuantity ?? ""));
      // `compareQuantity` is REQUIRED, not optional: without it a stale page
      // silently overwrites whatever happened in between, which is the whole
      // failure mode this feature has to avoid.
      if (quantity === null || compareQuantity === null) {
        return json({ success: false, error: "A stock value was not a whole number." }, { status: 400 });
      }
      changes.push({ inventoryItemId, locationId, quantity, compareQuantity });
    }

    // The variant's own tracking state, from the cache: an untracked variant
    // has no quantity to set, and saying so beats a generic failure. Read
    // rather than trusted from the client — the route is POST-reachable.
    const variantRow = await db.productVariant
      .findFirst({
        where: { id: variantId, product: { shop: session.shop } },
        select: { inventoryTracked: true },
      })
      .catch(() => null);

    const warning = await applyStockChanges(admin, db, session.shop, {
      variantId,
      changes,
      tracked: variantRow?.inventoryTracked ?? null,
    });
    if (warning) warnings.push(warning);
    return json({ success: true, warnings });
  }

  if (intent === "itemFields") {
    const variantId = getFormString(formData, "variantId");
    const inventoryItemId = getFormString(formData, "inventoryItemId");
    // The InventoryItem GID is the address of every one of these fields. A
    // variant without one has nothing to write to, which is a state to report
    // rather than a request to guess at.
    if (!inventoryItemId.startsWith("gid://shopify/InventoryItem/")) {
      return json({ success: true, warnings: ["stockNoInventoryItem"] });
    }
    // The two ids have to name the SAME variant, the rule the price intent
    // already follows: the InventoryItem GID addresses Shopify and the numeric
    // variant id addresses the cache mirror, so a crafted pair — this route is
    // directly POST-reachable — writes one variant's SKU on Shopify and
    // mirrors it onto another's row.
    if (!(await ownsInventoryItem(session.shop, variantId, inventoryItemId))) {
      return json({ success: false, error: "The ids do not match." }, { status: 400 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(getFormString(formData, "fields") || "{}");
    } catch {
      return json({ success: false, error: "The item fields could not be read." }, { status: 400 });
    }
    const raw = (parsed ?? {}) as Record<string, unknown>;

    // Only keys the client actually SENT — the write module distinguishes
    // "absent" (leave alone) from "" (clear), and rebuilding every key here
    // would collapse the two.
    const fields: InventoryItemFields = {};
    if ("cost" in raw) fields.cost = String(raw.cost ?? "");
    if ("requiresShipping" in raw) fields.requiresShipping = raw.requiresShipping === true;
    if ("harmonizedSystemCode" in raw) fields.harmonizedSystemCode = String(raw.harmonizedSystemCode ?? "");
    if ("countryCodeOfOrigin" in raw) fields.countryCodeOfOrigin = String(raw.countryCodeOfOrigin ?? "");
    // DROPPED rather than coerced: `raw.tracked === true || === "true"` read
    // anything else — `1`, `"TRUE"` — as false and UNTRACKED the item, which
    // is the destructive direction as the default.
    if ("tracked" in raw) {
      if (raw.tracked === true || raw.tracked === "true") fields.tracked = true;
      else if (raw.tracked === false || raw.tracked === "false") fields.tracked = false;
      else warnings.push("itemFieldsInvalid");
    }
    if ("sku" in raw) fields.sku = String(raw.sku ?? "");
    if ("weight" in raw && raw.weight && typeof raw.weight === "object") {
      const weight = raw.weight as Record<string, unknown>;
      fields.weight = { value: String(weight.value ?? ""), unit: String(weight.unit ?? "") };
    }

    const warning = await applyInventoryItemFields(admin, db, session.shop, {
      variantId,
      inventoryItemId,
      fields,
    });
    if (warning) warnings.push(warning);
    return json({ success: true, warnings });
  }

  if (intent === "channels") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(getFormString(formData, "channels") || "{}");
    } catch {
      return json({ success: false, error: "The channel changes could not be read." }, { status: 400 });
    }
    const payload = (parsed ?? {}) as { toPublish?: unknown; toUnpublish?: unknown; names?: unknown };
    const idsOf = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.map(String).filter((id) => id.startsWith("gid://shopify/Publication/"))
        : [];

    const names = new Map<string, string>();
    if (payload.names && typeof payload.names === "object") {
      for (const [key, value] of Object.entries(payload.names as Record<string, unknown>)) {
        names.set(key, String(value ?? ""));
      }
    }

    const warning = await applyPublicationChanges(admin, db, session.shop, {
      productId,
      toPublish: idsOf(payload.toPublish),
      toUnpublish: idsOf(payload.toUnpublish),
      names,
    });
    if (warning) warnings.push(warning);
    return json({ success: true, warnings });
  }

  return json({ success: false, error: `Unknown intent "${intent}".` }, { status: 400 });
}
