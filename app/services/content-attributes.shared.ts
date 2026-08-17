/**
 * PLAN_CONTENT_CREATION §Phase 3.1/3.2 — the merchandising half of a save.
 *
 * The editor sends every field as a flat string. Shopify wants an enum, a
 * boolean, a string array and a nullable string, on four different inputs. This
 * is the ONE place that translation happens, for the same reason
 * `FIELD_TO_TRANSLATION_KEY` is one map: the previous generation of this code
 * grew a per-resource copy of every rule and they drifted.
 *
 * ── Why validation lives here and not at the mutation ───────────────────────
 * `sortOrder` and `status` are GraphQL ENUMS. An unknown value fails at the
 * SCHEMA level, which Shopify returns as a top-level `errors` array with
 * `data: null` — it never reaches `userErrors`. Callers that only check
 * `userErrors` therefore read the whole save as a success while nothing was
 * written: the false-success pattern CLAUDE.md exists to prevent. So a value
 * this module does not recognise is DROPPED and reported, never forwarded.
 *
 * ── Why "" is not the same as absent ────────────────────────────────────────
 * A field the client never sent is `undefined` and must be left untouched. A
 * field the merchant cleared is `""` and must be written — for `templateSuffix`
 * that means `null`, which puts the item back on the theme's default template.
 * Collapsing the two is how a save silently stops being able to clear a field.
 */

import { CREATE_PRODUCT_STATUSES, COLLECTION_SORT_ORDERS } from "../config/create-fields.config";

export type AttributeResource = "Page" | "Blog" | "Article" | "Collection";

/** Shaped for the four `*UpdateInput`s. `author` stays a plain name here — the
 *  service wraps it in Shopify's `AuthorInput` at the call. */
export interface AttributeInput {
  isPublished?: boolean;
  templateSuffix?: string | null;
  sortOrder?: string;
  author?: string;
  tags?: string[];
}

const VALID_STATUSES = new Set<string>(CREATE_PRODUCT_STATUSES);
const VALID_SORT_ORDERS = new Set<string>(COLLECTION_SORT_ORDERS);

/** Which attributes each resource actually HAS. A `sortOrder` on a page is not
 *  a harmless extra: Shopify rejects the whole input. */
const ATTRIBUTES_BY_RESOURCE: Record<AttributeResource, Array<keyof AttributeInput>> = {
  Page: ["isPublished", "templateSuffix"],
  Blog: ["templateSuffix"],
  Article: ["isPublished", "templateSuffix", "author", "tags"],
  Collection: ["sortOrder", "templateSuffix"],
};

/** Shopify trims tags and drops empties; mirror that so a save does not report
 *  a change the shop would never store. Case-insensitively de-duplicated,
 *  because Shopify collapses "Sale" and "sale" into one. */
export function parseTagList(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function isValidProductStatus(value: string): boolean {
  return VALID_STATUSES.has(value.trim().toUpperCase());
}

export function isValidSortOrder(value: string): boolean {
  return VALID_SORT_ORDERS.has(value.trim().toUpperCase());
}

/**
 * The attribute half of a Shopify update input, built from the editor's flat
 * update map. Only keys the caller actually sent, and only ones this resource
 * has. An invalid enum value is omitted and named in `rejected`.
 */
export function attributeInputFor(
  resource: AttributeResource,
  updates: Record<string, string>,
  changedFields?: string[],
): AttributeInput & { rejected?: string[] } {
  // ── Presence is NOT intent ────────────────────────────────────────────────
  // A primary-locale save carries EVERY field, changed or not — only foreign
  // saves are filtered client-side. So "the client sent `tags`" says nothing
  // about whether the merchant touched them, and acting on presence alone
  // means editing a TITLE also writes the attributes. On an item whose row
  // predates the attribute sync those arrive as the migration's defaults —
  // empty — and Shopify REPLACES rather than merges, so the title edit would
  // delete every tag, clear the author and publish a hidden article.
  //
  // Undefined `changedFields` ⇒ write nothing. A caller that does not say what
  // changed is indistinguishable from one where nothing did, and only one of
  // those two readings is safe.
  const touched = (key: keyof AttributeInput) => !!changedFields?.includes(key);

  const declared = ATTRIBUTES_BY_RESOURCE[resource] ?? [];
  const allowed = declared.filter(touched);
  const input: AttributeInput & { rejected?: string[] } = {};
  const rejected: string[] = [];

  if (allowed.includes("isPublished") && updates.isPublished !== undefined) {
    // Anything but an explicit "false" is published — the same rule as the
    // column default, so a value written before the attribute sync existed
    // does not silently unpublish an item.
    input.isPublished = updates.isPublished !== "false";
  }

  if (allowed.includes("templateSuffix") && updates.templateSuffix !== undefined) {
    // "" means "back to the theme default", which Shopify expresses as null.
    input.templateSuffix = updates.templateSuffix.trim() || null;
  }

  if (allowed.includes("sortOrder") && updates.sortOrder !== undefined) {
    const value = updates.sortOrder.trim().toUpperCase();
    // Empty is "not set" — nothing to write, and certainly not an enum error.
    if (value) {
      if (isValidSortOrder(value)) input.sortOrder = value;
      else rejected.push("sortOrder");
    }
  }

  if (allowed.includes("author") && updates.author !== undefined) {
    const name = updates.author.trim();
    // `ArticleCreateInput.author` is REQUIRED, so an article always has one.
    // Sending an empty name would be Shopify's problem to reject; leaving the
    // existing author alone is the honest reading of an emptied field the UI
    // marks required.
    if (name) input.author = name;
    else rejected.push("author");
  }

  if (allowed.includes("tags") && updates.tags !== undefined) {
    // Shopify REPLACES the whole list, so this is the complete set, not an
    // addition. An empty string therefore legitimately clears every tag.
    input.tags = parseTagList(updates.tags);
  }

  if (rejected.length > 0) input.rejected = rejected;
  return input;
}
