/**
 * PLAN_CONTENT_CREATION Phase 4 — the commerce block: stock, locations, channels.
 *
 * The twin of `attribute-sync.shared.ts`, and it exists for the same reason:
 * the GraphQL selections and the response→row mappers must live in ONE place,
 * because a product query is written out in several files and a column added to
 * one of them is a column silently missing from the others.
 *
 * ── The discriminator rule, again ───────────────────────────────────────────
 * `ProductVariant.commerceSyncedAt` is to this block what `attributesSyncedAt`
 * is to the merchandising one: unset ⇒ every field in it is UNKNOWN, never
 * "empty". A variant row an older sync wrote would otherwise report cost 0,
 * not taxable and not tracked — three confident, wrong claims about a shop's
 * money. The mappers below return `{}` for a response that did not carry the
 * block, so a NARROWER query can neither overwrite what a full sync
 * established nor stamp knowledge that never arrived.
 *
 * ── Why stock is cached at all, given that it is volatile ───────────────────
 * Not to display it: the panel reads Shopify live, and a failed load says so
 * rather than showing a stale number. The rows are a MIRROR — they keep the
 * cache in agreement with Shopify for whatever is built on them later, and
 * give the GDPR purge something coherent to delete. Either way the snapshot
 * carries a timestamp and is never a base for arithmetic. `inventorySetQuantities` takes an
 * ABSOLUTE quantity, and the write path pairs it with `compareQuantity` so a
 * value that moved under the merchant's feet is REFUSED rather than
 * overwritten. Computing `cached + delta` is the classic source of inventory
 * drift and this module deliberately offers nothing to compute it with.
 *
 * ── Untracked is not zero ───────────────────────────────────────────────────
 * An inventory item with `tracked: false` has no quantity at all. Reporting 0
 * for it would tell a merchant they are sold out of something they can sell
 * without limit, which is the same class of error as reading an unsynced
 * column as an empty one.
 */

/**
 * ── These two numbers are a COST budget, not a preference ───────────────────
 * Shopify prices a query BEFORE running it, from the `first:` arguments alone,
 * and a nested connection multiplies by its parent's requested size. The
 * ceiling is 1000 points for a single query. `variants(first: 100)` each
 * carrying `inventoryLevels(first: 20)` prices at roughly 2300–4800 — so the
 * panel would fail with `MAX_COST_EXCEEDED` on EVERY product, including a
 * one-variant one, because the actual data size never enters the calculation.
 *
 * 25 × 10 prices at roughly 600. Both windows report their truncation rather
 * than rounding down silently: a partial stock list read as a total is a wrong
 * number, not a missing one.
 */
export const VARIANT_COMMERCE_PAGE_SIZE = 25;
export const INVENTORY_LEVEL_PAGE_SIZE = 10;
/** Sales channels a shop can have. Not nested, so it costs its own size only. */
export const PUBLICATION_PAGE_SIZE = 50;
/**
 * The shop's own locations, fetched in a query of their own.
 *
 * Not nested under the product on purpose: a per-SHOP list multiplied by the
 * variant window is cost paid for the same rows over and over. Inactive ones
 * are included — a deactivated location can still hold stock, and hiding it
 * reads as stock that vanished.
 */
export const SHOP_LOCATION_PAGE_SIZE = 50;

/**
 * The commerce fields of ONE variant.
 *
 * `inventoryItem.id` is the load-bearing one: cost, the shipping fields and
 * every quantity live on InventoryItem, and every write addresses that GID. A
 * variant without one cannot have its stock edited, and the UI says so rather
 * than offering a control that would fail.
 */
export const VARIANT_COMMERCE_SELECTION = `
                      price
                      compareAtPrice
                      inventoryPolicy
                      inventoryItem {
                        id
                        tracked
                        requiresShipping
                        countryCodeOfOrigin
                        harmonizedSystemCode
                        unitCost { amount }
                        measurement { weight { value unit } }
                        inventoryLevels(first: ${INVENTORY_LEVEL_PAGE_SIZE}) {
                          pageInfo { hasNextPage }
                          nodes {
                            location { id name isActive }
                            quantities(names: ["available", "on_hand", "committed"]) { name quantity }
                          }
                        }
                      }
                      taxable`;

