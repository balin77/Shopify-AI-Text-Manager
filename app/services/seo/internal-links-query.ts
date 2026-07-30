/**
 * How the internal-linking suggestion list is sliced: the two views, the type
 * filters and the WHERE clause they turn into.
 *
 * Shared by the page's loader and the apply endpoint so that "everything that
 * is listed" means the same set in both — the bulk actions must never act on a
 * wider set than the merchant is looking at. Client-safe (plain data), because
 * the page also renders the filter options from FILTER_TYPES.
 */

export const FILTER_TYPES = ["Product", "Collection", "Article", "Page"] as const;
export type FilterType = (typeof FILTER_TYPES)[number];

export const VIEWS = ["open", "rejected"] as const;
export type View = (typeof VIEWS)[number];

/** URL `view` -> the DB status that view lists. */
export const VIEW_STATUS: Record<View, string> = { open: "pending", rejected: "dismissed" };

export function parseView(raw: string | null): View {
  return VIEWS.includes(raw as View) ? (raw as View) : "open";
}

export function parseTypeFilter(raw: string | null): FilterType | null {
  return FILTER_TYPES.includes(raw as FilterType) ? (raw as FilterType) : null;
}

/**
 * The listed set. Filters belong in SQL, not in the client — otherwise page 1
 * of a filtered list would only contain whatever survived filtering out of the
 * first unfiltered page.
 */
export function suggestionWhere(shop: string, view: View, fromFilter: FilterType | null, toFilter: FilterType | null) {
  return {
    shop,
    status: VIEW_STATUS[view],
    ...(fromFilter ? { fromResourceType: fromFilter } : {}),
    ...(toFilter ? { toResourceType: toFilter } : {}),
  };
}
