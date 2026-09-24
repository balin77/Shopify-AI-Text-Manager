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
// The enum vocabularies the create form and the single editor already offer.
// From the import-FREE leaf module, never from create-fields.config: that file
// imports metaobject-fields.shared, which imports this one, and spreading a
// constant across that cycle reads it before it is initialised.
import {
  COLLECTION_SORT_ORDERS,
  WEIGHT_UNITS,
  INVENTORY_POLICIES,
} from "../../config/shopify-enums.shared";

// ─── Row types ─────────────────────────────────────────────────────────────

/** Row types the bulk editor supports. "variant" (Phase 3, Plan §5.3): one
 * row = one variant, with product image/title as read-only sticky context
 * columns. Phase 5 (Plan §7): "blog" = blog CONTAINERS (live-fetched, no DB
 * cache), "policy" = ShopPolicy rows, "metaobject" = Metaobject rows with
 * per-definition dynamic columns. */
export type BulkRowType =
  | "product"
  | "variant"
  /** One row = one IMAGE of the shop (its Shopify MediaImage GID is the row
   * id): product media from the product cache, everything else from the media
   * library. */
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
  // Image rows ride the products gate (and, on top of it, the productImages
  // cache flag; see allowedRowTypesForPlan) — product media are the bulk of
  // them and the cache they need is the product-image one.
  image: "products",
};

/**
 * The content type `/api/ai` accepts — NOT the same vocabulary as the plan
 * gate above. `VALID_CONTENT_TYPES` is `Object.keys(CONTENT_CONFIGS)` plus
 * "templates"/"metaobjects"; "articles" is a PLAN content type only (the AI
 * layer serves articles out of the blogs config, exactly like
 * content-rubrics.ts maps the "blogs" rubric to planContentType "articles").
 * Posting "articles" to /api/ai 400s before any handler runs, which silently
 * broke every AI action on article rows.
 */
