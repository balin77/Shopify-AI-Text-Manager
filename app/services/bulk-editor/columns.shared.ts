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
import { isValidShopifyGID, isValidLocale } from "../../utils/validation";

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

/** Column-picker group (Plan §2): Basis · SEO · Metafelder · Bilder · Optionen. */
export type ColumnGroup = "base" | "seo" | "metafields" | "images" | "options";

export const COLUMN_GROUP_ORDER: ColumnGroup[] = ["base", "seo", "metafields", "images", "options"];

export interface ColumnDescriptor {
  /** Stable, collision-free id. No ":" — GIDs contain their own colons.
   * Shapes: "field.title" | "mf.<namespace>.<key>" | "opt.<position>.<name|values>"
   * | "img.alt" | "var.price" | "image" | "blogTitle". */
  id: string;
  kind: ColumnKind;
  /** i18n key under t.bulkEditor.columns — OR (for metafield columns) the
   * shop-defined "namespace.key" name, rendered verbatim (never translated). */
  label: string;
  /** Column-picker group (§2). */
  group: ColumnGroup;
  editable: boolean;
  /** Whether the column is editable in a foreign locale (locale !== ""). */
  translatable: boolean;
  inputType: "text" | "textarea" | "select" | "money" | "number" | "boolean";
  minWidth: number;
  /** DB column backing a server-side sort — absent means the column is NOT
   * sortable and the header must not render a sort affordance (Plan §3.3). */
  sortKey?: string;
  /** kind "metafield": the Shopify metafield type (drives cell rendering AND
   * is sent verbatim in metafieldsSet — §14 no. 4: type is mandatory when the
   * set creates a metafield without a definition). */
  metafieldType?: string;
  /** kind "metafield": namespace/key carried explicitly — parsing them back
   * out of the column id would rely on "no dots in namespaces", which Shopify
   * does not guarantee forever. */
  metafieldNamespace?: string;
  metafieldKey?: string;
  /** kind "option": which option slot (1-based Shopify position) this column
   * addresses. Position, not GID — the column must be the same across all
   * products ("Option 1", "Option 2"), while the cell is product-bound. */
  optionPosition?: number;
  /** kind "option": whether the column edits the option's name or its values. */
  optionField?: "name" | "values";
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
  group: "base",
  editable: false,
  translatable: false,
  inputType: "text",
  minWidth: 72,
};

