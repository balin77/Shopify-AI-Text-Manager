/**
 * The permitted values of a Shopify product-taxonomy ATTRIBUTE, by handle.
 *
 * This is the one thing that stood between the app and creating an entry of a
 * Shopify STANDARD metaobject definition: `shopify--color-pattern` and nine
 * siblings on a live shop have a REQUIRED `product_taxonomy_value_reference`
 * field, and a form that cannot collect a value Shopify accepts is a
 * guaranteed rejection with no way for the merchant to fix it.
 *
 * MEASURED (2026-08-19, live shop, API 2026-07 -- PLAN_METAOBJECT_TAXONOMY_CREATE
 * §1.2/§1.3), and every rule below comes from that run rather than from a guess:
 *
 * 1. **The category is the only door.** `Taxonomy` exposes nothing but
 *    `categories`; the values hang off
 *    `TaxonomyCategory.attributes -> TaxonomyChoiceListAttribute.values`.
 * 2. **The query is COST-BOUND.** `categories(10) x attributes(50)` is roughly
 *    500 points against the Admin API's ~1000-point single-query ceiling, and
 *    nesting `values(250)` inside it multiplies into six figures -- the first
 *    probe cut came back `MAX_COST_EXCEEDED`, which was then reported as "no
 *    path exists". So it is two rounds: find the attribute id cheaply, then
 *    fetch its values by id.
 * 3. **The lists are small.** 19 colours, 51 patterns, neither truncated --
 *    which is why the caller renders a list and not a search picker.
 * 4. **The attribute is matched by NAME**, because the union member exposes no
 *    `handle`. For `color` and `pattern` that inference is CONFIRMED by
 *    containment (every value real entries hold is in the offered list). For
 *    the other definitions it is not measured, which is why a miss returns a
 *    REASON and never an empty list: "we could not read the values" and "there
 *    are no values" must not look the same, and the UI turns the first into a
 *    deep link into the Shopify admin rather than a picker that offers nothing.
 *
 * The lookup is memoised per attribute handle. Shopify's product taxonomy is
 * global and changes on their release cadence, not the merchant's, so a shop
 * scope would buy nothing and cost one three-round sweep per shop per field.
 */

import { logger } from "~/utils/logger.server";

export interface TaxonomyValueOption {
  id: string;
  name: string;
}

export type TaxonomyValuesResult =
  /** The attribute was found and its values read. `truncated` = a full page
   *  came back, so the list is "these and possibly more" -- stated, never
   *  silently presented as complete. */
  | { known: true; attributeName: string; values: TaxonomyValueOption[]; truncated: boolean }
  /**
   * No list. `attributeNotFound` = the API answered and none of the sampled
   * categories carries an attribute of that name; `lookupFailed` = we got no
   * answer at all. Separate states, because a failed call is not a negative
   * answer -- the trap this whole plan was written around.
   */
  | { known: false; reason: "attributeNotFound" | "lookupFailed"; detail?: string };

