/**
 * Adding, deleting and reordering product OPTIONS.
 *
 * Until now this app could only RENAME an option and its existing values
 * (`optionValuesToUpdate`), which is the one operation with no consequences.
 * Everything in this module changes the variant matrix, and that is the whole
 * reason it exists as its own file with its own rules:
 *
 *   add a value      -> Shopify creates the new combinations as variants
 *                      (`variantStrategy: MANAGE`). A red shirt in three sizes
 *                      is three new variants, priced 0 until the merchant says
 *                      otherwise. LEAVE_AS_IS would leave a value nobody can
 *                      order, which is not what "we now also sell red" means.
 *   delete a value   -> the variants that used it are DELETED, with their
 *                      stock, prices, SKUs and image assignments. Irreversible.
 *                      The caller counts them first (`countVariantsPerValue`)
 *                      so the confirmation can name the number.
 *   delete an option -> the matrix collapses onto the remaining options.
 *   reorder          -> order only. It cannot lose a variant, which is why it
 *                      is the one operation here that needs no warning.
 *
 * -- Two rules every function follows ----------------------------------------
 * 1. The ECHO decides. `userErrors: []` is not success anywhere in this app,
 *    and least of all here: these mutations answer with the product's options,
 *    so the caller gets what Shopify STORED and mirrors that.
 * 2. The mirror follows the echo, never the request. An added value's GID is
 *    assigned by Shopify, and the translation write path addresses values BY
 *    GID -- a mirror built from what was sent would have no id at all.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { PrismaClient } from "@prisma/client";
import { logger } from "~/utils/logger.server";
// Re-exported so server callers keep one import, while the CLIENT can reach
// the same key without pulling Prisma in behind it.
import { variantCountKey } from "./product-options.shared";
export { variantCountKey };
import {
  PRODUCT_OPTION_UPDATE,
  PRODUCT_OPTIONS_CREATE,
  PRODUCT_OPTIONS_DELETE,
  PRODUCT_OPTIONS_REORDER,
} from "~/graphql/content.mutations";

/** What the merchant should be told, as a CODE -- the app ships in three
 *  languages and the client owns all three. */
export type OptionWriteWarning =
  | "optionsNotConfirmed"
  | "optionsFailed"
  | "optionNameEmpty"
  | "optionValueEmpty"
  | "optionLastOne";

/** One option as Shopify echoed it back. */
export interface EchoedOption {
  id: string;
  name: string;
  position: number;
  linkedMetafield?: { namespace?: string | null; key?: string | null } | null;
  optionValues: Array<{ id: string; name: string; linkedMetafieldValue?: string | null }>;
}

interface MutationOutcome {
  warning?: OptionWriteWarning;
  options?: EchoedOption[];
}

/**
 * Runs one of the option mutations and reads the echo.
 *
 * The four mutations answer with the same shape, so the envelope handling --
 * schema-level errors, userErrors, the missing-product echo -- lives here once
 * instead of four times.
 */
async function runOptionMutation(
  admin: AdminApiContext,
  shop: string,
  document: string,
  variables: Record<string, unknown>,
  field: string,
): Promise<MutationOutcome> {
  try {
    const response = await admin.graphql(document, { variables });
    const body = (await response.json()) as {
      data?: Record<
        string,
        | {
            product?: { options?: EchoedOption[] } | null;
            userErrors?: Array<{ message?: string }>;
          }
        | undefined
      >;
      errors?: Array<{ message?: string }>;
    };

    // A schema-level error arrives as a top-level `errors` array with
    // `data: null` and never reaches `userErrors` -- read as "no data" it would
    // look like a successful call that changed nothing.
    if (body.errors?.length) {
      logger.warn("[ProductOptions] schema-level error", {
        context: "ProductOptions", shop, field, error: body.errors[0]?.message,
      });
      return { warning: "optionsFailed" };
    }
    const payload = body.data?.[field];
    if (payload?.userErrors?.length) {
      logger.warn("[ProductOptions] userErrors", {
        context: "ProductOptions", shop, field, error: payload.userErrors[0]?.message,
      });
      return { warning: "optionsFailed" };
    }
    const options = payload?.product?.options;
    // An EMPTY array is not an answer either: Shopify keeps every product on at
    // least one option, so `[]` is a response that did not carry the block.
    // `!options` alone lets it through, and an empty list mirrored as data is a
    // `notIn: []` that matches every row.
    if (!options || options.length === 0) return { warning: "optionsNotConfirmed" };
    return { options };
  } catch (error) {
    logger.warn("[ProductOptions] failed", {
      context: "ProductOptions", shop, field,
      error: error instanceof Error ? error.message : String(error),
    });
    return { warning: "optionsFailed" };
  }
}

