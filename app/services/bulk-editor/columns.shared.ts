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

/** Row types the bulk editor supports. "variant" (Phase 3, Plan §5.3): one
 * row = one variant, with product image/title as read-only sticky context
 * columns. Phase 5 (Plan §7): "blog" = blog CONTAINERS (live-fetched, no DB
 * cache), "policy" = ShopPolicy rows, "metaobject" = Metaobject rows with
 * per-definition dynamic columns. */
export type BulkRowType =
  | "product"
  | "variant"
  /** One row = one product MEDIUM (its Shopify MediaImage GID is the row id). */
  | "image"
  | "collection"
  | "article"
  | "page"
  | "blog"
  | "policy"
  | "metaobject";

export const BULK_ROW_TYPES: BulkRowType[] = [
  "product",
  "variant",
  "collection",
  "article",
  "page",
  "blog",
  "policy",
  "metaobject",
  "image",
];

/**
 * Maps each bulk row type to the plan ContentType that gates it
 * (PLAN_CONFIG[plan].contentTypes). The type selector, the route action and
 * the /api/ai handler all intersect against this — fixing the §0.4
 * inconsistency where a Basic shop was offered `article` although its plan
 * never syncs article content. Variants hang off products (Plan §5.3): the
 * same "products" gate covers them, so they are Basic+ like the other types.
 * Phase 5 (Plan §10.7): "policies" is Basic+, "blogs"/"metaobjects" are Pro+
 * per PLAN_CONFIG — this map is what enforces that, at all three gates.
 */
export const BULK_ROW_TYPE_TO_CONTENT_TYPE: Record<BulkRowType, string> = {
  product: "products",
  variant: "products",
  collection: "collections",
  article: "articles",
  page: "pages",
  blog: "blogs",
  policy: "policies",
  metaobject: "metaobjects",
  // Image rows are PRODUCT media — they ride the products gate (and, on top of
  // it, the productImages cache flag; see allowedRowTypesForPlan).
  image: "products",
};

// ─── Column descriptors (Plan §1.2) ────────────────────────────────────────

export type ColumnKind = "field" | "metafield" | "option" | "variant" | "image" | "readonly" | "mofield";

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
  /** kind "mofield" (Phase 5): the MetaobjectDefinition.type this column
   * belongs to — a column is only editable on rows of the SAME type (the
   * toolbar's type filter keeps the visible set homogeneous). Carried
   * explicitly, same reasoning as metafieldNamespace/-Key: parsing it back
   * out of "mo.<type>.<fieldKey>" would rely on "no dots in type names". */
  moType?: string;
  /** kind "mofield": the field key inside Metaobject.fields — doubling as the
   * Shopify translatable-content key for MetaobjectTranslation. */
  moFieldKey?: string;
  /** kind "mofield": the Shopify field type (drives cell rendering; rich_text
   * stays read-only, list types use the `|` display format). */
  moFieldType?: string;
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

// ─── Phase-5 static columns (Plan §7) ──────────────────────────────────────

/** Policy title is READ-ONLY: shopPolicyUpdate(shopPolicy:{type,body}) has no
 * title field (Plan §14) — Shopify derives the title from the policy type. */
const POLICY_TITLE_COLUMN: ColumnDescriptor = {
  id: "policyTitle",
  kind: "readonly",
  label: "policyTitle",
  group: "base",
  editable: false,
  translatable: false,
  inputType: "text",
  minWidth: 200,
  sortKey: "title",
};

/** Metaobject display name — read-only context (editing happens through the
 * type's own field columns; the label field IS one of them). */
const MO_DISPLAY_NAME_COLUMN: ColumnDescriptor = {
  id: "moDisplayName",
  kind: "readonly",
  label: "moDisplayName",
  group: "base",
  editable: false,
  translatable: false,
  inputType: "text",
  minWidth: 180,
  sortKey: "displayName",
};

/** Metaobject handle — read-only recognition column (handles are structural;
 * renaming them is a guided single-editor concern). */
const MO_HANDLE_COLUMN: ColumnDescriptor = {
  id: "moHandle",
  kind: "readonly",
  label: "moHandle",
  group: "base",
  editable: false,
  translatable: false,
  inputType: "text",
  minWidth: 160,
  sortKey: "handle",
};

