/**
 * Client-safe half of the bulk editor (docs/plans/PLAN_BULK_EDITOR.md §1.2/§3):
 * column descriptors, edit-map key helpers, constants and the pure diff
 * computation.
 *
 * MUST STAY CLIENT-SAFE — the route component (app.bulk.tsx) and the grid
 * components import computeDiff/column descriptors/constants in CLIENT code.
 * Importing anything server-only here (ShopifyApiGateway → logger.server,
 * Prisma, fs, …) drags it into the client bundle and breaks
 * `remix vite:build` ("Server-only module referenced by client"). Server-side
 * I/O lives in load.server.ts (reading rows) and apply.server.ts (writing the
 * diff), which import their pure pieces from here.
 */

// zod-based pure validation helpers — no server-only imports (safe here).
import { isValidShopifyGID } from "../../utils/validation";

// ─── Row types ─────────────────────────────────────────────────────────────

/** Row types the bulk editor supports today. Phase 3/5 add "variant",
 * "blog", "policy", "metaobject" here. */
export type BulkRowType = "product" | "collection" | "article" | "page";

export const BULK_ROW_TYPES: BulkRowType[] = ["product", "collection", "article", "page"];

/**
 * Maps each bulk row type to the plan ContentType that gates it
 * (PLAN_CONFIG[plan].contentTypes). The type selector, the route action and
 * the /api/ai handler all intersect against this — fixing the §0.4
 * inconsistency where a Basic shop was offered `article` although its plan
 * never syncs article content.
 */
export const BULK_ROW_TYPE_TO_CONTENT_TYPE: Record<BulkRowType, string> = {
  product: "products",
  collection: "collections",
  article: "articles",
  page: "pages",
};

// ─── Column descriptors (Plan §1.2) ────────────────────────────────────────

export type ColumnKind = "field" | "metafield" | "option" | "variant" | "image" | "readonly";

export interface ColumnDescriptor {
  /** Stable, collision-free id. No ":" — GIDs contain their own colons.
   * Shapes: "field.title" | "mf.<namespace>.<key>" | "var.price" | "img.alt"
   * | "image" | "blogTitle". */
  id: string;
  kind: ColumnKind;
  /** i18n key under t.bulkEditor.columns — OR (for metafield columns, Phase 2)
   * the merchant-defined display name, rendered verbatim. */
  label: string;
  editable: boolean;
  /** Whether the column is editable in a foreign locale (locale !== ""). */
  translatable: boolean;
  inputType: "text" | "textarea" | "select" | "money" | "number" | "boolean";
  minWidth: number;
  /** DB column backing a server-side sort — absent means the column is NOT
   * sortable and the header must not render a sort affordance (Plan §3.3). */
  sortKey?: string;
}

/** For kind "field": the flat row property (and Prisma column) behind the
 * column — "field.title" → "title". */
export function fieldNameOfColumn(column: ColumnDescriptor): string {
  return column.id.startsWith("field.") ? column.id.slice("field.".length) : column.id;
}

const IMAGE_COLUMN: ColumnDescriptor = {
  id: "image",
  kind: "image",
  label: "image",
  editable: false,
  translatable: false,
  inputType: "text",
  minWidth: 72,
};

const BLOG_TITLE_COLUMN: ColumnDescriptor = {
  id: "blogTitle",
  kind: "readonly",
  label: "blogTitle",
  editable: false,
  translatable: false,
  inputType: "text",
  minWidth: 140,
};

function fieldColumn(
  name: string,
  opts: {
    translatable: boolean;
    inputType: ColumnDescriptor["inputType"];
    minWidth: number;
    sortKey?: string;
  },
): ColumnDescriptor {
  return {
    id: `field.${name}`,
    kind: "field",
    label: name,
    editable: true,
    translatable: opts.translatable,
    inputType: opts.inputType,
    minWidth: opts.minWidth,
    ...(opts.sortKey ? { sortKey: opts.sortKey } : {}),
  };
}