export const BULK_ROW_TYPE_TO_AI_CONTENT_TYPE: Record<BulkRowType, string> = {
  ...BULK_ROW_TYPE_TO_CONTENT_TYPE,
  article: "blogs",
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
  /** "category" and "collections" are PICKER cells: the value is a GID (or a
   *  canonical list of them) that no merchant types, so the cell renders the
   *  same picker the single editor uses instead of a text box — see
   *  `isPickerColumn`. */
  inputType: "text" | "textarea" | "select" | "money" | "number" | "boolean" | "category" | "collections";
  minWidth: number;
  /** Upper bound for the column's grid track. Without it a column grows to an
   * equal 1fr share, which wastes the row's width on columns whose content is
   * always tiny (a position number). */
  maxWidth?: number;
  /** DB column backing a server-side sort — absent means the column is NOT
   * sortable and the header must not render a sort affordance (Plan §3.3). */
  sortKey?: string;
  /** inputType "select": the enum values this column accepts, in offer order.
   *
   * The VALUE vocabulary, never the labels — those are i18n and live in
   * `t.bulkEditor.enumLabels` keyed `<column.label>.<value>`, so the grid can
   * word "true" as "Sichtbar" on one column and "Ja" on the next. Carried on
   * the descriptor rather than in the cell component because both ends need
   * it: the cell offers exactly these, and the server refuses anything else
   * before the value can fail at the GraphQL SCHEMA level — where a bad enum
   * comes back as a top-level `errors` array with `data: null` that never
   * reaches `userErrors`, i.e. a save that reads as a success while nothing
   * was written.
   *
   * Deliberately NOT how `field.templateSuffix` gets its options: those are
   * the published THEME's files, so they are per shop and per resource, which
   * a static column universe cannot carry (and which the server, like the
   * single editor, does not re-validate). The grid feeds that one list in as a
   * prop; see `ThemeTemplateField` for the same lookup one item at a time. */
  selectOptions?: string[];
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

/**
 * Bulk-editor column field names that differ from the canonical UI field names
 * of FIELD_TO_TRANSLATION_KEY (shopify-content.service.ts — the ONE exported
 * map). Only aliases live here; the actual field→key mapping must never be
 * re-declared.
 */
const COLUMN_FIELD_ALIAS: Record<string, string> = {
  descriptionHtml: "description",
  seoDescription: "metaDescription",
};

/** Canonical UI field name for a bulk column ("descriptionHtml" →
 * "description") — the name the AI prompts and the single-editor paths use.
 * Client-safe: the grid's cell actions address the AI endpoints with it. */
export function canonicalFieldNameForColumn(column: ColumnDescriptor): string {
  const field = fieldNameOfColumn(column);
  return COLUMN_FIELD_ALIAS[field] ?? field;
}

/** For kind "field": the flat row property (and Prisma column) behind the
 * column — "field.title" → "title". */
export function fieldNameOfColumn(column: ColumnDescriptor): string {
  return column.id.startsWith("field.") ? column.id.slice("field.".length) : column.id;
}

/**
 * The key an AI prompt sees for a column: the canonical field name
 * ("description", "title"), or the metaobject field key — which is the shop's
 * own descriptive name and reads far better in a prompt than "mo.<type>.<key>".
 * THE one definition; both the bulkEditorTranslate task and the grid's
 * per-cell actions call it, so the two cannot drift apart.
 */
export function aiFieldKey(column: ColumnDescriptor): string {
  return column.kind === "mofield" ? (column.moFieldKey ?? column.id) : canonicalFieldNameForColumn(column);
}

/**
 * Cells whose VALUE is a "|"-joined list of independent entries: option values
 * and list.single_line_text_field metafields. They must never be handed to the
 * AI as one blob — the model drops the separator or the entry count and the
 * write then either hard-fails (options: `apply.server.ts` checks the count)
 * or silently collapses an N-entry list into one (`parseListMetafieldInput`
 * splits on "|"). Translate them entry by entry and rejoin.
 */
export function isListShapedColumn(column: ColumnDescriptor): boolean {
  if (column.kind === "option") return column.optionField === "values";
  return column.metafieldType === METAFIELD_TYPE_LIST_SINGLE_LINE;
}

/**
 * Whether a column can EVER offer the per-cell action menu, judged from the
 * descriptor alone. The grid reserves its action gutter on this, deliberately
 * NOT on whether the currently loaded rows happen to have an actionable cell:
 * editability is per row (a product without a second option, an image without
 * a mediaId), so probing the rows would make the track width jump on every
 * page turn, filter and search.
 */
export function columnCanHaveCellActions(column: ColumnDescriptor): boolean {
  if (!column.editable) return false;
  if (
    column.inputType === "select" ||
    column.inputType === "money" ||
    column.inputType === "number" ||
    isPickerColumn(column)
  ) {
    return false;
  }
  return column.kind === "field" || column.translatable;
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

/**
 * Alt text of a collection's / article's FEATURED image.
 *
 * Translatable, unlike the product row's `img.alt`: verified live against the
 * API (Settings → Translation Probe), `translatableResource` on the image's
 * own `CollectionImage`/`ArticleImage` GID offers the key `alt`. The two sides
 * of the write deliberately do NOT share an id — Shopify stores the
 * translation on the IMAGE resource, while the DB mirror sits on the PARENT
 * row (`ContentTranslation.key = "image_alt_text"`), which is exactly what the
 * single editor writes, so both editors read each other's rows.
 *
 * NOT the same picture as the media library's `MediaImage` of the same file:
 * the probe found the collection's file in Files with an EMPTY alt while the
 * CollectionImage alt was set. Two records — writing the file would not move
 * this value.
 */
export const FEATURED_IMAGE_ALT_COLUMN_ID = "img.featuredAlt";

const FEATURED_IMAGE_ALT_COLUMN: ColumnDescriptor = {
  id: FEATURED_IMAGE_ALT_COLUMN_ID,
  kind: "image",
  label: "featuredImgAlt",
  group: "images",
  editable: true,
  translatable: true,
  inputType: "text",
  minWidth: 220,
};

/**
 * Shopify calls ONE featured-image alt translation costs: resolve the image
 * GID from the parent, fetch its digest, then register (or remove) — none of
 * them shared with the row's own translationsRegister.
 */
const FEATURED_ALT_TRANSLATION_CALLS = 3;

/** The featured-image alt is a THIRD translation shape (Shopify target and DB
 * mirror have different ids), so every site that branches on it asks here
 * rather than pattern-matching the column id. */
export function isFeaturedImageAltColumn(column: ColumnDescriptor): boolean {
  return column.id === FEATURED_IMAGE_ALT_COLUMN_ID;
}

/**
 * The product's taxonomy category and its collection memberships — edited in
 * the grid through the SAME pickers the single editor uses.
 *
 * Neither survives a text cell, which is why they were read-only first and why
 * they are PICKER cells now rather than text:
 *
 *  - A category is a `TaxonomyCategory` GID chosen from Shopify's tree. Its NAME
 *    is what a merchant reads, and a name is not a value that can be written
 *    back — the tree repeats names under different parents. So the cell VALUE is
 *    the GID (the single editor's representation), and the picker shows the
 *    name.
 *  - A membership is a JOIN/LEAVE DIFF (`collectionsToJoin`/`ToLeave`), never a
 *    list: a product can belong to collections whose rows this shop never
 *    cached, collection titles are not unique, and a RULE-BASED collection must
 *    be refused in both directions — Shopify rejects a manual join on one, and
 *    because `productUpdate` is atomic that refusal takes the merchant's text
 *    edits with it. So the cell value is the membership as canonical GIDs
 *    (`canonicalCollectionIds`), the picker LOCKS what the server would refuse
 *    (`collectionPickerRows`, shared with the editor), and the save diffs
 *    against the CACHE with `diffCollectionMembership` exactly as the editor's
 *    save does.
 *
 * The value being a GID is also why a rectangular PASTE must not reach these
 * cells, and why the server refuses a cell carrying anything but GIDs: the
 * editor's lenient `parseCollectionIds` drops what it cannot read, so a pasted
 * "Sale, Winter" would parse to NO collections and be saved as "leave every
 * manual collection".
 */
export const CATEGORY_COLUMN_ID = "field.category";
export const COLLECTIONS_COLUMN_ID = "field.collections";

const COL_CATEGORY = fieldColumn("category", {
  translatable: false,
  inputType: "category",
  minWidth: 220,
});

const COL_COLLECTIONS = fieldColumn("collections", {
  translatable: false,
  inputType: "collections",
  minWidth: 240,
});

/** A cell whose value only a picker can produce (see COL_CATEGORY). */
export function isPickerColumn(column: ColumnDescriptor): boolean {
  return column.inputType === "category" || column.inputType === "collections";
}

/**
 * What a picker cell SHOWS where no picker is rendered — a read-only cell (the
 * foreign-language tabs, an unsynced row), which otherwise prints its value.
 *
 * The value is GIDs, and a merchant reading "gid://shopify/Collection/123" in a
 * column where the names used to be has learned nothing. The category shows the
 * cached PATH while the value is still the cached one; memberships show their
 * titles from the row. An id this row cannot name stays the id — an honest
 * "we do not know its name" rather than a blank that reads as "none".
 */
export function pickerDisplayValue(row: BulkRow, column: ColumnDescriptor, value: string): string {
  if (column.inputType === "category") {
    return value && value === row.category ? row.categoryName || value : value;
  }
  if (column.inputType === "collections") {
    const titles = new Map(
      (row.collectionMemberships ?? []).map((m) => [m.collectionId, m.collectionTitle] as const),
    );
    return value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => titles.get(id) || id)
      .join(", ");
  }
  return value;
}

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

/** `isPublished`, `taxable`, … — a boolean cell is a two-value enum, so it
 *  rides the same select machinery rather than growing a checkbox kind of its
 *  own. The strings are what the diff, the CSV round trip and the edit map all
 *  carry; only the LABEL differs per column (`enumLabels`). */
export const BOOLEAN_SELECT_OPTIONS = ["true", "false"];

export const VAR_SKU_COLUMN_ID = "var.sku";
export const VAR_PRICE_COLUMN_ID = "var.price";
export const VAR_COMPARE_AT_COLUMN_ID = "var.compareAtPrice";
export const VAR_BARCODE_COLUMN_ID = "var.barcode";

// ─── The Phase-4 commerce block (PLAN_CONTENT_CREATION §Phase 4) ───────────
//
// The single editor's variants card has had these since Phase 4; the grid had
// four of its fourteen. Cost, tax, the stock policy and everything customs
// wants are exactly the fields a merchant corrects across a catalogue rather
// than one variant at a time.
//
// TWO Shopify objects, which is the only thing that is structurally
// interesting here: `taxable` and `inventoryPolicy` are fields of the VARIANT
// and ride the existing `productVariantsBulkUpdate`, while cost, the weight,
// the customs fields and `tracked` live on the variant's INVENTORY ITEM and
// need `inventoryItemUpdate` — addressed by `inventoryItemId`, which is why
// the sync stores it at all and why a variant without one shows these cells
// read-only rather than offering a control that fails.
//
// What is deliberately NOT here is the QUANTITY. A stock level is a claim
// about a moment: the panel reads it LIVE and writes it with `compareQuantity`
// against the number the merchant was looking at, so a value that moved under
// their feet is refused rather than overwritten. A grid cell fed from a cache
// cannot make that promise, and "cached + typed number" is the classic source
// of inventory drift. It stays in the editor's stock panel.

export const VAR_COST_COLUMN_ID = "var.cost";
export const VAR_TAXABLE_COLUMN_ID = "var.taxable";
export const VAR_INVENTORY_POLICY_COLUMN_ID = "var.inventoryPolicy";
export const VAR_INVENTORY_TRACKED_COLUMN_ID = "var.inventoryTracked";
export const VAR_WEIGHT_COLUMN_ID = "var.weight";
export const VAR_WEIGHT_UNIT_COLUMN_ID = "var.weightUnit";
export const VAR_REQUIRES_SHIPPING_COLUMN_ID = "var.requiresShipping";
export const VAR_COUNTRY_OF_ORIGIN_COLUMN_ID = "var.countryCodeOfOrigin";
export const VAR_HS_CODE_COLUMN_ID = "var.harmonizedSystemCode";

/**
 * The three variant columns a PRODUCT row may carry.
 *
 * A price is not a property of a product — it is a property of a variant, which
 * is why "where is the price column?" has an answer that is correct and
 * unhelpful at the same time ("under Produktvarianten"). For the shop that
 * sells one thing per product, though, the product's ONE variant is the
 * product, and making a merchant switch row types to reprice it is the kind of
 * correctness nobody asked for.
 *
 * So exactly these three appear on product rows, editable only where the
 * product has exactly ONE variant — otherwise the cell would have to pick one
 * of several prices to show and one to overwrite, and either choice is wrong.
 * The rest of the commerce block stays on the variant rows: cost, customs and
 * the stock policy are per-variant settings a merchant goes looking for, not
 * numbers they scan a catalogue for.
 */
export const PRODUCT_VARIANT_COLUMN_IDS = new Set([
  VAR_PRICE_COLUMN_ID,
  VAR_COMPARE_AT_COLUMN_ID,
  VAR_SKU_COLUMN_ID,
]);

/** The commerce columns whose value lives on the variant's INVENTORY ITEM —
 *  a second mutation, and unreachable without an `inventoryItemId`. */
export const INVENTORY_ITEM_COLUMN_IDS = new Set([
  VAR_COST_COLUMN_ID,
  VAR_INVENTORY_TRACKED_COLUMN_ID,
  VAR_WEIGHT_COLUMN_ID,
  VAR_WEIGHT_UNIT_COLUMN_ID,
  VAR_REQUIRES_SHIPPING_COLUMN_ID,
  VAR_COUNTRY_OF_ORIGIN_COLUMN_ID,
  VAR_HS_CODE_COLUMN_ID,
]);

/** Every column fed by the Phase-4 commerce block, whose emptiness only means
 *  something once `commerceSyncedAt` is set — the variant-level twin of
 *  ATTRIBUTE_BLOCK_COLUMNS. Price, compare-at, SKU and barcode are NOT in it:
 *  they predate that block and come from the ordinary product sync. */
export const COMMERCE_BLOCK_COLUMNS = new Set([
  ...INVENTORY_ITEM_COLUMN_IDS,
  VAR_TAXABLE_COLUMN_ID,
  VAR_INVENTORY_POLICY_COLUMN_ID,
]);

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
  // A two-digit number and the sort affordance — nothing here ever needs more,
  // and the width is better spent on the text columns next to it.
  minWidth: 56,
  maxWidth: 72,
  sortKey: "position",
};

