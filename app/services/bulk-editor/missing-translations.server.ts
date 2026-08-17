/**
 * Bulk editor — candidate scan for the "translate missing" page.
 *
 * ONE source of truth for "what is missing": the page loader lists it, the
 * /api/ai task re-runs the very same scan before translating anything. The
 * client's selection is replayed over the server's own scan (§ selection model
 * in translate-missing.shared.ts) — a client-supplied cell list is never
 * trusted, and a cell that got filled in the meantime silently drops out.
 *
 * "Missing" is evaluated GLOBALLY (marketId "") — the page deliberately has no
 * market dimension (a market override is a per-cell decision, and the loader's
 * missing-detection has no market layer). A field counts as missing when the
 * PRIMARY value is non-empty (there is something to translate) and the foreign
 * locale has no non-empty translation.
 *
 * Server-only: Prisma + the row loader. The shapes it returns are the
 * client-safe ones from translate-missing.shared.ts.
 */

import type { PrismaClient } from "@prisma/client";
import { loadBulkRows, type BulkAdminClient } from "./load.server";
import {
  translationKeyForColumn,
  isSubResourceColumn,
  subResourceCacheFromRow,
  subResourceTargetsForColumn,
  CONTENT_RESOURCE_TYPE_BY_ROW_TYPE,
} from "./translations.server";
import {
  primaryValueForColumn,
  LIST_DISPLAY_SEPARATOR,
  METAFIELD_TYPE_SINGLE_LINE,
  isFeaturedImageAltColumn,
  METAFIELD_TYPE_MULTI_LINE,
  type BulkFilterId,
  type BulkRow,
  type BulkRowType,
  type ColumnDescriptor,
} from "./columns.shared";
import {
  MAX_TRANSLATE_CANDIDATE_ITEMS,
  MAX_TRANSLATE_SCAN_ROWS,
  TRANSLATE_SCAN_CHUNK,
  type MissingItem,
} from "./translate-missing.shared";

/**
 * Columns the page offers for AI translation, in display order.
 *
 * - `field` columns: everything Shopify has a translatable key for — INCLUDING
 *   `field.handle` (the old modal excluded it; the page offers it opt-in and
 *   normalizes the AI's slug, see translate-missing.shared.ts).
 * - `mofield` columns: metaobject field translations go through the same
 *   verified write path (MetaobjectTranslation). Only single/multi-line text —
 *   `list.*` fields carry their entries in ONE string separated by "|", which a
 *   translation would shatter, and rich_text is read-only everywhere.
 * - `metafield` and `option` columns: their translations ride on their OWN
 *   Shopify resource (the Metafield gid, the ProductOption / ProductOptionValue
 *   gids), which applyBulkDiff writes through the verified sub-resource path.
 * - The product row's `img.alt` column (kind "image") is NOT offered: it can
 *   only ever address the MAIN image. Alt-texts are translated on the IMAGE row
 *   type instead, where the row id IS the MediaImage GID and the alt column is
 *   an ordinary translatable field column (key "alt").
 */
export function translateCandidateColumns(
  columns: ColumnDescriptor[],
  type: BulkRowType,
  moType: string,
): ColumnDescriptor[] {
  return columns.filter((column) => {
    if (!column.translatable) return false;
    if (column.kind === "field") return translationKeyForColumn(column, type) !== null;
    if (column.kind === "mofield") {
      if (type !== "metaobject" || (moType && column.moType !== moType)) return false;
      return (
        column.moFieldType === METAFIELD_TYPE_SINGLE_LINE || column.moFieldType === METAFIELD_TYPE_MULTI_LINE
      );
    }
    // Metafield + option columns translate on their own Shopify resource
    // (apply.server.ts persistSubResourceTranslations). Whether a given ROW can
    // actually back them (cached gids, non-linked option) is decided per row in
    // the scan, not here.
    if (column.kind === "metafield") {
      // Same text-type filter as the metaobject fields: a list metafield holds
      // its entries as ONE json string, which a translation would shatter.
      return (
        type === "product" &&
        (column.metafieldType === METAFIELD_TYPE_SINGLE_LINE ||
          column.metafieldType === METAFIELD_TYPE_MULTI_LINE)
      );
    }
    if (column.kind === "option") return type === "product";
    // The featured-image alt writes through applyBulkDiff like everything else
    // here (its own third shape: Shopify target = the image GID, DB mirror =
    // the parent row), so it is a legitimate candidate — but only on the two
    // row types that HAVE a featured image.
    if (isFeaturedImageAltColumn(column)) return type === "collection" || type === "article";
    return false;
  });
}