interface AdminLike {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

/** One page of categories per round. See cost note (2) in the module header. */
const CATEGORY_PAGE = 10;
/** Attributes per category. 10 x 50 is the measured ~500-point round. */
const ATTRIBUTE_PAGE = 50;
/** Values of the ONE attribute, fetched by id in a round of its own. */
const VALUE_PAGE = 250;
/** How long a resolved attribute stays memoised. The taxonomy moves on
 *  Shopify's release cadence; an hour is short enough to pick up a change on
 *  the day it matters and long enough that a form never pays for the sweep. */
const CACHE_TTL_MS = 60 * 60 * 1000;

const cache = new Map<string, { at: number; result: TaxonomyValuesResult }>();

/** Exposed for tests: a memo that survives between them hides real failures. */
export function clearTaxonomyValueCache(): void {
  cache.clear();
}

/**
 * Attribute names and validation handles into one comparable form.
 *
 * `Bag/Case storage features` has to match the handle `bag-case-storage-features`,
 * so every run of non-alphanumerics collapses to a single hyphen -- the `/`
 * being the case a space-only rule gets wrong, and the reason this is a shared
 * function rather than an inline `replace` at each side of the comparison.
 */
export function normalizeTaxonomyHandle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function call(
  admin: AdminLike,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  try {
    const response = await admin.graphql(query, { variables });
    const body = (await response.json()) as { data?: any; errors?: Array<{ message?: string }> };
    if (body.errors?.length) {
      return { ok: false, error: body.errors.map((e) => e?.message ?? "?").join("; ") };
    }
    if (!body.data) return { ok: false, error: "no data" };
    return { ok: true, data: body.data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const CATEGORY_ATTRIBUTES = `#graphql
  query TaxonomyCategoryAttributes($search: String, $first: Int!, $attrFirst: Int!) {
    taxonomy {
      categories(search: $search, first: $first) {
        nodes {
          id
          attributes(first: $attrFirst) {
            nodes {
              __typename
              ... on TaxonomyChoiceListAttribute { id name }
            }
          }
        }
      }
    }
  }`;

const ATTRIBUTE_VALUES = `#graphql
  query TaxonomyAttributeValues($ids: [ID!]!, $first: Int!) {
    nodes(ids: $ids) {
      __typename
      ... on TaxonomyChoiceListAttribute {
        id
        name
        values(first: $first) { nodes { id name } }
      }
    }
  }`;

const TAXONOMY_VALUE_NAMES = `#graphql
  query TaxonomyValueNames($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on TaxonomyValue { id name }
    }
  }`;

/**
 * The search terms tried, in order, until the attribute turns up.
 *
 * The first round is the top-level verticals with NO search: that is where
 * `Color` and `Pattern` were measured, and it is the cheapest thing that can
 * work. A narrower attribute (`vase-shape`, `tool-utensil-material`) hangs off
 * a leaf instead, so the next two rounds search by the handle's own words and
 * then by its first word. Three bounded rounds rather than a walk of the whole
 * tree: the tree has tens of thousands of nodes and a picker cannot wait for it.
 */
function searchTermsFor(handle: string): Array<string | null> {
  const words = handle.split("-").filter(Boolean);
  const terms: Array<string | null> = [null];
  if (words.length > 0) terms.push(words.join(" "));
  if (words.length > 1) terms.push(words[0]);
  return terms;
}

/** Find the attribute id whose name normalises to `handle`. */
async function findAttribute(
  admin: AdminLike,
  handle: string,
): Promise<{ ok: true; id: string; name: string } | { ok: false; reason: "attributeNotFound" | "lookupFailed"; detail?: string }> {
  const wanted = normalizeTaxonomyHandle(handle);
  const failures: string[] = [];

  for (const search of searchTermsFor(handle)) {
    const res = await call(admin, CATEGORY_ATTRIBUTES, {
      search,
      first: CATEGORY_PAGE,
      attrFirst: ATTRIBUTE_PAGE,
    });
    if (!res.ok) {
      failures.push(res.error);
      continue;
    }
    const categories = (res.data?.taxonomy?.categories?.nodes ?? []) as any[];
    for (const category of categories) {
      for (const attribute of (category?.attributes?.nodes ?? []) as any[]) {
        if (!attribute?.id || !attribute?.name) continue;
        if (normalizeTaxonomyHandle(String(attribute.name)) !== wanted) continue;
        return { ok: true, id: String(attribute.id), name: String(attribute.name) };
      }
    }
  }

  // ANY round that failed poisons the negative. The FIRST round is the
  // no-search one, and that is where `Color` and `Pattern` were measured to
  // live -- so "round 1 was throttled, round 2 answered without a match" is
  // exactly the case that would otherwise tell a merchant, definitively, that
  // their definition names an attribute nobody has. A failed call is not a
  // negative answer, and a partly failed sweep is not a whole one.
  if (failures.length > 0) {
    return { ok: false, reason: "lookupFailed", detail: failures[0] };
  }
  return { ok: false, reason: "attributeNotFound" };
}

/**
 * The permitted values for one attribute handle.
 *
 * Never throws: the caller is a picker, and an exception there costs the whole
 * editor. A failure comes back as `known: false` with a reason.
 */
export async function taxonomyValuesForHandle(
  admin: AdminLike,
  handle: string,
): Promise<TaxonomyValuesResult> {
  const key = normalizeTaxonomyHandle(handle);
  if (key === "") return { known: false, reason: "attributeNotFound" };

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  const remember = (result: TaxonomyValuesResult): TaxonomyValuesResult => {
    // `lookupFailed` is NEVER memoised -- it would turn one throttled request
    // into an hour of "this field has no values" for every merchant behind the
    // same instance. `attributeNotFound` IS: it is a stable answer about the
    // taxonomy, and not remembering it means every control on a page of 25
    // entries re-runs the three-round sweep for a question already answered.
    if (result.known || result.reason === "attributeNotFound") {
      cache.set(key, { at: Date.now(), result });
    }
    return result;
  };

  const found = await findAttribute(admin, handle);
  if (!found.ok) {
    if (found.reason === "lookupFailed") {
      logger.warn("[taxonomy] attribute lookup failed", { handle, detail: found.detail });
    }
    return remember({ known: false, reason: found.reason, detail: found.detail });
  }

  const res = await call(admin, ATTRIBUTE_VALUES, { ids: [found.id], first: VALUE_PAGE });
  if (!res.ok) {
    logger.warn("[taxonomy] value read failed", { handle, detail: res.error });
    return remember({ known: false, reason: "lookupFailed", detail: res.error });
  }
  const values = ((res.data?.nodes ?? []) as any[])
    .flatMap((node) => (node?.values?.nodes ?? []) as any[])
    .filter((v) => v?.id && v?.name)
    .map((v) => ({ id: String(v.id), name: String(v.name) }));

  // An EMPTY list from a path that answered is not a count -- it is a path
  // that carried nothing, and offering it as "no values" would present the
  // failure as the merchant's data.
  if (values.length === 0) {
    return remember({ known: false, reason: "lookupFailed", detail: "the values connection answered empty" });
  }

  return remember({
    known: true,
    attributeName: found.name,
    values,
    truncated: values.length >= VALUE_PAGE,
  });
}

/**
 * Names for taxonomy GIDs an entry already holds.
 *
 * Separate from the list because the two answer different questions and fail
 * independently: a value can be stored that the offered list does not contain
 * (a definition changed, or the attribute was matched wrongly), and the editor
 * must still be able to SHOW it. A GID that resolves to nothing is returned
 * unnamed rather than dropped -- dropping it is what would make the next save
 * clear a value nobody meant to touch.
 */
export async function taxonomyValueNames(
  admin: AdminLike,
  ids: string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) return {};
  const res = await call(admin, TAXONOMY_VALUE_NAMES, { ids: unique });
  if (!res.ok) {
    logger.warn("[taxonomy] name resolution failed", { detail: res.error });
    return {};
  }
  const names: Record<string, string> = {};
  for (const node of (res.data?.nodes ?? []) as any[]) {
    if (node?.id && node?.name) names[String(node.id)] = String(node.name);
  }
  return names;
}