function variantColumn(
  id: string,
  label: string,
  opts: {
    inputType: ColumnDescriptor["inputType"];
    minWidth: number;
    sortKey?: string;
    selectOptions?: string[];
  },
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
    // A boolean is a two-value enum here (BOOLEAN_SELECT_OPTIONS); a select
    // with no vocabulary would render as an empty dropdown, which is a control
    // whose next save clears a working value.
    ...(opts.selectOptions
      ? { selectOptions: opts.selectOptions }
      : opts.inputType === "select"
        ? { selectOptions: BOOLEAN_SELECT_OPTIONS }
        : {}),
  };
}

const VAR_SKU_COLUMN = variantColumn(VAR_SKU_COLUMN_ID, "sku", { inputType: "text", minWidth: 140, sortKey: "sku" });
const VAR_PRICE_COLUMN = variantColumn(VAR_PRICE_COLUMN_ID, "price", { inputType: "money", minWidth: 110, sortKey: "price" });
const VAR_COMPARE_AT_COLUMN = variantColumn(VAR_COMPARE_AT_COLUMN_ID, "compareAtPrice", { inputType: "money", minWidth: 130, sortKey: "compareAtPrice" });
const VAR_BARCODE_COLUMN = variantColumn(VAR_BARCODE_COLUMN_ID, "barcode", { inputType: "text", minWidth: 140 });

const VAR_COST_COLUMN = variantColumn(VAR_COST_COLUMN_ID, "cost", { inputType: "money", minWidth: 120 });
const VAR_TAXABLE_COLUMN = variantColumn(VAR_TAXABLE_COLUMN_ID, "taxable", {
  inputType: "select",
  minWidth: 140,
  selectOptions: BOOLEAN_SELECT_OPTIONS,
});
const VAR_INVENTORY_POLICY_COLUMN = variantColumn(VAR_INVENTORY_POLICY_COLUMN_ID, "inventoryPolicy", {
  inputType: "select",
  minWidth: 200,
  selectOptions: [...INVENTORY_POLICIES],
});
const VAR_INVENTORY_TRACKED_COLUMN = variantColumn(VAR_INVENTORY_TRACKED_COLUMN_ID, "inventoryTracked", {
  inputType: "select",
  minWidth: 170,
  selectOptions: BOOLEAN_SELECT_OPTIONS,
});
/** Value and unit are ONE value to Shopify (it replaces the measurement rather
 *  than merging into it), but two cells here — so a save that carries only one
 *  of them takes the other from the cached row, and refuses when the cache has
 *  no unit to take. A number with no unit is not a weight. */
const VAR_WEIGHT_COLUMN = variantColumn(VAR_WEIGHT_COLUMN_ID, "weight", {
  inputType: "number",
  minWidth: 110,
});
const VAR_WEIGHT_UNIT_COLUMN = variantColumn(VAR_WEIGHT_UNIT_COLUMN_ID, "weightUnit", {
  inputType: "select",
  minWidth: 150,
  selectOptions: [...WEIGHT_UNITS],
});
const VAR_REQUIRES_SHIPPING_COLUMN = variantColumn(VAR_REQUIRES_SHIPPING_COLUMN_ID, "requiresShipping", {
  inputType: "select",
  minWidth: 170,
});
const VAR_COUNTRY_OF_ORIGIN_COLUMN = variantColumn(VAR_COUNTRY_OF_ORIGIN_COLUMN_ID, "countryCodeOfOrigin", {
  inputType: "text",
  minWidth: 150,
});
const VAR_HS_CODE_COLUMN = variantColumn(VAR_HS_CODE_COLUMN_ID, "harmonizedSystemCode", {
  inputType: "text",
  minWidth: 150,
});

function fieldColumn(
  name: string,
  opts: {
    translatable: boolean;
    inputType: ColumnDescriptor["inputType"];
    minWidth: number;
  /** Upper bound for the column's grid track. Without it a column grows to an
   * equal 1fr share, which wastes the row's width on columns whose content is
   * always tiny (a position number). */
  maxWidth?: number;
    sortKey?: string;
    group?: ColumnGroup;
    selectOptions?: string[];
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
    ...(opts.selectOptions ? { selectOptions: opts.selectOptions } : {}),
  };
}

