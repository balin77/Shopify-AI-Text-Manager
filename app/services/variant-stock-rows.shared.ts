/**
 * The rows of the stock table — for ONE variant, or for a whole group of them.
 *
 * -- Why a module of its own -------------------------------------------------
 * The table used to be a single variant's: one row per location, four numbers
 * read straight off `variant.levels`. A bulk scope makes every one of those
 * numbers a question about N variants at once, and the answers are not
 * interchangeable — "they all hold 5", "they hold different amounts" and "we
 * could not read the number" are three different statements, and a table that
 * renders all three as a figure is the one thing this panel may not do.
 *
 * So the aggregation is pure, testable and in one place, and the component
 * only renders what comes out of it.
 *
 * -- The one rule everything here follows ------------------------------------
 * A cell is a NUMBER only when every member agrees on it. Where they differ it
 * is `"mixed"`, which renders as `≠` and never as an arithmetic result: a sum
 * over the members would put "on hand 60" in a row whose input writes ONE
 * number per variant, and a merchant reading that row would type a number
 * meaning the opposite of what it does. Where any member's number could not be
 * read it is `null`, which renders as an em dash — the existing rule, unchanged.
 *
 * -- Stock is still never computed -------------------------------------------
 * Nothing here divides, distributes or sums a quantity that will be WRITTEN.
 * A bulk edit puts the typed number into every member's own edit key, and the
 * save path compares each one against that member's own loaded quantity — the
 * same compare-and-swap a single variant gets, N times. `cached + delta` is
 * still not expressible, and that is deliberate.
 */

/** A cell: a known number, unknown (`null`, an em dash), or differing (`≠`). */
export type StockCell = number | null | "mixed";

/** What one member contributes to one row — and the key its write lands on. */
export interface StockRowEntry {
  /** `variantId::locationId`, exactly the key the save path splits again. */
  key: string;
  /** Whether THIS member is activated at this location. */
  stocked: boolean;
  onHand: number | null;
}

export interface StockRow {
  /** The location id. Also the React key: a location appears once per table. */
  id: string;
  name: string;
  /** The LOCATION's own flag — a deactivated location takes no writes. */
  active: boolean;
  /** `"mixed"` when some members are stocked here and others are not. */
  stocked: boolean | "mixed";
  unavailable: StockCell;
  committed: StockCell;
  available: StockCell;
  /** One per member, in the members' own order. */
  entries: StockRowEntry[];
}

export interface StockMemberLevel {
  locationId: string;
  locationName: string;
  locationActive: boolean;
  onHand: number | null;
  available: number | null;
  committed: number | null;
  unavailable: number | null;
}

export interface StockMember {
  id: string;
  levels: StockMemberLevel[];
  levelsTruncated: boolean;
}

export interface StockLocation {
  id: string;
  name: string;
  isActive: boolean;
}

/**
 * The aggregate of one column over the members.
 *
 * A member that is not stocked here contributes NOTHING rather than a zero:
 * "we do not stock this here" and "we hold none" are different answers, and
 * the row's `stocked` flag is where that difference is already stated. Where
 * the members split on it the whole row reads `"mixed"` anyway.
 */
function cell(values: Array<number | null>): StockCell {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((value) => value === first) ? first : "mixed";
}

/**
 * One row per location, ordered the way the merchant's own data is.
 *
 * Locations that hold stock come first, in the order the members report them —
 * which for a single member is exactly the order the table always had. The
 * shop's other locations follow, and are suppressed entirely when ANY member's
 * level window was cut off: the rows that came back are the first ten of more,
 * so a location missing from them is not evidence that it holds nothing, and
 * an input on such a row would route into an activation that overwrites a real
 * quantity with no comparison.
 */
