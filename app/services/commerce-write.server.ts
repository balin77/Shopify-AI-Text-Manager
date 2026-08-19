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
 * ── This mutation has a deadline ────────────────────────────────────────────
 * `compareQuantity` / `ignoreCompareQuantity` are DEPRECATED from 2026-01 and
 * REMOVED from 2026-04, replaced by `changeFromQuantity` — and Shopify will
 * require `@idempotent` on inventory mutations from the same version. This app
 * pins 2025-10, so the shape below is correct today; the moment the pin moves
 * (the plan's Phase −1 targets 2026-07) this call sends fields that no longer
 * exist, which is a schema-level error and therefore a total, silent-looking
 * failure of every stock write. Whoever moves the pin has to come here.
 *
 * ── Never fails the save ────────────────────────────────────────────────────
 * Like the collection-rules and price paths: the content update has already
 * happened, so a stock or channel change that did not land comes back as a
 * warning CODE (the app ships in three languages), never as an error that
 * would tell the merchant their text edits were lost too.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { PrismaClient } from "@prisma/client";
import { parseMoney } from "./bulk-editor/columns.shared";
import {
  EMPTY_MEASUREMENT_INPUT,
  decideUnitPrice,
  isEmptyMeasurement,
  type UnitPriceFieldValues,
} from "./unit-price.shared";
import { logger } from "~/utils/logger.server";

/** Codes resolved to sentences by the client (`t.content.commerceWarnings`). */
export type CommerceWarning =
  | "itemFieldsNotConfirmed"
  | "itemFieldsFailed"
  | "itemFieldsInvalid"
  | "stockChangedMeanwhile"
  | "stockNotConfirmed"
  | "stockFailed"
  | "stockUntracked"
  | "stockNoInventoryItem"
  | "stockNoBaseline"
  | "channelsNotConfirmed"
  | "channelsFailed"
  | "priceInvalid"
  | "priceAmbiguous"
  | "priceNotConfirmed"
  | "priceFailed"
  | "unitPriceIncomplete"
  | "unitPriceInvalid"
  | "unitPriceAmbiguous"
  | "unitPriceDimension"
  | "unitPriceNotConfirmed"
  | "unitPriceNotShown";

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
  params: { variantId: string; changes: StockChange[]; reason?: string; tracked?: boolean | null },
): Promise<CommerceWarning | undefined> {
  if (params.changes.length === 0) return undefined;
  // An untracked variant has no quantity to set. Sending one anyway comes back
  // as a generic failure, which tells the merchant nothing about WHY — and
  // this is the one reason that is a fact about their setup rather than an
  // error. `undefined` is not "untracked": it means the caller did not say,
  // and only an explicit `false` refuses.
  if (params.tracked === false) return "stockUntracked";

  // `changes` is the echo that matters: the quantity Shopify STORED, per item
  // and location. Without it "saved" is a claim about money nobody verified.
  // It is filtered to on_hand — setting it ALSO produces an "available" ledger
  // change (available = on_hand minus open commitments), and a map keyed only
  // by item+location let that second entry shadow the first — a successful
  // write then read as "not confirmed", or worse, confirmed against the wrong
  // ledger.
  //
  // The prose stays out here on purpose: a `#` comment inside the document
  // travels to Shopify (see the GraphQL-comment gotcha in CLAUDE.md).
  try {
    const response = await admin.graphql(
      `#graphql
        mutation setOnHandQuantities($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            inventoryAdjustmentGroup {
              changes(quantityNames: ["on_hand"]) {
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
              name?: string | null;
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
      // would invite exactly the retry-that-overwrites this guard exists to
      // prevent. The member is `COMPARE_QUANTITY_STALE` — spelling it the
      // other way round made the comparison never match, so the safety
      // message never appeared.
      return first.code === "COMPARE_QUANTITY_STALE" ? "stockChangedMeanwhile" : "stockFailed";
    }

    const changes = payload?.inventoryAdjustmentGroup?.changes ?? [];
    // The echo, checked per CHANGE rather than in aggregate: a partial apply
    // that mirrored as complete would leave the cache claiming a quantity the
    // shop does not hold.
    const confirmed = new Map(
      changes
        // `quantityNames` already narrows this server-side; the second filter
        // is here because the cost of the argument being ignored is a money
        // claim judged against the wrong ledger.
        .filter((c) => c.item?.id && c.location?.id && (c.name == null || c.name === "on_hand"))
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
    // `publishable` is the echo: which publications the product now sits on.
    // Checked rather than assumed — this is the field the whole feature is
    // about, and "no userErrors" has never meant "stored".
    //
    // THREE connections, because `resourcePublicationsV2` defaults to
    // `catalogType: APP`: a region or B2B catalog the merchant just ticked
    // would be missing from a one-connection echo, and the write would report
    // "not confirmed" for a change that landed. `CatalogType` is an enum
    // though, so an API version that does not know these names fails the whole
    // MUTATION at the schema level — hence the retry below, which is safe
    // because publishing an already-published resource is a no-op.
    const send = (withCatalogs: boolean) =>
      admin.graphql(
        `#graphql
        mutation channelChange($id: ID!, $input: [PublicationInput!]!) {
          ${mutation}(id: $id, input: $input) {
            publishable {
              ... on Product {
                id
                resourcePublicationsV2(first: 50) {
                  nodes { isPublished publication { id } }
                }
                ${withCatalogs ? `marketEcho: resourcePublicationsV2(first: 50, catalogType: MARKET) {
                  nodes { isPublished publication { id } }
                }
                companyLocationEcho: resourcePublicationsV2(first: 50, catalogType: COMPANY_LOCATION) {
                  nodes { isPublished publication { id } }
                }` : ""}
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

    type EchoConnection = { nodes?: Array<{ isPublished?: boolean; publication?: { id?: string } }> | null } | null;
    type EchoBody = {
      data?: Record<string, {
        publishable?: {
          id?: string;
          resourcePublicationsV2?: EchoConnection;
          marketEcho?: EchoConnection;
          companyLocationEcho?: EchoConnection;
        } | null;
        userErrors?: Array<{ message: string }>;
      }>;
      errors?: Array<{ message?: string }>;
    };

    let body = (await (await send(true)).json()) as EchoBody;
    let echoCoversCatalogs = true;
    if (body.errors?.length) {
      logger.warn("[Commerce] Catalog-typed echo refused — retrying without it", {
        context: "Commerce", shop, mutation, error: body.errors[0]?.message,
      });
      echoCoversCatalogs = false;
      body = (await (await send(false)).json()) as EchoBody;
    }

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

    const nodes = [
      ...(payload?.publishable?.resourcePublicationsV2?.nodes ?? []),
      ...(payload?.publishable?.marketEcho?.nodes ?? []),
      ...(payload?.publishable?.companyLocationEcho?.nodes ?? []),
    ];
    const published = new Set(
      nodes.filter((n) => n.isPublished === true && n.publication?.id).map((n) => n.publication!.id as string),
    );
    // The echo means different things per verb, so it is checked per verb:
    // published ⇒ the id must now be in the set, unpublished ⇒ it must not.
    //
    // And UNPUBLISH is confirmed by ABSENCE, which is only evidence while the
    // echo can see everything. On the degraded retry it holds app catalogs
    // alone, so a market or B2B publication is absent by construction and
    // every unpublish would "confirm" whether or not anything was written —
    // a false success, plus a mirror row deleted for a change that did not
    // happen. Nothing is confirmed there; the caller reports "not confirmed",
    // which is what it is.
    if (mutation === "publishableUnpublish" && !echoCoversCatalogs) {
      logger.warn("[Commerce] Unpublish left unconfirmed — the echo could not see every catalog type", {
        context: "Commerce", shop, count: publicationIds.length,
      });
      return { ok: true, confirmed: new Set() };
    }
    const confirmed = new Set(
      publicationIds.filter((id) => (mutation === "publishablePublish" ? published.has(id) : !published.has(id))),
    );
    return { ok: true, confirmed };
  };

  try {
    const publishResult = await run("publishablePublish", params.toPublish);
    const unpublishResult = await run("publishableUnpublish", params.toUnpublish);

    const allConfirmed =
      publishResult.ok &&
      unpublishResult.ok &&
      publishResult.confirmed.size === params.toPublish.length &&
      unpublishResult.confirmed.size === params.toUnpublish.length;

    // Mirror only what came BACK — and mirror it even when the OTHER verb
    // failed. The two are separate mutations with no compensation between
    // them, so "publish landed, unpublish did not" is a real outcome;
    // returning early on it left Shopify holding a change the cache denied.
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

    if (!publishResult.ok || !unpublishResult.ok) {
      logger.warn("[Commerce] Channel verb failed", {
        context: "Commerce", shop, productId: params.productId,
      });
      return "channelsFailed";
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

// ────────────────────────────────────────────────────────────────────────────
// The InventoryItem's own fields — cost, tax, and what customs wants
// ────────────────────────────────────────────────────────────────────────────

/**
 * These do NOT live on the variant.
 *
 * Cost, taxability, weight, the HS code and the country of origin are fields of
 * `InventoryItem`, which is why the sync stores `inventoryItemId` at all: it is
 * the address every one of these writes uses. A variant without one cannot have
 * them edited, and the UI says so rather than offering a control that fails.
 *
 * Separate from the quantity write on purpose. A quantity is a claim about a
 * moment and is guarded by `compareQuantity`; these are settings, and guarding
 * them the same way would make a merchant fight a race that does not exist.
 */
export interface InventoryItemFields {
  /** Money as the merchant typed it. Parsed here, once. */
  cost?: string;
  /**
   * NOT here. This app READS `taxable` off the variant (that is where its
   * sync selects it from), and writing it would mean a second mutation
   * (`productVariantsBulkUpdate`) against a different object. Offering it as
   * an editable field whose read and write disagree about where it lives is
   * how a setting starts reverting on the next sync. It is displayed and left
   * to the Shopify admin until the read side moves too.
   */
  requiresShipping?: boolean;
  /** Value + unit travel TOGETHER: a number with no unit is not a weight. */
  weight?: { value: string; unit: string };
  harmonizedSystemCode?: string;
  countryCodeOfOrigin?: string;
  /**
   * Whether Shopify keeps a COUNT for this item.
   *
   * Off, there is no quantity at all — not zero, none — so the stock table has
   * nothing to show and the "keep selling at zero" policy has no zero to apply
   * to. Written here because `tracked` is a field of the InventoryItem, which
   * is also where this app READS it from.
   */
  tracked?: boolean;
  /**
   * The stock-keeping unit. On `InventoryItem` in 2025-10, which is where this
   * writes it; `ProductVariant.sku` is the same value read through the variant.
   */
  sku?: string;
}

/** Shopify's `WeightUnit` enum. A bad enum fails at the SCHEMA level. */
const WEIGHT_UNITS = new Set(["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"]);

/**
 * A non-negative decimal, or null.
 *
 * Money and weight are the two places in this module where a comma is as
 * likely as a dot — the merchant types what their keyboard and locale give
 * them, and this app already learned that lesson on the price field.
 */
export function parseDecimal(value: string): string | null {
  const trimmed = value.trim().replace(",", ".");
  if (!trimmed) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

/** A two-letter ISO country code, uppercased, or null. */
export function parseCountryCode(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

export async function applyInventoryItemFields(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  params: { variantId: string; inventoryItemId: string; fields: InventoryItemFields },
): Promise<CommerceWarning | undefined> {
  const input: Record<string, unknown> = {};
  const mirror: Record<string, unknown> = {};

  if (params.fields.cost !== undefined) {
    // "" is meaningful: it CLEARS the cost. Anything else that is not a
    // number is refused rather than forwarded — a bad scalar fails at the
    // schema level, which never reaches `userErrors`.
    if (params.fields.cost.trim() === "") {
      input.cost = null;
      mirror.cost = null;
    } else {
      // Money, so the same parser as the prices — `parseDecimal` would read a
      // German "1.299" as 1.30 here too.
      const parsed = parseMoney(params.fields.cost);
      if (!parsed.ok || !parsed.value) return "itemFieldsInvalid";
      input.cost = parsed.value;
      mirror.cost = parsed.value;
    }
  }
  if (params.fields.requiresShipping !== undefined) {
    input.requiresShipping = params.fields.requiresShipping;
    mirror.requiresShipping = params.fields.requiresShipping;
  }
  if (params.fields.tracked !== undefined) {
    input.tracked = params.fields.tracked;
    mirror.inventoryTracked = params.fields.tracked;
  }
  if (params.fields.sku !== undefined) {
    // "" clears it. A SKU is a merchant's own reference and an empty one is a
    // deliberate state, not a missing value.
    const sku = params.fields.sku.trim();
    input.sku = sku === "" ? null : sku;
    mirror.sku = sku === "" ? null : sku;
  }
  if (params.fields.weight !== undefined) {
    const value = parseDecimal(params.fields.weight.value);
    const unit = params.fields.weight.unit.trim().toUpperCase();
    // Both or neither. A weight with no unit is not a weight, and Shopify's
    // WeightUnit is an ENUM — a bad one fails at the schema level.
    if (value === null || !WEIGHT_UNITS.has(unit)) return "itemFieldsInvalid";
    input.measurement = { weight: { value: Number(value), unit } };
    mirror.weight = value;
    mirror.weightUnit = unit;
  }
  if (params.fields.harmonizedSystemCode !== undefined) {
    const code = params.fields.harmonizedSystemCode.trim();
    input.harmonizedSystemCode = code || null;
    mirror.harmonizedSystemCode = code || null;
  }
  if (params.fields.countryCodeOfOrigin !== undefined) {
    const raw = params.fields.countryCodeOfOrigin.trim();
    if (raw === "") {
      input.countryCodeOfOrigin = null;
      mirror.countryCodeOfOrigin = null;
    } else {
      const code = parseCountryCode(raw);
      // `CountryCode` is an enum too — same reasoning as the weight unit.
      if (code === null) return "itemFieldsInvalid";
      input.countryCodeOfOrigin = code;
      mirror.countryCodeOfOrigin = code;
    }
  }

  if (Object.keys(input).length === 0) return undefined;

  // `inventoryItem` is the echo, selected in full rather than as a bare id:
  // these are settings a merchant sets once and trusts, so the cache must
  // mirror what Shopify STORED, not what this app sent.
  try {
    const response = await admin.graphql(
      `#graphql
        mutation updateInventoryItem($id: ID!, $input: InventoryItemInput!) {
          inventoryItemUpdate(id: $id, input: $input) {
            inventoryItem {
              id
              tracked
              sku
              requiresShipping
              countryCodeOfOrigin
              harmonizedSystemCode
              unitCost { amount }
              measurement { weight { value unit } }
            }
            userErrors { field message }
          }
        }`,
      { variables: { id: params.inventoryItemId, input } },
    );

    const body = (await response.json()) as {
      data?: {
        inventoryItemUpdate?: {
          inventoryItem?: {
            id?: string;
            tracked?: boolean | null;
            sku?: string | null;
            requiresShipping?: boolean | null;
            countryCodeOfOrigin?: string | null;
            harmonizedSystemCode?: string | null;
            unitCost?: { amount?: string | null } | null;
            measurement?: { weight?: { value?: number | null; unit?: string | null } | null } | null;
          } | null;
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (body.errors?.length) {
      logger.warn("[Commerce] Item fields schema-level error", {
        context: "Commerce", shop, error: body.errors[0]?.message,
      });
      return "itemFieldsFailed";
    }
    const payload = body.data?.inventoryItemUpdate;
    if (payload?.userErrors?.length) {
      logger.warn("[Commerce] Item fields userErrors", {
        context: "Commerce", shop, error: payload.userErrors[0].message,
      });
      return "itemFieldsFailed";
    }
    const item = payload?.inventoryItem;
    if (!item?.id) return "itemFieldsNotConfirmed";
    // `tracked` decides whether stock exists at all, so a write Shopify
    // accepted and did not apply must not read as success.
    if ("inventoryTracked" in mirror && item.tracked !== mirror.inventoryTracked) {
      return "itemFieldsNotConfirmed";
    }
    if ("sku" in mirror && (item.sku ?? null) !== mirror.sku) return "itemFieldsNotConfirmed";

    // Mirror from the ECHO, not from `mirror` — Shopify normalises (a cost of
    // "4.5" comes back "4.50", a weight in grams may be rebased). Writing the
    // sent value would leave the cache claiming a number the shop does not
    // hold, and the panel reads that cache.
    await db.productVariant
      .updateMany({
        // SHOP-SCOPED, like every other mirror in this module. `variantId`
        // arrives as an unvalidated form field on a directly POST-reachable
        // route, so an unscoped write lets one shop's request overwrite
        // another shop's cached variant row. Shopify ids are globally unique
        // so it is safe in practice — but "safe because of an external
        // invariant" is not the house rule, and the scope costs nothing.
        where: { id: params.variantId, product: { shop } },
        data: {
          ...("cost" in mirror ? { cost: item.unitCost?.amount ?? null } : {}),
          ...("requiresShipping" in mirror ? { requiresShipping: item.requiresShipping ?? null } : {}),
          ...("weight" in mirror
            ? {
                weight: item.measurement?.weight?.value != null ? String(item.measurement.weight.value) : null,
                weightUnit: item.measurement?.weight?.unit ?? null,
              }
            : {}),
          ...("harmonizedSystemCode" in mirror ? { harmonizedSystemCode: item.harmonizedSystemCode ?? null } : {}),
          ...("countryCodeOfOrigin" in mirror ? { countryCodeOfOrigin: item.countryCodeOfOrigin ?? null } : {}),
          ...("inventoryTracked" in mirror ? { inventoryTracked: item.tracked ?? null } : {}),
          ...("sku" in mirror ? { sku: item.sku ?? null } : {}),
        },
      })
      .catch(() => undefined);

    logger.info("[Commerce] Item fields applied", {
      context: "Commerce", shop, variantId: params.variantId, fields: Object.keys(input).length,
    });
    return undefined;
  } catch (error) {
    logger.warn("[Commerce] Item field write failed", {
      context: "Commerce",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return "itemFieldsFailed";
  }
}


/** One variant's selling prices, as the merchant typed them. `undefined` means
 *  "not touched"; `""` on the compare-at price CLEARS it. */
export interface VariantPriceFields {
  price?: string;
  compareAtPrice?: string;
  /** ISBN, UPC, GTIN. "" CLEARS it — a wrong barcode is worse than none. */
  barcode?: string;
  /**
   * Whether tax is charged on this variant.
   *
   * It lives on the VARIANT, which is what this mutation writes and what the
   * loader reads it from — so the read/write mismatch that kept it read-only
   * is gone. It was only ever read-only because the panel had no variant write
   * path; it has had one since the prices moved here.
   */
  taxable?: boolean;
  /**
   * `DENY` or `CONTINUE` — whether Shopify keeps selling at zero stock.
   *
   * A GraphQL ENUM, so a bad value fails at the SCHEMA level: a top-level
   * `errors` array with `data: null` that never reaches `userErrors`, i.e. a
   * save that reads as a success while nothing was written. Validated here.
   */
  inventoryPolicy?: string;
  /**
   * The Grundpreis, as the four raw strings the merchant typed.
   *
   * Passed as a quartet rather than as a parsed measurement because the four
   * are ONE value: Shopify replaces the measurement object instead of merging
   * into it, so "change only the unit" is not a thing that exists. Parsed and
   * judged in one place by `decideUnitPrice` — all four empty CLEARS, all four
   * filled SETS, and anything between is refused rather than half-written.
   */
  unitPrice?: UnitPriceFieldValues;
  /**
   * Whether the storefront shows it.
   *
   * Its own field on the variant, and independent of the measurement — that
   * much is MEASURED: writing a measurement left it false through every probe
   * write. What is NOT measured is whether the switch itself can be moved.
   * The probe was extended to flip it and flip it back, and that run has not
   * happened yet, so this ships a control over a capability nobody has
   * confirmed.
   *
   * Shipped anyway, deliberately: if the storefront gates the Grundpreis on
   * this flag, withholding the control means writing a measurement nobody
   * ever sees. The cost of being wrong is bounded by the echo — a switch that
   * will not move gets its OWN warning rather than the generic one, because
   * the measurement may well be stored while only the switch refused, and one
   * code for both would send a merchant looking for a price that is saved.
   */
  showUnitPrice?: boolean;
}

/** Shopify's `ProductVariantInventoryPolicy`. */
const INVENTORY_POLICIES = new Set(["DENY", "CONTINUE"]);

/**
 * Write the SELLING price of one variant.
 *
 * ── Why this has no compare-and-swap, and what that means ───────────────────
 * Stock gets `compareQuantity`, so a number that moved under the merchant's
 * feet is refused rather than overwritten. `productVariantsBulkUpdate` offers
 * nothing equivalent: a price write overwrites whatever is there. That is a
 * property of the API, not a decision — so this does the one thing it can do
 * instead, which is to verify the ECHO: the price Shopify reports back must be
 * the one that was sent, and only then is the cache mirrored. A silent
 * normalisation ("9,90" → "9.90") is fine and expected; a DIFFERENT number
 * means something else won, and that is reported rather than mirrored.
 *
 * The comma is accepted on input because a German merchant types one, and
 * `parseDecimal` already folds it. What is refused is anything that is not a
 * number: a bad scalar fails at the SCHEMA level, where `userErrors` never sees
 * it and the whole call reads as a success while nothing was written.
 */
export async function applyVariantPrices(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  params: { productId: string; variantId: string; variantGid: string; fields: VariantPriceFields },
): Promise<CommerceWarning | undefined> {
  const input: Record<string, unknown> = { id: params.variantGid };

  /**
   * THE money parser — the bulk grid's, not this module's `parseDecimal`.
   *
   * `parseDecimal` folds one comma and accepts anything matching `\d+(\.\d+)?`,
   * which reads a German merchant's "1.299" as ONE EURO THIRTY. `parseMoney`
   * knows that "1.299" is genuinely ambiguous — 1299 to a German, 1.299 to an
   * American — and refuses it with a message telling the merchant how to write
   * it unambiguously, instead of silently picking one reading and repricing the
   * product by a factor of a thousand. It also rounds to two decimals, which
   * keeps the echo comparison below from tripping over Shopify's own rounding.
   */
  const money = (raw: string): { value: string } | { warning: CommerceWarning } => {
    const parsed = parseMoney(raw);
    if (!parsed.ok) return { warning: parsed.error === "ambiguous" ? "priceAmbiguous" : "priceInvalid" };
    return { value: parsed.value ?? "" };
  };

  if (params.fields.price !== undefined) {
    // The price itself cannot be cleared — Shopify requires one on every
    // variant — so an empty field is "leave it alone", not "set nothing".
    const parsed = money(params.fields.price);
    if ("warning" in parsed) return parsed.warning;
    if (parsed.value === "") return "priceInvalid";
    input.price = parsed.value;
  }
  if (params.fields.compareAtPrice !== undefined) {
    if (params.fields.compareAtPrice.trim() === "") {
      // The compare-at price CAN be cleared, and clearing it is how a merchant
      // ends a sale — so "" has to reach Shopify as null rather than be
      // dropped as "unchanged".
      input.compareAtPrice = null;
    } else {
      const parsed = money(params.fields.compareAtPrice);
      if ("warning" in parsed) return parsed.warning;
      input.compareAtPrice = parsed.value;
    }
  }

  if (params.fields.barcode !== undefined) {
    // "" clears it: an empty barcode field means the merchant removed a wrong
    // one, and dropping that as "unchanged" would leave it in place.
    const barcode = params.fields.barcode.trim();
    input.barcode = barcode === "" ? null : barcode;
  }
  if (params.fields.taxable !== undefined) {
    input.taxable = params.fields.taxable;
  }
  if (params.fields.inventoryPolicy !== undefined) {
    const policy = params.fields.inventoryPolicy.trim().toUpperCase();
    // An unrecognised enum is DROPPED and reported, never forwarded: Shopify
    // would reject the whole mutation at the schema level and the price in the
    // same call would go down with it.
    if (!INVENTORY_POLICIES.has(policy)) return "priceInvalid";
    input.inventoryPolicy = policy;
  }

  /** What the echo must show, once the four fields have been judged. */
  let wantedMeasurement: {
    quantityValue: number;
    quantityUnit: string;
    referenceValue: number;
    referenceUnit: string;
  } | null = null;
  /**
   * A refusal reported at the END, after everything else has been written.
   *
   * The measurement is dropped from the input rather than written half - a
   * Grundpreis the merchant did not describe is worse than none - but dropping
   * the whole CALL with it was the wrong half of that decision. On a group
   * edit the client can produce a partial quartet for a member whose
   * measurement the merchant never saw (the field showed "" because the
   * members disagree), and returning here took that member's price, barcode
   * and tax edits down with a Grundpreis they were not editing. Nothing wrong
   * is written either way; this way nothing right is thrown away.
   */
  let unitPriceRefusal: CommerceWarning | undefined;
  if (params.fields.unitPrice !== undefined) {
    const decision = decideUnitPrice(params.fields.unitPrice);
    if (decision.kind === "invalid") {
      unitPriceRefusal =
        decision.reason === "incomplete"
          ? "unitPriceIncomplete"
          : decision.reason === "ambiguous"
            ? "unitPriceAmbiguous"
            : decision.reason === "dimension"
              ? "unitPriceDimension"
              : "unitPriceInvalid";
    } else if (decision.kind === "clear") {
      // NOT `null`: measured to be accepted and ignored. See the shared
      // module's header.
      input.unitPriceMeasurement = EMPTY_MEASUREMENT_INPUT;
      wantedMeasurement = null;
    } else {
      input.unitPriceMeasurement = decision.measurement;
      wantedMeasurement = decision.measurement;
    }
  }
  if (params.fields.showUnitPrice !== undefined) {
    input.showUnitPrice = params.fields.showUnitPrice;
  }

  if (Object.keys(input).length <= 1) return unitPriceRefusal;

  try {
    const response = await admin.graphql(
      `#graphql
        mutation updateVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants {
              id
              price
              compareAtPrice
              barcode
              inventoryPolicy
              taxable
              unitPriceMeasurement {
                quantityValue
                quantityUnit
                referenceValue
                referenceUnit
              }
              showUnitPrice
            }
            userErrors { field message }
          }
        }`,
      { variables: { productId: params.productId, variants: [input] } },
    );

    const body = (await response.json()) as {
      data?: {
        productVariantsBulkUpdate?: {
          productVariants?: Array<{
            id?: string;
            price?: string | null;
            compareAtPrice?: string | null;
            barcode?: string | null;
            inventoryPolicy?: string | null;
            taxable?: boolean | null;
            unitPriceMeasurement?: {
              quantityValue?: number | null;
              quantityUnit?: string | null;
              referenceValue?: number | null;
              referenceUnit?: string | null;
            } | null;
            showUnitPrice?: boolean | null;
          }> | null;
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (body.errors?.length) {
      logger.warn("[Commerce] Price schema-level error", {
        context: "Commerce", shop, error: body.errors[0]?.message,
      });
      return "priceFailed";
    }
    const payload = body.data?.productVariantsBulkUpdate;
    if (payload?.userErrors?.length) {
      logger.warn("[Commerce] Price userErrors", {
        context: "Commerce", shop, error: payload.userErrors[0].message,
      });
      return "priceFailed";
    }

    const echoed = payload?.productVariants?.find((v) => v.id === params.variantGid);
    // The echo rule. `userErrors: []` with no variant back is the silent no-op
    // this app has been bitten by on every other write path.
    if (!echoed) return "priceNotConfirmed";
    // Compared as NUMBERS: Shopify answers "9.90" for a sent "9.9", and a
    // string compare would report that identical price as unconfirmed.
    const sameMoney = (sent: unknown, got: string | null | undefined) => {
      if (sent === null) return got === null || got === undefined || got === "";
      return Number(got ?? NaN) === Number(sent);
    };
    /**
     * Confirmed field by field, and the cache written from what SURVIVED.
     *
     * Returning on the first mismatch threw away the mirror of everything
     * Shopify had already stored: a save carrying a new price and a refused
     * display switch left the cached price at its old value while the warning
     * said everything else was saved. Nothing here mirrors an unconfirmed
     * value - the echo is still the only source - but a field the echo DID
     * confirm is no longer punished for its neighbour.
     */
    let failure: CommerceWarning | undefined;
    const refuse = (code: CommerceWarning) => {
      failure ??= code;
    };
    const confirmed: Record<string, unknown> = {};

    if (input.price !== undefined) {
      if (sameMoney(input.price, echoed.price)) {
        if (echoed.price != null) confirmed.price = echoed.price;
      } else refuse("priceNotConfirmed");
    }
    if (input.compareAtPrice !== undefined) {
      if (sameMoney(input.compareAtPrice, echoed.compareAtPrice)) {
        confirmed.compareAtPrice = echoed.compareAtPrice ?? null;
      } else refuse("priceNotConfirmed");
    }
    // The same rule for the two non-money fields. They were sent and mirrored
    // without ever being asked back for, so Shopify accepting the call and
    // storing nothing left the cache — and the merchant — believing a policy
    // that was never applied.
    if (input.barcode !== undefined) {
      if ((echoed.barcode ?? null) === input.barcode) confirmed.barcode = echoed.barcode ?? null;
      else refuse("priceNotConfirmed");
    }
    if (input.inventoryPolicy !== undefined) {
      if (echoed.inventoryPolicy === input.inventoryPolicy) {
        confirmed.inventoryPolicy = echoed.inventoryPolicy ?? null;
      } else refuse("priceNotConfirmed");
    }
    if (input.taxable !== undefined) {
      if (echoed.taxable === input.taxable) confirmed.taxable = echoed.taxable ?? null;
      else refuse("priceNotConfirmed");
    }

    // The Grundpreis has the strictest echo of the lot, because its failure
    // mode is the quiet one: `unitPriceMeasurement: null` is ACCEPTED and
    // ignored, so a removal that reported success is exactly what a merchant
    // would discover from their own storefront weeks later. Nothing is
    // mirrored for it — there is no cache column, the panel reads it live.
    if (input.unitPriceMeasurement !== undefined) {
      const got = echoed.unitPriceMeasurement ?? null;
      const stored = isEmptyMeasurement(got) ? null : got;
      const same =
        wantedMeasurement === null
          ? stored === null
          : !!stored &&
            Number(stored.quantityValue) === wantedMeasurement.quantityValue &&
            stored.quantityUnit === wantedMeasurement.quantityUnit &&
            Number(stored.referenceValue) === wantedMeasurement.referenceValue &&
            stored.referenceUnit === wantedMeasurement.referenceUnit;
      if (!same) refuse("unitPriceNotConfirmed");
    }
    // Its OWN code, and deliberately LAST: a switch that would not move
    // reports only itself, instead of casting doubt on a price that is stored.
    if (input.showUnitPrice !== undefined && echoed.showUnitPrice !== input.showUnitPrice) {
      refuse("unitPriceNotShown");
    }

    // Mirror what Shopify STORED, not what was sent — the same rule the theme
    // path follows for normalised richtext.
    if (Object.keys(confirmed).length > 0) {
      await db.productVariant
        .updateMany({ where: { id: params.variantId, product: { shop } }, data: confirmed as never })
        .catch(() => undefined);
    }

    return failure ?? unitPriceRefusal;
  } catch (error) {
    logger.warn("[Commerce] Price write failed", {
      context: "Commerce", shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return "priceFailed";
  }
}
