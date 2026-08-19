/**
 * PLAN_CONTENT_CREATION §1.3 — what each resource type can be CREATED with.
 *
 * Client-safe (no `.server` import) on purpose, and for the same reason as
 * `columns.shared.ts`: the modal renders from this and the server VALIDATES
 * against it. One description, two consumers — a field the client invents is
 * rejected because it is not here, not because someone remembered to reject it.
 *
 * Deliberately separate from `content-fields.config.tsx`: create fields are not
 * edit fields. `giftCard` can only be set at creation, `author` is mandatory
 * only here, `blogId` is meaningless afterwards, and the SEO fields of a
 * page/article/blog do not exist on the create input at all (§1.3 — they are a
 * second `metafieldsSet` step). Folding the two together would mean encoding
 * "…except when creating" all over the edit config.
 *
 * `templateSuffix` is deliberately NOT here (§2.5): it only helps someone who
 * knows their theme's template names by heart, and a wrong value renders the
 * page in the wrong layout. It lives in the attribute tab instead.
 */

// The taxonomy rules live in `metaobject-fields.shared` because the ENTRY
// editor needs the same ones, and a second copy of "how is a list of taxonomy
// GIDs serialised" is how the create form and the editor would come to write
// different bytes into the same field.
import {
  isMetaobjectTaxonomyListType,
  metaobjectFieldRole,
  parseMetaobjectTaxonomyValues,
  taxonomyValueBounds,
  TAXONOMY_VALUE_GID_PATTERN,
} from "~/services/metaobject-fields.shared";

export type CreatableResource = "product" | "collection" | "page" | "article" | "blog" | "metaobject";

/**
 * What can be DELETED. The same six, and not by coincidence: the types this
 * app cannot create are the ones Shopify has no create API for (policies are a
 * fixed set of six, theme content is not a resource), and it has no delete API
 * for those either. Aliased rather than re-listed so the two cannot drift.
 */
export type DeletableResource = CreatableResource;

/**
 * The GID type segment each resource's ids carry.
 *
 * ONE map, because two places need the same answer and they must not drift:
 * `deleteContent` refuses an id whose type disagrees with the named resource,
 * and the editor decides whether the selected item IS a deletable object at
 * all. The metaobjects tab is why the second one matters -- it lists TYPES
 * (`metaobject_type_<type>`), and treating one as a metaobject produced a
 * delete button that 400s AFTER the merchant typed the name into the
 * confirmation dialog.
 */
export const GID_TYPE_BY_RESOURCE: Record<DeletableResource, string> = {
  product: "Product",
  collection: "Collection",
  page: "Page",
  article: "Article",
  blog: "Blog",
  metaobject: "Metaobject",
};

/** True when `gid` is an id of `resource` (and not, say, a pseudo item id). */
export function isGidOfResource(gid: string, resource: DeletableResource): boolean {
  return gid.includes(`/${GID_TYPE_BY_RESOURCE[resource]}/`);
}

/**
 * How a field is entered. The modal maps these to controls; the server maps
 * them to a validation rule. A new kind has to be handled in BOTH — which is
 * the point of naming them here rather than inferring from the key.
 */
export type CreateFieldKind =
  | "text"
  | "textarea"
  | "richtext"
  | "handle"
  | "select"
  | "tags"
  | "money"
  | "image"
  /** Free-text keyword; goes into the AI prompt AND becomes the primary keyword (§2.5d). */
  | "keyword"
  /** Picks the parent blog for an article. Options are loaded live, not from this file. */
  | "blogPicker"
  /** Picks the metaobject definition. Options are loaded live and filtered (§1.5). */
  | "metaobjectType"
  /**
   * Picks one or more values out of Shopify's product taxonomy
   * (`product_taxonomy_value_reference`). The permitted values are loaded live
   * from `/api/metaobject-taxonomy` -- the definition's validations name the
   * attribute by handle and the values hang off a taxonomy CATEGORY, neither
   * of which the form could know by itself.
   */
  | "taxonomyValue";