// ─── Variant row columns (Phase 3 — Plan §5.3) ─────────────────────────────
// One row = one variant. Product image + product title are read-only sticky
// context; the variant title derives from the option values and stays
// read-only too. ALL variant columns are translatable:false — prices/SKUs
// have no translation layer.

export const VAR_SKU_COLUMN_ID = "var.sku";
export const VAR_PRICE_COLUMN_ID = "var.price";
export const VAR_COMPARE_AT_COLUMN_ID = "var.compareAtPrice";
export const VAR_BARCODE_COLUMN_ID = "var.barcode";

const PRODUCT_TITLE_COLUMN: ColumnDescriptor = {
  id: "productTitle",
  kind: "readonly",
  label: "productTitle",
  group: "base",
  editable: false,
  translatable: false,
  inputType: "text",
  minWidth: 180,
  // Nested sort (product.title) — load.server special-cases this key.
  sortKey: "productTitle",
};

const VARIANT_TITLE_COLUMN: ColumnDescriptor = {
  id: "variantTitle",
  kind: "readonly",
  label: "variantTitle",
  group: "base",
  editable: false,
  translatable: false,
  inputType: "text",
  minWidth: 160,
  sortKey: "title",
};

const VARIANT_POSITION_COLUMN: ColumnDescriptor = {
  id: "position",
  kind: "readonly",
  label: "position",
  group: "base",
  editable: false,
  translatable: false,
  inputType: "number",
  minWidth: 70,
  sortKey: "position",
};

function variantColumn(
  id: string,
  label: string,
  opts: { inputType: ColumnDescriptor["inputType"]; minWidth: number; sortKey?: string },
): ColumnDescriptor {
  return {
    id,
    kind: "variant",
    label,
    group: "base",
    editable: true,
    translatable: false,
    inputType: opts.inputType,
    minWidth: opts.minWidth,
    ...(opts.sortKey ? { sortKey: opts.sortKey } : {}),
  };
}

const VAR_SKU_COLUMN = variantColumn(VAR_SKU_COLUMN_ID, "sku", { inputType: "text", minWidth: 140, sortKey: "sku" });
const VAR_PRICE_COLUMN = variantColumn(VAR_PRICE_COLUMN_ID, "price", { inputType: "money", minWidth: 110, sortKey: "price" });
const VAR_COMPARE_AT_COLUMN = variantColumn(VAR_COMPARE_AT_COLUMN_ID, "compareAtPrice", { inputType: "money", minWidth: 130, sortKey: "compareAtPrice" });
const VAR_BARCODE_COLUMN = variantColumn(VAR_BARCODE_COLUMN_ID, "barcode", { inputType: "text", minWidth: 140 });

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
 * Image ROWS (one row = one product medium): the editable, translatable
 * alt-text. Unlike the product row's `img.alt` column — which can only ever
 * address the MAIN image — an image row's id IS the MediaImage GID, so the
 * translation rides on the row's own translatableResource (key "alt") and the
 * ordinary row path handles it.
 */
export const IMAGE_ROW_ALT_COLUMN_ID = "field.altText";