/** The node shape every publication connection below returns. */
const PUBLICATION_NODE_SELECTION = `
                    pageInfo { hasNextPage }
                    nodes {
                      isPublished
                      publishDate
                      publication { id name catalog { __typename title } }
                    }`;

/**
 * Every publication of this product — and `catalogType` is why there are THREE
 * connections instead of one.
 *
 * Two arguments carry this selection, and both are easy to get wrong:
 *
 * `onlyPublished: false` DEFAULTS to true, which returns only the channels the
 * product is already on — the picker could untick channels but never add one,
 * and the "on no channel — invisible" badge would sit above an empty list with
 * nothing to tick. The feature would diagnose the trap and withhold the cure.
 *
 * `catalogType` DEFAULTS to APP, and that default is silent: a shop with three
 * region catalogs and a B2B catalog gets an answer that mentions none of them,
 * indistinguishable from a shop that has none. This app shipped exactly that —
 * it grouped publications by catalog type over a list that could only ever
 * contain one. Markets and B2B locations have to be ASKED FOR, by name, in
 * their own connection.
 */
export const PRODUCT_PUBLICATIONS_SELECTION = `
                  resourcePublicationsV2(first: ${PUBLICATION_PAGE_SIZE}, onlyPublished: false) {${PUBLICATION_NODE_SELECTION}
                  }`;

/**
 * The two connections the default hides. Kept SEPARATE from the one above so a
 * caller can drop them and still work: `CatalogType` is an enum, an unknown
 * value fails at the SCHEMA level (a top-level `errors` array with `data: null`
 * that never reaches `userErrors`), and that would take the whole query — sales
 * channels included — down with it on any API version that does not know these
 * names. Every caller therefore falls back to the app-catalog selection alone
 * and reports the rest as unknown rather than as absent.
 */
export const PRODUCT_CATALOG_PUBLICATIONS_SELECTION = `
                  marketPublications: resourcePublicationsV2(first: ${PUBLICATION_PAGE_SIZE}, onlyPublished: false, catalogType: MARKET) {${PUBLICATION_NODE_SELECTION}
                  }
                  companyLocationPublications: resourcePublicationsV2(first: ${PUBLICATION_PAGE_SIZE}, onlyPublished: false, catalogType: COMPANY_LOCATION) {${PUBLICATION_NODE_SELECTION}
                  }`;

/**
 * What KIND of thing a publication publishes to.
 *
 * Shopify models three different questions with one mechanism. A publication
 * hangs off a `Catalog`, and the catalog's type is the only thing that says
 * which question it answers:
 *
 *   AppCatalog              a SALES CHANNEL — online store, POS, Shop, Google.
 *                           "Where is this sold?"
 *   MarketCatalog           a MARKET/region. "Who may see it?" — availability
 *                           and pricing per market, not a channel at all.
 *   CompanyLocationCatalog  a B2B company location. Same question, per buyer.
 *
 * The admin's own publishing dialog puts them in three separate lists, and
 * this app used to put all three in one headed "Sales channels" — so a shop
 * with markets read its regions as channels it had never installed.
 *
 * `""` means UNKNOWN, never "app": the field is nullable, and a row this
 * shop cached before the column existed carries no answer either. Everything
 * downstream must treat unknown as "leave where it always was" rather than as
 * evidence — an empty column is never evidence (CLAUDE.md).
 */
export type PublicationCatalogKind = "app" | "market" | "companyLocation" | "";

/** `Catalog.__typename` → the stable code stored and rendered. */
export function publicationCatalogKind(typename: unknown): PublicationCatalogKind {
  switch (typename) {
    case "AppCatalog":
      return "app";
    case "MarketCatalog":
      return "market";
    case "CompanyLocationCatalog":
      return "companyLocation";
    default:
      return "";
  }
}