const BLOG_TITLE_COLUMN: ColumnDescriptor = {
  id: "blogTitle",
  kind: "readonly",
  label: "blogTitle",
  group: "base",
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
    group?: ColumnGroup;
  },
): ColumnDescriptor {
  return {
    id: `field.${name}`,
    kind: "field",
    label: name,
    group: opts.group ?? "base",
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
const COL_SEO_TITLE = fieldColumn("seoTitle", { translatable: true, inputType: "text", minWidth: 200, group: "seo" });
const COL_SEO_DESCRIPTION = fieldColumn("seoDescription", { translatable: true, inputType: "textarea", minWidth: 280, group: "seo" });
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

// ─── Dynamic product columns (Phase 2 — Plan §4) ───────────────────────────

/** Shopify metafield types the grid can EDIT inline. rich_text_field is a
 * column too, but always read-only ("open in editor") — its JSON in a grid
 * cell would recreate the normalization divergence from the theme-richtext
 * path (Plan §4.1). Mirror of TRANSLATABLE_METAFIELD_TYPES
 * (metafield-enablement.server.ts), duplicated here because this module must
 * stay client-safe. A drift would surface immediately: the server builds the
 * column specs, this list only drives per-type rendering. */
export const METAFIELD_TYPE_SINGLE_LINE = "single_line_text_field";
export const METAFIELD_TYPE_MULTI_LINE = "multi_line_text_field";
export const METAFIELD_TYPE_RICH_TEXT = "rich_text_field";
export const METAFIELD_TYPE_LIST_SINGLE_LINE = "list.single_line_text_field";

/** A shop-specific metafield column, produced server-side from the enabled
 * definitions ∩ translatable types (columns.server.ts) and shipped to the
 * client as plain data — the client builds descriptors from it. */
export interface MetafieldColumnSpec {
  namespace: string;
  key: string;
  type: string;
}

export function metafieldColumnId(namespace: string, key: string): string {
  return `mf.${namespace}.${key}`;
}

export function buildMetafieldColumn(spec: MetafieldColumnSpec): ColumnDescriptor {
  const richText = spec.type === METAFIELD_TYPE_RICH_TEXT;
  return {
    id: metafieldColumnId(spec.namespace, spec.key),
    kind: "metafield",
    // Shop-defined name, rendered verbatim — same "namespace.key" label the
    // single-item editor shows (MetafieldsField.tsx). Never translated.
    label: `${spec.namespace}.${spec.key}`,
    group: "metafields",
    editable: !richText,
    translatable: !richText,
    inputType: spec.type === METAFIELD_TYPE_SINGLE_LINE ? "text" : "textarea",
    minWidth: 200,
    metafieldType: spec.type,
    metafieldNamespace: spec.namespace,
    metafieldKey: spec.key,
  };
}

/** Shopify's product option limit — three positions, so three fixed column
 * pairs ("Option 1 … Option 3"). Products with fewer options render the
 * spare cells read-only/empty. */
export const MAX_OPTION_POSITIONS = 3;

export function optionColumnId(position: number, field: "name" | "values"): string {
  return `opt.${position}.${field}`;
}

export function buildOptionColumns(): ColumnDescriptor[] {
  const columns: ColumnDescriptor[] = [];
  for (let position = 1; position <= MAX_OPTION_POSITIONS; position++) {
    for (const field of ["name", "values"] as const) {
      columns.push({
        id: optionColumnId(position, field),
        kind: "option",
        label: field, // heading is built from t.bulkEditor.columns.optionName/-Values + position
        group: "options",
        editable: true,
        translatable: false, // option translations stay in the single editor (sub-resource path)
        inputType: field === "values" ? "textarea" : "text",
        minWidth: field === "values" ? 220 : 160,
        optionPosition: position,
        optionField: field,
      });
    }
  }
  return columns;
}

/** Alt-text of the MAIN product image (lowest position). All other images
 * stay in the image manager (Plan §4.3). */
export const IMG_ALT_COLUMN_ID = "img.alt";

export function buildImgAltColumn(): ColumnDescriptor {
  return {
    id: IMG_ALT_COLUMN_ID,
    kind: "image",
    label: "imgAlt",
    group: "images",
    editable: true,
    // Alt-text translations ride on the MediaImage resource, not the product —
    // Phase 4 decides how to surface them; until then the column is
    // primary-only.
    translatable: false,
    inputType: "text",
    minWidth: 200,
  };
}

/** Which dynamic product columns the shop's plan may see/edit (Plan §10.7):
 * metafields/options/alt-texts are Basic+ because their cache is
 * (PLAN_CONFIG[plan].cacheEnabled.productMetafields/productOptions/
 * productImages). The server builds this from the plan; the client receives
 * it via the loader. */
export interface ProductColumnCaps {
  metafields: boolean;
  options: boolean;
  imageAlt: boolean;
}

/**
 * The full column universe for a type: the static per-type columns plus (for
 * products) the shop's enabled metafield columns, the option column pairs and
 * the main-image alt-text column. Pure and client-safe — the server builds
 * the same list (columns.server.ts) for validation, the client builds it from
 * loader data for rendering.
 */
export function buildColumnsForType(
  type: BulkRowType,
  metafieldSpecs: MetafieldColumnSpec[],
  caps: ProductColumnCaps,
): ColumnDescriptor[] {
  const columns = [...BULK_COLUMNS_BY_TYPE[type]];
  if (type !== "product") return columns;
  if (caps.metafields) columns.push(...metafieldSpecs.map(buildMetafieldColumn));
  if (caps.imageAlt) columns.push(buildImgAltColumn());
  if (caps.options) columns.push(...buildOptionColumns());
  return columns;
}

// ─── List-metafield cell format (Plan §4.1) ────────────────────────────────

/**
 * Display separator for list.single_line_text_field cells and option values:
 * `Rot | Blau | Grün`. NOTE: "|" is also the edit-map KEY separator — that is
 * fine, the list lives in the map's VALUE, never in the key. Keep it that
 * way.
 */
export const LIST_DISPLAY_SEPARATOR = " | ";

/** JSON array string → `A | B | C` display value. Non-JSON input is shown
 * verbatim (defensive against malformed cache rows). */
export function formatListMetafieldValue(raw: string): string {
  if (!raw) return "";
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map((v) => String(v)).join(LIST_DISPLAY_SEPARATOR);
  } catch {
    // fall through — show the raw value
  }
  return raw;
}

/** `A | B | C` display value → string array for metafieldsSet. Every entry
 * must be non-empty after trimming (Plan §4.1 validation); an entirely empty
 * cell never reaches this parser — it is the metafieldsDelete path. */
export function parseListMetafieldInput(
  display: string,
): { ok: true; values: string[] } | { ok: false; error: "emptyValue" } {
  const values = display.split("|").map((v) => v.trim());
  if (values.some((v) => v === "")) return { ok: false, error: "emptyValue" };
  return { ok: true, values };
}

/** Plain-text preview of Shopify's rich-text JSON for the read-only
 * rich_text_field cell. Falls back to the raw string when it isn't the
 * expected JSON shape. */
export function richTextPreview(raw: string): string {
  if (!raw) return "";
  try {
    const doc: unknown = JSON.parse(raw);
    const parts: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as { value?: unknown; children?: unknown };
      if (typeof n.value === "string") parts.push(n.value);
      if (Array.isArray(n.children)) n.children.forEach(walk);
    };
    walk(doc);
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    return text || raw;
  } catch {
    return raw;
  }
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

/** Shopify's documented metafieldsSet input limit (Plan §14). Lives here (not
 * apply.server.ts) because estimateCalls needs it client-side. */
export const METAFIELDS_SET_CHUNK = 25;

/** Alias-batch size for the bulk digest query (Plan §6.1) — mirrors the
 * seo-bulk-fix DIGEST_BATCH_CHUNK. Client-safe because estimateCalls counts
 * the digest roundtrips; the actual query lives in translations.server.ts. */
export const DIGEST_BATCH_CHUNK = 50;

/** Budget for ESTIMATED Shopify calls of one save (Plan §10.1). Since a
 * product row can fan out into up to four mutations (§4.4) and a foreign
 * row into register+remove, rows stopped measuring anything — the UI refuses
 * a save whose estimate exceeds this BEFORE submitting, instead of failing
 * 20 minutes into a task. */
export const MAX_TASK_CALLS = 2000;

// ─── Rows ──────────────────────────────────────────────────────────────────

/** One product-option slot on a row (Phase 2, product rows only). */
export interface BulkRowOption {
  /** ProductOption GID. */
  id: string;
  /** 1-based Shopify position — matches ColumnDescriptor.optionPosition. */
  position: number;
  name: string;
  /** Parsed values — both storage formats ([{id,name}] and legacy ["string"])
   * normalize to this shape; legacy entries carry id "". */
  values: { id: string; name: string }[];
  /** False when any value lacks a GID (legacy format) — the values cell is
   * then read-only: productOptionUpdate needs value ids. */
  hasValueIds: boolean;
  /** Metaobject-linked option (linkedMetafieldKey set): the ENTIRE option —
   * name AND values — is read-only in the grid (Plan §14 no. 5). */
  linked: boolean;
}

/** One enabled metafield value on a row, keyed by column id in
 * BulkRow.metafields. */
export interface BulkRowMetafield {
  /** Metafield GID. */
  id: string;
  value: string;
  type: string;
}

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
  /** Enabled metafield values keyed by column id ("mf.<ns>.<key>"). A missing
   * entry means the product has no such metafield yet — empty cell, and the
   * save CREATES it (Plan §4.1). */
  metafields?: Record<string, BulkRowMetafield>;
  /** Product options ordered by position (synthetic Title/Default Title
   * option already filtered out). */
  options?: BulkRowOption[];
  /** Main product image (lowest position). mediaId null ⇒ the img.alt cell is
   * read-only with a "resync" hint (Plan §4.3 — productUpdateMedia needs the
   * MediaImage GID). Absent ⇒ product has no image. */
  mainImage?: { mediaId: string | null; alt: string };
  /** Foreign-language cell values, keyed `${locale}|${marketId}|${columnId}`.
   * Phase 4 (languages/markets) fills this from ContentTranslation; in Phase 1
   * the UI only edits the primary locale, but the diff pipeline already
   * carries the segments so the key format never has to migrate again. */
  foreignValues?: Record<string, string>;
}