// The nine editable fields of the former bulk-meta editor, now as descriptors.
// translatable mirrors Shopify's translatable keys for these resources
// (title/body_html/handle/meta_title/meta_description/product_type/summary_html);
// status is a Shopify enum and never translatable.
const COL_TITLE = fieldColumn("title", { translatable: true, inputType: "text", minWidth: 220, sortKey: "title" });
const COL_DESCRIPTION_HTML = fieldColumn("descriptionHtml", { translatable: true, inputType: "textarea", minWidth: 280 });
const COL_PRODUCT_TYPE = fieldColumn("productType", { translatable: true, inputType: "text", minWidth: 200, sortKey: "productType" });
/**
 * The four values, in the order the grid has always offered them.
 *
 * Written out rather than spread from `CREATE_PRODUCT_STATUSES` because that
 * constant leads with DRAFT (a create form's default) and reshuffling a
 * dropdown merchants already know is a change nobody asked for. The two must
 * still describe the same SET, which is the half that actually matters —
 * `bulk-editor.attributes.test.ts` ("offers exactly the enum values the single
 * editor does") fails when they drift.
 */
const PRODUCT_STATUS_OPTIONS = ["ACTIVE", "DRAFT", "UNLISTED", "ARCHIVED"];

const COL_STATUS = fieldColumn("status", {
  translatable: false,
  inputType: "select",
  minWidth: 130,
  sortKey: "status",
  selectOptions: PRODUCT_STATUS_OPTIONS,
});
// PLAN_CONTENT_CREATION §Phase 3.6 — the two merchandising attributes the
// single editor gained in §3.1, pulled through to the grid where they are
// worth most: vendor and tags are the fields a merchant fixes across a whole
// catalogue, not one product at a time.
//
// Neither is translatable — Shopify stores one value per product — so they
// carry `translatable: false` like `status`, which keeps them out of every
// foreign-locale group by the same rule that already governs it.
//
// `tags` is a LIST behind one cell, comma-separated in the grid the same way
// the single editor's chips serialise. Written whole, because that is what
// `productUpdate` does with it: a cell edit REPLACES the product's tags.
const COL_VENDOR = fieldColumn("vendor", { translatable: false, inputType: "text", minWidth: 160, sortKey: "vendor" });
const COL_TAGS = fieldColumn("tags", { translatable: false, inputType: "text", minWidth: 220 });

// ─── The remaining merchandising attributes (PLAN_CONTENT_CREATION §3) ─────
//
// Until now these existed only in the single editor, which meant the one kind
// of field a merchant fixes across a whole catalogue — "put every gift product
// on the gift template", "unpublish last season's articles" — was the one kind
// they had to open five hundred items to reach.
//
// Every one of them is UNTRANSLATABLE (`translationKey: ""` in the single
// editor's config, one value per item), so `translatable: false` keeps them out
// of the foreign-locale groups by the rule that already governs status, vendor
// and tags. They also all live in the Phase-0 attribute block, so their cells
// are read-only until `attributesSyncedAt` is set — see
// ATTRIBUTE_BLOCK_COLUMNS, where an empty value and a never-fetched one are
// finally told apart.

/** The theme file that renders the item. A suffix nobody created renders the
 *  DEFAULT template and reports nothing anywhere, which is why the single
 *  editor made this a dropdown — and why it matters more here, where one typo
 *  is applied to every selected row. The OPTIONS are the published theme's and
 *  arrive as a prop (see `selectOptions`' note); with the lookup failed the
 *  cell falls back to a text box, exactly as `ThemeTemplateField` does. */
const COL_TEMPLATE_SUFFIX = fieldColumn("templateSuffix", {
  translatable: false,
  inputType: "select",
  minWidth: 190,
});

/** Pages and articles are visible or not. NOT the product's four-value status:
 *  a different field on a different mutation, and conflating the two is how a
 *  hidden article gets published by a title edit. */
const COL_IS_PUBLISHED = fieldColumn("isPublished", {
  translatable: false,
  inputType: "select",
  minWidth: 170,
  selectOptions: BOOLEAN_SELECT_OPTIONS,
});

/** Shopify's CollectionSortOrder. A GraphQL ENUM, so the offered set has to be
 *  exactly the accepted one. */
const COL_SORT_ORDER = fieldColumn("sortOrder", {
  translatable: false,
  inputType: "select",
  minWidth: 210,
  selectOptions: [...COLLECTION_SORT_ORDERS],
});

/** An article's author. `ArticleCreateInput.author` is REQUIRED, so an article
 *  always has one — which is why clearing this cell is refused rather than
 *  written (attributeInputFor reports it as rejected). */
const COL_AUTHOR = fieldColumn("author", {
  translatable: false,
  inputType: "text",
  minWidth: 180,
});
const COL_HANDLE = fieldColumn("handle", { translatable: true, inputType: "text", minWidth: 220, sortKey: "handle" });
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

/**
 * "Where does this image belong": the owning product for product media, the
 * best-effort usage label for every other image of the shop (theme, metaobject,
 * … or "unused"). Read-only — it describes the image, it does not change it.
 */
const IMAGE_USAGE_COLUMN: ColumnDescriptor = {
  id: "imageUsage",
  kind: "readonly",
  label: "imageUsage",
  group: "base",
  editable: false,
  translatable: false,
  inputType: "text",
  minWidth: 200,
  // Only the product-media segment is DB-sortable by it (nested product.title).
  sortKey: "productTitle",
};

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
    COL_VENDOR,
    COL_TAGS,
    COL_TEMPLATE_SUFFIX,
    // Picker cells — see COL_CATEGORY for why a picker and not text.
    COL_CATEGORY,
    COL_COLLECTIONS,
    COL_HANDLE,
    COL_SEO_TITLE,
    COL_SEO_DESCRIPTION,
    // The single variant's price, compare-at price and SKU — see
    // PRODUCT_VARIANT_COLUMN_IDS for why only these three and only here.
    VAR_PRICE_COLUMN,
    VAR_COMPARE_AT_COLUMN,
    VAR_SKU_COLUMN,
  ],
  variant: [
    IMAGE_COLUMN,
    PRODUCT_TITLE_COLUMN,
    VARIANT_TITLE_COLUMN,
    VAR_SKU_COLUMN,
    VAR_PRICE_COLUMN,
    VAR_COMPARE_AT_COLUMN,
    VAR_COST_COLUMN,
    VAR_TAXABLE_COLUMN,
    VAR_BARCODE_COLUMN,
    VAR_INVENTORY_TRACKED_COLUMN,
    VAR_INVENTORY_POLICY_COLUMN,
    VAR_WEIGHT_COLUMN,
    VAR_WEIGHT_UNIT_COLUMN,
    VAR_REQUIRES_SHIPPING_COLUMN,
    VAR_COUNTRY_OF_ORIGIN_COLUMN,
    VAR_HS_CODE_COLUMN,
    VARIANT_POSITION_COLUMN,
  ],
  collection: [
    IMAGE_COLUMN,
    COL_TITLE,
    COL_DESCRIPTION_HTML,
    COL_SORT_ORDER,
    COL_TEMPLATE_SUFFIX,
    COL_HANDLE,
    COL_SEO_TITLE,
    COL_SEO_DESCRIPTION,
    FEATURED_IMAGE_ALT_COLUMN,
  ],
  article: [
    IMAGE_COLUMN,
    BLOG_TITLE_COLUMN,
    COL_TITLE,
    COL_SUMMARY,
    COL_BODY,
    COL_AUTHOR,
    COL_TAGS,
    COL_IS_PUBLISHED,
    COL_TEMPLATE_SUFFIX,
    COL_HANDLE,
    COL_SEO_TITLE,
    COL_SEO_DESCRIPTION,
    FEATURED_IMAGE_ALT_COLUMN,
  ],
  page: [
    IMAGE_COLUMN,
    COL_TITLE,
    COL_BODY,
    COL_IS_PUBLISHED,
    COL_TEMPLATE_SUFFIX,
    COL_HANDLE,
    COL_SEO_TITLE,
    COL_SEO_DESCRIPTION,
  ],
  // Blog CONTAINERS (Plan §7): no body — Shopify's translatable keys for BLOG
  // are title/handle/meta_title/meta_description (Plan §14 no. 6), and the
  // primary write path (blogUpdate + global.title_tag/description_tag
  // metafields) covers exactly these four. Rows are live-fetched (no DB
  // cache), so the sortKeys here are resolved IN MEMORY by the loader.
  blog: [COL_TITLE, COL_TEMPLATE_SUFFIX, COL_HANDLE, COL_SEO_TITLE, COL_SEO_DESCRIPTION],
  // Policies (Plan §7): title read-only (§14 — shopPolicyUpdate has no title
  // input), body editable exactly like descriptionHtml/body on other types.
  // body IS translatable — under the ShopPolicy key exception ("body", not
  // "body_html"; fieldTranslationKeyMap in shopify-content.service.ts).
  policy: [POLICY_TITLE_COLUMN, COL_BODY],
  // Metaobjects (Plan §7): static read-only context columns only — the
  // editable columns are the per-definition mofield columns appended by
  // buildColumnsForType from the shop's MetaobjectDefinition specs.
  metaobject: [MO_DISPLAY_NAME_COLUMN, MO_HANDLE_COLUMN],
  // Image rows (one row = one image of the shop, keyed by its MediaImage GID).
  // "Used by" answers where the image belongs — the owning product, or the
  // media library's usage label; position is Shopify's media order.
  image: [IMAGE_COLUMN, IMAGE_USAGE_COLUMN, VARIANT_POSITION_COLUMN, IMAGE_ROW_ALT_COLUMN],
};

