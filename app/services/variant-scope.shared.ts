/**
 * What "the thing I am editing" means in the variants panel.
 *
 * A product with three colours and four sizes has twelve variants, and a
 * merchant almost never wants to edit exactly one of them: they want to price
 * all the white ones, or set the weight of all the 20cm ones, or raise every
 * price at once. Editing twelve boxes by hand to express "all white" is the
 * work this exists to remove.
 *
 * So the picker offers three kinds of scope:
 *
 *   variant  one variant, which is what the panel always did
 *   group    every variant carrying one option VALUE ("all white", "all 20cm",
 *            "all with a lid")
 *   all      every variant of the product
 *
 * -- Which groups exist ------------------------------------------------------
 * Only the ones that mean something. A group is offered when it has at least
 * two members AND is not the whole catalogue: on a product where every variant
 * is white, "all white" and "all variants" are the same set under two names,
 * and offering both invites the merchant to wonder what the difference is.
 *
 * -- Groups come from `selectedOptions`, never from the title -----------------
 * A variant's title is "Weiss / 20cm". Splitting it on " / " breaks on any
 * value that contains the separator, and merchants write "20 / 30 cm". Shopify
 * reports the pairs directly; that is what is used.
 *
 * -- The images --------------------------------------------------------------
 * A scope shows what it covers. One variant shows its own image; a group shows
 * up to four of its members', so "all white" is visibly the white ones. For
 * ALL variants the four are picked ACROSS the list rather than off the front,
 * or a product whose first four variants are all white would show four white
 * pictures for a scope that means everything.
 */

export interface ScopeVariant {
  id: string;
  title: string;
  sku: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
}

export interface ScopeImage {
  url: string;
  alt: string;
}

export interface VariantScope {
  /** `variant::<id>`, `group::<option>::<value>` or `all`. */
  id: string;
  kind: "variant" | "group" | "all";
  label: string;
  /** The option this group is over — absent on the other two kinds. */
  optionName?: string;
  variantIds: string[];
  images: ScopeImage[];
}

/** How many pictures a group or "all" shows. Four fits one row beside a select. */
export const SCOPE_IMAGE_COUNT = 4;

/**
 * Distinct images for a scope.
 *
 * `spread` walks the members at a stride instead of taking the first four, so
 * "all variants" shows a mix rather than four pictures of whatever sorts first.
 * Distinct by URL: four copies of one picture say nothing that one copy does
 * not, and a product with a single image would otherwise render it four times.
 */
export function pickScopeImages(
  members: ScopeVariant[],
  options?: { spread?: boolean; max?: number },
): ScopeImage[] {
  const max = options?.max ?? SCOPE_IMAGE_COUNT;
  if (max <= 0) return [];
  const order = options?.spread === true ? spreadOrder(members.length) : members.map((_, i) => i);

  const seen = new Set<string>();
  const picked: ScopeImage[] = [];
  for (const index of order) {
    const member = members[index];
    const url = member?.imageUrl;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    picked.push({ url, alt: member.imageAlt || member.title });
    if (picked.length >= max) break;
  }
  return picked;
}

/** Indices walked at a stride, then filled in — 0, n/4, n/2, … then the rest. */
function spreadOrder(length: number): number[] {
  if (length <= 0) return [];
  const stride = Math.max(1, Math.floor(length / SCOPE_IMAGE_COUNT));
  const order: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < length; i += stride) {
    order.push(i);
    seen.add(i);
  }
  // The remainder, so a product with fewer distinct images than strides still
  // fills its row.
  for (let i = 0; i < length; i++) if (!seen.has(i)) order.push(i);
  return order;
}

export function buildVariantScopes(
  variants: ScopeVariant[],
  labels: { all: string; groupLabel: (optionName: string, value: string) => string },
): VariantScope[] {
  const scopes: VariantScope[] = variants.map((variant) => ({
    id: `variant::${variant.id}`,
    kind: "variant",
    label: `${variant.title}${variant.sku ? ` · ${variant.sku}` : ""}`,
    variantIds: [variant.id],
    images: pickScopeImages([variant], { max: 1 }),
  }));

  if (variants.length < 2) return scopes;

  // One group per option VALUE, in the order the options and values first
  // appear — which is the order Shopify reports them, i.e. the merchant's own.
  const groups = new Map<string, { optionName: string; value: string; members: ScopeVariant[] }>();
  for (const variant of variants) {
    // A variant whose options were not reported groups into nothing rather
    // than throwing: a narrower query, or a row from an older cache, is a
    // missing answer, and the individual-variant scopes still work.
    for (const option of variant.selectedOptions ?? []) {
      const key = `${option.name}\n${option.value}`;
      const entry = groups.get(key) ?? { optionName: option.name, value: option.value, members: [] };
      entry.members.push(variant);
      groups.set(key, entry);
    }
  }

  for (const [key, entry] of groups) {
    // Two rules, and the second is the one that is easy to miss: a group
    // covering every variant is "all variants" spelled differently.
    if (entry.members.length < 2) continue;
    if (entry.members.length === variants.length) continue;
    scopes.push({
      id: `group::${key}`,
      kind: "group",
      label: labels.groupLabel(entry.optionName, entry.value),
      optionName: entry.optionName,
      variantIds: entry.members.map((m) => m.id),
      images: pickScopeImages(entry.members),
    });
  }

  scopes.push({
    id: "all",
    kind: "all",
    label: labels.all,
    variantIds: variants.map((v) => v.id),
    images: pickScopeImages(variants, { spread: true }),
  });

  return scopes;
}

/**
 * The value every member agrees on, or `null` when they differ.
 *
 * `null` is what makes a bulk field honest: showing the first member's price
 * for twelve variants that each have their own would invite the merchant to
 * leave it alone and unknowingly keep twelve different prices — or to touch it
 * and overwrite eleven of them without ever seeing what they were.
 */
export function commonValue(values: string[]): string | null {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((value) => value === first) ? first : null;
}