/**
 * Is this publication a SALES CHANNEL for the purposes of the "on no channel —
 * invisible" badge?
 *
 * Excludes only what is KNOWN to be something else. An unknown catalog counts
 * as a channel, deliberately: the badge is an alarm, and raising it for a
 * product that is in fact on the online store — because one row happened to
 * arrive without its catalog — is worse than not raising it at all.
 */
export function countsAsSalesChannel(kind: PublicationCatalogKind): boolean {
  return nonChannelKind(kind) === undefined;
}

/**
 * The kinds that are NOT sales channels — the one list both rules read.
 *
 * `countsAsSalesChannel` and `publicationGroupOf` used to each name these two
 * by hand, so the alarm's idea of "a channel" and the list's could drift apart
 * while both kept passing their own tests.
 */
const NON_CHANNEL_KINDS = ["market", "companyLocation"] as const;

function nonChannelKind(kind: PublicationCatalogKind) {
  return NON_CHANNEL_KINDS.find((candidate) => candidate === kind);
}

// ────────────────────────────────────────────────────────────────────────────
// Response shapes
// ────────────────────────────────────────────────────────────────────────────

export interface ShopifyQuantity {
  name?: string | null;
  quantity?: number | null;
}

export interface ShopifyInventoryLevelNode {
  location?: { id?: string | null; name?: string | null; isActive?: boolean | null } | null;
  quantities?: ShopifyQuantity[] | null;
}

export interface ShopifyInventoryItem {
  id?: string | null;
  tracked?: boolean | null;
  requiresShipping?: boolean | null;
  countryCodeOfOrigin?: string | null;
  harmonizedSystemCode?: string | null;
  unitCost?: { amount?: string | null } | null;
  measurement?: { weight?: { value?: number | null; unit?: string | null } | null } | null;
  inventoryLevels?: {
    pageInfo?: { hasNextPage?: boolean } | null;
    nodes?: ShopifyInventoryLevelNode[] | null;
  } | null;
}

export interface ShopifyVariantCommerce {
  taxable?: boolean | null;
  inventoryPolicy?: string | null;
  inventoryItem?: ShopifyInventoryItem | null;
}

export interface ShopifyResourcePublications {
  pageInfo?: { hasNextPage?: boolean } | null;
  nodes?: Array<{
    isPublished?: boolean | null;
    publishDate?: string | null;
    publication?: {
      id?: string | null;
      name?: string | null;
      catalog?: { __typename?: string | null; title?: string | null } | null;
    } | null;
  }> | null;
}

/** The columns the variant mapper writes. Every one nullable — see the header. */
export interface VariantCommerceColumns {
  inventoryItemId?: string | null;
  cost?: string | null;
  taxable?: boolean | null;
  requiresShipping?: boolean | null;
  weight?: string | null;
  weightUnit?: string | null;
  harmonizedSystemCode?: string | null;
  countryCodeOfOrigin?: string | null;
  inventoryTracked?: boolean | null;
  inventoryPolicy?: string | null;
  commerceSyncedAt?: Date;
}

/** The keys a FULL commerce selection always delivers. */
const REQUIRED_VARIANT_KEYS: Array<keyof ShopifyVariantCommerce> = [
  "taxable",
  "inventoryPolicy",
  "inventoryItem",
];

/**
 * True when the response actually carried the commerce block.
 *
 * Presence of the KEY, not truthiness of the value: `taxable: false` and
 * `inventoryItem: null` are both real answers, and a check on truthiness would
 * read a legitimately untracked variant as an unfetched one.
 */
export function hasVariantCommerce(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  return REQUIRED_VARIANT_KEYS.every((key) => key in (data as Record<string, unknown>));
}

function nullableText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

/**
 * Variant commerce columns from a Shopify variant node.
 *
 * Returns `{}` — write NOTHING — when the block is absent. A half-delivered
 * block written as defaults is worse than no write at all: it would stamp
 * `commerceSyncedAt`, which every reader takes as "these values are the
 * merchant's data".
 */