/** Shopify translatable-content key of a candidate column. */
export function candidateTranslationKey(column: ColumnDescriptor, type: BulkRowType): string | null {
  if (column.kind === "mofield") return column.moFieldKey ?? null;
  return translationKeyForColumn(column, type);
}

/** The row's PRIMARY value for a candidate column — the AI's source text. An
 * option-VALUES column yields the joined list, exactly as the grid cell shows
 * it (the write splits it back apart, positionally). */
export function candidateSourceValue(row: BulkRow, column: ColumnDescriptor): string {
  if (isFeaturedImageAltColumn(column)) return row.imageAlt ?? "";
  if (column.kind === "mofield") return row.moFields?.[column.id] ?? "";
  if (column.kind === "metafield") return row.metafields?.[column.id]?.value ?? "";
  if (column.kind === "option") {
    const option = row.options?.find((o) => o.position === column.optionPosition);
    if (!option) return "";
    return column.optionField === "name"
      ? option.name
      : option.values.map((v) => v.name).join(LIST_DISPLAY_SEPARATOR);
  }
  return primaryValueForColumn(row, column);
}

export interface MissingScanOptions {
  type: BulkRowType;
  search: string;
  filters: BulkFilterId[];
  moType: string;
  /** Published, non-primary shop locales. */
  foreignLocales: string[];
  /** Candidate columns (already plan-filtered by the caller). */
  columns: ColumnDescriptor[];
  /** Blog rows are live-fetched — the loader needs the admin client. */
  admin?: BulkAdminClient;
  /** Attach the primary source texts (+ the row's handle). The TASK needs
   * them; the page's loader does not — shipping every product description to
   * the browser to draw a checkbox list would be pure payload. */
  withSources?: boolean;
}

export interface MissingScanResult {
  /** EVERY candidate of the scan window, in row order — the caller slices the
   * page (and the runner walks it until the unit cap). */
  items: MissingItem[];
  /** columnId → locale → number of missing units in the whole window. */
  unitsByColumnLocale: Record<string, Record<string, number>>;
  /** Rows matching the filter (may exceed the scanned window). */
  matchedRows: number;
  scannedRows: number;
  /** True when the filter matched more rows than MAX_TRANSLATE_SCAN_ROWS — the
   * list and every run cover the first N only, and the UI says so. */
  scanTruncated: boolean;
}

/**
 * Exactly the dynamic product payloads the candidate columns need — nothing
 * more. Metafield/option columns carry their own namespace/key/position, so the
 * scan derives its load plan from the columns instead of taking the caller's
 * (wider) grid configuration.
 */
function productCellsFor(
  columns: ColumnDescriptor[],
): NonNullable<Parameters<typeof loadBulkRows>[2]["productCells"]> {
  const metafieldSpecs = columns
    .filter((c) => c.kind === "metafield" && c.metafieldNamespace && c.metafieldKey)
    .map((c) => ({
      namespace: c.metafieldNamespace as string,
      key: c.metafieldKey as string,
      type: c.metafieldType ?? METAFIELD_TYPE_SINGLE_LINE,
    }));
  return {
    metafieldSpecs,
    caps: {
      metafields: metafieldSpecs.length > 0,
      options: columns.some((c) => c.kind === "option"),
      imageAlt: false,
    },
  };
}

