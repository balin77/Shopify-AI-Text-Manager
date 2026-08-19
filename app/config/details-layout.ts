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

import { isAttributeField } from "../services/content-attributes.shared";

/** Types that render as their own region beside the grid, not inside it. */
const ASIDE_FIELD_TYPES = new Set(["commerce"]);

/** Types that need the whole grid width wherever the grid is. */
const FULL_WIDTH_FIELD_TYPES = new Set(["collectionRules"]);

/**
 * Types that are ONE control and nothing else — no chips under the box, no row
 * of AI buttons, no banner about what could not be loaded.
 *
 * They get a half-height card, which is the whole reason the grid counts in
 * half rows: a vendor name and a theme template are a label and a box, and a
 * card sized for a tag list around them is mostly empty grey. Two of them stack
 * in the space one ordinary field takes.
 */
const HALF_HEIGHT_FIELD_TYPES = new Set(["text", "select", "toggle", "money", "themeTemplate"]);

export interface DetailsLayoutField {
  type: string;
  translationKey?: string;
  supportsTranslation?: boolean;
  groupId?: string;
}

/** Does this field render beside the grid rather than in it? */
export function isDetailsAsideField(field: DetailsLayoutField): boolean {
  return ASIDE_FIELD_TYPES.has(field.type);
}

/** Does this field span every column of the grid? */
export function isFullWidthDetailsField(field: DetailsLayoutField): boolean {
  return FULL_WIDTH_FIELD_TYPES.has(field.type);
}

/**
 * Is one control the whole of this field, so half a card is enough?
 *
 * The type alone cannot answer it: `productType` is a `text` too, and it is
 * NOT an attribute — it is translatable content, so it renders through
 * `AIEditableField` with its improve / translate / copy row underneath and
 * needs the full card. `isAttributeField` is exactly the line between the two,
 * and it is the same predicate that decides the field's SAVE semantics, so a
 * new field cannot end up with a bare control and a tall card or the reverse.
 */
export function isHalfHeightDetailsField(field: DetailsLayoutField): boolean {
  return isAttributeField(field) && HALF_HEIGHT_FIELD_TYPES.has(field.type);
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
