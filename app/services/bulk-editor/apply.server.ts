/**
 * Bulk editor — diff persistence (docs/plans/PLAN_BULK_EDITOR.md §3/§4).
 *
 * Applies a diff-only payload to Shopify + the DB content cache. Since
 * Phase 2 a product row is no longer "one row = one mutation": its dirty
 * cells split into TARGET GROUPS, persisted in a fixed order (§4.4) so
 * partial failures stay traceable:
 *
 *   1. productUpdate           — base fields (incl. the partial-SEO guard)
 *   2. metafieldsSet           — ALL dirty metafields of the product in one
 *                                call, chunked at 25 (§14: upsert semantics,
 *                                type always sent); clearing a cell goes
 *                                through metafieldsDelete instead (§14 no. 4
 *                                — metafieldsSet with "" is rejected)
 *   3. productOptionUpdate     — one call per dirty option (API-shaped)
 *   4. productUpdateMedia      — main-image alt-text (§14 no. 3)
 *
 * Failures are per CELL (BulkFailure.columnId): one failed target group never
 * aborts the row's other groups, and a failed row never aborts the batch.
 * Collection/page/article rows stay single-mutation → their failures stay
 * row-level (no columnId).
 *
 * Server-only: ShopifyApiGateway drags logger.server into the bundle. The
 * pure pieces (computeDiff, groupDiffByRow, descriptors, cell resolution)
 * live in columns.shared.ts, which is client-safe.
 */

import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { ShopifyApiGateway } from "../shopify-api-gateway.service";
import { ShopifyContentService } from "../../../src/services/shopify-content.service";
import {
  METAFIELDS_SET,
  METAFIELDS_DELETE,
  PRODUCT_OPTION_UPDATE,
  METAOBJECT_UPDATE,
} from "../../graphql/content.mutations";
import { debugLog } from "../../utils/debug";
import { markTranslationSaved } from "../../utils/translation-save-lock.server";
import {
  loadDigestsForRows,
  fetchDigestsForResource,
  registerAndVerify,
  removeAndVerify,
  removeAndVerifyAcrossLocales,
  LOCALE_KEY_SEP,
  translationKeyForColumn,
  CONTENT_RESOURCE_TYPE_BY_ROW_TYPE,
  isSubResourceColumn,
  subResourceTargetsForColumn,
  loadProductSubResourceCaches,
  EMPTY_SUB_RESOURCE_CACHE,
  type ProductSubResourceCache,
  type SubResourceTarget,
  type TranslationInput,
} from "./translations.server";
import { logger } from "../../utils/logger.server";
import { redirectResourceFor, wasEverLive, type RedirectableResource } from "../seo/handle-redirect.shared";
// The single editor parses tags with exactly this function — one rule, so the
// two surfaces cannot disagree about what a tag list is.
import { parseTagList } from "../content-attributes.shared";
import {
  groupDiffByRow,
  parseListMetafieldInput,
  parseMoney,
  METAFIELD_TYPE_LIST_SINGLE_LINE,
  METAFIELDS_SET_CHUNK,
  LIST_DISPLAY_SEPARATOR,
  IMAGE_ROW_ALT_COLUMN_ID,
  IMG_ALT_COLUMN_ID,
  isFeaturedImageAltColumn,
  VAR_SKU_COLUMN_ID,
  VAR_PRICE_COLUMN_ID,
  VAR_COMPARE_AT_COLUMN_ID,
  VAR_BARCODE_COLUMN_ID,
  type BulkRowType,
  type BulkDiffEntry,
  type BulkDiffRowGroup,
  type BulkApplyResult,
  type BulkFailure,
  type ColumnDescriptor,
} from "./columns.shared";
import { moneyToDecimalString } from "../product-variant-sync.server";
import { writeMetaobjectFields, type MetaobjectFieldWrite } from "../metaobject-write.server";

interface ApplyContext {
  db: PrismaClient;
  shop: string;
  admin: AdminApiContext;
  /** Server-built column universe (buildServerColumnsByType) — resolves each
   * diff cell to its descriptor (metafield type/namespace/key, option
   * position, …). Both save entrances validated the diff against the SAME
   * object, so an unknown column here is a hard bug, not bad input. */
  columnsByType: Record<BulkRowType, ColumnDescriptor[]>;
  /** Published, non-primary shop locales — the target set for the Phase-4b
   * primary-save stale-translation invalidation. Passed in by the caller
   * (which already has the shop locales) so applyBulkDiff makes no extra
   * fetch; omitted/empty ⇒ invalidation safely no-ops (e.g. in unit tests). */
  foreignLocales?: string[];
  /** PLAN §Phase 3.3 — override the shop's "redirect on handle change" setting.
   *  Omitted ⇒ read from `AISettings` once per run. Tests pass `false` to keep
   *  the write paths free of redirect traffic. */
  autoHandleRedirect?: boolean;
}

/** Settable `ProductStatus` values for `productUpdate`'s `ProductInput`.
 *
 *  UNLISTED is included deliberately: the 2025-10 ProductStatus enum lists it
 *  and the docs name `ProductInput` among the inputs that accept it, so it is a
 *  writable status, not just a readable one. The docs' only restriction —
 *  "can't be changed from unlisted in older versions" — is scoped to
 *  pre-2025-10 versions, where UNLISTED is translated to active and is not part
 *  of the enum. Sources:
 *  https://shopify.dev/docs/api/admin-graphql/2025-10/enums/ProductStatus and
 *  https://shopify.dev/docs/apps/build/product-merchandising/unlisted-products,
 *  which states plainly: "You can query and SET the unlisted status through the
 *  new `unlisted` enum in `ProductStatus`."
 *
 *  The app defaults to 2025-10 but `SHOPIFY_API_VERSION` can pin an older one
 *  (shopify.server.ts), where UNLISTED is not part of the enum. This set is
 *  intentionally NOT version-aware: Shopify then rejects the value as a
 *  SCHEMA-level error, which `persistProductBase` turns into a per-cell
 *  `BulkFailure` via its top-level `data.errors` check. That check is what
 *  makes the non-version-aware set safe — before it existed, such a rejection
 *  resolved as a silent success. Do not remove one without the other.
 *
 *  Keep in sync with the option list in BulkCell.tsx; offering a status the
 *  gate rejects (or gating one the UI never offers) is the failure mode this
 *  pairing exists to avoid. */
const PRODUCT_STATUSES = new Set(["ACTIVE", "DRAFT", "UNLISTED", "ARCHIVED"]);

// Moved to columns.shared.ts (estimateCalls needs it client-side); re-exported
// here so existing imports keep working.
export { METAFIELDS_SET_CHUNK } from "./columns.shared";

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

interface PersistDeps {
  db: PrismaClient;
  shop: string;
  gateway: ShopifyApiGateway;
  contentService: ShopifyContentService;
  columnsByType: Record<BulkRowType, ColumnDescriptor[]>;
  /** Prefetched digests for the run's foreign groups (Plan §6.1):
   * resourceId → key → digest, loaded in ONE batched pass by applyBulkDiff. */
  digests: Map<string, Map<string, string>>;
  /** §6.3 re-fetch bookkeeping: each resource gets at most ONE digest
   * re-fetch per run — after that a still-missing digest is a cell error. */
  digestRefetched: Set<string>;
  /** parentId → its featured image's GID (null = the object has none). The
   * GID is cached nowhere and cannot be derived from the parent, so it is
   * resolved once per row instead of once per (row, locale, market) group. */
  featuredImageIds: Map<string, string | null>;
  /** Published, non-primary shop locales — the target set for the primary-save
   * stale-foreign-translation invalidation (Plan §6.6 / Phase 4b). Loaded once
   * per run; empty when the lookup failed (invalidation then safely no-ops). */
  foreignLocales: string[];
  /** productId → cached metafield/option GIDs, for the foreign groups that
   * write SUB-RESOURCE translations (metafield "value", option/value "name").
   * Loaded in ONE pass by applyBulkDiff, together with their digests. */
  subResourceCaches: Map<string, ProductSubResourceCache>;
  /** Merchant switch (Settings → Übersetzungen): may a changed/cleared PRIMARY
   * value delete its foreign translations at all? Resolved once per run and
   * checked by every §6.6 invalidation entry point; `false` makes them no-op
   * exactly like an empty `foreignLocales`. Fails OPEN — see
   * services/translations/translation-change-policy.server.ts. */
  purgeStaleTranslations: boolean;
  /** PLAN §Phase 3.3 — the shop's "redirect when a handle changes" preference,
   *  read ONCE per run. The setting is shop-level, so it has to hold on this
   *  write path too; the single editor's per-save override has no equivalent
   *  here (a grid has no per-row checkbox). */
  autoHandleRedirect: boolean;
}

function failureOf(group: BulkDiffRowGroup, message: string, columnId?: string): BulkFailure {
  return {
    rowId: group.rowId,
    rowType: group.rowType,
    ...(columnId ? { columnId } : {}),
    // Locale/market of the failed cell (Phase 4) — lets the UI mark the cell
    // in the right language view. Primary groups carry "" / "".
    ...(group.locale !== "" ? { locale: group.locale } : {}),
    ...(group.marketId !== "" ? { marketId: group.marketId } : {}),
    message,
  };
}

// ─── Product row: cell classification ──────────────────────────────────────

interface OptionCells {
  name?: { columnId: string; value: string };
  values?: { columnId: string; value: string };
}

interface ProductCellGroups {
  /** field name → value (field.* columns). */
  base: Record<string, string>;
  baseColumnIds: string[];
  metafields: { columnId: string; column: ColumnDescriptor; value: string }[];
  options: Map<number, OptionCells>;
  imageAlt?: { columnId: string; value: string };
  /** Cells whose column could not be classified — validation rejected these
   * already, so hitting this is a programming error surfaced per cell. */
  failures: BulkFailure[];
}

function classifyProductCells(group: BulkDiffRowGroup, columns: ColumnDescriptor[]): ProductCellGroups {
  const out: ProductCellGroups = {
    base: {},
    baseColumnIds: [],
    metafields: [],
    options: new Map(),
    failures: [],
  };
  for (const [columnId, value] of Object.entries(group.cells)) {
    const column = columns.find((c) => c.id === columnId);
    if (!column || !column.editable) {
      out.failures.push(failureOf(group, `Column "${columnId}" is not editable on ${group.rowType}.`, columnId));
      continue;
    }
    switch (column.kind) {
      case "field":
        out.base[columnId.slice("field.".length)] = value;
        out.baseColumnIds.push(columnId);
        break;
      case "metafield":
        out.metafields.push({ columnId, column, value });
        break;
      case "option": {
        const position = column.optionPosition ?? 0;
        const cells = out.options.get(position) ?? {};
        if (column.optionField === "name") cells.name = { columnId, value };
        else cells.values = { columnId, value };
        out.options.set(position, cells);
        break;
      }
      case "image": {
        if (column.id === IMG_ALT_COLUMN_ID) {
          out.imageAlt = { columnId, value };
        } else {
          // A non-alt image column is never editable.
          out.failures.push(failureOf(group, `Column "${columnId}" is not editable on ${group.rowType}.`, columnId));
        }
        break;
      }
      default:
        out.failures.push(failureOf(group, `Column "${columnId}" is not editable on ${group.rowType}.`, columnId));
    }
  }
  return out;
}

// ─── Primary-save stale-foreign-translation invalidation (Phase 4b) ────────

/**
 * PLAN_BULK_EDITOR §6.6 / Phase 4b: after a PRIMARY translatable field changes,
 * its existing FOREIGN translations are stale — remove them on Shopify AND
 * locally, exactly as the single editor does (updateContent), but through the
 * ECHO-VERIFIED remove path so a silent translationsRemove no-op can never
 * orphan the storefront from the DB (the single editor skips that echo — a
 * documented CLAUDE.md violation this bulk path deliberately does NOT copy).
 *
 * GLOBAL rows only (marketId ""): a market-specific override is a deliberate,
 * separate value, so it survives a primary change — matching the single
 * editor. Metaobjects use MetaobjectTranslation; every other type uses
 * ContentTranslation.
 *
 * BEST-EFFORT: the primary save already succeeded. A failure here logs and
 * leaves the stale rows (the pre-4b behaviour, identical to a direct edit in
 * the Shopify admin) rather than failing the cell.
 */