export interface CreateFieldDef {
  key: string;
  kind: CreateFieldKind;
  /** Rejected server-side when missing. */
  required?: boolean;
  /** i18n key under `t.create.fields.*`; the modal falls back to `key`. */
  labelKey: string;
  /** Hard cap enforced on BOTH sides. Shopify's own limits are stricter in
   *  places, but a value this app never sends cannot be blamed on the merchant. */
  maxLength?: number;
  /** Fixed option list. `select` only; dynamic pickers load their own. */
  options?: Array<{ value: string; labelKey: string }>;
  /** Hidden behind "more fields" — present but not in the first impression (§2.5). */
  advanced?: boolean;
  /** Never offered on the edit surface; exists only at creation time. */
  createOnly?: boolean;
  /**
   * Shopify stores this metaobject field as a JSON ARRAY
   * (`list.single_line_text_field`). The form collects it comma-separated and
   * the server serialises it — sending the raw string is accepted by neither,
   * so a definition with such a REQUIRED field would be advertised as
   * creatable and then always rejected.
   */
  listValue?: boolean;
  /**
   * `taxonomyValue` only. Everything the picker needs that a bare key cannot
   * carry: which field of the definition this is (the route resolves the
   * attribute handle from it server-side) and how many values are allowed.
   *
   * The bounds come from the definition's `list.min` / `list.max` validations
   * and are never hardcoded -- `color_taxonomy_reference` is 1..4 on a live
   * shop and the next definition will be something else.
   */
  taxonomy?: {
    /** The definition's own field key, without the `field.` prefix. */
    fieldKey: string;
    /** The Shopify field type, which decides list vs. single serialisation. */
    fieldType: string;
    isList: boolean;
    min: number | null;
    max: number | null;
  };
}

export interface CreateResourceSpec {
  resource: CreatableResource;
  /**
   * The `plans.ts` ContentType this resource belongs to — NOT the tab it is
   * reached from. Those differ for articles: they live on the blogs TAB, but
   * `plans.ts` gates "articles" and "blogs" separately, and gating an article
   * on "blogs" would be a different question than the one being asked.
   * (No shipping plan currently has one without the other, so the two spellings
   * behave identically today — which is exactly why getting it wrong here
   * would go unnoticed until a plan splits them.)
   */
  planContentType: string;
  /** Which plan limit counts this resource, if any (`null` = uncapped type). */
  limitResource: "products" | "collections" | "articles" | "pages" | null;
  /** i18n key for the modal title. */
  titleKey: string;
  fields: CreateFieldDef[];
  /**
   * SEO title/description do NOT exist on this type's create input and need a
   * SECOND `metafieldsSet` call against `global.title_tag` / `description_tag`
   * (§1.3). Without it the form accepts SEO input and Shopify stores nothing —
   * the documented false-success pattern.
   */
  seoViaMetafields?: boolean;
  /** Created as DRAFT / unpublished by default (§2.3) — nothing goes live by accident. */
  createsUnpublished?: boolean;
}

/** Shopify ProductStatus. Kept in step with PRODUCT_STATUSES in the bulk
 *  editor's apply.server.ts — the single editor must not offer a different set
 *  than the bulk editor (§2.3). Create defaults to DRAFT. */
export const CREATE_PRODUCT_STATUSES = ["DRAFT", "ACTIVE", "UNLISTED", "ARCHIVED"] as const;

/** Shopify CollectionSortOrder, measured against 2026-07 (PLAN §1.2a). */
export const COLLECTION_SORT_ORDERS = [
  "MANUAL",
  "BEST_SELLING",
  "ALPHA_ASC",
  "ALPHA_DESC",
  "PRICE_ASC",
  "PRICE_DESC",
  "CREATED",
  "CREATED_DESC",
  "MOST_RELEVANT",
] as const;

/** Shopify BlogCommentPolicy. */
export const BLOG_COMMENT_POLICIES = ["CLOSED", "MODERATED", "AUTO_PUBLISHED"] as const;

const TITLE_MAX = 255;
const HANDLE_MAX = 255;
const SEO_TITLE_MAX = 200;
const SEO_DESCRIPTION_MAX = 500;