const IMAGE_ROW_ALT_COLUMN = fieldColumn("altText", {
  translatable: true,
  inputType: "text",
  minWidth: 280,
  sortKey: "altText",
});

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
  variant: [
    IMAGE_COLUMN,
    PRODUCT_TITLE_COLUMN,
    VARIANT_TITLE_COLUMN,
    VAR_SKU_COLUMN,
    VAR_PRICE_COLUMN,
    VAR_COMPARE_AT_COLUMN,
    VAR_BARCODE_COLUMN,
    VARIANT_POSITION_COLUMN,
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
  // Blog CONTAINERS (Plan §7): no body — Shopify's translatable keys for BLOG
  // are title/handle/meta_title/meta_description (Plan §14 no. 6), and the
  // primary write path (blogUpdate + global.title_tag/description_tag
  // metafields) covers exactly these four. Rows are live-fetched (no DB
  // cache), so the sortKeys here are resolved IN MEMORY by the loader.
  blog: [COL_TITLE, COL_HANDLE, COL_SEO_TITLE, COL_SEO_DESCRIPTION],
  // Policies (Plan §7): title read-only (§14 — shopPolicyUpdate has no title
  // input), body editable exactly like descriptionHtml/body on other types.
  // body IS translatable — under the ShopPolicy key exception ("body", not
  // "body_html"; fieldTranslationKeyMap in shopify-content.service.ts).
  policy: [POLICY_TITLE_COLUMN, COL_BODY],
  // Metaobjects (Plan §7): static read-only context columns only — the
  // editable columns are the per-definition mofield columns appended by
  // buildColumnsForType from the shop's MetaobjectDefinition specs.
  metaobject: [MO_DISPLAY_NAME_COLUMN, MO_HANDLE_COLUMN],
  // Image rows (one row = one product medium with a Shopify MediaImage GID).
  // The product title is the "where does this image belong" column; position
  // is Shopify's media order.
  image: [IMAGE_COLUMN, PRODUCT_TITLE_COLUMN, VARIANT_POSITION_COLUMN, IMAGE_ROW_ALT_COLUMN],
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

// ─── Dynamic metaobject columns (Phase 5 — Plan §7) ────────────────────────

/**
 * One column per MetaobjectDefinition field, produced server-side
 * (columns.server.ts loadMetaobjectColumnSpecs) from the synced definitions
 * and shipped to the client as plain data. Same type filter as metafields:
 * only text-like types get a column at all; rich_text gets a READ-ONLY column
 * ("open in editor" — Plan §7/§11: grid-editing Shopify's rich-text JSON
 * recreates the theme-richtext normalization divergence).
 */
export interface MetaobjectColumnSpec {
  /** MetaobjectDefinition.type (e.g. "size_guide"). */
  type: string;
  fieldKey: string;
  /** Shopify field type name (single_line_text_field, …). */
  fieldType: string;
  /** Shop-defined field display name — rendered verbatim, never translated
   * (§10.4, same rule as metafield labels). */
  name: string;
}

/** Column id shape "mo.<type>.<fieldKey>" — collision-free against every
 * other id shape ("field."/"mf."/"opt."/"var."/"img." prefixes); type and
 * fieldKey are ADDITIONALLY carried as descriptor props (moType/moFieldKey),
 * so nothing ever parses this id back apart. */
export function metaobjectColumnId(type: string, fieldKey: string): string {
  return `mo.${type}.${fieldKey}`;
}

/** Metaobject field types the grid can edit inline — the same text-type set
 * as metafield columns. Everything else (references, numbers, booleans…)
 * gets NO column; rich_text gets a read-only column. */
export function isEditableMetaobjectFieldType(fieldType: string): boolean {
  return (
    fieldType === METAFIELD_TYPE_SINGLE_LINE ||
    fieldType === METAFIELD_TYPE_MULTI_LINE ||
    fieldType === METAFIELD_TYPE_LIST_SINGLE_LINE
  );
}

export function buildMetaobjectColumn(spec: MetaobjectColumnSpec): ColumnDescriptor {
  const richText = spec.fieldType === METAFIELD_TYPE_RICH_TEXT;
  return {
    id: metaobjectColumnId(spec.type, spec.fieldKey),
    kind: "mofield",
    // Shop-defined field name, rendered verbatim (§10.4).
    label: spec.name || spec.fieldKey,
    group: "metafields",
    editable: !richText,
    // Text fields translate into MetaobjectTranslation
    // (shop_metaobjectId_key_locale_marketId) via the verified Phase-4 path.
    translatable: !richText,
    inputType: spec.fieldType === METAFIELD_TYPE_SINGLE_LINE ? "text" : "textarea",
    minWidth: 200,
    moType: spec.type,
    moFieldKey: spec.fieldKey,
    moFieldType: spec.fieldType,
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
        // Option translations live on the ProductOption / ProductOptionValue
        // resource, not on the product — apply.server.ts routes these cells
        // through the sub-resource write path (translations.server.ts).
        translatable: true,
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
 * the main-image alt-text column, and (for metaobjects) one column per
 * definition field across ALL definitions — the toolbar's type filter narrows
 * the RENDERED set to one definition, but validation and the diff pipeline
 * work on the union (a diff entry for any real definition column is valid).
 * Pure and client-safe — the server builds the same list (columns.server.ts)
 * for validation, the client builds it from loader data for rendering.
 */
export function buildColumnsForType(
  type: BulkRowType,
  metafieldSpecs: MetafieldColumnSpec[],
  caps: ProductColumnCaps,
  metaobjectSpecs: MetaobjectColumnSpec[] = [],
): ColumnDescriptor[] {
  const columns = [...BULK_COLUMNS_BY_TYPE[type]];
  if (type === "metaobject") {
    columns.push(...metaobjectSpecs.map(buildMetaobjectColumn));
    return columns;
  }
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

/**
 * True when a stored JSON list value has an ENTRY that itself contains the
 * "|" separator character (review Finding 11): the display form joins entries
 * with " | ", so editing such a cell would re-split on "|" and silently
 * shatter the entry into several. Cells like this render READ-ONLY with an
 * "edit in the single editor" tooltip instead. Non-JSON input renders
 * verbatim (no join/split round-trip) and stays editable.
 */
export function listValueContainsSeparator(raw: string): boolean {
  if (!raw) return false;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.some((v) => String(v).includes("|"));
  } catch {
    // Not JSON — formatListMetafieldValue shows it verbatim, no split risk.
  }
  return false;
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

// ─── Money parsing/formatting (Phase 3 — Plan §5.5) ────────────────────────

export type ParseMoneyResult =
  | { ok: true; /** Normalized dot value "1299.90"; null = empty input. */ value: string | null }
  | { ok: false; error: "negative" | "invalid" | "ambiguous" };

/**
 * Locale-tolerant money parser (Plan §5.5). The app is trilingual: German and
 * Spanish merchants type `1.299,90`, English merchants `1,299.90` — a naive
 * parseFloat reads those as 1.299 and 1.
 *
 * Rules:
 * 1. Whitespace and currency symbols/codes are stripped.
 * 2. If the LAST separator is a comma followed by 1–2 digits, the comma is
 *    the decimal separator and dots are thousands separators; otherwise the
 *    dot is decimal and commas are thousands.
 * 3. A bare `1.299` — a SINGLE dot with EXACTLY three digits after it and no
 *    other separator — is genuinely ambiguous (German thousands vs. English
 *    milli-decimal) and is rejected as error "ambiguous" instead of silently
 *    normalizing to 1.30 (review Finding 3). Merchants disambiguate by
 *    writing `1299` or `1.299,00`.
 * 4. The result is normalized to two fraction digits. Negative amounts are an
 *    error; empty input returns value:null and the CALLER decides (price:
 *    cell error — Shopify's price is not nullable; compareAtPrice: null
 *    clears, §14).
 */
export function parseMoney(input: string): ParseMoneyResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, value: null };

  // Strip everything that isn't a digit, separator or sign (currency symbols,
  // letters, whitespace, NBSP…).
  const stripped = trimmed.replace(/[^0-9.,-]/g, "");
  if (stripped.includes("-")) return { ok: false, error: "negative" };
  if (!/[0-9]/.test(stripped)) return { ok: false, error: "invalid" };

  // Rule 3: single dot, exactly three digits after it, no other separator —
  // "1.299" could be 1299 (de/es thousands) or 1.299 (en decimal). Never
  // guess silently — surface a cell error with a disambiguation hint.
  if (/^\d+\.\d{3}$/.test(stripped)) return { ok: false, error: "ambiguous" };

  const lastComma = stripped.lastIndexOf(",");
  const lastDot = stripped.lastIndexOf(".");
  const digitsAfterComma = lastComma >= 0 ? stripped.length - lastComma - 1 : -1;
  const commaIsDecimal = lastComma > lastDot && digitsAfterComma >= 1 && digitsAfterComma <= 2;

  let normalized: string;
  if (commaIsDecimal) {
    const withoutThousands = stripped.replace(/\./g, "");
    if ((withoutThousands.match(/,/g) ?? []).length !== 1) return { ok: false, error: "invalid" };
    normalized = withoutThousands.replace(",", ".");
  } else {
    normalized = stripped.replace(/,/g, "");
    if ((normalized.match(/\./g) ?? []).length > 1) return { ok: false, error: "invalid" };
  }
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(normalized)) return { ok: false, error: "invalid" };

  const num = Number(normalized);
  if (!Number.isFinite(num)) return { ok: false, error: "invalid" };
  return { ok: true, value: num.toFixed(2) };
}

/** Localized display form of a normalized money value (Plan §5.5): shown via
 * Intl.NumberFormat in the app language, while the normalized dot value is
 * what gets stored/compared. Non-numeric input renders verbatim (defensive —
 * an unparseable edit stays visible exactly as typed). */
export function formatMoneyForDisplay(value: string, locale: string): string {
  if (value === "") return "";
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  try {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
  } catch {
    return value;
  }
}

// ─── Price bulk actions (Phase 3 — Plan §5.6) ──────────────────────────────
// Pure calculations over ONE normalized price value. The route applies them
// to the loaded (filtered) selection by FILLING THE EDIT MAP — never writing
// directly, so preview/correction/estimation/save all run through the normal
// diff pipeline.

export type PriceActionId =
  | "percent" // price ± X %
  | "absolute" // price ± X
  | "set" // price = X
  | "compareAtFromPrice" // compareAtPrice = current price (handled row-wise by the caller)
  | "round00"
  | "round90"
  | "round95";

export interface PriceAction {
  id: PriceActionId;
  /** Required for percent/absolute/set. percent/absolute may be negative
   * (reductions); set must be ≥ 0. */
  amount?: number;
}

const ROUND_ENDINGS: Partial<Record<PriceActionId, number>> = {
  round00: 0,
  round90: 0.9,
  round95: 0.95,
};

/**
 * Applies a price action to one normalized value ("1299.90"). Returns the new
 * normalized value, or null when the action does not apply (empty/unparseable
 * current price for anything but "set", missing amount, non-price action).
 * Results below zero clamp to "0.00" — a bulk reduction must not produce
 * negative prices, which Shopify rejects.
 */
export function applyPriceAction(current: string, action: PriceAction): string | null {
  if (action.id === "compareAtFromPrice") return null; // caller copies row-wise
  if (action.id === "set") {
    if (action.amount === undefined || !Number.isFinite(action.amount) || action.amount < 0) return null;
    return action.amount.toFixed(2);
  }

  const parsed = parseMoney(current);
  if (!parsed.ok || parsed.value === null) return null;
  const value = Number(parsed.value);

  const ending = ROUND_ENDINGS[action.id];
  if (ending !== undefined) {
    // Nearest n + ending (psychological pricing): n is the integer that
    // minimizes the distance, floored at 0.
    const n = Math.max(0, Math.round(value - ending));
    return (n + ending).toFixed(2);
  }

  if (action.amount === undefined || !Number.isFinite(action.amount)) return null;
  let next: number;
  if (action.id === "percent") next = value * (1 + action.amount / 100);
  else if (action.id === "absolute") next = value + action.amount;
  else return null;
  return Math.max(0, next).toFixed(2);
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

/** Hard cap on one detached run, counted in diff ENTRIES — i.e. changed
 * CELLS, not rows (the seoBulkMeta handler compares `diff.length` against
 * it; bulkEditorTranslate uses it as its candidate-row window, where one row
 * is exactly one cell). No per-item AI call on the save path, so the ceiling
 * can be much higher than AI bulk paths — it just bounds one runner's
 * worst-case wall-clock time. Client-safe on purpose: submitDiff and the CSV
 * import preview enforce the same ceiling BEFORE submitting (Finding 2). */
export const MAX_BULK_TASK_ITEMS = 500;

/** Assumed number of option values behind a CLEARED option-values cell — its
 * text is empty, so the real count is only known server-side. Deliberately on
 * the high side of a typical option (sizes, colours). */
const CLEARED_OPTION_VALUES_ESTIMATE = 10;

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
  // Variant rows (Phase 3, Plan §5.3): `title` holds the VARIANT title;
  // product context comes via productId/productTitle. Money values are the
  // NORMALIZED dot form ("1299.90", "" = unset) — display formatting is a
  // render concern (formatMoneyForDisplay), the diff always works on the
  // normalized value.
  productId?: string;
  productTitle?: string;
  sku?: string;
  price?: string;
  compareAtPrice?: string;
  barcode?: string;
  position?: number;
  /** Product has >100 variants — the sync window is capped (Plan §5.1); the
   * UI shows a "remainder lives in the Shopify admin" hint. */
  hasMoreVariants?: boolean;
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
  /** Image rows: the row's editable, translatable alt-text (primary locale). */
  altText?: string;
  /** Image rows: the ProductImage cache-row id. The alt translation mirror
   * (ProductImageAltTranslation) is keyed by it, while the ROW id is the
   * Shopify MediaImage GID. */
  imageCacheId?: string;
  /** Metaobject rows (Phase 5): the row's MetaobjectDefinition.type. A
   * mofield column is only editable when its moType matches this. `title`
   * holds the displayName, `handle` the metaobject handle. */
  moType?: string;
  /** Metaobject field values keyed by column id ("mo.<type>.<key>"). A
   * missing entry = the instance has no value for that field yet — empty
   * cell, and the save SETS it via metaobjectUpdate. */
  moFields?: Record<string, string>;
  /** Foreign-language cell values, keyed `${locale}|${marketId}|${columnId}`.
   * Phase 4 (languages/markets) fills this from ContentTranslation; in Phase 1
   * the UI only edits the primary locale, but the diff pipeline already
   * carries the segments so the key format never has to migrate again. */
  foreignValues?: Record<string, string>;
  /** PRIMARY view only: column ids whose primary value is NOT translated into
   * at least one published foreign locale (globally, marketId ""). Drives the
   * "missing translation" (blue) field colour — the grid shows blue when the
   * primary cell HAS content and its column id is listed here. Absent on the
   * foreign views (where the colour is "empty in the selected language"
   * instead, computed client-side from the cell value). */
  untranslatedColumnIds?: string[];
  /** PRIMARY view only: column id → the published foreign locales still MISSING
   * a non-empty translation for that column. Same source as
   * `untranslatedColumnIds` but keeps the per-locale detail (which the flag
   * collapses) so the blue cell can show a "missing in DE, FR" tooltip. */
  untranslatedLocalesByColumnId?: Record<string, string[]>;
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
  | "missingMediaId" // image row lacks the MediaImage GID — resync needed
  | "wrongMetaobjectType" // mofield column of another definition type (Phase 5)
  | "listSeparatorInValue"; // a list entry contains "|" — editing would shatter it (Finding 11)

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
        // "|" is the display separator — an entry containing it would shatter
        // on the split when saving. Read-only + "single editor" tooltip
        // (Finding 11); computeDiff drops any edit that sneaks in.
        if (listValueContainsSeparator(raw)) {
          return { value: formatListMetafieldValue(raw), editable: false, readOnlyReason: "listSeparatorInValue" };
        }
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
    case "variant": {
      // Editable variant cells (Plan §5.3): SKU, price, compareAtPrice,
      // barcode. Money values are stored normalized; display formatting
      // happens at render time.
      switch (column.id) {
        case VAR_SKU_COLUMN_ID:
          return { value: row.sku ?? "", editable: true };
        case VAR_PRICE_COLUMN_ID:
          return { value: row.price ?? "", editable: true };
        case VAR_COMPARE_AT_COLUMN_ID:
          return { value: row.compareAtPrice ?? "", editable: true };
        case VAR_BARCODE_COLUMN_ID:
          return { value: row.barcode ?? "", editable: true };
        default:
          return { value: "", editable: false, readOnlyReason: "column" };
      }
    }
    case "mofield": {
      // Cross-type cell (the union universe contains every definition's
      // columns, Plan §7): a column of another definition type is read-only
      // and empty for this row — computeDiff drops any edit that sneaks in.
      if (row.moType !== column.moType) {
        return { value: "", editable: false, readOnlyReason: "wrongMetaobjectType" };
      }
      const raw = row.moFields?.[column.id] ?? "";
      if (column.moFieldType === METAFIELD_TYPE_RICH_TEXT) {
        return { value: richTextPreview(raw), editable: false, readOnlyReason: "richText" };
      }
      if (column.moFieldType === METAFIELD_TYPE_LIST_SINGLE_LINE) {
        // Same "|"-in-entry guard as list metafields (Finding 11).
        if (listValueContainsSeparator(raw)) {
          return { value: formatListMetafieldValue(raw), editable: false, readOnlyReason: "listSeparatorInValue" };
        }
        return { value: formatListMetafieldValue(raw), editable: true };
      }
      // Missing field on the instance ⇒ empty, still editable — the save
      // SETS the field via metaobjectUpdate (§12 test case).
      return { value: raw, editable: true };
    }
    case "readonly": {
      let value = "";
      if (column.id === "blogTitle") value = row.blogTitle ?? "";
      else if (column.id === "productTitle") value = row.productTitle ?? "";
      else if (column.id === "variantTitle") value = row.title;
      else if (column.id === "position") value = row.position != null ? String(row.position) : "";
      else if (column.id === "policyTitle" || column.id === "moDisplayName") value = row.title;
      else if (column.id === "moHandle") value = row.handle;
      return { value, editable: false, readOnlyReason: "column" };
    }
    default:
      return { value: "", editable: false, readOnlyReason: "column" };
  }
}