async function invalidateStaleForeignTranslations(
  deps: PersistDeps,
  rowType: BulkRowType,
  resourceId: string,
  translationKeys: string[],
  /** ContentTranslation.resourceType to match — set for SUB-RESOURCES
   * (Metafield / ProductOption / ProductOptionValue), whose rows are keyed by
   * their own gid, not by the product's. */
  resourceTypeOverride?: string,
): Promise<void> {
  const { db, shop, gateway, foreignLocales } = deps;
  const keys = [...new Set(translationKeys.filter(Boolean))];
  if (!deps.purgeStaleTranslations || keys.length === 0 || foreignLocales.length === 0) return;

  const isMetaobject = rowType === "metaobject" && !resourceTypeOverride;
  const contentResourceType = resourceTypeOverride ?? CONTENT_RESOURCE_TYPE_BY_ROW_TYPE[rowType];

  // Image rows keep their translations in ProductImageAltTranslation — one key
  // ("alt") on one resource, so the generic key/locale bookkeeping below would
  // be pure overhead.
  if (rowType === "image" && !resourceTypeOverride) {
    await invalidateStaleImageAltTranslations(deps, resourceId);
    return;
  }
  try {
    // Which (locale, key) GLOBAL foreign rows actually exist — skip Shopify
    // entirely when there is nothing to invalidate (the common case on shops
    // that never translated this field).
    const existing = isMetaobject
      ? await db.metaobjectTranslation.findMany({
          where: { shop, metaobjectId: resourceId, marketId: "", key: { in: keys }, locale: { in: foreignLocales } },
          select: { key: true, locale: true },
        })
      : await db.contentTranslation.findMany({
          where: {
            shop,
            resourceType: contentResourceType,
            resourceId,
            marketId: "",
            key: { in: keys },
            locale: { in: foreignLocales },
          },
          select: { key: true, locale: true },
        });
    if (existing.length === 0) return;

    const presentLocales = [...new Set(existing.map((e) => e.locale))];
    const presentKeys = [...new Set(existing.map((e) => e.key))];
    const { confirmedPairs } = await removeAndVerifyAcrossLocales(gateway, resourceId, presentKeys, presentLocales, "");
    if (confirmedPairs.size === 0) return;

    // Delete ONLY the rows Shopify confirmed removed, grouped per locale to
    // keep the DB round-trips down.
    const confirmedKeysByLocale = new Map<string, string[]>();
    for (const row of existing) {
      if (!confirmedPairs.has(`${row.locale}${LOCALE_KEY_SEP}${row.key}`)) continue;
      const list = confirmedKeysByLocale.get(row.locale) ?? [];
      list.push(row.key);
      confirmedKeysByLocale.set(row.locale, list);
    }
    for (const [locale, localeKeys] of confirmedKeysByLocale) {
      if (isMetaobject) {
        await db.metaobjectTranslation.deleteMany({
          where: { shop, metaobjectId: resourceId, key: { in: localeKeys }, locale, marketId: "" },
        });
      } else {
        await db.contentTranslation.deleteMany({
          where: {
            shop,
            resourceType: contentResourceType,
            resourceId,
            key: { in: localeKeys },
            locale,
            marketId: "",
          },
        });
      }
    }
  } catch (err: unknown) {
    logger.warn("[BULK] Stale foreign-translation invalidation failed — stale rows kept", {
      context: "Bulk",
      resourceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The image counterpart of invalidateStaleForeignTranslations: a changed
 * PRIMARY alt makes every foreign alt stale. Same rules — echo-verified removal
 * on Shopify first, local rows deleted ONLY for confirmed locales, best-effort
 * (the primary write already succeeded, so a failure here logs and keeps the
 * stale rows rather than failing the cell).
 */
async function invalidateStaleImageAltTranslations(deps: PersistDeps, mediaId: string): Promise<void> {
  const { db, gateway, foreignLocales } = deps;
  if (!deps.purgeStaleTranslations || foreignLocales.length === 0) return;
  try {
    // Two stores, one rule: product media mirror into
    // ProductImageAltTranslation, every other image into
    // ContentTranslation("MediaImage") — the same split the write path applies.
    const cacheId = await imageCacheIdFor(deps, mediaId);
    const existing = cacheId
      ? await db.productImageAltTranslation.findMany({
          where: { imageId: cacheId, marketId: "", locale: { in: foreignLocales } },
          select: { locale: true },
        })
      : await db.contentTranslation.findMany({
          where: {
            shop: deps.shop,
            resourceType: "MediaImage",
            resourceId: mediaId,
            marketId: "",
            locale: { in: foreignLocales },
          },
          select: { locale: true },
        });
    if (existing.length === 0) return;

    const locales = [...new Set(existing.map((e) => e.locale))];
    const { confirmedPairs } = await removeAndVerifyAcrossLocales(gateway, mediaId, ["alt"], locales, "");
    const confirmedLocales = locales.filter((locale) =>
      confirmedPairs.has(`${locale}${LOCALE_KEY_SEP}alt`),
    );
    if (confirmedLocales.length === 0) return;
    if (cacheId) {
      await db.productImageAltTranslation.deleteMany({
        where: { imageId: cacheId, marketId: "", locale: { in: confirmedLocales } },
      });
    } else {
      await db.contentTranslation.deleteMany({
        where: {
          shop: deps.shop,
          resourceType: "MediaImage",
          resourceId: mediaId,
          marketId: "",
          locale: { in: confirmedLocales },
        },
      });
    }
  } catch (err: unknown) {
    logger.warn("[BULK] Stale image-alt invalidation failed — stale rows kept", {
      context: "Bulk",
      resourceId: mediaId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Shopify translation keys of the row's WRITTEN base/field columns that are
 * translatable — the invalidation target for a primary save. */
function translatableKeysForColumnIds(
  deps: PersistDeps,
  rowType: BulkRowType,
  columnIds: string[],
): string[] {
  const columns = deps.columnsByType[rowType];
  return columnIds
    .map((cid) => columns.find((c) => c.id === cid))
    .map((col) => (col ? translationKeyForColumn(col, rowType) : null))
    .filter((k): k is string => !!k);
}

// ─── Product row: stage 1 — base fields via productUpdate ──────────────────

async function persistProductBaseFields(
  group: BulkDiffRowGroup,
  cells: ProductCellGroups,
  deps: PersistDeps,
): Promise<BulkFailure[]> {
  const { db, shop, gateway } = deps;
  const id = group.rowId;
  const failures: BulkFailure[] = [];
  const fields: Partial<Record<string, string>> = { ...cells.base };

  // Per-cell validation: an invalid cell fails ALONE and is dropped from the
  // mutation — the row's remaining base cells still save.
  if (fields.title !== undefined && fields.title.trim() === "") {
    failures.push(failureOf(group, "Title cannot be empty.", "field.title"));
    delete fields.title;
  }
  if (fields.status !== undefined) {
    const s = fields.status.trim().toUpperCase();
    if (!PRODUCT_STATUSES.has(s)) {
      failures.push(
        failureOf(
          group,
          `Invalid status "${fields.status}" — expected ACTIVE, DRAFT, UNLISTED or ARCHIVED.`,
          "field.status",
        ),
      );
      delete fields.status;
    } else {
      fields.status = s;
    }
  }

  // Partial SEO clobber guard: productUpdate treats `seo` as a unit —
  // sending only `title` wipes the existing description (and vice versa).
  // When only one half is dirty, load the untouched half from the DB cache
  // and send it too. See "Partial SEO clobber" in CLAUDE.md. If the cache
  // row cannot be resolved, the SEO write is REJECTED as a cell error
  // (Finding 7) — falling back to "" would be exactly the wipe the guard
  // exists to prevent. A cached row with NULL values is fine: null means
  // "no value set on Shopify", so sending "" changes nothing.
  const partialSeo = (fields.seoTitle !== undefined) !== (fields.seoDescription !== undefined);
  let untouchedSeo: { seoTitle: string | null; seoDescription: string | null } | null = null;
  if (partialSeo) {
    untouchedSeo = await db.product
      .findUnique({
        where: { shop_id: { shop, id } },
        select: { seoTitle: true, seoDescription: true },
      })
      .catch(() => null);
    if (!untouchedSeo) {
      const dirtyHalf = fields.seoTitle !== undefined ? "field.seoTitle" : "field.seoDescription";
      failures.push(
        failureOf(
          group,
          "The untouched SEO value could not be loaded from the local cache — resync this product, then save the SEO change. (Sending only one half would wipe the other on Shopify.)",
          dirtyHalf,
        ),
      );
      delete fields.seoTitle;
      delete fields.seoDescription;
    }
  }

  const remainingColumnIds = cells.baseColumnIds.filter(
    (columnId) => fields[columnId.slice("field.".length)] !== undefined,
  );
  if (remainingColumnIds.length === 0) return failures;

  // §Phase 3.3 — read the old handle before productUpdate replaces it.
  const capturedHandle = await captureHandleForRedirect(group, fields.handle, deps);

  try {
    // Minimal partial productUpdate — only the fields that changed are sent,
    // so everything else is left untouched by Shopify (omitted GraphQL input
    // fields = "no change").
    const input: Record<string, unknown> = { id };
    if (fields.title !== undefined) input.title = fields.title;
    if (fields.handle !== undefined) input.handle = fields.handle;
    if (fields.descriptionHtml !== undefined) input.descriptionHtml = fields.descriptionHtml;
    if (fields.productType !== undefined) input.productType = fields.productType;
    if (fields.status !== undefined) input.status = fields.status;
    // §Phase 3.6. `tags` goes through the SAME parser as the single editor —
    // trimmed, empties dropped, case-insensitively de-duplicated — because
    // Shopify stores them that way and a grid cell full of stray commas would
    // otherwise report a change on every subsequent save.
    if (fields.vendor !== undefined) input.vendor = fields.vendor;
    if (fields.tags !== undefined) input.tags = parseTagList(fields.tags);
    if (fields.seoTitle !== undefined || fields.seoDescription !== undefined) {
      input.seo = {
        title: fields.seoTitle !== undefined ? fields.seoTitle : untouchedSeo?.seoTitle ?? "",
        description:
          fields.seoDescription !== undefined ? fields.seoDescription : untouchedSeo?.seoDescription ?? "",
      };
    }
    // `product { id handle tags }` is the echo the mirror and the redirect
    // read. Shopify normalises both of these — tags are trimmed and
    // case-collapsed, and a handle is slugified ("Summer Sale" is stored as
    // "summer-sale") — so the value this app SENT is not the value the shop
    // holds. Mirroring or redirecting to the sent one records a handle that
    // does not exist, and (per §Phase 3.3) a redirect onto a live page's own
    // path makes that page unreachable.
    //
    // The prose stays out here on purpose: a `#` comment inside the document
    // travels to Shopify (see the GraphQL-comment gotcha in CLAUDE.md).
    const response = await gateway.graphql(
      `#graphql
        mutation seoBulkMetaProductUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id handle tags }
            userErrors { field message }
          }
        }`,
      { variables: { input } },
    );
    const data = (await response.json()) as {
      data?: {
        productUpdate?: {
          product?: { id: string; handle?: string; tags?: string[] } | null;
          userErrors?: { field?: string[] | string; message: string }[];
        };
      };
      errors?: { message?: string }[];
    };
    // A SCHEMA-level GraphQL error (unknown enum value, wrong variable type)
    // comes back as HTTP 200 with a top-level `errors` array and `data: null`
    // — it never reaches `userErrors`. ShopifyApiGateway deliberately
    // logs-and-continues on non-throttle GraphQL errors and still resolves
    // `{ ok: true }`, so without this check the mutation reads as a success:
    // the DB cache below would be written with a value Shopify never stored,
    // and `invalidateStaleForeignTranslations` would delete foreign
    // translations for a primary change that never landed. That is exactly the
    // false-success pattern CLAUDE.md exists to prevent. Reachable in practice
    // via `status`: it is the only base field whose value can be invalid at the
    // schema level (e.g. UNLISTED against a pre-2025-10 `SHOPIFY_API_VERSION`).
    const gqlErrors = data.errors ?? [];
    if (gqlErrors.length > 0) throw new Error(gqlErrors[0]?.message || "GraphQL error");
    if (!data.data?.productUpdate) throw new Error("productUpdate returned no payload");
    const userErrors = data.data.productUpdate.userErrors ?? [];
    if (userErrors.length > 0) throw new Error(userErrors[0].message);

    const echoedProduct = data.data.productUpdate.product ?? null;

    const dbData: Record<string, unknown> = { lastSyncedAt: new Date() };
    for (const key of Object.keys(fields)) dbData[key] = fields[key];
    // The handle Shopify STORED, not the cell that was typed: Shopify
    // slugifies it, so mirroring the raw cell would leave the cache claiming a
    // handle the shop does not serve — and the grid reads that cache back.
    if (fields.handle !== undefined && echoedProduct?.handle) dbData.handle = echoedProduct.handle;
    // §Phase 3.6 — `tags` is a Prisma scalar LIST, not a string: the 1:1 copy
    // above would hand Prisma the comma-joined cell and fail the whole row.
    // Taken from Shopify's ECHO where there is one, because Shopify normalises
    // tags (trim, case-collapse) and the cache is what the grid reads back.
    if (fields.tags !== undefined) {
      const echoedTags = echoedProduct?.tags;
      dbData.tags = Array.isArray(echoedTags) ? echoedTags : parseTagList(fields.tags);
    }
    await db.product.update({ where: { shop_id: { shop, id } }, data: dbData });

    // Phase 4b: the changed primary fields' foreign translations are now stale.
    await invalidateStaleForeignTranslations(deps, "product", id, translatableKeysForColumnIds(deps, "product", remainingColumnIds));

    // §Phase 3.3 — only now, with the write confirmed: a redirect to a handle
    // Shopify never stored would point the old URL at a 404.
    await finishBulkHandleRedirect(capturedHandle, echoedProduct?.handle ?? fields.handle, group, deps);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // productUpdate is one atomic mutation over every base cell — attribute
    // the failure to each of them so the UI keeps their edits.
    for (const columnId of remainingColumnIds) failures.push(failureOf(group, message, columnId));
  }
  return failures;
}

// ─── Product row: stage 2 — metafields via metafieldsSet/metafieldsDelete ──

async function persistProductMetafields(
  group: BulkDiffRowGroup,
  cells: ProductCellGroups,
  deps: PersistDeps,
): Promise<BulkFailure[]> {
  const { db, shop, gateway } = deps;
  const productId = group.rowId;
  const failures: BulkFailure[] = [];

  interface SetEntry {
    columnId: string;
    input: { ownerId: string; namespace: string; key: string; type: string; value: string };
  }
  interface DeleteEntry {
    columnId: string;
    identifier: { ownerId: string; namespace: string; key: string };
  }
  const sets: SetEntry[] = [];
  const deletes: DeleteEntry[] = [];

  for (const { columnId, column, value } of cells.metafields) {
    const namespace = column.metafieldNamespace ?? "";
    const key = column.metafieldKey ?? "";
    const type = column.metafieldType ?? "";
    if (!namespace || !key || !type) {
      failures.push(failureOf(group, `Metafield column "${columnId}" is missing its definition.`, columnId));
      continue;
    }
    if (value === "") {
      // Clearing = metafieldsDelete with the {ownerId, namespace, key}
      // identifier (Plan §14 no. 4) — metafieldsSet with "" is rejected by
      // Shopify ("Value can't be blank"), the same trap as
      // title_tag/description_tag in CLAUDE.md.
      deletes.push({ columnId, identifier: { ownerId: productId, namespace, key } });
      continue;
    }
    let outgoing = value;
    if (type === METAFIELD_TYPE_LIST_SINGLE_LINE) {
      const parsed = parseListMetafieldInput(value);
      if (!parsed.ok) {
        failures.push(
          failureOf(group, "List values must not be empty — separate values with | and remove empty entries.", columnId),
        );
        continue;
      }
      outgoing = JSON.stringify(parsed.values);
    }
    // {ownerId, namespace, key, type, value} — NOT the single editor's
    // {id, value} form: an empty grid cell is the normal case, so the save
    // must be able to CREATE the metafield, and §14 makes `type` mandatory
    // for creation without a definition. Upsert semantics per Shopify.
    sets.push({ columnId, input: { ownerId: productId, namespace, key, type, value: outgoing } });
  }

  // All dirty metafields of ONE product in ONE call, chunked at Shopify's
  // 25-input limit (§4.4/§14).
  for (const setChunk of chunk(sets, METAFIELDS_SET_CHUNK)) {
    try {
      const response = await gateway.graphql(METAFIELDS_SET, {
        variables: { metafields: setChunk.map((s) => s.input) },
      });
      const data = (await response.json()) as {
        data?: {
          metafieldsSet?: {
            metafields?: { id: string; namespace: string; key: string; value: string; type: string }[] | null;
            userErrors?: { field?: string[] | string; message: string }[];
          };
        };
      };
      const userErrors = data.data?.metafieldsSet?.userErrors ?? [];
      if (userErrors.length > 0) {
        // metafieldsSet is atomic per call — one bad input fails the whole
        // chunk. Cells named in a userError field path ("metafields.N.…")
        // get the specific message; the rest get the atomicity explanation.
        const messageByIndex = new Map<number, string>();
        for (const err of userErrors) {
          const path = Array.isArray(err.field) ? err.field : typeof err.field === "string" ? [err.field] : [];
          const index = path.map((p) => parseInt(p, 10)).find((n) => Number.isInteger(n) && n >= 0);
          if (index !== undefined && index < setChunk.length) messageByIndex.set(index, err.message);
        }
        setChunk.forEach((entry, index) => {
          failures.push(
            failureOf(
              group,
              messageByIndex.get(index) ??
                (messageByIndex.size > 0
                  ? "Not saved — another metafield in the same call failed (Shopify applies the call atomically)."
                  : userErrors[0].message),
              entry.columnId,
            ),
          );
        });
        continue;
      }
      // Echo check: only values Shopify confirmed go into the DB mirror —
      // userErrors: [] alone is NOT success (CLAUDE.md invariant).
      const echoed = data.data?.metafieldsSet?.metafields ?? [];
      for (const entry of setChunk) {
        const echo = echoed?.find(
          (m) => m.namespace === entry.input.namespace && m.key === entry.input.key,
        );
        if (!echo) {
          failures.push(failureOf(group, "Shopify did not confirm the metafield write.", entry.columnId));
          continue;
        }
        await db.productMetafield.upsert({
          where: { id: echo.id },
          create: {
            id: echo.id,
            productId,
            namespace: echo.namespace,
            key: echo.key,
            value: echo.value,
            type: echo.type,
          },
          update: { value: echo.value, type: echo.type },
        });
        // The metafield's own foreign translations are now stale (§6.6) — they
        // live on the METAFIELD gid, so they need their own invalidation.
        await invalidateStaleForeignTranslations(deps, "product", echo.id, ["value"], "Metafield");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      for (const entry of setChunk) failures.push(failureOf(group, message, entry.columnId));
    }
  }

  // Same 25-input chunking as metafieldsSet (Finding 9) — metafieldsDelete
  // shares Shopify's per-call input limit.
  for (const deleteChunk of chunk(deletes, METAFIELDS_SET_CHUNK)) {
    try {
      const response = await gateway.graphql(METAFIELDS_DELETE, {
        variables: { metafields: deleteChunk.map((d) => d.identifier) },
      });
      const data = (await response.json()) as {
        data?: {
          metafieldsDelete?: {
            deletedMetafields?: { ownerId: string; namespace: string; key: string }[] | null;
            userErrors?: { field?: string[] | string; message: string }[];
          };
        };
      };
      const userErrors = data.data?.metafieldsDelete?.userErrors ?? [];
      if (userErrors.length > 0) {
        for (const entry of deleteChunk) failures.push(failureOf(group, userErrors[0].message, entry.columnId));
      } else {
        // Delete-echo check (CLAUDE.md): only remove the local row when
        // Shopify confirmed the removal — otherwise state diverges.
        const echoed = data.data?.metafieldsDelete?.deletedMetafields ?? [];
        for (const entry of deleteChunk) {
          const confirmed = echoed?.some(
            (d) => d.namespace === entry.identifier.namespace && d.key === entry.identifier.key,
          );
          if (!confirmed) {
            failures.push(failureOf(group, "Shopify did not confirm the metafield removal.", entry.columnId));
            continue;
          }
          // The metafield is gone — so are its translations. Delete the local
          // rows by gid; Shopify removed them with the metafield itself, so
          // there is nothing to confirm remotely.
          const removed = await db.productMetafield.findFirst({
            where: { productId, namespace: entry.identifier.namespace, key: entry.identifier.key },
            select: { id: true },
          });
          if (removed) {
            await db.contentTranslation.deleteMany({
              where: { shop, resourceId: removed.id, resourceType: "Metafield" },
            });
          }
          await db.productMetafield.deleteMany({
            where: { productId, namespace: entry.identifier.namespace, key: entry.identifier.key },
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      for (const entry of deleteChunk) failures.push(failureOf(group, message, entry.columnId));
    }
  }

  return failures;
}

// ─── Product row: stage 3 — options via productOptionUpdate ────────────────

async function persistProductOptions(
  group: BulkDiffRowGroup,
  cells: ProductCellGroups,
  deps: PersistDeps,
): Promise<BulkFailure[]> {
  const { db, gateway } = deps;
  const productId = group.rowId;
  const failures: BulkFailure[] = [];

  // One productOptionUpdate call PER dirty option — the mutation is
  // option-shaped (§4.4 no. 3).
  for (const [position, optionCells] of cells.options) {
    const columnIds = [optionCells.name?.columnId, optionCells.values?.columnId].filter(
      (c): c is string => !!c,
    );
    const failAll = (message: string) => {
      for (const columnId of columnIds) failures.push(failureOf(group, message, columnId));
    };

    const option = await db.productOption.findFirst({ where: { productId, position } });
    if (!option) {
      failAll(`This product has no option at position ${position}.`);
      continue;
    }
    // Linked options are FULLY read-only — name included (Plan §14 no. 5).
    if (option.linkedMetafieldKey) {
      failAll("This option is linked to metaobjects and cannot be edited here — use the single-item editor.");
      continue;
    }

    const optionInput: { id: string; name?: string } = { id: option.id };
    const validColumnIds: string[] = [];

    if (optionCells.name) {
      const name = optionCells.name.value.trim();
      if (name === "") {
        failures.push(failureOf(group, "Option name cannot be empty.", optionCells.name.columnId));
      } else {
        optionInput.name = name;
        validColumnIds.push(optionCells.name.columnId);
      }
    }

    let valueUpdates: { id: string; name: string }[] | undefined;
    if (optionCells.values) {
      const valuesColumnId = optionCells.values.columnId;
      // Existing values: both storage formats ([{id,name}] and legacy
      // ["string"]) parse — same as sub-resources.action.ts. Only entries
      // WITH GIDs can be mapped positionally onto productOptionUpdate.
      let existing: { id: string; name: string }[] = [];
      try {
        const parsed: unknown = JSON.parse(option.values || "[]");
        if (Array.isArray(parsed)) {
          existing = parsed.map((v: unknown) =>
            typeof v === "string"
              ? { id: "", name: v }
              : { id: String((v as { id?: unknown }).id ?? ""), name: String((v as { name?: unknown }).name ?? "") },
          );
        }
      } catch {
        existing = [];
      }
      if (existing.length === 0 || existing.some((v) => v.id === "")) {
        failures.push(
          failureOf(group, "Option values have no Shopify ids in the cache — resync this product first.", valuesColumnId),
        );
      } else {
        const newNames = optionCells.values.value.split("|").map((v) => v.trim());
        if (newNames.some((v) => v === "")) {
          failures.push(failureOf(group, "Option values must not be empty — separate values with |.", valuesColumnId));
        } else if (newNames.length !== existing.length) {
          // Adding/removing values is deliberately impossible in the grid —
          // it cascades into variants and belongs to the guided single-item
          // editor (Plan §4.2). The counts must match.
          failures.push(
            failureOf(
              group,
              `This option has ${existing.length} value(s), but ${newNames.length} were provided. Values can only be renamed here, not added or removed.`,
              valuesColumnId,
            ),
          );
        } else {
          valueUpdates = existing
            .map((v, i) => ({ id: v.id, name: newNames[i] }))
            .filter((v, i) => v.name !== existing[i].name);
          validColumnIds.push(valuesColumnId);
        }
      }
    }

    if (validColumnIds.length === 0) continue;
    if (optionInput.name === undefined && (!valueUpdates || valueUpdates.length === 0)) continue;

    try {
      const response = await gateway.graphql(PRODUCT_OPTION_UPDATE, {
        variables: {
          productId,
          option: optionInput,
          ...(valueUpdates && valueUpdates.length > 0 ? { optionValuesToUpdate: valueUpdates } : {}),
        },
      });
      const data = (await response.json()) as {
        data?: {
          productOptionUpdate?: {
            product?: { options?: { id: string; name?: string; values?: string[] }[] } | null;
            userErrors?: { field?: string[] | string; message: string }[];
          };
        };
      };
      const userErrors = data.data?.productOptionUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        for (const columnId of validColumnIds) failures.push(failureOf(group, userErrors[0].message, columnId));
        continue;
      }

      // Echo check (not just userErrors:[]): confirm Shopify echoed the target
      // option back with the values we sent — a silent no-op would otherwise be
      // mirrored to the DB as success (same guard as the metafield/variant
      // paths). The echoed `values` carries all value names; a landed rename
      // must show the new name (valueUpdates only holds actually-changed names).
      const echoedOption = data.data?.productOptionUpdate?.product?.options?.find((o) => o.id === option.id);
      const nameEchoed = optionInput.name === undefined || echoedOption?.name === optionInput.name;
      const valuesEchoed =
        !valueUpdates || valueUpdates.every((v) => (echoedOption?.values ?? []).includes(v.name));
      if (!echoedOption || !nameEchoed || !valuesEchoed) {
        for (const columnId of validColumnIds) {
          failures.push(failureOf(group, "Shopify did not confirm the option update.", columnId));
        }
        continue;
      }

      // Mirror into the local DB (same as sub-resources.action.ts) — the
      // loader reads name/values from ProductOption; without this the
      // post-save revalidation snaps back to the stale row.
      const dbData: { name?: string; values?: string } = {};
      if (optionInput.name !== undefined) dbData.name = optionInput.name;
      if (valueUpdates && valueUpdates.length > 0) {
        let parsed: unknown[] = [];
        try {
          const raw: unknown = JSON.parse(option.values || "[]");
          parsed = Array.isArray(raw) ? raw : [];
        } catch {
          parsed = [];
        }
        const nameById = new Map(valueUpdates.map((v) => [v.id, v.name]));
        dbData.values = JSON.stringify(
          parsed.map((v) => {
            if (typeof v === "string") return v; // legacy — unreachable here (guarded above), kept defensive
            const entry = v as { id?: string };
            return entry.id && nameById.has(entry.id) ? { ...entry, name: nameById.get(entry.id) } : v;
          }),
        );
      }
      if (Object.keys(dbData).length > 0) {
        await db.productOption.update({ where: { id: option.id }, data: dbData });
      }

      // §6.6: a renamed option (or option value) makes ITS OWN foreign
      // translations stale — they live on the ProductOption /
      // ProductOptionValue gid, so each one is invalidated separately.
      if (optionInput.name !== undefined) {
        await invalidateStaleForeignTranslations(deps, "product", option.id, ["name"], "ProductOption");
      }
      for (const update of valueUpdates ?? []) {
        await invalidateStaleForeignTranslations(deps, "product", update.id, ["name"], "ProductOptionValue");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      for (const columnId of validColumnIds) failures.push(failureOf(group, message, columnId));
    }
  }

  return failures;
}

// ─── Product row: stage 4 — main-image alt-text via productUpdateMedia ─────

/**
 * ONE productUpdateMedia call for ONE medium, with echo verification.
 * Returns an error message, or null on success.
 *
 * DELIBERATELY productUpdateMedia (Plan §14 no. 3): the mutation is deprecated
 * in favour of fileUpdate, but fileUpdate requires the write_files scope →
 * re-consent of every installed merchant (§11 no-go). This is also the existing
 * alt-text write path of the app (app/actions/product/update.actions.ts).
 * Revisit only when a scope event happens anyway.
 *
 * Shared by the product row's `img.alt` column and the IMAGE row type, so both
 * write through the same mutation and the same echo rule.
 */
async function writeMediaAltText(
  deps: PersistDeps,
  productId: string,
  mediaId: string,
  value: string,
): Promise<string | null> {
  try {
    const response = await deps.gateway.graphql(
      `#graphql
        mutation bulkEditorUpdateMedia($media: [UpdateMediaInput!]!, $productId: ID!) {
          productUpdateMedia(media: $media, productId: $productId) {
            media {
              alt
              mediaErrors { code details message }
            }
            mediaUserErrors { field message }
          }
        }`,
      {
        variables: {
          productId,
          // Empty string clears the alt-text on Shopify (null means "don't
          // change") — same contract as the single editor's write path.
          media: [{ id: mediaId, alt: value }],
        },
      },
    );
    const data = (await response.json()) as {
      data?: {
        productUpdateMedia?: {
          media?: { alt?: string | null; mediaErrors?: { message: string }[] }[] | null;
          mediaUserErrors?: { field?: string[] | string; message: string }[];
        };
      };
    };
    const payload = data.data?.productUpdateMedia;
    const mediaUserErrors = payload?.mediaUserErrors ?? [];
    if (mediaUserErrors.length > 0) return mediaUserErrors[0].message;
    const mediaErrors = payload?.media?.[0]?.mediaErrors ?? [];
    if (mediaErrors.length > 0) return mediaErrors[0].message;
    // Echo check (not just "media non-empty"): productUpdateMedia can accept
    // the call with empty mediaErrors yet leave the alt untouched — the silent
    // no-op class this module guards against everywhere else. Shopify returns
    // null for a cleared alt, which our empty-string input normalizes to.
    const echoedAlt = payload?.media?.[0]?.alt ?? "";
    if (!payload?.media || payload.media.length === 0 || echoedAlt !== value) {
      return "Shopify did not confirm the alt-text write.";
    }
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * ONE fileUpdate call for ONE MediaImage, with echo verification. Returns an
 * error message, or null on success.
 *
 * This is the path for images OUTSIDE the product catalogue (files library,
 * theme, metaobject references): productUpdateMedia is product-scoped and
 * cannot address them. It needs the `write_files` scope, which the app declares
 * since the image row type shipped — before that, the scope was deliberately
 * avoided (it forces every installed merchant to re-consent) and those alts
 * were read-only.
 *
 * Product media deliberately keep productUpdateMedia: it is the app's
 * established, tested path and the single editor uses the same one.
 */
async function writeFileAltText(
  deps: PersistDeps,
  mediaId: string,
  value: string,
): Promise<string | null> {
  try {
    const response = await deps.gateway.graphql(
      `#graphql
        mutation bulkEditorFileUpdate($files: [FileUpdateInput!]!) {
          fileUpdate(files: $files) {
            files {
              ... on MediaImage { id alt }
            }
            userErrors { field message code }
          }
        }`,
      // Empty string clears the alt (null would mean "don't change") — the same
      // contract writeMediaAltText uses.
      { variables: { files: [{ id: mediaId, alt: value }] } },
    );
    const data = (await response.json()) as {
      data?: {
        fileUpdate?: {
          files?: { id?: string; alt?: string | null }[] | null;
          userErrors?: { field?: string[] | string; message: string; code?: string }[];
        };
      };
      errors?: { message: string }[];
    };
    if (data.errors && data.errors.length > 0) return data.errors[0].message;
    const userErrors = data.data?.fileUpdate?.userErrors ?? [];
    if (userErrors.length > 0) return userErrors[0].message;
    // Echo check — same rule as every other write in this module: a call
    // Shopify accepted without storing anything is the silent no-op class.
    const echoed = data.data?.fileUpdate?.files?.find((f) => f.id === mediaId);
    if (!echoed || (echoed.alt ?? "") !== value) {
      return "Shopify did not confirm the alt-text write.";
    }
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function persistProductImageAlt(
  group: BulkDiffRowGroup,
  cells: ProductCellGroups,
  deps: PersistDeps,
): Promise<BulkFailure[]> {
  const { db, shop, gateway } = deps;
  const productId = group.rowId;
  const imageAlt = cells.imageAlt;
  if (!imageAlt) return [];
  const failures: BulkFailure[] = [];
  const fail = (message: string) => failures.push(failureOf(group, message, imageAlt.columnId));

  // Main image = lowest position — the same image the loader resolved.
  const image = await db.productImage.findFirst({
    where: { productId },
    orderBy: { position: "asc" },
  });
  if (!image) {
    fail("This product has no image.");
    return failures;
  }
  if (!image.mediaId) {
    fail("The image has no Shopify media id in the cache — resync this product first.");
    return failures;
  }

  const error = await writeMediaAltText(deps, productId, image.mediaId, imageAlt.value);
  if (error) {
    fail(error);
    return failures;
  }

  try {
    // DB mirror WITH altTextModifiedAt (Plan §4.3/§10.3): the product sync
    // preserves alt-texts younger than PRESERVE_WINDOW_MS (5 min,
    // product-sync.service.ts) — without the stamp, the products/update
    // webhook triggered by OUR OWN write would overwrite the fresh value.
    await db.productImage.update({
      where: { id: image.id },
      data: { altText: imageAlt.value, altTextModifiedAt: new Date() },
    });
    // The grid thumbnail + product list read Product.featuredImageAlt — the
    // main image (position 0) is the featured image, keep it in step.
    await db.product.update({
      where: { shop_id: { shop, id: productId } },
      data: { featuredImageAlt: imageAlt.value },
    });
    // §6.6: the alt's foreign translations are stale now — the same
    // invalidation the image ROW path and the single editor perform, so the
    // medium behaves identically no matter which grid edited it.
    await invalidateStaleForeignTranslations(deps, "image", image.mediaId, ["alt"]);
  } catch (err: unknown) {
    fail(err instanceof Error ? err.message : String(err));
  }
  return failures;
}

// ─── Product row: fixed-order target groups (§4.4) ─────────────────────────

async function persistProductRow(group: BulkDiffRowGroup, deps: PersistDeps): Promise<BulkFailure[]> {
  const cells = classifyProductCells(group, deps.columnsByType.product);
  const failures: BulkFailure[] = [...cells.failures];
  // Fixed order: 1. productUpdate, 2. metafieldsSet/-Delete,
  // 3. productOptionUpdate, 4. productUpdateMedia. A failed stage never
  // aborts the later ones — failures are per cell.
  failures.push(...(await persistProductBaseFields(group, cells, deps)));
  failures.push(...(await persistProductMetafields(group, cells, deps)));
  failures.push(...(await persistProductOptions(group, cells, deps)));
  failures.push(...(await persistProductImageAlt(group, cells, deps)));
  return failures;
}

/**
 * Image ROWS, primary locale: the row IS a product medium, so its only editable
 * cell is the alt-text and the write is ONE productUpdateMedia.
 *
 * The owning product is resolved SERVER-side from the cache (never taken from
 * the client) — which doubles as the tenancy check: a MediaImage GID that does
 * not belong to this shop simply does not resolve.
 */
async function persistImageRow(group: BulkDiffRowGroup, deps: PersistDeps): Promise<BulkFailure[]> {
  const { db, shop } = deps;
  const columns = deps.columnsByType.image;
  const failures: BulkFailure[] = [];

  const cells = Object.entries(group.cells).filter(([columnId]) => {
    const column = columns.find((c) => c.id === columnId);
    if (column?.editable) return true;
    failures.push(failureOf(group, `Column "${columnId}" is not editable.`, columnId));
    return false;
  });
  if (cells.length === 0) return failures;

  const image = await db.productImage.findFirst({
    where: { mediaId: group.rowId, product: { shop } },
    select: { id: true, productId: true, position: true },
  });
  if (!image) {
    // No ProductImage row ⇒ an image outside the product catalogue. It is
    // written through fileUpdate (write_files) instead of the product-scoped
    // productUpdateMedia, and mirrors into the media-library cache.
    const known = await db.mediaLibraryImage.findUnique({
      where: { shop_id: { shop, id: group.rowId } },
      select: { id: true },
    });
    if (!known) {
      for (const [columnId] of cells) {
        failures.push(
          failureOf(group, "This image is not in the local cache — run the image-library sync first.", columnId),
        );
      }
      return failures;
    }
    for (const [columnId, value] of cells) {
      if (columnId !== IMAGE_ROW_ALT_COLUMN_ID) {
        failures.push(failureOf(group, `Column "${columnId}" cannot be written on an image row.`, columnId));
        continue;
      }
      const error = await writeFileAltText(deps, group.rowId, value);
      if (error) {
        failures.push(failureOf(group, error, columnId));
        continue;
      }
      try {
        await db.mediaLibraryImage.update({
          where: { shop_id: { shop, id: group.rowId } },
          data: { altText: value },
        });
        // §6.6: the alt's foreign translations are stale now.
        await invalidateStaleForeignTranslations(deps, "image", group.rowId, ["alt"]);
      } catch (err: unknown) {
        failures.push(
          failureOf(
            group,
            `The alt text was saved on Shopify, but the local cache could not be updated (${err instanceof Error ? err.message : String(err)}). Run the image-library sync.`,
            columnId,
          ),
        );
      }
    }
    return failures;
  }

  for (const [columnId, value] of cells) {
    if (columnId !== IMAGE_ROW_ALT_COLUMN_ID) {
      failures.push(failureOf(group, `Column "${columnId}" cannot be written on an image row.`, columnId));
      continue;
    }
    const error = await writeMediaAltText(deps, image.productId, group.rowId, value);
    if (error) {
      failures.push(failureOf(group, error, columnId));
      continue;
    }
    // Shopify already holds the new value — a failing mirror must be reported
    // as a cell failure, not thrown: a concurrent product sync recreates
    // ProductImage rows (delete+create), so the update can hit P2025 right
    // after a successful write.
    try {
      // DB mirror WITH altTextModifiedAt (Plan §4.3/§10.3): the product sync
      // preserves alt-texts younger than PRESERVE_WINDOW_MS — without the stamp
      // the products/update webhook triggered by OUR OWN write overwrites it.
      await db.productImage.update({
        where: { id: image.id },
        data: { altText: value, altTextModifiedAt: new Date() },
      });
      // Position 0 is the featured image; the product list and the grid
      // thumbnail read Product.featuredImageAlt — keep it in step.
      if ((image.position ?? 0) === 0) {
        await db.product
          .update({ where: { shop_id: { shop, id: image.productId } }, data: { featuredImageAlt: value } })
          .catch(() => undefined);
      }
      // §6.6: the alt's foreign translations are now stale.
      await invalidateStaleForeignTranslations(deps, "image", group.rowId, ["alt"]);
    } catch (err: unknown) {
      failures.push(
        failureOf(
          group,
          `The alt text was saved on Shopify, but the local cache could not be updated (${err instanceof Error ? err.message : String(err)}). Resync the product.`,
          columnId,
        ),
      );
    }
  }
  return failures;
}

// ─── Non-product rows: single-mutation persist (unchanged from Phase 1) ────

/** Resolves a row group's cells (columnId → value) into flat field names
 * (title, seoTitle, …), rejecting non-editable/unknown columns. */
function fieldsOfGroup(group: BulkDiffRowGroup, columns: ColumnDescriptor[]): Partial<Record<string, string>> {
  const fields: Partial<Record<string, string>> = {};
  for (const columnId of Object.keys(group.cells)) {
    const column = columns.find((c) => c.id === columnId);
    // Per-type column guard — the route validator checks this too, but this
    // path is also reached from the /api/ai task runner, so reject here as
    // well before either Shopify or the DB can complain inconsistently.
    // The featured-image alt is the one editable non-`field` column on these
    // row types; it maps to the Prisma column `imageAltText`, which the mirror
    // loop below then picks up like any other field.
    if (column && column.editable && isFeaturedImageAltColumn(column)) {
      fields.imageAltText = group.cells[columnId];
      continue;
    }
    if (!column || !column.editable || column.kind !== "field") {
      throw new Error(`Column "${columnId}" is not editable on ${group.rowType}.`);
    }
    fields[columnId.slice("field.".length)] = group.cells[columnId];
  }
  return fields;
}

async function persistSingleMutationRow(group: BulkDiffRowGroup, deps: PersistDeps): Promise<void> {
  const { rowType: type, rowId: id } = group;
  const { db, shop, contentService } = deps;

  const fields = fieldsOfGroup(group, deps.columnsByType[type]);

  // Shopify rejects an empty title outright for every one of these resource
  // types — reject it here too so it counts as a per-row failure instead of
  // an opaque userError.
  if (fields.title !== undefined && fields.title.trim() === "") {
    throw new Error("Title cannot be empty.");
  }

  // Build the DB patch mirror. Every editable field maps 1:1 to its Prisma
  // column with the same name — no renames — so a single loop is enough.
  const dbData: Record<string, unknown> = { lastSyncedAt: new Date() };
  for (const key of Object.keys(fields)) {
    dbData[key] = fields[key];
  }
  /** Applied AFTER the write, because only then is Shopify's own value known.
   *  Same reason as the product path: a slugified handle differs from the cell
   *  that produced it, and the grid reads this cache back. */
  const withEchoedHandle = () =>
    fields.handle !== undefined && echoedResource?.handle
      ? { ...dbData, handle: echoedResource.handle }
      : dbData;

  // §Phase 3.3 — read the old handle before the mutation below replaces it.
  const capturedHandle = await captureHandleForRedirect(group, fields.handle, deps);
  // What Shopify ECHOED back. Every one of these mutations returns the
  // resource with its handle, and Shopify slugifies a handle it is given —
  // so the stored value is the only safe basis for both the cache mirror and
  // the redirect target.
  let echoedResource: { handle?: string } | null = null;

  switch (type) {
    case "collection": {
      // Same partial-SEO clobber guard as products — collectionUpdate also
      // treats `seo` as a unit. An unresolvable cache row REJECTS the write
      // (Finding 7): falling back to "" would wipe the untouched half. This
      // throw happens BEFORE any Shopify call, so nothing is half-written;
      // collection rows are single-mutation, so the failure is row-level.
      let seo: { title: string; description: string } | undefined;
      if (fields.seoTitle !== undefined || fields.seoDescription !== undefined) {
        const partialSeo = (fields.seoTitle !== undefined) !== (fields.seoDescription !== undefined);
        let untouched: { seoTitle: string | null; seoDescription: string | null } | null = null;
        if (partialSeo) {
          untouched = await db.collection
            .findUnique({
              where: { shop_id: { shop, id } },
              select: { seoTitle: true, seoDescription: true },
            })
            .catch(() => null);
          if (!untouched) {
            throw new Error(
              "The untouched SEO value could not be loaded from the local cache — resync this collection, then save the SEO change. (Sending only one half would wipe the other on Shopify.)",
            );
          }
        }
        seo = {
          title: fields.seoTitle !== undefined ? fields.seoTitle : untouched?.seoTitle ?? "",
          description:
            fields.seoDescription !== undefined
              ? fields.seoDescription
              : untouched?.seoDescription ?? "",
        };
      }
      echoedResource = await contentService.updateCollection(id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
        ...(fields.descriptionHtml !== undefined ? { descriptionHtml: fields.descriptionHtml } : {}),
        ...(seo ? { seo } : {}),
        // Featured-image alt: collectionUpdate carries it inline, the same
        // call the single editor makes (shopify-content.service updateContent).
        ...(fields.imageAltText !== undefined ? { image: { altText: fields.imageAltText } } : {}),
      });
      await db.collection.update({ where: { shop_id: { shop, id } }, data: withEchoedHandle() });
      break;
    }
    case "page": {
      echoedResource = await contentService.updatePage(id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
        ...(fields.body !== undefined ? { body: fields.body } : {}),
        ...(fields.seoTitle !== undefined ? { seoTitle: fields.seoTitle } : {}),
        ...(fields.seoDescription !== undefined ? { seoDescription: fields.seoDescription } : {}),
      });
      await db.page.update({ where: { shop_id: { shop, id } }, data: withEchoedHandle() });
      break;
    }
    case "article": {
      // Article SEO title/description are stored as global.title_tag /
      // description_tag metafields, written inline by updateArticle() (see
      // ShopifyContentService.updateArticle) — same as Page/Blog.
      echoedResource = await contentService.updateArticle(id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
        ...(fields.body !== undefined ? { body: fields.body } : {}),
        ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
        ...(fields.seoTitle !== undefined ? { seoTitle: fields.seoTitle } : {}),
        ...(fields.seoDescription !== undefined ? { seoDescription: fields.seoDescription } : {}),
        // See the collection branch — same inline alt write.
        ...(fields.imageAltText !== undefined ? { image: { altText: fields.imageAltText } } : {}),
      });
      await db.article.update({ where: { shop_id: { shop, id } }, data: withEchoedHandle() });
      break;
    }
    case "blog": {
      // Blog CONTAINER (Phase 5, Plan §7). SEO title/description are the
      // global.title_tag / description_tag METAFIELDS (CLAUDE.md gotcha):
      // updateBlog sends non-empty values inside blogUpdate's metafields
      // input and CLEARS emptied ones via metafieldsDelete — setting "" would
      // silently not clear ("Value can't be blank", §14 no. 4). Same gateway
      // path as the single editor (app.blog.tsx → updateContent → updateBlog).
      // NO DB mirror: blog containers have no cache model — the grid's
      // post-save revalidation live-fetches the fresh state from Shopify.
      echoedResource = await contentService.updateBlog(id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
        ...(fields.seoTitle !== undefined ? { seoTitle: fields.seoTitle } : {}),
        ...(fields.seoDescription !== undefined ? { seoDescription: fields.seoDescription } : {}),
      });
      break;
    }
    case "policy": {
      // ShopPolicy (Phase 5): shopPolicyUpdate is keyed by policy TYPE, not
      // id (§14 — and it has no title input; the title column is read-only).
      // The type is resolved SERVER-side from the cache row, which doubles as
      // the tenancy check — a policy id of another shop simply doesn't
      // resolve.
      if (fields.body === undefined) {
        throw new Error("Only the policy text (body) can be edited here.");
      }
      const policy = await db.shopPolicy.findUnique({
        where: { shop_id: { shop, id } },
        select: { type: true },
      });
      if (!policy) {
        throw new Error("This policy is not in the local cache — resync content first.");
      }
      await contentService.updateShopPolicy(policy.type, fields.body);
      await db.shopPolicy.update({
        where: { shop_id: { shop, id } },
        data: { body: fields.body, lastSyncedAt: new Date() },
      });
      break;
    }
    default: {
      // Exhaustiveness backstop — a new BulkRowType without a persist branch
      // must fail the row loudly, never silently skip the Shopify push while
      // the caller reports success (the false-success pattern from CLAUDE.md).
      throw new Error(`Unsupported row type "${type}".`);
    }
  }

  // Reached only on a successful write (every branch throws on failure).
  // Phase 4b: invalidate the changed primary fields' now-stale foreign
  // translations. Columns are keyed `field.<name>` in the universe.
  await invalidateStaleForeignTranslations(
    deps,
    type,
    id,
    translatableKeysForColumnIds(deps, type, Object.keys(fields).map((name) => `field.${name}`)),
  );
  // The featured-image alt is NOT a `field.` column, and its translation lives
  // on a different resource than its DB row — the generic pass above cannot
  // reach either half (§6.6 still applies: a changed primary makes the
  // existing translations stale).
  if (fields.imageAltText !== undefined && (type === "collection" || type === "article")) {
    await invalidateStaleFeaturedImageAltTranslations(deps, type, id);
  }

  // §Phase 3.3 — the write is confirmed (every branch above throws otherwise),
  // so the old URL can now be pointed at the new one.
  await finishBulkHandleRedirect(capturedHandle, echoedResource?.handle ?? fields.handle, group, deps);
}

/**
 * §6.6 for the featured-image alt. Same echo rule as everywhere else: the local
 * row only goes when Shopify confirms the removal, so a silent no-op can never
 * orphan the storefront from the DB.
 */
async function invalidateStaleFeaturedImageAltTranslations(
  deps: PersistDeps,
  rowType: BulkRowType,
  parentId: string,
): Promise<void> {
  const { db, shop, gateway, foreignLocales } = deps;
  if (!deps.purgeStaleTranslations || foreignLocales.length === 0) return;
  const resourceType = CONTENT_RESOURCE_TYPE_BY_ROW_TYPE[rowType];
  try {
    // Only touch Shopify when there is actually something to invalidate — the
    // common case is a shop that never translated this alt text.
    const existing = await db.contentTranslation.findMany({
      where: {
        shop,
        resourceId: parentId,
        resourceType,
        key: "image_alt_text",
        marketId: "",
        locale: { in: foreignLocales },
      },
      select: { locale: true },
    });
    if (existing.length === 0) return;
    const imageResourceId = await fetchFeaturedImageId(deps, rowType, parentId);
    if (!imageResourceId) return;
    const locales = [...new Set(existing.map((row) => row.locale))];
    const { confirmedPairs } = await removeAndVerifyAcrossLocales(gateway, imageResourceId, ["alt"], locales, "");
    const confirmed = locales.filter((locale) => confirmedPairs.has(`${locale}${LOCALE_KEY_SEP}alt`));
    if (confirmed.length === 0) return;
    await db.contentTranslation.deleteMany({
      where: {
        shop,
        resourceId: parentId,
        resourceType,
        key: "image_alt_text",
        marketId: "",
        locale: { in: confirmed },
      },
    });
  } catch (err: unknown) {
    // Never fail the primary save over the cleanup — the same posture the
    // generic invalidation takes.
    logger.warn("[bulk-editor] featured image alt invalidation failed", {
      context: "BulkEditor",
      parentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Metaobject rows: metaobjectUpdate with echo verification (Phase 5) ────

/**
 * Persists one primary metaobject row group with ONE metaobjectUpdate
 * (Plan §7). The row's dirty mofield cells become the mutation's `fields`
 * input; the cache row resolves the definition type SERVER-side (tenancy
 * check — a foreign shop's metaobject doesn't resolve) and guards against
 * cross-type columns. Echo semantics (CLAUDE.md): only when Shopify returns
 * the metaobject with our values in `fields` is the cache mirrored —
 * `userErrors: []` alone is not success.
 */
async function persistMetaobjectRow(group: BulkDiffRowGroup, deps: PersistDeps): Promise<BulkFailure[]> {
  const { db, shop, gateway } = deps;
  const id = group.rowId;
  const columns = deps.columnsByType.metaobject;
  const failures: BulkFailure[] = [];

  // The row's type is needed BEFORE the write for the cross-type guard below,
  // so it is read here as well as inside the shared writer. Two cheap reads of
  // one indexed row beat handing the writer a column model it has no business
  // knowing about.
  const cached = await db.metaobject.findUnique({
    where: { shop_id: { shop, id } },
    select: { type: true },
  });
  if (!cached) {
    return [failureOf(group, "This metaobject is not in the local cache — resync content first.")];
  }

  const writes: MetaobjectFieldWrite[] = [];
  for (const [columnId, value] of Object.entries(group.cells)) {
    const column = columns.find((c) => c.id === columnId);
    if (!column || !column.editable || column.kind !== "mofield" || !column.moFieldKey) {
      failures.push(failureOf(group, `Column "${columnId}" is not editable on ${group.rowType}.`, columnId));
      continue;
    }
    // Cross-type guard: the validation universe is the UNION of every
    // definition's columns (Plan §7) — a column of another type must fail
    // loudly here, never write a stray field into this metaobject.
    if (column.moType !== cached.type) {
      failures.push(
        failureOf(group, `This metaobject is of type "${cached.type}" — the column belongs to "${column.moType}".`, columnId),
      );
      continue;
    }
    let outgoing = value;
    if (column.moFieldType === METAFIELD_TYPE_LIST_SINGLE_LINE && value !== "") {
      const parsed = parseListMetafieldInput(value);
      if (!parsed.ok) {
        failures.push(
          failureOf(group, "List values must not be empty — separate values with | and remove empty entries.", columnId),
        );
        continue;
      }
      outgoing = JSON.stringify(parsed.values);
    }
    // "" clears the field value (MetaobjectFieldInput.value is a plain
    // String) — if a definition-level validation rejects the empty value,
    // Shopify answers with a userError and the cell fails visibly below.
    writes.push({ ref: columnId, key: column.moFieldKey, value: outgoing });
  }
  if (writes.length === 0) return failures;

  // ONE echo-verified metaobjectUpdate — the same call the single editor makes
  // (metaobject-write.server.ts). Failures come back per `ref`, which is the
  // column id, so a cell that Shopify refused stays red on its own.
  const result = await writeMetaobjectFields({ gateway, db, shop, id, writes });
  for (const failure of result.failures) {
    failures.push(failureOf(group, failure.message, failure.ref));
  }
  if (result.confirmedKeys.length > 0) {
    // Phase 4b: the confirmed primary field changes make their foreign
    // MetaobjectTranslation rows stale — invalidate by field key.
    await invalidateStaleForeignTranslations(deps, "metaobject", id, result.confirmedKeys);
  }
  return failures;
}

// ─── Foreign-locale rows: translationsRegister/-Remove with verification ───

/** ProductImage cache-row id for a MediaImage GID, shop-scoped (which doubles
 * as the tenancy check). Null when the image is not cached. */
async function imageCacheIdFor(deps: PersistDeps, mediaId: string): Promise<string | null> {
  const row = await deps.db.productImage.findFirst({
    where: { mediaId, product: { shop: deps.shop } },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** Primary-locale handle of a row — for the duplicate-slug guard below. */
async function loadPrimaryHandle(
  db: PrismaClient,
  shop: string,
  group: BulkDiffRowGroup,
): Promise<string | null> {
  const where = { shop_id: { shop, id: group.rowId } };
  const select = { handle: true } as const;
  switch (group.rowType) {
    case "product":
      return (await db.product.findUnique({ where, select }))?.handle ?? null;
    case "collection":
      return (await db.collection.findUnique({ where, select }))?.handle ?? null;
    case "article":
      return (await db.article.findUnique({ where, select }))?.handle ?? null;
    case "page":
      return (await db.page.findUnique({ where, select }))?.handle ?? null;
    default:
      return null;
  }
}

// ── PLAN §Phase 3.3 / §A1 — redirect on a handle change, in bulk ────────────
// The single editor is not the only place handles change: `field.handle` is an
// editable column here too, and a 250-row save can rewrite as many URLs in one
// go. The shop-level setting is a shop-level promise, so it has to hold on this
// path as well — through the SAME decision module, never a second rule.
//
// Since the locale prefix was measured (see the header of
// handle-redirect.shared.ts), the FOREIGN half is covered too: a translated
// handle is a real storefront URL and editing it breaks that URL exactly the
// same way. `captureTranslatedHandleForRedirect` below is that path, and it is
// deliberately narrower — the rules live in `decideTranslatedHandleRedirect`.
//
// Note what this does NOT change: bulk-TRANSLATE only ever fills EMPTY
// translations, and a locale that had no translated handle was being served
// under the primary one, which stays live. Nothing breaks there, so nothing is
// redirected — the decision reports `notTranslatedBefore` and stops.

interface CapturedHandle {
  resource: RedirectableResource;
  previousHandle: string;
  /** Was the OLD URL ever reachable? `false` ⇒ no redirect (a draft's address
   *  is one nobody holds); `null` ⇒ unknown, which proceeds. */
  previouslyLive: boolean | null;
}

/** The old handle, read BEFORE the write — afterwards it is gone. Returns null
 *  whenever no redirect could come of it, so the common case costs nothing. */
async function captureHandleForRedirect(
  group: BulkDiffRowGroup,
  nextHandle: string | undefined,
  deps: PersistDeps,
): Promise<CapturedHandle | null> {
  if (!deps.autoHandleRedirect || nextHandle === undefined || group.locale !== "") return null;
  const resource = redirectResourceFor(bulkRowTypeToResourceType(group.rowType), group.rowId);
  if (!resource) return null;
  // Blog containers have no cache model — their handle is only on Shopify.
  const before =
    group.rowType === "blog"
      ? { handle: await loadBlogHandleForRedirect(deps, group.rowId), state: {} }
      : await loadRedirectStateForRow(deps, group).catch(() => ({ handle: null, state: {} }));
  if (!before.handle) return null;
  return { resource, previousHandle: before.handle, previouslyLive: wasEverLive(resource, before.state) };
}

/** The row's pre-write handle plus what says whether its URL was reachable —
 *  one query, since both come off the same cache row. */
async function loadRedirectStateForRow(
  deps: PersistDeps,
  group: BulkDiffRowGroup,
): Promise<{ handle: string | null; state: { status?: string | null; isPublished?: boolean | null; attributesKnown?: boolean } }> {
  const where = { shop_id: { shop: deps.shop, id: group.rowId } };
  switch (group.rowType) {
    case "product": {
      const row = await deps.db.product.findUnique({ where, select: { handle: true, status: true } });
      return { handle: row?.handle ?? null, state: { status: row?.status ?? null } };
    }
    case "page": {
      const row = await deps.db.page.findUnique({
        where,
        select: { handle: true, isPublished: true, attributesSyncedAt: true },
      });
      return {
        handle: row?.handle ?? null,
        state: { isPublished: row?.isPublished ?? null, attributesKnown: !!row?.attributesSyncedAt },
      };
    }
    case "article": {
      const row = await deps.db.article.findUnique({
        where,
        select: { handle: true, isPublished: true, attributesSyncedAt: true },
      });
      return {
        handle: row?.handle ?? null,
        state: { isPublished: row?.isPublished ?? null, attributesKnown: !!row?.attributesSyncedAt },
      };
    }
    case "collection": {
      const row = await deps.db.collection.findUnique({ where, select: { handle: true } });
      // Visibility lives in publications — no scope, genuinely unknown.
      return { handle: row?.handle ?? null, state: {} };
    }
    default:
      return { handle: null, state: {} };
  }
}

/** Applies a captured handle change. Never throws and never fails a cell: the
 *  row is already written, and reporting a cell error here would tell the
 *  merchant their edit did not land when it did. */
async function finishBulkHandleRedirect(
  captured: CapturedHandle | null,
  nextHandle: string | undefined,
  group: BulkDiffRowGroup,
  deps: PersistDeps,
): Promise<void> {
  if (!captured || !nextHandle) return;
  try {
    const { applyHandleRedirect } = await import("../seo/handle-redirect.server");
    await applyHandleRedirect(deps.gateway as never, deps.shop, {
      resource: captured.resource,
      previousHandle: captured.previousHandle,
      nextHandle,
      wanted: true,
      previouslyLive: captured.previouslyLive,
      blogHandle:
        captured.resource === "article" ? await loadArticleBlogHandleForRedirect(deps, group.rowId) : undefined,
    });
  } catch {
    // Best effort by design — see the block comment above.
  }
}

interface CapturedTranslatedHandle {
  resource: RedirectableResource;
  previousHandle: string;
  primaryHandle: string | null;
  otherLocaleHandles: string[];
  previouslyLive: boolean | null;
  blogHandle: string | null;
  blogHandleTranslatedInLocale: boolean;
  previousHandleTakenElsewhere: boolean;
}

/**
 * Everything the foreign-locale decision needs, read BEFORE the write.
 *
 * Returns null for every case that could not produce a redirect anyway, so the
 * overwhelmingly common one — a translation row group with no handle cell —
 * costs nothing, and the next commonest — a handle being translated for the
 * FIRST time, which is every row bulk-translate writes — costs exactly one
 * indexed read before bailing. Only a real rename pays the rest: the cache
 * read, the collision lookup, and for articles the blog handle (a GraphQL
 * round-trip) plus one more translation read. This runs per ROW.
 */
async function captureTranslatedHandleForRedirect(
  group: BulkDiffRowGroup,
  hasHandleCell: boolean,
  deps: PersistDeps,
): Promise<CapturedTranslatedHandle | null> {
  // marketId: a market override is served to one market while a redirect row is
  // shop-wide. The decision refuses it too; skipping the reads here means the
  // common market-scoped save does not pay for a refusal.
  if (!deps.autoHandleRedirect || !hasHandleCell || group.locale === "" || group.marketId !== "") return null;
  const resource = redirectResourceFor(bulkRowTypeToResourceType(group.rowType), group.rowId);
  if (!resource) return null;

  try {
    // One query for BOTH halves of rule 2: this locale's own previous value and
    // every other locale's, which the unprefixed row would also answer for.
    const handleRows = await deps.db.contentTranslation.findMany({
      where: { shop: deps.shop, resourceId: group.rowId, key: "handle", marketId: "" },
      select: { locale: true, value: true },
    });
    const previousHandle = handleRows.find((r) => r.locale === group.locale)?.value?.trim() ?? "";
    // Nothing was translated before ⇒ the locale was served under the primary
    // handle, which stays live. Bail before the remaining reads.
    if (!previousHandle) return null;

    const before =
      group.rowType === "blog"
        ? { handle: await loadBlogHandleForRedirect(deps, group.rowId), state: {} }
        : await loadRedirectStateForRow(deps, group).catch(() => ({ handle: null, state: {} }));

    let blogHandle: string | null = null;
    let blogHandleTranslatedInLocale = false;
    if (resource === "article") {
      const article = await deps.db.article.findUnique({
        where: { shop_id: { shop: deps.shop, id: group.rowId } },
        select: { blogId: true },
      });
      if (article?.blogId) {
        blogHandle = await loadBlogHandleForRedirect(deps, article.blogId);
        const translatedBlogHandle = await deps.db.contentTranslation.findFirst({
          where: {
            shop: deps.shop,
            resourceId: article.blogId,
            key: "handle",
            locale: group.locale,
            marketId: "",
          },
          select: { value: true },
        });
        blogHandleTranslatedInLocale = !!translatedBlogHandle?.value?.trim();
      }
    }

    // Only reachable on a real rename, which is what makes an unindexed lookup
    // affordable here — see handleTakenByOtherResource.
    const { handleTakenByOtherResource } = await import("../seo/handle-redirect.server");
    const previousHandleTakenElsewhere = await handleTakenByOtherResource(
      deps.db as never,
      deps.shop,
      resource,
      previousHandle,
      group.rowId,
    );

    return {
      resource,
      previousHandle,
      previousHandleTakenElsewhere,
      primaryHandle: before.handle,
      otherLocaleHandles: handleRows.filter((r) => r.locale !== group.locale).map((r) => r.value),
      previouslyLive: wasEverLive(resource, before.state),
      blogHandle,
      blogHandleTranslatedInLocale,
    };
  } catch {
    // A redirect is a courtesy on a write that has to happen either way.
    return null;
  }
}

/** Applies a captured translated-handle change. `nextHandle` is `""` for a
 *  CLEARED translation, which the decision reads as "back to the primary
 *  handle". Never throws and never fails a cell — the translation is already
 *  written, and a redirect failure must not read as a failed save. */
async function finishTranslatedHandleRedirect(
  captured: CapturedTranslatedHandle | null,
  nextHandle: string | undefined,
  group: BulkDiffRowGroup,
  deps: PersistDeps,
): Promise<void> {
  if (!captured || nextHandle === undefined) return;
  try {
    const { applyTranslatedHandleRedirect } = await import("../seo/handle-redirect.server");
    await applyTranslatedHandleRedirect(deps.gateway as never, deps.shop, {
      resource: captured.resource,
      marketId: group.marketId,
      previousTranslatedHandle: captured.previousHandle,
      nextTranslatedHandle: nextHandle,
      primaryHandle: captured.primaryHandle,
      otherLocaleHandles: captured.otherLocaleHandles,
      previousHandleTakenElsewhere: captured.previousHandleTakenElsewhere,
      wanted: true,
      previouslyLive: captured.previouslyLive,
      blogHandle: captured.blogHandle,
      blogHandleTranslatedInLocale: captured.blogHandleTranslatedInLocale,
    });
  } catch {
    // Best effort by design — see the block comment above.
  }
}

/**
 * The shop's "redirect on handle change" preference, read ONCE per run.
 *
 * Every failure mode resolves to the column's own default (on): the setting
 * protects URLs, so the safe answer when the row cannot be read is to protect
 * them. An unwanted redirect is one row a merchant can delete; a missed one is
 * traffic nobody notices losing. The try/catch is not decoration — this runs
 * under test doubles that carry only the models a given test needs.
 */
async function loadAutoHandleRedirect(db: PrismaClient, shop: string): Promise<boolean> {
  try {
    const row = await db.aISettings.findUnique({
      where: { shop },
      select: { seoAutoHandleRedirect: true },
    });
    return row?.seoAutoHandleRedirect !== false;
  } catch {
    return true;
  }
}

/** The bulk row types that map onto the unified handler's resource names. */
function bulkRowTypeToResourceType(rowType: BulkRowType): string {
  switch (rowType) {
    case "product":    return "Product";
    case "collection": return "Collection";
    case "page":       return "Page";
    case "article":    return "Article";
    case "blog":       return "Blog";
    default:           return "";
  }
}

async function loadBlogHandleForRedirect(deps: PersistDeps, blogId: string): Promise<string | null> {
  try {
    const response = await deps.gateway.graphql(
      `#graphql
        query bulkBlogHandleForRedirect($id: ID!) { blog(id: $id) { handle } }`,
      { variables: { id: blogId } },
    );
    const data = (await response.json()) as { data?: { blog?: { handle?: string } } };
    return data?.data?.blog?.handle ?? null;
  } catch {
    return null;
  }
}

async function loadArticleBlogHandleForRedirect(deps: PersistDeps, articleId: string): Promise<string | null> {
  try {
    const article = await deps.db.article.findUnique({
      where: { shop_id: { shop: deps.shop, id: articleId } },
      select: { blogId: true },
    });
    if (!article?.blogId) return null;
    return await loadBlogHandleForRedirect(deps, article.blogId);
  } catch {
    return null;
  }
}

/**
 * Persists one foreign-locale row group (Plan §6): non-empty cells become ONE
 * verified translationsRegister, cleared cells ONE verified
 * translationsRemove. Only keys Shopify CONFIRMS are mirrored into
 * ContentTranslation (register → upsert, remove → delete); everything else is
 * a cell failure that keeps the merchant's edit (and, for clears, the local
 * DB row) intact. After every confirmed write, markTranslationSaved()
 * shields the resource from the webhook rebound for 60 s (§10.3).
 */
async function persistTranslationRow(group: BulkDiffRowGroup, deps: PersistDeps): Promise<BulkFailure[]> {
  const { db, shop, gateway } = deps;
  const resourceId = group.rowId;
  const { locale, marketId } = group;
  const resourceType = CONTENT_RESOURCE_TYPE_BY_ROW_TYPE[group.rowType];
  const columns = deps.columnsByType[group.rowType];
  const failures: BulkFailure[] = [];

  interface TranslationCell {
    columnId: string;
    key: string;
    value: string;
  }
  const writes: TranslationCell[] = [];
  const clears: TranslationCell[] = [];
  /** Cells whose translation does NOT live on this row's translatableResource
   * (metafields, product options) — written below against their own GIDs. */
  const subResourceCells: { columnId: string; column: ColumnDescriptor; value: string }[] = [];
  /** The featured-image alt: Shopify target is the image's OWN GID, the DB
   * mirror stays on this row — a third shape, handled separately below. */
  const featuredAltCells: { columnId: string; value: string }[] = [];
  for (const [columnId, value] of Object.entries(group.cells)) {
    const column = columns.find((c) => c.id === columnId);
    if (column && isFeaturedImageAltColumn(column)) {
      if (!column.translatable) {
        failures.push(failureOf(group, `Column "${columnId}" is not translatable.`, columnId));
        continue;
      }
      featuredAltCells.push({ columnId, value });
      continue;
    }
    if (column && isSubResourceColumn(column)) {
      // The `translatable` gate still applies here — diverting BEFORE checking
      // it would let a read-only rich_text metafield through on this path
      // (both entrances validate too, this is the defensive second half).
      if (!column.translatable) {
        failures.push(failureOf(group, `Column "${columnId}" is not translatable.`, columnId));
        continue;
      }
      subResourceCells.push({ columnId, column, value });
      continue;
    }
    const key = column ? translationKeyForColumn(column, group.rowType) : null;
    if (!column || !key) {
      // Validation rejected non-translatable columns already — reaching this
      // is a programming error, surfaced per cell (never silently dropped).
      failures.push(failureOf(group, `Column "${columnId}" is not translatable.`, columnId));
      continue;
    }
    if (value === "") clears.push({ columnId, key, value });
    else writes.push({ columnId, key, value });
  }

  if (subResourceCells.length > 0) {
    failures.push(...(await persistSubResourceTranslations(group, subResourceCells, deps)));
  }
  for (const cell of featuredAltCells) {
    const error = await writeFeaturedImageAltTranslation(group, cell.value, deps);
    if (error) failures.push(failureOf(group, error, cell.columnId));
    else markTranslationSaved(group.rowId);
  }

  // Duplicate-slug guard (same rule as updateContent in the single editor):
  // a handle "translation" identical to the primary handle causes Shopify
  // routing conflicts across locales. The single editor silently skips it; in
  // a 250-row grid a silent skip is invisible, so it is an explicit cell
  // failure here.
  const handleIndex = writes.findIndex((w) => w.key === "handle");
  if (handleIndex >= 0) {
    const primaryHandle = await loadPrimaryHandle(db, shop, group).catch(() => null);
    if (primaryHandle && writes[handleIndex].value.trim() === primaryHandle.trim()) {
      failures.push(
        failureOf(
          group,
          "The translated handle is identical to the primary handle — duplicate slugs across locales cause routing conflicts.",
          writes[handleIndex].columnId,
        ),
      );
      writes.splice(handleIndex, 1);
    }
  }

  // §3.3 foreign half — captured BEFORE the write, because afterwards the old
  // translated handle is gone. `writes` is re-scanned rather than reusing
  // `handleIndex`: the duplicate-slug guard above may just have removed it.
  const capturedTranslatedHandle = await captureTranslatedHandleForRedirect(
    group,
    writes.some((w) => w.key === "handle") || clears.some((c) => c.key === "handle"),
    deps,
  );
  /** The handle translation Shopify CONFIRMED — `""` for a confirmed clear,
   *  `undefined` while nothing is confirmed. */
  let confirmedHandle: string | undefined;

  // ── Digest rule (§6.3, ONE strict rule): no digest ⇒ one re-fetch of the
  // resource ⇒ still none ⇒ cell error. No Shopify write, NO DB write.
  let digestsForResource = deps.digests.get(resourceId);
  const missingDigest = writes.some((w) => !digestsForResource?.get(w.key));
  if (missingDigest && !deps.digestRefetched.has(resourceId)) {
    deps.digestRefetched.add(resourceId);
    try {
      const fresh = await fetchDigestsForResource(gateway, resourceId);
      const merged = new Map(digestsForResource ?? []);
      for (const [key, digest] of fresh) merged.set(key, digest);
      deps.digests.set(resourceId, merged);
      digestsForResource = merged;
    } catch {
      // Re-fetch failed — the writes without a digest fail per cell below.
    }
  }

  const ready: (TranslationCell & { digest: string })[] = [];
  for (const write of writes) {
    const digest = digestsForResource?.get(write.key);
    if (!digest) {
      // Expected for meta_title/meta_description without a primary SEO
      // override (Plan §14 no. 6) — still a cell error, never a silent skip
      // or a DB-only row.
      failures.push(
        failureOf(
          group,
          `Shopify provides no translatable digest for "${write.key}" on this resource — the translation cannot be registered. (For SEO fields this means the primary SEO value has not been set.)`,
          write.columnId,
        ),
      );
      continue;
    }
    ready.push({ ...write, digest });
  }

  if (ready.length > 0) {
    const inputs: TranslationInput[] = ready.map((w) => ({
      key: w.key,
      value: w.value,
      locale,
      translatableContentDigest: w.digest,
      ...(marketId ? { marketId } : {}),
    }));
    try {
      const { confirmedKeys, confirmedValues, userErrors } = await registerAndVerify(gateway, resourceId, inputs);
      for (const write of ready) {
        if (!confirmedKeys.has(write.key)) {
          failures.push(
            failureOf(
              group,
              userErrors[0]?.message ??
                "Shopify reported no error but did not store this translation — nothing was saved.",
              write.columnId,
            ),
          );
          continue;
        }
        // Webhook shield BEFORE the DB mirror — Shopify already holds the new
        // value, so the rebound protection must be active even if the mirror
        // fails (same ordering as updateContent).
        markTranslationSaved(resourceId);
        // What Shopify ECHOED, not what was sent. The same rule the theme path
        // already follows for autofix-normalised richtext: mirroring the raw
        // value diverges the DB from the storefront, and for `handle` it would
        // point the redirect at an address nobody serves.
        const storedValue = confirmedValues.get(write.key) ?? write.value;
        if (write.key === "handle") confirmedHandle = storedValue;
        if (group.rowType === "image") {
          // PRODUCT media mirror into ProductImageAltTranslation (keyed by the
          // ProductImage CACHE row) — the store the single editor and the SEO
          // bulk fix write, so all three read each other's rows. Every OTHER
          // image of the shop has no such row and uses the generic
          // ContentTranslation table under resourceType "MediaImage".
          const cacheId = await imageCacheIdFor(deps, resourceId);
          if (cacheId) {
            await db.productImageAltTranslation.upsert({
              where: { imageId_locale_marketId: { imageId: cacheId, locale, marketId } },
              update: { altText: storedValue },
              create: { imageId: cacheId, locale, marketId, altText: storedValue },
            });
          } else {
            await db.contentTranslation.upsert({
              where: {
                shop_resourceId_key_locale_marketId: {
                  shop,
                  resourceId,
                  key: write.key,
                  locale,
                  marketId,
                },
              },
              update: { value: storedValue, digest: write.digest, resourceType: "MediaImage" },
              create: {
                shop,
                resourceId,
                resourceType: "MediaImage",
                key: write.key,
                value: storedValue,
                locale,
                marketId,
                digest: write.digest,
              },
            });
          }
        } else if (group.rowType === "metaobject") {
          // Metaobject translations mirror into their OWN table (Phase 5,
          // unique shop_metaobjectId_key_locale_marketId) — the shape every
          // existing writer and the sync use. `type` comes from the cache
          // row; "" if the metaobject is (pathologically) uncached, the sync
          // repairs it.
          const cached = await db.metaobject.findUnique({
            where: { shop_id: { shop, id: resourceId } },
            select: { type: true },
          });
          await db.metaobjectTranslation.upsert({
            where: {
              shop_metaobjectId_key_locale_marketId: {
                shop,
                metaobjectId: resourceId,
                key: write.key,
                locale,
                marketId,
              },
            },
            update: { value: storedValue, outdated: false },
            create: {
              shop,
              metaobjectId: resourceId,
              type: cached?.type ?? "",
              key: write.key,
              value: storedValue,
              locale,
              marketId,
              outdated: false,
            },
          });
        } else {
          await db.contentTranslation.upsert({
            where: {
              shop_resourceId_key_locale_marketId: {
                shop,
                resourceId,
                key: write.key,
                locale,
                marketId,
              },
            },
            update: { value: storedValue, digest: write.digest, resourceType },
            create: {
              shop,
              resourceId,
              resourceType,
              key: write.key,
              value: storedValue,
              locale,
              marketId,
              digest: write.digest,
            },
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      for (const write of ready) failures.push(failureOf(group, message, write.columnId));
    }
  }

  if (clears.length > 0) {
    try {
      const { confirmedKeys, userErrors } = await removeAndVerify(
        gateway,
        resourceId,
        clears.map((c) => c.key),
        locale,
        marketId,
      );
      for (const clear of clears) {
        if (!confirmedKeys.has(clear.key)) {
          // NOT confirmed ⇒ the local row is NOT deleted (CLAUDE.md
          // invariant) — otherwise the field looks gone locally while it
          // survives on the storefront.
          failures.push(
            failureOf(
              group,
              userErrors[0]?.message ??
                "Shopify did not confirm the translation removal — the local value was kept.",
              clear.columnId,
            ),
          );
          continue;
        }
        markTranslationSaved(resourceId);
        // A cleared handle: the locale is served under the PRIMARY handle
        // again, so the dead translated URL gets a redirect there.
        if (clear.key === "handle") confirmedHandle = "";
        if (group.rowType === "image") {
          // Cleared alt translation — the row goes only because Shopify already
          // confirmed the removal above (CLAUDE.md).
          const cacheId = await imageCacheIdFor(deps, resourceId);
          if (cacheId) {
            await db.productImageAltTranslation.deleteMany({
              where: { imageId: cacheId, locale, marketId },
            });
          } else {
            await db.contentTranslation.deleteMany({
              where: { shop, resourceId, resourceType: "MediaImage", key: clear.key, locale, marketId },
            });
          }
        } else if (group.rowType === "metaobject") {
          await db.metaobjectTranslation.deleteMany({
            where: { shop, metaobjectId: resourceId, key: clear.key, locale, marketId },
          });
        } else {
          await db.contentTranslation.deleteMany({
            where: { shop, resourceId, key: clear.key, locale, marketId },
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      for (const clear of clears) failures.push(failureOf(group, message, clear.columnId));
    }
  }

  // AFTER both loops: only a translation Shopify confirmed changed a URL, and
  // an unconfirmed write leaves the old translated handle in place.
  await finishTranslatedHandleRedirect(capturedTranslatedHandle, confirmedHandle, group, deps);

  return failures;
}

/**
 * Featured-image alt translation of a collection / article.
 *
 * The only translation in this editor whose Shopify target and DB mirror have
 * DIFFERENT ids: Shopify stores it as key `alt` on the image's own
 * `CollectionImage`/`ArticleImage` GID, while the row lives in
 * `ContentTranslation` on the PARENT with key `image_alt_text` — the exact
 * shape `saveImageAltTextTranslation` in the single editor writes, so the two
 * editors read each other's rows.
 *
 * The image GID is not cached anywhere, so it is resolved from the parent per
 * row. Constructing it from the parent's numeric id is impossible: the probe
 * confirmed `gid://shopify/MediaImage/<same number>` resolves to nothing, and
 * the file's MediaImage carries a SEPARATE (empty) alt.
 *
 * Same echo rules as every other path here: no digest ⇒ cell error and NO DB
 * write; a removal that Shopify does not confirm keeps the local row.
 *
 * Returns an error message, or null on success.
 */
async function writeFeaturedImageAltTranslation(
  group: BulkDiffRowGroup,
  value: string,
  deps: PersistDeps,
): Promise<string | null> {
  const { db, shop, gateway } = deps;
  const { locale, marketId } = group;
  const resourceType = CONTENT_RESOURCE_TYPE_BY_ROW_TYPE[group.rowType];
  const dbKey = "image_alt_text";

  let imageResourceId: string;
  try {
    const resolved = await fetchFeaturedImageId(deps, group.rowType, group.rowId);
    if (!resolved) {
      return "This collection/article has no featured image on Shopify — there is nothing to translate.";
    }
    imageResourceId = resolved;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }

  if (value === "") {
    try {
      const { confirmedKeys, userErrors } = await removeAndVerify(gateway, imageResourceId, ["alt"], locale, marketId);
      if (!confirmedKeys.has("alt")) {
        return (
          userErrors[0]?.message ??
          "Shopify did not confirm the translation removal — the local value was kept."
        );
      }
      await db.contentTranslation.deleteMany({
        where: { shop, resourceId: group.rowId, resourceType, key: dbKey, locale, marketId },
      });
      return null;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  let digest = deps.digests.get(imageResourceId)?.get("alt");
  if (!digest && !deps.digestRefetched.has(imageResourceId)) {
    deps.digestRefetched.add(imageResourceId);
    try {
      const fresh = await fetchDigestsForResource(gateway, imageResourceId);
      deps.digests.set(imageResourceId, fresh);
      digest = fresh.get("alt");
    } catch {
      // fall through to the cell error below
    }
  }
  if (!digest) {
    // The image exists but exposes no `alt` digest — almost always because the
    // PRIMARY alt text is empty: translatableContent only lists keys that have
    // a value (CLAUDE.md). Say so, instead of "not translatable".
    return "Shopify offers no translatable alt text for this image — set the alt text in the primary language first.";
  }

  try {
    const { confirmedKeys, userErrors } = await registerAndVerify(gateway, imageResourceId, [
      {
        key: "alt",
        value,
        locale,
        translatableContentDigest: digest,
        ...(marketId ? { marketId } : {}),
      },
    ]);
    if (!confirmedKeys.has("alt")) {
      return (
        userErrors[0]?.message ??
        "Shopify reported no error but did not store this translation — nothing was saved."
      );
    }
    await db.contentTranslation.upsert({
      where: {
        shop_resourceId_key_locale_marketId: { shop, resourceId: group.rowId, key: dbKey, locale, marketId },
      },
      update: { value, digest, resourceType },
      create: { shop, resourceId: group.rowId, resourceType, key: dbKey, value, locale, marketId, digest },
    });
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** `collection(id){image{id}}` / `article(id){image{id}}` — the parent is the
 * only route to the image's GID (it is cached nowhere, and cannot be derived
 * from the parent id). */
async function fetchFeaturedImageId(
  deps: PersistDeps,
  rowType: BulkRowType,
  parentId: string,
): Promise<string | null> {
  // A foreign group is per (row, locale, market), so translating ONE
  // collection's alt into five languages would otherwise issue five identical
  // lookups — plus a sixth from the §6.6 invalidation.
  const cached = deps.featuredImageIds.get(parentId);
  if (cached !== undefined) return cached;
  const { gateway } = deps;
  const field = rowType === "article" ? "article" : "collection";
  const response = await gateway.graphql(
    `#graphql
      query bulkFeaturedImageId($id: ID!) {
        ${field}(id: $id) { image { id } }
      }`,
    { variables: { id: parentId } },
  );
  const payload = (await response.json()) as {
    data?: Record<string, { image?: { id?: string | null } | null } | null>;
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) throw new Error(payload.errors[0].message);
  const imageId = payload.data?.[field]?.image?.id ?? null;
  deps.featuredImageIds.set(parentId, imageId);
  return imageId;
}

/**
 * Foreign-locale writes for SUB-RESOURCE cells (Plan §4.1/§4.2 columns whose
 * translation lives on their own Shopify resource):
 *
 *   metafield cell     → the Metafield gid,       key "value"
 *   option name cell   → the ProductOption gid,   key "name"
 *   option values cell → ONE ProductOptionValue gid per entry, key "name"
 *
 * Same three invariants as the row path: digest rule (§6.3), echo-verified
 * register/remove, DB mirror only for CONFIRMED keys. The resourceType strings
 * mirror the single-item editor's (sub-resources.action.ts), so both editors
 * read and write the same ContentTranslation rows.
 *
 * A values cell fans out to several resources but stays ONE cell for the
 * merchant: any failing entry fails the whole cell (with the entry named), so
 * the grid never shows a green cell over a half-written list.
 */
async function persistSubResourceTranslations(
  group: BulkDiffRowGroup,
  cells: { columnId: string; column: ColumnDescriptor; value: string }[],
  deps: PersistDeps,
): Promise<BulkFailure[]> {
  const { db, shop, gateway } = deps;
  const { locale, marketId } = group;
  const failures: BulkFailure[] = [];
  const cache = deps.subResourceCaches.get(group.rowId) ?? EMPTY_SUB_RESOURCE_CACHE;

  for (const cell of cells) {
    const targets = subResourceTargetsForColumn(cell.column, cache);
    if (!targets || targets.length === 0) {
      failures.push(
        failureOf(
          group,
          cell.column.kind === "metafield"
            ? "This metafield is not in the local cache — resync this product first."
            : "This option cannot be translated here (linked to metaobjects, missing, or cached without Shopify ids) — use the single-item editor.",
          cell.columnId,
        ),
      );
      continue;
    }

    // Pair each target with the value it should carry. A values cell is the
    // only 1:n case and must line up positionally with the option's values.
    let pairs: { target: SubResourceTarget; value: string }[];
    if (cell.column.kind === "option" && cell.column.optionField === "values") {
      if (cell.value === "") {
        pairs = targets.map((target) => ({ target, value: "" }));
      } else {
        const names = cell.value.split(LIST_DISPLAY_SEPARATOR.trim()).map((v) => v.trim());
        if (names.length !== targets.length) {
          failures.push(
            failureOf(
              group,
              `This option has ${targets.length} value(s) — the translation must list exactly ${targets.length}, separated by "|".`,
              cell.columnId,
            ),
          );
          continue;
        }
        if (names.some((n) => n === "")) {
          failures.push(
            failureOf(group, "Option values must not be empty — separate values with |.", cell.columnId),
          );
          continue;
        }
        pairs = targets.map((target, index) => ({ target, value: names[index] }));
      }
    } else if (cell.column.kind === "metafield" && cell.column.metafieldType === METAFIELD_TYPE_LIST_SINGLE_LINE) {
      // A list metafield stores a JSON ARRAY — the translation must use the
      // same shape as the primary value (persistProductMetafields converts the
      // same way), otherwise the storefront reads a single string.
      if (cell.value === "") {
        pairs = [{ target: targets[0], value: "" }];
      } else {
        const parsed = parseListMetafieldInput(cell.value);
        if (!parsed.ok) {
          failures.push(
            failureOf(group, "List values must not be empty — separate values with |.", cell.columnId),
          );
          continue;
        }
        pairs = [{ target: targets[0], value: JSON.stringify(parsed.values) }];
      }
    } else {
      pairs = [{ target: targets[0], value: cell.value }];
    }

    let cellFailed: string | null = null;
    for (const pair of pairs) {
      const error = await writeSubResourceTranslation(pair.target, pair.value, deps);
      if (error && !cellFailed) cellFailed = error;
    }
    if (cellFailed) failures.push(failureOf(group, cellFailed, cell.columnId));
    else markTranslationSaved(group.rowId);
  }

  return failures;

  /** ONE resource, ONE key. Returns an error message, or null on success. */
  async function writeSubResourceTranslation(
    target: SubResourceTarget,
    value: string,
    persistDeps: PersistDeps,
  ): Promise<string | null> {
    // Clearing: Shopify rejects blank option/metafield translations, so a
    // cleared cell REMOVES the translation — and the local row only goes when
    // Shopify confirms the removal (CLAUDE.md).
    if (value === "") {
      try {
        const { confirmedKeys, userErrors } = await removeAndVerify(
          gateway,
          target.resourceId,
          [target.key],
          locale,
          marketId,
        );
        if (!confirmedKeys.has(target.key)) {
          return (
            userErrors[0]?.message ??
            "Shopify did not confirm the translation removal — the local value was kept."
          );
        }
        await db.contentTranslation.deleteMany({
          where: { shop, resourceId: target.resourceId, key: target.key, locale, marketId },
        });
        return null;
      } catch (err: unknown) {
        return err instanceof Error ? err.message : String(err);
      }
    }

    // §6.3 digest rule: prefetched, ONE re-fetch, then cell error — no Shopify
    // write and no DB-only row.
    let digest = persistDeps.digests.get(target.resourceId)?.get(target.key);
    if (!digest && !persistDeps.digestRefetched.has(target.resourceId)) {
      persistDeps.digestRefetched.add(target.resourceId);
      try {
        const fresh = await fetchDigestsForResource(gateway, target.resourceId);
        persistDeps.digests.set(target.resourceId, fresh);
        digest = fresh.get(target.key);
      } catch {
        // fall through to the cell error below
      }
    }
    if (!digest) {
      return target.resourceType === "Metafield"
        ? "Shopify provides no translatable digest for this metafield — its definition is not marked as translatable."
        : "Shopify provides no translatable digest for this option value — nothing was saved.";
    }

    try {
      const { confirmedKeys, userErrors } = await registerAndVerify(gateway, target.resourceId, [
        {
          key: target.key,
          value,
          locale,
          translatableContentDigest: digest,
          ...(marketId ? { marketId } : {}),
        },
      ]);
      if (!confirmedKeys.has(target.key)) {
        return (
          userErrors[0]?.message ??
          "Shopify reported no error but did not store this translation — nothing was saved."
        );
      }
      await db.contentTranslation.upsert({
        where: {
          shop_resourceId_key_locale_marketId: {
            shop,
            resourceId: target.resourceId,
            key: target.key,
            locale,
            marketId,
          },
        },
        update: { value, digest, resourceType: target.resourceType },
        create: {
          shop,
          resourceId: target.resourceId,
          resourceType: target.resourceType,
          key: target.key,
          value,
          locale,
          marketId,
          digest,
        },
      });
      return null;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}

// ─── Variant rows: ONE productVariantsBulkUpdate per PRODUCT (Plan §5.4) ───

/** Deliberately NO variant chunking per call (Plan §14 no. 2): Shopify
 * documents no per-call variant limit; the real bounds are the per-product
 * variant limit and dynamic query cost, and the gateway's THROTTLED retry
 * covers the latter. `inventoryQuantity` is NEVER part of the input (§11). */
const PRODUCT_VARIANTS_BULK_UPDATE = `#graphql
  mutation bulkEditorVariantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        sku
        price
        compareAtPrice
        barcode
      }
      userErrors {
        field
        message
      }
    }
  }`;

interface VariantBulkInput {
  id: string;
  price?: string;
  compareAtPrice?: string | null;
  barcode?: string | null;
  inventoryItem?: { sku: string };
}

interface PreparedVariantInput {
  group: BulkDiffRowGroup;
  input: VariantBulkInput;
  /** columnIds actually carried by `input` — failure attribution set. */
  columnIds: string[];
}

/** Maps the tail of a userErrors field path to the grid column
 * ("price" → var.price, "inventoryItem"/"sku" → var.sku). */
function variantColumnForErrorField(tail: string): string | null {
  switch (tail) {
    case "price":
      return VAR_PRICE_COLUMN_ID;
    case "compareAtPrice":
      return VAR_COMPARE_AT_COLUMN_ID;
    case "barcode":
      return VAR_BARCODE_COLUMN_ID;
    case "sku":
    case "inventoryItem":
      return VAR_SKU_COLUMN_ID;
    default:
      return null;
  }
}

/** Server-side money cell-error text. The negative/ambiguous branches mirror
 * the client's pre-save messages (t.bulkEditor.moneyErrors) — the client
 * catches these while typing, this is the defensive second layer for diffs
 * that arrive via direct POST/CSV. */
function moneyErrorMessage(error: "negative" | "invalid" | "ambiguous", value: string): string {
  switch (error) {
    case "negative":
      return "The amount cannot be negative.";
    case "ambiguous":
      // Finding 3: "1.299" is ambiguous (German thousands vs. English
      // decimal) — never guess; tell the merchant how to disambiguate.
      return `"${value}" is ambiguous — write 1299 or 1.299,00 instead.`;
    default:
      return `"${value}" is not a valid amount.`;
  }
}

/**
 * Builds the ProductVariantsBulkInput for one variant row group, reporting
 * invalid money cells as failures (they are dropped from the input, the rest
 * of the variant still saves — same per-cell semantics as the product base
 * fields). Money rules (Plan §5.5/§14): price is NOT nullable — clearing it
 * is a cell error; compareAtPrice cleared ⇒ explicit null.
 */
function buildVariantInput(group: BulkDiffRowGroup): { prepared: PreparedVariantInput | null; failures: BulkFailure[] } {
  const failures: BulkFailure[] = [];
  const input: VariantBulkInput = { id: group.rowId };
  const columnIds: string[] = [];

  for (const [columnId, value] of Object.entries(group.cells)) {
    switch (columnId) {
      case VAR_PRICE_COLUMN_ID: {
        const parsed = parseMoney(value);
        if (!parsed.ok) {
          failures.push(failureOf(group, moneyErrorMessage(parsed.error, value), columnId));
          break;
        }
        if (parsed.value === null) {
          // §14: price is not nullable at Shopify — clearing is not a valid
          // operation and must surface as a cell error, never a silent skip.
          failures.push(failureOf(group, "The price cannot be empty — Shopify requires a price on every variant.", columnId));
          break;
        }
        input.price = parsed.value;
        columnIds.push(columnId);
        break;
      }
      case VAR_COMPARE_AT_COLUMN_ID: {
        const parsed = parseMoney(value);
        if (!parsed.ok) {
          failures.push(failureOf(group, moneyErrorMessage(parsed.error, value), columnId));
          break;
        }
        // Cleared cell ⇒ explicit null (clears the compare-at price, §14).
        input.compareAtPrice = parsed.value;
        columnIds.push(columnId);
        break;
      }
      case VAR_SKU_COLUMN_ID:
        // SKU lives on the InventoryItem, not the variant — same path as
        // api.update-variant-match-key.tsx. "" clears the SKU (valid).
        input.inventoryItem = { sku: value };
        columnIds.push(columnId);
        break;
      case VAR_BARCODE_COLUMN_ID:
        input.barcode = value === "" ? null : value;
        columnIds.push(columnId);
        break;
      default:
        // Validation rejected unknown columns already — reaching this is a
        // programming error, surfaced per cell.
        failures.push(failureOf(group, `Column "${columnId}" is not editable on ${group.rowType}.`, columnId));
    }
  }

  if (columnIds.length === 0) return { prepared: null, failures };
  return { prepared: { group, input, columnIds }, failures };
}

/**
 * Persists the variant row groups of ONE product with ONE
 * productVariantsBulkUpdate (Plan §5.4). userErrors carry a field PATH ARRAY
 * (["variants","2","price"], §14 no. 1) — the index resolves the variant, the
 * tail the column, so the failure lands on exactly that cell. Echo semantics:
 * only values Shopify returns in `productVariants` are mirrored into the DB
 * (userErrors: [] alone is not success — CLAUDE.md invariant).
 */
async function persistVariantProductGroup(
  productId: string,
  groups: BulkDiffRowGroup[],
  deps: PersistDeps,
): Promise<BulkFailure[]> {
  const { db, gateway } = deps;
  const failures: BulkFailure[] = [];
  const sent: PreparedVariantInput[] = [];

  for (const group of groups) {
    const { prepared, failures: buildFailures } = buildVariantInput(group);
    failures.push(...buildFailures);
    if (prepared) sent.push(prepared);
  }
  if (sent.length === 0) return failures;

  const failEverySentCell = (message: string) => {
    for (const { group, columnIds } of sent) {
      for (const columnId of columnIds) failures.push(failureOf(group, message, columnId));
    }
  };

  try {
    const response = await gateway.graphql(PRODUCT_VARIANTS_BULK_UPDATE, {
      variables: { productId, variants: sent.map((s) => s.input) },
    });
    const data = (await response.json()) as {
      data?: {
        productVariantsBulkUpdate?: {
          productVariants?:
            | { id: string; sku?: string | null; price?: string | null; compareAtPrice?: string | null; barcode?: string | null }[]
            | null;
          userErrors?: { field?: string[] | string | null; message: string }[];
        };
      };
      errors?: { message: string }[];
    };
    // collectErrors pattern (api.update-variant-match-key.tsx): merge
    // top-level GraphQL errors with the mutation's userErrors.
    if (data.errors && data.errors.length > 0) {
      failEverySentCell(data.errors[0].message);
      return failures;
    }
    const payload = data.data?.productVariantsBulkUpdate;
    const userErrors = payload?.userErrors ?? [];

    if (userErrors.length > 0) {
      // §14 no. 1: `field` is an ARRAY of path segments
      // (["variants","2","price"]); tolerate the dot-joined string form too.
      // Resolve variants[i] → row group and the field tail → columnId.
      const messageByCell = new Map<string, string>(); // `${rowId}|${columnId}` → message
      for (const err of userErrors) {
        const path = Array.isArray(err.field)
          ? err.field
          : typeof err.field === "string"
            ? err.field.split(".")
            : [];
        const index = path.map((p) => parseInt(p, 10)).find((n) => Number.isInteger(n) && n >= 0);
        const tail = path.length > 0 ? path[path.length - 1] : "";
        const columnId = variantColumnForErrorField(tail);
        if (index !== undefined && index < sent.length && columnId) {
          messageByCell.set(`${sent[index].group.rowId}|${columnId}`, err.message);
        }
      }
      // The mutation applies atomically (no partial updates requested): cells
      // named in an error get the specific message, every other sent cell the
      // atomicity explanation. Nothing is mirrored.
      for (const { group, columnIds } of sent) {
        for (const columnId of columnIds) {
          const specific = messageByCell.get(`${group.rowId}|${columnId}`);
          failures.push(
            failureOf(
              group,
              specific ??
                (messageByCell.size > 0
                  ? "Not saved — another variant of the same product failed (Shopify applies the call atomically)."
                  : userErrors[0].message),
              columnId,
            ),
          );
        }
      }
      return failures;
    }

    // Echo check + DB mirror: only the values Shopify RETURNED go into the
    // cache (Plan §5.4 "nur zurückgemeldete Werte spiegeln").
    const echoed = payload?.productVariants ?? [];
    for (const { group, input, columnIds } of sent) {
      const echo = echoed?.find((v) => v.id === group.rowId);
      if (!echo) {
        for (const columnId of columnIds) {
          failures.push(failureOf(group, "Shopify did not confirm the variant update.", columnId));
        }
        continue;
      }
      const mirror: Record<string, unknown> = {};
      if (input.price !== undefined) mirror.price = moneyToDecimalString(echo.price ?? null);
      if (input.compareAtPrice !== undefined) {
        mirror.compareAtPrice = echo.compareAtPrice == null ? null : moneyToDecimalString(echo.compareAtPrice);
      }
      if (input.inventoryItem !== undefined) mirror.sku = echo.sku ?? null;
      if (input.barcode !== undefined) mirror.barcode = echo.barcode ?? null;
      await db.productVariant.updateMany({ where: { shopifyGid: group.rowId }, data: mirror });
    }
  } catch (err: unknown) {
    failEverySentCell(err instanceof Error ? err.message : String(err));
  }
  return failures;
}

// ─── Entry point ───────────────────────────────────────────────────────────

async function persistRow(group: BulkDiffRowGroup, deps: PersistDeps): Promise<BulkFailure[]> {
  // Foreign-locale groups (Phase 4) go through the verified translation path;
  // a market override without a locale has no meaning (primary content is
  // always global) and is rejected loudly.
  if (group.locale !== "") {
    return persistTranslationRow(group, deps);
  }
  if (group.marketId !== "") {
    return [
      failureOf(group, "A market-specific value requires a foreign language — primary content is always global."),
    ];
  }

  if (group.rowType === "product") {
    return persistProductRow(group, deps);
  }
  if (group.rowType === "metaobject") {
    return persistMetaobjectRow(group, deps);
  }
  if (group.rowType === "image") {
    return persistImageRow(group, deps);
  }

  try {
    await persistSingleMutationRow(group, deps);
    return [];
  } catch (err: unknown) {
    // Single-mutation rows fail as a whole — row-level failure (no columnId),
    // the UI falls back to marking the row's dirty cells.
    return [failureOf(group, err instanceof Error ? err.message : String(err))];
  }
}

/**
 * Applies a diff-only payload to Shopify + the DB content cache, one row
 * group at a time. Failures are per cell for product rows (§4.4) and per row
 * for the single-mutation types; neither ever aborts the rest of the batch.
 * `onProgress` lets callers (the detached Task runner) heartbeat progress
 * after every row.
 */
export async function applyBulkDiff(
  ctx: ApplyContext,
  diff: BulkDiffEntry[],
  onProgress?: (processed: number, total: number) => void | Promise<void>,
): Promise<BulkApplyResult> {
  const { db, shop, admin, columnsByType } = ctx;
  const gateway = new ShopifyApiGateway(admin, shop);
  const contentService = new ShopifyContentService(gateway as any); // eslint-disable-line @typescript-eslint/no-explicit-any

  const groups = groupDiffByRow(diff);

  // Published foreign locales for the Phase-4b invalidation come from the
  // caller (which already loaded them) — no extra fetch here.
  const foreignLocales = ctx.foreignLocales ?? [];
  // One lookup per run for the §6.6 invalidation switch (Settings →
  // Übersetzungen). Skipped entirely when there is nothing to invalidate
  // against, so a test context without locales makes no DB call.
  const { isPurgeOnPrimaryChangeEnabled } = await import(
    "../translations/translation-change-policy.server"
  );
  const purgeStaleTranslations =
    foreignLocales.length > 0 ? await isPurgeOnPrimaryChangeEnabled(shop, db) : false;

  // Digest prefetch for every foreign group in ONE batched pass (Plan §6.1:
  // only digests are bündelbar — the register itself is per resource).
  // Clears need no digest; only keys that will be REGISTERED are collected.
  const foreignResourceIds: string[] = [];
  const foreignKeys = new Set<string>();
  for (const group of groups) {
    if (group.locale === "") continue;
    const columns = columnsByType[group.rowType];
    let hasWrite = false;
    for (const [columnId, value] of Object.entries(group.cells)) {
      if (value === "") continue;
      const column = columns.find((c) => c.id === columnId);
      // The featured-image alt's key is a DB key — its digest lives on the
      // IMAGE resource, not on this row. Collecting it here would batch a
      // translatableResource(collection) query for a key that can never exist
      // there; the write path fetches the image's digest itself.
      if (column && isFeaturedImageAltColumn(column)) continue;
      const key = column ? translationKeyForColumn(column, group.rowType) : null;
      if (key) {
        foreignKeys.add(key);
        hasWrite = true;
      }
    }
    if (hasWrite) foreignResourceIds.push(group.rowId);
  }
  // Sub-resource cells (metafields, product options) translate on resources of
  // their OWN — their cached GIDs and digests are loaded in the same pass, so a
  // 250-row save still costs one batched digest query instead of one per cell.
  const subResourceProductIds = new Set<string>();
  const subResourceMetafieldKeys = new Map<string, { namespace: string; key: string }>();
  let needOptionCache = false;
  for (const group of groups) {
    if (group.locale === "" || group.rowType !== "product") continue;
    for (const columnId of Object.keys(group.cells)) {
      const column = columnsByType[group.rowType].find((c) => c.id === columnId);
      if (!column || !isSubResourceColumn(column)) continue;
      subResourceProductIds.add(group.rowId);
      if (column.kind === "metafield" && column.metafieldNamespace && column.metafieldKey) {
        subResourceMetafieldKeys.set(column.id, {
          namespace: column.metafieldNamespace,
          key: column.metafieldKey,
        });
      }
      if (column.kind === "option") needOptionCache = true;
    }
  }
  const subResourceCaches =
    subResourceProductIds.size > 0
      ? await loadProductSubResourceCaches(
          db,
          shop,
          [...subResourceProductIds],
          [...subResourceMetafieldKeys.values()],
          needOptionCache,
        )
      : new Map<string, ProductSubResourceCache>();
  for (const group of groups) {
    if (group.locale === "" || !subResourceCaches.has(group.rowId)) continue;
    const cache = subResourceCaches.get(group.rowId)!;
    for (const [columnId, value] of Object.entries(group.cells)) {
      // Clears need no digest — only registers do.
      if (value === "") continue;
      const column = columnsByType[group.rowType].find((c) => c.id === columnId);
      if (!column || !isSubResourceColumn(column)) continue;
      for (const target of subResourceTargetsForColumn(column, cache) ?? []) {
        foreignResourceIds.push(target.resourceId);
        foreignKeys.add(target.key);
      }
    }
  }

  const digests =
    foreignResourceIds.length > 0
      ? await loadDigestsForRows(gateway, foreignResourceIds, [...foreignKeys])
      : new Map<string, Map<string, string>>();

  // §Phase 3.3 — ONE read per run, not per row. A failed lookup falls back to
  // the column's own default (on): the setting protects URLs, so the safe
  // failure is to protect them, and an unwanted redirect is removable while a
  // missed one costs traffic no one notices.
  const autoHandleRedirect = ctx.autoHandleRedirect ?? (await loadAutoHandleRedirect(db, shop));

  const deps: PersistDeps = {
    db,
    shop,
    gateway,
    contentService,
    columnsByType,
    digests,
    digestRefetched: new Set(),
    featuredImageIds: new Map(),
    foreignLocales,
    subResourceCaches,
    purgeStaleTranslations,
    autoHandleRedirect,
  };
  const failures: BulkFailure[] = [];
  let saved = 0;

  // Persist units (Plan §5.4 groupDiffByMutationTarget): primary variant row
  // groups of the SAME product collapse into ONE productVariantsBulkUpdate;
  // everything else stays one unit per row group. The row→product mapping is
  // resolved SERVER-side from the cache (never trusted from the client), and
  // it doubles as the tenancy check — a variant that doesn't belong to this
  // shop simply doesn't resolve.
  type PersistUnit =
    | { kind: "single"; groups: [BulkDiffRowGroup] }
    | { kind: "variantProduct"; productId: string; groups: BulkDiffRowGroup[] }
    | { kind: "unresolvedVariant"; groups: [BulkDiffRowGroup] };

  const units: PersistUnit[] = [];
  const variantPrimaryGroups = groups.filter((g) => g.rowType === "variant" && g.locale === "");
  for (const group of groups) {
    if (group.rowType === "variant" && group.locale === "") continue; // collected below
    units.push({ kind: "single", groups: [group] });
  }
  if (variantPrimaryGroups.length > 0) {
    const owned = await db.productVariant.findMany({
      where: { shopifyGid: { in: variantPrimaryGroups.map((g) => g.rowId) }, product: { shop } },
      select: { shopifyGid: true, productId: true },
    });
    const productIdByGid = new Map(owned.map((v) => [v.shopifyGid, v.productId] as const));
    const byProduct = new Map<string, BulkDiffRowGroup[]>();
    for (const group of variantPrimaryGroups) {
      const productId = productIdByGid.get(group.rowId);
      if (!productId) {
        units.push({ kind: "unresolvedVariant", groups: [group] });
        continue;
      }
      const list = byProduct.get(productId) ?? [];
      list.push(group);
      byProduct.set(productId, list);
    }
    for (const [productId, productGroups] of byProduct) {
      units.push({ kind: "variantProduct", productId, groups: productGroups });
    }
  }

  let processedGroups = 0;
  for (const unit of units) {
    let unitFailures: BulkFailure[];
    try {
      if (unit.kind === "variantProduct") {
        unitFailures = await persistVariantProductGroup(unit.productId, unit.groups, deps);
      } else if (unit.kind === "unresolvedVariant") {
        unitFailures = [
          failureOf(
            unit.groups[0],
            "This variant is not in the local cache — reload/resync the product first.",
          ),
        ];
      } else {
        unitFailures = await persistRow(unit.groups[0], deps);
      }
    } catch (err: unknown) {
      // Defensive: the persist functions report expected failures themselves —
      // this only catches the unexpected (DB down, …) so the batch continues.
      const message = err instanceof Error ? err.message : String(err);
      unitFailures = unit.groups.map((g) => failureOf(g, message));
    }
    // saved counts ROW GROUPS without any attributed failure — unchanged
    // semantics for single-row units, per-variant granularity for units.
    for (const group of unit.groups) {
      if (!unitFailures.some((f) => f.rowId === group.rowId)) saved++;
    }
    failures.push(...unitFailures);
    processedGroups += unit.groups.length;
    if (onProgress) await onProgress(processedGroups, groups.length);
  }

  // §10.5: summaries only — never cell values.
  debugLog.bulkSave("diff applied", {
    rows: groups.length,
    cells: diff.length,
    saved,
    failedCells: failures.length,
    failedRows: new Set(failures.map((f) => f.rowId)).size,
  });

  return { saved, failures };
}
