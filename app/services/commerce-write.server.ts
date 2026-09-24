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
 * ── That deadline ARRIVED, and this is what it cost ─────────────────────────
 * The note that used to stand here predicted it exactly: `compareQuantity` /
 * `ignoreCompareQuantity` are REMOVED from 2026-04 in favour of
 * `changeFromQuantity`, so the moment the pin moved past it every stock write
 * would fail at the SCHEMA level — a total, silent-looking failure. The pin
 * moved (the deployed `SHOPIFY_API_VERSION`, not the default in
 * `api-version.ts`), nobody came here, and production answered exactly that,
 * MEASURED from the server on 2026-09-21:
 *
 *   Variable $input of type InventorySetQuantitiesInput! was provided invalid
 *   value for ignoreCompareQuantity (Field is not defined on
 *   InventorySetQuantitiesInput), quantities.0.compareQuantity (Field is not
 *   defined on InventoryQuantityInput)
 *
 * Two things that error PROVES, and they are why the fix below is narrow. A
 * variable-coercion error is raised after the document has VALIDATED, so every
 * other part of the call — the mutation, `inventoryAdjustmentGroup`,
 * `changes(quantityNames:)`, `quantityAfterChange`, `userErrors { code }` —
 * exists in that version and is not to be touched. And only the two named
 * fields are wrong, so the entry type is still `InventoryQuantityInput`: this
 * is a RENAME, not a new model.
 *
 * So the document is ASKED FOR rather than assumed: `readInventoryInputShape`
 * introspects both input types once per process and the write is built from
 * the field the schema really has, with the PINNED VERSION
 * (`isApiVersionAtLeast`) as the fallback for a lookup that could not answer.
 * The first cut pinned the version alone and logged the schema only AFTER a
 * rejection — which is right about where the answer lives and wrong about
 * when: the name in that pin is the repo's own recorded research, the removal
 * is what was measured, and a wrong name would have cost the merchant another
 * round of the same silence. Asking first costs one query per process.
 *
 * Both spellings keep the compare-and-swap, and a version that answers with
 * NEITHER is refused (`stockCompareUnsupported`) rather than written blind:
 * dropping the safety property to make a save go through is the one repair
 * this module may never make, and the entry type's real field names are in the
 * log beside the refusal.
 *
 * `@idempotent` is the OTHER half of that rework, and the sentence that used
 * to stand here — "the validation above would have named a missing required
 * directive and did not, so it is not required today" — was wrong about why it
 * was silent. It was silent because the request never got that far: variable
 * coercion refused the input and nothing else was ever reached. Once the input
 * was right, production answered immediately and on BOTH inventory mutations:
 *
 *   The @idempotent directive is required for this mutation but was not
 *   provided.
 *
 * So it is required from 2026-04, and it is read from the schema like
 * everything else here — `readIdempotentDirective` takes its LOCATION (a
 * directive on the operation is a different place in the document from one on
 * the field) and whether it takes a `key`. A directive spelled by hand is
 * refused exactly like a missing one, which is the loop this module has been
 * round twice already. The one lookup answers the two halves SEPARATELY: the
 * compare field has the version pin behind it, the directive has nothing, and
 * `inventoryActivate` needs the directive while using neither input type — so
 * a rename of those types must not take the directive's answer down with it.
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
  WEIGHT_UNITS as SHOPIFY_WEIGHT_UNITS,
  INVENTORY_POLICIES as SHOPIFY_INVENTORY_POLICIES,
} from "../config/shopify-enums.shared";
import {
  EMPTY_MEASUREMENT_INPUT,
  decideUnitPrice,
  isEmptyMeasurement,
  type UnitPriceFieldValues,
} from "./unit-price.shared";
import { randomUUID } from "node:crypto";
import { logger } from "~/utils/logger.server";
import { isApiVersionAtLeast } from "~/utils/api-version";

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
  | "stockCompareUnsupported"
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
 * Asked ONCE per process, and only after a write was refused at the schema
 * level: what do these two input types actually carry on this version?
 *
 * This exists because of how the bug above was found — by a merchant pressing
 * Save, seeing nothing happen, and a log line that named the two fields that
 * were wrong but not the ones that are right. The new name below is the repo's
 * own recorded research rather than a measurement (see the module header), so
 * if it is wrong the same silence would repeat and the next round would start
 * from the same place. It does not: the refusal now answers the question it
 * raises, in the log, with the shop's real schema.
 *
 * Diagnostic only. It never throws, never changes what is returned, and never
 * runs on a healthy write.
 */