/** Fields every type shares, in the order the modal shows them. */
function commonSeoFields(): CreateFieldDef[] {
  return [
    { key: "handle", kind: "handle", labelKey: "handle", maxLength: HANDLE_MAX, advanced: true },
    { key: "seoTitle", kind: "text", labelKey: "seoTitle", maxLength: SEO_TITLE_MAX, advanced: true },
    { key: "metaDescription", kind: "textarea", labelKey: "metaDescription", maxLength: SEO_DESCRIPTION_MAX, advanced: true },
  ];
}

export const CREATE_SPECS: Record<CreatableResource, CreateResourceSpec> = {
  product: {
    resource: "product",
    planContentType: "products",
    limitResource: "products",
    titleKey: "product",
    createsUnpublished: true,
    fields: [
      { key: "title", kind: "text", required: true, labelKey: "title", maxLength: TITLE_MAX },
      { key: "keyword", kind: "keyword", labelKey: "keyword", maxLength: 120 },
      { key: "image", kind: "image", labelKey: "image" },
      { key: "descriptionHtml", kind: "richtext", labelKey: "description" },
      // §2.3: all four statuses, same set as the bulk editor. DRAFT by default.
      {
        key: "status",
        kind: "select",
        labelKey: "status",
        options: CREATE_PRODUCT_STATUSES.map((value) => ({ value, labelKey: `status.${value}` })),
      },
      // §2.2 — a product without a price is not sellable, and this needs no
      // extra scope: productSet covers the default variant.
      { key: "price", kind: "money", labelKey: "price", advanced: true },
      { key: "compareAtPrice", kind: "money", labelKey: "compareAtPrice", advanced: true },
      { key: "sku", kind: "text", labelKey: "sku", maxLength: 255, advanced: true },
      { key: "barcode", kind: "text", labelKey: "barcode", maxLength: 255, advanced: true },
      { key: "productType", kind: "text", labelKey: "productType", maxLength: TITLE_MAX, advanced: true },
      { key: "vendor", kind: "text", labelKey: "vendor", maxLength: TITLE_MAX, advanced: true },
      { key: "tags", kind: "tags", labelKey: "tags", advanced: true },
      ...commonSeoFields(),
    ],
  },

  collection: {
    resource: "collection",
    planContentType: "collections",
    limitResource: "collections",
    titleKey: "collection",
    fields: [
      { key: "title", kind: "text", required: true, labelKey: "title", maxLength: TITLE_MAX },
      { key: "keyword", kind: "keyword", labelKey: "keyword", maxLength: 120 },
      { key: "image", kind: "image", labelKey: "image" },
      { key: "descriptionHtml", kind: "richtext", labelKey: "description" },
      {
        key: "sortOrder",
        kind: "select",
        labelKey: "sortOrder",
        advanced: true,
        options: COLLECTION_SORT_ORDERS.map((value) => ({ value, labelKey: `sortOrder.${value}` })),
      },
      ...commonSeoFields(),
    ],
  },

  page: {
    resource: "page",
    planContentType: "pages",
    limitResource: "pages",
    titleKey: "page",
    seoViaMetafields: true,
    createsUnpublished: true,
    fields: [
      { key: "title", kind: "text", required: true, labelKey: "title", maxLength: TITLE_MAX },
      { key: "keyword", kind: "keyword", labelKey: "keyword", maxLength: 120 },
      { key: "body", kind: "richtext", labelKey: "body" },
      ...commonSeoFields(),
    ],
  },

  article: {
    resource: "article",
    planContentType: "articles",
    limitResource: "articles",
    titleKey: "article",
    seoViaMetafields: true,
    createsUnpublished: true,
    fields: [
      // §1.4: blogId and author are BOTH mandatory on ArticleCreateInput.
      // author has no equivalent anywhere else in this app — without it,
      // article creation is simply impossible.
      { key: "blogId", kind: "blogPicker", required: true, labelKey: "blog", createOnly: true },
      { key: "title", kind: "text", required: true, labelKey: "title", maxLength: TITLE_MAX },
      { key: "author", kind: "text", required: true, labelKey: "author", maxLength: TITLE_MAX },
      { key: "keyword", kind: "keyword", labelKey: "keyword", maxLength: 120 },
      { key: "image", kind: "image", labelKey: "image" },
      { key: "summary", kind: "textarea", labelKey: "summary", maxLength: 5000 },
      { key: "body", kind: "richtext", labelKey: "body" },
      { key: "tags", kind: "tags", labelKey: "tags", advanced: true },
      ...commonSeoFields(),
    ],
  },

  blog: {
    resource: "blog",
    planContentType: "blogs",
    // Blogs have no plan limit of their own — articles do.
    limitResource: null,
    titleKey: "blog",
    fields: [
      { key: "title", kind: "text", required: true, labelKey: "title", maxLength: TITLE_MAX },
      {
        key: "commentPolicy",
        kind: "select",
        labelKey: "commentPolicy",
        advanced: true,
        options: BLOG_COMMENT_POLICIES.map((value) => ({ value, labelKey: `commentPolicy.${value}` })),
      },
      { key: "handle", kind: "handle", labelKey: "handle", maxLength: HANDLE_MAX, advanced: true },
    ],
  },

  metaobject: {
    resource: "metaobject",
    planContentType: "metaobjects",
    limitResource: null,
    titleKey: "metaobject",
    fields: [
      // §1.5: only definitions whose REQUIRED fields are all plain text are
      // offered — the app has editors for three field types and would
      // otherwise present entries Shopify rejects. The option list is built
      // live from the cached definitions, not from this file.
      { key: "type", kind: "metaobjectType", required: true, labelKey: "metaobjectType", createOnly: true },
      { key: "handle", kind: "handle", labelKey: "handle", maxLength: HANDLE_MAX, advanced: true },
      // The definition's own fields are appended at runtime — see
      // metaobjectFieldDefs() below.
    ],
  },
};

