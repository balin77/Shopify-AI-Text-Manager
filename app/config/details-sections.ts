/**
 * The subcards INSIDE the Details card.
 *
 * The Details card collects the merchandising attributes — the facts about an
 * item rather than the words it says. Flat, they were one grid of eight
 * unrelated controls: a vendor name next to a stock panel next to a theme file
 * suffix, with nothing saying which question each one answers. Shopify's own
 * admin splits exactly these into cards (Product organization, Theme template,
 * …), and the Variants card in this editor already carries the nested-Card
 * look, so this reuses both.
 *
 * The model is the same shape the rest of the editor uses — declarative on the
 * field, resolved once here:
 *
 *  - A field names its section in content-fields.config.tsx; the fields are
 *    folded into sections in CONFIG ORDER, and only CONSECUTIVE fields of the
 *    same section fold together. A field can therefore never jump into a
 *    subcard further up the card just because it carries the same tag.
 *  - `attributeFields` is already filtered (the status control is hoisted into
 *    the action bar, the default price only exists for a single-variant
 *    product), so a section whose fields all dropped out simply never appears.
 *  - With only ONE section left there is nothing to separate, so the card
 *    renders flat exactly as before — `shouldRenderDetailsSections`. A page or
 *    a blog whose only attribute is the theme template would otherwise get a
 *    titled box inside a titled box saying the same thing twice.
 */

/** The subcards the Details card can split into, in render order. */
export type DetailsSectionId = "publishing" | "organization" | "theme";

/**
 * Sections that are rendered WITHOUT a heading and without a subcard.
 *
 * "Organisation" is a word that says nothing its own fields do not already
 * say: a vendor, a product type, collections and tags ARE how an item is
 * organized, and the heading only cost the row above them. The fields still
 * fold into a section — that is what keeps them consecutive and lets them share
 * one compact grid — they just do not get a box drawn around them.
 *
 * The set is consulted in TWO places and must not be inlined at either: the
 * editor decides whether to draw the frame, and `shouldRenderDetailsSections`
 * counts how many frames there would be. A section that draws none must not be
 * counted, or the last titled section gets a subcard with nothing to be
 * separated FROM — the "titled box inside a titled box" this guard exists to
 * prevent.
 */
export const HEADLESS_DETAILS_SECTIONS = new Set<DetailsSectionId>(["organization"]);

/** One rendered block: a subcard (`id` set) or a run of unsectioned fields. */
export interface DetailsSection<F> {
  /** null = render the fields bare, without a subcard. */
  id: DetailsSectionId | null;
  fields: F[];
}

/**
 * English fallbacks, used when the i18n bundle has no `content.detailsSections`
 * entry — the same defensive pattern as every other label in the editor.
 */
export const DETAILS_SECTION_FALLBACK_LABELS: Record<DetailsSectionId, string> = {
  publishing: "Sales channels",
  organization: "Organization",
  theme: "Theme template",
};

/**
 * Fold the Details card's fields into subcards. Consecutive fields sharing a
 * section become one block; fields without a section collect into `id: null`
 * blocks and render bare.
 */
export function groupDetailsFields<F extends { detailsSection?: DetailsSectionId }>(
  fields: F[]
): DetailsSection<F>[] {
  const blocks: DetailsSection<F>[] = [];

  for (const field of fields) {
    const id = field.detailsSection ?? null;
    const last = blocks[blocks.length - 1];
    if (last && last.id === id) {
      last.fields.push(field);
    } else {
      blocks.push({ id, fields: [field] });
    }
  }

  return blocks;
}

/**
 * Are the subcards worth drawing? Counted over the blocks that would actually
 * DRAW one — sectioned, and not in `HEADLESS_DETAILS_SECTIONS`. One of them IS
 * the whole card, so a subcard around it just repeats the frame the "Details"
 * heading already draws — that is a page or a blog, whose only attribute is the
 * theme template. Blocks that render bare either way must not push the count
 * over the line, or they draw exactly the box this guard exists to prevent.
 */
export function shouldRenderDetailsSections<F>(blocks: DetailsSection<F>[]): boolean {
  return blocks.filter((block) => block.id !== null && !HEADLESS_DETAILS_SECTIONS.has(block.id)).length > 1;
}

/** Resolve a section's heading from the i18n bundle, with an English fallback. */
export function detailsSectionLabel(
  t: { content?: { detailsSections?: Partial<Record<DetailsSectionId, string>> } },
  id: DetailsSectionId
): string {
  return t.content?.detailsSections?.[id] || DETAILS_SECTION_FALLBACK_LABELS[id];
}
