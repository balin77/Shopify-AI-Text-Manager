/**
 * How the Details card lays its fields out.
 *
 * The card collects the merchandising attributes — the facts ABOUT an item
 * rather than the words it says. It used to split them into titled subcards per
 * section, which on a product meant three frames around six fields and a
 * heading ("Theme-Vorlage") standing directly above a field already labelled
 * "Theme-Template". The fields ARE the section names: a vendor, a product type,
 * collections and tags do not need a word above them saying "Organisation".
 *
 * So there is now ONE grey panel and one grid. What is left to decide is which
 * of two shapes a field has, and that is the whole of this module:
 *
 *  - a BOX — one label row and one control, the size of every other box. Five
 *    of the product's six fields.
 *  - the ASIDE — the sales-channel panel. It is a LIST, not a box: three
 *    columns of switch rows that want roughly double the width and grow taller
 *    than anything beside them. Placed as a double-wide cell inside the same
 *    auto-fit grid it can only land where auto-placement puts it, which with
 *    five boxes ahead of it is the middle of the last row with a hole beside
 *    it. As its own flex region (`.app-details-layout__aside`) it sits flush
 *    RIGHT while there is room and drops to a full-width row of its own when
 *    there is not — no hole in either case.
 *  - FULL width inside the grid — the collection rule builder, which is an
 *    editor rather than a field and has never fitted in a column.
 *
 * Keyed on the field TYPE, never on the key: the type is what says "this is a
 * list of switches" or "this is a rule editor", and a second content type that
 * grows the same control would otherwise have to be remembered here.
 */

/** Types that render as their own region beside the grid, not inside it. */
const ASIDE_FIELD_TYPES = new Set(["commerce"]);

/** Types that need the whole grid width wherever the grid is. */
const FULL_WIDTH_FIELD_TYPES = new Set(["collectionRules"]);

export interface DetailsLayoutField {
  type: string;
}

/** Does this field render beside the grid rather than in it? */
export function isDetailsAsideField(field: DetailsLayoutField): boolean {
  return ASIDE_FIELD_TYPES.has(field.type);
}

/** Does this field span every column of the grid? */
export function isFullWidthDetailsField(field: DetailsLayoutField): boolean {
  return FULL_WIDTH_FIELD_TYPES.has(field.type);
}

export interface DetailsLayout<F> {
  /** The boxes, in config order — the auto-fit grid. */
  grid: F[];
  /** The right-hand region, in config order. Empty for every type but products. */
  aside: F[];
}

/**
 * Split the Details card's fields into the two regions.
 *
 * Order inside each region is the CONFIG's, untouched: the config is the one
 * place that says a vendor comes before a product type, and a second ordering
 * rule here would be a second answer to the same question.
 */
export function splitDetailsFields<F extends DetailsLayoutField>(fields: F[]): DetailsLayout<F> {
  const grid: F[] = [];
  const aside: F[] = [];
  for (const field of fields) {
    (isDetailsAsideField(field) ? aside : grid).push(field);
  }
  return { grid, aside };
}