export function createSpecFor(resource: string): CreateResourceSpec | null {
  return (CREATE_SPECS as Record<string, CreateResourceSpec | undefined>)[resource] ?? null;
}

/** Field keys a client may send for this resource. Anything else is dropped. */
export function allowedFieldKeys(resource: CreatableResource): Set<string> {
  return new Set(CREATE_SPECS[resource].fields.map((f) => f.key));
}

/**
 * The metaobject field types the CREATE FORM can collect a value for.
 *
 * A definition whose REQUIRED fields include anything outside this set is not
 * offerable: the form could not collect a value Shopify will accept, so it
 * would produce a guaranteed rejection with no way for the merchant to fix it.
 *
 * It deliberately no longer equals `isEditableMetaobjectFieldType` (the BULK
 * grid's set). The two answer different questions -- "can a spreadsheet cell
 * hold this?" and "can a form collect this?" -- and the taxonomy references are
 * exactly where they diverge: the grid has no picker and the plan keeps them
 * out of it (PLAN_METAOBJECT_TAXONOMY_CREATE §3), while the form has one.
 * Collapsing them again would either drop the create feature or grow a
 * spreadsheet column that stores raw GIDs.
 *
 * Adding the two taxonomy types is THE switch of Phase 2: on a live shop it
 * unblocks `shopify--color-pattern` plus nine sibling definitions whose single
 * required field is a taxonomy reference (§1.3).
 */
export const EDITABLE_METAOBJECT_FIELD_TYPES = [
  "single_line_text_field",
  "multi_line_text_field",
  "list.single_line_text_field",
  "product_taxonomy_value_reference",
  "list.product_taxonomy_value_reference",
] as const;

export interface MetaobjectFieldDefinition {
  key: string;
  name?: string;
  type?: { name?: string } | string;
  /** Added by the Phase-0 sync. ABSENT on definitions cached before it —
   *  absent is NOT false, see the schema comment on MetaobjectDefinition. */
  required?: boolean;
  /** Added by the same sync. Carries the taxonomy attribute handle and the
   *  list bounds; the create form reads the bounds, the route reads the handle. */
  validations?: Array<{ name: string; value?: string | null }>;
}

function fieldTypeName(def: MetaobjectFieldDefinition): string {
  return typeof def.type === "string" ? def.type : def.type?.name ?? "";
}

/**
 * Can entries be created for this definition?
 *
 * Returns a REASON rather than a boolean, because the UI has to explain the
 * refusal — "this type cannot be created here" with no cause reads like a bug.
 *
 * `requiredUnknown` is its own outcome on purpose: a definition cached before
 * the Phase-0 sync carries no `required` flag at all, and treating that as
 * "nothing is required" would offer a form that Shopify then rejects for a
 * missing field the merchant was never asked for. Unknown ⇒ offer a reload.
 */