export function getColumnForType(type: BulkRowType, columnId: string): ColumnDescriptor | undefined {
  return BULK_COLUMNS_BY_TYPE[type].find((c) => c.id === columnId);
}

/**
 * The canonical spelling of a select cell's value, or null if it has none.
 *
 * The grid's dropdown can only ever produce the vocabulary, but the grid is not
 * the only entrance: a rectangular PASTE writes raw text into whatever cells it
 * covers, and a CSV import writes whatever the file says. Without this, one
 * pasted "Ja" column read as `true` on every boolean cell it touched — turning
 * tax on for tax-exempt variants and publishing hidden pages — because the
 * boolean readers treat anything that is not the exact string "false" as true.
 * That is the right reading of a two-value enum and the wrong reading of
 * arbitrary text, and the fix is to make sure only the enum ever reaches them.
 *
 * It NORMALIZES rather than merely judging, because the values come out of
 * spreadsheets: "  unlisted  " is the merchant meaning UNLISTED, and the
 * product status path has trimmed and uppercased for exactly that reason since
 * before this existed. Matching case-insensitively and writing the canonical
 * option back does it once, for every select column, instead of each reader
 * inventing its own tolerance — which is also what makes `value !== "false"`
 * downstream a safe reading again.
 *
 * `templateSuffix` is the one select with no static vocabulary (its options are
 * the published theme's files), so it is deliberately not judged here — its
 * cell falls back to a text box for the same reason.
 *
 * An EMPTY value has no canonical form either: none of these enums has a blank
 * member, so "" is a cell somebody cleared into a value Shopify will not take.
 */
export function canonicalSelectValue(column: ColumnDescriptor, value: string): string | null {
  if (column.inputType !== "select" || !column.selectOptions) return value;
  const needle = value.trim().toLowerCase();
  return column.selectOptions.find((option) => option.toLowerCase() === needle) ?? null;
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
        minWidth: field === "values" ? 240 : 200,
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
    // READ-ONLY on purpose. It only ever covered the MAIN image, and its
    // translation rides on the MediaImage resource, which a product row cannot
    // address — so it was editable in the primary language and greyed out in
    // every other one, for one image out of many. The Images row type has a
    // row per picture with a full, translatable write path; this cell shows
    // the value for context and links there (see onShowImages).
    editable: false,
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
  const parsed = parseDecimalInput(input);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return { ok: true, value: null };
  return { ok: true, value: Number(parsed.value).toFixed(2) };
}

/**
 * The SEPARATOR rules of `parseMoney`, without the money.
 *
 * Extracted because the unit-price quantity needs the identical
 * de/es-vs-en decision - a merchant typing "1.000" for a 1000 ml bottle must
 * not have it silently read as 1 - but must NOT be rounded to two decimals:
 * 0.125 kg is a quantity, where 0.125 of a franc is not a price. Two copies of
 * rule 3 is exactly how the ambiguity guard would come back missing from one
 * of them.
 *
 * Returns the normalized value with its own precision intact, or the same
 * three errors `parseMoney` reports.
 */
