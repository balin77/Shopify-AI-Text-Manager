/**
 * PLAN_CONTENT_CREATION §2.5a–d — what the create modal can hand to the AI.
 *
 * ── Why a MAP and not a flag on the create field ────────────────────────────
 * The `/api/ai` generation handler resolves its prompt, its character limit
 * and its AI-instruction keys from `CONTENT_CONFIGS[contentType]
 * .fieldDefinitions.find(f => f.key === fieldType)` — the EDITOR's field list.
 * The create form has its own list, with its own keys: a product's long text
 * is `descriptionHtml` here and `description` there. Sending a create key
 * straight through resolves to `undefined`, which does not fail — it silently
 * produces a generic prompt with no character limit and no merchant
 * instructions, and the merchant sees a worse result with no way to know why.
 *
 * So the mapping is explicit, and a create field that has no editor twin is
 * simply not offered to the AI.
 *
 * ── Order matters ───────────────────────────────────────────────────────────
 * "Generate the rest" runs the fields in the order below and feeds each result
 * forward as context. The long text is written first because the SEO fields
 * are summaries OF it — generating a meta description before the description
 * exists means summarising the title, which is the whole reason a merchant
 * would rewrite it afterwards.
 */

import type { CreatableResource } from "./create-fields.config";

export interface CreateAiField {
  /** Key in the create form's value map. */
  createKey: string;
  /** Key in `CONTENT_CONFIGS[contentType].fieldDefinitions` — NOT the same. */
  editorKey: string;
}

export interface CreateAiSpec {
  /** The `contentType` `/api/ai` expects. Articles live under "blogs". */
  contentType: string;
  /** Generated in this order, each result becoming context for the next. */
  fields: CreateAiField[];
}

const SEO_TAIL: CreateAiField[] = [
  { createKey: "seoTitle", editorKey: "seoTitle" },
  { createKey: "metaDescription", editorKey: "metaDescription" },
  // The slug last: it is derived from the title, and Shopify will happily
  // derive its own if this stays empty — the least costly one to skip.
  { createKey: "handle", editorKey: "handle" },
];

/**
 * Blogs and metaobjects are deliberately absent.
 *
 * A blog has a title and a handle and nothing else to write; a metaobject's
 * fields come from a merchant-defined definition this app cannot know the
 * meaning of, so an "improve this" prompt would be writing into a field whose
 * purpose it cannot read. Offering a button that produces noise is worse than
 * not offering one.
 */
export const CREATE_AI_SPECS: Partial<Record<CreatableResource, CreateAiSpec>> = {
  product: {
    contentType: "products",
    fields: [{ createKey: "descriptionHtml", editorKey: "description" }, ...SEO_TAIL],
  },
  collection: {
    contentType: "collections",
    fields: [{ createKey: "descriptionHtml", editorKey: "description" }, ...SEO_TAIL],
  },
  page: {
    contentType: "pages",
    fields: [{ createKey: "body", editorKey: "body" }, ...SEO_TAIL],
  },
  article: {
    contentType: "blogs",
    fields: [
      { createKey: "body", editorKey: "body" },
      { createKey: "summary", editorKey: "summary" },
      ...SEO_TAIL,
    ],
  },
};

export function createAiSpecFor(resource: CreatableResource | null): CreateAiSpec | null {
  return resource ? CREATE_AI_SPECS[resource] ?? null : null;
}

/**
 * The create-form key holding the item's long text, for use as prompt context.
 * Not derived from `fields[0]`: that happens to be true today and would break
 * silently the moment a spec grows a field in front of it.
 */
export const LONG_TEXT_KEY_BY_RESOURCE: Partial<Record<CreatableResource, string>> = {
  product: "descriptionHtml",
  collection: "descriptionHtml",
  page: "body",
  article: "body",
};

/**
 * §2.5a — the fields the chained `translateAll` should carry.
 *
 * That action reads its values off the FORM, by EDITOR field key, and does not
 * go back to the cache for them. Firing it right after the create therefore
 * needs the same create→editor key mapping the AI path needs — plus the title,
 * which no AI spec lists because the merchant always writes it themselves.
 *
 * Derived from the AI spec rather than declared twice: a field added to one
 * and forgotten in the other is a field that generates but never translates.
 */
export function translatableCreateFields(resource: CreatableResource | null): CreateAiField[] {
  const spec = createAiSpecFor(resource);
  if (!spec) return [];
  return [{ createKey: "title", editorKey: "title" }, ...spec.fields];
}
