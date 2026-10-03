/**
 * The theme page's own translation cache, addressed by LAYER.
 *
 * `loadTranslations` answers every row of a locale: the GLOBAL layer
 * (`marketId` "" / absent) and each market's override of the same key sit side
 * by side. A lookup by key alone returns whichever comes first, so a save, a
 * clear or a translate answer written into one layer overwrote (or removed) the
 * other, and the editor showed the wrong wording until a reload. Every cache
 * write and read of that page goes through these helpers, which always name the
 * layer. Import-free on purpose (client and tests).
 */
export interface ThemeCacheRow {
  key: string;
  value: string;
  locale?: string;
  marketId?: string;
}

const layerOf = (row: { marketId?: string }): string => row.marketId ?? "";

/** Put one value into ONE layer of a locale's cached rows (in place). */
export function upsertThemeRow(
  rows: ThemeCacheRow[],
  key: string,
  value: string,
  locale: string,
  marketId: string = "",
): void {
  const index = rows.findIndex((tr) => tr.key === key && layerOf(tr) === marketId);
  if (index >= 0) {
    rows[index] = { ...rows[index], value };
  } else {
    rows.push({ key, value, locale, marketId });
  }
}

/** Drop one layer's row of a key (in place); other layers are untouched. */
export function removeThemeRow(rows: ThemeCacheRow[], key: string, marketId: string = ""): void {
  const index = rows.findIndex((tr) => tr.key === key && layerOf(tr) === marketId);
  if (index >= 0) rows.splice(index, 1);
}

/**
 * What a foreign save wrote: non-empty values are upserted, empty ones are
 * REMOVED (a kept "" row would count as a translation), all in the layer the
 * save was made for. Returns a new list.
 */
export function applyThemeSaveToRows(
  rows: ThemeCacheRow[],
  values: Record<string, string>,
  locale: string,
  marketId: string,
): ThemeCacheRow[] {
  const next = [...rows];
  for (const [key, value] of Object.entries(values)) {
    if (value) upsertThemeRow(next, key, value, locale, marketId);
    else removeThemeRow(next, key, marketId);
  }
  return next;
}

/**
 * The value a view shows for a key: the open market's override where it has
 * one, else the global row (the editor's own display chain). Global view
 * (`marketId` "") reads the global row only.
 */
export function themeRowValue(
  rows: ThemeCacheRow[] | undefined,
  key: string,
  marketId: string = "",
): string {
  if (!rows) return "";
  if (marketId) {
    const own = rows.find((tr) => tr.key === key && layerOf(tr) === marketId);
    if (own?.value) return own.value;
  }
  return rows.find((tr) => tr.key === key && layerOf(tr) === "")?.value || "";
}