export function variantCommerceColumns(
  data: ShopifyVariantCommerce | null | undefined,
  now: Date = new Date(),
): VariantCommerceColumns {
  if (!hasVariantCommerce(data)) return {};
  const item = data?.inventoryItem ?? null;
  const weight = item?.measurement?.weight ?? null;

  return {
    inventoryItemId: nullableText(item?.id),
    // Money as a STRING all the way to Prisma's Decimal — a float conversion
    // here is the rounding error the schema's Decimal exists to avoid.
    cost: nullableText(item?.unitCost?.amount),
    taxable: data?.taxable ?? null,
    requiresShipping: item?.requiresShipping ?? null,
    weight: weight?.value != null ? String(weight.value) : null,
    weightUnit: nullableText(weight?.unit),
    harmonizedSystemCode: nullableText(item?.harmonizedSystemCode),
    countryCodeOfOrigin: nullableText(item?.countryCodeOfOrigin),
    inventoryTracked: item?.tracked ?? null,
    inventoryPolicy: nullableText(data?.inventoryPolicy),
    commerceSyncedAt: now,
  };
}

export interface InventoryLevelRow {
  shop: string;
  inventoryItemId: string;
  variantId: string;
  locationId: string;
  onHand: number | null;
  available: number | null;
}

export interface LocationRow {
  id: string;
  shop: string;
  name: string;
  isActive: boolean;
  position: number;
}

/**
 * Stock rows and the locations they mention, from one variant's response.
 *
 * `null` means the block was NOT delivered — the caller's signal to skip the
 * rebuild entirely, not to wipe the levels. An empty `rows` list with
 * `hasMore: false` is a real answer: this variant holds stock nowhere.
 *
 * Locations come back alongside because the same response carries them, and a
 * separate location query would be one more call per sync for data already in
 * hand. `position` is the order Shopify returned them in.
 */
export function inventoryLevelRows(
  shop: string,
  variantId: string,
  data: ShopifyVariantCommerce | null | undefined,
): { rows: InventoryLevelRow[]; locations: LocationRow[]; hasMore: boolean } | null {
  if (!hasVariantCommerce(data)) return null;
  const item = data?.inventoryItem ?? null;
  const inventoryItemId = nullableText(item?.id);
  // No InventoryItem ⇒ nothing addressable. Not an error: a variant can exist
  // without one, and the UI shows that state rather than an empty stock table.
  if (!inventoryItemId) return { rows: [], locations: [], hasMore: false };

  const rows: InventoryLevelRow[] = [];
  const locations: LocationRow[] = [];
  const seenLocations = new Set<string>();

  for (const [index, node] of (item?.inventoryLevels?.nodes ?? []).entries()) {
    const locationId = nullableText(node?.location?.id);
    if (!locationId) continue;

    if (!seenLocations.has(locationId)) {
      seenLocations.add(locationId);
      locations.push({
        id: locationId,
        shop,
        name: node?.location?.name ?? "",
        // A deactivated location keeps its stock but takes no writes. Mirrored
        // so the UI can grey it instead of hiding it — a location that
        // disappears reads as stock that vanished.
        isActive: node?.location?.isActive !== false,
        position: index,
      });
    }

    const byName = new Map(
      (node?.quantities ?? []).map((q) => [q?.name ?? "", q?.quantity ?? null] as const),
    );
    rows.push({
      shop,
      inventoryItemId,
      variantId,
      locationId,
      // A name Shopify did not return is UNKNOWN, not zero. An untracked item
      // reports neither, and 0 would tell the merchant they are sold out of
      // something they can sell without limit.
      onHand: byName.has("on_hand") ? byName.get("on_hand") ?? null : null,
      available: byName.has("available") ? byName.get("available") ?? null : null,
      // `committed` rides along in the QUERY but is not mirrored: it moves with
      // every order and the cache has no column for it. The panel reads it off
      // the live response instead.
    });
  }

  return {
    rows,
    locations,
    hasMore: item?.inventoryLevels?.pageInfo?.hasNextPage === true,
  };
}

