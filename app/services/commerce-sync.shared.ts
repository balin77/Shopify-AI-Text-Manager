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

/**
 * Every sales channel of the shop, with this product's state in each.
 *
 * `onlyPublished: false` is the load-bearing argument. It DEFAULTS to true,
 * which returns only the channels the product is already on — so the picker
 * could untick channels but never add one, and the "on no channel — invisible"
 * badge would sit above an empty list with nothing to tick. The feature would
 * diagnose the trap and withhold the cure.
 */
export const PRODUCT_PUBLICATIONS_SELECTION = `
                  resourcePublicationsV2(first: ${PUBLICATION_PAGE_SIZE}, onlyPublished: false) {
                    pageInfo { hasNextPage }
                    nodes {
                      isPublished
                      publishDate
                      publication { id name }
                    }
                  }`;

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
    publication?: { id?: string | null; name?: string | null } | null;
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

export interface PublicationRow {
  shop: string;
  productId: string;
  publicationId: string;
  publicationName: string;
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
      publicationName: node?.publication?.name ?? "",
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
