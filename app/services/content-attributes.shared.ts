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

/**
 * Is this field one of the §Phase 3 merchandising attributes?
 *
 * The two marks together, never the `type` alone: `vendor`, `author` and
 * `templateSuffix` are `type: "text"` like a title is, and routing on type
 * would either miss them (leaving them without the not-synced lock and the
 * not-translatable notice the other four get) or swallow every text field in
 * the app. `translationKey: ""` plus `supportsTranslation: false` is true of
 * exactly these seven fields and of nothing else in the repo.
 */
export function isAttributeField(field: {
  translationKey?: string;
  supportsTranslation?: boolean;
}): boolean {
  return field.supportsTranslation === false && !field.translationKey;
}

/**
 * WHICH CARD a field renders in — the one place that decides, for all three.
 *
 * WHERE a field sits and HOW it saves are separate questions. `isAttributeField`
 * above answers the second and nothing here changes that: it still decides the
 * not-translatable notice, the `attributesSyncedAt` lock and the `changedFields`
 * gate. This answers only the first, and DERIVES it from the second — an
 * attribute belongs in the Details card, everything else in the main one — so
 * that a new field lands in the right place without saying anything.
 *
 * `card` is how the two deliberately come apart, and there are exactly two
 * such fields. `category` is an attribute that renders UP in the main card,
 * because Shopify's own admin puts the category next to the description and a
 * merchant who knows that admin looks there. `productType` is translatable
 * content that renders DOWN in the Details card, right next to the category —
 * the two are constantly taken for one field, and two cards apart there was
 * nothing to compare. Both keep their own save semantics either way.
 */
export function fieldCard(field: {
  card?: string;
  translationKey?: string;
  supportsTranslation?: boolean;
}): "main" | "searchEngine" | "details" {
  if (field.card === "searchEngine") return "searchEngine";
  if (field.card === "details") return "details";
  if (field.card === "main") return "main";
  return isAttributeField(field) ? "details" : "main";
}

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

// ────────────────────────────────────────────────────────────────────────────
// §Phase 3.1 — collection MEMBERSHIP (products only)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Membership is a DIFF, not a list.
 *
 * `ProductInput` takes `collectionsToJoin` / `collectionsToLeave`, so sending
 * "the collections this product is in" is not an option at all — and that is
 * the right shape anyway: a product can belong to collections whose rows this
 * shop never cached (the collection cache is capped by the merchant's plan),
 * and a full-list write would silently drop every one of them.
 *
 * Two rules carry the correctness here:
 *
 *   - The BEFORE side is the CACHE (`ProductCollection`), never the client. A
 *     payload that names an id as "left" must not be able to remove a
 *     membership this editor never showed.
 *   - A RULE-BASED collection is never touched, in EITHER direction. Leaving
 *     one is undone by its rule within seconds — a save that apparently did
 *     nothing. JOINING one is worse: Shopify refuses manual membership on a
 *     smart collection, and because `productUpdate` is atomic that refusal
 *     takes the merchant's title, description and SEO edits down with it. The
 *     picker locks such rows; this is the server-side twin, because the action
 *     is reachable by POST.
 *   - `automated: null` means UNKNOWN — a collection row written before the
 *     attribute sync existed, where the column's `false` default is
 *     indistinguishable from a measured "manual". Unknown is treated as
 *     automated for the purpose of refusing: the cost of not adding a
 *     membership is a merchant clicking again, the cost of adding it wrongly is
 *     a lost text edit.
 */
export interface MembershipDiff {
  toJoin: string[];
  toLeave: string[];
  /** Rule-based (or unknown) collections the payload tried to change. */
  refusedAutomated: string[];
}

export function diffCollectionMembership(
  before: Array<{ collectionId: string; automated: boolean | null }>,
  afterIds: string[],
  /**
   * How each collection in the SHOP reads — the picker's own list. Only
   * consulted for a JOIN, where `before` by definition has no row to read.
   * Omitted ⇒ joins are not screened, which is the pre-existing behaviour and
   * the right one for a caller that has no list to screen against.
   */
  known?: Map<string, boolean | null>,
): MembershipDiff {
  const beforeById = new Map(before.map((row) => [row.collectionId, row] as const));
  const after = new Set(afterIds.filter((id) => id.trim()));

  const toJoin: string[] = [];
  const refusedAutomated: string[] = [];

  for (const id of after) {
    if (beforeById.has(id)) continue;
    // Not `=== true`: `null` (never attribute-synced) is refused too. See the
    // header — the asymmetry of the two costs is the whole argument.
    if (known && known.has(id) && known.get(id) !== false) {
      refusedAutomated.push(id);
      continue;
    }
    toJoin.push(id);
  }

  const toLeave: string[] = [];
  for (const row of before) {
    if (after.has(row.collectionId)) continue;
    if (row.automated !== false) {
      refusedAutomated.push(row.collectionId);
      continue;
    }
    toLeave.push(row.collectionId);
  }

  return { toJoin, toLeave, refusedAutomated };
}

/**
 * The editor carries membership as a comma-separated list of collection GIDs,
 * like every other value in that flat map. Parsed here so the client and the
 * server read it the same way.
 */
export function parseCollectionIds(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const id = raw.trim();
    // Only real GIDs. A stray token would become a `collectionsToJoin` entry
    // and fail the WHOLE mutation, taking the merchant's text edits with it.
    if (!id.startsWith("gid://shopify/Collection/")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** A taxonomy GID, or null for "cleared". Anything else is refused. */
export function parseCategoryId(value: string): { id: string | null; valid: boolean } {
  const trimmed = value.trim();
  if (!trimmed) return { id: null, valid: true };
  // Same reasoning as the collection ids: a bad ID fails at the schema level,
  // which never reaches `userErrors` — the save would read as a success while
  // nothing was written.
  if (!trimmed.startsWith("gid://shopify/TaxonomyCategory/")) return { id: null, valid: false };
  return { id: trimmed, valid: true };
}