export async function scanMissingTranslations(
  db: PrismaClient,
  shop: string,
  opts: MissingScanOptions,
): Promise<MissingScanResult> {
  const empty: MissingScanResult = {
    items: [],
    unitsByColumnLocale: {},
    matchedRows: 0,
    scannedRows: 0,
    scanTruncated: false,
  };
  if (opts.foreignLocales.length === 0 || opts.columns.length === 0) return empty;

  // columnId → Shopify key. Bijective per row type.
  const keyByColumnId = new Map<string, string>();
  for (const column of opts.columns) {
    if (isSubResourceColumn(column)) continue;
    const key = candidateTranslationKey(column, opts.type);
    if (key) keyByColumnId.set(column.id, key);
  }
  if (keyByColumnId.size === 0 && !opts.columns.some(isSubResourceColumn)) return empty;
  const keys = [...new Set(keyByColumnId.values())];
  // Columns whose translation lives on their own Shopify resource — resolved
  // per ROW below (a linked option or an uncached metafield simply has no
  // target and therefore no candidate).
  const subColumns = opts.columns.filter(isSubResourceColumn);
  const productCells = productCellsFor(opts.columns);

  // "missingTranslation" is a FOREIGN-view filter (load.server.ts gates every
  // one of its branches on locale !== ""), and this scan runs on the primary
  // view — carrying it along would leave it silently inert while `matchedRows`
  // reported an unfiltered total. It is also redundant: this page IS the
  // missing-translation view.
  const filters = opts.filters.filter((f) => f !== "missingTranslation");

  const items: MissingItem[] = [];
  const unitsByColumnLocale: Record<string, Record<string, number>> = {};
  let matchedRows = 0;
  let scannedRows = 0;
  // The OFFSET is advanced by the requested window, not by the returned row
  // count. The image union legitimately returns fewer rows than asked for (it
  // drops library copies of images the product segment already served), and
  // advancing by the count would re-read the tail of the previous chunk —
  // duplicate candidates and doubled unit estimates.
  let scanOffset = 0;
  let exhausted = false;

  // Chunked walk instead of one big window: rows that are already fully
  // translated must NOT occupy the budget, otherwise a shop whose first N rows
  // are done would be told "nothing is missing" forever.
  while (scannedRows < MAX_TRANSLATE_SCAN_ROWS && items.length < MAX_TRANSLATE_CANDIDATE_ITEMS) {
    const take = Math.min(TRANSLATE_SCAN_CHUNK, MAX_TRANSLATE_SCAN_ROWS - scannedRows);
    const { rows, total } = await loadBulkRows(db, shop, {
      type: opts.type,
      // Primary view: the scan reads primary values and compares them against
      // the translation tables itself.
      locale: "",
      marketId: "",
      search: opts.search,
      filters,
      sort: null,
      skip: scanOffset,
      take,
      productCells,
      admin: opts.admin,
      moType: opts.moType,
    });
    matchedRows = total;
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    scannedRows += rows.length;
    scanOffset += take;

    const translated = await loadTranslatedLocales(db, shop, opts, rows, keys);
    const subTranslated = await loadSubResourceTranslatedLocales(db, shop, opts, rows, subColumns);
    for (const row of rows) {
      const byKey = translated.get(row.id);
      const columns: MissingItem["columns"] = [];
      const subCache = subColumns.length > 0 ? subResourceCacheFromRow(row) : null;
      for (const column of opts.columns) {
        if (subCache && isSubResourceColumn(column)) {
          const entry = missingSubResourceEntry(row, column, subCache, opts, subTranslated);
          if (!entry) continue;
          columns.push(entry);
          const byLocale = (unitsByColumnLocale[column.id] ??= {});
          for (const locale of entry.locales) byLocale[locale] = (byLocale[locale] ?? 0) + 1;
          continue;
        }
        const key = keyByColumnId.get(column.id);
        if (!key) continue;
        // Nothing to translate without a primary value — the same rule the old
        // task used, and the reason an "empty everywhere" field never shows up.
        const source = candidateSourceValue(row, column);
        if (source.trim() === "") continue;
        const have = byKey?.get(key);
        const missing = opts.foreignLocales.filter((locale) => !have?.has(locale));
        if (missing.length === 0) continue;
        columns.push({
          columnId: column.id,
          locales: missing,
          ...(opts.withSources ? { source } : {}),
        });
        const byLocale = (unitsByColumnLocale[column.id] ??= {});
        for (const locale of missing) byLocale[locale] = (byLocale[locale] ?? 0) + 1;
      }
      if (columns.length === 0) continue;
      items.push({
        rowId: row.id,
        title: row.title || row.handle || row.id,
        subtitle: subtitleOf(row),
        ...(row.imageUrl ? { imageUrl: row.imageUrl } : {}),
        ...(opts.withSources ? { primaryHandle: row.handle ?? "" } : {}),
        columns,
      });
    }

    if (scanOffset >= total) {
      exhausted = true;
      break;
    }
  }

  return {
    items,
    unitsByColumnLocale,
    matchedRows,
    scannedRows,
    // Truncated = the walk stopped on a budget while rows were left over. When
    // it ran out of rows, the result is complete no matter how far it walked.
    scanTruncated: !exhausted && scannedRows < matchedRows,
  };
}