// The nine editable fields of the former bulk-meta editor, now as descriptors.
// translatable mirrors Shopify's translatable keys for these resources
// (title/body_html/handle/meta_title/meta_description/product_type/summary_html);
// status is a Shopify enum and never translatable.
const COL_TITLE = fieldColumn("title", { translatable: true, inputType: "text", minWidth: 180, sortKey: "title" });
const COL_DESCRIPTION_HTML = fieldColumn("descriptionHtml", { translatable: true, inputType: "textarea", minWidth: 280 });
const COL_PRODUCT_TYPE = fieldColumn("productType", { translatable: true, inputType: "text", minWidth: 180, sortKey: "productType" });
const COL_STATUS = fieldColumn("status", { translatable: false, inputType: "select", minWidth: 130, sortKey: "status" });
const COL_HANDLE = fieldColumn("handle", { translatable: true, inputType: "text", minWidth: 180, sortKey: "handle" });
const COL_SEO_TITLE = fieldColumn("seoTitle", { translatable: true, inputType: "text", minWidth: 200 });
const COL_SEO_DESCRIPTION = fieldColumn("seoDescription", { translatable: true, inputType: "textarea", minWidth: 280 });
const COL_BODY = fieldColumn("body", { translatable: true, inputType: "textarea", minWidth: 280 });
const COL_SUMMARY = fieldColumn("summary", { translatable: true, inputType: "textarea", minWidth: 240 });

/**
 * Per-type column allowlist, in canonical (picker + default render) order.
 * Used by the UI (column picker + grid) AND by the server (route action and
 * /api/ai handler reject any diff entry whose column isn't editable for its
 * row type).
 */
export const BULK_COLUMNS_BY_TYPE: Record<BulkRowType, ColumnDescriptor[]> = {
  product: [
    IMAGE_COLUMN,
    COL_TITLE,
    COL_DESCRIPTION_HTML,
    COL_PRODUCT_TYPE,
    COL_STATUS,
    COL_HANDLE,
    COL_SEO_TITLE,
    COL_SEO_DESCRIPTION,
  ],
  collection: [IMAGE_COLUMN, COL_TITLE, COL_DESCRIPTION_HTML, COL_HANDLE, COL_SEO_TITLE, COL_SEO_DESCRIPTION],
  article: [
    IMAGE_COLUMN,
    BLOG_TITLE_COLUMN,
    COL_TITLE,
    COL_SUMMARY,
    COL_BODY,
    COL_HANDLE,
    COL_SEO_TITLE,
    COL_SEO_DESCRIPTION,
  ],
  page: [IMAGE_COLUMN, COL_TITLE, COL_BODY, COL_HANDLE, COL_SEO_TITLE, COL_SEO_DESCRIPTION],
};

export function getColumnForType(type: BulkRowType, columnId: string): ColumnDescriptor | undefined {
  return BULK_COLUMNS_BY_TYPE[type].find((c) => c.id === columnId);
}

/** True if `columnId` is a valid EDITABLE column for `type`. Server-side
 * validation guard AND client-side stale-edit filter. */
