/**
 * Which item `/app/metaobjects?select=…` should open on.
 *
 * Pure and client-safe, and its own module for one reason: this rule shipped
 * wrong twice while it lived inline in the page, because nothing could test it.
 *
 * -- What the page can actually select ---------------------------------------
 * The list holds TYPES, not entries: one item per metaobject definition, with
 * `id = "metaobject_type_<type>"`. Entries load lazily underneath a type, 25 at
 * a time. So the best any deep link can do is open the RIGHT TYPE — an entry
 * cannot be selected here, and a link that claims to "land on the entry" is
 * describing something this page does not do.
 *
 * -- What a caller may send ---------------------------------------------------
 * 1. A Metaobject GID (`gid://shopify/Metaobject/123`). This names an ENTRY, so
 *    it matches no item at all — the loader resolves it to the entry's type
 *    from the cache and passes that in as `resolvedType`. The client cannot do
 *    that step itself, which is why it is not attempted here.
 * 2. A type handle ("color"), a definition name ("Color"), or a title.
 * 3. A metafield key ("custom--material"). A linked product option carries
 *    `<namespace>--<key>`, which equals the metaobject type ONLY for Shopify's
 *    standard definitions, where the two happen to be spelled alike. The part
 *    after the namespace is therefore tried too — but strictly SECOND.
 *
 * -- Why two passes ----------------------------------------------------------
 * `find` with five clauses evaluates all of them per item, in item order, so a
 * definition matching only the loose form and sorting earlier would beat one
 * matching the parameter exactly. A near-miss must never take an exact match's
 * place: exact over the whole list first, loose only if nothing exact exists.
 */

export interface MetaobjectTypeItem {
  id: string;
  type?: string | null;
  title?: string | null;
  definitionName?: string | null;
}

export function resolveMetaobjectSelection(
  items: MetaobjectTypeItem[],
  selectParam: string | null,
  /** The type of the entry a Metaobject GID pointed at, resolved server-side. */
  resolvedType?: string,
): string | undefined {
  if (items.length === 0) return undefined;
  const wanted = (resolvedType || selectParam || "").toLowerCase().trim();
  if (!wanted) return undefined;

  const exact = items.find(
    (item) =>
      item.type?.toLowerCase() === wanted ||
      item.title?.toLowerCase() === wanted ||
      item.definitionName?.toLowerCase() === wanted,
  );
  if (exact) return exact.id;

  if (!wanted.includes("--")) return undefined;
  const withoutNamespace = wanted.split("--").slice(1).join("--");
  const loose = items.find(
    (item) =>
      item.type?.toLowerCase() === withoutNamespace ||
      item.definitionName?.toLowerCase() === withoutNamespace,
  );
  return loose?.id;
}
