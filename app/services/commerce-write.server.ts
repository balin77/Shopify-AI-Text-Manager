/**
 * PLAN_CONTENT_CREATION Phase 4 — writing stock and sales channels.
 *
 * ── The echo rule, stricter than anywhere else in this app ──────────────────
 * A quantity is money. So a stock write counts as successful only when Shopify
 * returns the NEW QUANTITY and it matches what was asked for — not when
 * `userErrors` is empty, and not when the mutation merely returned an object.
 * There is no optimistic update anywhere in this file: the cache is written
 * from the echo or not at all.
 *
 * ── Never a delta over a cached number ──────────────────────────────────────
 * `inventorySetQuantities` takes an ABSOLUTE quantity, and this module pairs it
 * with `compareQuantity` — the value the merchant was LOOKING AT. If stock
 * moved between the page load and the save (an order, a return, another app),
 * Shopify refuses the write and the merchant is told the number changed,
 * instead of silently overwriting someone else's arithmetic. Computing
 * `cached + delta` is the classic source of inventory drift and this module
 * offers nothing to compute it with.
 *
 * ── Two names, two meanings ─────────────────────────────────────────────────
 * `on_hand` is what is physically in the room. `available` is on-hand minus
 * what is committed to unfulfilled orders, and it is DERIVED — writing it
 * directly would silently contradict the commitments. So only `on_hand` is
 * writable here; `available` is read and shown.
 *
 * ── Never fails the save ────────────────────────────────────────────────────
 * Like the collection-rules and price paths: the content update has already
 * happened, so a stock or channel change that did not land comes back as a
 * warning CODE (the app ships in three languages), never as an error that
 * would tell the merchant their text edits were lost too.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { PrismaClient } from "@prisma/client";
import { logger } from "~/utils/logger.server";

/** Codes resolved to sentences by the client (`t.content.commerceWarnings`). */
export type CommerceWarning =
  | "stockChangedMeanwhile"
  | "stockNotConfirmed"
  | "stockFailed"
  | "stockUntracked"
  | "stockNoInventoryItem"
  | "channelsNotConfirmed"
  | "channelsFailed";

export interface StockChange {
  /** gid://shopify/InventoryItem/... */
  inventoryItemId: string;
  /** gid://shopify/Location/... */
  locationId: string;
  /** The ABSOLUTE new on-hand count. */
  quantity: number;
  /**
   * What the merchant was looking at. Shopify refuses the write when reality
   * has moved on — which is the entire safety property here, so it is
   * required rather than optional.
   */
  compareQuantity: number;
}

/**
 * A quantity is a whole, non-negative number.
 *
 * Validated here rather than at the mutation because a bad scalar fails at the
 * SCHEMA level, which comes back as a top-level `errors` array with
 * `data: null` and never reaches `userErrors` — the save would read as a
 * success while nothing was written.
 */