export type MetaobjectCreatability =
  | { creatable: true }
  | { creatable: false; reason: "requiredUnknown" | "unsupportedRequiredType"; detail?: string };

export function metaobjectCreatability(fieldDefinitions: MetaobjectFieldDefinition[]): MetaobjectCreatability {
  if (fieldDefinitions.length === 0) return { creatable: true };

  if (fieldDefinitions.some((f) => f.required === undefined)) {
    return { creatable: false, reason: "requiredUnknown" };
  }

  const blocking = fieldDefinitions.filter(
    (f) => f.required && !(EDITABLE_METAOBJECT_FIELD_TYPES as readonly string[]).includes(fieldTypeName(f)),
  );
  if (blocking.length > 0) {
    return {
      creatable: false,
      reason: "unsupportedRequiredType",
      detail: blocking.map((f) => `${f.key} (${fieldTypeName(f) || "?"})`).join(", "),
    };
  }
  return { creatable: true };
}

/** The definition's own fields, as create fields. Only the editable types are
 *  rendered; optional fields of other types are simply left unset. */
export function metaobjectFieldDefs(fieldDefinitions: MetaobjectFieldDefinition[]): CreateFieldDef[] {
  return fieldDefinitions
    .filter((f) => (EDITABLE_METAOBJECT_FIELD_TYPES as readonly string[]).includes(fieldTypeName(f)))
    .map((f) => {
      const type = fieldTypeName(f);
      if (metaobjectFieldRole(type) === "taxonomyValue") {
        const isList = isMetaobjectTaxonomyListType(type);
        return {
          key: `field.${f.key}`,
          kind: "taxonomyValue" as const,
          required: f.required === true,
          labelKey: f.name || f.key,
          // NOT `listValue`: that flag means "the form collected it
          // comma-separated, serialise it here". The taxonomy picker hands
          // over the value ALREADY serialised the way Shopify stores it —
          // exactly like the entry editor, so both write the same bytes.
          taxonomy: {
            fieldKey: f.key,
            fieldType: type,
            isList,
            ...taxonomyValueBounds(type, f.validations),
          },
        };
      }
      const isList = type === "list.single_line_text_field";
      return {
        key: `field.${f.key}`,
        // A list is collected the way tags are — comma-separated — and
        // serialised to JSON before it is sent.
        kind: isList ? ("tags" as const) : type === "multi_line_text_field" ? ("textarea" as const) : ("text" as const),
        required: f.required === true,
        labelKey: f.name || f.key,
        listValue: isList,
      };
    });
}

/**
 * The `fields` payload for `metaobjectCreate`, from the form's flat values.
 *
 * `MetaobjectFieldInput` has EXACTLY `key` and `value`. Any extra property
 * makes GraphQL refuse the whole variable, and the failure surfaces as a
 * generic "not confirmed by Shopify" that looks like a Shopify problem rather
 * than a payload one — it once took every metaobject create with it. Building
 * the payload here rather than inline in the action is what makes that
 * testable.
 */
export function metaobjectFieldsPayload(
  fields: CreateFieldDef[],
  values: Record<string, string>,
): Array<{ key: string; value: string }> {
  const payload: Array<{ key: string; value: string }> = [];
  for (const field of fields) {
    const raw = (values[field.key] ?? "").trim();
    if (field.taxonomy) {
      // Already serialised the way Shopify stores it — a JSON array of GIDs
      // for the list flavour, a bare GID otherwise — because the picker speaks
      // the stored form end to end. Re-serialising here would be a second
      // opinion on the same bytes, and the entry editor holds the first.
      if (raw.length === 0) continue;
      payload.push({ key: field.key.replace(/^field\./, ""), value: raw });
      continue;
    }
    if (field.listValue) {
      // Stored as a JSON array; the form collects it comma-separated.
      const items = raw.split(",").map((v) => v.trim()).filter(Boolean);
      if (items.length === 0) continue;
      payload.push({ key: field.key.replace(/^field\./, ""), value: JSON.stringify(items) });
      continue;
    }
    if (raw.length === 0) continue;
    payload.push({ key: field.key.replace(/^field\./, ""), value: raw });
  }
  return payload;
}