/**
 * What this API version's inventory input types actually carry, as read from
 * the schema. Held for the life of the process: it is a property of the
 * version, not of the shop.
 */
interface InventoryInputShape {
  /**
   * The two INPUT types, or `null` where they could not be read.
   *
   * Separate from the directive below because they are separate questions with
   * separate consequences: the compare field has the version pin to fall back
   * on, the directive has nothing — and `inventoryActivate` needs the
   * directive while using neither of these types, so a rename of them must not
   * take its answer down with it.
   */
  inputs: {
    /** The entry field that carries the baseline, or `null` if there is none. */
    compareField: "compareQuantity" | "changeFromQuantity" | null;
    /** Whether the top-level input still has the opt-out switch. */
    sendIgnoreCompareQuantity: boolean;
    /** Every field of the entry input, for the log and for the refusal. */
    entryFields: string[];
  } | null;
  /**
   * `@idempotent`, as this version defines it. `null` inside a directive list
   * that DID answer means the schema has no such directive; the surrounding
   * `null` means the list itself could not be read.
   *
   * Shopify made it REQUIRED on the inventory mutations in the same 2026-04
   * rework, and a call without it is refused before it runs: "The @idempotent
   * directive is required for this mutation but was not provided." Where it
   * SITS and what it TAKES are read from the schema rather than assumed —
   * a directive spelled wrong is refused exactly like a missing one, which is
   * the loop this module has already been round twice.
   */
  directives: { idempotent: IdempotentDirective | null } | null;
}

interface IdempotentDirective {
  /** True ⇒ it belongs on the operation, false ⇒ on the field. */
  onMutation: boolean;
  takesKey: boolean;
}

let inventoryInputShape: InventoryInputShape | null = null;

/**
 * The `@idempotent` definition this version carries, read from the schema.
 *
 * Two things are read rather than assumed, because getting either wrong is
 * refused exactly like sending nothing: WHERE it may sit (GraphQL directives
 * declare their locations, and `MUTATION` — the operation — is a different
 * place in the document from `FIELD`), and whether it takes a `key`.
 */
function readIdempotentDirective(
  directives: Array<{ name?: string; locations?: string[] | null; args?: Array<{ name?: string }> | null }>,
): IdempotentDirective | null {
  const found = directives.find((directive) => directive?.name === "idempotent");
  if (!found) return null;
  const locations = found.locations ?? [];
  // An EXECUTABLE location or nothing. A directive declared only where a
  // schema is defined (`FIELD_DEFINITION` and its siblings) cannot be written
  // into a query at all: doing it anyway fails document validation — `data:
  // null`, no `userErrors`, every stock write refused — which is the silence
  // this module exists to end, re-created by the lookup meant to end it.
  if (!locations.includes("MUTATION") && !locations.includes("FIELD")) return null;
  return {
    onMutation: locations.includes("MUTATION"),
    takesKey: (found.args ?? []).some((arg) => arg?.name === "key"),
  };
}

/**
 * Where the directive goes in the document, and with what. PURE.
 *
 * The KEY is per DOCUMENT and travels inside the query string, so a transport
 * that re-sends the same string sends the same key — which is what the
 * directive is for. Two separate saves are two operations and get two keys.
 *
 * `null` — absent, or a list that could not be read — puts nothing in either
 * slot: a directive spelled on a hunch is refused exactly like a missing one,
 * so the mutation goes as it did before and the log above says why.
 */