/**
 * One sub-resource column of one row → its missing-translation entry, or null
 * when nothing is missing (or the row cannot back the column at all: linked
 * option, uncached metafield, legacy option values without gids).
 *
 * A VALUES cell covers SEVERAL ProductOptionValue resources but stays ONE cell:
 * it counts as missing as soon as ONE entry lacks a translation, and it carries
 * the entries that are already translated (`existingListValues`) so the task can
 * merge instead of overwriting them.
 */
function missingSubResourceEntry(
  row: BulkRow,
  column: ColumnDescriptor,
  cache: ReturnType<typeof subResourceCacheFromRow>,
  opts: MissingScanOptions,
  translatedByLocale: Map<string, Map<string, string>>,
): MissingItem["columns"][number] | null {
  const targets = subResourceTargetsForColumn(column, cache);
  if (!targets || targets.length === 0) return null;
  const source = candidateSourceValue(row, column);
  if (source.trim() === "") return null;

  const isList = column.kind === "option" && column.optionField === "values";
  const missing: string[] = [];
  const existingByLocale: Record<string, string[]> = {};
  for (const locale of opts.foreignLocales) {
    const byResource = translatedByLocale.get(locale);
    const values = targets.map((t) => byResource?.get(t.resourceId) ?? "");
    if (values.every((v) => v !== "")) continue;
    missing.push(locale);
    if (isList) existingByLocale[locale] = values;
  }
  if (missing.length === 0) return null;

  return {
    columnId: column.id,
    locales: missing,
    ...(opts.withSources ? { source } : {}),
    ...(opts.withSources && isList ? { existingListValuesByLocale: existingByLocale } : {}),
  };
}

/**
 * locale → (sub-resource gid → non-empty GLOBAL translation) for the page's
 * rows. One query for every metafield/option/option-value of the chunk.
 */
async function loadSubResourceTranslatedLocales(
  db: PrismaClient,
  shop: string,
  opts: MissingScanOptions,
  rows: BulkRow[],
  subColumns: ColumnDescriptor[],
): Promise<Map<string, Map<string, string>>> {
  const byLocale = new Map<string, Map<string, string>>();
  if (subColumns.length === 0) return byLocale;
  const ids = new Set<string>();
  for (const row of rows) {
    const cache = subResourceCacheFromRow(row);
    for (const column of subColumns) {
      for (const target of subResourceTargetsForColumn(column, cache) ?? []) ids.add(target.resourceId);
    }
  }
  if (ids.size === 0) return byLocale;

  const records = await db.contentTranslation.findMany({
    where: {
      shop,
      resourceId: { in: [...ids] },
      marketId: "",
      key: { in: ["value", "name"] },
      locale: { in: opts.foreignLocales },
    },
    select: { resourceId: true, locale: true, value: true },
  });
  for (const record of records) {
    if (!record.value || record.value.trim() === "") continue;
    let map = byLocale.get(record.locale);
    if (!map) {
      map = new Map();
      byLocale.set(record.locale, map);
    }
    map.set(record.resourceId, record.value);
  }
  return byLocale;
}

/** Second line of an item — enough context to tell two similar titles apart. */
function subtitleOf(row: BulkRow): string {
  if (row.type === "article") return row.blogTitle || row.handle || "";
  if (row.type === "metaobject") return row.handle || row.moType || "";
  return row.handle || "";
}