// ────────────────────────────────────────────────────────────────────────────
// Validation — the SAME rules the modal enforces and the server re-applies
// ────────────────────────────────────────────────────────────────────────────

export interface CreateValidationError {
  field: string;
  code:
    | "required"
    | "tooLong"
    | "unknownField"
    | "invalidOption"
    | "invalidHandle"
    | "invalidMoney"
    | "invalidTaxonomyValue"
    // Split from `invalidTaxonomyValue` because ONE code cannot carry three
    // sentences: "that is not a taxonomy value", "that is too many" and "that
    // is too few" need different remedies, and the shared phrasing told a
    // merchant who had picked four values to "pick a value from the list".
    | "tooManyTaxonomyValues"
    | "tooFewTaxonomyValues";
  detail?: string;
}

/** Shopify's handle grammar: lowercase alphanumerics and dashes. */
const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MONEY_PATTERN = /^\d+(?:[.,]\d{1,2})?$/;

/**
 * Validate a submitted payload against the spec.
 *
 * The server calls this with `extraFields` for the metaobject case, where the
 * definition's own fields are only known at runtime. It is the ONLY validator:
 * the modal disabling its submit button is convenience, this is the rule
 * (§1.5 — the action is reachable by POST).
 */
export function validateCreatePayload(
  resource: CreatableResource,
  values: Record<string, string>,
  extraFields: CreateFieldDef[] = [],
): CreateValidationError[] {
  const spec = CREATE_SPECS[resource];
  const fields = [...spec.fields, ...extraFields];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const errors: CreateValidationError[] = [];

  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) {
      // Never silently ignored: a dropped field would look like a successful
      // create that quietly lost data.
      errors.push({ field: key, code: "unknownField" });
    }
  }

  for (const field of fields) {
    const raw = values[field.key];
    const value = typeof raw === "string" ? raw.trim() : "";

    if (field.required && value.length === 0) {
      errors.push({ field: field.key, code: "required" });
      continue;
    }
    if (value.length === 0) continue;

    if (field.maxLength && value.length > field.maxLength) {
      errors.push({ field: field.key, code: "tooLong", detail: `${value.length}/${field.maxLength}` });
    }
    if (field.kind === "handle" && !HANDLE_PATTERN.test(value)) {
      errors.push({ field: field.key, code: "invalidHandle" });
    }
    if (field.kind === "money" && !MONEY_PATTERN.test(value)) {
      errors.push({ field: field.key, code: "invalidMoney" });
    }
    if (field.kind === "select" && field.options && !field.options.some((o) => o.value === value)) {
      errors.push({ field: field.key, code: "invalidOption", detail: value });
    }
    if (field.taxonomy) {
      // The SERVER's own check, and it is not a formality: a value that is not
      // a TaxonomyValue GID fails at the GraphQL SCHEMA level — a top-level
      // `errors` array with `data: null` that never reaches `userErrors`, so
      // forwarding it would make the whole create read as a success while
      // nothing was written. Same trap the merchandising enums documented.
      const ids = parseMetaobjectTaxonomyValues(field.taxonomy.fieldType, value);
      if (ids.length === 0 || ids.some((id) => !TAXONOMY_VALUE_GID_PATTERN.test(id))) {
        errors.push({ field: field.key, code: "invalidTaxonomyValue", detail: value });
      } else if (field.taxonomy.max !== null && ids.length > field.taxonomy.max) {
        errors.push({
          field: field.key,
          code: "tooManyTaxonomyValues",
          detail: String(field.taxonomy.max),
        });
      } else if (field.taxonomy.min !== null && ids.length < field.taxonomy.min) {
        errors.push({
          field: field.key,
          code: "tooFewTaxonomyValues",
          detail: String(field.taxonomy.min),
        });
      }
    }
  }

  return errors;
}

/**
 * Shopify's own handle normalisation, for the "suggested handle" the modal
 * shows while the merchant types a title. Not authoritative — Shopify decides,
 * and on a collision it appends `-1` (§1.7), which is why the modal reports
 * the handle it got BACK rather than the one it sent.
 */
export function suggestHandle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, HANDLE_MAX);
}