function idempotentSlots(directive: IdempotentDirective | null): { operation: string; field: string } {
  if (!directive) return { operation: "", field: "" };
  const text = directive.takesKey ? ` @idempotent(key: "${randomUUID()}")` : " @idempotent";
  return directive.onMutation ? { operation: text, field: "" } : { operation: "", field: text };
}

/**
 * The directive slots for a caller that has no shape in hand of its own.
 *
 * `inventoryActivate` is the one: it needs `@idempotent` and uses NEITHER
 * inventory input type, so it asks here rather than reading a shape it has no
 * other use for. A caller that already holds the shape (the stock write below)
 * passes its own `directives` to `idempotentSlots` instead, or one save pays
 * for two lookups and logs the failure twice.
 */
export async function inventoryIdempotency(
  admin: AdminApiContext,
  shop: string,
): Promise<{ operation: string; field: string }> {
  return idempotentSlots((await readInventoryInputShape(admin, shop))?.directives?.idempotent ?? null);
}

/**
 * Forgets the memoised answer. For tests, and for nothing else.
 *
 * Production memoises only a DEFINITE answer, for an hour's worth of saves or
 * for the life of the process: the shape is a property of the API version, not
 * of the shop. A lookup that FAILED is never memoised — the same rule
 * `taxonomy-values.server.ts` follows, because one throttled minute must not
 * become a process-lifetime "we do not know".
 */
export function resetInventoryInputShapeProbe(): void {
  inventoryInputShape = null;
}

/**
 * Asks the SCHEMA which spelling of the comparison this version has.
 *
 * The version pin below encodes what Shopify changed in 2026-04, and it is
 * only as good as the NAME in it — which is recorded research rather than
 * something that could be verified from where the fix was written. Asking the
 * server removes that last guess: the answer is in the schema, the schema is
 * one query away, and the alternative is another silent no-op that the
 * merchant discovers instead of us.
 *
 * It is the DECISION, not a diagnostic: it runs before the write rather than
 * after a rejection, once per process, and its result picks the document. An
 * unanswered lookup is not a verdict — the version pin then decides, which is
 * exactly the behaviour this replaces.
 */
