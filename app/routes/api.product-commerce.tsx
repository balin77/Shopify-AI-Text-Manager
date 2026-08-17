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
 * So this reads LIVE on open and writes the result to the cache afterwards. The
 * cache is the fallback for a throttled lookup and the label store for
 * locations and channels — never the number the merchant edits against.
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
} from "~/services/commerce-sync.shared";
import {
  applyPublicationChanges,
  applyStockChanges,
  parseQuantity,
  type CommerceWarning,
  type StockChange,
} from "~/services/commerce-write.server";

/** Stock and channels are a Pro feature, like the other commerce surfaces. */
const REQUIRED_PLAN = "pro" as const;

export interface CommerceVariantView {
  id: string;
  gid: string;
  title: string;
  sku: string | null;
  inventoryItemId: string | null;
  /** null ⇒ never synced. false ⇒ Shopify keeps no count for this variant. */
  inventoryTracked: boolean | null;
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

    const numericProductId = productId.replace("gid://shopify/Product/", "");
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
      await db.productVariant
        .updateMany({ where: { id: numericId }, data: columns as never })
        .catch(() => undefined);
      if (levels) {
        await db.inventoryLevel.deleteMany({ where: { variantId: numericId } }).catch(() => undefined);
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
        inventoryItemId: columns.inventoryItemId ?? null,
        inventoryTracked: columns.inventoryTracked ?? null,
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
      numericProductId,
      product.resourcePublicationsV2 as never,
    );
    if (publications) {
      await db.productPublication.deleteMany({ where: { shop: session.shop, productId: numericProductId } }).catch(() => undefined);
      if (publications.rows.length > 0) {
        await db.productPublication.createMany({ data: publications.rows, skipDuplicates: true }).catch(() => undefined);
      }
    }

    return json({
      success: true,
      variants,
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
      if (!inventoryItemId.startsWith("gid://shopify/InventoryItem/")) continue;
      if (!locationId.startsWith("gid://shopify/Location/")) continue;
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

    const warning = await applyStockChanges(admin, db, session.shop, { variantId, changes });
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