/**
 * The three lists a publication can belong to, in the admin's own order.
 *
 * `channels` is not a catalog kind but a BUCKET: an AppCatalog belongs in it,
 * and so does an UNKNOWN one — which is where an unknown publication has
 * always rendered, and the conservative place to leave it (see
 * `countsAsSalesChannel`).
 */
export const PUBLICATION_GROUP_ORDER = ["channels", "market", "companyLocation"] as const;

export type PublicationGroupId = (typeof PUBLICATION_GROUP_ORDER)[number];

export function publicationGroupOf(kind: PublicationCatalogKind): PublicationGroupId {
  // Same list as `countsAsSalesChannel`, so the alarm and the grouping can
  // never disagree about what a channel is. Anything not on it — including an
  // UNKNOWN catalog — buckets with the sales channels, which is where it has
  // always rendered.
  return nonChannelKind(kind) ?? "channels";
}

/**
 * Bucket publications into the three lists, keeping Shopify's order inside
 * each. The SALES CHANNEL group is always present, even empty: that is the
 * state the "on no channel — invisible" alarm exists for, and a shop whose
 * only publications are market catalogs would otherwise drop the alarm
 * together with its heading. The other two appear only if the shop has them.
 */
export function groupPublications<T extends { catalogType: PublicationCatalogKind }>(
  rows: T[],
): Array<{ id: PublicationGroupId; rows: T[] }> {
  return PUBLICATION_GROUP_ORDER.map((id) => ({
    id,
    rows: rows.filter((row) => publicationGroupOf(row.catalogType) === id),
  })).filter((group) => group.id === "channels" || group.rows.length > 0);
}

/**
 * Which MARKETS a product's publications scope it to — the mapper behind
 * `/api/product-market-publications`.
 *
 * `scoped` is every market a market catalog covers, published or not; `published`
 * is the subset the product actually sits in. The two are separate answers on
 * purpose: a market that NO catalog scopes is unrestricted, which is not the
 * same as a market the product was left out of, and only the second is worth
 * warning about.
 *
 * `truncated` propagates from BOTH windows — the publication page and each
 * catalog's market list. A market that fell off either end is indistinguishable
 * from one the product is genuinely missing from, so the caller must say
 * nothing rather than guess.
 */
export interface MarketPublicationView {
  scopedMarketIds: string[];
  publishedMarketIds: string[];
  /**
   * Scoped, not live YET — a market launch with a future publish date.
   *
   * Shopify reports `isPublished: false` for a scheduled publication, so
   * without this set a merchant preparing a market launch would be told the
   * product "is not in the catalog" and sent to add what they already added.
   * The same distinction `PublicationRow.publishDate` keeps for channels.
   */
  scheduledMarketIds: string[];
  truncated: boolean;
}

export interface ShopifyMarketPublications {
  pageInfo?: { hasNextPage?: boolean } | null;
  nodes?: Array<{
    isPublished?: boolean | null;
    publishDate?: string | null;
    publication?: {
      id?: string | null;
      catalog?: {
        __typename?: string | null;
        markets?: {
          pageInfo?: { hasNextPage?: boolean } | null;
          nodes?: Array<{ id?: string | null }> | null;
        } | null;
      } | null;
    } | null;
  }> | null;
}

