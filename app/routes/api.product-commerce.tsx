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
  inventoryLevelRows,
  productPublicationRows,
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

/** Stock and channels are a Pro feature, like the other commerce surfaces. */
const REQUIRED_PLAN = "pro" as const;

export interface CommerceVariantView {
  id: string;
  gid: string;
  title: string;
  sku: string | null;
  /** The SELLING price — what a customer pays. Not `cost`, which is what the
   *  merchant pays and is the field that used to be alone in this panel. */
  price: string | null;
  compareAtPrice: string | null;
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
  levels: Array<{
    locationId: string;
    locationName: string;
    locationActive: boolean;
    onHand: number | null;
    available: number | null;
  }>;
  /** The location window was cut off — the totals below are not totals. */
  levelsTruncated: boolean;
}

export interface CommerceChannelView {
  publicationId: string;
  name: string;
  isPublished: boolean;
  publishDate: string | null;
}

async function requirePlan(shop: string): Promise<boolean> {
  const settings = await db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } });
  return meetsPlan((settings?.subscriptionPlan || "free") as never, REQUIRED_PLAN);
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
    const response = await admin.graphql(
      `#graphql
        query productCommerce($id: ID!) {
          product(id: $id) {
            id
            ${PRODUCT_PUBLICATIONS_SELECTION}
            variants(first: ${VARIANT_COMMERCE_PAGE_SIZE}) {
              pageInfo { hasNextPage }
              nodes {
                id
                title
                sku
                ${VARIANT_COMMERCE_SELECTION}
              }
            }
          }
        }`,
      { variables: { id: productId } },
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
        context: "Commerce", shop: session.shop, error: body.errors[0]?.message,
      });
      return json({ success: false, error: "The stock and channel data could not be loaded." }, { status: 502 });
    }
    const product = body.data?.product;
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
    const variantNodes = ((product.variants as Record<string, unknown> | undefined)?.nodes ?? []) as Array<
      Record<string, unknown>
    >;

    const variants: CommerceVariantView[] = [];
    for (const node of variantNodes) {
      const gid = String(node.id ?? "");
      if (!gid) continue;
      const numericId = gid.replace("gid://shopify/ProductVariant/", "");
      const columns = variantCommerceColumns(node as never);
      const levels = inventoryLevelRows(session.shop, numericId, node as never);

      // Locations come back with the levels, so they are mirrored here rather
      // than fetched separately — same data, one call.
      for (const location of levels?.locations ?? []) {
        await db.location
          .upsert({
            where: { shop_id: { shop: session.shop, id: location.id } },
            create: location,
            update: { name: location.name, isActive: location.isActive, position: location.position, syncedAt: new Date() },
          })
          .catch(() => undefined);
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
      variants.push({
        id: numericId,
        gid,
        title: String(node.title ?? ""),
        sku: (node.sku as string | null) ?? null,
        // Read straight off the node, NOT through `variantCommerceColumns`:
        // price is not part of the commerce block (the regular product sync
        // owns it), and folding it in would tie it to that block's
        // all-or-nothing presence rule.
        price: (node.price as string | null) ?? null,
        compareAtPrice: (node.compareAtPrice as string | null) ?? null,
        inventoryItemId: columns.inventoryItemId ?? null,
        inventoryTracked: columns.inventoryTracked ?? null,
        cost: columns.cost ?? null,
        taxable: columns.taxable ?? null,
        requiresShipping: columns.requiresShipping ?? null,
        weight: columns.weight ?? null,
        weightUnit: columns.weightUnit ?? null,
        harmonizedSystemCode: columns.harmonizedSystemCode ?? null,
        countryCodeOfOrigin: columns.countryCodeOfOrigin ?? null,
        levels: (levels?.rows ?? []).map((row) => ({
          locationId: row.locationId,
          locationName: locationNames.get(row.locationId)?.name ?? "",
          locationActive: locationNames.get(row.locationId)?.isActive !== false,
          onHand: row.onHand,
          available: row.available,
        })),
        levelsTruncated: levels?.hasMore === true,
      });
    }

    const publications = productPublicationRows(
      session.shop,
      productId,
      product.resourcePublicationsV2 as never,
    );
    if (publications) {
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
      variantsTruncated: ((product.variants as Record<string, unknown> | undefined)?.pageInfo as { hasNextPage?: boolean } | undefined)?.hasNextPage === true,
      channels: (publications?.rows ?? []).map((row) => ({
        publicationId: row.publicationId,
        name: row.publicationName,
        isPublished: row.isPublished,
        publishDate: row.publishDate ? row.publishDate.toISOString() : null,
      })) satisfies CommerceChannelView[],
      channelsTruncated: publications?.hasMore === true,
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