/** The row's primary-locale value for a field column ("" for non-field
 * columns — use resolveCellValue for the full per-cell resolution). */
export function primaryValueForColumn(row: BulkRow, column: ColumnDescriptor): string {
  if (column.kind !== "field") return "";
  const value = (row as unknown as Record<string, unknown>)[fieldNameOfColumn(column)];
  return typeof value === "string" ? value : "";
}

// ─── Per-cell resolution (Phase 2 — editability varies per ROW now) ────────

/** Why a cell renders read-only — drives the localized tooltip. */
export type CellReadOnlyReason =
  | "column" // the whole column is read-only (blogTitle, image, …)
  | "richText" // rich_text_field metafield — "open in editor" (Plan §4.1)
  | "linkedOption" // metaobject-linked option — fully read-only (Plan §14 no. 5)
  | "missingOption" // product has no option at this position
  | "legacyOptionValues" // values without GIDs — can't be mapped for update
  | "missingImage" // product has no image at all
  | "missingMediaId"; // image row lacks the MediaImage GID — resync needed

export interface ResolvedCell {
  /** Baseline display value of the cell (primary locale). */
  value: string;
  editable: boolean;
  readOnlyReason?: CellReadOnlyReason;
}

function joinOptionValues(option: BulkRowOption): string {
  return option.values.map((v) => v.name).join(LIST_DISPLAY_SEPARATOR);
}