/** Per-type membership for a (possibly dynamic) column: dynamic product
 * columns (metafields, options, img.alt) belong to product rows only,
 * mofield columns to metaobject rows only; static columns fall back to the
 * per-type allowlist. */
export function columnAllowedForType(type: BulkRowType, column: ColumnDescriptor): boolean {
  if (column.kind === "metafield" || column.kind === "option" || column.id === IMG_ALT_COLUMN_ID) {
    return type === "product";
  }
  if (column.kind === "mofield") return type === "metaobject";
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
 *
 * NEVER diff without a baseline: an edit whose rowId is not in `rows` is
 * DROPPED here — there is no load baseline to compare against, and inventing
 * one (e.g. "") would turn the save into a blind overwrite (data-loss risk).
 * The route therefore KEEPS such edits in its map (they survive paging via
 * baseline accumulation and become diffable once the row loads) and surfaces
 * their count in a banner instead of silently losing them (Finding 1).
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
    let next = (edits[key] ?? "").trim();
    // Money columns (Plan §5.5): the merchant may have typed a localized form
    // ("1.299,90") or a bulk action may have written a formatted value —
    // normalize BEFORE comparing, so re-typing the same amount in another
    // locale format is not dirty and the diff always carries the normalized
    // dot value. Unparseable input passes through verbatim: it MUST stay
    // dirty and becomes a per-cell failure in the persistence pipeline (a
    // whole-diff rejection would nuke the batch for one typo).
    if (column.inputType === "money") {
      const parsed = parseMoney(next);
      if (parsed.ok) next = parsed.value ?? "";
    }
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
 *   ceil(metafield sets / 25) + ceil(metafield deletes / 25) +
 *   1 productOptionUpdate per dirty option position + 1 productUpdateMedia;
 * - primary variant groups: ONE productVariantsBulkUpdate per PRODUCT
 *   (Plan §5.4 grouping) — the row→product mapping comes from
 *   `opts.variantProductIdByRowId` (the client builds it from the loaded
 *   rows); without it every variant row counts as its own call, which
 *   over-estimates but never under-estimates;
 * - primary non-product group: 1 (single-mutation row); EXCEPT blog rows,
 *   which count 1 blogUpdate + 1 metafieldsDelete when an SEO cell is
 *   CLEARED (Plan §7/§14 no. 4 — clearing global.title_tag/description_tag
 *   needs the extra delete call; setting rides inside blogUpdate);
 * - foreign group: 1 translationsRegister (any non-empty cell) +
 *   1 translationsRemove (any cleared cell);
 * - plus ceil(unique foreign resources / DIGEST_BATCH_CHUNK) digest batches.
 *
 * `columns` is the (current type's) descriptor universe — unknown column ids
 * are counted as one call each (defensive over-estimate, never under).
 */
export function estimateCalls(
  diff: BulkDiffEntry[],
  columns: ColumnDescriptor[],
  opts?: { variantProductIdByRowId?: Record<string, string> },
): number {
  const columnById = new Map(columns.map((c) => [c.id, c] as const));
  const groups = groupDiffByRow(diff);
  let calls = 0;
  const foreignDigestResources = new Set<string>();
  const variantTargets = new Set<string>();

  for (const group of groups) {
    const entries = Object.entries(group.cells);
    if (group.locale !== "") {
      // Sub-resource cells (metafields, product options) do NOT ride on the
      // row's own translationsRegister: each target resource costs its own
      // register/remove call, and an option-VALUES cell is one call per value.
      // Counting them as part of the row's single call would let a save that
      // fans out into hundreds of calls slip past MAX_TASK_CALLS.
      const ownEntries = entries.filter(([columnId]) => {
        const column = columnById.get(columnId);
        return !column || (column.kind !== "metafield" && column.kind !== "option");
      });
      const subEntries = entries.filter(([columnId]) => {
        const column = columnById.get(columnId);
        return column && (column.kind === "metafield" || column.kind === "option");
      });
      const hasWrites = ownEntries.some(([, v]) => v !== "");
      const hasClears = ownEntries.some(([, v]) => v === "");
      calls += (hasWrites ? 1 : 0) + (hasClears ? 1 : 0);
      if (hasWrites) foreignDigestResources.add(group.rowId);
      for (const [columnId, value] of subEntries) {
        const column = columnById.get(columnId);
        // Values cells fan out per entry; the exact count is only known
        // server-side, so estimate with the display separator (over-estimating
        // is the safe direction for a budget guard).
        const isValuesCell = column?.kind === "option" && column.optionField === "values";
        const targets = !isValuesCell
          ? 1
          : value !== ""
            ? Math.max(1, value.split(LIST_DISPLAY_SEPARATOR.trim()).length)
            : // A CLEARED values cell carries no text to count, yet still costs
              // one removeAndVerify per value — estimate high, since the guard
              // must never let a save through that it should have refused.
              CLEARED_OPTION_VALUES_ESTIMATE;
        // One register (or remove) + one digest fetch per target resource.
        calls += targets;
        if (value !== "") calls += Math.ceil(targets / DIGEST_BATCH_CHUNK);
      }
      continue;
    }
    if (group.rowType === "variant") {
      // One mutation per product (§5.4) — fall back to the row id itself when
      // the mapping is unknown (defensive over-estimate).
      variantTargets.add(opts?.variantProductIdByRowId?.[group.rowId] ?? group.rowId);
      continue;
    }
    if (group.rowType === "blog") {
      // updateBlog = ONE blogUpdate (SEO sets ride in its metafields input)
      // plus ONE metafieldsDelete when any SEO half is cleared (§14 no. 4).
      const clearsSeo = entries.some(
        ([columnId, value]) =>
          (columnId === "field.seoTitle" || columnId === "field.seoDescription") && value === "",
      );
      calls += 1 + (clearsSeo ? 1 : 0);
      continue;
    }
    if (group.rowType !== "product") {
      // Single-mutation rows: collection/page/article, policy
      // (shopPolicyUpdate), metaobject (metaobjectUpdate) and image rows
      // (productUpdateMedia) — 1 call each.
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
      Math.ceil(metafieldDeletes / METAFIELDS_SET_CHUNK) +
      optionPositions.size +
      imageAlt;
  }

  calls += variantTargets.size;
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

export type BulkFilterId =
  | "missingSeoTitle"
  | "missingSeoDescription"
  | "missingTranslation"
  // Variant-row filters (Phase 3, Plan §5.3):
  | "missingSku"
  | "missingPrice"
  | "compareAtNotAbovePrice" // compareAtPrice ≤ price — the classic data error
  // Image-row filter (one row = one product medium):
  | "missingAltText";

export const BULK_FILTER_IDS: BulkFilterId[] = [
  "missingSeoTitle",
  "missingSeoDescription",
  "missingTranslation",
  "missingSku",
  "missingPrice",
  "compareAtNotAbovePrice",
  "missingAltText",
];

/** Filters that apply to variant rows — the FilterBar shows exactly these for
 * type "variant" and exactly the others for the content types. */
export const VARIANT_FILTER_IDS: BulkFilterId[] = ["missingSku", "missingPrice", "compareAtNotAbovePrice"];

/** Which filter vocabulary a row type speaks (Phase 3/5): "content" = SEO +
 * translation filters; "variant" = the price/SKU data filters;
 * "translationOnly" = policy/metaobject rows, which have no SEO columns. */
export type BulkFilterSet = "content" | "variant" | "translationOnly" | "image";

export function filterSetForType(type: BulkRowType): BulkFilterSet {
  if (type === "variant") return "variant";
  if (type === "image") return "image";
  if (type === "policy" || type === "metaobject") return "translationOnly";
  return "content";
}

/**
 * THE per-set filter-id source (Finding 13): the FilterBar builds its choices
 * from this, and handleTypeChange prunes the URL's filter ids against the
 * NEW type's set on a type switch — otherwise e.g. `missingSku` silently
 * rides along into a product view.
 */
export const FILTER_IDS_BY_SET: Record<BulkFilterSet, BulkFilterId[]> = {
  content: ["missingSeoTitle", "missingSeoDescription", "missingTranslation"],
  variant: VARIANT_FILTER_IDS,
  translationOnly: ["missingTranslation"],
  image: ["missingAltText", "missingTranslation"],
};

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