export function isColumnEditableForType(type: BulkRowType, columnId: string): boolean {
  const col = getColumnForType(type, columnId);
  return !!col && col.editable;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Selectable page sizes (Plan §3.3). Anything above 250 stays locked — the
 * rows carry textareas, not text. */
export const BULK_PAGE_SIZES = [50, 100, 250] as const;
export const BULK_DEFAULT_PAGE_SIZE = 100;

/** Hard cap on simultaneously visible columns (Plan §10.2): 250 rows × 20
 * columns is the browser-load ceiling; the column picker refuses the 21st. */
export const MAX_VISIBLE_COLUMNS = 20;

/** More dirty cells than this go through the detached "seoBulkMeta" Task
 * (seo-bulk-meta.handler.ts) instead of a synchronous save. */
export const MAX_SYNC_SAVE = 25;

/** Hard cap on one detached run. No per-item AI call here, so the ceiling can
 * be much higher than AI bulk paths — it just bounds one runner's worst-case
 * wall-clock time. */
export const MAX_BULK_TASK_ITEMS = 500;

// ─── Rows ──────────────────────────────────────────────────────────────────

export interface BulkRow {
  id: string;
  type: BulkRowType;
  title: string;
  seoTitle: string;
  seoDescription: string;
  handle: string;
  // Per-type optional editable fields.
  descriptionHtml?: string;
  productType?: string;
  status?: string;
  body?: string;
  summary?: string;
  // Read-only display fields.
  imageUrl?: string;
  imageAlt?: string;
  blogTitle?: string;
  /** Foreign-language cell values, keyed `${locale}|${marketId}|${columnId}`.
   * Phase 4 (languages/markets) fills this from ContentTranslation; in Phase 1
   * the UI only edits the primary locale, but the diff pipeline already
   * carries the segments so the key format never has to migrate again. */
  foreignValues?: Record<string, string>;
}

/** The row's primary-locale value for a field column ("" for non-field
 * columns, which are never editable). */
export function primaryValueForColumn(row: BulkRow, column: ColumnDescriptor): string {
  if (column.kind !== "field") return "";
  const value = (row as unknown as Record<string, unknown>)[fieldNameOfColumn(column)];
  return typeof value === "string" ? value : "";
}

// ─── Edit-map keys: `${rowId}|${locale}|${marketId}|${columnId}` ───────────

/**
 * Separator is "|", NOT ":" — the old `${id}:${field}` format needed a
 * lastIndexOf(":") trick because GIDs contain their own colons; with four
 * segments that trick is no longer viable. "|" never occurs in GIDs, locales,
 * market ids or column ids, so a plain split is exact.
 */
export const EDIT_KEY_SEPARATOR = "|";

export function makeEditKey(rowId: string, locale: string, marketId: string, columnId: string): string {
  return [rowId, locale, marketId, columnId].join(EDIT_KEY_SEPARATOR);
}

export interface ParsedEditKey {
  rowId: string;
  /** "" = primary locale. */
  locale: string;
  /** "" = global (all markets). */
  marketId: string;
  columnId: string;
}

/** Null unless the key has exactly four "|"-separated segments with a
 * non-empty rowId and columnId. */
export function parseEditKey(key: string): ParsedEditKey | null {
  const parts = key.split(EDIT_KEY_SEPARATOR);
  if (parts.length !== 4) return null;
  const [rowId, locale, marketId, columnId] = parts;
  if (!rowId || !columnId) return null;
  return { rowId, locale, marketId, columnId };
}

// ─── Diff pipeline (pure, unit-tested) ─────────────────────────────────────

export interface BulkDiffEntry {
  rowId: string; // GID of the row (Product, Collection, …)
  rowType: BulkRowType;
  locale: string; // "" = primary locale
  marketId: string; // "" = global
  columnId: string; // ColumnDescriptor.id
  value: string;
}

export interface BulkFailure {
  rowId: string;
  rowType: BulkRowType;
  message: string;
}

export interface BulkApplyResult {
  saved: number;
  failures: BulkFailure[];
}

/**
 * Diff-only save-all: only cells whose trimmed value differs from the
 * (trimmed) baseline are returned. `edits` is keyed by
 * `${rowId}|${locale}|${marketId}|${columnId}` — exactly the shape of the
 * route's client-side edit map.
 *
 * Rules carried over verbatim from the bulk-meta editor:
 * - trimmed comparison — whitespace-only "changes" never count as dirty;
 * - a deliberate clear (typing nothing over content) IS a real change;
 * - unknown/stale keys (row gone, malformed key, column not editable for the
 *   row's type) are silently dropped;
 * New with the locale dimension:
 * - a foreign-locale edit (locale !== "") is dropped unless the column is
 *   `translatable` — non-translatable columns render read-only there anyway.
 *
 * The baseline for the primary locale is the row's own field value; for a
 * foreign locale it is the loaded translation in `row.foreignValues` (missing
 * translation = ""), so typing into an untranslated ghost cell is a diff and
 * re-typing the existing translation is not.
 *
 * `columns` is the descriptor universe used to resolve column ids — pass ALL
 * columns of the current type (not just the visible ones), so edits made in a
 * since-hidden column still save.
 */
export function computeDiff(
  rows: BulkRow[],
  columns: ColumnDescriptor[],
  edits: Record<string, string>,
): BulkDiffEntry[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const columnById = new Map(columns.map((c) => [c.id, c] as const));
  const diff: BulkDiffEntry[] = [];

  for (const key of Object.keys(edits)) {
    const parsed = parseEditKey(key);
    if (!parsed) continue;
    const { rowId, locale, marketId, columnId } = parsed;

    const row = byId.get(rowId);
    if (!row) continue;

    const column = columnById.get(columnId);
    if (!column || !column.editable) continue;
    if (!isColumnEditableForType(row.type, columnId)) continue;
    if (locale !== "" && !column.translatable) continue;

    const baseline =
      locale === "" && marketId === ""
        ? primaryValueForColumn(row, column)
        : row.foreignValues?.[`${locale}|${marketId}|${columnId}`] ?? "";

    const original = baseline.trim();
    const next = (edits[key] ?? "").trim();
    if (next !== original) {
      diff.push({ rowId: row.id, rowType: row.type, locale, marketId, columnId, value: next });
    }
  }

  return diff;
}

export interface BulkDiffRowGroup {
  rowType: BulkRowType;
  rowId: string;
  locale: string;
  marketId: string;
  /** columnId → new value. */
  cells: Record<string, string>;
}

/**
 * Groups flat diff entries into one patch per (rowType, rowId, locale,
 * marketId), so a row with several dirty cells produces a single Shopify
 * mutation instead of one per cell. Primary edits and (future) per-locale
 * translation edits of the same row land in separate groups — they use
 * different Shopify mutations.
 */
export function groupDiffByRow(diff: BulkDiffEntry[]): BulkDiffRowGroup[] {
  const map = new Map<string, BulkDiffRowGroup>();
  for (const entry of diff) {
    const key = [entry.rowType, entry.rowId, entry.locale, entry.marketId].join(EDIT_KEY_SEPARATOR);
    let group = map.get(key);
    if (!group) {
      group = {
        rowType: entry.rowType,
        rowId: entry.rowId,
        locale: entry.locale,
        marketId: entry.marketId,
        cells: {},
      };
      map.set(key, group);
    }
    group.cells[entry.columnId] = entry.value;
  }
  return [...map.values()];
}

/**
 * Diff-entry validation shared by the route action AND the /api/ai handler —
 * the handler is reachable directly via POST, so both entrances enforce the
 * exact same rules (Plan §0.2 no. 4): GID shape, plan-allowed row type,
 * per-type column allowlist, and (Phase 1) primary-language-only segments.
 */
export function isValidBulkDiffEntry(e: unknown, allowedTypes: BulkRowType[]): e is BulkDiffEntry {
  if (!e || typeof e !== "object") return false;
  const entry = e as Record<string, unknown>;
  return (
    typeof entry.rowId === "string" &&
    isValidShopifyGID(entry.rowId) &&
    typeof entry.rowType === "string" &&
    (allowedTypes as string[]).includes(entry.rowType) &&
    typeof entry.columnId === "string" &&
    isColumnEditableForType(entry.rowType as BulkRowType, entry.columnId) &&
    // Phase 1 writes the primary language only — the locale/market segments
    // ride along in the key format (Phase 4 fills them), but a non-empty
    // segment has no server write path yet and is rejected, not dropped.
    entry.locale === "" &&
    entry.marketId === "" &&
    typeof entry.value === "string"
  );
}

// ─── Server-side filter/sort vocabulary (client-safe: types + validation) ──

export type BulkFilterId = "missingSeoTitle" | "missingSeoDescription" | "missingTranslation";

export const BULK_FILTER_IDS: BulkFilterId[] = [
  "missingSeoTitle",
  "missingSeoDescription",
  "missingTranslation",
];

export type SortDirection = "asc" | "desc";

export interface BulkSort {
  /** ColumnDescriptor.id of a column with a sortKey. */
  columnId: string;
  direction: SortDirection;
}

/** Parses the `sort` URL param (`<columnId>.<asc|desc>`), returning null for
 * anything that isn't a sortable column of `type`. Column ids contain their
 * own dots ("field.title"), so the direction is the LAST dot segment. */
export function parseSortParam(type: BulkRowType, raw: string | null): BulkSort | null {
  if (!raw) return null;
  const sep = raw.lastIndexOf(".");
  if (sep <= 0) return null;
  const columnId = raw.slice(0, sep);
  const direction = raw.slice(sep + 1);
  if (direction !== "asc" && direction !== "desc") return null;
  const column = getColumnForType(type, columnId);
  if (!column?.sortKey) return null;
  return { columnId, direction };
}

export function serializeSortParam(sort: BulkSort): string {
  return `${sort.columnId}.${sort.direction}`;
}