/**
 * Resolves a row × column to its baseline value and per-row editability.
 * Column-level editability (rich_text metafields, readonly kinds) and
 * row-level constraints (linked options, missing mediaId, missing option
 * position) both land here, so the grid, computeDiff and the tests share ONE
 * truth about what a cell shows and whether typing into it counts.
 */
export function resolveCellValue(row: BulkRow, column: ColumnDescriptor): ResolvedCell {
  switch (column.kind) {
    case "field":
      return { value: primaryValueForColumn(row, column), editable: column.editable };
    case "metafield": {
      const mf = row.metafields?.[column.id];
      const raw = mf?.value ?? "";
      if (column.metafieldType === METAFIELD_TYPE_RICH_TEXT) {
        return { value: richTextPreview(raw), editable: false, readOnlyReason: "richText" };
      }
      if (column.metafieldType === METAFIELD_TYPE_LIST_SINGLE_LINE) {
        return { value: formatListMetafieldValue(raw), editable: true };
      }
      return { value: raw, editable: true };
    }
    case "option": {
      const option = row.options?.find((o) => o.position === column.optionPosition);
      if (!option) return { value: "", editable: false, readOnlyReason: "missingOption" };
      const value = column.optionField === "name" ? option.name : joinOptionValues(option);
      // Linked options: the WHOLE option is read-only, including the name —
      // Plan §14 no. 5 (overrides the §4.2 text). Renaming stays in the
      // single-item editor.
      if (option.linked) return { value, editable: false, readOnlyReason: "linkedOption" };
      if (column.optionField === "values" && !option.hasValueIds) {
        return { value, editable: false, readOnlyReason: "legacyOptionValues" };
      }
      return { value, editable: true };
    }
    case "image": {
      if (column.id === IMG_ALT_COLUMN_ID) {
        if (!row.mainImage) return { value: "", editable: false, readOnlyReason: "missingImage" };
        if (!row.mainImage.mediaId) {
          return { value: row.mainImage.alt, editable: false, readOnlyReason: "missingMediaId" };
        }
        return { value: row.mainImage.alt, editable: true };
      }
      return { value: "", editable: false, readOnlyReason: "column" };
    }
    case "readonly":
      return {
        value: column.id === "blogTitle" ? row.blogTitle ?? "" : "",
        editable: false,
        readOnlyReason: "column",
      };
    default:
      return { value: "", editable: false, readOnlyReason: "column" };
  }
}

/** Per-type membership for a (possibly dynamic) column: dynamic product
 * columns (metafields, options, img.alt) belong to product rows only; static
 * columns fall back to the per-type allowlist. */