export function parseQuantity(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  // Shopify permits negative on-hand in some configurations, but this app has
  // no UI that means it — a minus sign here is a typo, not an intent.
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Writes ONE variant's on-hand quantities and mirrors what Shopify confirmed.
 *
 * All changes go in a single `inventorySetQuantities` call: Shopify applies it
 * atomically, so a merchant editing three locations at once cannot end up with
 * one of them written and two not.
 */
export async function applyStockChanges(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  params: { variantId: string; changes: StockChange[]; reason?: string },
): Promise<CommerceWarning | undefined> {
  if (params.changes.length === 0) return undefined;

  try {
    const response = await admin.graphql(
      `#graphql
        mutation setOnHandQuantities($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            inventoryAdjustmentGroup {
              # The echo that matters: the quantity Shopify STORED, per item and
              # location. Without it "saved" is a claim about money nobody
              # verified.
              changes {
                name
                delta
                quantityAfterChange
                item { id }
                location { id }
              }
            }
            userErrors { field message code }
          }
        }`,
      {
        variables: {
          input: {
            // Only ever "on_hand". `available` is derived from it minus open
            // commitments, and writing it directly would contradict them.
            name: "on_hand",
            // Shopify requires a reason string; "correction" is what a manual
            // stock edit in the admin records too.
            reason: params.reason || "correction",
            // The safety property. With this false, a stale page silently
            // overwrites whatever happened in between.
            ignoreCompareQuantity: false,
            quantities: params.changes.map((change) => ({
              inventoryItemId: change.inventoryItemId,
              locationId: change.locationId,
              quantity: change.quantity,
              compareQuantity: change.compareQuantity,
            })),
          },
        },
      },
    );

    const body = (await response.json()) as {
      data?: {
        inventorySetQuantities?: {
          inventoryAdjustmentGroup?: {
            changes?: Array<{
              quantityAfterChange?: number | null;
              item?: { id?: string } | null;
              location?: { id?: string } | null;
            }> | null;
          } | null;
          userErrors?: Array<{ message: string; code?: string | null }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (body.errors?.length) {
      logger.warn("[Commerce] Stock schema-level error", {
        context: "Commerce", shop, error: body.errors[0]?.message,
      });
      return "stockFailed";
    }

    const payload = body.data?.inventorySetQuantities;
    if (payload?.userErrors?.length) {
      const first = payload.userErrors[0];
      logger.warn("[Commerce] Stock userErrors", {
        context: "Commerce", shop, error: first.message, code: first.code ?? undefined,
      });
      // Told apart on purpose: "someone else changed it" is a thing the
      // merchant can act on by reloading, and reading it as a generic failure
      // would invite a retry that overwrites the other change.
      return first.code === "STALE_COMPARE_QUANTITY" ? "stockChangedMeanwhile" : "stockFailed";
    }

    const changes = payload?.inventoryAdjustmentGroup?.changes ?? [];
    // The echo, checked per CHANGE rather than in aggregate: a partial apply
    // that mirrored as complete would leave the cache claiming a quantity the
    // shop does not hold.
    const confirmed = new Map(
      changes
        .filter((c) => c.item?.id && c.location?.id)
        .map((c) => [`${c.item!.id}::${c.location!.id}`, c.quantityAfterChange ?? null] as const),
    );

    const unconfirmed = params.changes.filter((change) => {
      const stored = confirmed.get(`${change.inventoryItemId}::${change.locationId}`);
      return stored == null || stored !== change.quantity;
    });

    // Whatever WAS confirmed is mirrored — a merchant who edited three
    // locations and got two through should see those two.
    const landed = params.changes.filter((c) => !unconfirmed.includes(c));
    for (const change of landed) {
      await db.inventoryLevel
        .updateMany({
          where: { shop, variantId: params.variantId, locationId: change.locationId },
          data: { onHand: change.quantity, syncedAt: new Date() },
        })
        .catch(() => undefined);
    }

    if (unconfirmed.length > 0) {
      logger.warn("[Commerce] Stock not echoed back", {
        context: "Commerce", shop, variantId: params.variantId, unconfirmed: unconfirmed.length,
      });
      return "stockNotConfirmed";
    }

    logger.info("[Commerce] Stock applied", {
      context: "Commerce", shop, variantId: params.variantId, changes: landed.length,
    });
    return undefined;
  } catch (error) {
    logger.warn("[Commerce] Stock write failed", {
      context: "Commerce",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return "stockFailed";
  }
}

/**
 * Publishes / unpublishes a product on sales channels.
 *
 * §2.3's trap is why this exists: `status: ACTIVE` is NOT visibility. A product
 * that is active but published to no channel is invisible everywhere, and the
 * Shopify admin does not say so on the product page either.
 *
 * Two mutations rather than one, because Shopify has no "set the list": publish
 * and unpublish are separate verbs. They are still ONE decision, so a failure
 * in either half reports the same code — a half-applied channel change is not a
 * success with a footnote.
 */
export async function applyPublicationChanges(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  params: { productId: string; toPublish: string[]; toUnpublish: string[]; names: Map<string, string> },
): Promise<CommerceWarning | undefined> {
  if (params.toPublish.length === 0 && params.toUnpublish.length === 0) return undefined;

  const run = async (
    mutation: "publishablePublish" | "publishableUnpublish",
    publicationIds: string[],
  ): Promise<{ ok: boolean; confirmed: Set<string> }> => {
    if (publicationIds.length === 0) return { ok: true, confirmed: new Set() };
    const response = await admin.graphql(
      `#graphql
        mutation channelChange($id: ID!, $input: [PublicationInput!]!) {
          ${mutation}(id: $id, input: $input) {
            publishable {
              # The echo: which channels the product now sits on. Checked
              # rather than assumed — this is the field the whole feature is
              # about, and "no userErrors" has never meant "stored".
              ... on Product {
                id
                resourcePublicationsV2(first: 50) {
                  nodes { isPublished publication { id } }
                }
              }
            }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          id: params.productId,
          input: publicationIds.map((publicationId) => ({ publicationId })),
        },
      },
    );

    const body = (await response.json()) as {
      data?: Record<string, {
        publishable?: {
          id?: string;
          resourcePublicationsV2?: {
            nodes?: Array<{ isPublished?: boolean; publication?: { id?: string } }> | null;
          } | null;
        } | null;
        userErrors?: Array<{ message: string }>;
      }>;
      errors?: Array<{ message?: string }>;
    };

    if (body.errors?.length) {
      logger.warn("[Commerce] Channel schema-level error", {
        context: "Commerce", shop, mutation, error: body.errors[0]?.message,
      });
      return { ok: false, confirmed: new Set() };
    }
    const payload = body.data?.[mutation];
    if (payload?.userErrors?.length) {
      logger.warn("[Commerce] Channel userErrors", {
        context: "Commerce", shop, mutation, error: payload.userErrors[0].message,
      });
      return { ok: false, confirmed: new Set() };
    }

    const nodes = payload?.publishable?.resourcePublicationsV2?.nodes ?? [];
    const published = new Set(
      nodes.filter((n) => n.isPublished === true && n.publication?.id).map((n) => n.publication!.id as string),
    );
    // The echo means different things per verb, so it is checked per verb:
    // published ⇒ the id must now be in the set, unpublished ⇒ it must not.
    const confirmed = new Set(
      publicationIds.filter((id) => (mutation === "publishablePublish" ? published.has(id) : !published.has(id))),
    );
    return { ok: true, confirmed };
  };

  try {
    const publishResult = await run("publishablePublish", params.toPublish);
    const unpublishResult = await run("publishableUnpublish", params.toUnpublish);

    if (!publishResult.ok || !unpublishResult.ok) return "channelsFailed";

    const allConfirmed =
      publishResult.confirmed.size === params.toPublish.length &&
      unpublishResult.confirmed.size === params.toUnpublish.length;

    // Mirror only what came BACK. A row written from the request would make
    // the editor show a channel the product is not actually on.
    for (const publicationId of publishResult.confirmed) {
      await db.productPublication
        .upsert({
          where: { productId_publicationId: { productId: params.productId, publicationId } },
          create: {
            shop,
            productId: params.productId,
            publicationId,
            publicationName: params.names.get(publicationId) ?? "",
            isPublished: true,
          },
          update: { isPublished: true, syncedAt: new Date() },
        })
        .catch(() => undefined);
    }
    for (const publicationId of unpublishResult.confirmed) {
      await db.productPublication
        .updateMany({
          where: { shop, productId: params.productId, publicationId },
          data: { isPublished: false, publishDate: null, syncedAt: new Date() },
        })
        .catch(() => undefined);
    }

    if (!allConfirmed) {
      logger.warn("[Commerce] Channels not fully echoed", {
        context: "Commerce", shop, productId: params.productId,
      });
      return "channelsNotConfirmed";
    }

    logger.info("[Commerce] Channels applied", {
      context: "Commerce",
      shop,
      productId: params.productId,
      published: params.toPublish.length,
      unpublished: params.toUnpublish.length,
    });
    return undefined;
  } catch (error) {
    logger.warn("[Commerce] Channel write failed", {
      context: "Commerce",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return "channelsFailed";
  }
}
