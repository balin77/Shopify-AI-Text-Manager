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
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { ShopifyApiGateway } from "../shopify-api-gateway.service";
import { ShopifyContentService } from "../../../src/services/shopify-content.service";
import {
  METAFIELDS_SET,
  METAFIELDS_DELETE,
  PRODUCT_OPTION_UPDATE,
} from "../../graphql/content.mutations";
import { debugLog } from "../../utils/debug";
import { markTranslationSaved } from "../../utils/translation-save-lock.server";
import {
  loadDigestsForRows,
  fetchDigestsForResource,
  registerAndVerify,
  removeAndVerify,
  translationKeyForColumn,
  CONTENT_RESOURCE_TYPE_BY_ROW_TYPE,
  type TranslationInput,
} from "./translations.server";
import {
  groupDiffByRow,
  parseListMetafieldInput,
  parseMoney,
  METAFIELD_TYPE_LIST_SINGLE_LINE,
  METAFIELDS_SET_CHUNK,
  IMG_ALT_COLUMN_ID,
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

interface ApplyContext {
  db: PrismaClient;
  shop: string;
  admin: AdminApiContext;
  /** Server-built column universe (buildServerColumnsByType) — resolves each
   * diff cell to its descriptor (metafield type/namespace/key, option
   * position, …). Both save entrances validated the diff against the SAME
   * object, so an unknown column here is a hard bug, not bad input. */
  columnsByType: Record<BulkRowType, ColumnDescriptor[]>;
}

const PRODUCT_STATUSES = new Set(["ACTIVE", "DRAFT", "ARCHIVED"]);

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
        failureOf(group, `Invalid status "${fields.status}" — expected ACTIVE, DRAFT or ARCHIVED.`, "field.status"),
      );
      delete fields.status;
    } else {
      fields.status = s;
    }
  }

  const remainingColumnIds = cells.baseColumnIds.filter(
    (columnId) => fields[columnId.slice("field.".length)] !== undefined,
  );
  if (remainingColumnIds.length === 0) return failures;

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
    if (fields.seoTitle !== undefined || fields.seoDescription !== undefined) {
      // Partial SEO clobber guard: productUpdate treats `seo` as a unit —
      // sending only `title` wipes the existing description (and vice versa).
      // When only one half is dirty, load the untouched half from the DB
      // cache and send it too. See "Partial SEO clobber" in CLAUDE.md.
      const partialSeo = (fields.seoTitle !== undefined) !== (fields.seoDescription !== undefined);
      let untouched: { seoTitle: string | null; seoDescription: string | null } | null = null;
      if (partialSeo) {
        untouched = await db.product.findUnique({
          where: { shop_id: { shop, id } },
          select: { seoTitle: true, seoDescription: true },
        });
      }
      input.seo = {
        title: fields.seoTitle !== undefined ? fields.seoTitle : untouched?.seoTitle ?? "",
        description:
          fields.seoDescription !== undefined ? fields.seoDescription : untouched?.seoDescription ?? "",
      };
    }
    const response = await gateway.graphql(
      `#graphql
        mutation seoBulkMetaProductUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            userErrors { field message }
          }
        }`,
      { variables: { input } },
    );
    const data = (await response.json()) as {
      data?: { productUpdate?: { userErrors?: { field?: string[] | string; message: string }[] } };
    };
    const userErrors = data.data?.productUpdate?.userErrors ?? [];
    if (userErrors.length > 0) throw new Error(userErrors[0].message);

    const dbData: Record<string, unknown> = { lastSyncedAt: new Date() };
    for (const key of Object.keys(fields)) dbData[key] = fields[key];
    await db.product.update({ where: { shop_id: { shop, id } }, data: dbData });
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
  const { db, gateway } = deps;
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
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      for (const entry of setChunk) failures.push(failureOf(group, message, entry.columnId));
    }
  }

  if (deletes.length > 0) {
    try {
      const response = await gateway.graphql(METAFIELDS_DELETE, {
        variables: { metafields: deletes.map((d) => d.identifier) },
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
        for (const entry of deletes) failures.push(failureOf(group, userErrors[0].message, entry.columnId));
      } else {
        // Delete-echo check (CLAUDE.md): only remove the local row when
        // Shopify confirmed the removal — otherwise state diverges.
        const echoed = data.data?.metafieldsDelete?.deletedMetafields ?? [];
        for (const entry of deletes) {
          const confirmed = echoed?.some(
            (d) => d.namespace === entry.identifier.namespace && d.key === entry.identifier.key,
          );
          if (!confirmed) {
            failures.push(failureOf(group, "Shopify did not confirm the metafield removal.", entry.columnId));
            continue;
          }
          await db.productMetafield.deleteMany({
            where: { productId, namespace: entry.identifier.namespace, key: entry.identifier.key },
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      for (const entry of deletes) failures.push(failureOf(group, message, entry.columnId));
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
        data?: { productOptionUpdate?: { userErrors?: { field?: string[] | string; message: string }[] } };
      };
      const userErrors = data.data?.productOptionUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        for (const columnId of validColumnIds) failures.push(failureOf(group, userErrors[0].message, columnId));
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      for (const columnId of validColumnIds) failures.push(failureOf(group, message, columnId));
    }
  }

  return failures;
}

// ─── Product row: stage 4 — main-image alt-text via productUpdateMedia ─────

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

  try {
    // DELIBERATELY productUpdateMedia (Plan §14 no. 3): the mutation is
    // deprecated in favour of fileUpdate, but fileUpdate requires the
    // write_files scope → re-consent of every installed merchant (§11
    // no-go). This is also the existing alt-text write path of the app
    // (app/actions/product/update.actions.ts). Revisit only when a scope
    // event happens anyway.
    const response = await gateway.graphql(
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
          media: [{ id: image.mediaId, alt: imageAlt.value }],
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
    const mediaErrors = payload?.media?.[0]?.mediaErrors ?? [];
    if (mediaUserErrors.length > 0) {
      fail(mediaUserErrors[0].message);
      return failures;
    }
    if (mediaErrors.length > 0) {
      fail(mediaErrors[0].message);
      return failures;
    }
    if (!payload?.media || payload.media.length === 0) {
      fail("Shopify did not confirm the alt-text write.");
      return failures;
    }

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

  switch (type) {
    case "collection": {
      // Same partial-SEO clobber guard as products — collectionUpdate also
      // treats `seo` as a unit.
      let seo: { title: string; description: string } | undefined;
      if (fields.seoTitle !== undefined || fields.seoDescription !== undefined) {
        const partialSeo = (fields.seoTitle !== undefined) !== (fields.seoDescription !== undefined);
        let untouched: { seoTitle: string | null; seoDescription: string | null } | null = null;
        if (partialSeo) {
          untouched = await db.collection.findUnique({
            where: { shop_id: { shop, id } },
            select: { seoTitle: true, seoDescription: true },
          });
        }
        seo = {
          title: fields.seoTitle !== undefined ? fields.seoTitle : untouched?.seoTitle ?? "",
          description:
            fields.seoDescription !== undefined
              ? fields.seoDescription
              : untouched?.seoDescription ?? "",
        };
      }
      await contentService.updateCollection(id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
        ...(fields.descriptionHtml !== undefined ? { descriptionHtml: fields.descriptionHtml } : {}),
        ...(seo ? { seo } : {}),
      });
      await db.collection.update({ where: { shop_id: { shop, id } }, data: dbData });
      break;
    }
    case "page": {
      await contentService.updatePage(id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
        ...(fields.body !== undefined ? { body: fields.body } : {}),
        ...(fields.seoTitle !== undefined ? { seoTitle: fields.seoTitle } : {}),
        ...(fields.seoDescription !== undefined ? { seoDescription: fields.seoDescription } : {}),
      });
      await db.page.update({ where: { shop_id: { shop, id } }, data: dbData });
      break;
    }
    case "article": {
      // Article SEO title/description are stored as global.title_tag /
      // description_tag metafields, written inline by updateArticle() (see
      // ShopifyContentService.updateArticle) — same as Page/Blog.
      await contentService.updateArticle(id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
        ...(fields.body !== undefined ? { body: fields.body } : {}),
        ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
        ...(fields.seoTitle !== undefined ? { seoTitle: fields.seoTitle } : {}),
        ...(fields.seoDescription !== undefined ? { seoDescription: fields.seoDescription } : {}),
      });
      await db.article.update({ where: { shop_id: { shop, id } }, data: dbData });
      break;
    }
    default: {
      // Exhaustiveness backstop — a new BulkRowType without a persist branch
      // must fail the row loudly, never silently skip the Shopify push while
      // the caller reports success (the false-success pattern from CLAUDE.md).
      throw new Error(`Unsupported row type "${type}".`);
    }
  }
}

// ─── Foreign-locale rows: translationsRegister/-Remove with verification ───

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
  for (const [columnId, value] of Object.entries(group.cells)) {
    const column = columns.find((c) => c.id === columnId);
    const key = column ? translationKeyForColumn(column) : null;
    if (!column || !key) {
      // Validation rejected non-translatable columns already — reaching this
      // is a programming error, surfaced per cell (never silently dropped).
      failures.push(failureOf(group, `Column "${columnId}" is not translatable.`, columnId));
      continue;
    }
    if (value === "") clears.push({ columnId, key, value });
    else writes.push({ columnId, key, value });
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
      const { confirmedKeys, userErrors } = await registerAndVerify(gateway, resourceId, inputs);
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
          update: { value: write.value, digest: write.digest, resourceType },
          create: {
            shop,
            resourceId,
            resourceType,
            key: write.key,
            value: write.value,
            locale,
            marketId,
            digest: write.digest,
          },
        });
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
        await db.contentTranslation.deleteMany({
          where: { shop, resourceId, key: clear.key, locale, marketId },
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      for (const clear of clears) failures.push(failureOf(group, message, clear.columnId));
    }
  }

  return failures;
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
          failures.push(
            failureOf(
              group,
              parsed.error === "negative" ? "The price cannot be negative." : `"${value}" is not a valid amount.`,
              columnId,
            ),
          );
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
          failures.push(
            failureOf(
              group,
              parsed.error === "negative"
                ? "The compare-at price cannot be negative."
                : `"${value}" is not a valid amount.`,
              columnId,
            ),
          );
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
      const key = column ? translationKeyForColumn(column) : null;
      if (key) {
        foreignKeys.add(key);
        hasWrite = true;
      }
    }
    if (hasWrite) foreignResourceIds.push(group.rowId);
  }
  const digests =
    foreignResourceIds.length > 0
      ? await loadDigestsForRows(gateway, foreignResourceIds, [...foreignKeys])
      : new Map<string, Map<string, string>>();

  const deps: PersistDeps = {
    db,
    shop,
    gateway,
    contentService,
    columnsByType,
    digests,
    digestRefetched: new Set(),
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