/**
 * Mirrors the echoed options into the cache.
 *
 * Values are stored as `[{id, name}]` -- the shape the translation path and the
 * bulk editor both read. The legacy `["string"]` form still parses on the way
 * out, but nothing writes it any more: a value without its GID cannot be
 * renamed or translated.
 */
export async function mirrorOptions(
  db: PrismaClient,
  productId: string,
  options: EchoedOption[],
): Promise<void> {
  // `Product.id` and therefore `ProductOption.productId` hold the GID -- that
  // is what `product-sync.service.ts` writes and what every other reader
  // queries by. Stripping the prefix here made the create branch violate the
  // foreign key (swallowed as "mirror failed", so a created option stayed
  // invisible) and made deleteMany and the caller's remainingCount match
  // nothing at all.
  if (options.length === 0) {
    // An echo with no options is not a product without options: Shopify keeps
    // every product on at least one. Read as data it would wipe the cache of a
    // product whose options are untouched -- the same rule the attribute
    // mappers follow for a narrower response.
    logger.warn("[ProductOptions] empty echo, mirror skipped", {
      context: "ProductOptions", productId,
    });
    return;
  }
  try {
    const keep = options.map((o) => o.id);
    // Deleted options go, and their rows with them -- a stale option row is one
    // the editor would still offer to translate.
    await db.productOption.deleteMany({
      where: { productId, id: { notIn: keep } },
    });
    for (const option of options) {
      // The same shape the sync writes. A mirror that dropped `linked` would
      // make a metaobject-linked option look editable and translatable, which
      // is exactly what the app forbids for one.
      const values = JSON.stringify(
        option.optionValues.map((v) => ({
          id: v.id,
          name: v.name,
          linked: !!v.linkedMetafieldValue,
          linkedValue: v.linkedMetafieldValue || undefined,
        })),
      );
      const linkedMetafieldKey = option.linkedMetafield
        ? `${option.linkedMetafield.namespace}--${option.linkedMetafield.key}`
        : null;
      await db.productOption.upsert({
        where: { id: option.id },
        update: { name: option.name, position: option.position, values, linkedMetafieldKey },
        create: {
          id: option.id,
          productId,
          name: option.name,
          position: option.position,
          values,
          linkedMetafieldKey,
        },
      });
    }
  } catch (error) {
    // A failed mirror is a stale editor, not a failed write -- Shopify already
    // holds the change. The next reload repairs it.
    logger.warn("[ProductOptions] mirror failed", {
      context: "ProductOptions", productId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface OptionValueChange {
  /** Existing values to rename, by GID. */
  toUpdate?: Array<{ id: string; name: string }>;
  /** New value names. Shopify assigns their GIDs. */
  toAdd?: string[];
  /** Value GIDs to remove -- and with them, their variants. */
  toDelete?: string[];
}

/**
 * One option's name and/or values.
 *
 * `variantStrategy` is only sent when the matrix actually changes: a rename
 * needs none, and sending MANAGE for a rename would ask Shopify to reconcile a
 * matrix that did not move.
 */
export async function applyOptionChange(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  params: { productId: string; optionId: string; name?: string; values?: OptionValueChange },
): Promise<OptionWriteWarning | undefined> {
  const option: { id: string; name?: string } = { id: params.optionId };
  if (params.name !== undefined) {
    const name = params.name.trim();
    if (!name) return "optionNameEmpty";
    option.name = name;
  }

  const requestedAdds = params.values?.toAdd ?? [];
  const toAdd = requestedAdds.map((n) => n.trim()).filter(Boolean);
  // A requested add that is blank is REPORTED, not quietly dropped: filtering
  // it away could empty the request entirely, and the "nothing to do" return
  // below would then answer a lost edit with success.
  if (toAdd.length !== requestedAdds.length) return "optionValueEmpty";
  const toDelete = params.values?.toDelete ?? [];
  const toUpdate = (params.values?.toUpdate ?? []).map((v) => ({ id: v.id, name: v.name.trim() }));
  if (toUpdate.some((v) => !v.name)) return "optionValueEmpty";

  const changesMatrix = toAdd.length > 0 || toDelete.length > 0;
  const variables: Record<string, unknown> = { productId: params.productId, option };
  if (toUpdate.length > 0) variables.optionValuesToUpdate = toUpdate;
  if (toAdd.length > 0) variables.optionValuesToAdd = toAdd.map((name) => ({ name }));
  if (toDelete.length > 0) variables.optionValuesToDelete = toDelete;
  if (changesMatrix) variables.variantStrategy = "MANAGE";

  // Nothing to do beats a mutation that changes nothing: the caller sends one
  // request per option and most of them are untouched.
  if (params.name === undefined && !changesMatrix && toUpdate.length === 0) return undefined;

  const outcome = await runOptionMutation(admin, shop, PRODUCT_OPTION_UPDATE, variables, "productOptionUpdate");
  if (outcome.warning) return outcome.warning;
  await mirrorOptions(db, params.productId, outcome.options ?? []);
  return undefined;
}

/** A brand-new option, with at least one value -- Shopify rejects one without. */
export async function createOption(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  params: { productId: string; name: string; values: string[] },
): Promise<OptionWriteWarning | undefined> {
  const name = params.name.trim();
  if (!name) return "optionNameEmpty";
  const values = params.values.map((v) => v.trim()).filter(Boolean);
  if (values.length === 0) return "optionValueEmpty";

  const outcome = await runOptionMutation(
    admin,
    shop,
    PRODUCT_OPTIONS_CREATE,
    { productId: params.productId, options: [{ name, values: values.map((v) => ({ name: v })) }] },
    "productOptionsCreate",
  );
  if (outcome.warning) return outcome.warning;
  await mirrorOptions(db, params.productId, outcome.options ?? []);
  return undefined;
}

/**
 * Removes a whole option.
 *
 * Refused when it is the LAST one: Shopify keeps every product on at least one
 * option, and the mutation's rejection would arrive as a generic failure that
 * says nothing about why.
 */
export async function deleteOption(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  params: { productId: string; optionId: string; remainingCount: number },
): Promise<OptionWriteWarning | undefined> {
  if (params.remainingCount <= 1) return "optionLastOne";

  const outcome = await runOptionMutation(
    admin,
    shop,
    PRODUCT_OPTIONS_DELETE,
    { productId: params.productId, options: [params.optionId] },
    "productOptionsDelete",
  );
  if (outcome.warning) return outcome.warning;
  await mirrorOptions(db, params.productId, outcome.options ?? []);
  return undefined;
}

/** Order only -- the one operation here that cannot lose a variant. */
export async function reorderOptions(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  params: { productId: string; orderedIds: string[] },
): Promise<OptionWriteWarning | undefined> {
  const outcome = await runOptionMutation(
    admin,
    shop,
    PRODUCT_OPTIONS_REORDER,
    {
      productId: params.productId,
      // Shopify counts positions from 1.
      options: params.orderedIds.map((id, index) => ({ id, position: index + 1 })),
    },
    "productOptionsReorder",
  );
  if (outcome.warning) return outcome.warning;
  await mirrorOptions(db, params.productId, outcome.options ?? []);
  return undefined;
}

/**
 * How many variants use each option value, live from Shopify.
 *
 * Not from the cache: `ProductVariant` stores a display `title` ("Red / S") and
 * nothing about which VALUE produced which segment. Splitting that title would
 * be a guess, and this number is the one a merchant decides an irreversible
 * delete on -- so it is read from the source, once, when the card is opened.
 *
 * Keyed by option NAME plus value name, because `selectedOptions` reports names
 * rather than GIDs. Returns an empty map on any failure: the confirmation then
 * says it could not count, which is honest, rather than showing a zero.
 */
export async function countVariantsPerValue(
  admin: AdminApiContext,
  shop: string,
  productId: string,
): Promise<Record<string, number>> {
  try {
    const counts: Record<string, number> = {};
    let cursor: string | null = null;
    // Shopify allows up to 2048 variants per product, so this terminates well
    // inside the bound. It PAGES rather than taking the first 250: an
    // undercount is the quiet version of the zero this function refuses to
    // report, and it would be read as "fewer variants at stake than there are".
    for (let page = 0; page < 10; page++) {
      const response: Response = await admin.graphql(
        `#graphql
          query productOptionVariantCounts($id: ID!, $after: String) {
            product(id: $id) {
              variants(first: 250, after: $after) {
                nodes { selectedOptions { name value } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }`,
        { variables: { id: productId, after: cursor } },
      );
      const body = (await response.json()) as {
        data?: {
          product?: {
            variants?: {
              nodes?: Array<{ selectedOptions?: Array<{ name: string; value: string }> }>;
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            };
          };
        };
      };
      const variants = body.data?.product?.variants;
      for (const variant of variants?.nodes ?? []) {
        for (const selected of variant.selectedOptions ?? []) {
          const key = variantCountKey(selected.name, selected.value);
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
      if (!variants?.pageInfo?.hasNextPage || !variants.pageInfo.endCursor) break;
      cursor = variants.pageInfo.endCursor;
    }
    return counts;
  } catch (error) {
    logger.warn("[ProductOptions] variant count failed", {
      context: "ProductOptions", shop, productId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}