/**
 * rowId → key → set of locales that ALREADY carry a non-empty global
 * translation. Metaobjects read their own table (MetaobjectTranslation);
 * everything else reads ContentTranslation — the same split the grid loader
 * uses.
 */
async function loadTranslatedLocales(
  db: PrismaClient,
  shop: string,
  opts: MissingScanOptions,
  rows: BulkRow[],
  keys: string[],
): Promise<Map<string, Map<string, Set<string>>>> {
  const rowIds = rows.map((r) => r.id);
  // Image rows: alt translations live in ProductImageAltTranslation, keyed by
  // the ProductImage CACHE row (the row id is the MediaImage GID).
  if (opts.type === "image") {
    const cacheIdByRow = new Map<string, string>();
    for (const row of rows) if (row.imageCacheId) cacheIdByRow.set(row.imageCacheId, row.id);
    // Library images (no ProductImage row) use the generic ContentTranslation
    // table under resourceType "MediaImage".
    const libraryIds = rows.filter((r) => !r.imageCacheId).map((r) => r.id);
    const byRow = new Map<string, Map<string, Set<string>>>();
    const mark = (rowId: string, locale: string) => {
      let byKey = byRow.get(rowId);
      if (!byKey) {
        byKey = new Map();
        byRow.set(rowId, byKey);
      }
      const locales = byKey.get("alt") ?? new Set<string>();
      locales.add(locale);
      byKey.set("alt", locales);
    };

    if (cacheIdByRow.size > 0) {
      const records = await db.productImageAltTranslation.findMany({
        where: {
          image: { id: { in: [...cacheIdByRow.keys()] }, product: { shop } },
          marketId: "",
          locale: { in: opts.foreignLocales },
        },
        select: { imageId: true, locale: true, altText: true },
      });
      for (const record of records) {
        if (!record.altText || record.altText.trim() === "") continue;
        const rowId = cacheIdByRow.get(record.imageId);
        if (rowId) mark(rowId, record.locale);
      }
    }
    if (libraryIds.length > 0) {
      const records = await db.contentTranslation.findMany({
        where: {
          shop,
          resourceType: "MediaImage",
          resourceId: { in: libraryIds },
          marketId: "",
          locale: { in: opts.foreignLocales },
        },
        select: { resourceId: true, locale: true, value: true },
      });
      for (const record of records) {
        if (!record.value || record.value.trim() === "") continue;
        mark(record.resourceId, record.locale);
      }
    }
    return byRow;
  }
  const isMetaobject = opts.type === "metaobject";
  const records = isMetaobject
    ? (
        await db.metaobjectTranslation.findMany({
          where: {
            shop,
            metaobjectId: { in: rowIds },
            marketId: "",
            key: { in: keys },
            locale: { in: opts.foreignLocales },
          },
          select: { metaobjectId: true, key: true, locale: true, value: true },
        })
      ).map((t) => ({ rowId: t.metaobjectId, key: t.key, locale: t.locale, value: t.value }))
    : (
        await db.contentTranslation.findMany({
          where: {
            shop,
            resourceType: CONTENT_RESOURCE_TYPE_BY_ROW_TYPE[opts.type],
            resourceId: { in: rowIds },
            marketId: "",
            key: { in: keys },
            locale: { in: opts.foreignLocales },
          },
          select: { resourceId: true, key: true, locale: true, value: true },
        })
      ).map((t) => ({ rowId: t.resourceId, key: t.key, locale: t.locale, value: t.value }));

  const byRow = new Map<string, Map<string, Set<string>>>();
  for (const record of records) {
    // An empty translation counts as MISSING (a cleared cell is not a
    // translation) — same rule as the grid's blue "missing" colour.
    if (!record.value || record.value.trim() === "") continue;
    let byKey = byRow.get(record.rowId);
    if (!byKey) {
      byKey = new Map();
      byRow.set(record.rowId, byKey);
    }
    let locales = byKey.get(record.key);
    if (!locales) {
      locales = new Set();
      byKey.set(record.key, locales);
    }
    locales.add(record.locale);
  }
  return byRow;
}