async function readInventoryInputShape(
  admin: AdminApiContext,
  shop: string,
): Promise<InventoryInputShape | null> {
  if (inventoryInputShape) return inventoryInputShape;
  try {
    const response = await admin.graphql(
      `#graphql
        query commerceInventoryInputShape {
          setInput: __type(name: "InventorySetQuantitiesInput") { inputFields { name } }
          entryInput: __type(name: "InventoryQuantityInput") { inputFields { name } }
          schema: __schema { directives { name locations args { name } } }
        }`,
    );
    const body = (await response.json()) as {
      data?: {
        setInput?: { inputFields?: Array<{ name?: string }> | null } | null;
        entryInput?: { inputFields?: Array<{ name?: string }> | null } | null;
        schema?: {
          directives?: Array<{
            name?: string;
            locations?: string[] | null;
            args?: Array<{ name?: string }> | null;
          }> | null;
        } | null;
      };
    };
    const names = (input: { inputFields?: Array<{ name?: string }> | null } | null | undefined): string[] =>
      (input?.inputFields ?? [])
        .map((field) => field?.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0);

    const setFields = names(body.data?.setInput);
    const entryFields = names(body.data?.entryInput);

    // The DIRECTIVE half is decided first and on its own evidence. It has no
    // version pin to fall back on — a mutation that needs `@idempotent` and is
    // sent without it is refused before it runs — and `inventoryActivate`
    // needs it while using neither input type below, so letting a rename of
    // those types discard this answer would take a write down that has nothing
    // to do with them. A directive LIST that came back empty is "we could not
    // read it" (introspection off, throttled, a schema-level error) and stays
    // `null`; a list that answered without `idempotent` in it is a definite
    // "this version has none".
    const directiveList = body.data?.schema?.directives ?? null;
    const directives = directiveList && directiveList.length > 0
      ? { idempotent: readIdempotentDirective(directiveList) }
      : null;

    // BOTH input lists, or that half is not an answer. `__type` returns null
    // rather than an error for a name this version does not have, and
    // introspection can be switched off or throttled — so an empty list is "we
    // could not read it", never "the field is gone". Requiring both is the
    // half that is easy to miss and expensive to get wrong: with only the
    // entry type answering, `ignoreCompareQuantity` would read as REMOVED and
    // be omitted while the old `compareQuantity` is sent — and on a version
    // that still has the switch, omitting it is precisely the silent overwrite
    // this whole module is built to refuse. Falling back to the pin sends the
    // pair that belongs together.
    const inputsAnswered = entryFields.length > 0 && setFields.length > 0;
    if (!inputsAnswered) {
      logger.warn("[Commerce] Inventory input shape not answered", {
        context: "Commerce",
        shop,
        InventorySetQuantitiesInput: setFields.join(", ") || "none",
        InventoryQuantityInput: entryFields.join(", ") || "none",
        // Named rather than dropped: "introspection is off" and "the query was
        // throttled" are different problems and look identical without it.
        error: (body as { errors?: Array<{ message?: string }> }).errors?.[0]?.message,
      });
    }

    const shape: InventoryInputShape = {
      inputs: inputsAnswered
        ? {
            // Order matters only in that BOTH are checked: a version carrying
            // the old name keeps it, and the new one is used where the old is
            // gone.
            compareField: entryFields.includes("compareQuantity")
              ? "compareQuantity"
              : entryFields.includes("changeFromQuantity")
                ? "changeFromQuantity"
                : null,
            sendIgnoreCompareQuantity: setFields.includes("ignoreCompareQuantity"),
            entryFields,
          }
        : null,
      directives,
    };
    // Logged ONCE, at info: this is the fact that was missing while every
    // stock save failed, and it belongs in the deploy log whether or not
    // anything is wrong with it.
    logger.info("[Commerce] Inventory input shape", {
      context: "Commerce",
      shop,
      compareField: shape.inputs?.compareField ?? "none",
      ignoreCompareQuantity: shape.inputs?.sendIgnoreCompareQuantity ?? "unknown",
      idempotent: directives
        ? directives.idempotent
          ? `${directives.idempotent.onMutation ? "on mutation" : "on field"}${directives.idempotent.takesKey ? ", takes key" : ""}`
          : "absent"
        : "unknown",
      InventorySetQuantitiesInput: setFields.join(", ") || "none",
      InventoryQuantityInput: entryFields.join(", ") || "none",
    });
    // Memoised only where BOTH halves are definite: a comparison field was
    // found AND the directive list answered. A `null` compareField refuses
    // every stock save of this process without asking again, and a missing
    // directive answer refuses every inventory mutation of it — so one odd
    // answer would become a standing outage. The shop it would really apply to
    // writes nothing either way, which makes re-asking the cheap direction.
    if (shape.inputs?.compareField && shape.directives) inventoryInputShape = shape;
    return shape;
  } catch (error) {
    logger.warn("[Commerce] Inventory input shape could not be read", {
      context: "Commerce", shop, error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The version from which `compareQuantity` / `ignoreCompareQuantity` are gone
 * and `changeFromQuantity` carries the same meaning. See the module header:
 * the removal is measured from the server, the new name is recorded research.
 */
const INVENTORY_COMPARE_RENAMED_IN = "2026-04" as const;

/**
 * Does this `userErrors` code mean "the quantity moved under you"?
 *
 * `STALE` and nothing else. The first cut also accepted any code NAMING the
 * comparison, which reads as tolerant and is the opposite: a
 * `COMPARE_QUANTITY_REQUIRED` — the shape of complaint this whole change is
 * about — would then be reported to the merchant as "the stock changed
 * meanwhile", sending them into a reload-and-retry loop over a request that
 * will be refused identically every time, with the real defect hidden behind
 * a sentence about somebody else's order.
 */
function isStaleCompareCode(code: string | null | undefined): boolean {
  return typeof code === "string" && code.toUpperCase().includes("STALE");
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
  /**
   * Which spelling of the compare-and-swap this version has — ASKED, with the
   * version pin as the fallback for a lookup that could not answer.
   */
  const measured = await readInventoryInputShape(admin, shop);
  const inputs = measured?.inputs ?? null;
  const pinnedUsesChangeFrom = isApiVersionAtLeast(INVENTORY_COMPARE_RENAMED_IN);
  const compareField: "compareQuantity" | "changeFromQuantity" | null = inputs
    ? inputs.compareField
    : pinnedUsesChangeFrom
      ? "changeFromQuantity"
      : "compareQuantity";
  const sendIgnoreCompareQuantity = inputs
    ? inputs.sendIgnoreCompareQuantity
    : !pinnedUsesChangeFrom;

  // No baseline field at all, on a version that answered. Refusing is the only
  // move left: a quantity written with nothing to compare against overwrites
  // whatever happened between the page load and the click, which is the one
  // failure this module exists to prevent and the one it may never trade away
  // to make a save go through. The entry type's real fields are in the log
  // above, so a name nobody here has seen is a one-line fix rather than
  // another round of guessing.
  if (!compareField) {
    logger.warn("[Commerce] Inventory input has no comparison field", {
      context: "Commerce", shop, InventoryQuantityInput: inputs?.entryFields.join(", ") || "unknown",
    });
    return "stockCompareUnsupported";
  }

  // Required from 2026-04, and refused before execution without it. Read from
  // the schema, not spelled by hand — and taken from the shape ALREADY in
  // hand, because asking again is a second round trip and a second warn line
  // for one save.
  const idempotent = idempotentSlots(measured?.directives?.idempotent ?? null);

  try {
    const response = await admin.graphql(
      `#graphql
        mutation setOnHandQuantities($input: InventorySetQuantitiesInput!)${idempotent.operation} {
          inventorySetQuantities(input: $input)${idempotent.field} {
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
            // The safety property, under whichever name this version has it.
            // Where the opt-out switch still exists it is sent explicitly,
            // because its default is the silent overwrite; where it is gone,
            // sending the baseline IS the request to compare.
            ...(sendIgnoreCompareQuantity ? { ignoreCompareQuantity: false } : {}),
            quantities: params.changes.map((change) => ({
              inventoryItemId: change.inventoryItemId,
              locationId: change.locationId,
              quantity: change.quantity,
              [compareField]: change.compareQuantity,
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
      // The shape this version wanted was already read BEFORE the write and
      // logged there, so a rejection here is no longer a question about the
      // schema — it names something else.
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
      // The exact member is the one measured on 2025-10. The rename above
      // moved the FIELD, and Shopify may have moved this code with it — so a
      // code that merely NAMES the situation counts too. Nothing about the
      // write hangs on this: it picks which sentence the merchant reads, and
      // guessing wrong costs a less specific one, never a wrong quantity.
      return isStaleCompareCode(first.code) ? "stockChangedMeanwhile" : "stockFailed";
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

  const runBatch = async (
    mutation: "publishablePublish" | "publishableUnpublish",
    publicationIds: string[],
  ): Promise<{ ok: boolean; confirmed: Set<string>; refusedPerId?: boolean }> => {
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
      // The ONE failure that is worth isolating: Shopify looked at the input
      // and declined part of it. A schema error or a throttle is about the
      // call, not about any single publication.
      return { ok: false, confirmed: new Set(), refusedPerId: true };
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

  /**
   * One refused publication must not take the others down with it.
   *
   * `publishablePublish` is atomic over its input: a single id Shopify
   * declines fails the whole call, and the merchant is told none of their
   * channel changes landed. That became reachable the moment the picker
   * started offering every publication the SHOP has rather than only the ones
   * the product already had a record in — a channel a product is not eligible
   * for is exactly the id Shopify declines.
   *
   * So a failed batch is retried one id at a time. Safe to retry, because both
   * verbs are no-ops on a resource already in the target state; the batch is
   * kept as the fast path because it is one call for the normal case.
   */
  const run = async (
    mutation: "publishablePublish" | "publishableUnpublish",
    publicationIds: string[],
  ): Promise<{ ok: boolean; confirmed: Set<string> }> => {
    const batch = await runBatch(mutation, publicationIds);
    // Only a per-input refusal is isolated. A THROTTLED batch arrives as a
    // top-level `errors` array, and retrying it once per id would turn one
    // exhausted cost bucket into N more mutations — half of which may land as
    // the bucket refills, leaving a half-applied change reported as the
    // softer "not confirmed".
    if (batch.ok || !batch.refusedPerId || publicationIds.length < 2) return batch;

    logger.warn("[Commerce] Channel batch refused per input — isolating", {
      context: "Commerce", shop, mutation, count: publicationIds.length,
    });
    const confirmed = new Set<string>();
    let anyOk = false;
    for (const publicationId of publicationIds) {
      const single = await runBatch(mutation, [publicationId]);
      if (single.ok) anyOk = true;
      for (const id of single.confirmed) confirmed.add(id);
    }
    // `ok` means "the call worked", not "everything landed" — an id that is
    // still missing from `confirmed` is reported as unconfirmed by the caller,
    // which is the honest outcome for a publication Shopify declined.
    return { ok: anyOk, confirmed };
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

/** Shopify's `WeightUnit` enum. A bad enum fails at the SCHEMA level. The
 *  vocabulary lives in the import-free leaf module, because the bulk grid
 *  offers the same values in a dropdown and the two must not drift. */
const WEIGHT_UNITS = new Set<string>(SHOPIFY_WEIGHT_UNITS);

/**
 * A non-negative decimal, or null.
 *
 * Money and weight are the two places in this module where a comma is as
 * likely as a dot — the merchant types what their keyboard and locale give
 * them, and this app already learned that lesson on the price field.
 *
 * A missing digit on either side of the separator is what people type too —
 * ".1" for a tenth of a kilo, "2." — and neither is ambiguous, so both are
 * completed ("0.1", "2") rather than refused. Refusing ".1" cost the whole
 * InventoryItem write, because `inventoryItemUpdate` applies as a unit.
 */
export function parseDecimal(value: string): string | null {
  const trimmed = value.trim().replace(",", ".");
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  if (whole === "" && fraction === "") return null;
  return fraction === "" ? whole : `${whole || "0"}.${fraction}`;
}

/**
 * A customs tariff (HS) code as Shopify stores it: 6 to 13 DIGITS and nothing
 * else ("Harmonized system code must be a number between six and thirteen
 * digits"). Merchants copy them out of tariff tables, where they are printed
 * grouped — "4420.90.00", "6109 10 00", "8471-30" — so the separators are
 * removed rather than refused; the digits are the code. Returns "" for an
 * empty value (= clear it) and null for anything that is still not a code
 * afterwards, which is refused BEFORE the mutation: `inventoryItemUpdate`
 * applies as a unit, so Shopify's refusal would take every other item field
 * of that variant with it.
 */
export function parseHsCode(value: string): string | null {
  const digits = value.replace(/[\s.\-]/g, "");
  if (digits === "") return "";
  return /^\d{6,13}$/.test(digits) ? digits : null;
}

/** A two-letter ISO country code, uppercased, or null. */
export function parseCountryCode(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * Anything that speaks Admin GraphQL.
 *
 * The single editor hands in Shopify's `AdminApiContext`; the bulk editor
 * hands in its `ShopifyApiGateway`, whose queue and THROTTLED retry it must
 * not bypass on a save that can carry hundreds of rows. Both satisfy this
 * shape, which is the whole point — ONE InventoryItem write path, reached from
 * two surfaces, rather than a second copy of the mutation and the echo rule in
 * apply.server.ts.
 */
export interface CommerceGraphqlClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<{ json: () => Promise<any> }>;
}

/**
 * What an InventoryItem write did.
 *
 * Richer than the `CommerceWarning` the single editor's panel needs, for the
 * bulk grid's sake: it marks failures per CELL, so it has to know WHICH field
 * was refused and WHAT Shopify said. The panel keeps its code — it renders one
 * sentence from `t.content.commerceWarnings` in three languages, and a raw
 * Shopify string is not that.
 */
export type InventoryItemWriteResult =
  | { ok: true }
  | {
      ok: false;
      warning: CommerceWarning;
      /** The `InventoryItemFields` key this app refused before sending. Absent
       *  when Shopify refused the call as a whole. */
      field?: keyof InventoryItemFields;
      /** Shopify's own words, where there are any. */
      message?: string;
    };

export async function writeInventoryItemFields(
  admin: CommerceGraphqlClient,
  db: PrismaClient,
  shop: string,
  params: { variantId: string; inventoryItemId: string; fields: InventoryItemFields },
): Promise<InventoryItemWriteResult> {
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
      if (!parsed.ok || !parsed.value) {
        return { ok: false, warning: "itemFieldsInvalid", field: "cost" };
      }
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
    if (value === null || !WEIGHT_UNITS.has(unit)) {
      return { ok: false, warning: "itemFieldsInvalid", field: "weight" };
    }
    input.measurement = { weight: { value: Number(value), unit } };
    mirror.weight = value;
    mirror.weightUnit = unit;
  }
  if (params.fields.harmonizedSystemCode !== undefined) {
    const code = parseHsCode(params.fields.harmonizedSystemCode);
    if (code === null) {
      return { ok: false, warning: "itemFieldsInvalid", field: "harmonizedSystemCode" };
    }
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
      if (code === null) {
        return { ok: false, warning: "itemFieldsInvalid", field: "countryCodeOfOrigin" };
      }
      input.countryCodeOfOrigin = code;
      mirror.countryCodeOfOrigin = code;
    }
  }

  if (Object.keys(input).length === 0) return { ok: true };

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
      return { ok: false, warning: "itemFieldsFailed", message: body.errors[0]?.message };
    }
    const payload = body.data?.inventoryItemUpdate;
    if (payload?.userErrors?.length) {
      logger.warn("[Commerce] Item fields userErrors", {
        context: "Commerce", shop, error: payload.userErrors[0].message,
      });
      return { ok: false, warning: "itemFieldsFailed", message: payload.userErrors[0].message };
    }
    const item = payload?.inventoryItem;
    if (!item?.id) return { ok: false, warning: "itemFieldsNotConfirmed" };
    // `tracked` decides whether stock exists at all, so a write Shopify
    // accepted and did not apply must not read as success.
    if ("inventoryTracked" in mirror && item.tracked !== mirror.inventoryTracked) {
      return { ok: false, warning: "itemFieldsNotConfirmed", field: "tracked" };
    }
    if ("sku" in mirror && (item.sku ?? null) !== mirror.sku) {
      return { ok: false, warning: "itemFieldsNotConfirmed", field: "sku" };
    }

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
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[Commerce] Item field write failed", { context: "Commerce", shop, error: message });
    return { ok: false, warning: "itemFieldsFailed", message };
  }
}

/**
 * The single editor's view of the write above: one warning CODE or nothing.
 *
 * The panel renders a sentence from `t.content.commerceWarnings` in three
 * languages, so a raw Shopify string is no use to it — and it never marks
 * individual fields, because it saves the whole card at once. Kept as a thin
 * wrapper rather than as a second implementation.
 */
export async function applyInventoryItemFields(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  params: { variantId: string; inventoryItemId: string; fields: InventoryItemFields },
): Promise<CommerceWarning | undefined> {
  const result = await writeInventoryItemFields(admin, db, shop, params);
  return result.ok ? undefined : result.warning;
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

/** Shopify's `ProductVariantInventoryPolicy` — same single-source rule as the
 *  weight units above. */
const INVENTORY_POLICIES = new Set<string>(SHOPIFY_INVENTORY_POLICIES);

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
   * `parseDecimal` folds one comma and accepts any plain decimal,
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