export function buildStockRows(
  members: StockMember[],
  shopLocations: StockLocation[],
): { rows: StockRow[]; truncated: boolean } {
  const truncated = members.some((member) => member.levelsTruncated);

  /** Every location any member is stocked at, first-seen order. */
  const order: string[] = [];
  const names = new Map<string, string>();
  const active = new Map<string, boolean>();
  for (const member of members) {
    for (const level of member.levels) {
      if (!order.includes(level.locationId)) order.push(level.locationId);
      if (!names.has(level.locationId)) names.set(level.locationId, level.locationName || level.locationId);
      if (!active.has(level.locationId)) active.set(level.locationId, level.locationActive);
    }
  }
  if (!truncated) {
    for (const location of shopLocations) {
      if (order.includes(location.id)) continue;
      order.push(location.id);
      names.set(location.id, location.name || location.id);
      active.set(location.id, location.isActive);
    }
  }

  const rows = order.flatMap((locationId): StockRow[] => {
    const found = members.map((member) => ({
      member,
      level: member.levels.find((l) => l.locationId === locationId) ?? null,
    }));
    /**
     * The members this row can speak for.
     *
     * A member whose level window was CUT OFF and that reports no level here
     * is UNKNOWN, not unstocked — its location 11+ simply did not come back.
     * Counting it as unstocked would put an empty input in front of a real
     * quantity, and a number typed there routes into an ACTIVATION, which
     * writes with no comparison at all. That is the compare-less overwrite the
     * whole panel is built to refuse, and it cannot happen on a single variant
     * (the table is dropped wholesale there), so it arrived with the group.
     *
     * Such a member is left out of the row entirely: out of its figures, out
     * of its edit keys, and therefore out of the write. What tells the
     * merchant the table is incomplete is the truncation line above it, which
     * is already shown whenever any member was cut off.
     */
    const speaking = found.filter((f) => f.level !== null || !f.member.levelsTruncated);
    if (speaking.length === 0) return [];
    const stockedCount = speaking.filter((f) => f.level !== null).length;
    const stocked: boolean | "mixed" =
      stockedCount === 0 ? false : stockedCount === speaking.length ? true : "mixed";

    /** The three read-only columns, over the members that are stocked here.
     *  With none of them stocked the row has no numbers at all — an em dash,
     *  which is what a location nobody stocks always showed. */
    const column = (pick: (level: StockMemberLevel) => number | null): StockCell => {
      if (stocked === false) return null;
      if (stocked === "mixed") return "mixed";
      return cell(speaking.map((f) => (f.level ? pick(f.level) : null)));
    };

    return [
      {
        id: locationId,
        name: names.get(locationId) ?? locationId,
        active: active.get(locationId) ?? false,
        stocked,
        unavailable: column((l) => l.unavailable),
        committed: column((l) => l.committed),
        available: column((l) => l.available),
        entries: speaking.map((f) => ({
          key: `${f.member.id}::${locationId}`,
          stocked: f.level !== null,
          onHand: f.level?.onHand ?? null,
        })),
      },
    ];
  });

  return { rows, truncated };
}

/**
 * What the on-hand input shows: the value every member holds (or has been
 * given), `null` where they differ, `""` where there is nothing to show.
 *
 * An EDIT wins over the loaded number for the member it belongs to, which is
 * what makes a group half-edited in a single scope read as `≠` rather than as
 * whichever number happens to be first. A member that is not stocked here
 * shows nothing, never a `0`: a pre-filled zero reads as "we hold none" for a
 * location the merchant does not stock at all.
 */
export function onHandFieldValue(row: StockRow, edits: Record<string, string>): string | null {
  const values = row.entries.map((entry) => {
    const edited = edits[entry.key];
    if (edited !== undefined) return edited;
    return entry.stocked ? String(entry.onHand ?? "") : "";
  });
  if (values.length === 0) return "";
  const first = values[0];
  return values.every((value) => value === first) ? first : null;
}

/**
 * A column's total over the rows — ALL or nothing, the table's own rule.
 *
 * A row whose number could not be read makes the total unknown, and one the
 * members disagree about makes it `≠`. Summing what is known and skipping the
 * rest produced a smaller figure under the word "Total", with a different
 * number of rows behind each column.
 *
 * It takes the cells ALREADY RESOLVED, and that is not a detail: "a location
 * nobody stocks holds 0" is true of the three read-only columns and false of
 * the on-hand one, where the merchant may have TYPED a quantity into exactly
 * such a row — that is how a location is stocked for the first time, and a
 * substitution made in here would replace their number with a zero and leave
 * the total sitting still while they typed.
 */
export function totalCell(values: StockCell[]): StockCell {
  if (values.some((value) => value === "mixed")) return "mixed";
  if (values.some((value) => value == null)) return null;
  return (values as number[]).reduce((a, b) => a + b, 0);
}