/** `null` ⇒ the response did not carry the block; the caller must not guess. */
export function marketPublicationView(
  connection: ShopifyMarketPublications | null | undefined,
): MarketPublicationView | null {
  if (!connection) return null;

  const scoped = new Set<string>();
  const published = new Set<string>();
  const scheduled = new Set<string>();
  let truncated = connection.pageInfo?.hasNextPage === true;

  for (const node of connection.nodes ?? []) {
    const catalog = node?.publication?.catalog;
    if (publicationCatalogKind(catalog?.__typename) !== "market") continue;
    if (catalog?.markets?.pageInfo?.hasNextPage === true) truncated = true;
    // Not live, and the date is still AHEAD ⇒ a launch is scheduled. The
    // date has to be compared, not merely present: a publication that was
    // unpublished again keeps its old date, and reading that as "scheduled"
    // would suppress the warning forever on a product that really is missing
    // from the market. An unparseable date is not a schedule either.
    const publishAt = node?.publishDate ? Date.parse(node.publishDate) : NaN;
    const isScheduled = node?.isPublished !== true && Number.isFinite(publishAt) && publishAt > Date.now();
    for (const market of catalog?.markets?.nodes ?? []) {
      const marketId = market?.id;
      if (!marketId) continue;
      scoped.add(marketId);
      // A market served by SEVERAL catalogs counts as published if ANY of
      // them carries the product — that is what the storefront resolves to.
      // Same for scheduled: one catalog with a launch date is a launch.
      if (node?.isPublished === true) published.add(marketId);
      else if (isScheduled) scheduled.add(marketId);
    }
  }

  return {
    scopedMarketIds: [...scoped],
    publishedMarketIds: [...published],
    scheduledMarketIds: [...scheduled],
    truncated,
  };
}

export interface PublicationRow {
  shop: string;
  productId: string;
  publicationId: string;
  publicationName: string;
  /** "" = unknown. See `publicationCatalogKind`. */
  catalogType: PublicationCatalogKind;
  isPublished: boolean;
  publishDate: Date | null;
}

/**
 * Channel rows from one product's response.
 *
 * `null` ⇒ not delivered, skip the rebuild. The same rule as everywhere else
 * in this file, and it matters more here than usual: an empty publication list
 * IS a meaningful state (§2.3 — an ACTIVE product published nowhere is
 * invisible), so "wipe on a partial response" would manufacture exactly the
 * alarming state this feature exists to reveal.
 */
export function productPublicationRows(
  shop: string,
  productId: string,
  data: ShopifyResourcePublications | null | undefined,
): { rows: PublicationRow[]; hasMore: boolean } | null {
  if (!data) return null;
  const rows: PublicationRow[] = [];
  const seen = new Set<string>();

  for (const node of data.nodes ?? []) {
    const publicationId = nullableText(node?.publication?.id);
    if (!publicationId || seen.has(publicationId)) continue;
    seen.add(publicationId);

    const publishDate = node?.publishDate ? new Date(node.publishDate) : null;
    const validDate = publishDate && !Number.isNaN(publishDate.getTime()) ? publishDate : null;

    rows.push({
      shop,
      productId,
      publicationId,
      // A NAME, through a chain, because only the first link is reliable.
      // MEASURED on a live shop (2026-08, Settings → Probes → Publications):
      // a market catalog's `Publication.name` comes back EMPTY, so a channel
      // list built on it alone rendered three regions as raw GIDs. The
      // catalog's own `title` is `String!` and is what the merchant named it.
      publicationName: nullableText(node?.publication?.name)
        ?? nullableText(node?.publication?.catalog?.title)
        ?? "",
      catalogType: publicationCatalogKind(node?.publication?.catalog?.__typename),
      // Shopify's own `isPublished` already accounts for a future publish
      // date, so it is taken verbatim rather than recomputed from the date —
      // two answers to one question is how they drift apart.
      isPublished: node?.isPublished === true,
      publishDate: validDate,
    });
  }

  return { rows, hasMore: data.pageInfo?.hasNextPage === true };
}

/**
 * Is a quantity meaningful for this variant at all?
 *
 * `tracked === false` means Shopify keeps no count — there is nothing to show
 * and nothing to write. `null` means the block was never synced, which is a
 * third state: it renders as "unknown" with a reload, never as a number.
 */
export function stockIsMeaningful(inventoryTracked: boolean | null | undefined): boolean {
  return inventoryTracked === true;
}