export function columnAllowedForType(type: BulkRowType, column: ColumnDescriptor): boolean {
  if (column.kind === "metafield" || column.kind === "option" || column.id === IMG_ALT_COLUMN_ID) {
    return type === "product";
  }
  return !!getColumnForType(type, column.id);
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
  /** The failed CELL (Plan §4.4 partial-failure semantics): the UI marks the
   * cell red and keeps its edit for retry. Absent = row-level failure (whole
   * row's mutation failed, e.g. a single-mutation page/collection row) — the
   * UI then falls back to marking the row's dirty cells. */
  columnId?: string;
  /** Locale/market of the failed cell (Phase 4) — lets the UI mark the cell
   * in the RIGHT language view and keep exactly that edit. Absent = primary
   * ("" / ""), the pre-Phase-4 shape. */
  locale?: string;
  marketId?: string;
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
    if (!columnAllowedForType(row.type, column)) continue;
    if (locale !== "" && !column.translatable) continue;

    // Per-ROW editability (Phase 2): a linked option, a legacy values format
    // or a missing mediaId make an otherwise-editable column read-only for
    // this row — edits that sneak into the map are dropped, same as
    // column-level read-only.
    const resolved = resolveCellValue(row, column);
    if (locale === "" && !resolved.editable) continue;

    const baseline =
      locale === "" && marketId === ""
        ? resolved.value
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
 * Estimated Shopify calls for a diff (Plan §10.1) — the UI compares this
 * against MAX_TASK_CALLS BEFORE saving, and the /api/ai handler enforces the
 * same budget server-side.
 *
 * Counting mirrors the persistence pipeline:
 * - primary product group: 1 productUpdate (any field cell) +
 *   ceil(metafield sets / 25) + 1 metafieldsDelete (any cleared metafield) +
 *   1 productOptionUpdate per dirty option position + 1 productUpdateMedia;
 * - primary non-product group: 1 (single-mutation row);
 * - foreign group: 1 translationsRegister (any non-empty cell) +
 *   1 translationsRemove (any cleared cell);
 * - plus ceil(unique foreign resources / DIGEST_BATCH_CHUNK) digest batches.
 *
 * `columns` is the (current type's) descriptor universe — unknown column ids
 * are counted as one call each (defensive over-estimate, never under).
 */
export function estimateCalls(diff: BulkDiffEntry[], columns: ColumnDescriptor[]): number {
  const columnById = new Map(columns.map((c) => [c.id, c] as const));
  const groups = groupDiffByRow(diff);
  let calls = 0;
  const foreignDigestResources = new Set<string>();

  for (const group of groups) {
    const entries = Object.entries(group.cells);
    if (group.locale !== "") {
      const hasWrites = entries.some(([, v]) => v !== "");
      const hasClears = entries.some(([, v]) => v === "");
      calls += (hasWrites ? 1 : 0) + (hasClears ? 1 : 0);
      if (hasWrites) foreignDigestResources.add(group.rowId);
      continue;
    }
    if (group.rowType !== "product") {
      calls += 1;
      continue;
    }
    let base = 0;
    let metafieldSets = 0;
    let metafieldDeletes = 0;
    let imageAlt = 0;
    const optionPositions = new Set<number>();
    for (const [columnId, value] of entries) {
      const column = columnById.get(columnId);
      if (!column) {
        calls += 1; // unknown → defensive one-call estimate
        continue;
      }
      switch (column.kind) {
        case "field":
          base = 1;
          break;
        case "metafield":
          if (value === "") metafieldDeletes += 1;
          else metafieldSets += 1;
          break;
        case "option":
          optionPositions.add(column.optionPosition ?? 0);
          break;
        default:
          if (column.id === IMG_ALT_COLUMN_ID) imageAlt = 1;
          else calls += 1;
      }
    }
    calls +=
      base +
      Math.ceil(metafieldSets / METAFIELDS_SET_CHUNK) +
      (metafieldDeletes > 0 ? 1 : 0) +
      optionPositions.size +
      imageAlt;
  }

  calls += Math.ceil(foreignDigestResources.size / DIGEST_BATCH_CHUNK);
  return calls;
}

/**
 * Diff-entry validation shared by the route action AND the /api/ai handler —
 * the handler is reachable directly via POST, so both entrances enforce the
 * exact same rules (Plan §0.2 no. 4): GID shape, plan-allowed row type,
 * per-type column allowlist, and (until Phase 4) primary-language-only
 * segments.
 *
 * `columnsByType` MUST be the SERVER-built column universe
 * (buildServerColumnsByType, columns.server.ts) — that is what makes the
 * mf.-column allowlist a server-side check against the shop's enabled
 * definitions instead of trusting whatever column ids the client sends.
 */
export function isValidBulkDiffEntry(
  e: unknown,
  allowedTypes: BulkRowType[],
  columnsByType: Record<BulkRowType, ColumnDescriptor[]>,
): e is BulkDiffEntry {
  if (!e || typeof e !== "object") return false;
  const entry = e as Record<string, unknown>;
  if (
    typeof entry.rowId !== "string" ||
    !isValidShopifyGID(entry.rowId) ||
    typeof entry.rowType !== "string" ||
    !(allowedTypes as string[]).includes(entry.rowType) ||
    typeof entry.columnId !== "string" ||
    typeof entry.value !== "string"
  ) {
    return false;
  }
  const column = columnsByType[entry.rowType as BulkRowType]?.find((c) => c.id === entry.columnId);
  if (!column || !column.editable) return false;
  // Locale/market segments (Phase 4): primary edits are always global
  // ("" / ""). Foreign-locale edits are only valid on translatable columns; a
  // market override additionally requires a foreign locale (Shopify forbids
  // market-specific PRIMARY content) and a well-formed Market GID. Note the
  // route action / handler additionally verify the locale against the shop's
  // PUBLISHED locales — that needs I/O and can't happen here.
  if (typeof entry.locale !== "string" || typeof entry.marketId !== "string") return false;
  if (entry.locale === "") return entry.marketId === "";
  if (!column.translatable) return false;
  if (!isValidLocale(entry.locale)) return false;
  return entry.marketId === "" || isValidShopifyGID(entry.marketId);
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