export function parseDecimalInput(input: string): ParseMoneyResult {
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
  return { ok: true, value: normalized };
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
  // §Phase 3.6. `tags` is a LIST behind one cell — comma-separated, written
  // whole (productUpdate replaces the list rather than appending to it).
  vendor?: string;
  tags?: string;
  /** The remaining merchandising attributes, as grid strings. `isPublished`
   *  is "true"/"false" (a two-value enum; see BOOLEAN_SELECT_OPTIONS), the
   *  other three are the stored value verbatim — an empty `templateSuffix` is
   *  the theme's DEFAULT template and an empty `sortOrder` is "not set", both
   *  of which the cell offers as a named option rather than as a blank. */
  templateSuffix?: string;
  isPublished?: string;
  sortOrder?: string;
  author?: string;
  /** False ⇒ `vendor`/`tags` above are the migration's defaults, not the
   *  merchant's data (§2.4). The grid shows them as unknown, never as empty. */
  attributesKnown?: boolean;
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
  /** §Phase 4 commerce block, as grid strings. The booleans are "true"/"false"
   *  (two-value enums), the money and the weight are the normalized dot form
   *  ("12.50", "" = unset) and the two enums are Shopify's own values. */
  cost?: string;
  taxable?: string;
  inventoryPolicy?: string;
  inventoryTracked?: string;
  weight?: string;
  weightUnit?: string;
  requiresShipping?: string;
  countryCodeOfOrigin?: string;
  harmonizedSystemCode?: string;
  /** False ⇒ every field of the block above is the migration's default, not
   *  the shop's data (`ProductVariant.commerceSyncedAt`) — the variant twin of
   *  `attributesKnown`. The grid shows them as unknown, never as empty. */
  commerceKnown?: boolean;
  /** PRODUCT rows: the taxonomy category's GID ("" = none) — the cell VALUE —
   *  and its full path, which is what the picker shows (see COL_CATEGORY). */
  category?: string;
  categoryName?: string;
  /** PRODUCT rows: the memberships as canonical collection GIDs (the cell
   *  VALUE, `canonicalCollectionIds`), and the rows behind them with their
   *  titles and rule-based flags, which the picker needs to name and LOCK
   *  them. */
  collections?: string;
  collectionMemberships?: {
    collectionId: string;
    collectionTitle: string;
    automated: boolean | null;
  }[];
  /** PRODUCT rows: the membership list above is INCOMPLETE — the product
   *  belongs to more collections than the sync's window fetched. The picker
   *  says so; editing stays safe, because the save diffs against the cache and
   *  a membership the cache never held can never be "left". */
  hasMoreCollections?: boolean;
  /** PRODUCT rows: the product's ONE variant, when it has exactly one — the
   *  price, compare-at price and SKU cells then edit it directly. Absent means
   *  either "more than one variant" (`variantCount`, which the cell reports as
   *  such) or "the variants were never cached". */
  singleVariant?: { id: string; price: string; compareAtPrice: string; sku: string };
  /** PRODUCT rows: how many variants the cache holds, capped at the loader's
   *  peek. Null ⇒ not cached at all, which is a different cell state from
   *  "several". */
  variantCount?: number | null;
  /** The variant's InventoryItem GID — the address cost, weight, the customs
   *  fields and `tracked` are written at. Absent ⇒ those cells are read-only:
   *  there is nothing to write them to, and a resync is the way in. */
  inventoryItemId?: string;
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
  /** Image rows: where the image is used — the product title, or the media
   * library's best-effort usage label. */
  imageUsage?: string;
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
  | "listSeparatorInValue" // a list entry contains "|" — editing would shatter it (Finding 11)
  | "altTextInImages" // product main-image alt — edit it under the Images row type
  | "attributesNotSynced" // PLAN §2.4 — the block was never fetched (see below)
  | "commerceNotSynced" // §Phase 4 — `commerceSyncedAt` unset: unknown, not empty
  | "missingInventoryItem" // the variant has no InventoryItem GID to write to
  | "multipleVariants" // a product row's price cell: which of several? (see below)
  | "variantsNotSynced" // the product's variants were never cached
  | "priceNotSynced"; // the variant row is cached, its price is not (see priceCell)

/** The columns fed by the Phase-0 attribute block, whose emptiness only means
 *  something once `attributesSyncedAt` is set. `status` is NOT one of them — it
 *  predates that block and is non-null in the schema.
 *
 *  `isPublished` is the one that would be silently destructive without this:
 *  its column is `Boolean @default(true)`, so a row an older sync wrote reads
 *  as "visible" whether or not it is, and a merchant who saw that and moved on
 *  would publish a hidden page by touching a NEIGHBOURING cell. The same
 *  argument as `tags`, where the migration default is `[]` and `productUpdate`
 *  replaces rather than merges. A resync is the way out, for all of them. */
export const ATTRIBUTE_BLOCK_COLUMNS = new Set([
  "field.vendor",
  "field.tags",
  "field.templateSuffix",
  "field.isPublished",
  "field.sortOrder",
  "field.author",
  // An empty category on a row an older sync wrote is "not fetched", not "no
  // category" — and an empty membership list there would be saved as "leave
  // every collection", which is the expensive direction of the same trap.
  CATEGORY_COLUMN_ID,
  COLLECTIONS_COLUMN_ID,
]);

export interface ResolvedCell {
  /** Baseline display value of the cell (primary locale). */
  value: string;
  editable: boolean;
  readOnlyReason?: CellReadOnlyReason;
}

/**
 * A variant column on a PRODUCT row.
 *
 * Three states, and collapsing any two of them is a wrong answer rather than a
 * shorter one: the product has one variant (edit it), it has several (which
 * price would the cell show, and which would a save overwrite?), or the
 * variants were never cached (a resync, not a restriction). A product with
 * more than 100 variants is the same "several" as one with two — the sync
 * window is capped, and `variantCount` is only ever the loader's peek.
 */
function resolveProductVariantCell(row: BulkRow, column: ColumnDescriptor): ResolvedCell {
  // Shopify guarantees every product at least one variant, so a count of ZERO
  // is the cache lacking them rather than a product without any — the same
  // "empty is not evidence" rule as `attributesSyncedAt`.
  if (!row.variantCount) {
    // …but the OPTIONS are cached by every product sync, including the list
    // reload that does not fetch variants at all. An option offering two or
    // more values proves "several" without a single variant row, and "several"
    // is read-only however many a reload would bring in — so a resync hint
    // there would send the merchant on an errand that changes nothing. Only a
    // product whose options leave "exactly one" possible keeps the hint: there
    // a reload really does make the cell editable. Both answers are read-only,
    // so an orphaned option value (one without a variant) can at worst pick
    // the wrong explanation, never unlock a cell.
    const provesSeveral = (row.options ?? []).some((o) => o.values.length > 1);
    return {
      value: "",
      editable: false,
      readOnlyReason: provesSeveral ? "multipleVariants" : "variantsNotSynced",
    };
  }
  const variant = row.singleVariant;
  if (!variant) return { value: "", editable: false, readOnlyReason: "multipleVariants" };
  switch (column.id) {
    case VAR_PRICE_COLUMN_ID:
      return priceCell(variant.price, variant.price);
    case VAR_COMPARE_AT_COLUMN_ID:
      return priceCell(variant.price, variant.compareAtPrice);
    case VAR_SKU_COLUMN_ID:
      return { value: variant.sku, editable: true };
    default:
      // A product row offers no other variant column — see
      // PRODUCT_VARIANT_COLUMN_IDS.
      return { value: "", editable: false, readOnlyReason: "column" };
  }
}

/**
 * A price or compare-at cell, given the variant's cached PRICE.
 *
 * Shopify has no variant without a price, so an empty one is the cache lacking
 * it — a row the image manager created before it learned to store prices —
 * and not a product that costs nothing. Shown as an editable blank it read as
 * "this product has no price", and the compare-at beside it is unknown for the
 * same reason (its own emptiness is a real answer only once the price proves
 * the row was price-synced). Opening the product once, or any product sync,
 * fills it in.
 */
function priceCell(price: string, value: string): ResolvedCell {
  if (price === "") return { value: "", editable: false, readOnlyReason: "priceNotSynced" };
  return { value, editable: true };
}

/** The commerce block's value for one column. Flat properties on the row, so
 *  this is a lookup rather than a computation — written out instead of indexing
 *  by a derived name, which would silently answer "" for a typo. */
function commerceValueForColumn(row: BulkRow, columnId: string): string {
  switch (columnId) {
    case VAR_COST_COLUMN_ID:
      return row.cost ?? "";
    case VAR_TAXABLE_COLUMN_ID:
      return row.taxable ?? "";
    case VAR_INVENTORY_POLICY_COLUMN_ID:
      return row.inventoryPolicy ?? "";
    case VAR_INVENTORY_TRACKED_COLUMN_ID:
      return row.inventoryTracked ?? "";
    case VAR_WEIGHT_COLUMN_ID:
      return row.weight ?? "";
    case VAR_WEIGHT_UNIT_COLUMN_ID:
      return row.weightUnit ?? "";
    case VAR_REQUIRES_SHIPPING_COLUMN_ID:
      return row.requiresShipping ?? "";
    case VAR_COUNTRY_OF_ORIGIN_COLUMN_ID:
      return row.countryCodeOfOrigin ?? "";
    case VAR_HS_CODE_COLUMN_ID:
      return row.harmonizedSystemCode ?? "";
    default:
      return "";
  }
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
    case "field": {
      const value = primaryValueForColumn(row, column);
      // PLAN §2.4 / §3.6 — a cell whose row predates the attribute sync shows
      // the migration's default, not the merchant's data. Read-only, because
      // `productUpdate` REPLACES the tag list rather than merging it: typing
      // one tag into an unsynced row would wipe the product's real tags, on a
      // row the grid itself admits it does not know. The single editor locks
      // the same fields for the same reason; a resync is the way out.
      if (ATTRIBUTE_BLOCK_COLUMNS.has(column.id) && row.attributesKnown === false) {
        return { value, editable: false, readOnlyReason: "attributesNotSynced" };
      }
      return { value, editable: column.editable };
    }
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
      if (column.id === FEATURED_IMAGE_ALT_COLUMN_ID) {
        // No picture ⇒ nothing to describe. Shopify's collectionUpdate/
        // articleUpdate would accept the alt text and drop it, and there would
        // be no image resource to hang the translation on either.
        if (!row.imageUrl) return { value: "", editable: false, readOnlyReason: "missingImage" };
        return { value: row.imageAlt ?? "", editable: true };
      }
      if (column.id === IMG_ALT_COLUMN_ID) {
        if (!row.mainImage) return { value: "", editable: false, readOnlyReason: "missingImage" };
        // Read-only either way (see buildImgAltColumn); a missing mediaId is
        // still worth naming separately, since it means the product needs a
        // resync before the Images row type can show the picture at all.
        if (!row.mainImage.mediaId) {
          return { value: row.mainImage.alt, editable: false, readOnlyReason: "missingMediaId" };
        }
        return { value: row.mainImage.alt, editable: false, readOnlyReason: "altTextInImages" };
      }
      return { value: "", editable: false, readOnlyReason: "column" };
    }
    case "variant": {
      // A PRODUCT row carries three of these, for its ONE variant.
      if (row.type === "product") return resolveProductVariantCell(row, column);
      // Editable variant cells (Plan §5.3): SKU, price, compareAtPrice,
      // barcode. Money values are stored normalized; display formatting
      // happens at render time.
      switch (column.id) {
        case VAR_SKU_COLUMN_ID:
          return { value: row.sku ?? "", editable: true };
        case VAR_PRICE_COLUMN_ID:
          return priceCell(row.price ?? "", row.price ?? "");
        case VAR_COMPARE_AT_COLUMN_ID:
          return priceCell(row.price ?? "", row.compareAtPrice ?? "");
        case VAR_BARCODE_COLUMN_ID:
          return { value: row.barcode ?? "", editable: true };
        default:
          break;
      }
      if (COMMERCE_BLOCK_COLUMNS.has(column.id)) {
        const value = commerceValueForColumn(row, column.id);
        // §Phase 4 — a variant row written before the commerce sync existed
        // carries nulls that are indistinguishable from "the merchant left it
        // empty". `taxable` is the one that would be quietly expensive: shown
        // as "no" and saved along with a neighbouring cell, it stops charging
        // tax on a product that owes it. A resync is the way out.
        if (row.commerceKnown === false) {
          return { value, editable: false, readOnlyReason: "commerceNotSynced" };
        }
        // Cost, weight, customs and `tracked` are written on the INVENTORY
        // ITEM, which this variant has no address for.
        if (INVENTORY_ITEM_COLUMN_IDS.has(column.id) && !row.inventoryItemId) {
          return { value, editable: false, readOnlyReason: "missingInventoryItem" };
        }
        return { value, editable: true };
      }
      return { value: "", editable: false, readOnlyReason: "column" };
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
      else if (column.id === "imageUsage") value = row.imageUsage ?? row.productTitle ?? "";
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
  /**
   * What the save handed to the auto-translation (retranslate.server.ts).
   * Present only when auto-translate is on AND something was collected —
   * absent is "nothing to say", never "nothing happened".
   *
   * `capped` is the number of rows that were NOT re-translated because the
   * save had already opened MAX_REPAIR_GROUPS background runs. Not "deleted":
   * what happens to them depends on the surface — most follow the merchant's
   * stored deletion answer, while a webhook-backed row this save claimed keeps
   * its stale translations (its webhook was made to bail). Reported rather than
   * logged either way: a merchant told "everything gets re-translated" who then
   * finds row 30 untouched has no way to learn that a limit exists.
   */
  retranslation?: {
    /** Background RUNS this save started — a run per (row, surface), and only
     *  where the repair really had something left to translate. */
    started: number;
    /** The (locale, key) pairs those runs are rewriting. This is the number a
     *  merchant recognises; `started` is the number of Task rows it produced. */
    translations: number;
    /** Groups whose repair could not start (a failed lookup, a surface with no
     *  source language). Their stale translations are kept, so this is not a
     *  silent zero — it is the count nobody would otherwise see. */
    skipped: number;
    /** Rows the cap refused, counted as ROWS. */
    capped: number;
    /**
     * The `Task` rows those runs report under, so the grid can stop showing an
     * empty foreign cell for a translation that is still being written.
     *
     * The save's own revalidation lands seconds before the first AI answer, and
     * nothing else ever tells the page a detached run finished — which is
     * exactly what a merchant sees as "I switched languages and the new entries
     * are not there". A reader polls these until each is terminal and then
     * reloads the DISPLAY; it must never write anything back.
     *
     * A row may not exist yet when this arrives (the run is spawned, not
     * awaited, and may be queued behind another for the same resource), so
     * "no such task" reads as NOT-YET, never as finished.
     */
    taskIds?: string[];
  };
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
 *   1 translationsRemove (any cleared cell) PLUS 1 verification re-read for it
 *     — an unechoed removal is re-checked against the resource's current
 *     translations, so a clear costs two calls in the worst case;
 * - plus ceil(unique foreign resources / DIGEST_BATCH_CHUNK) digest batches.
 *
 * `columns` is the (current type's) descriptor universe — unknown column ids
 * are counted as one call each (defensive over-estimate, never under).
 */
/** A cleared foreign cell: `translationsRemove`, plus the re-read that
 *  verifies an unechoed removal instead of reporting a dead end. */
const CLEAR_CELL_CALLS = 2;

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
      const isSubEntry = (columnId: string): boolean => {
        const column = columnById.get(columnId);
        return !!column && (column.kind === "metafield" || column.kind === "option");
      };
      // The featured-image alt rides on NEITHER: it costs its own image-id
      // lookup, its own digest fetch and its own register/remove — three
      // calls, none of them shared with the row. Counting it as an own-resource
      // cell under-reported a 2000-unit run by ~3x, which is exactly the
      // direction this guard must never err in.
      const featuredAltEntries = entries.filter(([columnId]) => {
        const column = columnById.get(columnId);
        return !!column && isFeaturedImageAltColumn(column);
      });
      const ownEntries = entries.filter(
        ([columnId]) => !isSubEntry(columnId) && !featuredAltEntries.some(([id]) => id === columnId),
      );
      const subEntries = entries.filter(([columnId]) => isSubEntry(columnId));
      calls += featuredAltEntries.length * FEATURED_ALT_TRANSLATION_CALLS;
      const hasWrites = ownEntries.some(([, v]) => v !== "");
      const hasClears = ownEntries.some(([, v]) => v === "");
      // A clear is TWO calls in the worst case: the removal, plus the
      // verification re-read when Shopify echoes nothing back. The re-read only
      // fires on a gap, so this over-estimates the common case — which is the
      // only direction this guard is allowed to err in.
      calls += (hasWrites ? 1 : 0) + (hasClears ? CLEAR_CELL_CALLS : 0);
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
      // …plus ONE `inventoryItemUpdate` per VARIANT that touches the
      // InventoryItem half (cost, weight, customs, `tracked`). Shopify offers
      // no bulk form of that mutation, so a 200-row save of cost prices is 200
      // calls on top of the one bulk update — exactly the fan-out this guard
      // exists to notice before MAX_TASK_CALLS is blown past.
      if (entries.some(([columnId]) => INVENTORY_ITEM_COLUMN_IDS.has(columnId))) calls += 1;
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
      // A PRIMARY featured-alt change additionally invalidates its stale
      // translations, which costs the image-id lookup plus one
      // translationsRemove (§6.6). Charged unconditionally: whether any
      // translation exists is only knowable server-side, and the guard errs high.
      if (entries.some(([columnId]) => { const c = columnById.get(columnId); return !!c && isFeaturedImageAltColumn(c); })) {
        calls += 2;
      }
      continue;
    }
    let base = 0;
    let metafieldSets = 0;
    let metafieldDeletes = 0;
    let imageAlt = 0;
    // The three single-variant cells share ONE productVariantsBulkUpdate, so
    // they are a flag and not a count — the same shape as `base`.
    let variantWrite = 0;
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
        case "variant":
          variantWrite = 1;
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
      imageAlt +
      variantWrite;
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
  | "missingAltText"
  // Product status (products, and variants via their product). OR-combined
  // with each other — see BULK_FILTER_OR_GROUPS:
  | "statusActive"
  | "statusDraft"
  | "statusUnlisted"
  | "statusArchived"
  // Page/article visibility (OR group):
  | "published"
  | "hidden"
  // Collection kind (OR group):
  | "smartCollection"
  | "manualCollection"
  // Content gaps (AND-combined like every other flag):
  | "missingDescription"
  | "missingImage"
  | "missingVendor"
  | "missingProductType"
  | "missingCategory"
  | "missingTags"
  | "missingSummary";

export const BULK_FILTER_IDS: BulkFilterId[] = [
  "missingSeoTitle",
  "missingSeoDescription",
  "missingTranslation",
  "missingSku",
  "missingPrice",
  "compareAtNotAbovePrice",
  "missingAltText",
  "statusActive",
  "statusDraft",
  "statusUnlisted",
  "statusArchived",
  "published",
  "hidden",
  "smartCollection",
  "manualCollection",
  "missingDescription",
  "missingImage",
  "missingVendor",
  "missingProductType",
  "missingCategory",
  "missingTags",
  "missingSummary",
];

/** Shopify `ProductStatus` value behind each status filter id. */
export const STATUS_FILTER_VALUES: Partial<Record<BulkFilterId, string>> = {
  statusActive: "ACTIVE",
  statusDraft: "DRAFT",
  statusUnlisted: "UNLISTED",
  statusArchived: "ARCHIVED",
};

export const STATUS_FILTER_IDS: BulkFilterId[] = ["statusActive", "statusDraft", "statusUnlisted", "statusArchived"];
export const VISIBILITY_FILTER_IDS: BulkFilterId[] = ["published", "hidden"];
export const COLLECTION_KIND_FILTER_IDS: BulkFilterId[] = ["smartCollection", "manualCollection"];

/**
 * Filter ids that answer ONE question with several values ("which status?").
 * Inside a group they are OR-combined — AND over "active" and "draft" would
 * always be empty — and every group is AND-combined with the rest. All other
 * ids are independent flags and AND-combine as before.
 */
export const BULK_FILTER_OR_GROUPS: BulkFilterId[][] = [
  STATUS_FILTER_IDS,
  VISIBILITY_FILTER_IDS,
  COLLECTION_KIND_FILTER_IDS,
];

/** The selected members of one OR group, in group order. */
export function selectedInGroup(filters: readonly BulkFilterId[], group: readonly BulkFilterId[]): BulkFilterId[] {
  return group.filter((id) => filters.includes(id));
}

/**
 * Filters that read a merchandising attribute (`vendor`, `tags`, `category`,
 * `isPublished`, `isSmart`). On a row an older sync wrote those columns hold
 * the migration DEFAULTS, indistinguishable from real values
 * (`attributesSyncedAt` is the discriminator — CLAUDE.md), so these filters
 * only ever match attribute-synced rows. Undercounting is the chosen failure:
 * an unsynced page must not be reported as "visible", nor an unsynced product
 * as "no vendor".
 */
export const ATTRIBUTE_GATED_FILTER_IDS: BulkFilterId[] = [
  ...VISIBILITY_FILTER_IDS,
  ...COLLECTION_KIND_FILTER_IDS,
  "missingVendor",
  "missingCategory",
  "missingTags",
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

/**
 * Type-specific filters on top of the set's shared vocabulary — the columns
 * behind them exist only on that type (blogs, for instance, share the
 * "content" set but have no status, description or image in the cache).
 */
const TYPE_FILTER_IDS: Partial<Record<BulkRowType, BulkFilterId[]>> = {
  product: [
    ...STATUS_FILTER_IDS,
    "missingDescription",
    "missingImage",
    "missingProductType",
    "missingVendor",
    "missingCategory",
    "missingTags",
  ],
  variant: STATUS_FILTER_IDS,
  collection: [...COLLECTION_KIND_FILTER_IDS, "missingDescription", "missingImage"],
  article: [...VISIBILITY_FILTER_IDS, "missingDescription", "missingSummary", "missingImage", "missingTags"],
  page: [...VISIBILITY_FILTER_IDS, "missingDescription"],
};

/**
 * THE per-TYPE filter-id source: what the FilterBar offers, what a type switch
 * prunes the URL against, and what the loader accepts (a hand-crafted URL
 * param outside it is dropped there rather than reaching a column the type
 * does not have).
 */
export function filterIdsForType(type: BulkRowType): BulkFilterId[] {
  return [...FILTER_IDS_BY_SET[filterSetForType(type)], ...(TYPE_FILTER_IDS[type] ?? [])];
}

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
